"use strict";
/*
 * fake-dom.js — 供 Node 集成测试使用的极简 DOM/window/chrome 环境。
 * 目标：让真实的 inject/content.js 在 Node 中执行完整的
 * 选择表单 → 保存多份修订 → 合并预览/选源/二次确认 → 整组恢复 交互，
 * 消息经真实 background/service-worker.js + 内存 IndexedDB 裁决。
 *
 * 仅实现扩展代码实际用到的 API，非通用 DOM 垫片。
 */

/* ---------------- 事件 ---------------- */

class FakeEventTarget {
  constructor() {
    this.__listeners = new Map();
  }
  addEventListener(type, fn, _opts) {
    if (!this.__listeners.has(type)) this.__listeners.set(type, new Set());
    this.__listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    const s = this.__listeners.get(type);
    if (s) s.delete(fn);
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    if (ev.bubbles) {
      let node = this;
      while (node) {
        const s = node.__listeners && node.__listeners.get(ev.type);
        if (s) for (const fn of [...s]) fn.call(node, ev);
        node = node.parentNode;
      }
    } else {
      const s = this.__listeners && this.__listeners.get(ev.type);
      if (s) for (const fn of [...s]) fn.call(this, ev);
    }
    return true;
  }
}

class FakeEvent {
  constructor(type, opts) {
    this.type = type;
    opts = opts || {};
    this.bubbles = !!opts.bubbles;
    this.target = null;
  }
}

/* ---------------- 元素 ---------------- */

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION"]);

class FakeElement extends FakeEventTarget {
  constructor(tagName, ownerDoc) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDoc;
    this.nodeType = 1;
    this.isConnected = true;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = {};
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.disabled = false;
    this.readOnly = false;
    // 输入控件
    this.type = this.tagName === "TEXTAREA" ? undefined : "text";
    this.name = "";
    this.id = "";
    this.value = "";
    this.placeholder = "";
    this.checked = false;
    this.selected = false;
    this.rows = 2;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    if (!TEXT_TAGS.has(child.tagName)) {
      this.textContent = (this.textContent || "") + (child.textContent || "");
    }
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "id") this.id = String(v);
    else if (k === "name") this.name = String(v);
    else if (k === "class") this.className = String(v);
    else if (k === "type") this.type = String(v);
    else if (k === "placeholder") this.placeholder = String(v);
    else if (k === "for") ;
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k)
      ? this.attributes[k]
      : null;
  }
  hasAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k);
  }

  attachShadow(_opts) {
    const sh = new FakeShadowRoot(this.ownerDocument);
    sh.host = this;
    this.shadowRoot = sh;
    return sh;
  }

  // 内容脚本用到的选择器：#id、tag、tag#id、label[for="x"]、简单组合
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const out = [];
    walk(this, (n) => {
      if (matches(n, sel)) out.push(n);
    });
    return out;
  }

  closest(sel) {
    let node = this;
    while (node && node.tagName) {
      if (matches(node, sel)) return node;
      node = node.parentNode;
    }
    return null;
  }

  get classList() {
    const self = this;
    return {
      toggle(c, force) {
        const set = new Set((self.className || "").split(/\s+/).filter(Boolean));
        const on = force === undefined ? !set.has(c) : force;
        if (on) set.add(c);
        else set.delete(c);
        self.className = [...set].join(" ");
      },
    };
  }

  // content.js 用 getElementById（panel 容器）
  getElementById(id) {
    return this.querySelector("#" + id);
  }
}

class FakeShadowRoot extends FakeElement {
  constructor(ownerDoc) {
    super("#shadow-root", ownerDoc);
    this.mode = "closed";
  }
}

function walk(node, fn) {
  for (const c of node.childNodes || []) {
    if (c.nodeType === 1) {
      fn(c);
      walk(c, fn);
    }
  }
}

