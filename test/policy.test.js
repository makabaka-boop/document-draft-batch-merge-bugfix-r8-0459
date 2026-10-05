"use strict";
// 纯策略逻辑测试：字段准入、排除规则、指纹、恢复拒绝、信封校验、路由隔离。
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../extension/inject/policy.js");

function d(patch) {
  return Object.assign(
    {
      tag: "INPUT",
      type: "text",
      id: undefined,
      name: undefined,
      autocomplete: "",
      placeholder: "",
      ariaLabel: "",
      labelText: "",
      disabled: false,
      readOnly: false,
    },
    patch,
  );
}

test("普通文本字段准入：text/search/url/tel/email/number 与 textarea", () => {
  const descs = [
    d({ id: "a", type: "text" }),
    d({ id: "b", type: "search" }),
    d({ id: "c", type: "url" }),
    d({ id: "e", type: "tel" }),
    d({ id: "f", type: "email" }),
    d({ id: "g", type: "number" }),
    { tag: "TEXTAREA", id: "h" },
  ];
  const a = P.analyze(descs);
  assert.equal(a.eligible.length, 7);
});

test("password/file/hidden/checkbox/radio/color/date 等一律排除", () => {
  const types = [
    "password",
    "file",
    "hidden",
    "checkbox",
    "radio",
    "color",
    "date",
    "range",
    "submit",
    "button",
  ];
  const a = P.analyze(types.map((type, i) => d({ id: "x" + i, type })));
  assert.equal(a.eligible.length, 0);
  assert.deepEqual(
    a.excluded.map((x) => x.reason),
    types.map(() => "type"),
  );
});

test("一次性验证码字段排除（autocomplete 与名称/中文占位符）", () => {
  const a = P.analyze([
    d({ id: "c1", autocomplete: "one-time-code" }),
    d({ id: "c2", name: "sms_code" }),
    d({ id: "c3", placeholder: "短信验证码" }),
    d({ id: "c4", ariaLabel: "Enter OTP" }),
    d({ id: "c5", name: "mfaToken" }),
  ]);
  assert.equal(a.eligible.length, 0);
  assert.ok(a.excluded.every((x) => x.reason === "otp"));
});

test("支付自动填充字段排除（cc-*/transaction-* 与卡号/CVV/有效期）", () => {
  const a = P.analyze([
    d({ id: "p1", autocomplete: "cc-number" }),
    d({ id: "p2", autocomplete: "cc-csc" }),
    d({ id: "p3", autocomplete: "cc-exp" }),
    d({ id: "p4", autocomplete: "cc-name" }),
    d({ id: "p5", autocomplete: "transaction-currency" }),
    d({ id: "p6", name: "credit_card" }),
    d({ id: "p7", ariaLabel: "card expiration date" }),
    d({ id: "p8", placeholder: "安全码 CVV" }),
  ]);
  assert.equal(a.eligible.length, 0);
  assert.ok(a.excluded.every((x) => x.reason === "payment"));
});

test("username 与 name 保留（不是敏感 token）", () => {
  const a = P.analyze([
    d({ id: "u1", autocomplete: "username" }),
    d({ id: "n1", autocomplete: "name" }),
  ]);
  assert.equal(a.eligible.length, 2);
});

test("无 id 无 name 排除；有唯一 id 或唯一 name 可保留", () => {
  const a = P.analyze([
    d({}), // 无身份
    d({ id: "one" }), // id 唯一
    d({ name: "nm" }), // name 唯一
    d({ id: "dup" }),
    d({ id: "dup" }), // id 重复
    d({ name: "g" }),
    d({ name: "g" }), // name 重复（且无 id）
  ]);
  assert.deepEqual(
    a.eligible.map((x) => x.key),
    ["#one", "@nm"],
  );
  const reasons = new Map(a.excluded.map((x) => [x.index, x.reason]));
  assert.equal(reasons.get(0), "identity");
  assert.ok(
    reasons.get(3) === "duplicate-id" && reasons.get(4) === "duplicate-id",
  );
  assert.ok(
    reasons.get(5) === "duplicate-name" && reasons.get(6) === "duplicate-name",
  );
});

test("disabled / readonly / select/button 排除", () => {
  const a = P.analyze([
    d({ id: "z1", disabled: true }),
    d({ id: "z2", readOnly: true }),
    { tag: "SELECT", id: "z3" },
    { tag: "BUTTON", id: "z4" },
  ]);
  assert.equal(a.eligible.length, 0);
  assert.deepEqual(
    a.excluded.map((x) => x.reason).sort(),
    ["disabled", "readonly", "tag", "tag"].sort(),
  );
});

test("指纹随字段增删与类型变化而变，且稳定", () => {
  const a1 = P.analyze([d({ id: "a" }), d({ id: "b" })]);
  const a2 = P.analyze([d({ id: "a" }), d({ id: "b" })]);
  const a3 = P.analyze([d({ id: "a" }), d({ id: "b" }), d({ id: "c" })]);
  const a4 = P.analyze([d({ id: "a" }), d({ id: "b", type: "email" })]);
  const f1 = P.fingerprint(a1.eligible);
  assert.equal(f1, P.fingerprint(a2.eligible));
  assert.notEqual(f1, P.fingerprint(a3.eligible));
  assert.notEqual(f1, P.fingerprint(a4.eligible));
  assert.match(f1, /^[0-9a-f]{16}$/);
});

