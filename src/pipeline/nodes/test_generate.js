// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/test_generate — Stage 7: Self-Checking Directed Testbench Generation
//
// Informed loopback (mirror of rtl_generate).
//
// When this node runs as the triage entry of a K-to-X reflow chain, it
// detects st._fixContext and branches to the appropriate FIX prompt for
// the owning stage's source:
//   source = "lint_test"     → promptTBLintFix(tb, rtl, lintResult, spec, el, previousFixes)
//   source = "verify"        → promptTBFromVerifyFail(tb, rtl, verifyResult, spec, el, previousFixes)
//   source = "test_review"   → promptTestReviewFix(tb, rtl, reviewResult, spec, el)
//   source = "judge"         → promptTBFromVerifyFail when verifyResult is present,
//                              else cold regen (no good TB-only fix prompt for judge)
//
// LLM event label includes "@fix:<source>" for traceability.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLMJson, addRetryHint } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptTB } from "../../prompts/index.js";
import { promptTBLintFix } from "../../prompts/lint.js";
import { promptTBFromVerifyFail } from "../../prompts/verify.js";
import { promptTestReviewFix } from "../../prompts/testReview.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { formatErrorsToAvoid } from "../errorsToAvoid.js";

export async function testGenerateNode(st) {
  const ci = st._childInterfaces || [];
  const ctx = st._fixContext;
  const rtlCode = (st.rtl_generate && st.rtl_generate.code) || "";
  // Cross-run "errors to avoid" (#26–28), opt-in. Empty when off / no lessons
  // → cold promptTB is byte-identical to before.
  const _avoidTb = (st._config && st._config.errorsToAvoid && st._services && st._services.errorMemory)
    ? formatErrorsToAvoid(st._services.errorMemory.all(), { domain: "tb" })
    : "";

  let p;
  let stageLabel = "test_generate";
  if (ctx && typeof ctx === "object" && ctx.source) {
    const prevTB = ctx.previousCode || (st.test_generate && st.test_generate.code) || "";
    const prevFixes = Array.isArray(ctx.previousFixes) ? ctx.previousFixes : [];
    if (ctx.source === "lint_test" && ctx.lintResult) {
      p = promptTBLintFix(prevTB, rtlCode, ctx.lintResult, st.spec, st.elicit, prevFixes);
      stageLabel = "test_generate@fix:lint_test";
    } else if (ctx.source === "verify" && ctx.verifyResult) {
      p = promptTBFromVerifyFail(prevTB, rtlCode, ctx.verifyResult, st.spec, st.elicit, prevFixes);
      stageLabel = "test_generate@fix:verify";
    } else if (ctx.source === "test_review" && ctx.reviewResult) {
      p = promptTestReviewFix(prevTB, rtlCode, ctx.reviewResult, st.spec, st.elicit);
      stageLabel = "test_generate@fix:test_review";
    } else if (ctx.source === "judge" && ctx.verifyResult) {
      p = promptTBFromVerifyFail(prevTB, rtlCode, ctx.verifyResult, st.spec, st.elicit, prevFixes);
      stageLabel = "test_generate@fix:judge-via-verify";
    } else {
      // Source we don't have a TB fix prompt for → cold regen
      p = promptTB(rtlCode, st.spec, st.elicit, ci, _avoidTb);
    }
  } else {
    p = promptTB(rtlCode, st.spec, st.elicit, ci, _avoidTb);
  }

  p = await applySkillsToPrompt(p, st, "test_generate");
  const _sc = getStageConfig(st._config, "test_generate");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  addRetryHint(p, st._lastError);

  // callLLMJson = callLLM + extractJSON + one hinted re-ask on parse failure.
  const jr = await callLLMJson(p);
  const d = jr.data;
  const lastText = jr.llms[jr.llms.length - 1].text;
  const _llms = jr.llms.map(function(r) { return Object.assign({ stage: stageLabel }, r); });
  const _llm = _llms[_llms.length - 1];
  return {
    test_generate: { code: d.code || lastText, _llms: _llms },
    _llm: _llm,
    _llms: _llms,
  };
}
