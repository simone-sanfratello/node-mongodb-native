import { ServerType, STATE_CLOSED, STATE_CLOSING } from './common';
import {
  now,
  makeStateMachine,
  calculateDurationInMs,
  makeInterruptableAsyncInterval
} from '../utils';
import { EventEmitter } from 'events';
import connect = require('../cmap/connect');
import { Connection } from '../cmap/connection';
import { MongoNetworkError } from '../error';
import { Long } from '../bson';
import {
  ServerHeartbeatStartedEvent,
  ServerHeartbeatSucceededEvent,
  ServerHeartbeatFailedEvent
} from './events';

const kServer = Symbol('server');
const kMonitorId = Symbol('monitorId');
const kConnection = Symbol('connection');
const kCancellationToken = Symbol('cancellationToken');
const kRTTPinger = Symbol('rttPinger');
const kRoundTripTime = Symbol('roundTripTime');

const STATE_IDLE = 'idle';
const STATE_MONITORING = 'monitoring';
const stateTransition = makeStateMachine({
  [STATE_CLOSING]: [STATE_CLOSING, STATE_IDLE, STATE_CLOSED],
  [STATE_CLOSED]: [STATE_CLOSED, STATE_MONITORING],
  [STATE_IDLE]: [STATE_IDLE, STATE_MONITORING, STATE_CLOSING],
  [STATE_MONITORING]: [STATE_MONITORING, STATE_IDLE, STATE_CLOSING]
});

const INVALID_REQUEST_CHECK_STATES = new Set([STATE_CLOSING, STATE_CLOSED, STATE_MONITORING]);
function isInCloseState(monitor: any) {
  return monitor.s.state === STATE_CLOSED || monitor.s.state === STATE_CLOSING;
}

class Monitor extends EventEmitter {
  s: any;
  address: any;
  options: any;
  connectOptions: any;
  [kServer]: any;
  [kConnection]: any;
  [kCancellationToken]: any;
  [kMonitorId]: any;

  constructor(server: any, options: any) {
    super(options);
    this[kServer] = server;
    this[kConnection] = undefined;
    this[kCancellationToken] = new EventEmitter();
    this[kCancellationToken].setMaxListeners(Infinity);
    this[kMonitorId] = null;
    this.s = {
      state: STATE_CLOSED
    };

    this.address = server.description.address;
    this.options = Object.freeze({
      connectTimeoutMS:
        typeof options.connectionTimeout === 'number'
          ? options.connectionTimeout
          : typeof options.connectTimeoutMS === 'number'
          ? options.connectTimeoutMS
          : 10000,
      heartbeatFrequencyMS:
        typeof options.heartbeatFrequencyMS === 'number' ? options.heartbeatFrequencyMS : 10000,
      minHeartbeatFrequencyMS:
        typeof options.minHeartbeatFrequencyMS === 'number' ? options.minHeartbeatFrequencyMS : 500
    });

    // TODO: refactor this to pull it directly from the pool, requires new ConnectionPool integration
    const addressParts = server.description.address.split(':');
    const connectOptions = Object.assign(
      {
        id: '<monitor>',
        host: addressParts[0],
        port: parseInt(addressParts[1], 10),
        connectionType: Connection
      },
      server.s.options,
      this.options,

      // force BSON serialization options
      {
        raw: false,
        promoteLongs: true,
        promoteValues: true,
        promoteBuffers: true
      }
    );

    // ensure no authentication is used for monitoring
    delete connectOptions.credentials;
    this.connectOptions = Object.freeze(connectOptions);
  }

  connect() {
    if (this.s.state !== STATE_CLOSED) {
      return;
    }

    // start
    const heartbeatFrequencyMS = this.options.heartbeatFrequencyMS;
    const minHeartbeatFrequencyMS = this.options.minHeartbeatFrequencyMS;
    this[kMonitorId] = makeInterruptableAsyncInterval(monitorServer(this), {
      interval: heartbeatFrequencyMS,
      minInterval: minHeartbeatFrequencyMS,
      immediate: true
    });
  }

  requestCheck() {
    if (INVALID_REQUEST_CHECK_STATES.has(this.s.state)) {
      return;
    }

    this[kMonitorId].wake();
  }

