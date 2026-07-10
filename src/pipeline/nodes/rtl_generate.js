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
import { runCli, parseCLIOutput, CliBackendError } from "../../cli/index.js";
import { promptRTL, stripFindingEchoes } from "../../prompts/index.js";
import { promptRTLFix } from "../../prompts/lint.js";
import { promptRTLFromVerifyFail } from "../../prompts/verify.js";
import { promptRTLReviewFix } from "../../prompts/rtlReview.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { resolveAvoidSection, buildRuleIndex } from "../errorsToAvoid.js";
import { shippedRuleRecords } from "../knowledgePacks.js";
import { repairRtlCandidate, detectImplausibleArtifact } from "../fixLoopHelpers.js";
import { CODE_SCHEMA } from "../../prompts/schemas.js";
import { createLogger } from "../log.js";
import {
  resolveBestOfN, resolveBestOfNTemp, diversityConfig, summarizeLint,
  runBestOfN, bestOfNMeta, RANK_CRITERIA,
} from "../bestOfN.js";

export async function rtlGenerateNode(st) {
  const ci = st._childInterfaces || [];
  // Cross-run "errors to avoid" (#26–28) + bundled trained-knowledge packs
  // (Path B), both opt-in. Shipped packs auto-enable for the active model; the
  // harvested catalog is scoped by the same model filter. Empty on both → cold
  // promptRTL is byte-identical to before.
  const _cfg = st._config || {};
  const _harvestRtl = (st._services && st._services.errorMemory) ? st._services.errorMemory.all() : [];
  const _shippedRtl = shippedRuleRecords(_cfg);
  const _avoidRtl = resolveAvoidSection(_cfg, _harvestRtl, _shippedRtl, "rtl");
  // Trained-rule index for the informed-fix path: the fixer prefers a model-
  // rewritten / curated rule for a finding's class over the static table.
  const _ruleIndex = buildRuleIndex(_cfg, _harvestRtl, _shippedRtl, "rtl");
  const ctx = st._fixContext;

  // Informed-fix branch.
  let p;
  let stageLabel = "rtl_generate";
  // Best-of-N applies to COLD generation only; every informed-fix branch below
  // stays single-shot. Tracks which prompt we ended up using.
  let isColdGen = false;
  if (ctx && typeof ctx === "object" && ctx.source) {
    const prev = ctx.previousCode || (st.rtl_generate && st.rtl_generate.code) || "";
    const prevFixes = Array.isArray(ctx.previousFixes) ? ctx.previousFixes : [];
    if (ctx.source === "lint" && ctx.lintResult) {
      p = promptRTLFix(prev, ctx.lintResult, st.elicit, prevFixes, null, _ruleIndex);
      stageLabel = "rtl_generate@fix:lint";
    } else if (ctx.source === "verify" && ctx.verifyResult) {
      p = promptRTLFromVerifyFail(prev, ctx.verifyResult, st.spec, st.elicit, prevFixes);
      stageLabel = "rtl_generate@fix:verify";
    } else if (ctx.source === "rtl_review" && ctx.reviewResult) {
      p = promptRTLReviewFix(prev, ctx.reviewResult, st.spec, st.elicit);
      stageLabel = "rtl_generate@fix:rtl_review";
    } else if (ctx.source === "integration" && Array.isArray(ctx.findings) && ctx.findings.length > 0) {
      // S3 integration reflow: the SYSTEM pipeline attributed a failure to
      // this module. Repair against that evidence — a cold regen from the
      // same spec would likely reproduce the same code and change-detection
      // would then skip re-integration, leaving the failure standing.
      const synthLint = {
        errors: ctx.findings.map(function(f) {
          return { code: f.type || "INTEGRATION", msg: "[system integration] " + (f.msg || String(f)) };
        }),
        warnings: [],
      };
      p = promptRTLFix(prev, synthLint, st.elicit, prevFixes);
      stageLabel = "rtl_generate@fix:integration";
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
      p = promptRTL(st.architect, st.spec, st.elicit, ci, st._sharedPackageCode || null, _avoidRtl);
      isColdGen = true;
    }
  } else {
    p = promptRTL(st.architect, st.spec, st.elicit, ci, st._sharedPackageCode || null, _avoidRtl);
    isColdGen = true;
  }

  p = await applySkillsToPrompt(p, st, "rtl_generate");
  const _sc = getStageConfig(st._config, "rtl_generate");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  p.jsonSchema = CODE_SCHEMA;   // structured outputs (roadmap #1)
  addRetryHint(p, st._lastError);

  // ── Best-of-N cold generation (#17) ──
  // Active only for COLD generation with a backend (the Verilator selector) and
  // bestOfN >= 2. Otherwise this is the single-shot path below, byte-identical.
  const _N = isColdGen ? resolveBestOfN(st._config) : 1;
  if (_N >= 2 && st._config && st._config.backendUrl) {
    return await generateBestOfN(st, p, _sc, _N, stageLabel);
  }

  // callLLMJson = callLLM + extractJSON + one hinted re-ask on parse failure.
  let jr = await callLLMJson(p);
  let d = jr.data;
  let allJrLlms = jr.llms;
  // Implausible-artifact guard, COLD GENERATION only — mirror of
  // test_generate (measured there, run 9): a template-echo/placeholder code
  // field gets one corrective re-ask, then an honest halt. Fix-path outputs
  // are vetted at their adoption sites instead.
  if (isColdGen && detectImplausibleArtifact(d.code || allJrLlms[allJrLlms.length - 1].text)) {
    if (st._onLog) st._onLog("↻ COMPLETE-SOURCE RE-ASK (rtl_generate)\n"
      + "The output carried no usable SystemVerilog in its code field — re-asking for the complete module source.");
    const p2 = Object.assign({}, p, {
      userMessage: (p.userMessage || "") + "\n\n━━ COMPLETE-SOURCE REQUIREMENT ━━\n"
        + "Return the COMPLETE module source — a full `module …; … endmodule` — as the value of "
        + "the JSON \"code\" field. Every line of the design appears literally in that field.",
    });
    jr = await callLLMJson(p2);
    d = jr.data;
    allJrLlms = allJrLlms.concat(jr.llms);
    if (detectImplausibleArtifact(d.code || jr.llms[jr.llms.length - 1].text)) {
      throw new Error("rtl_generate produced no usable module (empty or placeholder code field) "
        + "after a corrective re-ask — halting honestly instead of shipping it.");
    }
  }
  const lastText = jr.llms[jr.llms.length - 1].text;
  const _llms = allJrLlms.map(function(r) { return Object.assign({ stage: stageLabel }, r); });
  const _llm = _llms[_llms.length - 1];
  // Echo guard: informed-fix paths hand the model a findings block, and a
  // weak model can paste it into the code (measured live — every echoed line
  // became a syntax error). The format is ours, never legal SV — strip it.
  const _deEchoed = stripFindingEchoes(d.code || lastText).code;
  // Opt-in deterministic syntax repair (docs/syntax-repair.md): mechanical
  // fixes before first lint, so the fix loop starts from clean-of-the-obvious.
  const _rep = repairRtlCandidate(st._config, _deEchoed, createLogger(st._onLog, "thin"));
  const out = {
    rtl_generate: { code: _rep.code, _llms: _llms },
    _llm: _llm,
    _llms: _llms,
  };
  if (_rep.fixes) out.rtl_generate._syntaxRepairs = _rep.fixes;
  // Durable cold-generation ledger — survives the StateGraph shallow-merge that
  // clobbers rtl_generate._llms when downstream stages rewrite { code }. Set on
  // cold gen only (see docs/best-of-n.md) so it stays a stable generation-cost
  // measure even when rtl_generate re-runs as a reflow triage entry.
  if (isColdGen) out._genLlmsRtl = _llms;
  return out;
}

