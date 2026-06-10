// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// reflowPlanner
//
// Given the triage target K and the current pipeline tail, produce the
// ordered chain of stages judge should run for one outer iteration.
//
// CONTRACT:
//   planReflow({
//     triageTarget: "rtl_generate",
//     activeStages: getActiveStages(...),  // ordered by .order
//     state:        currentState,           // for "smart" skip predicates
//     mode:         "smart" | "strict",
//   })
//   → [ { stageId, stageKey, order, reason } ]
//
// REASONS attached to each entry (surfaced in the trace panel):
//   "triage"         — the user-triaged regen target itself
//   "downstream"     — runs because something earlier in the chain changed
//   "always"         — verify and judge always run (gating)
//   "skipped"        — present in the tail but skipped (smart mode)
//
// SMART MODE LOGIC:
//   - K (the triage target) → always runs ("triage")
//   - Every stage after K → runs UNLESS:
//       (a) its previously-stored result is non-null AND has a "passing"
//           indicator (lint.status === "PASS" / lint_test.status === "PASS" /
//           verify.fail === 0 etc.), AND
//       (b) it depends only on stages we did NOT re-run.
//     We use a conservative "depends on everything upstream" model — once
//     ANY upstream stage in the chain runs, the current stage runs too,
//     because its inputs changed.
//   - verify and judge always run at the end (gating stages).
//
// STRICT MODE LOGIC:
//   - Every active stage from K onwards runs unconditionally.
//
// NOTE: stages before K are NEVER included — the chain is the K-to-X tail only.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure planner — no I/O. The caller (judge.js) consumes the chain
 * sequentially, invoking the orchestrator per entry.
 *
 * Judge's K-to-X reflow entry point. The triage target is the stage judge
 * picked to regenerate; the chain runs from there through judge inclusive.
 */
export function planReflow(opts) {
  const triageTarget = opts.triageTarget;
  const stages       = opts.activeStages || [];
  const state        = opts.state || {};
  const mode         = (opts.mode === "strict") ? "strict" : "smart";
  // The caller may attach a fixContext that the chain runner forwards onto the
  // triage entry's subState.
  const fixContext   = opts.fixContext || null;

  if (!triageTarget) return [];

  // Locate the triage target in the active-stages list
  const targetIdx = stages.findIndex(function(s) { return s.key === triageTarget; });
  if (targetIdx < 0) return [];

  // The chain runs from K through the end of the pipeline (judge inclusive);
  // stages before K are not included.
  const tail = stages.slice(targetIdx);

  return _buildChain(tail, state, mode, {
    // For judge: the triage target is the K entry; verify and judge
    // themselves are gating stages that always re-run.
    triageKey:  triageTarget,
    alwaysKeys: ["verify", "judge"],
    fixContext: fixContext,
  });
}

/**
 * Generalized per-stage planner.
 *
 * When a non-judge loopback-capable stage (lint, lint_test, rtl_review,
 * test_review, verify) triggers its own K-to-X reflow, this function
 * computes the chain. The owner stage is BOTH the start anchor (via
 * its STAGE_REFLOW_SCOPE entry) AND the terminal stage of its chain.
 *
 * @param {object} opts
 * @param {string} opts.ownerKey      — which stage owns this loopback
 * @param {Array}  opts.tail          — pre-computed tail from getReflowTail(ownerKey, activeStages)
 * @param {object} opts.state         — current pipeline state for skip predicates
 * @param {string} opts.mode          — "smart" | "strict"
 * @param {string} opts.triggerStage  — which stage caused the loopback (typically same as ownerKey, but
 *                                       could be different if a node delegates triage to an inner step)
 */
export function planStageReflow(opts) {
  const ownerKey   = opts.ownerKey;
  const tail       = opts.tail || [];
  const state      = opts.state || {};
  const mode       = (opts.mode === "strict") ? "strict" : "smart";
  // The owner attaches its failure context here.
  const fixContext = opts.fixContext || null;

  if (!ownerKey || tail.length === 0) return [];

  // Default trigger is the HEAD of the tail (the regen target), not the owner.
  // E.g. when lint loops back, the natural triage target is rtl_generate — the
  // artifact lint is asking to be regenerated. Callers can override with
  // opts.triggerStage to triage elsewhere in the tail.
  const triggerKey = opts.triggerStage || tail[0].key;

  return _buildChain(tail, state, mode, {
    // For a stage-level reflow the FIRST entry (head of the K-to-X
    // tail) is the regeneration target. The owner itself is at the
    // end of the tail and always re-runs (it's the "gating" stage
    // analogous to verify/judge in the judge reflow).
    triageKey:  triggerKey,
    alwaysKeys: [ownerKey],
    fixContext: fixContext,
  });
}

