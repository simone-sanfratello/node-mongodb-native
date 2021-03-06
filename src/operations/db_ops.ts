import ReadPreference = require('../read_preference');
import { Code } from '../bson';
import { MongoError } from '../error';
import CONSTANTS = require('../constants');
import {
  applyWriteConcern,
  debugOptions,
  handleCallback,
  parseIndexOptions,
  toError,
  MongoDBNamespace
} from '../utils';

const debugFields = [
  'authSource',
  'w',
  'wtimeout',
  'j',
  'native_parser',
  'forceServerObjectId',
  'serializeFunctions',
  'raw',
  'promoteLongs',
  'promoteValues',
  'promoteBuffers',
  'bufferMaxEntries',
  'numberOfRetries',
  'retryMiliSeconds',
  'readPreference',
  'pkFactory',
  'noListener'
];

/**
 * Creates an index on the db and collection.
 *
 * @function
 * @param {Db} db The Db instance on which to create an index.
 * @param {string} name Name of the collection to create the index on.
 * @param {(string|object)} fieldOrSpec Defines the index.
 * @param {object} [options] Optional settings. See Db.prototype.createIndex for a list of options.
 * @param {Db~resultCallback} [callback] The command result callback
 */
function createIndex(
  db: any,
  name: string,
  fieldOrSpec: any,
  options?: object,
  callback?: Function
) {
  // Get the write concern options
  let finalOptions: any = Object.assign({}, { readPreference: ReadPreference.PRIMARY }, options);
  finalOptions = applyWriteConcern(finalOptions, { db }, options);

  // Ensure we have a callback
  if (finalOptions.writeConcern && typeof callback !== 'function') {
    throw MongoError.create({
      message: 'Cannot use a writeConcern without a provided callback',
      driver: true
    });
  }

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback!(new MongoError('topology was destroyed'));

  // Attempt to run using createIndexes command
  createIndexUsingCreateIndexes(db, name, fieldOrSpec, finalOptions, (err?: any, result?: any) => {
    if (err == null) return handleCallback(callback!, err, result);

    /**
     * The following errors mean that the server recognized `createIndex` as a command so we don't need to fallback to an insert:
     * 67 = 'CannotCreateIndex' (malformed index options)
     * 85 = 'IndexOptionsConflict' (index already exists with different options)
     * 86 = 'IndexKeySpecsConflict' (index already exists with the same name)
     * 11000 = 'DuplicateKey' (couldn't build unique index because of dupes)
     * 11600 = 'InterruptedAtShutdown' (interrupted at shutdown)
     * 197 = 'InvalidIndexSpecificationOption' (`_id` with `background: true`)
     */
    if (
      err.code === 67 ||
      err.code === 11000 ||
      err.code === 85 ||
      err.code === 86 ||
      err.code === 11600 ||
      err.code === 197
    ) {
      return handleCallback(callback!, err, result);
    }

    // Create command
    const doc = createCreateIndexCommand(db, name, fieldOrSpec, options);
    // Set no key checking
    finalOptions.checkKeys = false;
    // Insert document
    db.s.topology.insert(
      db.s.namespace.withCollection(CONSTANTS.SYSTEM_INDEX_COLLECTION),
      doc,
      finalOptions,
      (err?: any, result?: any) => {
        if (callback == null) return;
        if (err) return handleCallback(callback, err);
        if (result == null) return handleCallback(callback, null, null);
        if (result.result.writeErrors)
          return handleCallback(callback, MongoError.create(result.result.writeErrors[0]), null);
        handleCallback(callback, null, doc.name);
      }
    );
  });
}

// Add listeners to topology
function createListener(db: any, e: any, object: any) {
  function listener(err: any) {
    if (object.listeners(e).length > 0) {
      object.emit(e, err, db);
    }
  }
  return listener;
}

