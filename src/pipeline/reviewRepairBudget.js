// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// One repair allowance per review tree. Nested reviews assess the regenerated
// artifact; the owner decides whether to spend another repair. Re-asks and a
// fallback after a failed chain also consume the same allowance.
export function reviewRepairBudget(st, key, limit) {
  const inherited = st._reviewRepairBudgets?.[key];
  const budget = inherited || { limit: Math.max(0, Number.isFinite(limit) ? limit : 4), used: 0,
    stopReason: null, rejections: [] };
  st._reviewRepairBudgets = { ...st._reviewRepairBudgets, [key]: budget };
  const seen = new Map();
  return {
    budget, nested: !!inherited,
    take() {
      if (budget.stopReason) return false;
      if (budget.used >= budget.limit) {
        budget.stopReason = "shared repair budget exhausted";
        return false;
      }
      budget.used++;
      return true;
    },
    reject(candidate, reason, diagnostics = "") {
      const entry = { reason, diagnostics: String(diagnostics).slice(0, 12000), candidate };
      budget.rejections.push(entry);
      const signature = JSON.stringify([String(candidate).replace(/\s+/g, " ").trim(), reason, entry.diagnostics]);
      const count = (seen.get(signature) || 0) + 1;
      seen.set(signature, count);
      if (count >= 2) budget.stopReason = "repeated rejected repair";
    },
    feedback(review) {
      const last = budget.rejections.at(-1);
      return last ? { ...review, _repairRejection: last } : review;
    },
    report() {
      return { limit: budget.limit, used: budget.used,
        stopReason: budget.stopReason,
        rejections: budget.rejections.slice() };
    },
  };
}
