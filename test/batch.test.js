"use strict";
// 多修订合并：显式冲突选择、同值合并、预览后整组原子拒绝、仅实际整份恢复的修订进入清理。
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../extension/inject/policy.js");
const B = require("../extension/inject/batch.js");

const TOKEN = "t".repeat(64);
const ROUTE = "https://shop.example/checkout?step=1#x";

function control(form, key, value) {
  return {
    tagName: key === "#bio" ? "TEXTAREA" : "INPUT",
    type: key === "#email" ? "email" : key === "#age" ? "number" : "text",
    value,
    disabled: false,
    readOnly: false,
    isConnected: true,
    form,
  };
}

function fieldDef(key, kind, id, name) {
  return { key, kind, id: id == null ? null : id, name: name == null ? null : name };
}

function snapshot(values, overrides) {
  const form = Object.assign({ isConnected: true }, (overrides && overrides.form) || {});
  const defs = [
    fieldDef("#name", "input:text", "name"),
    fieldDef("#email", "input:email", "email"),
    fieldDef("#age", "input:number", "age"),
    fieldDef("#bio", "textarea", "bio"),
  ];
  const fp = P.fnv1a64Hex(
    defs
      .map((d) => [d.key, d.kind, d.id || "", d.name || ""].join("|"))
      .join("~"),
  );
  return Object.assign(
    {
      token: TOKEN,
      route: ROUTE,
      formId: "profile",
      formIdentity: "profile#" + fp,
      fingerprint: fp,
      form,
      fields: defs.map((d) =>
        Object.assign({}, d, {
          label: d.key.slice(1),
          value: String(values[d.key] == null ? "" : values[d.key]),
          control: control(form, d.key, String(values[d.key] == null ? "" : values[d.key])),
        }),
      ),
    },
    overrides || {},
  );
}

function revision(id, fields, createdAt) {
  const snap = snapshot({});
  return {
    id,
    createdAt,
    formId: "profile",
    formFingerprint: snap.fingerprint,
    formIdentity: snap.formIdentity,
    fields: fields.map((f) =>
      Object.assign(
        {
          id: f.key.slice(1),
          name: null,
          kind: snap.fields.find((x) => x.key === f.key).kind,
          label: f.key.slice(1),
        },
        f,
      ),
    ),
  };
}

test("相同值自动合并；冲突必须显式选择修订来源", () => {
  const snap = snapshot({ "#name": "current", "#email": "old" });
  const revisions = [
    revision(
      "rev-old",
      [
        { key: "#name", value: "Alice" },
        { key: "#email", value: "a@example.com" },
      ],
      100,
    ),
    revision(
      "rev-new",
      [
        { key: "#name", value: "Alice" },
        { key: "#email", value: "b@example.com" },
      ],
      200,
    ),
  ];

  assert.throws(
    () =>
      B.buildPlan(
        revisions,
        { keys: ["#name", "#email"], choices: {} },
        snapshot({ "#name": "current", "#email": "old" }),
      ),
    (err) => err.code === "conflict-choice-required",
  );

  const plan = B.buildPlan(
    revisions,
    { keys: ["#name", "#email"], choices: { "#email": "rev-old" } },
    snap,
  );
  assert.deepEqual(
    plan.fields.map((f) => [f.key, f.value, f.sourceId]),
    [
      ["#name", "Alice", "rev-old"],
      ["#email", "a@example.com", "rev-old"],
    ],
  );
  // 同值字段不会仅因较新草稿而覆盖用户明确选择旧来源的相邻字段；来源保留在 sourceIds。
  assert.deepEqual(plan.fields[0].sourceIds, ["rev-old", "rev-new"]);
});

test("未选字段不写入；最多 20 个合并字段；修订数量限 2～8", () => {
  const snap = snapshot({ "#name": "n", "#email": "e" });
  const revisions = [
    revision("r1", [{ key: "#name", value: "A" }], 1),
    revision("r2", [{ key: "#email", value: "x@e.test" }], 2),
  ];
  const plan = B.buildPlan(revisions, { keys: ["#name"] }, snap);
  const writes = [];
  const result = B.commitWithLiveSnapshot(plan, snap, snap, ({ control }, value) =>
    writes.push([control, value]),
  );
  assert.deepEqual(
    writes.map(([, value]) => value),
    ["A"],
  );
  assert.equal(snap.fields[1].control.value, "e");
  assert.equal(result.fieldCount, 1);

  assert.throws(
    () => B.buildPlan([revisions[0]], { keys: ["#name"] }, snap),
    (err) => err.code === "bad-revision-count",
  );
  assert.throws(
    () =>
      B.buildPlan(
        revisions,
        { keys: ["#name"], choices: {} },
        snap,
        { minRevisions: 2, maxRevisions: 1, maxFields: 20 },
      ),
    (err) => err.code === "bad-revision-count",
  );
});