/**
 * Ensures that an index exists. If it does not, creates it.
 *
 * @function
 * @param {Db} db The Db instance on which to ensure the index.
 * @param {string} name The index name
 * @param {(string|object)} fieldOrSpec Defines the index.
 * @param {object} [options] Optional settings. See Db.prototype.ensureIndex for a list of options.
 * @param {Db~resultCallback} [callback] The command result callback
 */
function ensureIndex(
  db: any,
  name: string,
  fieldOrSpec: any,
  options?: object,
  callback?: Function
) {
  // Get the write concern options
  const finalOptions = applyWriteConcern({}, { db }, options);
  // Create command
  const selector = createCreateIndexCommand(db, name, fieldOrSpec, options);
  const index_name = selector.name;

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback!(new MongoError('topology was destroyed'));

  // Merge primary readPreference
  finalOptions.readPreference = ReadPreference.PRIMARY;

  // Check if the index already exists
  indexInformation(db, name, finalOptions, (err?: any, indexInformation?: any) => {
    if (err != null && err.code !== 26) return handleCallback(callback!, err, null);
    // If the index does not exist, create it
    if (indexInformation == null || !indexInformation[index_name]) {
      createIndex(db, name, fieldOrSpec, options, callback);
    } else {
      if (typeof callback === 'function') return handleCallback(callback, null, index_name);
    }
  });
}

/**
 * Evaluate JavaScript on the server
 *
 * @function
 * @param {Db} db The Db instance.
 * @param {Code} code JavaScript to execute on server.
 * @param {(object|Array)} parameters The parameters for the call.
 * @param {object} [options] Optional settings. See Db.prototype.eval for a list of options.
 * @param {Db~resultCallback} [callback] The results callback
 * @deprecated Eval is deprecated on MongoDB 3.2 and forward
 */
function evaluate(db: any, code: any, parameters: any, options?: any, callback?: Function) {
  let finalCode = code;
  let finalParameters = [];

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback!(new MongoError('topology was destroyed'));

  // If not a code object translate to one
  if (!(finalCode && finalCode._bsontype === 'Code')) finalCode = new Code(finalCode);
  // Ensure the parameters are correct
  if (parameters != null && !Array.isArray(parameters) && typeof parameters !== 'function') {
    finalParameters = [parameters];
  } else if (parameters != null && Array.isArray(parameters) && typeof parameters !== 'function') {
    finalParameters = parameters;
  }

  // Create execution selector
  let cmd: any = { $eval: finalCode, args: finalParameters };
  // Check if the nolock parameter is passed in
  if (options['nolock']) {
    cmd['nolock'] = options['nolock'];
  }

  // Set primary read preference
  options.readPreference = new ReadPreference(ReadPreference.PRIMARY);

  // Execute the command
  executeCommand(db, cmd, options, (err?: any, result?: any) => {
    if (err) return handleCallback(callback!, err, null);
    if (result && result.ok === 1) return handleCallback(callback!, null, result.retval);
    if (result)
      return handleCallback(
        callback!,
        MongoError.create({ message: `eval failed: ${result.errmsg}`, driver: true }),
        null
      );
    handleCallback(callback!, err, result);
  });
}

/**
 * Execute a command
 *
 * @function
 * @param {Db} db The Db instance on which to execute the command.
 * @param {object} command The command hash
 * @param {object} [options] Optional settings. See Db.prototype.command for a list of options.
 * @param {Db~resultCallback} [callback] The command result callback
 */
function executeCommand(db: any, command: object, options?: any, callback?: Function) {
  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback!(new MongoError('topology was destroyed'));
  // Get the db name we are executing against
  const dbName = options.dbName || options.authdb || db.databaseName;

  // Convert the readPreference if its not a write
  options.readPreference = ReadPreference.resolve(db, options);

  // Debug information
  if (db.s.logger.isDebug())
    db.s.logger.debug(
      `executing command ${JSON.stringify(
        command
      )} against ${dbName}.$cmd with options [${JSON.stringify(
        debugOptions(debugFields, options)
      )}]`
    );

  // Execute command
  db.s.topology.command(
    db.s.namespace.withCollection('$cmd'),
    command,
    options,
    (err?: any, result?: any) => {
      if (err) return handleCallback(callback!, err);
      if (options.full) return handleCallback(callback!, null, result);
      handleCallback(callback!, null, result.result);
    }
  );
}

