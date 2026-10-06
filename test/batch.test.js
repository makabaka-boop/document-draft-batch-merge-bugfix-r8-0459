"use strict";
// 多修订合并恢复纯策略测试：
// 同值自动合并、冲突必须显式选源（绝不自动以较新修订覆盖）、
// 提交前全量复核（当前值/种类/控件/表单身份/路由/授权）、任一失效整组拒绝、
// 只返回实际完整恢复的修订。
const test = require("node:test");
const assert = require("node:assert/strict");

const B = require("../extension/inject/batch.js");
const P = require("../extension/inject/policy.js");

// —— 构造夹具 ——

function controlFor(key, value, connected) {
  // 不透明控件对象：策略层只做 === 比较与 isConnected 读取
  return { key, tagName: "INPUT", value, isConnected: connected !== false };
}

let controlMap;
function snapshot(over) {
  const fields = [
    { key: "#a", id: "a", name: null, kind: "input:text", control: controlMap.get("#a") },
    { key: "#b", id: "b", name: null, kind: "input:text", control: controlMap.get("#b") },
    { key: "#c", id: "c", name: null, kind: "input:email", control: controlMap.get("#c") },
  ].map((f) =>
    Object.assign(f, { value: f.control ? f.control.value : "" }),
  );
  const fp = P.fingerprint(
    fields.map((f) => ({
      key: f.key,
      kind: f.kind,
      descriptor: { id: f.id, name: f.name },
    })),
  );
  return Object.assign(
    {
      token: "tok",
      route: "https://s.test/form",
      formId: "f1",
      formIdentity: P.formIdentity("f1", fp),
      fingerprint: fp,
      fields,
    },
    over,
  );
}

function revision(id, fields, createdAt) {
  const fp = P.fingerprint(
    [
      { key: "#a", kind: "input:text", descriptor: { id: "a", name: null } },
      { key: "#b", kind: "input:text", descriptor: { id: "b", name: null } },
      { key: "#c", kind: "input:email", descriptor: { id: "c", name: null } },
    ],
  );
  return {
    id,
    formId: "f1",
    formIdentity: P.formIdentity("f1", fp),
    createdAt,
    fields: fields.map((f) =>
      Object.assign(
        { id: null, name: null, label: f.key.slice(1) },
        f,
      ),
    ),
  };
}

const fA = (value) => ({ key: "#a", id: "a", name: null, kind: "input:text", value });
const fB = (value) => ({ key: "#b", id: "b", name: null, kind: "input:text", value });
const fC = (value) => ({ key: "#c", id: "c", name: null, kind: "input:email", value });

function setup(controls) {
  controlMap = new Map(
    Object.entries(
      controls || {
        "#a": controlFor("#a", ""),
        "#b": controlFor("#b", ""),
        "#c": controlFor("#c", ""),
      },
    ),
  );
}

test.beforeEach(() => setup());

function analyze(revs, snap) {
  const r = B.analyzeMerge(revs, snap || snapshot());
  assert.equal(r.ok, true, "分析应通过: " + (r.error || ""));
  return r;
}

// —— 合并语义 ——

test("相同值自动合并；不冲突的字段无需选择", () => {
  const revs = [
    revision("r1", [fA("x"), fB("1")], 100),
    revision("r2", [fA("x"), fC("m@x")], 200),
  ];
  const a = analyze(revs);
  assert.equal(a.fieldCount, 3);
  assert.deepEqual(a.groups.map((g) => g.conflict), [false, false, false]);
  const plan = B.buildMergePlan(a, {});
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.plan.fields.map((f) => [f.key, f.value]),
    [
      ["#a", "x"],
      ["#b", "1"],
      ["#c", "m@x"],
    ],
  );
});

test("同名字段值不同即为冲突：未显式选择来源时不能生成计划（不自动以较新修订覆盖）", () => {
  const revs = [
    revision("r1", [fA("old"), fB("1")], 100),
    revision("r2", [fA("new"), fB("1")], 200), // 较新
  ];
  const a = analyze(revs);
  const gA = a.groups.find((g) => g.key === "#a");
  assert.equal(gA.conflict, true);
  assert.deepEqual(
    gA.distinct.map((d) => d.value),
    ["old", "new"],
  );
  // 即使不给选择，也不能默认取较新值
  const refused = B.buildMergePlan(a, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "missing-choice");
});

