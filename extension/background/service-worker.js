/*
 * service-worker.js — 无后台服务器；全部状态在 IndexedDB。
 * 仅在用户点击扩展图标弹窗并点击“授权当前页”后注入，权限只有 activeTab + scripting。
 */
importScripts("../inject/policy.js", "db.js");

const P = self.FSP;
const DB = self.FSPDB;

/* ---------------- 生命周期 ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
  DB.pruneExpired().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAlarm();
  DB.pruneExpired().catch(() => {});
});

function scheduleAlarm() {
  chrome.alarms.create(P.ALARM_NAME, { periodInMinutes: P.ALARM_PERIOD_MIN });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === P.ALARM_NAME) DB.pruneExpired().catch(() => {});
});

// 标签关闭即撤回其令牌（令牌状态仍以库为准，这里做即时清理）
chrome.tabs.onRemoved.addListener((tabId) => {
  DB.revokeTab(tabId).catch(() => {});
});

/* ---------------- 注入 ---------------- */

async function injectIntoActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return { ok: false, error: "no-tab" };
  if (!tab.url || !P.isInjectableUrl(tab.url))
    return { ok: false, error: "unsupported-url", url: tab.url };

  // activeTab 授权只作用于顶层文档；allFrames:false、frameId 不指定即顶层
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ["inject/route-hook.js"],
      injectImmediately: false,
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ["inject/policy.js", "inject/batch.js", "inject/content.js"],
      injectImmediately: false,
      world: "ISOLATED",
    });
  } catch (e) {
    return {
      ok: false,
      error: "injection-failed",
      message: String((e && e.message) || e),
    };
  }
  return { ok: true, tabId: tab.id };
}

/* ---------------- sender 校验 ---------------- */

function senderContext(sender) {
  if (!sender || !sender.tab || sender.tab.id == null) return null;
  // frameId === 0 才是顶层文档；不读取任何 iframe
  if (sender.frameId !== 0) return null;
  const url = sender.url || (sender.tab && sender.tab.url);
  if (!url || !P.isInjectableUrl(url)) return null;
  return {
    tabId: sender.tab.id,
    // documentId 是浏览器为本次加载提供的文档标识（Chrome 106+）
    docId: sender.documentId || null,
    origin: P.originOf(url),
    route: P.fullRoute(url),
    url,
  };
}

// 组合验证：浏览器提供的 sender.documentId + tab + origin + 库内令牌状态。
// 消息里自报的任何身份字段都不采信。
async function authenticate(sender, token) {
  const ctx = senderContext(sender);
  if (!ctx) return { ok: false, error: "bad-sender" };
  if (!ctx.docId) return { ok: false, error: "no-document-id" };
  if (typeof token !== "string" || token.length !== 64)
    return { ok: false, error: "bad-token" };
  const v = await DB.verifyToken({
    token,
    tabId: ctx.tabId,
    docId: ctx.docId,
    origin: ctx.origin,
  });
  if (!v.ok) return v;
  return { ok: true, ctx, tokenRecord: v.token };
}

/* ---------------- 消息处理 ---------------- */