  reset() {
    if (isInCloseState(this)) {
      return;
    }

    stateTransition(this, STATE_CLOSING);
    resetMonitorState(this);

    // restart monitor
    stateTransition(this, STATE_IDLE);

    // restart monitoring
    const heartbeatFrequencyMS = this.options.heartbeatFrequencyMS;
    const minHeartbeatFrequencyMS = this.options.minHeartbeatFrequencyMS;
    this[kMonitorId] = makeInterruptableAsyncInterval(monitorServer(this), {
      interval: heartbeatFrequencyMS,
      minInterval: minHeartbeatFrequencyMS
    });
  }

  close() {
    if (isInCloseState(this)) {
      return;
    }

    stateTransition(this, STATE_CLOSING);
    resetMonitorState(this);

    // close monitor
    this.emit('close');
    stateTransition(this, STATE_CLOSED);
  }
}

function resetMonitorState(monitor: any) {
  stateTransition(monitor, STATE_CLOSING);
  if (monitor[kMonitorId]) {
    monitor[kMonitorId].stop();
    monitor[kMonitorId] = null;
  }

  if (monitor[kRTTPinger]) {
    monitor[kRTTPinger].close();
    monitor[kRTTPinger] = undefined;
  }

  monitor[kCancellationToken].emit('cancel');
  if (monitor[kMonitorId]) {
    clearTimeout(monitor[kMonitorId]);
    monitor[kMonitorId] = undefined;
  }

  if (monitor[kConnection]) {
    monitor[kConnection].destroy({ force: true });
  }
}

function checkServer(monitor: any, callback: Function) {
  let start = now();
  monitor.emit('serverHeartbeatStarted', new ServerHeartbeatStartedEvent(monitor.address));
  function failureHandler(err: any) {
    if (monitor[kConnection]) {
      monitor[kConnection].destroy({ force: true });
      monitor[kConnection] = undefined;
    }

    monitor.emit(
      'serverHeartbeatFailed',
      new ServerHeartbeatFailedEvent(calculateDurationInMs(start), err, monitor.address)
    );

    monitor.emit('resetServer', err);
    monitor.emit('resetConnectionPool');
    callback(err);
  }

  if (monitor[kConnection] != null && !monitor[kConnection].closed) {
    const connectTimeoutMS = monitor.options.connectTimeoutMS;
    const maxAwaitTimeMS = monitor.options.heartbeatFrequencyMS;
    const topologyVersion = monitor[kServer].description.topologyVersion;
    const isAwaitable = topologyVersion != null;

    const cmd = isAwaitable
      ? { ismaster: true, maxAwaitTimeMS, topologyVersion: makeTopologyVersion(topologyVersion) }
      : { ismaster: true };

    const options = isAwaitable
      ? { socketTimeout: connectTimeoutMS + maxAwaitTimeMS, exhaustAllowed: true }
      : { socketTimeout: connectTimeoutMS };

    if (isAwaitable && monitor[kRTTPinger] == null) {
      monitor[kRTTPinger] = new RTTPinger(monitor[kCancellationToken], monitor.connectOptions);
    }

    monitor[kConnection].command('admin.$cmd', cmd, options, (err?: any, result?: any) => {
      if (err) {
        failureHandler(err);
        return;
      }

      const isMaster = result.result;
      const duration = isAwaitable
        ? monitor[kRTTPinger].roundTripTime
        : calculateDurationInMs(start);

      monitor.emit(
        'serverHeartbeatSucceeded',
        new ServerHeartbeatSucceededEvent(duration, isMaster, monitor.address)
      );

      // if we are using the streaming protocol then we immediately issue another `started`
      // event, otherwise the "check" is complete and return to the main monitor loop
      if (isAwaitable && isMaster.topologyVersion) {
        monitor.emit('serverHeartbeatStarted', new ServerHeartbeatStartedEvent(monitor.address));
        start = now();
      } else {
        if (monitor[kRTTPinger]) {
          monitor[kRTTPinger].close();
          monitor[kRTTPinger] = undefined;
        }

        callback(undefined, isMaster);
      }
    });

    return;
  }

  // connecting does an implicit `ismaster`
  connect(monitor.connectOptions, monitor[kCancellationToken], (err?: any, conn?: any) => {
    if (conn && isInCloseState(monitor)) {
      conn.destroy({ force: true });
      return;
    }

    if (err) {
      monitor[kConnection] = undefined;

      // we already reset the connection pool on network errors in all cases
      if (!(err instanceof MongoNetworkError)) {
        monitor.emit('resetConnectionPool');
      }

      failureHandler(err);
      return;
    }

    monitor[kConnection] = conn;
    monitor.emit(
      'serverHeartbeatSucceeded',
      new ServerHeartbeatSucceededEvent(
        calculateDurationInMs(start),
        conn.ismaster,
        monitor.address
      )
    );

    callback(undefined, conn.ismaster);
  });
}