test("冲突字段必须采用用户明确指定的已选修订来源（选旧不取新）", () => {
  const revs = [
    revision("r1", [fA("old")], 100),
    revision("r2", [fA("new")], 200),
  ];
  const a = analyze(revs);
  const plan = B.buildMergePlan(a, { "#a": "r1" }); // 明确采用较旧修订
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.fields[0].value, "old");
  assert.equal(plan.plan.fields[0].sourceId, "r1");
});

test("选择来源不在已选修订中 → bad-choice", () => {
  const revs = [
    revision("r1", [fA("old")], 100),
    revision("r2", [fA("new")], 200),
  ];
  const a = analyze(revs);
  assert.equal(B.buildMergePlan(a, { "#a": "rX" }).error, "bad-choice");
});

test("多冲突字段需逐字段选择；三份修订各取所需", () => {
  const revs = [
    revision("r1", [fA("v1"), fB("b1")], 100),
    revision("r2", [fA("v2"), fB("b2")], 200),
    revision("r3", [fA("v3"), fC("c3")], 300),
  ];
  const a = analyze(revs);
  assert.equal(a.groups.filter((g) => g.conflict).length, 2);
  const plan = B.buildMergePlan(a, { "#a": "r3", "#b": "r1" });
  assert.equal(plan.ok, true);
  const m = new Map(plan.plan.fields.map((f) => [f.key, f]));
  assert.equal(m.get("#a").value, "v3");
  assert.equal(m.get("#b").value, "b1");
  assert.equal(m.get("#c").value, "c3"); // 唯一值自动合并
});

// —— 分析期拒绝（整组、且尚未写入） ——

test("修订数量必须 2～8 份", () => {
  assert.equal(B.analyzeMerge([revision("r1", [fA("x")], 1)], snapshot()).error, "few-revisions");
  assert.equal(B.analyzeMerge([], snapshot()).error, "few-revisions");
  const many = Array.from({ length: 9 }, (_, i) =>
    revision("r" + i, [fA("v" + i)], 100 + i),
  );
  assert.equal(B.analyzeMerge(many, snapshot()).error, "many-revisions");
});

test("合并字段并集超过 20 → too-many-fields", () => {
  const fp = P.fingerprint(
    Array.from({ length: 21 }, (_, i) => ({
      key: "#f" + i,
      kind: "input:text",
      descriptor: { id: "f" + i, name: null },
    })),
  );
  const snap = {
    token: "t",
    route: "https://s.test/form",
    formId: "f1",
    formIdentity: P.formIdentity("f1", fp),
    fingerprint: fp,
    fields: Array.from({ length: 21 }, (_, i) => ({
      key: "#f" + i,
      id: "f" + i,
      name: null,
      kind: "input:text",
      value: "",
      control: controlFor("#f" + i, ""),
    })),
  };
  const revOf = (id, keys) => ({
    id,
    formId: "f1",
    formIdentity: snap.formIdentity,
    createdAt: 1,
    fields: keys.map((k) => ({
      key: k,
      id: k.slice(1),
      name: null,
      kind: "input:text",
      label: k.slice(1),
      value: id + ":" + k,
    })),
  });
  const keys = Array.from({ length: 21 }, (_, i) => "#f" + i);
  const res = B.analyzeMerge(
    [revOf("r1", keys.slice(0, 11)), revOf("r2", keys.slice(11))],
    snap,
  );
  assert.equal(res.error, "too-many-fields");
});

test("存在不属于当前表单身份的修订 → revision-form-mismatch（不把值写进别的表单）", () => {
  const good = revision("r1", [fA("x")], 100);
  const other = revision("r2", [fA("y")], 200);
  other.formId = "invoice";
  other.formIdentity = "invoice#deadbeefdeadbeef";
  assert.equal(B.analyzeMerge([good, other], snapshot()).error, "revision-form-mismatch");
});