// 解析单个简单选择器：tag、#id、.class、tag#id、tag[attr="v"]
function parseSimple(part) {
  const m = part.match(
    /^([a-z0-9]*)?((?:[#.][\w-]+)*)?(?:\[([\w-]+)(?:=["'](.+?)["'])?\])?$/i,
  );
  if (!m) return null;
  const head = m[2] || "";
  let id = null;
  let cls = null;
  const hm = head.match(/(?:#([\w-]+))|(?:\.([\w-]+))/g);
  if (hm) {
    for (const x of hm) {
      if (x[0] === "#") id = x.slice(1);
      else cls = x.slice(1); // content.js 只用到单个 class
    }
  }
  return {
    tag: m[1] ? m[1].toUpperCase() : null,
    id,
    cls,
    attr: m[3] || null,
    attrVal: m[4] !== undefined ? m[4] : undefined,
  };
}

function matchOne(node, p) {
  if (node.nodeType !== 1) return false;
  if (p.tag && node.tagName !== p.tag) return false;
  if (p.id && node.id !== p.id) return false;
  if (p.cls && !(node.className || "").split(/\s+/).includes(p.cls))
    return false;
  if (p.attr) {
    const v = node.getAttribute(p.attr);
    if (v == null) return false;
    if (p.attrVal !== undefined && v !== p.attrVal) return false;
  }
  return true;
}

function matchDescendants(node, parts) {
  // 最后一段匹配 node；其余各段需按顺序在祖先链中存在
  if (!matchOne(node, parts[parts.length - 1])) return false;
  let idx = parts.length - 2;
  let ancestor = node.parentNode;
  while (idx >= 0) {
    let found = false;
    while (ancestor) {
      if (ancestor.nodeType === 1 && matchOne(ancestor, parts[idx])) {
        found = true;
        ancestor = ancestor.parentNode;
        break;
      }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
    idx--;
  }
  return true;
}

function matches(node, selector) {
  // 支持逗号分组（每组内允许空格后代组合）
  const groups = selector.trim().split(",");
  for (const g of groups) {
    const parts = g.trim().split(/\s+/).map(parseSimple);
    if (parts.some((p) => !p)) continue;
    if (matchDescendants(node, parts)) return true;
  }
  return false;
}

/* ---------------- 文档 ---------------- */

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.nodeType = 9;
    this.documentElement = new FakeElement("html", this);
    const body = new FakeElement("body", this);
    body.parentNode = this.documentElement;
    this.documentElement.childNodes.push(body);
    this.body = body;
    this.title = "";
    this.activeElement = null;
  }
  createElement(tag) {
    return new FakeElement(tag, this);
  }
  createTextNode(text) {
    const n = {
      nodeType: 3,
      textContent: String(text),
      parentNode: null,
    };
    return n;
  }
  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
  getElementById(id) {
    return this.documentElement.querySelector("#" + id);
  }
}

/* ---------------- MutationObserver ---------------- */

class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb;
    FakeMutationObserver.instances.push(this);
  }
  observe(_target, _opts) {}
  disconnect() {
    const i = FakeMutationObserver.instances.indexOf(this);
    if (i >= 0) FakeMutationObserver.instances.splice(i, 1);
  }
  takeRecords() {
    return [];
  }
  static trigger() {
    for (const o of [...FakeMutationObserver.instances]) o.cb([], o);
  }
}
FakeMutationObserver.instances = [];

class FakeInputEl {}
// 模拟浏览器原生 value setter：以 .call(control, v) 调用时写控件自身的 value 属性
Object.defineProperty(FakeInputEl.prototype, "value", {
  configurable: true,
  enumerable: true,
  set(v) {
    this.value = String(v);
  },
});
class FakeTextAreaEl {}
Object.defineProperty(FakeTextAreaEl.prototype, "value", {
  configurable: true,
  enumerable: true,
  set(v) {
    this.value = String(v);
  },
});

/* ---------------- window / location / chrome ---------------- */

function installFakeDom(url) {
  const document = new FakeDocument();
  const contentListeners = new Set(); // content script 侧 runtime.onMessage

  const locationObj = (() => {
    const u = new URL(url);
    return {
      href: url,
      origin: u.origin,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
    };
  })();

  const window = new FakeEventTarget();
  window.window = window;
  window.document = document;
  window.location = locationObj;
  window.HTMLInputElement = FakeInputEl;
  window.HTMLTextAreaElement = FakeTextAreaEl;
  window.MutationObserver = FakeMutationObserver;
  // 计时器必须是真实异步：content.js 用 setTimeout 做 MutationObserver 批处理与
  // flash 定时，同步执行会在 render 过程中重入并打乱异步消息顺序。
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms || 0, ...args);
  window.clearTimeout = (id) => realClearTimeout(id);
  window.location = locationObj;
  // 页面 → 内容脚本的 postMessage（同源，ev.source === window）
  window.postMessage = function (data) {
    const ev = new FakeEvent("message");
    ev.data = data;
    ev.source = window;
    window.dispatchEvent(ev);
  };

  // chrome.runtime.sendMessage：内容脚本 → SW（真实 SW 源码由测试加载）。
  // Chrome 总是异步回调；SW 用 Promise.resolve().then 后才 sendResponse，
  // 这里通过 queueMicrotask 保证同步执行的 listener 返回后回调仍在微任务中完成。
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        queueMicrotask(() => {
          chrome.runtime.__swListener(
            msg,
            {
              tab: { id: 1 },
              frameId: 0,
              documentId: chrome.runtime.__docId || "doc-test",
              url: locationObj.href,
            },
            (r) => cb && cb(r),
          );
        });
      },
      onMessage: {
        addListener(fn) {
          contentListeners.add(fn);
        },
      },
    },
  };
  // SW → 内容脚本（如 AUTH_REVOKED 推送）
  chrome.__dispatchFromSw = function (msg) {
    let responded;
    for (const fn of [...contentListeners])
      fn(msg, {}, (r) => (responded = r));
    return responded;
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = locationObj;
  globalThis.chrome = chrome;
  globalThis.Event = FakeEvent;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.self = globalThis;
  globalThis.setTimeout = window.setTimeout;
  globalThis.clearTimeout = window.clearTimeout;
  globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };

  return { window, document, chrome, location: locationObj, FakeElement, FakeEvent };
}

module.exports = { installFakeDom, FakeElement, FakeMutationObserver, FakeEvent };
