(function (root) {
  function buildPlan(revisions, choices, snapshot) {
    const merged = new Map();
    for (const revision of revisions
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)) {
      for (const field of revision.fields) {
        const current = snapshot.fields.find((f) => f.key === field.key);
        if (!current) throw Error("field missing");
        if (
          !merged.has(field.key) ||
          !choices[field.key] ||
          choices[field.key] === revision.id
        )
          merged.set(field.key, {
            ...field,
            sourceId: revision.id,
            before: current.value,
            control: current.control,
          });
      }
    }
    return {
      context: { ...snapshot },
      revisions: revisions.map((r) => r.id),
      fields: [...merged.values()],
    };
  }
  function commit(plan, snapshot, write) {
    if (
      plan.context.token !== snapshot.token ||
      plan.context.route !== snapshot.route
    )
      throw Error("document changed");
    for (const field of plan.fields) {
      const current = snapshot.fields.find((f) => f.key === field.key);
      if (
        !current ||
        current.kind !== field.kind ||
        current.value !== field.before
      )
        throw Error("field changed");
      write(current, field.value);
    }
    return plan.revisions.slice();
  }
  const api = { buildPlan, commit };
  if (typeof module !== "undefined") module.exports = api;
  else root.FSPBatch = api;
})(globalThis);
