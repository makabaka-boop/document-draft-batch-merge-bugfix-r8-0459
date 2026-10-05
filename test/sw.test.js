"use strict";
// service worker 消息层集成测试：伪造 chrome.* 事件 API + 内存 IndexedDB，
// 加载真实的 policy.js / db.js / service-worker.js 代码跑完整消息流。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { installFakeIndexedDB, SCHEMA } = require("./fake-idb.js");
installFakeIndexedDB(SCHEMA);

const P = require("../extension/inject/policy.js");
const DB = require("../extension/background/db.js");

/* ---------- 伪造 chrome 环境 ---------- */

let currentTab = { id: 1, url: "https://shop.example/checkout?step=1" };
const injections = [];
let contentResponder = null; // 模拟内容脚本对 tabs.sendMessage 的响应

const chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: {
      listener: null,
      addListener(fn) {
        this.listener = fn;
      },
    },
    sendMessage() {},
  },
  alarms: {
    create() {},
    onAlarm: { addListener() {} },
  },
  tabs: {
    onRemoved: { addListener() {} },
    async query() {
      return [currentTab];
    },
    async sendMessage(_tabId, msg, _opts) {
      if (!contentResponder) throw new Error("Could not establish connection");
      return contentResponder(msg);
    },
    async executeScript(_tabId, details) {
      injections.push(details);
      return [];
    },
  },
  scripting: {
    async executeScript(details) {
      injections.push(details);
      return [];
    },
  },
};

globalThis.chrome = chrome;
globalThis.self = globalThis;

// 加载真实 SW 源码（importScripts 在 Node 下替换为空：依赖已通过 require 注入全局）
let swSrc = fs.readFileSync(
  path.join(__dirname, "..", "extension", "background", "service-worker.js"),
  "utf8",
);
swSrc = swSrc.replace(/^importScripts\(.*\);$/m, "");
vm.runInThisContext(swSrc, { filename: "service-worker.js" });

// 发消息（模拟 chrome.runtime.onMessage）
function dispatch(msg, sender) {
  return new Promise((resolve) => {
    chrome.runtime.onMessage.listener(msg, sender || {}, (res) => resolve(res));
  });
}

const pageSender = (over) =>
  Object.assign(
    {
      tab: { id: 1 },
      frameId: 0,
      documentId: "doc-1",
      url: currentTab.url,
    },
    over || {},
  );

function envelope(fields, fp) {
  fields = fields || [
    {
      key: "#a",
      id: "a",
      name: null,
      kind: "input:text",
      label: "A",
      value: "va",
    },
  ];
  return {
    origin: "https://shop.example",
    route: currentTab.url,
    formId: "checkout",
    formFingerprint: fp || "0123456789abcdef",
    fields,
  };
}

test.beforeEach(async () => {
  await DB.wipeForTests();
  injections.length = 0;
  contentResponder = null;
  currentTab = { id: 1, url: "https://shop.example/checkout?step=1" };
});

test("GRANT：仅编程注入顶层文档（MAIN 路由钩子 + ISOLATED 策略/内容脚本），无通配权限", async () => {
  const res = await dispatch({ type: "GRANT" });
  assert.equal(res.ok, true);
  assert.equal(injections.length, 2);
  assert.equal(injections[0].world, "MAIN");
  assert.equal(injections[0].target.allFrames, false);
  assert.deepEqual(injections[0].files, ["inject/route-hook.js"]);
  assert.equal(injections[1].world, "ISOLATED");
  assert.deepEqual(injections[1].files, [
    "inject/policy.js",
    "inject/batch.js",
    "inject/content.js",
  ]);
  for (const inj of injections) assert.equal(inj.target.allFrames, false);
});

