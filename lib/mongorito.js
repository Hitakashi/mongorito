'use strict';

/**
* Dependencies
*/

let mongoskin;

// if npm version is >= 3.x, mongoskin must be required directly
try {
  mongoskin = require('monk/node_modules/mongoskin');
} catch (_) {
  mongoskin = require('mongoskin');
}

const pluralize = require('pluralize');
const compose = require('koa-compose');
const result = require('lodash.result');
const clone = require('clone');
const monk = require('monk');
const wrap = require('co-monk');
const get = require('get-value');
const set = require('set-value');
const is = require('is_js');

const Query = require('./query');


/**
* Mongorito
*
* Main class, manages mongodb connection and collections
*/

class Mongorito {
  /**
   * Connect to a MongoDB database and return connection object
   *
   * @param {String} urls - connection urls (as arguments)
   * @api public
   */
   
  static connect () {
    // parse arguments
    let args = Array.prototype.slice.call(arguments);

    let urls = [];
    let options = {};

    args.forEach(function (arg) {
      if (is.string(arg)) {
        urls.push(arg);
      }

      if (is.object(arg)) {
        options = arg;
      }
    });

    // convert mongo:// urls to monk-supported ones
    urls = urls.map(function (url) {
      return url.replace(/^mongo\:\/\//, '');
    });

    let db = monk(urls, options);

    // if there is already a connection
    // don't overwrite it with a new one
    if (!this.db) {
      this.db = db;
    }

    return db;
  }


  /**
   * Disconnect from a database
   *
   * @api public
   */
  
  static disconnect () {
    this.db.close();
  }


  /**
   * Alias for .disconnect()
   *
   * @api public
   */
  
  static close () {
    return this.disconnect.apply(this, arguments);
  }


  /**
   * Return a co-wrapped monk collection
   *
   * @api private
   */
  
  static _collection (db, name) {
    let url = db.driver._connect_args[0];
    let collections = this._collections[url];

    if (!collections) {
      collections = this._collections[url] = {};
    }

    if (collections[name]) {
      return collections[name];
    }

    let collection = db.get(name);

    collections[name] = wrap(collection);
    
    return collections[name];
  }
}


/**
 * Cache for monk collections
 *
 * @api private
 */

Mongorito._collections = {};


/**
* Model
*/

class Model {
  constructor (attrs, options) {
    this.attributes = clone(attrs || {});
    this.changed = {};
    this.previous = {};
    this.options = clone(options || {});

    // reset hooks
    Object.defineProperty(this, '_hooks', {
      value: {
        before: {
          create: [],
          update: [],
          remove: [],
          save: []
        },
        after: {
          create: [],
          update: [],
          remove: [],
          save: []
        }
      },
      enumerable: false
    });

    // run custom per-model configuration
    this.configure();
  }


  /**
   * Get collection for current model
   *
   * @api private
   */
  
  get _collection () {
    if (is.string(this.collection)) {
      return Mongorito._collection(this._db, this.collection);
    }
    
    // get collectio name
    // from the "collection" property
    // or generate the default one
    let defaultName = pluralize(this.constructor.name).toLowerCase();
    let name = result(this, 'collection', defaultName);

    // save collection name
    // to avoid the same check in future
    this.collection = this.constructor.prototype.collection = name;

    return Mongorito._collection(this._db, this.collection);
  }

  
  /**
   * Get database for current model
   *
   * @api private
   */
  
  get _db () {
    // use either custom database
    // specified for this model
    // or use a default one
    return this.db || Mongorito.db;
  }


  /**
   * Get model attribute
   *
   * @param {String} key - property name
   * @api public
   */
  
  get (key) {
    // if key is empty
    // return all attributes
    let value = key ? get(this.attributes, key) : this.attributes;
    
    // if value is object
    // return a deep copy
    return value && value.constructor === Object ? clone(value) : value;
  }


  /**
   * Set model attribute
   *
   * @param {String} key - property name
   * @param {Mixed} value - property value
   * @api public
   */
  
  set (key, value) {
    // if object passed instead of key-value pair
    // iterate and call set on each item
    if (is.object(key)) {
      let attrs = key;
      let keys = Object.keys(attrs);

      let self = this;

      keys.forEach(function (key) {
        self.set(key, attrs[key]);
      });

      return;
    }

    // check if the value actually changed
    let previousValue = this.get(key);
    
    if (previousValue !== value) {
      set(this.previous, key, previousValue);
      set(this.attributes, key, value);
      set(this.changed, key, true);
    }

    return value;
  }


  /**
   * Unset model attribute
   *
   * @param {String} key - property name
   * @api public
   */
  
  unset (key) {
    this.set(key, undefined);
  }


  /**
   * Set default values
   *
   * @api private
   */
  