/**
 * Runs a command on the database as admin.
 *
 * @function
 * @param {Db} db The Db instance on which to execute the command.
 * @param {object} command The command hash
 * @param {object} [options] Optional settings. See Db.prototype.executeDbAdminCommand for a list of options.
 * @param {Db~resultCallback} [callback] The command result callback
 */
function executeDbAdminCommand(db: any, command: object, options?: object, callback?: Function) {
  const namespace = new MongoDBNamespace('admin', '$cmd');

  db.s.topology.command(namespace, command, options, (err?: any, result?: any) => {
    // Did the user destroy the topology
    if (db.serverConfig && db.serverConfig.isDestroyed()) {
      return callback!(new MongoError('topology was destroyed'));
    }

    if (err) return handleCallback(callback!, err);
    handleCallback(callback!, null, result.result);
  });
}

/**
 * Retrieves this collections index info.
 *
 * @function
 * @param {Db} db The Db instance on which to retrieve the index info.
 * @param {string} name The name of the collection.
 * @param {object} [options] Optional settings. See Db.prototype.indexInformation for a list of options.
 * @param {Db~resultCallback} [callback] The command result callback
 */
function indexInformation(db: any, name: string, options?: any, callback?: Function) {
  // If we specified full information
  const full = options['full'] == null ? false : options['full'];

  // Did the user destroy the topology
  if (db.serverConfig && db.serverConfig.isDestroyed())
    return callback!(new MongoError('topology was destroyed'));
  // Process all the results from the index command and collection
  function processResults(indexes: any) {
    // Contains all the information
    let info: any = {};
    // Process all the indexes
    for (let i = 0; i < indexes.length; i++) {
      const index = indexes[i];
      // Let's unpack the object
      info[index.name] = [];
      for (let name in index.key) {
        info[index.name].push([name, index.key[name]]);
      }
    }

    return info;
  }

  // Get the list of indexes of the specified collection
  db.collection(name)
    .listIndexes(options)
    .toArray((err?: any, indexes?: any) => {
      if (err) return callback!(toError(err));
      if (!Array.isArray(indexes)) return handleCallback(callback!, null, []);
      if (full) return handleCallback(callback!, null, indexes);
      handleCallback(callback!, null, processResults(indexes));
    });
}

/**
 * Retrieve the current profiling information for MongoDB
 *
 * @function
 * @param {Db} db The Db instance on which to retrieve the profiling info.
 * @param {object} [options] Optional settings. See Db.protoype.profilingInfo for a list of options.
 * @param {Db~resultCallback} [callback] The command result callback.
 * @deprecated Query the system.profile collection directly.
 */
function profilingInfo(db: any, options?: object, callback?: Function) {
  try {
    db.collection('system.profile')
      .find({}, options)
      .toArray(callback);
  } catch (err) {
    return callback!(err, null);
  }
}

// Validate the database name
function validateDatabaseName(databaseName: any) {
  if (typeof databaseName !== 'string')
    throw MongoError.create({ message: 'database name must be a string', driver: true });
  if (databaseName.length === 0)
    throw MongoError.create({ message: 'database name cannot be the empty string', driver: true });
  if (databaseName === '$external') return;

  const invalidChars = [' ', '.', '$', '/', '\\'];
  for (let i = 0; i < invalidChars.length; i++) {
    if (databaseName.indexOf(invalidChars[i]) !== -1)
      throw MongoError.create({
        message: "database names cannot contain the character '" + invalidChars[i] + "'",
        driver: true
      });
  }
}