test("GRANT 拒绝非 http(s) 页面", async () => {
  const old = currentTab;
  currentTab = { id: 2, url: "chrome://extensions/" };
  const res = await dispatch({ type: "GRANT" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "unsupported-url");
  currentTab = old;
});

test("iframe（frameId!==0）消息一律拒绝，不读取任何帧", async () => {
  const hello = await dispatch(
    { type: "HELLO" },
    pageSender({ frameId: 3, documentId: "frame-doc" }),
  );
  assert.equal(hello.ok, false);
  assert.equal(hello.error, "bad-sender");
  // 没有 tab 的伪造 sender 同样不行
  const r2 = await dispatch(
    { type: "HELLO" },
    { frameId: 0, documentId: "d", url: currentTab.url },
  );
  assert.equal(r2.ok, false);
});

test("完整生命周期：握手→保存→列表→读取→清理只删确认修订", async () => {
  const h1 = await dispatch({ type: "HELLO" }, pageSender());
  assert.equal(h1.ok, true);
  const token = h1.token;

  const s1 = await dispatch(
    { type: "SAVE_DRAFT", token, envelope: envelope() },
    pageSender(),
  );
  assert.equal(s1.ok, true);

  const list = await dispatch({ type: "LIST_DRAFTS", token }, pageSender());
  assert.equal(list.revisions.length, 1);
  assert.equal(list.revisions[0].fieldCount, 1);
  const id = list.revisions[0].id;

  const got = await dispatch({ type: "GET_REVISION", token, id }, pageSender());
  assert.equal(got.ok, true);
  assert.equal(got.revision.fields[0].value, "va");

  // 期间又新增一份输入
  const s2 = await dispatch(
    {
      type: "SAVE_DRAFT",
      token,
      envelope: envelope([
        {
          key: "#a",
          id: "a",
          name: null,
          kind: "input:text",
          label: "A",
          value: "newer",
        },
      ]),
    },
    pageSender(),
  );
  assert.equal(s2.ok, true);

  // 用户只确认清理第一份；新增的必须保留
  const del = await dispatch(
    { type: "CONSUME_REVISION", token, id },
    pageSender(),
  );
  assert.equal(del.ok, true);
  const list2 = await dispatch({ type: "LIST_DRAFTS", token }, pageSender());
  assert.equal(list2.revisions.length, 1);
  assert.notEqual(list2.revisions[0].id, id);
  assert.equal(list2.revisions[0].fields[0].value, "newer");
});

test("重新授权产生新文档令牌：旧页迟到保存被拒，不能覆盖新页草稿", async () => {
  const h1 = await dispatch({ type: "HELLO" }, pageSender());
  const oldToken = h1.token;
  await dispatch(
    {
      type: "SAVE_DRAFT",
      token: oldToken,
      envelope: envelope(undefined, "aaaaaaaaaaaaaaaa"),
    },
    pageSender(),
  );

  // 同一文档重新授权（再次 GRANT + HELLO）
  const h2 = await dispatch({ type: "HELLO" }, pageSender());
  assert.notEqual(h2.token, oldToken);

  const stale = await dispatch(
    {
      type: "SAVE_DRAFT",
      token: oldToken,
      envelope: envelope(undefined, "bbbbbbbbbbbbbbbb"),
    },
    pageSender(),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "superseded-token");

  // 新令牌正常写入，且新页草稿不被旧页覆盖
  const fresh = await dispatch(
    {
      type: "SAVE_DRAFT",
      token: h2.token,
      envelope: envelope(undefined, "bbbbbbbbbbbbbbbb"),
    },
    pageSender(),
  );
  assert.equal(fresh.ok, true);
  const list = await dispatch(
    { type: "LIST_DRAFTS", token: h2.token },
    pageSender(),
  );
  assert.equal(list.revisions.length, 2);
});

test("sender.documentId 变化（整页导航后新文档）时旧令牌组合校验失败", async () => {
  const h = await dispatch(
    { type: "HELLO" },
    pageSender({ documentId: "doc-1" }),
  );
  const r = await dispatch(
    { type: "SAVE_DRAFT", token: h.token, envelope: envelope() },
    pageSender({ documentId: "doc-2" }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "token-context-mismatch");
});

test("SPA 换路由：同文档令牌仍有效，但草稿隔离到新路由；页面自报旧路由不能串桶", async () => {
  const h = await dispatch(
    { type: "HELLO" },
    pageSender({ documentId: "spa-doc" }),
  );
  await dispatch(
    { type: "SAVE_DRAFT", token: h.token, envelope: envelope() },
    pageSender({
      documentId: "spa-doc",
      url: "https://shop.example/checkout?step=1",
    }),
  );

  const newUrl = "https://shop.example/checkout?step=2#payment";
  // 恶意/过期的页面自报旧 route，sender 给的是新 URL：后台以 sender 为准
  const evilEnv = envelope();
  evilEnv.route = "https://shop.example/checkout?step=1";
  const s = await dispatch(
    { type: "SAVE_DRAFT", token: h.token, envelope: evilEnv },
    pageSender({ documentId: "spa-doc", url: newUrl }),
  );
  assert.equal(s.ok, true);

  const oldList = await dispatch(
    { type: "LIST_DRAFTS", token: h.token },
    pageSender({
      documentId: "spa-doc",
      url: "https://shop.example/checkout?step=1",
    }),
  );
  assert.equal(oldList.revisions.length, 1); // 只有第一份，第二份没串进来
  const newList = await dispatch(
    { type: "LIST_DRAFTS", token: h.token },
    pageSender({ documentId: "spa-doc", url: newUrl }),
  );
  assert.equal(newList.revisions.length, 1);

  // 新路由桶里不能读旧路由的修订 id
  const oldId = oldList.revisions[0].id;
  const cross = await dispatch(
    { type: "GET_REVISION", token: h.token, id: oldId },
    pageSender({ documentId: "spa-doc", url: newUrl }),
  );
  assert.equal(cross.ok, false);
  assert.equal(cross.error, "route-mismatch");
});

test("REVOKE 后令牌立即失效；AUTH_REVOKED 会推送给内容脚本", async () => {
  const h = await dispatch({ type: "HELLO" }, pageSender());
  const pushed = [];
  contentResponder = async (msg) => {
    pushed.push(msg.type);
    return { ok: true };
  };
  const r = await dispatch({ type: "REVOKE" }); // 来自弹窗（无 sender.tab）
  assert.equal(r.ok, true);
  assert.ok(pushed.includes("AUTH_REVOKED"));
  contentResponder = null;

  const after = await dispatch(
    { type: "SAVE_DRAFT", token: h.token, envelope: envelope() },
    pageSender(),
  );
  assert.equal(after.ok, false);
});

test("内容脚本伪造弹窗身份无效：PRUNE_NOW 仅接受弹窗；TTL=0 仅 fsp_test 标签页", async () => {
  const fromPage = await dispatch({ type: "PRUNE_NOW" }, pageSender());
  assert.equal(fromPage.ok, false);
  assert.equal(fromPage.error, "popup-only");

  // 弹窗在普通页勾测试模式：拒绝
  currentTab = { id: 1, url: "https://shop.example/checkout" };
  const normal = await dispatch({
    type: "PRUNE_NOW",
    testMode: true,
    revisionTtl: 0,
    tokenTtl: 0,
  });
  assert.equal(normal.ok, false);
  assert.equal(normal.error, "test-mode-requires-fsp-test-tab");

  // fsp_test 页面允许
  currentTab = { id: 1, url: "https://shop.example/navigate.html?fsp_test=1" };
  const allowed = await dispatch({
    type: "PRUNE_NOW",
    testMode: true,
    revisionTtl: 0,
    tokenTtl: 0,
  });
  assert.equal(allowed.ok, true);

  // 普通默认清理始终允许
  currentTab = { id: 1, url: "https://shop.example/checkout" };
  assert.equal((await dispatch({ type: "PRUNE_NOW" })).ok, true);
});

test("载荷约束在 SW 层强制执行（20 项上限、password kind、超长值）", async () => {
  const h = await dispatch(
    { type: "HELLO" },
    pageSender({ documentId: "enforce-doc" }),
  );
  const t = h.token;

  const many = Array.from({ length: 21 }, (_, i) => ({
    key: "#f" + i,
    id: "f" + i,
    name: null,
    kind: "input:text",
    label: "f" + i,
    value: "",
  }));
  assert.equal(
    (
      await dispatch(
        { type: "SAVE_DRAFT", token: t, envelope: envelope(many) },
        pageSender({ documentId: "enforce-doc" }),
      )
    ).error,
    "too-many-fields",
  );

  const pw = [
    {
      key: "#p",
      id: "p",
      name: null,
      kind: "input:password",
      label: "p",
      value: "x",
    },
  ];
  assert.equal(
    (
      await dispatch(
        { type: "SAVE_DRAFT", token: t, envelope: envelope(pw) },
        pageSender({ documentId: "enforce-doc" }),
      )
    ).error,
    "bad-field-kind",
  );

  const big = [
    {
      key: "#a",
      id: "a",
      name: null,
      kind: "input:text",
      label: "A",
      value: "x".repeat(P.MAX_VALUE_BYTES + 1),
    },
  ];
  assert.equal(
    (
      await dispatch(
        { type: "SAVE_DRAFT", token: t, envelope: envelope(big) },
        pageSender({ documentId: "enforce-doc" }),
      )
    ).error,
    "value-too-large",
  );
});
