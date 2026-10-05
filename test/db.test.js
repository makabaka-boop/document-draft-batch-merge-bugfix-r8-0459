"use strict";
// 后台 IndexedDB 层测试（内存假库）：
// 令牌事务语义、组合校验、按 origin/路由隔离、只删确认修订、过期清理、SW“重启”。
const test = require("node:test");
const assert = require("node:assert/strict");

const { installFakeIndexedDB, SCHEMA } = require("./fake-idb.js");
installFakeIndexedDB(SCHEMA);

const DB = require("../extension/background/db.js");
const P = require("../extension/inject/policy.js");

test.beforeEach(async () => {
  await DB.wipeForTests();
});

function env(over) {
  const fields = [
    {
      key: "#a",
      id: "a",
      name: null,
      kind: "input:text",
      label: "A",
      value: "va",
    },
  ];
  const fp = "0123456789abcdef";
  const envelope = {
    origin: "https://a.test",
    route: "https://a.test/f?step=1#x",
    formId: "f1",
    formFingerprint: fp,
    formIdentity: P.formIdentity("f1", fp),
    fields,
  };
  return Object.assign(envelope, over);
}

test("重新授权在同一事务内作废旧令牌并签发新令牌", async () => {
  const t1 = await DB.issueToken({
    tabId: 7,
    docId: "d1",
    origin: "https://a.test",
    route: "r1",
  });
  const t2 = await DB.issueToken({
    tabId: 7,
    docId: "d1",
    origin: "https://a.test",
    route: "r1",
  });
  assert.notEqual(t1.token, t2.token);

  const v1 = await DB.verifyToken({
    token: t1.token,
    tabId: 7,
    docId: "d1",
    origin: "https://a.test",
  });
  assert.equal(v1.ok, false);
  assert.equal(v1.error, "superseded-token"); // 旧页迟到保存不能覆盖新页草稿

  const v2 = await DB.verifyToken({
    token: t2.token,
    tabId: 7,
    docId: "d1",
    origin: "https://a.test",
  });
  assert.equal(v2.ok, true);
});

test("组合校验：tab / documentId / origin 任一不符都拒绝", async () => {
  const t = await DB.issueToken({
    tabId: 1,
    docId: "doc-a",
    origin: "https://a.test",
    route: "r",
  });
  assert.equal(
    (
      await DB.verifyToken({
        token: t.token,
        tabId: 2,
        docId: "doc-a",
        origin: "https://a.test",
      })
    ).error,
    "token-context-mismatch",
  );
  assert.equal(
    (
      await DB.verifyToken({
        token: t.token,
        tabId: 1,
        docId: "doc-b",
        origin: "https://a.test",
      })
    ).error,
    "token-context-mismatch",
  );
  assert.equal(
    (
      await DB.verifyToken({
        token: t.token,
        tabId: 1,
        docId: "doc-a",
        origin: "https://b.test",
      })
    ).error,
    "token-context-mismatch",
  );
  assert.equal(
    (
      await DB.verifyToken({
        token: "x".repeat(64),
        tabId: 1,
        docId: "doc-a",
        origin: "https://a.test",
      })
    ).error,
    "unknown-token",
  );
});

test("过期令牌不能使用", async () => {
  const t = await DB.issueToken({
    tabId: 3,
    docId: "d",
    origin: "https://a.test",
    route: "r",
  });
  const future = t.issuedAt + P.TOKEN_TTL_MS + 1;
  const r = await DB.pruneExpired(future);
  assert.ok(r.tokens >= 1);
  const v = await DB.verifyToken({
    token: t.token,
    tabId: 3,
    docId: "d",
    origin: "https://a.test",
  });
  assert.equal(v.error, "expired-token");
});

test("草稿按 origin + 完整路由隔离", async () => {
  const r1 = await DB.addRevision(env());
  await DB.addRevision(env({ route: "https://a.test/f?step=2#x" }));
  await DB.addRevision(
    env({ origin: "https://b.test", route: "https://b.test/f?step=1#x" }),
  );
  const rows = await DB.listRevisions(
    "https://a.test",
    "https://a.test/f?step=1#x",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, r1.id);
  assert.deepEqual(rows[0].fields[0], {
    key: "#a",
    label: "A",
    kind: "input:text",
    value: "va",
  });
});