const HANDLERS = {
  // 弹窗发起：执行注入。用户点击才会发生（activeTab 授权点）。
  async GRANT(_msg, _sender, _fromPopup) {
    return injectIntoActiveTab();
  },

  // 注入后的内容脚本握手：事务化作废旧令牌、签发新文档令牌
  async HELLO(_msg, sender) {
    const ctx = senderContext(sender);
    if (!ctx) return { ok: false, error: "bad-sender" };
    if (!ctx.docId) return { ok: false, error: "no-document-id" };
    const rec = await DB.issueToken({
      tabId: ctx.tabId,
      docId: ctx.docId,
      origin: ctx.origin,
      route: ctx.route,
    });
    return {
      ok: true,
      token: rec.token,
      docId: rec.docId,
      origin: ctx.origin,
      route: ctx.route,
      issuedAt: rec.issuedAt,
      expiresAt: rec.expiresAt,
    };
  },

  // 内容脚本/弹窗探测当前绑定
  async STATUS(msg, sender, fromPopup) {
    if (fromPopup) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab || tab.id == null) return { ok: true, supported: false };
      const supported = !!(tab.url && P.isInjectableUrl(tab.url));
      const token = await DB.getActiveTokenForTab(tab.id);
      let bound = false;
      let route = null;
      if (token) {
        try {
          const r = await chrome.tabs.sendMessage(
            tab.id,
            { type: "PING" },
            { frameId: 0 },
          );
          // 内容脚本存活且已握手即视为绑定；tabId/docId 的强校验发生在每条带令牌消息上
          bound = !!(r && r.alive && r.bound);
          route = r.route || null;
        } catch (_e) {
          bound = false; // 内容脚本不存在（导航/重载/刷新扩展）即视为未绑定
        }
      }
      const c = await DB.counts();
      return {
        ok: true,
        supported,
        hasToken: !!token,
        bound,
        route,
        url: tab.url || null,
        counts: c,
      };
    }
    // 内容脚本侧：弹窗直接 PING 即可，这里仅作存在性响应
    return { ok: true, echo: true };
  },

  // 弹窗或内容脚本撤回授权
  async REVOKE(_msg, sender, fromPopup) {
    let tabId;
    if (fromPopup) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab || tab.id == null) return { ok: false, error: "no-tab" };
      tabId = tab.id;
    } else {
      const ctx = senderContext(sender);
      if (!ctx) return { ok: false, error: "bad-sender" };
      tabId = ctx.tabId;
    }
    const n = await DB.revokeTab(tabId);
    try {
      await chrome.tabs.sendMessage(
        tabId,
        { type: "AUTH_REVOKED" },
        { frameId: 0 },
      );
    } catch (_e) {
      // 页面已无内容脚本，忽略
    }
    return { ok: true, revoked: n };
  },

  // 保存草稿
  async SAVE_DRAFT(msg, sender) {
    const auth = await authenticate(sender, msg.token);
    if (!auth.ok) return auth;
    const ctx = auth.ctx;

    const built = P.buildEnvelope(
      Object.assign({}, msg.envelope, {
        origin: ctx.origin,
        // 路由以浏览器 sender 为准，覆盖页面自报值：SPA 换路由后旧页面不能写到新路由桶
        route: ctx.route,
      }),
    );
    if (!built.ok) return built;

    // 后台无 DOM 访问权（不申请 host 权限），全字段指纹由我们注入的内容脚本计算；
    // 这里保证信封自洽（buildEnvelope 已校验指纹格式与每个字段的 key/kind/长度）。
    // 真正的“身份/类型变化即拒绝”在恢复时由内容脚本对实时 DOM 重新验证。
    const rec = await DB.addRevision(built.envelope);
    return { ok: true, id: rec.id, createdAt: rec.createdAt };
  },

  // 列出当前 origin + 完整路由下的修订
  async LIST_DRAFTS(msg, sender) {
    const auth = await authenticate(sender, msg.token);
    if (!auth.ok) return auth;
    const rows = await DB.listRevisions(auth.ctx.origin, auth.ctx.route);
    return { ok: true, route: auth.ctx.route, revisions: rows };
  },

  // 恢复前取完整修订（预览数据来源）
  async GET_REVISION(msg, sender) {
    const auth = await authenticate(sender, msg.token);
    if (!auth.ok) return auth;
    if (typeof msg.id !== "string") return { ok: false, error: "bad-id" };
    const rec = await DB.getRevision(msg.id, auth.ctx.origin);
    if (!rec) return { ok: false, error: "not-found" };
    // 仅允许读取当前路由桶
    if (rec.route !== auth.ctx.route)
      return { ok: false, error: "route-mismatch" };
    return {
      ok: true,
      revision: {
        id: rec.id,
        formId: rec.formId,
        formIdentity: rec.formIdentity,
        formFingerprint: rec.formFingerprint,
        fields: rec.fields.map((f) => ({
          key: f.key,
          id: f.id,
          name: f.name,
          kind: f.kind,
          label: f.label,
          value: f.value,
        })),
        createdAt: rec.createdAt,
      },
    };
  },

  // 确认提交完成后的清理：只删这一份确认过的修订
  async CONSUME_REVISION(msg, sender) {
    const auth = await authenticate(sender, msg.token);
    if (!auth.ok) return auth;
    if (typeof msg.id !== "string") return { ok: false, error: "bad-id" };
    const rec = await DB.getRevision(msg.id, auth.ctx.origin);
    if (!rec) return { ok: false, error: "not-found" };
    if (rec.route !== auth.ctx.route)
      return { ok: false, error: "route-mismatch" };
    const deleted = await DB.deleteRevision(msg.id, auth.ctx.origin);
    return { ok: true, deleted };
  },

  // 过期清理。默认按真实 TTL；TTL=0 的测试模式仅在 ?fsp_test=1 的标签页允许。
  async PRUNE_NOW(msg, _sender, fromPopup) {
    if (!fromPopup) return { ok: false, error: "popup-only" };
    if (msg && msg.testMode) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab || !tab.url || !tab.url.includes("fsp_test=1")) {
        return { ok: false, error: "test-mode-requires-fsp-test-tab" };
      }
      const result = await DB.pruneExpired(
        Date.now(),
        Number(msg.revisionTtl) || 0,
        Number(msg.tokenTtl) || 0,
      );
      return { ok: true, result };
    }
    const result = await DB.pruneExpired(Date.now());
    return { ok: true, result };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  const handler = HANDLERS[type];
  if (!handler) {
    sendResponse({ ok: false, error: "unknown-message" });
    return false;
  }
  // 弹窗发出的消息 sender 无 tab；其它一律按页面内容脚本校验
  const fromPopup = !(sender && sender.tab);
  Promise.resolve()
    .then(() => handler(msg, sender, fromPopup))
    .then((res) => sendResponse(res || { ok: true }))
    .catch((e) =>
      sendResponse({
        ok: false,
        error: "exception",
        message: String((e && e.message) || e),
      }),
    );
  return true; // 异步响应
});
