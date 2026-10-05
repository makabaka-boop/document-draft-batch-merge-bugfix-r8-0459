/*
 * 仅供测试的最小内存 IndexedDB：支持 objectStore、单字段 index、游标式范围扫描。
 * 事务语义：oncomplete 在所有请求回调之后触发；abort 时丢弃写操作。
 */
"use strict";

class FakeTx {
  constructor(db, names, mode) {
    this.db = db;
    this.mode = mode;
    this.names = names;
    this.stores = new Map(names.map((n) => [n, new FakeStore(this, n)]));
    this.error = null;
    this._scheduled = 0;
    this._done = false;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }
  objectStore(name) {
    if (!this.stores.has(name)) throw new Error("NotFoundError: " + name);
    return this.stores.get(name);
  }
  _enter() {
    this._scheduled++;
  }
  _leave() {
    this._scheduled--;
    if (this._scheduled === 0) queueMicrotask(() => this._finish());
  }
  _finish() {
    if (this._done) return;
    this._done = true;
    if (this.error) {
      if (this.onabort) this.onabort({ target: this });
      else if (this.onerror) this.onerror({ target: this });
    } else if (this.oncomplete) {
      // 提交：把每个 store 的快照写回 db
      for (const store of this.stores.values()) store.commit();
      this.oncomplete({ target: this });
    }
  }
  abort() {
    this.error = new Error("aborted");
    if (this._scheduled === 0) queueMicrotask(() => this._finish());
  }
}

class FakeStore {
  constructor(tx, name) {
    this.tx = tx;
    this.name = name;
    this.namePath = this.tx.db.namePath[name];
    this._rows = new Map(tx.db.rows[name]); // 事务内拷贝
    this._indexes = tx.db.indexes[name];
  }
  commit() {
    if (this.tx.mode === "readwrite" && !this.tx.error) {
      this.tx.db.rows[this.name] = this._rows;
    }
  }
  _run(fn) {
    const req = new FakeRequest();
    this.tx._enter();
    queueMicrotask(() => {
      try {
        fn(req);
        req._fireSuccess();
      } catch (e) {
        req.error = e;
        req._fireError();
      }
      this.tx._leave();
    });
    return req;
  }
  add(value) {
    const key = value[this.namePath];
    return this._run((req) => {
      if (this._rows.has(key)) {
        const err = new Error("ConstraintError");
        err.name = "ConstraintError";
        throw err;
      }
      this._rows.set(key, structuredClone(value));
      req.result = key;
    });
  }
  put(value) {
    const key = value[this.namePath];
    return this._run((req) => {
      this._rows.set(key, structuredClone(value));
      req.result = key;
    });
  }
  get(key) {
    return this._run((req) => {
      req.result = this._rows.has(key)
        ? structuredClone(this._rows.get(key))
        : undefined;
    });
  }
  delete(key) {
    return this._run((req) => {
      this._rows.delete(key);
      req.result = undefined;
    });
  }
  clear() {
    return this._run((req) => {
      this._rows.clear();
      req.result = undefined;
    });
  }
  getAll(query) {
    return this._run((req) => {
      let vals = Array.from(this._rows.values()).map((v) => structuredClone(v));
      if (query instanceof FakeKeyRange)
        vals = vals.filter((v) =>
          query.test(this.namePath ? v[this.namePath] : v),
        );
      else if (query !== undefined)
        vals = vals.filter(
          (v) => this._indexValue(v, query.indexName) === query.value,
        );
      req.result = vals;
    });
  }
  _indexValue(value, indexName) {
    const path = this._indexes[indexName];
    return value[path];
  }
  index(name) {
    return {
      name,
      getAll: (rangeOrValue) => {
        if (rangeOrValue === undefined) return this.getAll();
        return this._run((req) => {
          const vals = Array.from(this._rows.values()).map((v) =>
            structuredClone(v),
          );
          req.result = vals.filter((v) => {
            const iv = this._indexValue(v, name);
            if (rangeOrValue instanceof FakeKeyRange)
              return rangeOrValue.test(iv);
            return iv === rangeOrValue;
          });
        });
      },
    };
  }
}

class FakeKeyRange {
  constructor(opts) {
    Object.assign(this, opts);
  }
  static only(v) {
    return new FakeKeyRange({ only: v });
  }
  static upperBound(v, open) {
    return new FakeKeyRange({ upper: v, upperOpen: !!open });
  }
  test(v) {
    if (this.only !== undefined) return v === this.only;
    if (this.upper !== undefined)
      return this.upperOpen ? v < this.upper : v <= this.upper;
    return true;
  }
}

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.result = undefined;
    this.error = null;
  }
  _fireSuccess() {
    if (this.onsuccess) this.onsuccess({ target: this });
  }
  _fireError() {
    if (this.onerror) this.onerror({ target: this });
  }
}

class FakeDB {
  constructor(name, version, schema) {
    this.name = name;
    this.version = version;
    this.rows = {};
    this.namePath = {};
    this.indexes = {};
    for (const [store, def] of Object.entries(schema)) {
      this.rows[store] = new Map();
      this.namePath[store] = def.keyPath;
      this.indexes[store] = def.indexes || {};
    }
  }
  transaction(names, mode = "readonly") {
    return new FakeTx(this, names, mode);
  }
  get objectStoreNames() {
    return {
      contains: (n) => Object.prototype.hasOwnProperty.call(this.rows, n),
    };
  }
}

function installFakeIndexedDB(schema) {
  const db = new FakeDB("fake", 1, schema);
  globalThis.indexedDB = {
    open() {
      const req = new FakeRequest();
      queueMicrotask(() => {
        req.result = db;
        req._fireSuccess();
      });
      return req;
    },
  };
  return db;
}

const SCHEMA = {
  tokens: { keyPath: "token", indexes: { tabId: "tabId", docId: "docId" } },
  revisions: {
    keyPath: "id",
    indexes: { scopeKey: "scopeKey", expiresAt: "expiresAt" },
  },
  meta: { keyPath: "key" },
};

module.exports = { installFakeIndexedDB, SCHEMA, FakeKeyRange };