function monitorServer(monitor: any) {
  return (callback: Function) => {
    stateTransition(monitor, STATE_MONITORING);
    function done() {
      if (!isInCloseState(monitor)) {
        stateTransition(monitor, STATE_IDLE);
      }

      callback();
    }

    // TODO: the next line is a legacy event, remove in v4
    process.nextTick(() => monitor.emit('monitoring', monitor[kServer]));
    checkServer(monitor, (err?: any, isMaster?: any) => {
      if (err) {
        // otherwise an error occured on initial discovery, also bail
        if (monitor[kServer].description.type === ServerType.Unknown) {
          monitor.emit('resetServer', err);
          return done();
        }
      }

      // if the check indicates streaming is supported, immediately reschedule monitoring
      if (isMaster && isMaster.topologyVersion) {
        setTimeout(() => {
          if (!isInCloseState(monitor)) {
            monitor[kMonitorId].wake();
          }
        }, 0);
      }

      done();
    });
  };
}

function makeTopologyVersion(tv: any) {
  return {
    processId: tv.processId,
    counter: Long.fromNumber(tv.counter)
  };
}

class RTTPinger {
  [kConnection]?: any;
  [kCancellationToken]: any;
  [kRoundTripTime]: any;
  [kMonitorId]?: any;
  closed: boolean;

  constructor(cancellationToken: any, options: any) {
    this[kConnection] = null;
    this[kCancellationToken] = cancellationToken;
    this[kRoundTripTime] = 0;
    this.closed = false;

    const heartbeatFrequencyMS = options.heartbeatFrequencyMS;
    this[kMonitorId] = setTimeout(() => measureRoundTripTime(this, options), heartbeatFrequencyMS);
  }

  get roundTripTime() {
    return this[kRoundTripTime];
  }

  close() {
    this.closed = true;

    clearTimeout(this[kMonitorId]);
    this[kMonitorId] = undefined;

    if (this[kConnection]) {
      this[kConnection].destroy({ force: true });
    }
  }
}

function measureRoundTripTime(rttPinger: any, options: any) {
  const start = now();
  const cancellationToken = rttPinger[kCancellationToken];
  const heartbeatFrequencyMS = options.heartbeatFrequencyMS;

  if (rttPinger.closed) {
    return;
  }

  function measureAndReschedule(conn: any) {
    if (rttPinger.closed) {
      conn.destroy({ force: true });
      return;
    }

    if (rttPinger[kConnection] == null) {
      rttPinger[kConnection] = conn;
    }

    rttPinger[kRoundTripTime] = calculateDurationInMs(start);
    rttPinger[kMonitorId] = setTimeout(
      () => measureRoundTripTime(rttPinger, options),
      heartbeatFrequencyMS
    );
  }

  if (rttPinger[kConnection] == null) {
    connect(options, cancellationToken, (err?: any, conn?: any) => {
      if (err) {
        rttPinger[kConnection] = undefined;
        rttPinger[kRoundTripTime] = 0;
        return;
      }

      measureAndReschedule(conn);
    });

    return;
  }

  rttPinger[kConnection].command('admin.$cmd', { ismaster: 1 }, (err: any) => {
    if (err) {
      rttPinger[kConnection] = undefined;
      rttPinger[kRoundTripTime] = 0;
      return;
    }

    measureAndReschedule(null);
  });
}

export { Monitor };
