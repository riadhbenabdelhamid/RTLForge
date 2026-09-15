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
import { withSharedPackage, cmdWithFiles, childRtlFiles } from "../cliFiles.js";
import { promptRTL, promptStandaloneRTL, promptStandaloneTB, stripFindingEchoes } from "../../prompts/index.js";
import { qualifyStandaloneChecker } from "../qualifyStandaloneChecker.js";
import { promptRTLFix, patchModeFixPrompt } from "../../prompts/lint.js";
import { PATCH_SCHEMA } from "../../prompts/schemas.js";
import { applyEdits } from "../applyEdits.js";
import { promptRTLFromVerifyFail } from "../../prompts/verify.js";
import { promptRTLReviewFix } from "../../prompts/rtlReview.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { resolveAvoidSectionRanked, buildRuleIndex } from "../errorsToAvoid.js";
import { shippedRuleRecords } from "../knowledgePacks.js";
import { repairRtlCandidate, detectImplausibleArtifact, formalEvidenceOf } from "../fixLoopHelpers.js";
import { maybeRepair } from "../syntaxRepair.js";
import { fixDescsFrom } from "../triageMemory.js";
import { CODE_SCHEMA } from "../../prompts/schemas.js";
import { createLogger } from "../log.js";
import { extractModuleInterface } from "../../utils/svInterface.js";
import { extractRTLInterface } from "../../utils/interfaceContract.js";
import {
  resolveBestOfN, resolveBestOfNTemp, diversityConfig, summarizeLint,
  runBestOfN, bestOfNMeta, RANK_CRITERIA,
} from "../bestOfN.js";