test("字段消失 / 类型变化 / id·name 身份变化 → 整组拒绝，不猜相近输入框", () => {
  const revs = [
    revision("r1", [fA("x"), fB("y")], 100),
    revision("r2", [fA("z"), fB("y")], 200),
  ];
  setup({
    "#a": controlFor("#a", ""),
    "#b": controlFor("#b", ""),
    "#c": controlFor("#c", ""),
  });
  // #a 消失：快照只保留 #b #c，指纹也随之变化（身份同样不符）
  const snapMissing = snapshot({
    fields: [
      { key: "#b", id: "b", name: null, kind: "input:text", value: "", control: controlMap.get("#b") },
      { key: "#c", id: "c", name: null, kind: "input:email", value: "", control: controlMap.get("#c") },
    ],
  });
  const m1 = B.analyzeMerge(revs, snapMissing);
  assert.equal(m1.ok, false);
  assert.ok(["field-missing", "revision-form-mismatch"].includes(m1.error));

  // #b 类型从 text 变 email
  const snapKind = snapshot({
    fields: [
      { key: "#a", id: "a", name: null, kind: "input:text", value: "", control: controlMap.get("#a") },
      { key: "#b", id: "b", name: null, kind: "input:email", value: "", control: controlMap.get("#b") },
      { key: "#c", id: "c", name: null, kind: "input:email", value: "", control: controlMap.get("#c") },
    ],
  });
  assert.equal(B.analyzeMerge(revs, snapKind).error, "field-kind-changed");

  // #a 的 id 身份变化：key 相同但 id 变为别的值（模拟 name-only 顶替）
  const snapIdent = snapshot({
    fields: [
      { key: "#a", id: "a2", name: null, kind: "input:text", value: "", control: controlMap.get("#a") },
      { key: "#b", id: "b", name: null, kind: "input:text", value: "", control: controlMap.get("#b") },
      { key: "#c", id: "c", name: null, kind: "input:email", value: "", control: controlMap.get("#c") },
    ],
  });
  assert.equal(B.analyzeMerge(revs, snapIdent).error, "field-identity-changed");
});

// —— 提交：先全量复核，再一次性写入 ——

