"use strict";
/*
 * content-interaction.test.js — 用极简假 DOM 跑“真实” content.js，
 * 消息接真实 background/service-worker.js（vm 隔离作用域执行）+ 内存 IndexedDB，
 * 端到端验证多修订合并恢复的页面交互：
 *   同值自动合并 / 冲突必须显式选源 / 二次确认 /
 *   预览后改动整组拒绝且零写入 / 授权过期整组拒绝 /
 *   表单替换后不能写入 / 仅实际恢复的修订可清理 / 原单修订流程不受影响。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { installFakeDom, FakeMutationObserver, FakeEvent } =
  require("./fake-dom.js");
const { installFakeIndexedDB, SCHEMA } = require("./fake-idb.js");

installFakeIndexedDB(SCHEMA);
const FSP = require("../extension/inject/policy.js");
const FSPBatch = require("../extension/inject/batch.js");
const DB = require("../extension/background/db.js");

const PAGE_URL = "https://shop.example/profile?fsp_test=1";

/* ---------------- 页面夹具 ---------------- */

function makeInput(doc, a) {
  const FakeElementCtor = require("./fake-dom.js").FakeElement;
  const tag = a.tag || "INPUT";
  const el = new FakeElementCtor(tag, doc);
  el.type = a.type || (tag === "TEXTAREA" ? undefined : "text");
  if (a.id) {
    el.id = a.id;
    el.attributes.id = a.id;
  }
  if (a.name) {
    el.name = a.name;
    el.attributes.name = a.name;
  }
  if (a.value != null) el.value = String(a.value);
  const label = doc.createElement("label");
  label.appendChild(doc.createTextNode(a.label || a.id || a.name || ""));
  label.appendChild(el);
  return label;
}

function buildProfileForm(doc) {
  const FakeElementCtor = require("./fake-dom.js").FakeElement;
  const form = new FakeElementCtor("form", doc);
  form.id = "profile";
  form.attributes.id = "profile";
  for (const a of [
    { id: "fullname", name: "fullname", type: "text", label: "姓名" },
    { id: "email", name: "email", type: "email", label: "邮箱" },
    { id: "bio", name: "bio", tag: "TEXTAREA", label: "简介" },
  ])
    form.appendChild(makeInput(doc, a));
  return form;
}

/* ---------------- VM 隔离执行真实脚本 ---------------- */

function runScript(file, sandbox, filename) {
  const src = fs.readFileSync(file, "utf8");
  vm.runInContext(
    filename === "service-worker.js"
      ? src.replace(/^importScripts\(.*\);$/m, "")
      : src,
    vm.createContext(sandbox),
    { filename },
  );
}

let seq = 0;

