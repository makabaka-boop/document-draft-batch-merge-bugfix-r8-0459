/*
 * batch.js — 多修订合并恢复的纯策略（无 DOM、无 chrome.* 依赖，可在 Node 单测中运行）。
 *
 * 合并规则：
 *  - 同一字段在各修订中值相同 → 自动合并；
 *  - 值不同（冲突）→ 必须由用户显式指定“采用哪个已选修订”，绝不以时间新旧自动覆盖；
 *  - 提交前对预览时刻的当前值、字段种类、字段身份、原控件、表单身份、路由、授权令牌
 *    逐项复核；任一失效即整组拒绝、一项都不写；未参与合并的字段保持原值。
 *
 * 快照由内容脚本从实时 DOM 构造：
 *   { token, route, formId, formIdentity, fingerprint,
 *     fields: [{ key, id, name, kind, value, control }] }
 * 其中 control 是不透明的控件引用（DOM 节点），本模块只用 === 比较身份，不访问其属性。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FSPBatch = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MAX_BATCH_REVISIONS = 8; // 一次合并最多选择的修订份数
  const MAX_MERGE_FIELDS = 20; // 合并后最多写入字段数

  const ERRORS = {
    "few-revisions": "请选择 2～8 份修订后再合并",
    "many-revisions": "一次最多合并 8 份修订",
    "too-many-fields": "合并字段最多 20 个",
    "revision-form-mismatch": "存在不属于当前表单身份的修订",
    "field-missing": "修订中的字段在当前表单已消失",
    "field-kind-changed": "字段类型已变化",
    "field-identity-changed": "字段 id/name 已变化",
    "missing-choice": "存在冲突字段尚未明确选择来源",
    "bad-choice": "指定的来源不在所选修订中",
    "bad-analysis": "预览分析已失效，请重新打开预览",
    "token-changed": "授权令牌已变化（重新授权后旧预览失效）",
    "route-changed": "路由已变化",
    "form-changed": "表单身份或字段集合已变化",
    "control-changed": "原控件已被替换或已移出文档",
    "field-changed": "字段当前值在预览后发生了变化",
    "write-failed": "写入控件时失败",
  };

  function fail(error, details) {
    return { ok: false, error, details: details || [] };
  }

  /* ---------------- 预览分析：校验 + 冲突分组（不产生写入计划） ---------------- */

  // revisions: GET_REVISION 返回的完整修订（按 createdAt 任意顺序均可）
  // snapshot: 实时 DOM 快照
  function analyzeMerge(revisions, snapshot) {
    if (!snapshot || typeof snapshot !== "object")
      return fail("form-changed");
    if (!Array.isArray(revisions) || revisions.length < 2)
      return fail("few-revisions");
    if (revisions.length > MAX_BATCH_REVISIONS)
      return fail("many-revisions");

    const byKey = new Map(snapshot.fields.map((f) => [f.key, f]));

    // 每份修订都必须与“当前表单”同一身份（formId + 全字段指纹）
    for (const r of revisions) {
      if (
        !r ||
        r.formId !== snapshot.formId ||
        r.formIdentity !== snapshot.formIdentity
      ) {
        return fail("revision-form-mismatch", [{ id: r && r.id }]);
      }
    }

    // 逐字段比对当前 DOM：字段消失 / 种类变化 / id、name 变化 → 整组拒绝，不猜相近输入框
    for (const r of revisions) {
      for (const f of r.fields) {
        const cur = byKey.get(f.key);
        if (!cur) return fail("field-missing", [{ key: f.key }]);
        if (cur.kind !== f.kind)
          return fail("field-kind-changed", [{ key: f.key }]);
        if ((cur.id || null) !== (f.id || null) ||
            (cur.name || null) !== (f.name || null)) {
          return fail("field-identity-changed", [{ key: f.key }]);
        }
      }
    }

    // 并集字段（按最旧修订中的出现顺序），上限 20
    const ordered = revisions
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt); // 旧 → 新，保证确定性
    const keys = [];
    const seen = new Set();
    for (const r of ordered) {
      for (const f of r.fields) {
        if (!seen.has(f.key)) {
          seen.add(f.key);
          keys.push(f.key);
        }
      }
    }
    if (keys.length > MAX_MERGE_FIELDS) return fail("too-many-fields");

    const groups = keys.map((key) => {
      const cur = byKey.get(key);
      const sources = []; // 旧 → 新
      let sample = null;
      for (const r of ordered) {
        const f = r.fields.find((x) => x.key === key);
        if (f) {
          if (!sample) sample = f;
          sources.push({ id: r.id, value: f.value, createdAt: r.createdAt });
        }
      }
      // 去重保留首次出现顺序
      const distinct = [];
      for (const s of sources) {
        let bucket = distinct.find((d) => d.value === s.value);
        if (!bucket) {
          bucket = { value: s.value, ids: [] };
          distinct.push(bucket);
        }
        bucket.ids.push(s.id);
      }
      return {
        key,
        label: sample.label,
        id: sample.id,
        name: sample.name,
        kind: sample.kind,
        currentValue: cur.value,
        control: cur.control, // 原控件引用，commit 时必须仍是同一个对象
        sources,
        distinct,
        conflict: distinct.length > 1,
        newestId: sources[sources.length - 1].id,
      };
    });

    return {
      ok: true,
      context: snapshot,
      groups,
      fieldCount: keys.length,
      revisionIds: revisions.map((r) => r.id),
    };
  }

  function allChoicesResolved(analysis, choices) {
    choices = choices || {};
    return analysis.groups
      .filter((g) => g.conflict)
      .every((g) => Object.prototype.hasOwnProperty.call(choices, g.key));
  }

  /* ---------------- 解决冲突 → 写入计划（纯数据；仍不触碰 DOM） ---------------- */

  // choices: { [fieldKey]: revisionId } —— 仅用于冲突字段；用户必须显式指定。
  // 非冲突字段不接受 choices（同值合并不需要选择），其来源记为含该值的最新修订。
  function buildMergePlan(analysis, choices) {
    if (!analysis || analysis.ok !== true) return fail("bad-analysis");
    choices = choices || {};
    const idSet = new Set(analysis.revisionIds);

    const fields = [];
    for (const g of analysis.groups) {
      let sourceId;
      let value;
      if (g.conflict) {
        sourceId = choices[g.key];
        if (!sourceId) return fail("missing-choice", [{ key: g.key }]);
        if (!idSet.has(sourceId)) return fail("bad-choice", [{ key: g.key }]);
        const src = g.sources.find((s) => s.id === sourceId);
        if (!src) return fail("bad-choice", [{ key: g.key }]);
        value = src.value;
      } else {
        // 各修订同值：合并该唯一值；绝不读取冲突选择，也不以时间新旧改变值
        value = g.distinct[0].value;
        sourceId = g.newestId;
      }
      fields.push({
        key: g.key,
        id: g.id,
        name: g.name,
        kind: g.kind,
        label: g.label,
        value,
        sourceId,
        before: g.currentValue, // 预览时刻当前值；commit 时必须仍相等
        control: g.control, // 预览时刻原控件；commit 时必须是同一对象
      });
    }

    const planValueOf = new Map(fields.map((f) => [f.key, f.value]));

    // “实际成功恢复的修订”：该修订保存的每一个字段，其值都与最终合并值一致。
    // 冲突中落败、或字段未被完整覆盖的修订不返回 → 后续清理不会误删它们。
    const appliedRevisionIds = analysis.revisionIds.filter((id) =>
      analysis.groups.every((g) => {
        const src = g.sources.find((s) => s.id === id);
        if (!src) return true; // 该修订不含此字段，不参与判定
        return src.value === planValueOf.get(g.key);
      }),
    );

    return {
      ok: true,
      plan: {
        context: analysis.context,
        fields,
        revisionIds: analysis.revisionIds.slice(),
        appliedRevisionIds,
      },
    };
  }

  /* ---------------- 提交：全部条件先复核通过，再整组写入 ---------------- */

  // snapshot 必须是确认瞬间从实时 DOM 重建的新快照（不能复用预览时的快照）。
  // write(currentField, value) 由调用方提供；本函数保证：要么一次不调用，
  // 要么按计划对每个字段恰好调用一次。返回 { ok, appliedRevisionIds } / { ok:false, error }。
  function commitPlan(plan, snapshot, write) {
    if (!plan || !plan.context || typeof write !== "function")
      return fail("bad-analysis");
    if (!snapshot || typeof snapshot !== "object")
      return fail("form-changed");

    // —— 文档级条件 ——
    if (snapshot.token !== plan.context.token) return fail("token-changed");
    if (snapshot.route !== plan.context.route) return fail("route-changed");
    if (
      snapshot.formId !== plan.context.formId ||
      snapshot.fingerprint !== plan.context.fingerprint ||
      snapshot.formIdentity !== plan.context.formIdentity
    ) {
      return fail("form-changed");
    }

    const byKey = new Map(snapshot.fields.map((f) => [f.key, f]));

    // 第一轮：逐项复核，全部通过后才允许任何写入（杜绝半写）
    const targets = [];
    for (const f of plan.fields) {
      const cur = byKey.get(f.key);
      if (!cur) return fail("field-missing", [{ key: f.key }]);
      if (cur.kind !== f.kind)
        return fail("field-kind-changed", [{ key: f.key }]);
      if ((cur.id || null) !== (f.id || null) ||
          (cur.name || null) !== (f.name || null)) {
        return fail("field-identity-changed", [{ key: f.key }]);
      }
      // 必须仍是预览时的那个控件对象，且仍在文档中（防止表单被整体替换后继续写入）
      if (cur.control !== f.control)
        return fail("control-changed", [{ key: f.key }]);
      const c = f.control;
      if (c && typeof c.isConnected === "boolean" && !c.isConnected)
        return fail("control-changed", [{ key: f.key }]);
      // 靠后的字段变化也会使整组失效
      if (cur.value !== f.before)
        return fail("field-changed", [{ key: f.key }]);
      targets.push({ cur, f });
    }

    // 第二轮：统一写入。只写计划内字段，未选字段绝不触碰。
    for (const { cur, f } of targets) {
      try {
        write(cur, f.value);
      } catch (e) {
        return {
          ok: false,
          error: "write-failed",
          message: String((e && e.message) || e),
        };
      }
    }
    return { ok: true, appliedRevisionIds: plan.appliedRevisionIds.slice() };
  }

  return {
    MAX_BATCH_REVISIONS,
    MAX_MERGE_FIELDS,
    ERRORS,
    analyzeMerge,
    allChoicesResolved,
    buildMergePlan,
    commitPlan,
  };
});
