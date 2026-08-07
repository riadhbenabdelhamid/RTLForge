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
import { promptTBLintFix, patchModeFixPrompt } from "../../prompts/lint.js";
import { PATCH_SCHEMA } from "../../prompts/schemas.js";
import { applyEdits } from "../applyEdits.js";
import { promptTBFromVerifyFail } from "../../prompts/verify.js";
import { promptTestReviewFix } from "../../prompts/testReview.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { detectImplausibleArtifact } from "../fixLoopHelpers.js";
import { fixDescsFrom } from "../triageMemory.js";
import { resolveAvoidSectionRanked } from "../errorsToAvoid.js";
import { shippedRuleRecords } from "../knowledgePacks.js";
import { maybeRepair, maybeRepairWithLog } from "../syntaxRepair.js";
import { CODE_SCHEMA } from "../../prompts/schemas.js";
import { createLogger } from "../log.js";
import {
  resolveBestOfN, resolveBestOfNTemp, diversityConfig, summarizeLint,
  runBestOfN, bestOfNMeta, RANK_CRITERIA,
} from "../bestOfN.js";

export async function testGenerateNode(st) {
  const ci = st._childInterfaces || [];
  const ctx = st._fixContext;
  const rtlCode = (st.rtl_generate && st.rtl_generate.code) || "";
  // Cross-run "errors to avoid" (#26–28) + bundled trained-knowledge packs
  // (Path B), both opt-in. Empty on both → cold promptTB is byte-identical.
  const _cfg = st._config || {};
  const _harvestTb = (st._services && st._services.errorMemory) ? st._services.errorMemory.all() : [];
  // Ranked by similarity to this design's description when an embedder
  // service is wired (config.embedModel); count-ordered otherwise.
  const _embedSvc = st._services && st._services.embedder;
  const _avoidTb = await resolveAvoidSectionRanked(
    _cfg, _harvestTb, shippedRuleRecords(_cfg), "tb", st._userDesc, _embedSvc ? _embedSvc.embed : null);

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
      p = promptTBFromVerifyFail(prevTB, rtlCode, ctx.verifyResult, st.spec, st.elicit, prevFixes, null, ctx.attemptHistory, ctx.priorRecipes, ctx.diagnosis);
      stageLabel = "test_generate@fix:verify";
    } else if (ctx.source === "test_review" && ctx.reviewResult) {
      p = promptTestReviewFix(prevTB, rtlCode, ctx.reviewResult, st.spec, st.elicit);
      stageLabel = "test_generate@fix:test_review";
    } else if (ctx.source === "judge" && ctx.verifyResult) {
      p = promptTBFromVerifyFail(prevTB, rtlCode, ctx.verifyResult, st.spec, st.elicit, prevFixes, null, ctx.attemptHistory, ctx.priorRecipes, ctx.diagnosis);
      stageLabel = "test_generate@fix:judge-via-verify";
    } else {
      // Source we don't have a TB fix prompt for → cold regen
      p = promptTB(rtlCode, st.spec, st.elicit, ci, _avoidTb, st._config.tbArchitecture, st._sharedPackageCode);
      isColdGen = true;
    }
  } else {
    p = promptTB(rtlCode, st.spec, st.elicit, ci, _avoidTb, st._config.tbArchitecture, st._sharedPackageCode);
    isColdGen = true;
  }

  p = await applySkillsToPrompt(p, st, "test_generate");
  const _sc = getStageConfig(st._config, "test_generate");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  p.jsonSchema = CODE_SCHEMA;   // structured outputs (roadmap #1)
  addRetryHint(p, st._lastError);

  // Patch-mode (gated fixPatchMode) for the CHAIN's informed verify/judge TB
  // fixes — run 28's regression WAS this path: a full-file TB rewrite that
  // quietly added a ref_dout staging flop. Exact-match edits against the
  // previous TB; fail-closed to ONE full-file ask (_pFull).
  let _pFull = null;
  let _patchBase = null;
  if (!isColdGen && st._config.fixPatchMode
      && ctx && (ctx.source === "verify" || (ctx.source === "judge" && ctx.verifyResult))) {
    const pm = patchModeFixPrompt(p);
    if (pm._patchMode) {
      _pFull = p;
      pm.jsonSchema = PATCH_SCHEMA;
      p = pm;
      _patchBase = ctx.previousCode || (st.test_generate && st.test_generate.code) || "";
    }
  }

  // ── Best-of-N cold generation (#17) ──
  const _N = isColdGen ? resolveBestOfN(st._config) : 1;
  if (_N >= 2 && st._config && st._config.backendUrl) {
    return await generateTBBestOfN(st, p, _sc, _N, stageLabel, rtlCode);
  }

  // callLLMJson = callLLM + extractJSON + one hinted re-ask on parse failure.
  let jr = await callLLMJson(p);
  let d = jr.data;
  let allJrLlms = jr.llms;
  if (p._patchMode) {
    const _ap = applyEdits(_patchBase, d && d.edits);
    if (_ap.ok) {
      if (st._onLog) st._onLog("Patch mode (" + stageLabel + "): " + _ap.applied + " edit(s) applied cleanly.\n");
      d = { code: _ap.code, fixes: (d.fixes || []).map(function(f) { return { test: f.test || f.id || "", desc: f.desc || "" }; }) };
    } else {
      if (st._onLog) st._onLog("Patch mode fallback (" + stageLabel + "): " + _ap.failReason + " — re-asking for the full file.\n");
      jr = await callLLMJson(_pFull);
      d = jr.data;
      allJrLlms = allJrLlms.concat(jr.llms);
    }
  }
  // Implausible-artifact guard, COLD GENERATION only (measured, run 9:
  // reasoning-token exhaustion made the model echo the JSON template and the
  // literal string "<complete testbench source>" shipped as the TB with a ✓ —
  // the next 2+ hours measured a placeholder). Cold gen is the one path with
  // no downstream adoption guard; fix-path outputs are vetted at their
  // adoption sites (gutted/infra-loss/lint gates). One corrective re-ask,
  // then an HONEST halt: there is no artifact to proceed with.
  if (isColdGen && detectImplausibleArtifact(d.code || allJrLlms[allJrLlms.length - 1].text)) {
    if (st._onLog) st._onLog("↻ COMPLETE-SOURCE RE-ASK (test_generate)\n"
      + "The output carried no usable SystemVerilog in its code field — re-asking for the complete testbench source.");
    const p2 = Object.assign({}, p, {
      userMessage: (p.userMessage || "") + "\n\n━━ COMPLETE-SOURCE REQUIREMENT ━━\n"
        + "Return the COMPLETE testbench source — a full `module …_tb; … endmodule` — as the "
        + "value of the JSON \"code\" field. Every line of the testbench appears literally in that field.",
    });
    jr = await callLLMJson(p2);
    d = jr.data;
    allJrLlms = allJrLlms.concat(jr.llms);
    if (detectImplausibleArtifact(d.code || jr.llms[jr.llms.length - 1].text)) {
      throw new Error("test_generate produced no usable testbench (empty or placeholder code field) "
        + "after a corrective re-ask — halting honestly instead of shipping it. "
        + "Resume when the model is healthy (this run measured reasoning-token exhaustion).");
    }
  }
  const lastText = jr.llms[jr.llms.length - 1].text;
  const _llms = allJrLlms.map(function(r) { return Object.assign({ stage: stageLabel }, r); });
  const _llm = _llms[_llms.length - 1];
  // Opt-in deterministic syntax repair (docs/syntax-repair.md) — the mid-block
  // declaration hoist targets this node's dominant measured failure.
  const _rep = maybeRepairWithLog(st._config, d.code || lastText, createLogger(st._onLog, "thin"));
  const out = {
    test_generate: { code: _rep.code, _llms: _llms },
    _llm: _llm,
    _llms: _llms,
  };
  if (_rep.fixes) out.test_generate._syntaxRepairs = _rep.fixes;
  // Recipe raw material — the fixer's own minimal-change descriptions; judge
  // records them as a cross-run fix recipe on measured improvement.
  if (!isColdGen && d && Array.isArray(d.fixes) && d.fixes.length > 0) {
    out.test_generate._fixDescs = fixDescsFrom(d.fixes);
  }
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
  const moduleName = (st.elicit && st.elicit.modName) || st._modName || "module";
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
      // Rank on the POST-repair TB (opt-in) — selection consistent with what ships.
      const res = await runCli(st._config.backendUrl, {
        command: tbLintCmd, files: { [rtlFileName]: rtlCode, [tbFileName]: maybeRepair(st._config, code).code },
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
  const _rep = maybeRepairWithLog(st._config, winner.code, appendLog);
  const outBo = {
    test_generate: { code: _rep.code, _llms: runningLlms.slice(), _bestOfN: meta },
    _genLlmsTb: runningLlms.slice(),
    _llm: _llm,
    _llms: runningLlms.slice(),
  };
  if (_rep.fixes) outBo.test_generate._syntaxRepairs = _rep.fixes;
  return outBo;
}
