/*
 * policy.js — 纯策略/判定逻辑，无 DOM、无 chrome.* 依赖。
 * 同时适用于：内容脚本（isolated world）、background service worker、Node 单元测试。
 * 经典脚本挂载到 globalThis.FSP；Node 下通过 module.exports 导出。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FSP = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MAX_FIELDS = 20; // 每份草稿最多保存字段数
  const MAX_VALUE_BYTES = 64 * 1024; // 单值上限
  const MAX_TOTAL_BYTES = 256 * 1024; // 单份草稿总值上限
  const MAX_ID_LEN = 128;
  const MAX_LABEL_LEN = 200;

  const ALLOWED_INPUT_TYPES = [
    "text",
    "search",
    "url",
    "tel",
    "email",
    "number",
  ];
  const INPUT_KINDS = new Set(ALLOWED_INPUT_TYPES.map((t) => "input:" + t));

  // 数据库与 TTL（background 也引用这里的常量，保证单一事实来源）
  const DB_NAME = "form-save-local-v1";
  const DB_VERSION = 1;
  const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 授权令牌 12 小时
  const REVISION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 草稿修订 7 天
  const ALARM_NAME = "fsp-sweep";
  const ALARM_PERIOD_MIN = 30;

  const ROUTE_EVENT = "__fsp_routechange__"; // main world -> isolated world

  /* ---------------- URL / scope ---------------- */

  function isInjectableUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (_e) {
      return false;
    }
  }

  function originOf(url) {
    return new URL(url).origin;
  }

  // 完整路由 = origin + pathname + search + hash（hash 也参与隔离，SPA 不同视图互不串草稿）
  function fullRoute(url) {
    const u = new URL(url);
    return u.origin + u.pathname + u.search + u.hash;
  }

  /* ---------------- 敏感字段判定 ---------------- */

  // 一次性验证码：autocomplete=one-time-code，或 id/name/placeholder/aria-label 命中
  const OTP_TOKEN_RE = /otp|2fa|mfa|captcha|passcode|one[._-]?time/;
  const OTP_WORD_RE = /sms|verification|verify|auth(?:orization|or)?|security/;
  const OTP_CJK_RE = /验证码|短信验证|动态码/;

  // 支付自动填充：cc-* / transaction-* autocomplete token，或卡号、有效期、CVV 等
  const PAY_TOKEN_RE =
    /credit|card|csc|cvv|cvc|cc[._-]?(?:num|name|exp|csc|type)|expir(?:y|ation|es|ed)|cardholder/;
  const PAY_CJK_RE = /卡号|信用卡|银行卡|有效期|安全码/;

  function autocompleteTokens(desc) {
    const raw = (desc.autocomplete || "").toLowerCase();
    return raw.split(/[\s]+/).filter(Boolean);
  }

  function signalTokens(desc) {
    const s = [
      desc.id || "",
      desc.name || "",
      desc.placeholder || "",
      desc.ariaLabel || "",
    ]
      .join("\n")
      .toLowerCase();
    return s.split(/[^a-z0-9]+/).filter(Boolean);
  }

  function signals(desc) {
    return [
      desc.id || "",
      desc.name || "",
      desc.placeholder || "",
      desc.ariaLabel || "",
      desc.labelText || "",
    ]
      .join("\n")
      .toLowerCase();
  }

  function isOtp(desc) {
    const tokens = autocompleteTokens(desc);
    if (tokens.includes("one-time-code")) return true;
    const toks = signalTokens(desc);
    if (toks.some((t) => OTP_TOKEN_RE.test(t))) return true;
    // sms/verify/auth/security 这类常见词要求与 code 组合出现，避免误伤
    const sig = signals(desc);
    if (OTP_WORD_RE.test(sig) && /code|验证码|短信|动态/.test(sig)) return true;
    return OTP_CJK_RE.test(sig);
  }

  function isPayment(desc) {
    const tokens = autocompleteTokens(desc);
    if (tokens.some((t) => t.startsWith("cc-") || t.startsWith("transaction-")))
      return true;
    const toks = signalTokens(desc);
    if (toks.some((t) => PAY_TOKEN_RE.test(t))) return true;
    return PAY_CJK_RE.test(signals(desc));
  }

  function kindOf(desc) {
    const tag = (desc.tag || "").toUpperCase();
    if (tag === "TEXTAREA") return "textarea";
    const type = (desc.type || "text").toLowerCase();
    return "input:" + type;
  }

  /* ---------------- 表单/控件分析 ---------------- */

  // descriptors: [{tag, type, id, name, autocomplete, placeholder, ariaLabel,
  //                 labelText, disabled, readOnly}]，按文档顺序排列
  function analyze(descriptors) {
    const idCount = new Map();
    const nameCount = new Map();
    for (const d of descriptors) {
      if (d.id) idCount.set(d.id, (idCount.get(d.id) || 0) + 1);
      if (d.name) nameCount.set(d.name, (nameCount.get(d.name) || 0) + 1);
    }

    const eligible = [];
    const excluded = [];

    descriptors.forEach((d, index) => {
      const tag = (d.tag || "").toUpperCase();
      const kind = kindOf(d);
      const reject = (reason) => excluded.push({ index, reason, kind });

      if (tag !== "INPUT" && tag !== "TEXTAREA") return reject("tag");
      if (tag === "INPUT" && !INPUT_KINDS.has(kind)) return reject("type");
      if (d.disabled) return reject("disabled");
      if (d.readOnly) return reject("readonly");
      if (!d.id && !d.name) return reject("identity");
      if (d.id && (idCount.get(d.id) || 0) > 1) return reject("duplicate-id");
      // 有唯一 id 即可；无 id 时退而要求 name 唯一
      if (!d.id && (nameCount.get(d.name) || 0) > 1)
        return reject("duplicate-name");
      if (isOtp(d)) return reject("otp");
      if (isPayment(d)) return reject("payment");

      const key = d.id ? "#" + d.id : "@" + d.name;
      eligible.push({ descriptor: d, key, kind, index });
    });

    return { eligible, excluded, idCount, nameCount };
  }

  /* ---------------- 指纹 / 表单身份 ---------------- */

  function fnv1a64Hex(str) {
    const bytes = new TextEncoder().encode(str);
    let h = 0xcbf29ce484222325n;
    for (const b of bytes) {
      h ^= BigInt(b);
      h = BigInt.asUintN(64, h * 0x100000001b3n);
    }
    return h.toString(16).padStart(16, "0");
  }

  // 指纹覆盖“当前可保存的全部字段”，字段增删/类型变化都会改变指纹
  function fingerprint(eligible) {
    const parts = eligible.map((e) =>
      [e.key, e.kind, e.descriptor.id || "", e.descriptor.name || ""].join("|"),
    );
    return fnv1a64Hex(parts.join("~"));
  }

  // 表单身份：form 元素自身 id（调用方保证文档内唯一）+ 字段指纹
  function formIdentity(formId, fp) {
    return formId + "#" + fp;
  }

  /* ---------------- 恢复校验：身份或类型变化即拒绝 ---------------- */

  function validateRestore(envelope, currentAnalyze) {
    const mismatches = [];
    const byKey = new Map(currentAnalyze.eligible.map((e) => [e.key, e]));
    for (const f of envelope.fields) {
      const cur = byKey.get(f.key);
      if (!cur) {
        mismatches.push({ key: f.key, label: f.label, reason: "missing" });
        continue;
      }
      if (cur.kind !== f.kind) {
        mismatches.push({ key: f.key, label: f.label, reason: "kind-changed" });
        continue;
      }
      if (
        (cur.descriptor.id || "") !== (f.id || "") ||
        (cur.descriptor.name || "") !== (f.name || "")
      ) {
        mismatches.push({
          key: f.key,
          label: f.label,
          reason: "identity-changed",
        });
      }
    }
    const currentFp = fingerprint(currentAnalyze.eligible);
    if (currentFp !== envelope.formFingerprint) {
      mismatches.push({
        key: "",
        label: "",
        reason: "form-fingerprint-changed",
      });
    }
    return { ok: mismatches.length === 0, mismatches, currentFp };
  }

  /* ---------------- 保存载荷校验 ---------------- */

  function byteLen(s) {
    return new TextEncoder().encode(String(s)).length;
  }

  function clip(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) : s;
  }

  const REASON_TEXT = {
    tag: "非文本控件",
    type: "类型不允许（password/file/hidden/checkbox 等）",
    disabled: "已禁用",
    readonly: "只读",
    identity: "缺少 id 与 name",
    "duplicate-id": "表单内 id 重复",
    "duplicate-name": "表单内 name 重复",
    otp: "一次性验证码字段",
    payment: "支付自动填充字段",
  };

  // 由内容脚本选出的字段构造并校验修订信封；background 会再次校验
  function buildEnvelope(input) {
    const e = input || {};
    if (!isInjectableUrl(e.origin)) return { ok: false, error: "bad-origin" };
    if (typeof e.route !== "string" || !e.route.startsWith(e.origin)) {
      return { ok: false, error: "bad-route" };
    }
    if (
      !e.formId ||
      typeof e.formId !== "string" ||
      e.formId.length > MAX_ID_LEN
    ) {
      return { ok: false, error: "bad-form-id" };
    }
    if (!/^[0-9a-f]{16}$/.test(e.formFingerprint || "")) {
      return { ok: false, error: "bad-fingerprint" };
    }
    if (!Array.isArray(e.fields) || e.fields.length === 0)
      return { ok: false, error: "empty" };
    if (e.fields.length > MAX_FIELDS)
      return { ok: false, error: "too-many-fields" };

    const seen = new Set();
    let total = 0;
    const fields = [];
    for (const f of e.fields) {
      const key = f && f.key;
      if (typeof key !== "string" || !/^(#|@).+/.test(key) || seen.has(key)) {
        return { ok: false, error: "bad-field-key" };
      }
      seen.add(key);
      const kind = f.kind;
      const kindOk = kind === "textarea" || INPUT_KINDS.has(kind);
      if (!kindOk) return { ok: false, error: "bad-field-kind" };
      if (
        f.id != null &&
        (typeof f.id !== "string" || f.id.length > MAX_ID_LEN)
      ) {
        return { ok: false, error: "bad-field-id" };
      }
      if (
        f.name != null &&
        (typeof f.name !== "string" || f.name.length > MAX_ID_LEN)
      ) {
        return { ok: false, error: "bad-field-name" };
      }
      const value = f.value == null ? "" : String(f.value);
      if (byteLen(value) > MAX_VALUE_BYTES)
        return { ok: false, error: "value-too-large" };
      total += byteLen(value);
      if (total > MAX_TOTAL_BYTES)
        return { ok: false, error: "total-too-large" };
      fields.push({
        key,
        id: f.id || null,
        name: f.name || null,
        kind,
        label: clip(f.label || key.slice(1), MAX_LABEL_LEN),
        value,
      });
    }

    return {
      ok: true,
      envelope: {
        v: 1,
        origin: e.origin,
        route: e.route,
        formId: e.formId,
        formFingerprint: e.formFingerprint,
        formIdentity: formIdentity(e.formId, e.formFingerprint),
        fields,
      },
    };
  }

  function isExpired(ts, now, ttl) {
    return ts + ttl <= now;
  }

  function randomToken() {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  return {
    MAX_FIELDS,
    MAX_VALUE_BYTES,
    MAX_TOTAL_BYTES,
    ALLOWED_INPUT_TYPES,
    DB_NAME,
    DB_VERSION,
    TOKEN_TTL_MS,
    REVISION_TTL_MS,
    ALARM_NAME,
    ALARM_PERIOD_MIN,
    ROUTE_EVENT,
    REASON_TEXT,
    isInjectableUrl,
    originOf,
    fullRoute,
    isOtp,
    isPayment,
    kindOf,
    analyze,
    fingerprint,
    formIdentity,
    validateRestore,
    buildEnvelope,
    isExpired,
    randomToken,
    fnv1a64Hex,
  };
});