test("getRevision 拒绝跨 origin 读取；过期记录不可见", async () => {
  const r = await DB.addRevision(env());
  assert.equal(await DB.getRevision(r.id, "https://b.test"), null);
  const got = await DB.getRevision(r.id, "https://a.test");
  assert.equal(got.id, r.id);

  // 手动把 expiresAt 改过去
  const expired = await DB.addRevision(env({ route: "https://a.test/old" }));
  const db = await DB.openDb();
  const { t, stores, done } = (() => {
    const tx2 = db.transaction(["revisions"], "readwrite");
    return {
      t: tx2,
      stores: { revisions: tx2.objectStore("revisions") },
      done: new Promise((res, rej) => {
        tx2.oncomplete = () => res();
        tx2.onerror = () => rej(tx2.error);
      }),
    };
  })();
  const rec = await new Promise((q) => {
    const req = stores.revisions.get(expired.id);
    req.onsuccess = () => q(req.result);
  });
  rec.expiresAt = 1;
  stores.revisions.put(rec);
  await done;
  assert.equal(await DB.getRevision(expired.id, "https://a.test"), null);
});

test("清理只删除用户确认过的那一份修订，期间新增输入保留", async () => {
  const r1 = await DB.addRevision(
    env({
      fields: [
        {
          key: "#a",
          id: "a",
          name: null,
          kind: "input:text",
          label: "A",
          value: "1",
        },
      ],
    }),
  );
  const r2 = await DB.addRevision(
    env({
      fields: [
        {
          key: "#a",
          id: "a",
          name: null,
          kind: "input:text",
          label: "A",
          value: "2",
        },
      ],
    }),
  );
  const r3 = await DB.addRevision(
    env({
      fields: [
        {
          key: "#a",
          id: "a",
          name: null,
          kind: "input:text",
          label: "A",
          value: "3",
        },
      ],
    }),
  );
  // 用户确认 r2 已提交，只删 r2
  assert.equal(await DB.deleteRevision(r2.id, "https://a.test"), true);
  const rows = await DB.listRevisions("https://a.test", env().route);
  assert.deepEqual(rows.map((x) => x.id).sort(), [r1.id, r3.id].sort());
  // 跨 origin 不能删
  assert.equal(await DB.deleteRevision(r1.id, "https://evil.test"), false);
});

test("过期清理：只删过期修订，未到期的保留", async () => {
  const keep = await DB.addRevision(env());
  const old = await DB.addRevision(env({ route: "https://a.test/expired" }));
  // 把 old 的创建时间前移 1 小时，模拟旧修订
  const db = await DB.openDb();
  {
    const tx2 = db.transaction(["revisions"], "readwrite");
    const store = tx2.objectStore("revisions");
    const rec = await new Promise((q) => {
      const req = store.get(old.id);
      req.onsuccess = () => q(req.result);
    });
    rec.createdAt -= 60 * 60 * 1000;
    rec.expiresAt = rec.createdAt + P.REVISION_TTL_MS;
    store.put(rec);
    await new Promise((res, rej) => {
      tx2.oncomplete = () => res();
      tx2.onerror = () => rej(tx2.error);
    });
  }
  // TTL=30min：1 小时前的记录过期，刚创建的保留
  const r = await DB.pruneExpired(Date.now(), 30 * 60 * 1000, P.TOKEN_TTL_MS);
  assert.equal(r.revisions, 1);
  const rows = await DB.listRevisions("https://a.test", env().route);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, keep.id);
  assert.equal(await DB.getRevision(old.id, "https://a.test"), null);
});

test("撤回 tab 令牌后不可再验证", async () => {
  const t = await DB.issueToken({
    tabId: 9,
    docId: "d",
    origin: "https://a.test",
    route: "r",
  });
  const n = await DB.revokeTab(9);
  assert.equal(n, 1);
  const v = await DB.verifyToken({
    token: t.token,
    tabId: 9,
    docId: "d",
    origin: "https://a.test",
  });
  assert.equal(v.ok, false);
});

test("SW “重启”后状态全部从库恢复（无进程内变量依赖）", async () => {
  // 重新 require 模块缓存的同一份代码，但 fake indexedDB 数据是持久的：
  delete require.cache[require.resolve("../extension/background/db.js")];
  const DB2 = require("../extension/background/db.js");
  const counts = await DB2.counts();
  // wipeForTests 在 beforeEach 已清库；这里直接验证“唤醒后可用且数据延续”
  const r = await DB2.addRevision(env());
  delete require.cache[require.resolve("../extension/background/db.js")];
  const DB3 = require("../extension/background/db.js");
  const got = await DB3.getRevision(r.id, "https://a.test");
  assert.ok(got);
  assert.equal(got.formIdentity, env().formIdentity);
  assert.equal((await DB3.counts()).revisions, 1);
});