/**
 * Shared chain builder. Walks the supplied tail and labels each entry
 * with a reason:
 *   "triage"     → the regeneration target (head of tail)
 *   "always"     → gating stages that always re-run (e.g. verify/judge
 *                  for the judge reflow, or the owner itself for a
 *                  stage reflow)
 *   "downstream" → re-runs because something upstream changed
 *   "skipped"    → smart-mode skip: previously passed, no upstream change
 *
 * Strict mode runs every entry regardless.
 */
function _buildChain(tail, state, mode, opts) {
  const triageKey  = opts.triageKey;
  const alwaysKeys = new Set(opts.alwaysKeys || []);
  // Optional fixContext for the triage entry. When present, the runner forwards
  // it onto the triage stage's subState as `_fixContext`, where the generation
  // node uses it to call its fix-prompt variant instead of cold regen.
  const fixContext = opts.fixContext || null;

  if (mode === "strict") {
    return tail.map(function(s) {
      const reason = (s.key === triageKey) ? "triage"
        : alwaysKeys.has(s.key) ? "always"
        : "downstream";
      const entry = {
        stageId: s.id, stageKey: s.key, order: s.order, reason: reason,
      };
      if (reason === "triage" && fixContext) entry.fixContext = fixContext;
      return entry;
    });
  }

  // Smart mode: skip stages that already passed AND have no upstream changes.
  let anyUpstreamReran = false;
  const out = [];
  let sawTriage = false;
  for (let i = 0; i < tail.length; i++) {
    const s = tail[i];
    // The triage target always runs
    if (s.key === triageKey) {
      const triageEntry = { stageId: s.id, stageKey: s.key, order: s.order, reason: "triage" };
      if (fixContext) triageEntry.fixContext = fixContext;
      out.push(triageEntry);
      anyUpstreamReran = true;
      sawTriage = true;
      continue;
    }
    // Gating stages always run
    if (alwaysKeys.has(s.key)) {
      out.push({ stageId: s.id, stageKey: s.key, order: s.order, reason: "always" });
      continue;
    }
    // Before the triage point, stages can be skipped if passing
    // (this matters for stage-reflow where triage may be later in the tail)
    if (!sawTriage) {
      const prev = state[s.key] || {};
      const wasPassing = isStagePassing(s.key, prev);
      if (wasPassing) {
        out.push({ stageId: s.id, stageKey: s.key, order: s.order, reason: "skipped" });
      } else {
        out.push({ stageId: s.id, stageKey: s.key, order: s.order, reason: "downstream" });
        anyUpstreamReran = true;
      }
      continue;
    }
    // After triage, anything upstream that re-ran propagates
    if (anyUpstreamReran) {
      out.push({ stageId: s.id, stageKey: s.key, order: s.order, reason: "downstream" });
      continue;
    }
    // Otherwise skippable if passing
    const prev = state[s.key] || {};
    const wasPassing = isStagePassing(s.key, prev);
    if (wasPassing) {
      out.push({ stageId: s.id, stageKey: s.key, order: s.order, reason: "skipped" });
    } else {
      out.push({ stageId: s.id, stageKey: s.key, order: s.order, reason: "downstream" });
      anyUpstreamReran = true;
    }
  }
  return out;
}

/**
 * Stage-specific "is this result a pass?" predicate. The eval gate has
 * its own much richer notion of pass/fail but for reflow planning we
 * only need a simple "should I bother re-running this stage in smart
 * mode?" decision.
 */
function isStagePassing(stageKey, result) {
  if (!result || typeof result !== "object") return false;
  if (stageKey === "lint" || stageKey === "lint_test") {
    return result.status === "PASS";
  }
  if (stageKey === "verify") {
    return result.fail === 0 && (result.total || 0) > 0;
  }
  if (stageKey === "rtl_review" || stageKey === "test_review") {
    // Review is "passing" if no critical/major issues unfixed
    return !result.unfixedIssues
      || (Array.isArray(result.unfixedIssues) && result.unfixedIssues.length === 0);
  }
  if (stageKey === "formal_props") {
    // Property generation succeeds when the JSON parsed and has properties
    return Array.isArray(result.properties) && result.properties.length > 0;
  }
  if (stageKey === "test_generate" || stageKey === "rtl_generate") {
    // Generation produced code if `code` non-empty.
    return typeof result.code === "string" && result.code.length > 0;
  }
  return false;
}

/**
 * Resolve the effective per-stage iter limit for a nested re-entry.
 * Returns the nested override if the user set one, else the base limit (so each
 * judge re-entry resets to the base per-stage maxIters unless overridden).
 */
export function resolveNestedIterLimit(stageKey, cfg) {
  if (!cfg) return undefined;
  if (stageKey === "lint" || stageKey === "lint_test") {
    if (typeof cfg.nestedLintIters === "number") return cfg.nestedLintIters;
    return cfg.maxLintIters;
  }
  if (stageKey === "verify") {
    if (typeof cfg.nestedVerifyIters === "number") return cfg.nestedVerifyIters;
    return cfg.maxVerifyIters;
  }
  return undefined;
}
