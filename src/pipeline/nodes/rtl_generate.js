// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/rtl_generate — Stage 4: RTL Code Generation
//
// Generates a complete synthesisable SystemVerilog module.
// Falls back to r.text as the code if extractJSON succeeds but the parsed
// object has no .code field (some models return the code directly).
//
// Informed loopback.
//
// When this node runs as the triage entry of a K-to-X reflow chain, the
// reflow runner passes a `_fixContext` field on the subState containing
// failure information from the owning stage. This node detects it and
// branches to the appropriate FIX prompt instead of cold-regenning from
// spec. This is what makes reflows actually informative — without this
// branch the LLM has no idea what failed and just rerolls the dice.
//
// fixContext shape (uniform across all owner stages):
//   {
//     source:        "lint" | "verify" | "rtl_review" | "judge",
//     ownerIter:     number,
//     previousCode:  string,    // the prior RTL attempt
//     previousFixes: Array,     // accumulated fixes across iterations
//     lintResult:    object?,   // populated when source === "lint"
//     verifyResult:  object?,   // populated when source === "verify" or
//                               // "judge" (judge often forwards verify data)
//     reviewResult:  object?,   // populated when source === "rtl_review"
//     judgeVerdict:  object?,   // populated when source === "judge"
//   }
//
// The mapping from source → fix prompt:
//   source = "lint"        → promptRTLFix(code, lintResult, el, previousFixes)
//   source = "verify"      → promptRTLFromVerifyFail(code, verifyResult, spec, el, previousFixes)
//   source = "rtl_review"  → promptRTLReviewFix(code, reviewResult, spec, el)
//   source = "judge"       → promptRTLFromVerifyFail when verifyResult is present,
//                            else promptRTLFix using judgeVerdict.failingIds as lint-like errors
//
// LLM event label includes "@fix:<source>" so the trace / metrics tabs
// can distinguish informed fix calls from cold regens.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLMJson, addRetryHint } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptRTL } from "../../prompts/index.js";
import { promptRTLFix } from "../../prompts/lint.js";
import { promptRTLFromVerifyFail } from "../../prompts/verify.js";
import { promptRTLReviewFix } from "../../prompts/rtlReview.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";

export async function rtlGenerateNode(st) {
  const ci = st._childInterfaces || [];
  const ctx = st._fixContext;

  // Informed-fix branch.
  let p;
  let stageLabel = "rtl_generate";
  if (ctx && typeof ctx === "object" && ctx.source) {
    const prev = ctx.previousCode || (st.rtl_generate && st.rtl_generate.code) || "";
    const prevFixes = Array.isArray(ctx.previousFixes) ? ctx.previousFixes : [];
    if (ctx.source === "lint" && ctx.lintResult) {
      p = promptRTLFix(prev, ctx.lintResult, st.elicit, prevFixes);
      stageLabel = "rtl_generate@fix:lint";
    } else if (ctx.source === "verify" && ctx.verifyResult) {
      p = promptRTLFromVerifyFail(prev, ctx.verifyResult, st.spec, st.elicit, prevFixes);
      stageLabel = "rtl_generate@fix:verify";
    } else if (ctx.source === "rtl_review" && ctx.reviewResult) {
      p = promptRTLReviewFix(prev, ctx.reviewResult, st.spec, st.elicit);
      stageLabel = "rtl_generate@fix:rtl_review";
    } else if (ctx.source === "judge") {
      if (ctx.verifyResult) {
        p = promptRTLFromVerifyFail(prev, ctx.verifyResult, st.spec, st.elicit, prevFixes);
        stageLabel = "rtl_generate@fix:judge-via-verify";
      } else {
        const synthLint = {
          errors: ((ctx.judgeVerdict && ctx.judgeVerdict.failingIds) || []).map(function(id) {
            return { code: id, msg: "Judge marked criterion " + id + " as failing" };
          }),
          warnings: [],
        };
        p = promptRTLFix(prev, synthLint, st.elicit, prevFixes);
        stageLabel = "rtl_generate@fix:judge";
      }
    } else {
      p = promptRTL(st.architect, st.spec, st.elicit, ci, st._sharedPackageCode || null);
    }
  } else {
    p = promptRTL(st.architect, st.spec, st.elicit, ci, st._sharedPackageCode || null);
  }

  p = await applySkillsToPrompt(p, st, "rtl_generate");
  const _sc = getStageConfig(st._config, "rtl_generate");
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
    rtl_generate: { code: d.code || lastText, _llms: _llms },
    _llm: _llm,
    _llms: _llms,
  };
}