async function bootWorld() {
  const env = installFakeDom(PAGE_URL);
  const form = buildProfileForm(env.document);
  env.document.body.appendChild(form);
  const chrome = env.chrome;

  // 同时支持 SW（单一 listener 记录）与 content.js（Set 注册）的 onMessage
  let swListener = null;
  const contentFns = new Set();
  let phase = "sw"; // sw | content
  chrome.runtime.onMessage = {
    addListener(fn) {
      if (phase === "sw") swListener = fn;
      else contentFns.add(fn);
    },
  };
  chrome.runtime.onInstalled = { addListener() {} };
  chrome.runtime.onStartup = { addListener() {} };
  chrome.alarms = {
    create() {},
    onAlarm: { addListener() {} },
  };
  chrome.tabs = {
    onRemoved: { addListener() {} },
    async query() {
      return [{ id: 1, url: env.location.href }];
    },
    async sendMessage(_t, msg) {
      let r;
      for (const fn of contentFns) fn(msg, {}, (x) => (r = x));
      return r;
    },
  };
  chrome.scripting = { async executeScript() {} };

  // 1) 真实 SW（独立作用域：内含 const P / DB 等声明；self 即全局对象）
  const swGlobal = { console, setTimeout, clearTimeout, URL };
  swGlobal.self = swGlobal;
  swGlobal.chrome = chrome;
  swGlobal.FSP = FSP;
  swGlobal.FSPDB = DB;
  runScript(
    path.join(__dirname, "..", "extension", "background", "service-worker.js"),
    swGlobal,
    "service-worker.js",
  );

  // 2) 真实 content.js（独立作用域；FSP/FSPBatch 作为全局注入）
  phase = "content";
  env.window.FSP = FSP;
  env.window.FSPBatch = FSPBatch;
  chrome.runtime.sendMessage = (msg, cb) =>
    setTimeout(
      () =>
        swListener(
          msg,
          {
            tab: { id: 1 },
            frameId: 0,
            documentId: "doc-test-" + seq,
            url: env.location.href,
          },
          cb,
        ),
      0,
    );
  runScript(
    path.join(__dirname, "..", "extension", "inject", "content.js"),
    {
      window: env.window,
      self: env.window,
      document: env.document,
      location: env.location,
      chrome,
      console,
      setTimeout,
      clearTimeout,
      URL,
      URLSearchParams,
      Event: FakeEvent,
      MutationObserver: FakeMutationObserver,
      CSS: globalThis.CSS,
      HTMLInputElement: env.window.HTMLInputElement,
      HTMLTextAreaElement: env.window.HTMLTextAreaElement,
      FSP,
      FSPBatch,
      globalThis: env.window,
    },
    "content-" + seq++ + ".js",
  );

  await new Promise((r) => setTimeout(r, 5)); // 等首次 handshake 完成
  return { env, chrome, form };
}

/* ---------------- 测试驱动 ---------------- */

function driver(env) {
  function call(data) {
    return new Promise((resolve) => {
      const handler = (ev) => {
        const m = ev.data;
        if (!m || !m.__fspTestResult) return;
        env.window.removeEventListener("message", handler);
        resolve(m.res);
      };
      env.window.addEventListener("message", handler);
      env.window.postMessage(Object.assign({ __fspTest: true }, data));
    });
  }
  const control = (id) => env.document.querySelector("#" + id);
  const sleep = (t) => new Promise((r) => setTimeout(r, t));
  return {
    call,
    control,
    async selectForm(formId) {
      // 等待首次握手完成（真实 chrome 中消息天然异步）
      for (let i = 0; i < 20; i++) {
        const s = await call({ action: "state" });
        if (s.status === "select-form") break;
        await sleep(5);
      }
      return call({ action: "batch-select-form", formId });
    },
    async save(keys) {
      return call({ action: "batch-save", keys });
    },
    async pick(ids) {
      const r = await call({ action: "batch-pick", ids });
      return r;
    },
    async choice(key, revisionId) {
      return call({ action: "batch-choice", key, revisionId });
    },
    async confirm(v) {
      return call({ action: "batch-confirm", value: v !== false });
    },
    async apply(readKeys) {
      return call({ action: "batch-apply", readKeys: readKeys || [] });
    },
    async setValue(key, value) {
      return call({ action: "set-value", key, value });
    },
    async detach() {
      return call({ action: "detach-form" });
    },
    async state() {
      return call({ action: "state" });
    },
  };
}

function readAll(d) {
  return d.apply(["#fullname", "#email", "#bio"]);
}

test.beforeEach(async () => {
  await DB.wipeForTests();
});

/* ---------------- 用例 ---------------- */