test("commit 在任一当前值、类型、控件或表单变化时整组拒绝且不写", () => {
  const previewSnap = snapshot({ "#name": "n", "#email": "e" });
  const revisions = [
    revision("r1", [{ key: "#name", value: "A" }], 1),
    revision("r2", [{ key: "#email", value: "a@e.test" }], 2),
  ];
  const selection = { keys: ["#name", "#email"] };
  const basePlan = B.buildPlan(revisions, selection, previewSnap);

  function liveClone(values) {
    values = values || {};
    const live = Object.assign({}, previewSnap, {
      fields: previewSnap.fields.map((f) => ({ ...f, control: f.control })),
    });
    for (const field of live.fields) {
      const value = values[field.key];
      if (value !== undefined) {
        field.value = value;
        field.control.value = value;
      }
    }
    return live;
  }

  // 靠后的 email 被用户改动：整组拒绝，前面的 name 也不能先写。
  const changed = liveClone({ "#email": "edited" });
  assert.throws(
    () => B.commitWithLiveSnapshot(basePlan, previewSnap, changed, () => assert.fail()),
    (err) => err.code === "field-changed",
  );
  assert.equal(previewSnap.fields[0].control.value, "n");

  // 控件被替换（即使 id/value 相同）也拒绝。
  const replaced = snapshot({ "#name": "n", "#email": "e" });
  replaced.form = previewSnap.form;
  replaced.fields[0].control = previewSnap.fields[0].control;
  assert.throws(
    () => B.commitWithLiveSnapshot(basePlan, previewSnap, replaced, () => assert.fail()),
    (err) => err.code === "control-changed",
  );

  // 表单对象被替换：不向另一个同 id/同结构表单写入。
  const otherForm = snapshot({ "#name": "n", "#email": "e" });
  assert.throws(
    () => B.commitWithLiveSnapshot(basePlan, previewSnap, otherForm, () => assert.fail()),
    (err) => err.code === "context-changed",
  );

  // 类型变化，整组拒绝。
  const kindChanged = liveClone();
  kindChanged.fields[0].kind = "input:password";
  kindChanged.fields[0].control.type = "password";
  assert.throws(
    () => B.commitWithLiveSnapshot(basePlan, previewSnap, kindChanged, () => assert.fail()),
    (err) => err.code === "identity-changed",
  );
});

test("路由或授权令牌在确认后变化时整组拒绝", () => {
  const previewSnap = snapshot({ "#name": "n" });
  const revisions = [
    revision("r1", [{ key: "#name", value: "A" }], 1),
    revision("r2", [{ key: "#name", value: "A" }], 2),
  ];
  const plan = B.buildPlan(revisions, { keys: ["#name"] }, previewSnap);

  const routed = snapshot({ "#name": "n" }, { route: ROUTE + "#changed" });
  routed.form = previewSnap.form;
  routed.fields = previewSnap.fields.map((f) => ({ ...f, control: f.control }));
  assert.throws(
    () => B.commitWithLiveSnapshot(plan, previewSnap, routed, () => assert.fail()),
    (err) => err.code === "context-changed",
  );

  const authed = snapshot({ "#name": "n" }, { token: "x".repeat(64) });
  authed.form = previewSnap.form;
  authed.fields = previewSnap.fields.map((f) => ({ ...f, control: f.control }));
  assert.throws(
    () => B.commitWithLiveSnapshot(plan, previewSnap, authed, () => assert.fail()),
    (err) => err.code === "context-changed",
  );
});

test("只有实际提供已恢复字段的修订才返回供后续清理", () => {
  const snap = snapshot({ "#name": "n", "#email": "e", "#age": "1" });
  const revisions = [
    revision(
      "r1",
      [
        { key: "#name", value: "A" },
        { key: "#email", value: "a@e.test" },
      ],
      1,
    ),
    revision(
      "r2",
      [
        { key: "#email", value: "b@e.test" },
        { key: "#age", value: "2" },
      ],
      2,
    ),
    revision(
      "r3",
      [{ key: "#age", value: "3" }],
      3,
    ),
  ];
  // name 实际取自 r1，冲突 email 明确取自 r2；未选 age，所以 r3 不进入清理。
  const plan = B.buildPlan(
    revisions,
    { keys: ["#name", "#email"], choices: { "#email": "r2" } },
    snap,
  );
  const result = B.commitWithLiveSnapshot(plan, snap, snap, () => {});
  assert.deepEqual(result.revisionIds, ["r1", "r2", "r3"]);
  assert.deepEqual(result.appliedRevisionIds, ["r1", "r2"]);

  // 同值来源即便还含未恢复字段，也已实际提供一个恢复值，因此进入清理；
  // 是否删除仍由用户提交后手动点击。
  const snap2 = snapshot({ "#name": "n", "#email": "e", "#age": "1" });
  const revisions2 = [
    revision("full1", [{ key: "#name", value: "A" }], 1),
    revision("full2", [{ key: "#email", value: "a@e.test" }], 2),
    revision("partial", [
      { key: "#email", value: "a@e.test" },
      { key: "#age", value: "9" },
    ], 3),
  ];
  const plan2 = B.buildPlan(
    revisions2,
    { keys: ["#name", "#email"] },
    snap2,
  );
  const result2 = B.commitWithLiveSnapshot(plan2, snap2, snap2, () => {});
  assert.deepEqual(result2.appliedRevisionIds, ["full1", "full2", "partial"]);
});

test("单修订模式仍走相同的预览快照与原子写入校验", () => {
  const previewSnap = snapshot({ "#bio": "before" });
  const rev = revision("single", [{ key: "#bio", value: "after" }], 1);
  const plan = B.buildPlan(
    [rev],
    { keys: ["#bio"] },
    previewSnap,
    { minRevisions: 1, maxRevisions: 1, maxFields: 20 },
  );
  const writes = [];
  const result = B.commitWithLiveSnapshot(
    plan,
    previewSnap,
    previewSnap,
    ({ control }, value) => writes.push([control.tagName, value]),
  );
  assert.deepEqual(writes, [["TEXTAREA", "after"]]);
  assert.deepEqual(result.appliedRevisionIds, ["single"]);
});