  _setDefaults () {
    let defaults = result(this, 'defaults', {});
    let keys = Object.keys(defaults);

    let self = this;

    keys.forEach(function (key) {
      let defaultValue = defaults[key];
      let actualValue = self.get(key);

      if (is.undefined(actualValue)) {
        self.set(key, defaultValue);
      }
    });
  }


  /**
   * Get all attributes
   *
   * @api public
   */
  
  toJSON () {
    return this.attributes;
  }


  /**
   * Configure model (usually, set hooks here)
   * Supposed to be overriden
   *
   * @api public
   */
  
  configure () {

  }
  
  
  /**
   * Rollback given method when error occurs
   * Supposed to be overriden
   *
   * @param {String} name - method name
   * @api public
   */
  
  * rollback () {
    
  }
  
  
  /**
   * Return a function, that in case of an error
   * executes this.rollback() with a given method name
   *
   * @api private
   */
  
  _rollbackFor (method) {
    return function * (next) {
      try {
        yield* next;
      } catch (err) {
        yield this.rollback(method);
        throw err;
      }
    };
  }


  /**
   * Add hooks
   *
   * @api private
   */
  
  hook (when, action, method) {
    let self = this;

    // if object is given
    // iterate and call .hook()
    // for each entry
    if (is.object(when)) {
      let hooks = when;
      let keys = Object.keys(hooks);

      keys.forEach(function (key) {
        let parts = key.split(':');
        let when = parts[0];
        let action = parts[1];
        let method = hooks[key];

        self.hook(when, action, method);
      });

      return;
    }

    // if array is given
    // iterate and call .hook()
    // for each item
    if (is.array(method)) {
      let methods = method;

      methods.forEach(function (method) {
        return self.hook(when, action, method);
      });

      return;
    }

    // if method is a string
    // get the function
    if (is.not.function(method)) {
      method = this[method];
    }

    // around hooks should be
    // at the end of before:*
    // at the beginning of after:*
    if (when === 'around') {
      this._hooks.before[action].push(method);
      this._hooks.after[action].unshift(method);
    } else {
      this._hooks[when][action].push(method);
    }
  }
  
  
  /**
   * Add multiple hooks at once
   *
   * @api public
   */
  
  hooks () {
    return this.hook.apply(this, arguments);
  }


  /**
   * Add before:* hook
   *
   * @param {String} action - before what
   * @param {String} method - hook name
   * @api public
   */
  
  before (action, method) {
    this.hook('before', action, method);
  }


  /**
   * Add after:* hook
   *
   * @param {String} action - after what
   * @param {String} method - hook name
   * @api public
   */
  
  after (action, method) {
    this.hook('after', action, method);
  }


  /**
   * Add around:* hook
   *
   * @param {String} action - around what
   * @param {String} method - hook name
   * @api public
   */
  
  around (action, method) {
    this.hook('around', action, method);
  }


  /**
   * Execute hooks
   *
   * @api private
   */
  
  _runHooks (when, action, options) {
    if (!options) {
      options = {};
    }

    let hooks = this._getHooks(when, action);
    
    // skip hooks
    let skip = options.skip;
    
    if (skip) {
      if (is.string(skip)) {
        skip = [skip];
      }
      
      hooks = hooks.filter(function (fn) {
        return skip.indexOf(fn.name) === -1;
      });
    }
    
    let middleware = [];
    let self = this;
    
    // insert a rollback fn
    // before each hook
    hooks.forEach(function (fn) {
      let rollback = self._rollbackFor(fn.name);
      
      middleware.push(rollback, fn);
    });

    return compose(middleware).call(this);
  }
  
  
  /**
   * Get hooks for a given operation
   *
   * @api private
   */
  
  _getHooks (when, action) {
    let hooks = this._hooks[when][action] || [];
    
    // if create or update hooks requested
    // prepend save hooks also
    if (action === 'create' || action === 'update') {
      hooks.push.apply(hooks, this._hooks[when].save);
    }
    
    return hooks;
  }


  /**
   * Save a model
   *
   * @param {Object} options - options for save operation
   * @api public
   */
  
  * save (options) {
    // set default values if needed
    this._setDefaults();

    let id = this.get('_id');
    let fn = id ? this.update : this.create;

    // revert populated documents to _id's
    let populate = this.options.populate || emptyObject;
    let keys = Object.keys(populate);

    let self = this;

    keys.forEach(function (key) {
      let value = self.get(key);

      if (is.array(value)) {
        value = value.map(function (doc) {
          return doc.get('_id');
        });
      } else {
        value = value.get('_id');
      }

      self.set(key, value);
    });
    
    return yield fn.call(this, options);
  }


  /**
   * Create a model
   *
   * @api private
   */
  
  * create (options) {
    let collection = this._collection;
    let attrs = this.attributes;

    let date = new Date;

    this.set({
      'created_at': date,
      'updated_at': date
    });

    yield* this._runHooks('before', 'create', options);

    let doc = yield collection.insert(attrs);

    this.set('_id', doc._id);

    yield* this._runHooks('after', 'create', options);

    return this;
  }