test("全部条件有效：按计划写入，未参与合并的字段不动", () => {
  setup({
    "#a": controlFor("#a", ""),
    "#b": controlFor("#b", "keep"), // 预览后保持不变，但不在计划内
    "#c": controlFor("#c", ""),
  });
  const revs = [
    revision("r1", [fA("old")], 100),
    revision("r2", [fA("new")], 200),
  ];
  const snap = snapshot();
  const a = B.analyzeMerge(revs, snap);
  const { plan } = B.buildMergePlan(a, { "#a": "r2" });
  const writes = [];
  const res = B.commitPlan(
    plan,
    snap,
    (field, value) => writes.push([field.key, value]),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(writes, [["#a", "new"]]);
  // 未选字段 #b/#c 未传给 write；快照中 #b 值保持原样
  assert.equal(snap.fields.find((f) => f.key === "#b").value, "keep");
});

test("预览后任一靠前/靠后字段当前值变化 → 整组拒绝且一个字段都不写", () => {
  const revs = [
    revision("r1", [fA("1"), fB("1")], 100),
    revision("r2", [fA("2"), fB("2")], 200),
  ];
  const snap0 = snapshot();
  const a = B.analyzeMerge(revs, snap0);
  const { plan } = B.buildMergePlan(a, { "#a": "r2", "#b": "r2" });

  // 确认瞬间重建快照：#a 已被用户改动（无论它排在前面还是后面）
  controlMap.get("#a").value = "user-edited";
  const fresh = snapshot();
  const writes = [];
  const res = B.commitPlan(plan, fresh, (f, v) => writes.push([f.key, v]));
  assert.equal(res.ok, false);
  assert.equal(res.error, "field-changed");
  assert.equal(writes.length, 0);
});

test("授权令牌变化 / 路由变化 / 表单身份变化 / 原控件被替换 → 整组拒绝、零写入", () => {
  const revs = [
    revision("r1", [fA("x"), fB("y")], 100),
    revision("r2", [fA("z"), fB("y")], 200),
  ];
  const snap0 = snapshot();
  const a = B.analyzeMerge(revs, snap0);
  const { plan } = B.buildMergePlan(a, { "#a": "r1" });
  const noop = () => {
    throw new Error("不应写入");
  };

  assert.equal(B.commitPlan(plan, snapshot({ token: "tok2" }), noop).error, "token-changed");
  assert.equal(
    B.commitPlan(plan, snapshot({ route: "https://s.test/other" }), noop).error,
    "route-changed",
  );
  assert.equal(
    B.commitPlan(plan, snapshot({ formIdentity: "f1#0000000000000000" }), noop).error,
    "form-changed",
  );
  // 指纹变化（字段集合增删）
  const changedFp = snapshot();
  changedFp.fingerprint = "1111111111111111";
  assert.equal(B.commitPlan(plan, changedFp, noop).error, "form-changed");
  // 表单被替换后 key 相同但控件已是另一个对象
  setup();
  const replaced = snapshot();
  replaced.fields = replaced.fields.map((f) =>
    f.key === "#a" ? Object.assign({}, f, { control: controlFor("#a", "") }) : f,
  );
  assert.equal(B.commitPlan(plan, replaced, noop).error, "control-changed");
  // 控件脱离文档
  const detached = snapshot();
  detached.fields[0].control = {
    tagName: "INPUT",
    value: "",
    isConnected: false,
  };
  assert.equal(B.commitPlan(plan, detached, noop).error, "control-changed");
});

test("零写入保证：write 在第二个字段抛错时，结果为 write-failed 且不标记任何恢复", () => {
  const revs = [revision("r1", [fA("x"), fB("y")], 100)];
  // 需要 2 份修订
  revs.push(revision("r2", [fA("x"), fB("y")], 200));
  const snap0 = snapshot();
  const a = B.analyzeMerge(revs, snap0);
  const { plan } = B.buildMergePlan(a, {});
  let calls = 0;
  const res = B.commitPlan(plan, snap0, () => {
    calls++;
    if (calls === 2) throw new Error("boom");
  });
  assert.equal(res.error, "write-failed");
});

// —— 只清理实际成功恢复的修订 ——

test("appliedRevisionIds：只包含值与最终合并完全一致的修订；冲突落败者不清理", () => {
  const revs = [
    revision("r1", [fA("old"), fB("same")], 100),
    revision("r2", [fA("new"), fB("same")], 200),
  ];
  const a = analyze(revs);

  const pickedOld = B.buildMergePlan(a, { "#a": "r1" }).plan;
  // r1 两个字段都与合并值一致 → 可清理；r2 的 #a 落败 → 不清理
  assert.deepEqual(pickedOld.appliedRevisionIds, ["r1"]);

  const pickedNew = B.buildMergePlan(a, { "#a": "r2" }).plan;
  assert.deepEqual(pickedNew.appliedRevisionIds, ["r2"]);
});

test("同值合并的所有提供方修订都算完整恢复（值一致即可清理）", () => {
  const revs = [
    revision("r1", [fA("x"), fB("y")], 100),
    revision("r2", [fA("x"), fB("y")], 200),
  ];
  const a = analyze(revs);
  const { plan } = B.buildMergePlan(a, {});
  assert.deepEqual(plan.appliedRevisionIds.sort(), ["r1", "r2"]);
});

test("仅保存了部分字段的修订：其保存的字段全部与合并值一致时才算恢复", () => {
  // r1 只保存 #a 且与最终值一致；#a 选 r1，#b 自动合并
  const revs = [
    revision("r1", [fA("old")], 100),
    revision("r2", [fA("new"), fB("b2")], 200),
  ];
  const a = analyze(revs);
  // 选较旧的 #a=old；r2 的 #a 落败、#b 一致 → r2 不算完整恢复
  assert.deepEqual(
    B.buildMergePlan(a, { "#a": "r1" }).plan.appliedRevisionIds,
    ["r1"],
  );
});

test("allChoicesResolved 辅助判定", () => {
  const revs = [
    revision("r1", [fA("x"), fB("1")], 100),
    revision("r2", [fA("y"), fB("2")], 200),
  ];
  const a = analyze(revs);
  assert.equal(B.allChoicesResolved(a, {}), false);
  assert.equal(B.allChoicesResolved(a, { "#a": "r1" }), false);
  assert.equal(
    B.allChoicesResolved(a, { "#a": "r1", "#b": "r2" }),
    true,
  );
});
