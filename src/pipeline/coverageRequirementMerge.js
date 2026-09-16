// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

const attribution = ["src", "sources", "provenance"];
const behavior = req => JSON.stringify(Object.fromEntries(Object.entries(req)
  .filter(([key]) => !key.startsWith("_") && !attribution.includes(key))
  .sort(([a], [b]) => a.localeCompare(b))));

// Coverage review owns amendments, not a lossy replacement of every record.
// Preserve omitted fields for the same requirement. Attribution may be carried
// only when every behavioral field (including rationale/choice references and
// formal environment role) is unchanged. Changed behavior needs fresh support.
export function mergeCoverageRequirements(original, reviewed) {
  const byId = new Map(original.map(req => [req.id, req]));
  const preserved = [], issues = [];
  const requirements = reviewed.map(update => {
    const prior = byId.get(update.id);
    if (!prior) return { ...update };
    const next = { ...prior, ...update };
    if ((next.environment === true) !== (prior.environment === true)) {
      issues.push({ id: update.id, reason: "Coverage review cannot change a requirement's formal environment role" });
    }
    if (behavior(prior) !== behavior(next)) {
      for (const key of attribution) if (!Object.hasOwn(update, key)) delete next[key];
    } else {
      const fields = attribution.filter(key => Object.hasOwn(prior, key) && !Object.hasOwn(update, key));
      if (fields.length) preserved.push({ id: update.id, fields });
    }
    return next;
  });
  return { requirements, preserved, issues };
}
