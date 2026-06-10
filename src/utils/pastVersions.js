// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// utils/pastVersions — collect (step, iter, code) snapshots for split-view
//
// Lets the split-view picker select arbitrary past versions of the code paired
// with metadata (step that produced the fix, iteration ID inside that step's
// fix loop).
//
// Data sources (all populated by the _structured capture):
//   - rtl_generate (id 4)._originalCode      → the very-first generated RTL
//   - test_generate (id 7)._originalCode     → the very-first generated TB
//   - lint (id 6).iterations[]._structured.afterCode (RTL fix)
//   - lint_test (id 12).iterations[]._structured.afterCode (TB fix)
//   - verify (id 8).verifyHistory[]._structured.rtlFix.afterCode (RTL fix)
//   - verify (id 8).verifyHistory[]._structured.tbFix.afterCode (TB fix)
//   - rtl_review (id 10)._iterations[]._structured.afterCode (RTL fix)
//   - test_review (id 11)._iterations[]._structured.afterCode (TB fix)
//
// Each snapshot is { stepId, stepKey, stepLabel, iter, code, kind, label }
// where `kind` is "rtl" or "tb" so callers can filter by which split-view
// they're populating, and `label` is a human-readable string ready for a
// dropdown.
// ═══════════════════════════════════════════════════════════════════════════

const STAGE_LABELS = {
  4:  { key: "rtl_generate",  label: "RTL Gen" },
  6:  { key: "lint",          label: "Lint" },
  7:  { key: "test_generate", label: "Test Gen" },
  8:  { key: "verify",        label: "Verify" },
  9:  { key: "judge",         label: "Judge" },
  10: { key: "rtl_review",    label: "RTL Review" },
  11: { key: "test_review",   label: "Test Review" },
  12: { key: "lint_test",     label: "Lint Test" },
};

function _stageInfo(stageId) {
  return STAGE_LABELS[stageId] || { key: "stage_" + stageId, label: "Stage " + stageId };
}

/**
 * Collect all RTL-code snapshots from the current stageData.
 *
 * Returns the snapshots in chronological order (RTL Gen original → lint fixes
 * → rtl_review fixes → verify RTL fixes → judge regen, etc.). Each entry has
 * enough metadata for a dropdown to display "Step / iter N — N+ M lines".
 *
 * Reflow provenance. If `stageRuns` is provided (the per-stage run-history map
 * managed by the reducer), we ALSO emit a labeled snapshot for every chain
 * re-run that carries an `.result.code` field.
 * Each gets a label like:
 *
 *   "Lint — iter 2 · reflow inside judge iter 1 (depth 1)"
 *
 * so the user can distinguish (a) the original top-level lint iter 2 fix
 * from (b) a re-run of that lint iter 2 fix that happened INSIDE a
 * judge-triggered reflow chain. Without the provenance these would look
 * identical in the dropdown.
 *
 * The legacy snapshot sources (iterations[], verifyHistory[], etc.) keep
 * working as before — this just appends additional entries.
 *
 * @param {object} stageData  Full stageData map keyed by stage id.
 * @param {object} [stageRuns] Optional per-stage run history (module.stageRuns).
 * @returns {Array<{stepId: number, stepKey: string, stepLabel: string, iter: number,
 *                  code: string, kind: string, label: string, lineCount: number}>}
 */
export function collectRTLSnapshots(stageData, stageRuns) {
  return _collectSnapshots(stageData, "rtl", stageRuns);
}

/**
 * Collect all TB-code snapshots from stageData. Same shape as collectRTLSnapshots.
 */
export function collectTBSnapshots(stageData, stageRuns) {
  return _collectSnapshots(stageData, "tb", stageRuns);
}