/**
 * Create the command object for Db.prototype.createIndex.
 *
 * @param {Db} db The Db instance on which to create the command.
 * @param {string} name Name of the collection to create the index on.
 * @param {(string|object)} fieldOrSpec Defines the index.
 * @param {object} [options] Optional settings. See Db.prototype.createIndex for a list of options.
 * @returns {object} The insert command object.
 */
function createCreateIndexCommand(db: any, name: string, fieldOrSpec: any, options?: any): any {
  const indexParameters = parseIndexOptions(fieldOrSpec);
  const fieldHash = indexParameters.fieldHash;

  // Generate the index name
  const indexName = typeof options.name === 'string' ? options.name : indexParameters.name;
  const selector: any = {
    ns: db.s.namespace.withCollection(name).toString(),
    key: fieldHash,
    name: indexName
  };

  // Ensure we have a correct finalUnique
  const finalUnique = options == null || 'object' === typeof options ? false : options;
  // Set up options
  options = options == null || typeof options === 'boolean' ? {} : options;

  // Add all the options
  const keysToOmit = Object.keys(selector);
  for (let optionName in options) {
    if (keysToOmit.indexOf(optionName) === -1) {
      selector[optionName] = options[optionName];
    }
  }

  if (selector['unique'] == null) selector['unique'] = finalUnique;

  // Remove any write concern operations
  const removeKeys = ['w', 'wtimeout', 'j', 'fsync', 'readPreference', 'session'];
  for (let i = 0; i < removeKeys.length; i++) {
    delete selector[removeKeys[i]];
  }

  // Return the command creation selector
  return selector;
}

/**
 * Create index using the createIndexes command.
 *
 * @param {Db} db The Db instance on which to execute the command.
 * @param {string} name Name of the collection to create the index on.
 * @param {(string|object)} fieldOrSpec Defines the index.
 * @param {object} [options] Optional settings. See Db.prototype.createIndex for a list of options.
 * @param {Db~resultCallback} [callback] The command result callback.
 */
function createIndexUsingCreateIndexes(
  db: any,
  name: string,
  fieldOrSpec: any,
  options?: any,
  callback?: Function
) {
  // Build the index
  const indexParameters = parseIndexOptions(fieldOrSpec);
  // Generate the index name
  const indexName = typeof options.name === 'string' ? options.name : indexParameters.name;
  // Set up the index
  const indexes: any = [{ name: indexName, key: indexParameters.fieldHash }];
  // merge all the options
  const keysToOmit = Object.keys(indexes[0]).concat([
    'writeConcern',
    'w',
    'wtimeout',
    'j',
    'fsync',
    'readPreference',
    'session'
  ]);

  for (let optionName in options) {
    if (keysToOmit.indexOf(optionName) === -1) {
      indexes[0][optionName] = options[optionName];
    }
  }

  // Get capabilities
  const capabilities = db.s.topology.capabilities();

  // Did the user pass in a collation, check if our write server supports it
  if (indexes[0].collation && capabilities && !capabilities.commandsTakeCollation) {
    // Create a new error
    const error = new MongoError('server/primary/mongos does not support collation');
    error.code = 67;
    // Return the error
    return callback!(error);
  }

  // Create command, apply write concern to command
  const cmd = applyWriteConcern({ createIndexes: name, indexes }, { db }, options);

  // ReadPreference primary
  options.readPreference = ReadPreference.PRIMARY;

  // Build the command
  executeCommand(db, cmd, options, (err?: any, result?: any) => {
    if (err) return handleCallback(callback!, err, null);
    if (result.ok === 0) return handleCallback(callback!, toError(result), null);
    // Return the indexName for backward compatibility
    handleCallback(callback!, null, indexName);
  });
}

export {
  createListener,
  createIndex,
  ensureIndex,
  evaluate,
  executeCommand,
  executeDbAdminCommand,
  indexInformation,
  profilingInfo,
  validateDatabaseName
};
