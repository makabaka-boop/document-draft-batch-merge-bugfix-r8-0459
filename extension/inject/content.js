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

  window.addEventListener("message", (ev) => {
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

  function batchSnapshot() {
    const form = state.selectedForm;
    if (!form || !form.isConnected || state.status !== "select-form")
      throw Error("当前文档未绑定表单");
    const analysis = P.analyze(descriptorsOf(form)),
      fingerprint = P.fingerprint(analysis.eligible);
    return {
      token: state.token,
      route: P.fullRoute(location.href),
      formId: form.id,
      formIdentity: P.formIdentity(form.id, fingerprint),
      fingerprint,
      form,
      fields: analysis.eligible.map((f) => {
        const control = controlOfKey(form, f.key);
        return { key: f.key, kind: f.kind, value: control.value, control };
      }),
    };
  }
  async function openBatch() {
    try {
      const snapshot = batchSnapshot(),
        ids = [...state.batchIds],
        revisions = [];
      for (const id of ids) {
        const response = await send({
          type: "GET_REVISION",
          token: snapshot.token,
          id,
        });
        if (!response.ok) throw Error(response.error);
        revisions.push(response.revision);
      }
      const choices = {},
        values = new Map();
      for (const r of revisions)
        for (const f of r.fields) {
          const list = values.get(f.key) ?? [];
          list.push({ id: r.id, value: f.value });
          values.set(f.key, list);
        }
      for (const [key, list] of values)
        if (new Set(list.map((x) => x.value)).size > 1) {
          const choice = prompt(
            "字段 " +
              key +
              " 有冲突，请输入采用的修订 ID：" +
              JSON.stringify(list),
          );
          if (choice === null) return;
          choices[key] = choice;
        }
      const plan = FSPBatch.buildPlan(revisions, choices, snapshot);
      if (
        !confirm(
          "确认合并恢复这些字段？" +
            JSON.stringify(
              plan.fields.map((f) => ({
                key: f.key,
                source: f.sourceId,
                before: f.before,
                after: f.value,
              })),
            ),
        )
      )
        return;
      const auth = await send({
        type: "LIST_DRAFTS",
        token: plan.context.token,
      });
      if (!auth.ok) throw Error("授权已变化");
      const events = [];
      FSPBatch.commit(plan, batchSnapshot(), (field, value) => {
        const prototype =
          field.control.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(
          field.control,
          value,
        );
        events.push(field.control);
      });
      for (const control of events) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }
      for (const id of plan.revisions) state.appliedRevisions.add(id);
      flash("已合并恢复 " + plan.fields.length + " 个字段");
      refreshDrafts();
    } catch (e) {
      flash("合并恢复被拒绝：" + e.message);
    }
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
    sec.appendChild(
      h("button", { class: "btn", text: "合并已选修订", onClick: openBatch }),
    );
    for (const d of state.drafts) {
      const sameForm =
        state.selectedForm &&
        d.formIdentity ===
          P.formIdentity(
            state.selectedForm.id,
            P.fingerprint((state.analysis || { eligible: [] }).eligible),
          );
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
      row.appendChild(
        h("input", {
          type: "checkbox",
          checked: state.batchIds.has(d.id),
          onChange: (e) => {
            if (e.target.checked) state.batchIds.add(d.id);
            else state.batchIds.delete(d.id);
          },
        }),
      );
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
  }

  window.__fspFsm = { regrant, handshake };

  // 首次注入即握手
  handshake();
})();
