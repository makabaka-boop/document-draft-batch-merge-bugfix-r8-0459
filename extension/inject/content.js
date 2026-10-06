/*
 * content.js — 仅注入顶层文档（background 以 allFrames:false 注入）。
 * 运行在 isolated world：页面脚本无法接触本扩展状态。
 * 重复注入安全：单例监听器只装一次；每次注入都重新握手拿新文档令牌。
 */
(function () {
  "use strict";

  const P = window.FSP;

  if (window.__fspFsm) {
    window.__fspFsm.regrant();
    return;
  }

  /* ---------------- 状态（仅该文档内存；权威状态在后台 IndexedDB） ---------------- */
  const state = {
    token: null,
    lastToken: null, // 仅供测试钩子验证“旧令牌被顶掉”
    status: "connecting", // connecting | select-form | paused-route | paused-form | revoked | error
    statusDetail: "",
    route: P.fullRoute(location.href),
    forms: [],
    selectedForm: null,
    analysis: null,
    selectedKeys: new Set(),
    fieldsStale: false,
    drafts: [],
    preview: null, // {revision, current, validation}
    batch: null, // {revisions, analysis, choices, confirmed, fieldCount}
    batchIds: new Set(),
    appliedRevisions: new Set(),
  };

  const TEST_MODE = new URLSearchParams(location.search).has("fsp_test");

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError)
            return resolve({
              ok: false,
              error: "runtime",
              message: chrome.runtime.lastError.message,
            });
          resolve(res || { ok: false, error: "no-response" });
        });
      } catch (e) {
        resolve({ ok: false, error: "runtime", message: String(e) });
      }
    });
  }

  /* ---------------- DOM 分析 ---------------- */

  function labelFor(control) {
    if (control.id) {
      const l = document.querySelector(
        'label[for="' + CSS.escape(control.id) + '"]',
      );
      if (l && l.textContent.trim()) return l.textContent.trim();
    }
    const wrap = control.closest && control.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    if (control.getAttribute("aria-label"))
      return control.getAttribute("aria-label").trim();
    if (control.placeholder) return control.placeholder;
    return control.name || control.id || "";
  }

  function descriptorsOf(form) {
    return Array.from(form.querySelectorAll("input,textarea")).map((c) => ({
      tag: c.tagName,
      type: c.type,
      id: c.id || undefined,
      name: c.name || undefined,
      autocomplete: c.getAttribute("autocomplete") || "",
      placeholder: c.placeholder || "",
      ariaLabel: c.getAttribute("aria-label") || "",
      labelText: labelFor(c),
      disabled: !!c.disabled,
      readOnly: !!c.readOnly,
    }));
  }

  function scanForms() {
    const all = Array.from(document.querySelectorAll("form[id]"));
    const counts = new Map();
    for (const f of all) counts.set(f.id, (counts.get(f.id) || 0) + 1);
    return all.filter((f) => f.id && counts.get(f.id) === 1);
  }

  function controlOfKey(form, key) {
    if (!form) return null;
    if (key[0] === "#")
      return form.querySelector("#" + CSS.escape(key.slice(1)));
    const name = key.slice(1);
    // @name 键只可能来自“无 id 且 name 唯一”的控件
    return (
      Array.from(form.querySelectorAll("input,textarea")).find(
        (c) => !c.id && c.getAttribute("name") === name,
      ) || null
    );
  }

  /* ---------------- 握手 / 授权 ---------------- */

  async function handshake() {
    state.status = "connecting";
    state.statusDetail = "";
    render();
    const res = await send({ type: "HELLO" });
    if (!res.ok) {
      state.status = "error";
      state.statusDetail = res.error || "握手失败";
      render();
      return;
    }
    state.lastToken = state.token;
    state.token = res.token;
    state.route = res.route;
    resetSelection();
    state.status = "select-form";
    openPanel();
    render();
    refreshFormsAndDrafts();
  }

  function resetSelection() {
    state.selectedForm = null;
    state.analysis = null;
    state.selectedKeys = new Set();
    state.fieldsStale = false;
    state.preview = null;
    state.batch = null;
    state.batchIds = new Set();
  }

  async function regrant() {
    await handshake();
  }

  function teardownRevoked() {
    state.token = null;
    state.status = "revoked";
    resetSelection();
    state.drafts = [];
    closePanel();
  }

  /* ---------------- 路由与表单变化 ---------------- */

  function onRouteMaybeChanged() {
    const route = P.fullRoute(location.href);
    if (route === state.route) return;
    state.route = route;
    if (state.status === "revoked" || state.status === "error") return;
    // SPA 换路由：暂停绑定，要求重新选择（令牌仍属本文档，保存时后台按新路由隔离）
    resetSelection();
    state.drafts = [];
    state.status = "paused-route";
    render();
  }

  const routeObserver = () => onRouteMaybeChanged();
  window.addEventListener(P.ROUTE_EVENT, routeObserver, true);

  function onPageshow(e) {
    if (e.persisted) {
      // 从 bfcache 恢复：重新握手，旧令牌被事务性顶掉
      handshake();
    }
  }
  window.addEventListener("pageshow", onPageshow, true);

  // 整页导航（非 bfcache）前尽力撤回
  window.addEventListener(
    "pagehide",
    (e) => {
      if (!e.persisted && state.token) send({ type: "REVOKE" });
    },
    true,
  );

  let mutationScheduled = false;
  const domObserver = new MutationObserver(() => {
    if (mutationScheduled) return;
    mutationScheduled = true;
    setTimeout(() => {
      mutationScheduled = false;
      handleDomChange();
    }, 200);
  });

  function handleDomChange() {
    if (state.status === "revoked" || state.status === "connecting") return;
    state.forms = scanForms();
    if (state.selectedForm) {
      if (!state.selectedForm.isConnected) {
        // 表单被替换/移除：暂停绑定，不猜测相近表单
        resetSelection();
        state.status = "paused-form";
        render();
        return;
      }
      const fresh = P.analyze(descriptorsOf(state.selectedForm));
      if (
        P.fingerprint(fresh.eligible) !== P.fingerprint(state.analysis.eligible)
      ) {
        state.fieldsStale = true; // 字段集合变化，要求重新勾选
      }
      state.analysis = fresh;
      pruneInvalidSelection();
    }
    render();
  }

  function pruneInvalidSelection() {
    const valid = new Set(state.analysis.eligible.map((x) => x.key));
    for (const k of Array.from(state.selectedKeys)) {
      if (!valid.has(k)) state.selectedKeys.delete(k);
    }
  }

  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "id",
      "name",
      "type",
      "disabled",
      "readonly",
      "autocomplete",
    ],
  });

  /* ---------------- 操作：选择表单 ---------------- */

  function selectFormById(formId) {
    const form = state.forms.find((f) => f.id === formId) || null;
    state.selectedForm = form;
    state.selectedKeys = new Set();
    state.fieldsStale = false;
    state.preview = null;
    state.batch = null;
    state.batchIds = new Set();
    if (form) {
      state.analysis = P.analyze(descriptorsOf(form));
      state.status = "select-form";
    }
    render();
    refreshDrafts();
  }

  function toggleField(key, checked) {
    if (checked) {
      if (
        state.selectedKeys.size >= P.MAX_FIELDS &&
        !state.selectedKeys.has(key)
      ) {
        flash("最多选择 " + P.MAX_FIELDS + " 项");
        render();
        return;
      }
      state.selectedKeys.add(key);
    } else {
      state.selectedKeys.delete(key);
    }
    render();
  }

  function toggleAll(checked) {
    if (checked) {
      state.analysis.eligible
        .slice(0, P.MAX_FIELDS)
        .forEach((e) => state.selectedKeys.add(e.key));
    } else {
      state.selectedKeys.clear();
    }
    render();
  }

  let flashText = "";
  let flashTimer = null;
  function flash(text) {
    flashText = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashText = "";
      render();
    }, 2500);
  }

  /* ---------------- 操作：保存草稿 ---------------- */

  async function saveDraft(tokenOverride) {
    // 测试路径：跳过 UI 前置条件，直接发保存以验证后台令牌裁决（仅 ?fsp_test=1 页面可触发）
    if (tokenOverride) {
      const fp = state.analysis
        ? P.fingerprint(state.analysis.eligible)
        : "0123456789abcdef";
      const probe = await send({
        type: "SAVE_DRAFT",
        token: tokenOverride,
        envelope: {
          origin: location.origin,
          route: state.route,
          formId: state.selectedForm ? state.selectedForm.id : "__probe__",
          formFingerprint: fp,
          fields: [
            {
              key: "#__probe__",
              id: "__probe__",
              name: null,
              kind: "input:text",
              label: "probe",
              value: "",
            },
          ],
        },
      });
      reportTestResult(probe);
      return;
    }
    if (!state.selectedForm || state.fieldsStale) {
      flash("字段已变化，请重新选择后再保存");
      return;
    }
    // 保存瞬间重新分析，拒绝使用过期快照
    const analysis = P.analyze(descriptorsOf(state.selectedForm));
    const fpNow = P.fingerprint(analysis.eligible);
    if (state.analysis && P.fingerprint(state.analysis.eligible) !== fpNow) {
      state.fieldsStale = true;
      render();
      return;
    }
    state.analysis = analysis;
    pruneInvalidSelection();
    if (state.selectedKeys.size === 0) {
      flash("请先勾选要保存的字段");
      return;
    }

    const fields = analysis.eligible
      .filter((e) => state.selectedKeys.has(e.key))
      .map((e) => {
        const control = controlOfKey(state.selectedForm, e.key);
        return {
          key: e.key,
          id: e.descriptor.id || null,
          name: e.descriptor.name || null,
          kind: e.kind,
          label: (e.descriptor.labelText || e.key.slice(1)).slice(0, 200),
          value: control ? control.value : "",
        };
      });

    const envelope = {
      origin: location.origin,
      route: state.route,
      formId: state.selectedForm.id,
      formFingerprint: fpNow,
      fields,
    };
    const res = await send({
      type: "SAVE_DRAFT",
      token: state.token,
      envelope,
    });
    if (!res.ok) {
      flash("保存被拒绝：" + (res.error || "未知错误"));
      render();
      return;
    }
    flash("已保存为新修订");
    refreshDrafts();
  }

  /* ---------------- 操作：草稿列表 / 恢复预览 ---------------- */

  async function refreshFormsAndDrafts() {
    state.forms = scanForms();
    render();
    return refreshDrafts();
  }

  async function refreshDrafts() {
    if (!state.token) return;
    const res = await send({ type: "LIST_DRAFTS", token: state.token });
    if (!res.ok) {
      flash("读取草稿失败：" + res.error);
      return;
    }
    state.drafts = res.revisions || [];
    render();
  }

  async function openPreview(id) {
    if (!state.selectedForm) {
      flash("请先在上方选择要恢复到的表单");
      return;
    }
    state.batch = null;
    const res = await send({ type: "GET_REVISION", token: state.token, id });
    if (!res.ok) {
      flash("读取修订失败：" + res.error);
      return;
    }
    const revision = res.revision;

    // 不猜测：严格按保存的 key 在当前选中表单中找控件
    const currentAnalyze = P.analyze(descriptorsOf(state.selectedForm));
    const validation = P.validateRestore(
      { formFingerprint: revision.formFingerprint, fields: revision.fields },
      currentAnalyze,
    );
    const currentByKey = new Map();
    for (const f of revision.fields) {
      const control = controlOfKey(state.selectedForm, f.key);
      const hit = currentAnalyze.eligible.find((e) => e.key === f.key);
      currentByKey.set(f.key, {
        control,
        kind: hit ? hit.kind : null,
        currentValue: control ? control.value : "",
      });
    }
    state.analysis = currentAnalyze;
    state.preview = { revision, validation, currentByKey, confirmed: false };
    render();
  }

  function closePreview() {
    state.preview = null;
    render();
  }

  function setPreviewConfirm(v) {
    if (state.preview) state.preview.confirmed = v;
    render();
  }

  async function applyRestore() {
    const pv = state.preview;
    if (!pv || !pv.validation.ok || !pv.confirmed) return;
    // 全部通过校验后才统一写入，任一不过则完全不写
    const targets = pv.revision.fields.map((f) => {
      const cur = pv.currentByKey.get(f.key);
      return { f, control: cur.control };
    });
    if (targets.some((t) => !t.control)) {
      flash("存在找不到的字段，已拒绝");
      return;
    }
    for (const { f, control } of targets) {
      setNativeValue(control, f.value);
    }
    state.appliedRevisions.add(pv.revision.id);
    flash("已恢复 " + targets.length + " 个字段");
    state.preview = null;
    refreshDrafts();
  }

  // 用页面环境自身的原生 setter 赋值并派发 input/change，兼容 React/Vue 受控组件
  function setNativeValue(control, value) {
    const proto =
      control.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function consumeRevision(id) {
    const res = await send({
      type: "CONSUME_REVISION",
      token: state.token,
      id,
    });
    if (!res.ok) {
      flash("清理失败：" + res.error);
      return;
    }
    state.appliedRevisions.delete(id);
    flash("已删除该修订（其它草稿与期间新增内容保留）");
    refreshDrafts();
  }

  /* ---------------- 后台消息 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === "PING") {
      sendResponse({
        alive: true,
        bound: !!state.token,
        status: state.status,
        route: state.route,
        testMode: TEST_MODE,
      });
      return false;
    }
    if (msg.type === "AUTH_REVOKED") {
      teardownRevoked();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  /* ---------------- 测试钩子（仅 ?fsp_test=1 页面） ---------------- */

  function reportTestResult(res) {
    window.postMessage({ __fspTestResult: true, res }, location.origin);
  }

  window.addEventListener("message", async (ev) => {
    if (!TEST_MODE || ev.source !== window) return;
    const m = ev.data;
    if (!m || m.__fspTest !== true) return;
    if (m.action === "stale-save") {
      // 用被顶掉的旧令牌尝试迟到保存：预期被后台拒绝
      if (!state.lastToken) {
        reportTestResult({ ok: false, error: "no-previous-token" });
        return;
      }
      saveDraft(state.lastToken);
    } else if (m.action === "state") {
      reportTestResult({
        ok: true,
        status: state.status,
        route: state.route,
        hasToken: !!state.token,
      });
    } else if (m.action === "batch-select-form") {
      selectFormById(m.formId);
      reportTestResult({ ok: true });
    } else if (m.action === "batch-save") {
      // 走真实保存流程：勾选字段 → SAVE_DRAFT
      state.selectedKeys = new Set(m.keys || []);
      await saveDraft();
      await refreshDrafts();
      reportTestResult({ ok: true, drafts: state.drafts.map((d) => d.id) });
    } else if (m.action === "batch-pick") {
      for (const id of m.ids || []) state.batchIds.add(id);
      await openBatch();
      const b = state.batch;
      reportTestResult(
        b
          ? {
              ok: true,
              conflicts: b.analysis.groups
                .filter((g) => g.conflict)
                .map((g) => g.key),
              fieldCount: b.fieldCount,
            }
          : { ok: false, error: "batch-not-open", flash: flashText },
      );
    } else if (m.action === "batch-choice") {
      setBatchChoice(m.key, m.revisionId);
      reportTestResult({ ok: true });
    } else if (m.action === "batch-confirm") {
      setBatchConfirm(!!m.value);
      reportTestResult({ ok: true });
    } else if (m.action === "batch-apply") {
      await applyBatch();
      reportTestResult({
        ok: true,
        applied: [...state.appliedRevisions],
        values: (m.readKeys || []).map((k) => {
          const c = controlOfKey(state.selectedForm, k);
          return [k, c ? c.value : null];
        }),
        batchOpen: !!state.batch,
      });
    } else if (m.action === "batch-close") {
      closeBatch();
      reportTestResult({ ok: true });
    } else if (m.action === "set-value") {
      const c = controlOfKey(state.selectedForm, m.key);
      if (!c) {
        reportTestResult({ ok: false, error: "no-control" });
        return;
      }
      setNativeValue(c, m.value);
      reportTestResult({ ok: true });
    } else if (m.action === "detach-form") {
      if (state.selectedForm) state.selectedForm.isConnected = false;
      reportTestResult({ ok: true });
    }
  });

  /* ---------------- 面板 UI（closed Shadow DOM） ---------------- */

  let host = null;
  let root = null;

  const STYLE = `
  :host { all: initial; }
  * { font: 12px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .panel { position: fixed; top: 16px; right: 16px; width: 340px; max-height: 86vh;
    background: #fff; color: #1f2328; border: 1px solid #d0d7de; border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.18); z-index: 2147483647; display: flex; flex-direction: column; overflow: hidden; }
  .hd { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:#0f6fff; color:#fff; }
  .hd b { font-size:13px; }
  .hd button { background: transparent; color:#fff; border:0; cursor:pointer; font-size:14px; padding:0 2px; }
  .bd { overflow-y:auto; padding:10px 12px; }
  .sec { margin-bottom:12px; }
  .sec h3 { font-size:12px; margin:0 0 6px; color:#57606a; font-weight:600; }
  .banner { padding:6px 8px; border-radius:6px; margin-bottom:8px; font-size:12px; }
  .b-info { background:#ddf4ff; color:#0550ae; }
  .b-warn { background:#fff8c5; color:#7d4e00; }
  .b-err { background:#ffebe9; color:#cf222e; }
  select, button.btn, input[type=text] { width:100%; box-sizing:border-box; padding:5px 8px;
    border:1px solid #d0d7de; border-radius:6px; background:#fff; color:#1f2328; }
  button.btn { cursor:pointer; margin-top:6px; }
  button.btn.primary { background:#0f6fff; color:#fff; border-color:#0f6fff; }
  button.btn:disabled { opacity:.5; cursor:not-allowed; }
  .field { display:flex; gap:6px; align-items:flex-start; padding:3px 0; }
  .field input { margin:2px 0 0; }
  .field .k { color:#57606a; font-size:11px; word-break:break-all; }
  .ex { color:#8c959f; font-size:11px; }
  .draft { border:1px solid #d0d7de; border-radius:8px; padding:7px 9px; margin-bottom:6px; }
  .draft .top { display:flex; justify-content:space-between; gap:6px; }
  .draft .meta { color:#57606a; font-size:11px; }
  .tag { font-size:10px; padding:0 5px; border-radius:10px; background:#eaeef2; color:#57606a; white-space:nowrap;}
  .tag.same { background:#dafbe1; color:#0a7a37; }
  .tag.diff { background:#ffebe9; color:#cf222e; }
  .row { display:flex; gap:6px; margin-top:6px; }
  .row .btn { margin-top:0; }
  .flash { font-size:11px; color:#9a6700; background:#fff8c5; border-radius:6px; padding:5px 7px; margin-bottom:6px; }
  .overlay { position:absolute; inset:0; background:rgba(255,255,255,.97); display:flex; flex-direction:column; }
  .ov-hd { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-bottom:1px solid #d0d7de; font-weight:600; }
  .ov-bd { overflow-y:auto; padding:10px 12px; flex:1; }
  table { width:100%; border-collapse:collapse; }
  td { border-bottom:1px solid #eaeef2; padding:4px 5px; vertical-align:top; font-size:11px; word-break:break-word; }
  td.k { color:#57606a; width:34%; }
  .mismatch { color:#cf222e; font-weight:600; }
  .muted { color:#8c959f; }
  .confirm-line { display:flex; gap:7px; align-items:flex-start; margin:8px 0; }
  .count { color:#57606a; font-size:11px; }
  .choice { display:flex; gap:6px; align-items:flex-start; padding:2px 0 2px 10px; }
  .choice input { margin:3px 0 0; }
  .pick { font-weight:600; color:#0a7a37; }
  `;

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.startsWith("on"))
          el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, "");
        else if (v != null && v !== false) el.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }

  function openPanel() {
    if (host) {
      host.style.display = "";
      return;
    }
    host = document.createElement("div");
    host.id = "__fsp_panel_host";
    host.style.all = "initial";
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.appendChild(style);
    root.appendChild(h("div", { class: "panel", id: "panel" }));
    document.documentElement.appendChild(host);
  }

  function closePanel() {
    if (host) host.remove();
    host = null;
    root = null;
  }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleString();
    } catch (_e) {
      return String(ts);
    }
  }

  function statusBanner() {
    switch (state.status) {
      case "connecting":
        return h("div", { class: "banner b-info", text: "正在建立文档令牌…" });
      case "revoked":
        return h("div", {
          class: "banner b-err",
          text: "授权已撤回。重新点击扩展图标可再次授权。",
        });
      case "error":
        return h("div", {
          class: "banner b-err",
          text: "连接失败：" + state.statusDetail,
        });
      case "paused-route":
        return h("div", {
          class: "banner b-warn",
          text: "检测到 SPA 路由变化，已暂停绑定。请重新选择本页表单。",
        });
      case "paused-form":
        return h("div", {
          class: "banner b-warn",
          text: "原表单已被替换或移除，已暂停绑定。请重新选择表单，不会猜测其它输入框。",
        });
      default:
        if (state.fieldsStale) {
          return h("div", {
            class: "banner b-warn",
            text: "字段集合发生变化，请重新勾选后再保存或恢复。",
          });
        }
        return h("div", {
          class: "banner b-info",
          text: "已授权当前文档（令牌仅限本文档、本标签页）。",
        });
    }
  }

  function renderSelectionSection() {
    const sec = h("div", { class: "sec" }, h("h3", { text: "1. 选择字段" }));
    if (!state.forms.length) {
      sec.appendChild(
        h("div", { class: "muted", text: "本页没有带唯一 id 的表单。" }),
      );
      return sec;
    }
    const sel = h(
      "select",
      {
        onChange: (e) => selectFormById(e.target.value || null),
      },
      [h("option", { value: "", text: "— 选择表单（需带唯一 id）—" })],
    );
    for (const f of state.forms) {
      const a = P.analyze(descriptorsOf(f));
      const opt = h("option", {
        value: f.id,
        text: "#" + f.id + "（" + a.eligible.length + " 个可保存字段）",
      });
      if (state.selectedForm === f) opt.selected = true;
      sel.appendChild(opt);
    }
    sec.appendChild(sel);

    if (state.selectedForm && state.analysis) {
      const a = state.analysis;
      const allBox = h("input", {
        type: "checkbox",
        onChange: (e) => toggleAll(e.target.checked),
      });
      allBox.checked =
        a.eligible.length > 0 &&
        a.eligible.every((x) => state.selectedKeys.has(x.key));
      sec.appendChild(
        h("div", { class: "field", style: "margin-top:6px" }, [
          allBox,
          h("b", { text: "全选可选字段" }),
          h("span", {
            class: "count",
            text:
              "（已选 " + state.selectedKeys.size + "/" + P.MAX_FIELDS + "）",
          }),
        ]),
      );
      for (const e of a.eligible) {
        const cb = h("input", {
          type: "checkbox",
          onChange: (ev) => toggleField(e.key, ev.target.checked),
        });
        cb.checked = state.selectedKeys.has(e.key);
        sec.appendChild(
          h("div", { class: "field" }, [
            cb,
            h("div", null, [
              h("div", { text: e.descriptor.labelText || e.key.slice(1) }),
              h("div", { class: "k", text: e.key + " · " + e.kind }),
            ]),
          ]),
        );
      }
      if (a.excluded.length) {
        const groups = new Map();
        for (const x of a.excluded) {
          const t = P.REASON_TEXT[x.reason] || x.reason;
          groups.set(t, (groups.get(t) || 0) + 1);
        }
        sec.appendChild(
          h(
            "div",
            { class: "ex", style: "margin-top:6px" },
            "已排除：" + Array.from(groups, ([t, n]) => t + "×" + n).join("；"),
          ),
        );
      }
      sec.appendChild(
        h("button", {
          class: "btn primary",
          disabled: state.fieldsStale || state.status !== "select-form",
          onClick: () => saveDraft(),
          text: "保存所选为新草稿修订",
        }),
      );
    }
    return sec;
  }

  // 当前表单身份（formId + 实时全字段指纹）
  function currentFormIdentity(form) {
    const analysis = P.analyze(descriptorsOf(form));
    const fp = P.fingerprint(analysis.eligible);
    return { analysis, fp, identity: P.formIdentity(form.id, fp) };
  }

  // 从实时 DOM 构造合并策略所需快照；控件引用原样放入（策略层只用 === 比较）
  function batchSnapshot() {
    const form = state.selectedForm;
    if (!form || !form.isConnected || state.status !== "select-form")
      throw Error("当前文档未绑定表单");
    const { analysis, fp, identity } = currentFormIdentity(form);
    return {
      token: state.token,
      route: P.fullRoute(location.href),
      formId: form.id,
      formIdentity: identity,
      fingerprint: fp,
      form,
      fields: analysis.eligible.map((f) => {
        const control = controlOfKey(form, f.key);
        return {
          key: f.key,
          id: f.descriptor.id || null,
          name: f.descriptor.name || null,
          kind: f.kind,
          value: control ? control.value : "",
          control,
        };
      }),
    };
  }

  // 打开合并预览：读取所选修订 → 策略层校验并分组（同值合并 / 标记冲突）。
  // 此时不写任何字段；冲突来源由用户在预览层逐字段明确选择。
  async function openBatch() {
    if (state.status !== "select-form" || !state.selectedForm) {
      flash("请先选择当前表单");
      return;
    }
    const ids = [...state.batchIds];
    if (ids.length < 2) {
      flash("请勾选至少 2 份同表单修订后再合并");
      return;
    }
    if (ids.length > FSPBatch.MAX_BATCH_REVISIONS) {
      flash("一次最多合并 " + FSPBatch.MAX_BATCH_REVISIONS + " 份修订");
      return;
    }
    let snapshot;
    try {
      snapshot = batchSnapshot();
    } catch (e) {
      flash(e.message);
      return;
    }
    const revisions = [];
    for (const id of ids) {
      const response = await send({
        type: "GET_REVISION",
        token: state.token,
        id,
      });
      if (!response.ok) {
        flash("读取修订失败：" + response.error);
        return;
      }
      revisions.push(response.revision);
    }
    const analysis = FSPBatch.analyzeMerge(revisions, snapshot);
    if (!analysis.ok) {
      flash("无法合并：" + (FSPBatch.ERRORS[analysis.error] || analysis.error));
      return;
    }
    // 默认不替用户选择任何冲突值；旧的单修订预览让位给合并预览
    state.preview = null;
    state.batch = {
      revisions,
      analysis,
      choices: {},
      confirmed: false,
      fieldCount: analysis.fieldCount,
    };
    render();
  }

  function setBatchChoice(key, revisionId) {
    const b = state.batch;
    if (!b) return;
    if (b.choices[key] !== revisionId) b.confirmed = false; // 选择变化需重新二次确认
    b.choices[key] = revisionId;
    render();
  }

  function setBatchConfirm(v) {
    if (state.batch) state.batch.confirmed = v;
    render();
  }

  function closeBatch() {
    state.batch = null;
    render();
  }

  // 确认恢复：授权/路由复核 → 对“确认瞬间”的实时 DOM 重建快照 →
  // 策略层全量复核通过后一次性写入；任一条件失效整组拒绝、一项不改。
  async function applyBatch() {
    const b = state.batch;
    if (!b) return;
    const resolved = FSPBatch.buildMergePlan(b.analysis, b.choices);
    if (!resolved.ok || !b.confirmed) {
      flash("仍有冲突字段未选择来源或未完成确认");
      render();
      return;
    }

    // 过期 / 撤回 / 被顶掉的授权不能恢复（后台以浏览器 sender 身份为准）
    const auth = await send({ type: "VERIFY_TOKEN", token: state.token });
    if (!auth.ok) {
      flash("授权已失效，整组未恢复：" + auth.error);
      state.batch = null;
      render();
      return;
    }
    if (auth.route !== P.fullRoute(location.href)) {
      flash("路由已变化，整组未恢复");
      state.batch = null;
      render();
      return;
    }

    let snapshot;
    try {
      snapshot = batchSnapshot();
    } catch (e) {
      flash("表单绑定已失效，整组未恢复：" + e.message);
      state.batch = null;
      render();
      return;
    }

    const written = [];
    const result = FSPBatch.commitPlan(
      resolved.plan,
      snapshot,
      (field, value) => {
        setControlValueQuiet(field.control, value);
        written.push(field.control);
      },
    );
    if (!result.ok) {
      // commitPlan 在任何写入前就已完成全部复核，这里失败保证一个字段都没动
      flash("整组拒绝，未改动任何字段：" + (FSPBatch.ERRORS[result.error] || result.error));
      state.batch = null;
      render();
      return;
    }
    for (const control of written) {
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // 只把“实际成功恢复”的修订标记为可清理；冲突落败/未完整恢复的修订不标记
    for (const id of result.appliedRevisionIds)
      state.appliedRevisions.add(id);
    flash(
      "已合并恢复 " +
        resolved.plan.fields.length +
        " 个字段（来自 " +
        result.appliedRevisionIds.length +
        " 份修订）",
    );
    state.batch = null;
    state.batchIds = new Set();
    refreshDrafts();
  }

  // 不派发事件的原生 setter 赋值（整组写完后由调用方统一派发 input/change）
  function setControlValueQuiet(control, value) {
    const proto =
      control.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(control, value);
  }
  function renderDraftsSection() {
    const sec = h(
      "div",
      { class: "sec" },
      h("h3", { text: "2. 草稿修订（" + state.drafts.length + "）" }),
    );
    if (!state.drafts.length) {
      sec.appendChild(
        h("div", {
          class: "muted",
          text: "当前 origin + 完整路由下暂无草稿。按 origin、路由、表单身份隔离。",
        }),
      );
      return sec;
    }
    const currentIdentity =
      state.selectedForm && state.analysis
        ? P.formIdentity(
            state.selectedForm.id,
            P.fingerprint(state.analysis.eligible),
          )
        : null;
    const selectableCount = state.drafts.filter(
      (d) => currentIdentity && d.formIdentity === currentIdentity,
    ).length;
    const mergeBtn = h("button", {
      class: "btn",
      text:
        "合并已选修订（" +
        state.batchIds.size +
        "/" +
        FSPBatch.MAX_BATCH_REVISIONS +
        "，需 2 份起、仅限当前表单）",
      onClick: openBatch,
    });
    mergeBtn.disabled =
      state.batchIds.size < 2 ||
      state.batchIds.size > FSPBatch.MAX_BATCH_REVISIONS ||
      !currentIdentity;
    sec.appendChild(mergeBtn);
    for (const d of state.drafts) {
      const sameForm = !!currentIdentity && d.formIdentity === currentIdentity;
      const card = h("div", { class: "draft" }, [
        h("div", { class: "top" }, [
          h("div", null, [
            h("b", { text: "#" + d.formId }),
            h("div", {
              class: "meta",
              text:
                fmtTime(d.createdAt) +
                " · " +
                d.fieldCount +
                " 项 · " +
                d.id.slice(-6),
            }),
          ]),
          h("span", {
            class: "tag " + (sameForm ? "same" : "diff"),
            text: sameForm ? "当前表单一致" : "表单不一致",
          }),
        ]),
      ]);
      const row = h("div", { class: "row" });
      // 合并仅允许选择与当前表单身份完全一致的修订；不同表单的勾选项禁用
      const batchCb = h("input", {
        type: "checkbox",
        title: sameForm ? "加入合并" : "表单不一致，不能参与合并",
        onChange: (e) => {
          if (e.target.checked) {
            if (state.batchIds.size >= FSPBatch.MAX_BATCH_REVISIONS) {
              flash("一次最多合并 " + FSPBatch.MAX_BATCH_REVISIONS + " 份修订");
              e.target.checked = false;
              return;
            }
            state.batchIds.add(d.id);
          } else {
            state.batchIds.delete(d.id);
          }
          render();
        },
      });
      batchCb.checked = state.batchIds.has(d.id);
      if (!sameForm) batchCb.disabled = true;
      row.appendChild(batchCb);
      row.appendChild(
        h("button", {
          class: "btn primary",
          onClick: () => openPreview(d.id),
          text: "恢复预览",
        }),
      );
      if (state.appliedRevisions.has(d.id)) {
        row.appendChild(
          h("button", {
            class: "btn",
            onClick: () => consumeRevision(d.id),
            text: "我已提交完成，删除此修订",
          }),
        );
      }
      card.appendChild(row);
      sec.appendChild(card);
    }
    if (state.selectedForm && selectableCount < 2) {
      sec.appendChild(
        h("div", {
          class: "ex",
          style: "margin-top:4px",
          text: "当前表单至少需要 2 份修订才能合并；表单不一致的修订不参与。",
        }),
      );
    }
    return sec;
  }

  function renderPreviewOverlay() {
    const pv = state.preview;
    const ov = h("div", { class: "overlay" }, [
      h("div", { class: "ov-hd" }, [
        h("span", { text: "3. 恢复预览与确认" }),
        h("button", {
          class: "btn",
          style: "width:auto;margin:0",
          onClick: closePreview,
          text: "✕",
        }),
      ]),
      h("div", { class: "ov-bd" }),
    ]);
    const bd = ov.querySelector(".ov-bd");

    if (!pv.validation.ok) {
      bd.appendChild(
        h("div", {
          class: "banner b-err",
          text: "字段身份或类型已变化，拒绝恢复，且不会猜测相近输入框。请重新选择字段保存新草稿。",
        }),
      );
      const ul = h("div", null);
      const reasons = new Map(
        pv.validation.mismatches.map((m) => [m.reason, 0]),
      );
      for (const m of pv.validation.mismatches)
        reasons.set(m.reason, reasons.get(m.reason) + 1);
      const reasonText = {
        missing: "字段已消失",
        "kind-changed": "字段类型变化",
        "identity-changed": "id/name 变化",
        "form-fingerprint-changed": "表单字段集合变化（新增或删除了字段）",
      };
      for (const [r, n] of reasons) {
        ul.appendChild(
          h("div", {
            class: "mismatch",
            text: "· " + (reasonText[r] || r) + " ×" + n,
          }),
        );
      }
      bd.appendChild(ul);
      bd.appendChild(
        h("button", { class: "btn", onClick: closePreview, text: "返回" }),
      );
      return ov;
    }

    const table = h(
      "table",
      null,
      h("tr", null, [
        h("td", { class: "k", text: "字段" }),
        h("td", { text: "当前值 → 草稿值" }),
      ]),
    );
    for (const f of pv.revision.fields) {
      const cur = pv.currentByKey.get(f.key);
      const tr = h("tr", null, [
        h(
          "td",
          { class: "k" },
          h("div", null, [
            h("div", { text: f.label }),
            h("div", { class: "muted", text: f.key + " · " + f.kind }),
          ]),
        ),
        h("td", null, [
          h("div", {
            class: "muted",
            text: cur.currentValue === "" ? "（空）" : cur.currentValue,
          }),
          h("div", {
            text: "↓ " + (f.value === "" ? "（清空为空）" : f.value),
          }),
        ]),
      ]);
      table.appendChild(tr);
    }
    bd.appendChild(table);

    const cb = h("input", {
      type: "checkbox",
      onChange: (e) => setPreviewConfirm(e.target.checked),
    });
    bd.appendChild(
      h("label", { class: "confirm-line" }, [
        cb,
        h("span", {
          text:
            "我确认将以上 " +
            pv.revision.fields.length +
            " 个字段覆盖为草稿值（此为第二次确认）。",
        }),
      ]),
    );
    bd.appendChild(
      h("button", {
        class: "btn primary",
        disabled: !pv.confirmed,
        onClick: applyRestore,
        text: "确认恢复",
      }),
    );
    bd.appendChild(
      h("div", {
        class: "muted",
        style: "margin-top:8px",
        text: "恢复不会自动提交，也不会删除草稿；确认表单提交完成后，可手动删除对应修订。",
      }),
    );
    return ov;
  }

  function renderBatchOverlay() {
    const b = state.batch;
    const a = b.analysis;
    const ov = h("div", { class: "overlay" }, [
      h("div", { class: "ov-hd" }, [
        h("span", {
          text:
            "3. 多修订合并预览与确认（" +
            a.revisionIds.length +
            " 份 · " +
            b.fieldCount +
            " 个字段）",
        }),
        h("button", {
          class: "btn",
          style: "width:auto;margin:0",
          onClick: closeBatch,
          text: "✕",
        }),
      ]),
      h("div", { class: "ov-bd" }),
    ]);
    const bd = ov.querySelector(".ov-bd");

    const planResult = FSPBatch.buildMergePlan(a, b.choices);
    const unresolved = a.groups.filter(
      (g) => g.conflict && !Object.prototype.hasOwnProperty.call(b.choices, g.key),
    );

    bd.appendChild(
      h("div", {
        class: "banner b-info",
        text:
          "同值字段已自动合并；标红的冲突字段必须由你逐字段选择采用哪一份修订，不会以新旧自动覆盖。",
      }),
    );

    const table = h("table", null, [
      h("tr", null, [
        h("td", { class: "k", text: "字段" }),
        h("td", { text: "当前值 → 合并值与来源" }),
      ]),
    ]);

    for (const g of a.groups) {
      const keyCell = h(
        "td",
        { class: "k" },
        h("div", null, [
          h("div", { text: g.label }),
          h("div", { class: "muted", text: g.key + " · " + g.kind }),
        ]),
      );
      const valCell = h("td");
      valCell.appendChild(
        h("div", {
          class: "muted",
          text: "当前值：" + (g.currentValue === "" ? "（空）" : g.currentValue),
        }),
      );

      if (g.conflict) {
        const chosen = b.choices[g.key];
        valCell.appendChild(
          h(
            "div",
            {
              class: "mismatch",
              style: "margin:3px 0",
              text:
                "⚠ 各修订值不同，请明确选择来源" +
                (chosen ? "" : "（未选择）"),
            },
          ),
        );
        for (const d of g.distinct) {
          const safeName = g.key.replace(/[^a-zA-Z0-9_-]/g, "_");
          const labelId = "__fsp_r_" + safeName + "_" + d.ids[0];
          const radio = h("input", {
            type: "radio",
            name: "fspsrc_" + safeName,
            id: labelId,
            onChange: () => setBatchChoice(g.key, d.ids[0]),
          });
          radio.checked = chosen != null && d.ids.includes(chosen);
          const sameChoice =
            chosen != null && d.ids.includes(chosen);
          const line = h("label", { class: "choice" }, [
            radio,
            h("span", {
              class: sameChoice ? "pick" : "",
              text:
                (d.value === "" ? "（清空为空）" : d.value) +
                "　← 修订尾号 " +
                d.ids.map((id) => id.slice(-6)).join(" / "),
            }),
          ]);
          valCell.appendChild(line);
        }
      } else {
        valCell.appendChild(
          h("div", {
            style: "margin:3px 0",
            text:
              "✓ 各修订同值，自动合并：" +
              (g.distinct[0].value === "" ? "（清空为空）" : g.distinct[0].value) +
              "（" +
              g.sources.length +
              " 份一致）",
          }),
        );
      }
      table.appendChild(h("tr", null, [keyCell, valCell]));
    }
    bd.appendChild(table);

    if (unresolved.length) {
      bd.appendChild(
        h("div", {
          class: "banner b-err",
          style: "margin-top:8px",
          text: "还有 " + unresolved.length + " 个冲突字段未选择来源，整组恢复暂不可用。",
        }),
      );
    }
    if (!planResult.ok && planResult.error !== "missing-choice") {
      bd.appendChild(
        h("div", {
          class: "banner b-err",
          style: "margin-top:8px",
          text: FSPBatch.ERRORS[planResult.error] || planResult.error,
        }),
      );
    }

    const cb = h("input", {
      type: "checkbox",
      onChange: (e) => setBatchConfirm(e.target.checked),
    });
    cb.checked = b.confirmed;
    bd.appendChild(
      h("label", { class: "confirm-line" }, [
        cb,
        h("span", {
          text:
            "我确认按上述选择合并恢复 " +
            b.fieldCount +
            " 个字段；未选中的字段保持原值（第二次确认）。",
        }),
      ]),
    );
    const applyBtn = h("button", {
      class: "btn primary",
      onClick: applyBatch,
      text: "确认合并恢复",
    });
    applyBtn.disabled =
      unresolved.length > 0 || !planResult.ok || !b.confirmed;
    bd.appendChild(applyBtn);
    bd.appendChild(
      h("div", {
        class: "muted",
        style: "margin-top:8px",
        text:
          "确认后会再次复核授权、路由、表单身份、控件与各字段当前值；任一变化整组拒绝且不改动任何字段。仅实际完整恢复的修订可在提交后清理。",
      }),
    );
    return ov;
  }

  function render() {
    if (!root) return;
    const panel = root.getElementById("panel");
    panel.textContent = "";

    panel.appendChild(
      h("div", { class: "hd" }, [
        h("b", { text: "表单暂存 · 本地" }),
        h("button", {
          title: "收起",
          onClick: () => {
            if (host) host.style.display = "none";
          },
          text: "—",
        }),
      ]),
    );
    const bd = h("div", { class: "bd" });
    panel.appendChild(bd);

    bd.appendChild(statusBanner());
    if (flashText)
      bd.appendChild(h("div", { class: "flash", text: flashText }));

    if (state.token && state.status !== "revoked" && state.status !== "error") {
      bd.appendChild(renderSelectionSection());
      bd.appendChild(renderDraftsSection());
    }
    if (state.preview) panel.appendChild(renderPreviewOverlay());
    if (state.batch) panel.appendChild(renderBatchOverlay());
  }

  window.__fspFsm = { regrant, handshake };

  // 首次注入即握手
  handshake();
})();
