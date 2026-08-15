// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// pipeline/datasetCollector — every artifact a run produces, labelled
//
// The training export (trainingExport.js) reads a FINISHED checkpoint and
// emits only what passed. That throws away most of what a run learns:
//
//   - the failures. A model that produced RTL with seven lint warnings and
//     could not fix them is exactly the example a repair-trained model needs,
//     and the export drops it because judge never passed.
//   - the intermediate attempts. The checkpoint size guard sheds `_iterations`
//     on any large run, so by export time the fix history may be gone.
//   - who wrote it. Nothing downstream can tell a strong teacher's output from
//     a model's own, and mixing the two silently is how self-distillation
//     happens by accident.
//
// This collects at the moment each stage completes, so nothing depends on what
// survives serialisation. Every record carries the model and provider that
// produced it, because a dataset assembled from several models is only useful
// if the rows can be told apart.
//
// Records are one of two roles:
//   generate — (spec/architecture → code), labelled with how it then measured
//   repair   — (findings + before-code → after-code), labelled with whether
//              the next measurement actually improved
//
// Pure. The caller supplies identity and does the writing.
// ═══════════════════════════════════════════════════════════════════════════

/** Stable short id for a spec, so runs of the same spec group together. */
export function specId(text) {
  const s = String(text || "");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = ((h1 ^ s.charCodeAt(i)) >>> 0) * 0x01000193 >>> 0;
    h2 = ((h2 + s.charCodeAt(i)) >>> 0) * 0x85ebca6b >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

function findingsText(list) {
  return (list || []).slice(0, 40)
    .map((e) => "- [" + (e.code || e.type || "ISSUE") + "] " + (e.msg || e.message || "")).join("\n");
}

/**
 * Records for one completed stage.
 *
 * @param {object} a
 * @param {string} a.stageKey   rtl_generate | lint | rtl_review | test_generate | …
 * @param {object} a.result     the stage's result object as dispatched
 * @param {object} a.ident      { specId, specName, project, module, model, provider, ts }
 * @returns {Array<object>} zero or more records
 */
export function artifactRecords(a) {
  const stageKey = a && a.stageKey;
  const r = (a && a.result) || {};
  const id = (a && a.ident) || {};
  const out = [];
  const base = function(extra) {
    return Object.assign({
      spec_id:  id.specId || null,
      spec_name: id.specName || null,
      project:  id.project || null,
      module:   id.module || null,
      model:    id.model || null,
      provider: id.provider || null,
      stage:    stageKey,
      ts:       id.ts || null,
    }, extra);
  };

  const RTL_GEN = { rtl_generate: 1 };
  const TB_GEN  = { test_generate: 1 };
  const RTL_FIX = { lint: 1, rtl_review: 1 };
  const TB_FIX  = { lint_test: 1, test_review: 1 };

  // ── generated artifacts ─────────────────────────────────────────────
  if (RTL_GEN[stageKey] && r.code) {
    out.push(base({ artifact: "rtl", role: "generate", iteration: 0, code: r.code, outcome: {} }));
  }
  if (TB_GEN[stageKey] && r.code) {
    out.push(base({ artifact: "tb", role: "generate", iteration: 0, code: r.code, outcome: {} }));
  }

  // ── measured outcomes, and the repairs attempted along the way ───────
  const artifact = (RTL_FIX[stageKey] || stageKey === "verify") ? "rtl"
    : TB_FIX[stageKey] ? "tb" : null;

  const its = Array.isArray(r.iterations) ? r.iterations : [];
  for (let k = 0; k < its.length; k++) {
    const cur = its[k];
    const next = its[k + 1] || null;
    const st = cur && cur._structured;
    // The measurement of whatever code went INTO this iteration — a labelled
    // artifact whether it passed or failed. Failures are the point: an export
    // that keeps only passing code cannot teach repair.
    out.push(base({
      artifact: artifact || "rtl",
      role: "measure",
      iteration: cur.iter != null ? cur.iter : k + 1,
      code: (st && st.beforeCode) || null,
      outcome: {
        status:   cur.status || null,
        errors:   typeof cur.errors === "number" ? cur.errors : null,
        warnings: typeof cur.warnings === "number" ? cur.warnings : null,
      },
      findings: findingsText([].concat(cur.errorList || [], cur.warningList || [])) || null,
    }));
    // The repair itself, labelled with whether the NEXT measurement improved.
    // `improved` is measured, never asserted — an unimproved repair is still
    // kept, because "this edit did not help" is a training signal too.
    if (st && st.beforeCode && st.afterCode && st.afterCode !== st.beforeCode) {
      const before = typeof cur.errors === "number" ? cur.errors : null;
      const after  = next && typeof next.errors === "number" ? next.errors : null;
      out.push(base({
        artifact: artifact || "rtl",
        role: "repair",
        iteration: cur.iter != null ? cur.iter : k + 1,
        findings: findingsText([].concat(cur.errorList || [], cur.warningList || [])),
        before_code: st.beforeCode,
        code: st.afterCode,
        outcome: { errors_before: before, errors_after: after },
        improved: (before != null && after != null) ? (after < before) : null,
      }));
    }
  }

  // ── terminal verdicts on a finished artifact ────────────────────────
  if (stageKey === "verify" && (r.pass != null || r.total != null)) {
    out.push(base({
      artifact: "rtl", role: "measure", iteration: null, code: null,
      outcome: { pass: r.pass, total: r.total, fail: r.fail, sim: r.sim || null },
    }));
  }
  if (stageKey === "judge" && (r.overall || r.score != null)) {
    out.push(base({
      artifact: "rtl", role: "measure", iteration: null, code: null,
      outcome: { verdict: r.overall || null, score: r.score != null ? r.score : null },
    }));
  }
  if ((stageKey === "rtl_review" || stageKey === "test_review") && (r.verdict || r.score != null)) {
    out.push(base({
      artifact: stageKey === "rtl_review" ? "rtl" : "tb",
      role: "measure", iteration: null,
      code: r._reviewedCode || null,
      outcome: { verdict: r.verdict || null, score: r.score != null ? r.score : null,
                 issues: Array.isArray(r.issues) ? r.issues.length : null },
    }));
  }

  return out.filter(function(rec) {
    // A record with neither code nor a measurement teaches nothing.
    return rec.code || rec.before_code || (rec.outcome && Object.keys(rec.outcome).length > 0);
  });
}