test("合并恢复端到端：同值合并 + 冲突显式选源（选旧不取新）+ 二次确认 + 仅标记实际恢复修订", async () => {
  const { env } = await bootWorld();
  const d = driver(env);
  assert.equal((await d.selectForm("profile")).ok, true);

  // r1
  d.control("fullname").value = "A";
  d.control("email").value = "x@a";
  d.control("bio").value = "old";
  const s1 = await d.save(["#fullname", "#email", "#bio"]);
  assert.equal(s1.drafts.length, 1);

  // r2：fullname 冲突，其余同值
  d.control("fullname").value = "B";
  const s2 = await d.save(["#fullname", "#email", "#bio"]);
  const [r2Id, r1Id] = s2.drafts; // 列表倒序

  d.control("fullname").value = "";
  d.control("email").value = "";
  d.control("bio").value = "";

  const pick = await d.pick([r1Id, r2Id]);
  assert.equal(pick.ok, true, JSON.stringify(pick));
  assert.deepEqual([...pick.conflicts], ["#fullname"]);
  assert.equal(pick.fieldCount, 3);

  // 未选来源时 apply 被拒，零写入，预览仍在
  const premature = await d.apply(["#fullname"]);
  assert.equal(premature.values[0][1], "");
  assert.equal(premature.batchOpen, true);

  // 明确采用较旧 r1
  await d.choice("#fullname", r1Id);
  // 未勾二次确认仍拒绝
  assert.equal((await d.apply(["#fullname"])).values[0][1], "");

  await d.confirm(true);
  const done = await readAll(d);
  assert.equal(done.batchOpen, false);
  // 值经 VM 跨领域回传，按结构比较
  assert.deepEqual(JSON.parse(JSON.stringify(done.values)), [
    ["#fullname", "A"], // 用户选旧，不被较新 r2 自动覆盖
    ["#email", "x@a"], // 同值自动合并
    ["#bio", "old"],
  ]);
  // 只有 r1 完整恢复；冲突落败的 r2 不进入后续清理
  assert.deepEqual([...done.applied].sort(), [r1Id]);

  // 原单修订流程仍可用：状态正常
  assert.equal((await d.state()).status, "select-form");
});

test("预览后靠后字段被改动 → 确认时整组拒绝、一个字段都不写（含靠前字段）", async () => {
  const { env } = await bootWorld();
  const d = driver(env);
  await d.selectForm("profile");

  d.control("fullname").value = "A";
  d.control("bio").value = "1";
  const s1 = await d.save(["#fullname", "#bio"]);
  d.control("fullname").value = "B";
  d.control("bio").value = "2";
  const s2 = await d.save(["#fullname", "#bio"]);
  const [r2, r1] = s2.drafts;
  void s1;

  d.control("fullname").value = "";
  d.control("bio").value = "";

  const pick = await d.pick([r1, r2]);
  assert.equal(pick.ok, true, JSON.stringify(pick));
  assert.deepEqual([...pick.conflicts].sort(), ["#bio", "#fullname"]);
  await d.choice("#fullname", r2);
  await d.choice("#bio", r1);
  await d.confirm(true);

  // 确认后、应用前用户又编辑了 bio
  assert.equal((await d.setValue("#bio", "user-changed")).ok, true);

  const res = await d.apply(["#fullname", "#bio"]);
  assert.deepEqual(JSON.parse(JSON.stringify(res.values)), [
    ["#fullname", ""], // 靠前字段也不得先写
    ["#bio", "user-changed"],
  ]);
});

test("授权撤回/过期 → 合并恢复整组拒绝且不写入", async () => {
  const { env } = await bootWorld();
  const d = driver(env);
  await d.selectForm("profile");

  d.control("email").value = "a@x";
  const s1 = await d.save(["#email"]);
  d.control("email").value = "b@x";
  const s2 = await d.save(["#email"]);
  const [r2, r1] = s2.drafts;
  void s1;
  d.control("email").value = "";

  await d.pick([r1, r2]);
  await d.choice("#email", r2);
  await d.confirm(true);

  await DB.revokeTab(1); // 授权在确认前失效

  const res = await d.apply(["#email"]);
  assert.equal(res.values[0][1], "");
  assert.equal(res.batchOpen, false);
});

test("表单被替换/脱离文档后整组拒绝，不会继续写入", async () => {
  const { env } = await bootWorld();
  const d = driver(env);
  await d.selectForm("profile");

  d.control("bio").value = "one";
  const s1 = await d.save(["#bio"]);
  d.control("bio").value = "two";
  const s2 = await d.save(["#bio"]);
  const [r2, r1] = s2.drafts;
  void s1;
  d.control("bio").value = "";

  await d.pick([r1, r2]);
  await d.choice("#bio", r1);
  await d.confirm(true);

  await d.detach(); // state.selectedForm.isConnected = false
  const res = await d.apply(["#bio"]);
  assert.equal(res.values[0][1], "");
});