function requiredExportedName(st) {
  const name = st && st._config && st._config.requiredModuleName;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function assertRequiredExportedName(st, code, where) {
  const required = requiredExportedName(st);
  if (!required) return;
  const actual = extractRTLInterface(code, required);
  if (!actual || actual.moduleName !== required) {
    throw new Error((where || "rtl_generate") + " produced exported RTL module name \""
      + String(actual && actual.moduleName || "") + "\"; requiredModuleName is \""
      + required + "\". Refusing to rename or ship the candidate.");
  }
}

export async function rtlGenerateNode(st) {
  const ci = st._childInterfaces || [];
  // Cross-run "errors to avoid" (#26–28) + bundled trained-knowledge packs
  // (Path B), both opt-in. Shipped packs auto-enable for the active model; the
  // harvested catalog is scoped by the same model filter. Empty on both → cold
  // promptRTL is byte-identical to before.
  const _cfg = st._config || {};
  const _harvestRtl = (st._services && st._services.errorMemory) ? st._services.errorMemory.all() : [];
  const _shippedRtl = shippedRuleRecords(_cfg);
  // With an embedder service wired (config.embedModel), harvested lessons are
  // ranked by similarity to THIS design's description; without one this is the
  // count-ordered section, byte-identical to before.
  const _embedSvc = st._services && st._services.embedder;
  const _avoidRtl = await resolveAvoidSectionRanked(
    _cfg, _harvestRtl, _shippedRtl, "rtl", st._userDesc, _embedSvc ? _embedSvc.embed : null);
  // Trained-rule index for the informed-fix path: the fixer prefers a model-
  // rewritten / curated rule for a finding's class over the static table.
  const _ruleIndex = buildRuleIndex(_cfg, _harvestRtl, _shippedRtl, "rtl");
  const ctx = st._fixContext;
  const standaloneEnabled = _cfg.standaloneFallback === true
    || (_cfg.standaloneFallback && typeof _cfg.standaloneFallback === "object");
  // A standalone candidate is generated once from the raw user description
  // and then carried through reflows.  It never sees the derived spec,
  // architecture, RTL, TB, findings, or any benchmark artifact.
  let standaloneCandidate = st.rtl_generate && st.rtl_generate._standaloneCandidate
    ? st.rtl_generate._standaloneCandidate : null;
  // Revalidate a carried candidate as well as a newly generated one. This
  // keeps old checkpoints from bypassing a newly configured exported-name
  // contract and records an honest unavailable candidate instead of renaming
  // it or comparing it under the wrong top-level module.
  const _requiredStandaloneName = requiredExportedName(st);
  if (standaloneCandidate && standaloneCandidate.code && _requiredStandaloneName) {
    const carriedActual = extractRTLInterface(standaloneCandidate.code, _requiredStandaloneName);
    if (!carriedActual || carriedActual.moduleName !== _requiredStandaloneName) {
      standaloneCandidate = Object.assign({}, standaloneCandidate, {
        status: "ERROR",
        error: "standalone candidate exported module \""
          + String(carriedActual && carriedActual.moduleName || "")
          + "\" but requiredModuleName is \"" + _requiredStandaloneName + "\"",
      });
    }
  }
  let standaloneLlms = [];
  // The independent checker is created alongside the standalone RTL, before
  // formal verification and before the pipeline testbench can influence any
  // comparison.  test_generate reuses this frozen record through reflows.
  let standaloneChecker = st.rtl_generate && st.rtl_generate._standaloneCheckerCandidate
    ? st.rtl_generate._standaloneCheckerCandidate : null;
  let standaloneCheckerLlms = [];
  const standaloneCallMeta = function(call) {
    return {
      stage: call && call.stage || "rtl_generate@standalone",
      model: call && call.model || "",
      provider: call && call.provider || "",
      tokensIn: call && call.tokensIn || 0,
      tokensOut: call && call.tokensOut || 0,
      latencyMs: call && call.latencyMs || 0,
      stopReason: call && call.stopReason || null,
    };
  };

  // A checker is never trusted merely because it parsed as SystemVerilog. The
  // bounded review is on by default whenever standalone fallback is enabled;
  // an explicit false keeps the source for audit but makes the comparison
  // UNVERIFIED without silently comparing candidates.

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
      p = promptRTLFromVerifyFail(prev, ctx.verifyResult, st.spec, st.elicit, prevFixes, null, ctx.attemptHistory, ctx.priorRecipes, ctx.diagnosis, ctx.formalEvidence || formalEvidenceOf(st));
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
        p = promptRTLFromVerifyFail(prev, ctx.verifyResult, st.spec, st.elicit, prevFixes, null, ctx.attemptHistory, ctx.priorRecipes, ctx.diagnosis, ctx.formalEvidence || formalEvidenceOf(st));
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

  if (standaloneEnabled && isColdGen && !standaloneCandidate
      && String(st._userDesc || "").trim()) {
    const standalonePrompt = promptStandaloneRTL(
      st._userDesc,
      requiredExportedName(st) || (st.elicit && st.elicit.modName) || st._modName || "module");
    standalonePrompt.config = _sc;
    standalonePrompt.maxTokens = _sc._maxTokens;
    standalonePrompt.jsonSchema = CODE_SCHEMA;
    standalonePrompt.onChunk = st._onLog;
    try {
      const sr = await callLLMJson(standalonePrompt);
      standaloneLlms = sr.llms.map(function(r) {
        return Object.assign({ stage: "rtl_generate@standalone" }, r);
      });
      const raw = (sr.data && sr.data.code) || "";
      if (!raw || detectImplausibleArtifact(raw)) {
        standaloneCandidate = {
          status: "ERROR",
          error: "standalone candidate was empty or not a complete module",
          calls: standaloneLlms.map(standaloneCallMeta),
        };
      } else {
        const repaired = repairRtlCandidate(st._config, raw);
        const required = requiredExportedName(st);
        const actual = extractRTLInterface(repaired.code, required);
        standaloneCandidate = (!required || (actual && actual.moduleName === required))
          ? {
              status: "READY",
              code: repaired.code,
              rawCode: raw,
              syntaxRepairs: repaired.fixes || [],
              source: "original-description",
              calls: standaloneLlms.map(standaloneCallMeta),
            }
          : {
              status: "ERROR",
              error: "standalone candidate exported module \"" + String(actual && actual.moduleName || "")
                + "\" but requiredModuleName is \"" + required + "\"",
              calls: standaloneLlms.map(standaloneCallMeta),
            };
      }
    } catch (e) {
      standaloneLlms = (e && Array.isArray(e.llms) ? e.llms : []).map(function(r) {
        return Object.assign({ stage: "rtl_generate@standalone" }, r);
      });
      standaloneCandidate = {
        status: "ERROR",
        error: String(e && e.message || e),
        calls: standaloneLlms.map(standaloneCallMeta),
      };
      if (st._onLog) st._onLog("⚠ Standalone candidate unavailable: " + standaloneCandidate.error + "\n");
    }
  }

  if (standaloneEnabled && standaloneCandidate && standaloneCandidate.code
      && !standaloneChecker && String(st._userDesc || "").trim()) {
    const checkerPrompt = promptStandaloneTB(
      st._userDesc,
      extractModuleInterface(standaloneCandidate.code,
        requiredExportedName(st) || (st.elicit && st.elicit.modName) || st._modName || "module"),
      requiredExportedName(st) || (st.elicit && st.elicit.modName) || st._modName || "module");
    checkerPrompt.config = _sc;
    checkerPrompt.maxTokens = _sc._maxTokens;
    checkerPrompt.jsonSchema = CODE_SCHEMA;
    checkerPrompt.onChunk = st._onLog;
    try {
      const cr = await callLLMJson(checkerPrompt);
      standaloneCheckerLlms = cr.llms.map(function(r) {
        return Object.assign({ stage: "test_generate@standalone" }, r);
      });
      const rawChecker = (cr.data && cr.data.code) || "";
      if (!rawChecker || detectImplausibleArtifact(rawChecker)) {
        standaloneChecker = {
          status: "ERROR",
          error: "standalone checker was empty or not a complete testbench",
          calls: standaloneCheckerLlms.map(standaloneCallMeta),
        };
      } else {
        const repairedChecker = maybeRepair(st._config, rawChecker);
        standaloneChecker = {
          status: "READY",
          code: repairedChecker.code,
          rawCode: rawChecker,
          syntaxRepairs: repairedChecker.fixes || [],
          source: "original-description-interface",
          calls: standaloneCheckerLlms.map(standaloneCallMeta),
        };
      }
      if (standaloneChecker && standaloneChecker.code) {
        standaloneChecker = await qualifyStandaloneChecker(
          standaloneChecker,
          extractModuleInterface(standaloneCandidate.code,
            requiredExportedName(st) || (st.elicit && st.elicit.modName) || st._modName || "module"),
          requiredExportedName(st) || (st.elicit && st.elicit.modName) || st._modName || "module",
          st, _sc, standaloneCheckerLlms);
      }
    } catch (e) {
      standaloneCheckerLlms = (e && Array.isArray(e.llms) ? e.llms : []).map(function(r) {
        return Object.assign({ stage: "test_generate@standalone" }, r);
      });
      standaloneChecker = {
        status: "ERROR",
        error: String(e && e.message || e),
        calls: standaloneCheckerLlms.map(standaloneCallMeta),
      };
      if (st._onLog) st._onLog("⚠ Standalone checker unavailable: " + standaloneChecker.error + "\n");
    }
  }

  // Patch-mode (gated fixPatchMode) for the CHAIN's informed verify/judge
  // fixes — this node is where reflow chains regenerate RTL, and run 28
  // showed the full-file rewrites here are where drive-by regressions ride
  // in. Exact-match edits against the previous code; a non-applying edit
  // set falls back to ONE full-file ask (_pFull, today's behavior).
  let _pFull = null;
  let _patchBase = null;
  if (!isColdGen && st._config.fixPatchMode
      && ctx && (ctx.source === "verify" || (ctx.source === "judge" && ctx.verifyResult))) {
    const pm = patchModeFixPrompt(p);
    if (pm._patchMode) {
      _pFull = p;
      pm.jsonSchema = PATCH_SCHEMA;
      p = pm;
      _patchBase = ctx.previousCode || (st.rtl_generate && st.rtl_generate.code) || "";
    }
  }

  // ── Best-of-N cold generation (#17) ──
  // Active only for COLD generation with a backend (the Verilator selector) and
  // bestOfN >= 2. Otherwise this is the single-shot path below, byte-identical.
  const _N = isColdGen ? resolveBestOfN(st._config) : 1;
  if (_N >= 2 && st._config && st._config.backendUrl) {
    const bestOut = await generateBestOfN(st, p, _sc, _N, stageLabel);
    if (standaloneCandidate) bestOut.rtl_generate._standaloneCandidate = standaloneCandidate;
    if (standaloneChecker) bestOut.rtl_generate._standaloneCheckerCandidate = standaloneChecker;
    if (standaloneLlms.length) {
      bestOut.rtl_generate._standaloneLlms = standaloneLlms.map(standaloneCallMeta);
      bestOut._standaloneLlms = standaloneLlms.map(standaloneCallMeta);
    }
    if (standaloneCheckerLlms.length) {
      bestOut.rtl_generate._standaloneCheckerLlms = standaloneCheckerLlms.map(standaloneCallMeta);
      bestOut._standaloneCheckerLlms = standaloneCheckerLlms.map(standaloneCallMeta);
    }
    bestOut._llms = standaloneCheckerLlms.concat(standaloneLlms).concat(bestOut._llms || []);
    return bestOut;
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
  assertRequiredExportedName(st, _rep.code, stageLabel);
  const out = {
    rtl_generate: { code: _rep.code, _llms: _llms },
    _llm: _llm,
    _llms: standaloneCheckerLlms.concat(standaloneLlms).concat(_llms),
  };
  if (standaloneCandidate) {
    out.rtl_generate._standaloneCandidate = standaloneCandidate;
    if (standaloneLlms.length) out.rtl_generate._standaloneLlms = standaloneLlms.map(standaloneCallMeta);
  }
  if (standaloneChecker) {
    out.rtl_generate._standaloneCheckerCandidate = standaloneChecker;
    if (standaloneCheckerLlms.length) out.rtl_generate._standaloneCheckerLlms = standaloneCheckerLlms.map(standaloneCallMeta);
  }
  if (standaloneLlms.length) out._standaloneLlms = standaloneLlms.map(standaloneCallMeta);
  if (standaloneCheckerLlms.length) out._standaloneCheckerLlms = standaloneCheckerLlms.map(standaloneCallMeta);
  if (_rep.fixes) out.rtl_generate._syntaxRepairs = _rep.fixes;
  // Informed-fix paths return a `fixes` array (the model's own minimal-change
  // descriptions). Surface them as recipe raw material: judge records them as
  // a cross-run fix recipe when the attempt measurably improves the score.
  if (!isColdGen && d && Array.isArray(d.fixes) && d.fixes.length > 0) {
    out.rtl_generate._fixDescs = fixDescsFrom(d.fixes);
  }
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
  const moduleName = (st.elicit && st.elicit.modName) || st._modName || "module";
  const rtlFileName = moduleName + ".sv";
  const lintTemplate = st._config.lintCmd || "verilator --lint-only -Wall {RTL}";
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
      assertRequiredExportedName(st, code, "rtl_generate@bestof" + i);
      const llms = jr.llms.map(function (r) { return Object.assign({ stage: stageLabel + "@bestof" + i }, r); });
      for (let k = 0; k < llms.length; k++) runningLlms.push(llms[k]);
      return { code: code, llms: llms };
    },
    lintCode: async function (code) {
      // Rank candidates on their POST-repair lint (opt-in): selection must be
      // consistent with what actually ships — a candidate whose only errors
      // are mechanically repairable should outrank one with a real defect.
      //
      // Rank against the SAME file set the module ships with: in a system run
      // the candidate imports the shared package and instantiates its
      // children, so linting it alone fails every candidate identically on
      // "Import package not found" and the ranking degenerates to noise.
      const _rankFiles = withSharedPackage(
        Object.assign(childRtlFiles(st._childInterfaces),
                      { [rtlFileName]: repairRtlCandidate(st._config, code).code }),
        st._sharedPackageCode);
      const res = await runCli(st._config.backendUrl, {
        command: cmdWithFiles(lintTemplate, _rankFiles.order, rtlFileName),
        files: _rankFiles.files,
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
  assertRequiredExportedName(st, _rep.code, "rtl_generate@bestof winner");
  const outBo = {
    rtl_generate: { code: _rep.code, _llms: runningLlms.slice(), _bestOfN: meta },
    _genLlmsRtl: runningLlms.slice(),
    _llm: _llm,
    _llms: runningLlms.slice(),
  };
  if (_rep.fixes) outBo.rtl_generate._syntaxRepairs = _rep.fixes;
  return outBo;
}
