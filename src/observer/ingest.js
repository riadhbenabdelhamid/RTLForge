// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// observer/ingest — Orchestrate stage-completion observations
//
// Single entry point: `observeStage(ctx)`. Called by runStage.js after a
// stage finishes (success or failure). Must NEVER throw — the observer
// is parallel to the pipeline, not in its critical path. Errors are
// swallowed and surfaced via a one-line console warning.
//
// FLOW:
//   1. If config.observerEnabled !== true → skip (default off).
//   2. Build the minimal raw_input from the stage result (we don't ship
//      full code blocks to the LLM — that would balloon cost and leak
//      no signal anyway).
//   3. Call extractObservation() → structured kind/summary/severity.
//   4. If kind === "nothing" → return (no DB write).
//   5. Insert into observer_events with workflow scoping.
//
// PERFORMANCE: the LLM call is fire-and-forget. We don't await
// completion before returning to runStage; the promise resolves in the
// background and writes the event when ready. Pipeline runs aren't
// blocked.
// ═══════════════════════════════════════════════════════════════════════════

import { openDb, insertEvent } from "./sqlite.js";
import { extractObservation } from "./extractor.js";

/**
 * Observe one stage completion.
 *
 * @param {object} ctx
 * @param {string} ctx.workflow      - "rtl" (today)
 * @param {string} ctx.projectId
 * @param {string} ctx.moduleId
 * @param {string} ctx.stageKey
 * @param {boolean} ctx.succeeded
 * @param {object} ctx.stageResult   - the data the pipeline node returned
 * @param {object} ctx.skillsApplied - skill ids overlaid on this stage
 * @param {object} ctx.llm           - { tokensIn, tokensOut, latencyMs }
 * @param {object} services          - { callLLM, extractJSON, config }
 */
export function observeStage(ctx, services) {
  // Defensive: never throw to the caller. Even synchronous errors
  // (bad config shape) shouldn't bubble up.
  try {
    const cfg = (services && services.config) || {};
    if (cfg.observerEnabled !== true) return;

    const raw = buildRawInput(ctx);

    // Run extraction async — fire-and-forget. Errors caught internally
    // by extractObservation; even so we wrap in another try.
    (async function() {
      try {
        const extracted = await extractObservation(raw, services);
        if (!extracted || extracted.kind === "nothing") return;
        const handle = await openDb(cfg);
        if (!handle.available) return;
        insertEvent(handle, {
          ts:          Date.now(),
          workflow:    ctx.workflow || cfg.workflow || "rtl",
          project_id:  ctx.projectId || null,
          module_id:   ctx.moduleId || null,
          stage_key:   ctx.stageKey || null,
          event_kind:  extracted.kind,
          raw_input:   raw,
          extracted:   extracted,
          severity:    extracted.severity || "info",
        });
      } catch (_e) {
        // Swallow — observer is best-effort. Surface as one-line warning
        // for debuggability without spamming the user log.
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[observer] ingest failed: " + (_e && _e.message ? _e.message : _e));
        }
      }
    })();
  } catch (_e) {
    // Outermost guard: refuse to throw under any circumstance.
  }
}

/**
 * Build the small object we ship to the extractor. We deliberately
 * include only signal-bearing fields to keep cost low and leak nothing
 * about the user's design beyond what the observer needs.
 *
 * Stage code blocks are NOT included. We summarize: line counts,
 * error/warning counts, score, presence of fixes — not the code.
 */
function buildRawInput(ctx) {
  const r = ctx.stageResult || {};
  // Per stage, we extract the typical "outcome shape" fields.
  const out = {
    stage:           ctx.stageKey,
    succeeded:       !!ctx.succeeded,
    skills_applied:  Array.isArray(ctx.skillsApplied) ? ctx.skillsApplied : [],
  };
  if (ctx.llm) {
    out.tokens_in  = ctx.llm.tokensIn  || 0;
    out.tokens_out = ctx.llm.tokensOut || 0;
    out.latency_ms = ctx.llm.latencyMs || 0;
  }
  // Stage-specific summaries:
  switch (ctx.stageKey) {
    case "lint":
    case "lint_test": {
      out.error_count   = (r.errors || []).length;
      out.warning_count = (r.warnings || []).length;
      out.fixes_applied = (r.fixes || []).length;
      // The first few error messages — useful for clustering across runs
      out.first_errors  = (r.errors || []).slice(0, 3).map(function(e) {
        return typeof e === "string" ? e.slice(0, 200) : (e.msg || "").slice(0, 200);
      });
      break;
    }
    case "verify": {
      out.tests_total   = r.total || 0;
      out.tests_pass    = r.pass  || 0;
      out.tests_fail    = r.fail  || 0;
      out.cli           = !!r.cli;
      out.coverage      = r.cov || null;
      out.first_failures = (r.tests || []).filter(function(t) { return t.st === "FAIL"; })
        .slice(0, 3).map(function(t) { return (t.name || "") + ": " + (t.reason || ""); });
      break;
    }
    case "judge": {
      out.overall = r.overall;
      out.score   = r.score;
      out.iterations = (r.judgeHistory || []).length;
      out.eval_failing_ids = r.eval ? (r.eval.failingIds || []).slice(0, 5) : [];
      break;
    }
    case "rtl_generate":
    case "test_generate": {
      out.code_lines = ((r.code || "").match(/\n/g) || []).length;
      break;
    }
    case "rtl_review":
    case "test_review": {
      out.score = r.score;
      out.fixes_applied = (r.fixes || []).length;
      break;
    }
    case "formal_props": {
      out.assertion_count = (r.properties || []).length;
      out.cover_count     = (r.covers || []).length;
      break;
    }
    default: {
      // Unknown stage — include only what we know
      out.note = "stage-specific summary not implemented";
    }
  }
  return out;
}
