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
import { runCli, parseCLIOutput, CliBackendError } from "../../cli/index.js";
import { promptTB } from "../../prompts/index.js";
import { promptTBLintFix } from "../../prompts/lint.js";
import { promptTBFromVerifyFail } from "../../prompts/verify.js";
import { promptTestReviewFix } from "../../prompts/testReview.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { formatErrorsToAvoid } from "../errorsToAvoid.js";
import { createLogger } from "../log.js";
import {
  resolveBestOfN, resolveBestOfNTemp, diversityConfig, summarizeLint,
  runBestOfN, bestOfNMeta, RANK_CRITERIA,
} from "../bestOfN.js";

export async function testGenerateNode(st) {
  const ci = st._childInterfaces || [];
  const ctx = st._fixContext;
  const rtlCode = (st.rtl_generate && st.rtl_generate.code) || "";
  // Cross-run "errors to avoid" (#26–28), opt-in. Empty when off / no lessons
  // → cold promptTB is byte-identical to before.
  const _avoidTb = (st._config && st._config.errorsToAvoid && st._services && st._services.errorMemory)
    ? formatErrorsToAvoid(st._services.errorMemory.all(), { domain: "tb", model: st._config.model || null, crossModel: !!st._config.errorsToAvoidCrossModel })
    : "";

  let p;
  let stageLabel = "test_generate";
  // Best-of-N applies to COLD generation only (mirror of rtl_generate).
  let isColdGen = false;
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
      isColdGen = true;
    }
  } else {
    p = promptTB(rtlCode, st.spec, st.elicit, ci, _avoidTb);
    isColdGen = true;
  }

  p = await applySkillsToPrompt(p, st, "test_generate");
  const _sc = getStageConfig(st._config, "test_generate");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  addRetryHint(p, st._lastError);

  // ── Best-of-N cold generation (#17) ──
  const _N = isColdGen ? resolveBestOfN(st._config) : 1;
  if (_N >= 2 && st._config && st._config.backendUrl) {
    return await generateTBBestOfN(st, p, _sc, _N, stageLabel, rtlCode);
  }

  // callLLMJson = callLLM + extractJSON + one hinted re-ask on parse failure.
  const jr = await callLLMJson(p);
  const d = jr.data;
  const lastText = jr.llms[jr.llms.length - 1].text;
  const _llms = jr.llms.map(function(r) { return Object.assign({ stage: stageLabel }, r); });
  const _llm = _llms[_llms.length - 1];
  const out = {
    test_generate: { code: d.code || lastText, _llms: _llms },
    _llm: _llm,
    _llms: _llms,
  };
  // Durable cold-generation ledger (see docs/best-of-n.md) — survives the merge
  // that clobbers test_generate._llms when downstream stages rewrite { code }.
  if (isColdGen) out._genLlmsTb = _llms;
  return out;
}

/**
 * Best-of-N TB generation. Candidates are ranked on INTEGRATION: each TB is
 * linted together with the (fixed) RTL via tbLintCmd, so the winner is the TB
 * that elaborates cleanest against the DUT. Deliberately not ranked on sim
 * pass/fail — a correct TB should fail against buggy RTL (see docs/best-of-n.md).
 */
async function generateTBBestOfN(st, p, _sc, n, stageLabel, rtlCode) {
  const temp = resolveBestOfNTemp(st._config);
  const moduleName = (st.elicit && st.elicit.modName) || "module";
  const rtlFileName = moduleName + ".sv";
  const tbFileName = moduleName + "_tb.sv";
  const tbLintCmd = (st._config.tbLintCmd || "verilator --lint-only -Wall {TB}")
    .replace("{TB}", tbFileName);
  const _cliOpts = {
    retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
    timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
    logger:    st._logger || null,
  };
  const _strictCli = (st._config.strictCli !== false) && !!st._config.backendUrl;
  const appendLog = createLogger(st._onLog, "thin");
  appendLog("Best-of-" + n + " TB generation", "Drawing " + n
    + " candidates (candidate 0 greedy, rest @ temp " + temp + "), selecting the cleanest integration with the DUT…");

  const runningLlms = [];
  const result = await runBestOfN({
    n: n,
    criteria: RANK_CRITERIA,
    makeConfig: function (i) { return diversityConfig(_sc, i, temp); },
    generate: async function (cfg, i) {
      const pc = Object.assign({}, p, { config: cfg });
      const jr = await callLLMJson(pc);
      const code = (jr.data && jr.data.code) || jr.llms[jr.llms.length - 1].text;
      const llms = jr.llms.map(function (r) { return Object.assign({ stage: stageLabel + "@bestof" + i }, r); });
      for (let k = 0; k < llms.length; k++) runningLlms.push(llms[k]);
      return { code: code, llms: llms };
    },
    lintCode: async function (code) {
      // Provide BOTH files so the TB elaborates against the DUT (integration).
      const res = await runCli(st._config.backendUrl, {
        command: tbLintCmd, files: { [rtlFileName]: rtlCode, [tbFileName]: code },
      }, st._signal, _cliOpts);
      if (res && res._error) {
        if (_strictCli) throw new CliBackendError(res._msg, res._attempts || 1);
        return null;
      }
      if (res && res.exitCode !== undefined) {
        const parsed = parseCLIOutput(res.stderr);
        return summarizeLint({ exitCode: res.exitCode, errors: parsed.errors, warnings: parsed.warnings });
      }
      return null;
    },
    onCandidate: function (rec) {
      const l = rec.lint;
      appendLog("Candidate " + rec.index,
        rec.error ? ("generation failed — skipped (" + rec.error + ")")
          : !l ? "could not be linted (no result) — ranks worst"
          : (l.compiles ? "integrates with DUT" : "does NOT integrate")
            + ", " + l.errors + " errors, " + l.warnings + " warnings");
    },
    shouldContinue: function (/* i */) {
      if (st._budget && st._budget.enabled) {
        const over = st._budget.overWith(runningLlms);
        if (over) {
          appendLog("⛔ RUN BUDGET EXHAUSTED", over.message
            + "\nStopping best-of-N early; ranking the candidates drawn so far.");
          return false;
        }
      }
      return true;
    },
  });

  const winner = result.winner;
  const meta = bestOfNMeta(result);
  appendLog("Best-of-N selection",
    "Picked candidate " + meta.winner + " of " + meta.n + " (lower index breaks ties).");
  const _llm = (winner.llms && winner.llms.length)
    ? winner.llms[winner.llms.length - 1]
    : runningLlms[runningLlms.length - 1];
  return {
    test_generate: { code: winner.code, _llms: runningLlms.slice(), _bestOfN: meta },
    _genLlmsTb: runningLlms.slice(),
    _llm: _llm,
    _llms: runningLlms.slice(),
  };
}
