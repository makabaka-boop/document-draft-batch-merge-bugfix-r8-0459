/*
 * batch.js — 多修订合并的纯策略逻辑（无 DOM/chrome 依赖）。
 *
 * 关键点：buildPlan 只根据“当时的表单快照”和用户的显式字段/冲突选择生成计划；
 * commit 在写入任何值之前重新比对授权上下文、路由、表单对象、控件对象、类型与预览时
 * 当前值。任一条件不满足都会抛出异常，且不会调用 write。
 */
(function (root) {
  "use strict";

  const MIN_REVISIONS = 2;
  const MAX_REVISIONS = 8;
  const MAX_FIELDS = 20;

  function failure(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
  }

  function normalizeIdentity(value) {
    return value == null || value === "" ? null : String(value);
  }

  function normalizeSelection(revisions, input) {
    const hasKeyList =
      input &&
      (Array.isArray(input.keys) ||
        input.keys instanceof Set ||
        Array.isArray(input.selectedKeys) ||
        input.selectedKeys instanceof Set);
    const raw = hasKeyList
      ? input.keys || input.selectedKeys
      : [];
    const keys = raw instanceof Set ? Array.from(raw) : raw;
    if (!Array.isArray(keys)) failure("bad-selection", "invalid field selection");

    // 兼容早期纯冲突选择表：只传 {fieldKey: revisionId} 时表示选择修订中所有字段。
    const inferredKeys = new Set();
    if (!hasKeyList && input && typeof input === "object") {
      for (const rev of revisions)
        for (const field of rev.fields) inferredKeys.add(field.key);
    }
    const out = new Set(hasKeyList ? keys : inferredKeys);
    if (hasKeyList) {
      const seen = new Set();
      for (const key of keys) {
        if (typeof key !== "string" || key.length === 0)
          failure("bad-field-key", "invalid field key");
        if (seen.has(key)) failure("duplicate-field-key", "duplicate field key");
        seen.add(key);
      }
    }
    const choices = hasKeyList ? input.choices || {} : input || {};
    return { keys: out, choices };
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object")
      failure("bad-snapshot", "missing form snapshot");
    if (typeof snapshot.token !== "string" || snapshot.token.length !== 64)
      failure("bad-token", "invalid authorization token");
    if (typeof snapshot.route !== "string" || !snapshot.route)
      failure("bad-route", "invalid route");
    if (!snapshot.form || typeof snapshot.formId !== "string")
      failure("bad-form", "missing form");
    if (
      typeof snapshot.formIdentity !== "string" ||
      snapshot.formIdentity !==
        (snapshot.formId + "#" + snapshot.fingerprint)
    )
      failure("bad-form-identity", "invalid form identity");
    if (!Array.isArray(snapshot.fields))
      failure("bad-snapshot-fields", "missing snapshot fields");

    const byKey = new Map();
    for (const field of snapshot.fields) {
      if (!field || typeof field.key !== "string" || !field.control)
        failure("bad-control", "field is missing its control");
      if (byKey.has(field.key))
        failure("duplicate-current-field", "duplicate current field");
      if (typeof field.kind !== "string")
        failure("bad-field-kind", "field is missing its kind");
      byKey.set(field.key, {
        key: field.key,
        id: normalizeIdentity(field.id),
        name: normalizeIdentity(field.name),
        kind: field.kind,
        value: field.value == null ? "" : String(field.value),
        control: field.control,
      });
    }
    return byKey;
  }

  function validateRevision(rev, index, currentByKey, snapshot) {
    if (!rev || typeof rev.id !== "string")
      failure("bad-revision", "revision #" + index + " is invalid");
    if (
      rev.formIdentity !== snapshot.formIdentity ||
      rev.formFingerprint !== snapshot.fingerprint ||
      (rev.formId != null && rev.formId !== snapshot.formId)
    ) {
      failure("form-identity-changed", "revision does not belong to this form");
    }
    if (!Array.isArray(rev.fields) || rev.fields.length === 0)
      failure("bad-revision-fields", "revision has no fields");

    const seen = new Set();
    for (const field of rev.fields) {
      if (!field || typeof field.key !== "string")
        failure("bad-field-key", "revision field key is invalid");
      if (seen.has(field.key))
        failure("duplicate-revision-field", "revision contains duplicate field");
      seen.add(field.key);

      const current = currentByKey.get(field.key);
      if (!current) failure("missing", "field " + field.key + " disappeared");
      if (field.kind !== current.kind)
        failure("kind-changed", "field " + field.key + " kind changed");
      if (
        normalizeIdentity(field.id) !== current.id ||
        normalizeIdentity(field.name) !== current.name
      ) {
        failure("identity-changed", "field " + field.key + " identity changed");
      }
    }
  }

  function buildPlan(revisions, selection, snapshot, options) {
    const limits = Object.assign(
      { minRevisions: MIN_REVISIONS, maxRevisions: MAX_REVISIONS, maxFields: MAX_FIELDS },
      options || {},
    );
    const currentByKey = validateSnapshot(snapshot);
    if (!Array.isArray(revisions))
      failure("bad-revisions", "revisions must be an array");
    if (
      revisions.length < limits.minRevisions ||
      revisions.length > limits.maxRevisions
    ) {
      failure("bad-revision-count", "select between 2 and 8 revisions");
    }

    const revisionIds = new Set();
    const ordered = revisions
      .slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
    for (const [i, rev] of ordered.entries()) {
      if (!rev || revisionIds.has(rev.id))
        failure("bad-revision", "duplicate or invalid revision");
      revisionIds.add(rev.id);
      validateRevision(rev, i, currentByKey, snapshot);
    }

    const selectionInfo = normalizeSelection(ordered, selection);
    const keys = selectionInfo.keys;
    if (keys.size === 0) failure("empty-selection", "no fields selected");
    if (keys.size > limits.maxFields) failure("too-many-fields", "at most 20 fields");
    const choices = selectionInfo.choices;

    const sourcesByKey = new Map();
    for (const rev of ordered) {
      for (const field of rev.fields) {
        if (!keys.has(field.key)) continue;
        const list = sourcesByKey.get(field.key) || [];
        list.push({
          key: field.key,
          id: normalizeIdentity(field.id),
          name: normalizeIdentity(field.name),
          kind: field.kind,
          label: field.label,
          value: field.value == null ? "" : String(field.value),
          revisionId: rev.id,
          createdAt: rev.createdAt || 0,
          control: currentByKey.get(field.key).control,
          before: currentByKey.get(field.key).value,
        });
        sourcesByKey.set(field.key, list);
      }
    }

    const fields = [];
    // 使用当前表单的字段顺序，而不是某份草稿的存储顺序。
    for (const current of snapshot.fields) {
      if (!keys.has(current.key)) continue;
      const sources = sourcesByKey.get(current.key);
      if (!sources || sources.length === 0)
        failure("missing-source", "no selected revision contains " + current.key);
      const distinctValues = [...new Set(sources.map((s) => s.value))];
      let chosen;
      if (distinctValues.length === 1) {
        // 值完全相同：安全合并，不需要用户在等价来源之间再选一次。
        chosen = sources[0];
      } else {
        const choice = choices[current.key];
        chosen = sources.find((s) => s.revisionId === choice);
        if (!chosen) {
          failure(
            "conflict-choice-required",
            "field " + current.key + " requires an explicit revision choice",
          );
        }
      }
      fields.push({
        key: chosen.key,
        id: chosen.id,
        name: chosen.name,
        kind: chosen.kind,
        label: chosen.label,
        value: chosen.value,
        before: chosen.before,
        control: chosen.control,
        sourceId: chosen.revisionId,
        sourceIds: sources.map((s) => s.revisionId),
      });
    }

    // 只有至少一个被选字段的最终写入值确实来自该修订，才进入后续清理；
    // 同值来源都会命中。未选字段、或冲突中未采用的不同值不会使修订命中。
    const appliedRevisionIds = ordered
      .filter((rev) =>
        rev.fields.some((saved) =>
          fields.some(
            (planned) =>
              planned.key === saved.key &&
              planned.value === (saved.value == null ? "" : String(saved.value)),
          ),
        ),
      )
      .map((rev) => rev.id);

    return {
      context: {
        token: snapshot.token,
        route: snapshot.route,
        formId: snapshot.formId,
        formIdentity: snapshot.formIdentity,
        fingerprint: snapshot.fingerprint,
        form: snapshot.form,
      },
      revisionIds: ordered.map((r) => r.id),
      revisions: ordered.map((r) => r.id),
      appliedRevisionIds,
      appliedRevisions: appliedRevisionIds,
      fields,
    };
  }

  function sameIdentity(a, b) {
    return a.key === b.key && a.kind === b.kind && a.id === b.id && a.name === b.name;
  }

  function validateCommitContext(plan, expectedSnapshot, liveSnapshot, liveByKey) {
    if (!plan || !plan.context || !Array.isArray(plan.fields))
      failure("bad-plan", "invalid restore plan");
    const ctx = plan.context;
    const expected = expectedSnapshot || {};
    const live = liveSnapshot || {};
    if (
      ctx.token !== expected.token ||
      ctx.route !== expected.route ||
      ctx.formId !== expected.formId ||
      ctx.formIdentity !== expected.formIdentity ||
      ctx.fingerprint !== expected.fingerprint ||
      ctx.form !== expected.form
    ) {
      failure("context-changed", "preview context changed");
    }
    if (
      live.token !== expected.token ||
      live.route !== expected.route ||
      live.formId !== expected.formId ||
      live.formIdentity !== expected.formIdentity ||
      live.fingerprint !== expected.fingerprint ||
      live.form !== expected.form
    ) {
      failure("context-changed", "route, authorization, or form changed after preview");
    }
    if (!expected.form || expected.form.isConnected === false)
      failure("form-detached", "original form is no longer connected");

    const expectedByKey = new Map((expected.fields || []).map((f) => [f.key, f]));
    const targets = [];
    for (const field of plan.fields) {
      const atPreview = expectedByKey.get(field.key);
      const live = liveByKey.get(field.key);
      if (!atPreview || !live) failure("missing", "field disappeared");
      if (!field.control || field.control !== atPreview.control || field.control !== live.control)
        failure("control-changed", "original control changed");
      if (!sameIdentity(field, atPreview) || !sameIdentity(field, live))
        failure("identity-changed", "field identity changed");
      const tagName = String(field.control.tagName || "").toUpperCase();
      if (field.kind === "textarea") {
        if (tagName !== "TEXTAREA") failure("kind-changed", "control is not a textarea");
      } else if (tagName !== "INPUT" || field.control.type !== field.kind.slice(6)) {
        failure("kind-changed", "control input type changed");
      }
      if (field.control.form !== undefined && field.control.form !== ctx.form)
        failure("control-changed", "control no longer belongs to the original form");
      if (field.control.isConnected === false)
        failure("control-detached", "control is no longer connected");
      if (field.control.disabled || field.control.readOnly)
        failure("control-not-writable", "control became disabled or readonly");
      // 预览打开后的值、以及 buildPlan 之后的值都必须仍与计划一致。
      if (atPreview.value !== field.before || live.value !== field.before)
        failure("field-changed", "current field value changed after preview");
      if (field.control.value !== undefined && field.control.value !== field.before)
        failure("field-changed", "live control value changed after plan was built");
      targets.push({ field, control: field.control, value: field.value });
    }
    return targets;
  }

  function commit(plan, expectedSnapshot, liveSnapshotOrWrite, maybeWrite) {
    const hasLiveSnapshot = typeof maybeWrite === "function";
    const liveSnapshot = hasLiveSnapshot ? liveSnapshotOrWrite : expectedSnapshot;
    const write = hasLiveSnapshot ? maybeWrite : liveSnapshotOrWrite;
    const liveByKey = validateSnapshot(liveSnapshot || expectedSnapshot);
    const targets = validateCommitContext(
      plan,
      expectedSnapshot,
      liveSnapshot,
      liveByKey,
    );

    // 所有条件已先通过；从这里开始才允许写入。
    for (const target of targets) write(target, target.value);
    // 保持早期 commit(plan, snapshot, write) 返回已参与修订 ID 数组的调用方式，
    // 同时附带更明确的字段计数与可清理修订列表。
    const result = plan.revisionIds.slice();
    result.fieldCount = targets.length;
    result.revisionIds = plan.revisionIds.slice();
    result.revisions = plan.revisionIds.slice();
    result.appliedRevisionIds = plan.appliedRevisionIds.slice();
    result.appliedRevisions = plan.appliedRevisionIds.slice();
    return result;
  }

  // 内容脚本在重新取数后调用：liveSnapshot 是确认瞬间重新抓取的当前 DOM，
  // expectedSnapshot 是预览打开时冻结的上下文。这样无需把 DOM 控件序列化进计划。
  function commitWithLiveSnapshot(plan, expectedSnapshot, liveSnapshot, write) {
    return commit(plan, expectedSnapshot, liveSnapshot, write);
  }

  const api = {
    MIN_REVISIONS,
    MAX_REVISIONS,
    MAX_FIELDS,
    buildPlan,
    commit,
    commitWithLiveSnapshot,
  };
  if (typeof module !== "undefined") module.exports = api;
  else root.FSPBatch = api;
})(globalThis);