  /**
   * Update a model
   *
   * @api private
   */
  
  * update (options) {
    let collection = this._collection;
    let attrs = this.attributes;

    this.set('updated_at', new Date);

    yield* this._runHooks('before', 'update', options);
    yield collection.updateById(attrs._id, attrs);
    yield* this._runHooks('after', 'update', options);

    return this;
  }


  /**
   * Remove a model
   *
   * @api private
   */
  
  * remove (options) {
    let collection = this._collection;

    yield* this._runHooks('before', 'remove', options);
    yield collection.remove({ _id: this.get('_id') });
    yield* this._runHooks('after', 'remove', options);

    return this;
  }


  /**
   * Atomically increment a model property
   *
   * @param {Object} props - set of properties and values
   * @param {Object} options - options for update operation
   * @api public
   */
  
  * inc (props, options) {
    let id = this.get('_id');

    if (!id) {
      throw new Error('Can\'t atomically increment a property of unsaved document.');
    }

    let collection = this._collection;
    
    yield* this._runHooks('before', 'update', options);

    yield collection.updateById(id, {
      '$inc': props
    });

    // perform increment locally
    // to prevent the need to refresh
    // the model from a database
    let self = this;

    Object.keys(props).forEach(function (key) {
      // get current value
      let value = self.get(key);

      // perform increment
      value += props[key];

      // save
      self.set(key, value);
    });

    yield* this._runHooks('after', 'update', options);

    return this;
  }
  
  
  /**
   * Get database for a model
   *
   * @api private
   */
  
  static get _db () {
    // support for multiple connections
    // if model has a custom database assigned
    // use it, otherwise use the default
    return this.prototype.db || Mongorito.db;
  }


  /**
   * Get collection for a model
   *
   * @api private
   */
  
  static get _collection () {
    if (is.string(this.prototype.collection)) {
      return Mongorito._collection(this._db, this.prototype.collection);
    }
    
    // get collection name
    // from the "collection" property
    // or generate the default one
    let defaultName = pluralize(this.name).toLowerCase();
    let name = result(this.prototype, 'collection', defaultName);

    // save collection name
    // to avoid the same check in future
    this.prototype.collection = name;

    return Mongorito._collection(this._db, name);
  }

  
  /**
   * Find documents
   *
   * @param {Object} query - find conditions, same as this.where()
   * @api public
   */
  
  static find (query) {
    // collection, model
    return new Query(this._collection, this).find(query);
  }


  /**
   * Count documents
   *
   * @param {Object} query - find conditions, same as this.where()
   * @api public
   */
  
  static count (query) {
    // collection, model
    return new Query(this._collection, this).count(query);
  }

  
  /**
   * Find all documents in a collection
   *
   * @api public
   */
  
  static all () {
    return this.find();
  }


  /**
   * Find one document
   *
   * @param {Object} query - find conditions, same as this.where()
   * @api public
   */
  
  static * findOne (query) {
    let docs = yield* this.find(query);

    return docs[0];
  }


  /**
   * Find a document by ID
   *
   * @param {ObjectID} id - document id
   * @api public
   */
  
  static findById (id) {
    return this.findOne({ _id: id });
  }


  /**
   * Remove documents
   *
   * @param {Object} query - remove conditions, same as this.where()
   * @api public
   */
  
  static remove (query) {
    // collection, model
    return new Query(this._collection, this).remove(query);
  }
  
  
  /**
   * Drop collection
   *
   * @api public
   */
  
  static * drop () {
    yield this._collection.drop();
  }


  /**
   * Set up an index
   *
   * @see https://github.com/Automattic/monk#indexes
   * @api public
   */
  
  static * index () {
    return yield this._collection.index.apply(this._collection, arguments);
  }


  /**
   * List all indexes
   *
   * @see https://github.com/Automattic/monk#indexes
   * @api public
   */
  
  static * indexes () {
    return yield this._collection.indexes();
  }
}

// Setting up functions that have
// the same implementation
// and act as a bridge to Query
const methods = [
  'where',
  'limit',
  'skip',
  'sort',
  'exists',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'nin',
  'and',
  'or',
  'ne',
  'nor',
  'populate',
  'matches',
  'match',
  'include',
  'exclude',
  'search'
];

methods.forEach(function (method) {
  Model[method] = function () {
    // collection, model
    let query = new Query(this._collection, this);

    query[method].apply(query, arguments);

    return query;
  };
});


/**
* Expose Mongorito
*/

exports = module.exports = Mongorito;

exports.Model = Model;

Object.keys(mongoskin).forEach(function (key) {
  if (['connect', 'version', 'db'].indexOf(key) === -1) {
    exports[key] = mongoskin[key];
  }
});

const emptyObject = {};