test("恢复校验：身份/类型/集合变化即拒绝，不猜测", () => {
  const saved = {
    formFingerprint: P.fingerprint(
      P.analyze([d({ id: "a" }), d({ id: "b" })]).eligible,
    ),
    fields: [
      { key: "#a", id: "a", name: undefined, kind: "input:text" },
      { key: "#b", id: "b", name: undefined, kind: "input:text" },
    ],
  };
  // 完全一致
  const cur1 = P.analyze([d({ id: "a" }), d({ id: "b" })]);
  assert.equal(P.validateRestore(saved, cur1).ok, true);

  // #b 变成 email 类型
  const cur2 = P.analyze([d({ id: "a" }), d({ id: "b", type: "email" })]);
  const v2 = P.validateRestore(saved, cur2);
  assert.equal(v2.ok, false);
  assert.ok(
    v2.mismatches.some((m) => m.key === "#b" && m.reason === "kind-changed"),
  );

  // #b 消失（新增了 #c 也不能顶替）
  const cur3 = P.analyze([d({ id: "a" }), d({ id: "c" })]);
  const v3 = P.validateRestore(saved, cur3);
  assert.equal(v3.ok, false);
  assert.ok(
    v3.mismatches.some((m) => m.key === "#b" && m.reason === "missing"),
  );
  assert.ok(v3.mismatches.some((m) => m.reason === "form-fingerprint-changed"));

  // id/name 身份变化（同样 key 由 id 变 name）
  const cur4 = P.analyze([d({ id: "a" }), d({ name: "b" })]);
  const v4 = P.validateRestore(saved, cur4);
  assert.equal(v4.ok, false);
});

test("完整路由区分 search 与 hash；仅 http(s) 可注入", () => {
  const base = "https://shop.example/checkout?step=2#card";
  assert.equal(P.fullRoute(base), "https://shop.example/checkout?step=2#card");
  assert.notEqual(
    P.fullRoute("https://x/a?step=2"),
    P.fullRoute("https://x/a?step=3"),
  );
  assert.notEqual(P.fullRoute("https://x/a#v1"), P.fullRoute("https://x/a#v2"));
  for (const u of [
    "chrome://extensions",
    "chrome-extension://abc/popup.html",
    "file:///tmp/x.html",
    "about:blank",
    "https://x/a",
  ]) {
    assert.equal(P.isInjectableUrl(u), u.startsWith("https://"));
  }
});

test("buildEnvelope 强制约束：上限 20、值长度、坏 key、坏 origin、空字段", () => {
  const good = {
    origin: "https://x.test",
    route: "https://x.test/f",
    formId: "f1",
    formFingerprint: "0123456789abcdef",
    fields: [
      { key: "#a", id: "a", kind: "input:text", label: "A", value: "v" },
    ],
  };
  assert.equal(P.buildEnvelope(good).ok, true);

  const tooMany = Object.assign({}, good, {
    fields: Array.from({ length: 21 }, (_, i) => ({
      key: "#f" + i,
      id: "f" + i,
      kind: "input:text",
      value: "",
    })),
  });
  assert.equal(P.buildEnvelope(tooMany).error, "too-many-fields");

  const badKey = Object.assign({}, good, {
    fields: [{ key: "nohash", kind: "input:text", value: "" }],
  });
  assert.equal(P.buildEnvelope(badKey).error, "bad-field-key");

  const dupKey = Object.assign({}, good, {
    fields: [good.fields[0], good.fields[0]],
  });
  assert.equal(P.buildEnvelope(dupKey).error, "bad-field-key");

  const badKind = Object.assign({}, good, {
    fields: [{ key: "#p", id: "p", kind: "input:password", value: "x" }],
  });
  assert.equal(P.buildEnvelope(badKind).error, "bad-field-kind");

  const crossOrigin = Object.assign({}, good, { route: "https://evil.test/f" });
  assert.equal(P.buildEnvelope(crossOrigin).error, "bad-route");

  const empty = Object.assign({}, good, { fields: [] });
  assert.equal(P.buildEnvelope(empty).error, "empty");

  const big = "x".repeat(P.MAX_VALUE_BYTES + 1);
  const tooBig = Object.assign({}, good, {
    fields: [{ key: "#a", id: "a", kind: "input:text", value: big }],
  });
  assert.equal(P.buildEnvelope(tooBig).error, "value-too-large");
});

test("formIdentity 含 formId 与指纹，换表单不串身份", () => {
  const fp = P.fingerprint(P.analyze([d({ id: "a" })]).eligible);
  assert.equal(P.formIdentity("f1", fp), "f1#" + fp);
  assert.notEqual(P.formIdentity("f1", fp), P.formIdentity("f2", fp));
});
