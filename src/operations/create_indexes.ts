import { Aspect, defineAspects } from './operation';
import { MongoError } from '../error';
import CommandOperation = require('./command');
import { maxWireVersion, parseIndexOptions } from '../utils';

const validIndexOptions = new Set([
  'unique',
  'partialFilterExpression',
  'sparse',
  'background',
  'expireAfterSeconds',
  'storageEngine',
  'collation'
]);

class CreateIndexesOperation extends CommandOperation {
  collection: any;
  onlyReturnNameOfCreatedIndex?: boolean;
  indexes: any;

  constructor(parent: any, collection: any, indexes: any, options: any) {
    super(parent, options);
    this.collection = collection;

    // createIndex can be called with a variety of styles:
    //   coll.createIndex('a');
    //   coll.createIndex({ a: 1 });
    //   coll.createIndex([['a', 1]]);
    // createIndexes is always called with an array of index spec objects
    if (!Array.isArray(indexes) || Array.isArray(indexes[0])) {
      this.onlyReturnNameOfCreatedIndex = true;
      // TODO: remove in v4 (breaking change); make createIndex return full response as createIndexes does

      const indexParameters = parseIndexOptions(indexes);
      // Generate the index name
      const name = typeof options.name === 'string' ? options.name : indexParameters.name;
      // Set up the index
      const indexSpec: any = { name, key: indexParameters.fieldHash };
      // merge valid index options into the index spec
      for (let optionName in options) {
        if (validIndexOptions.has(optionName)) {
          indexSpec[optionName] = options[optionName];
        }
      }
      this.indexes = [indexSpec];
      return;
    }

    this.indexes = indexes;
  }

  execute(server: any, callback: Function) {
    const options = this.options;
    const indexes = this.indexes;

    const serverWireVersion = maxWireVersion(server);

    // Ensure we generate the correct name if the parameter is not set
    for (let i = 0; i < indexes.length; i++) {
      // Did the user pass in a collation, check if our write server supports it
      if (indexes[i].collation && serverWireVersion < 5) {
        callback(
          new MongoError(
            `Server ${server.name}, which reports wire version ${serverWireVersion}, does not support collation`
          )
        );
        return;
      }

      if (indexes[i].name == null) {
        const keys = [];

        for (let name in indexes[i].key) {
          keys.push(`${name}_${indexes[i].key[name]}`);
        }

        // Set the name
        indexes[i].name = keys.join('_');
      }
    }

    const cmd = { createIndexes: this.collection, indexes } as any;

    if (options.commitQuorum != null) {
      if (serverWireVersion < 9) {
        callback(
          new MongoError('`commitQuorum` option for `createIndexes` not supported on servers < 4.4')
        );
        return;
      }
      cmd.commitQuorum = options.commitQuorum;
    }

    // collation is set on each index, it should not be defined at the root
    this.options.collation = undefined;

    super.executeCommand(server, cmd, (err?: any, result?: any) => {
      if (err) {
        callback(err);
        return;
      }

      callback(null, this.onlyReturnNameOfCreatedIndex ? indexes[0].name : result);
    });
  }
}

defineAspects(CreateIndexesOperation, [Aspect.WRITE_OPERATION, Aspect.EXECUTE_WITH_SELECTION]);

export = CreateIndexesOperation;