function _collectSnapshots(stageData, kind, stageRuns) {
  if (!stageData || typeof stageData !== "object") return [];
  const snapshots = [];

  // 1. Original code from RTL Gen (4) or Test Gen (7).
  const generateStageId = kind === "rtl" ? 4 : 7;
  const generateData = stageData[generateStageId];
  if (generateData) {
    // Prefer _originalCode (set when ANY downstream fix mutated the code).
    // If _originalCode is absent, the stage's `code` IS the original.
    const originalCode = generateData._originalCode || generateData.code;
    if (originalCode) {
      snapshots.push({
        stepId:    generateStageId,
        stepKey:   _stageInfo(generateStageId).key,
        stepLabel: _stageInfo(generateStageId).label,
        iter:      0,
        code:      originalCode,
        kind:      kind,
        label:     _stageInfo(generateStageId).label + " — original",
        lineCount: originalCode.split("\n").length,
      });
    }
  }

  // 2. Lint (RTL) — id 6, or Lint Test (TB) — id 12.
  const lintStageId = kind === "rtl" ? 6 : 12;
  const lintData = stageData[lintStageId];
  if (lintData && Array.isArray(lintData.iterations)) {
    lintData.iterations.forEach(function(it) {
      if (it && it._structured && it._structured.afterCode) {
        snapshots.push({
          stepId:    lintStageId,
          stepKey:   _stageInfo(lintStageId).key,
          stepLabel: _stageInfo(lintStageId).label,
          iter:      it.iter,
          code:      it._structured.afterCode,
          kind:      kind,
          label:     _stageInfo(lintStageId).label + " — iter " + it.iter,
          lineCount: it._structured.afterCode.split("\n").length,
        });
      }
    });
  }

  // 3. Review stage (RTL Review id 10 / Test Review id 11).
  const reviewStageId = kind === "rtl" ? 10 : 11;
  const reviewData = stageData[reviewStageId];
  if (reviewData && Array.isArray(reviewData._iterations)) {
    reviewData._iterations.forEach(function(it) {
      if (it && it._structured && it._structured.afterCode) {
        snapshots.push({
          stepId:    reviewStageId,
          stepKey:   _stageInfo(reviewStageId).key,
          stepLabel: _stageInfo(reviewStageId).label,
          iter:      it.iter,
          code:      it._structured.afterCode,
          kind:      kind,
          label:     _stageInfo(reviewStageId).label + " — iter " + it.iter,
          lineCount: it._structured.afterCode.split("\n").length,
        });
      }
    });
  }

  // 4. Verify (id 8) — has BOTH rtlFix and tbFix per iter.
  const verifyData = stageData[8];
  if (verifyData && Array.isArray(verifyData.verifyHistory)) {
    verifyData.verifyHistory.forEach(function(h) {
      const sub = h && h._structured;
      if (!sub) return;
      const fixField = kind === "rtl" ? "rtlFix" : "tbFix";
      const f = sub[fixField];
      if (f && f.afterCode) {
        snapshots.push({
          stepId:    8,
          stepKey:   "verify",
          stepLabel: "Verify (" + (kind === "rtl" ? "RTL" : "TB") + ")",
          iter:      h.iter,
          code:      f.afterCode,
          kind:      kind,
          label:     "Verify — iter " + h.iter + " (" + (kind === "rtl" ? "RTL" : "TB") + " fix)",
          lineCount: f.afterCode.split("\n").length,
        });
      }
    });
  }

  // 5. Judge (id 9). Each judge iteration may regen RTL and/or TB; the capture
  // stores _structured.{rtlRegen,tbRegen} on each judgeHistory entry. Walk
  // those and surface the afterCode per iter.
  const judgeData = stageData[9];
  if (judgeData && Array.isArray(judgeData.judgeHistory)) {
    judgeData.judgeHistory.forEach(function(h) {
      const sub = h && h._structured;
      if (!sub) return;
      const regenField = kind === "rtl" ? "rtlRegen" : "tbRegen";
      const r = sub[regenField];
      if (r && r.afterCode) {
        snapshots.push({
          stepId:    9,
          stepKey:   "judge",
          stepLabel: "Judge (" + (kind === "rtl" ? "RTL" : "TB") + ")",
          iter:      h.iter,
          code:      r.afterCode,
          kind:      kind,
          label:     "Judge — iter " + h.iter + " (" + (kind === "rtl" ? "RTL" : "TB") + " regen)",
          lineCount: r.afterCode.split("\n").length,
        });
      }
    });
  }

  // 6. Manual edits. When the user edits code in the
  // SplitCodeView and clicks "Done Editing", a snapshot is pushed to
  // stageData[4]._manualEditHistory[] (or [7] for TB). Surface those here
  // so they appear in the compare dropdown.
  const generateMod = stageData[generateStageId];
  if (generateMod && Array.isArray(generateMod._manualEditHistory)) {
    generateMod._manualEditHistory.forEach(function(entry, idx) {
      if (entry && entry.code) {
        const ts = entry.ts ? new Date(entry.ts).toLocaleString() : "";
        snapshots.push({
          stepId:    generateStageId,
          stepKey:   _stageInfo(generateStageId).key,
          stepLabel: _stageInfo(generateStageId).label + " (manual edit)",
          iter:      idx + 1,
          code:      entry.code,
          kind:      kind,
          label:     "Manual edit #" + (idx + 1) + (ts ? " @ " + ts : ""),
          lineCount: entry.code.split("\n").length,
          manual:    true,
          ts:        entry.ts || null,
        });
      }
    });
  }

  // 7. Reflow re-runs from stageRuns. Each entry in
  // stageRuns[id] is one execution of that stage (top-level or chain
  // re-run). For chain re-runs (context.depth > 0), we add a labeled
  // snapshot that EXPLICITLY says where the re-run happened in the
  // reflow hierarchy. This is what makes the dropdown's provenance
  // useful for diagnosing convergence.
  //
  // We skip:
  //   • runs with context.depth === 0 or null (top-level — already
  //     covered by the legacy sources above)
  //   • runs missing a .result.code (no code to compare against —
  //     these are typically lint/verify runs that didn't regen code)
  //   • runs marked status="error" / "aborted" (no usable artifact)
  //
  // RTL kind: codeful stages are 4 (rtl_generate), 6 (lint),
  //           10 (rtl_review), 8 (verify). For 8 we read .verify.rtlFix
  //           if the result has the structured capture, falling back
  //           to .verify.code if not.
  // TB kind:  codeful stages are 7 (test_generate), 12 (lint_test),
  //           11 (test_review), 8 (verify with tbFix).
  if (stageRuns && typeof stageRuns === "object") {
    const codefulStageIds = kind === "rtl"
      ? [4, 6, 10, 8]
      : [7, 12, 11, 8];
    for (const sid of codefulStageIds) {
      const runs = stageRuns[sid];
      if (!Array.isArray(runs)) continue;
      for (const r of runs) {
        if (!r || !r.context) continue;
        if (r.status !== "complete") continue;
        if (!r.context.depth || r.context.depth < 1) continue;
        // Extract the code from r.result. The shape depends on the stage:
        //   rtl_generate / test_generate → result.code
        //   verify → result.code (if it ran regen) or skip
        //   lint / lint_test / *_review → result usually doesn't have
        //     a .code field directly; the code mutation is recorded
        //     inside the stage's iteration capture. Skip in those cases
        //     to avoid generating duplicate snapshots from the legacy
        //     sources above.
        const res = r.result;
        if (!res || typeof res !== "object") continue;
        // Only emit when result has a top-level `code` field. For
        // most reflow re-runs of regenerating stages this is true.
        if (typeof res.code !== "string" || res.code.length === 0) continue;
        const owner = r.context.parentStageKey || "?";
        const ownerIter = r.context.parentIter != null ? r.context.parentIter : "?";
        const depth = r.context.depth;
        const stepLabel = _stageInfo(sid).label;
        snapshots.push({
          stepId:    sid,
          stepKey:   _stageInfo(sid).key,
          stepLabel: stepLabel,
          iter:      r.runId,
          code:      res.code,
          kind:      kind,
          // Provenance label includes the reflow context.
          // Example: "Lint — run #3 · reflow inside judge iter 1 (depth 1)"
          label:     stepLabel +
                     " — run #" + r.runId +
                     " · reflow inside " + owner +
                     " iter " + ownerIter +
                     " (depth " + depth + ")",
          lineCount: res.code.split("\n").length,
          reflow:    true,
          // Carry the raw provenance fields so future consumers can
          // build their own labels without parsing the string.
          provenance: {
            depth:          depth,
            parentStageKey: owner,
            parentIter:     ownerIter,
            reason:         r.context.reason || null,
            runId:          r.runId,
            ts:             r.finishedAt || r.ts || null,
          },
        });
      }
    }
  }

  return snapshots;
}