/**
 * Draw N candidate RTLs (candidate 0 greedy, 1..N-1 exploring), lint each with
 * Verilator, and keep the one that elaborates cleanest (rankCandidates). All
 * orchestration lives in the pure runBestOfN; this adapter wires in callLLMJson
 * + runCli and the run-budget gate.
 */
async function generateBestOfN(st, p, _sc, n, stageLabel) {
  const temp = resolveBestOfNTemp(st._config);
  const moduleName = (st.elicit && st.elicit.modName) || "module";
  const rtlFileName = moduleName + ".sv";
  const lintCmd = (st._config.lintCmd || "verilator --lint-only -Wall {RTL}")
    .replace("{RTL}", rtlFileName);
  const _cliOpts = {
    retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
    timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
    logger:    st._logger || null,
  };
  const _strictCli = (st._config.strictCli !== false) && !!st._config.backendUrl;
  const appendLog = createLogger(st._onLog, "thin");
  appendLog("Best-of-" + n + " RTL generation", "Drawing " + n
    + " candidates (candidate 0 greedy, rest @ temp " + temp + "), selecting the cleanest elaboration…");

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
      // Rank candidates on their POST-repair lint (opt-in): selection must be
      // consistent with what actually ships — a candidate whose only errors
      // are mechanically repairable should outrank one with a real defect.
      const res = await runCli(st._config.backendUrl, {
        command: lintCmd, files: { [rtlFileName]: repairRtlCandidate(st._config, code).code },
      }, st._signal, _cliOpts);
      if (res && res._error) {
        if (_strictCli) throw new CliBackendError(res._msg, res._attempts || 1);
        return null; // can't evaluate this candidate — ranks worst
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
          : (l.compiles ? "elaborates" : "does NOT elaborate")
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
  const _rep = repairRtlCandidate(st._config, winner.code, appendLog);
  const outBo = {
    rtl_generate: { code: _rep.code, _llms: runningLlms.slice(), _bestOfN: meta },
    _genLlmsRtl: runningLlms.slice(),
    _llm: _llm,
    _llms: runningLlms.slice(),
  };
  if (_rep.fixes) outBo.rtl_generate._syntaxRepairs = _rep.fixes;
  return outBo;
}
