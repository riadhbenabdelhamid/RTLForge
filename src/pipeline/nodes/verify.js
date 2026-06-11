// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/verify — Stage 8: Simulation Verification with Iterative Fix Loop
//
// Mirror of the lint node, but for simulation results:
//
//   1. Try the real CLI backend (Verilator + sim commands), fall back to
//      LLM-estimated verify via promptVerify.
//   2. Iteratively fix RTL and/or testbench (up to MAX_VERIFY_ITERS).
//   3. Triage routing: each failed iteration calls promptVerifyTriage to
//      classify root cause as test_generate / rtl_generate / spec.
//      The triage decision drives whether to fix RTL, TB, or both.
//   4. Classifier-gated validation via classifyTestResults against the
//      ORIGINAL BASELINE test results (not just previous iter).
//   5. Best-known state tracking by score = pass - 2*fail.
//   6. Stagnation detection: same pass/fail signature → break.
//   7. Cov-warning gate: if config.verifyWarningsAsErrors and line<80% or
//      branch<70%, treat as failed even when all tests pass.
//
// Result delta:
//   verify       — final verify report with .verifyHistory[]
//   rtl_generate — { code, _originalCode?, _fixSource? }
//   test_generate — { code, _originalCode?, _fixSource? }
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { runCli, CliBackendError, parseTestLine, parseCoverageDat } from "../../cli/index.js";
import { classifyTestResults } from "../classifiers.js";
import { createLogger } from "../log.js";
import { parseCoversAnnotations, attributeTestToReq } from "../coversParser.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { tagFixes, createCodeChurnTracker } from "../fixLoopHelpers.js";
// Per-stage K-to-X reflow: when verify's iteration decides RTL or TB needs
// regenerating, the chain runs rtl_generate → rtl_review → lint → formal_props
// → test_generate → test_review → lint_test → verify instead of inline
// promptRTLFromVerifyFail / promptTBFromVerifyFail calls. The triage target
// picked by promptVerifyTriage becomes the chain's regen entry point.
import { planStageReflow } from "../reflowPlanner.js";
import { runReflowChain, resolveReflowMode } from "../reflowRunner.js";
import { getReflowTail } from "../../constants/stages.js";
// SVA-in-simulation: bind the formal_props properties into the Verilator
// build so they're actually checked at runtime. See svaBind.js for the full
// rationale, the safety filter, and the compile-failure fallback contract.
import { buildSvaChecker, injectVerilatorFlag, svaCompileFailed } from "../svaBind.js";
import {
  promptVerify,
  promptVerifyTriage,
  promptRTLFromVerifyFail,
  promptTBFromVerifyFail,
} from "../../prompts/index.js";

export async function verifyNode(st) {
  const allLlms = [];
  const verifyHistory = [];
  let finalVerify = null;
  const originalRTL = (st.rtl_generate || {}).code || "";
  const originalTB  = (st.test_generate || {}).code || "";
  let currentRTL = originalRTL;
  let currentTB  = originalTB;
  let bestRTL = currentRTL;
  let bestTB = currentTB;
  let bestVerify = null;
  let bestScore = -Infinity;
  let lastOutcomeSig = null;
  let stagnationCount = 0;
  // Candidate-churn tracker over (RTL, TB) PAIRS — catches A→B→A oscillation
  // across fix iterations before a wasted re-simulation (see
  // fixLoopHelpers.js). Seeded with the original pair so an exact revert to
  // the baseline also counts as a repeat.
  const churnTracker = createCodeChurnTracker();
  churnTracker.record(originalRTL + " " + originalTB, 0);
  const moduleName = (st.elicit && st.elicit.modName) || "module";
  const rtlFileName = moduleName + ".sv";
  const tbFileName = moduleName + "_tb.sv";

  // CLI robustness — retries / timeout / strict mode
  const _cliOpts = {
    retries:   (st._config.cliRetryCount == null ? 1 : st._config.cliRetryCount),
    timeoutMs: ((st._config.backendTimeoutSec || 600) * 1000),
    logger:    st._logger || null,   // surfaces CLI events in the Log panel
  };
  const _strictCli = (st._config.strictCli === true) && !!st._config.backendUrl;

  // Shared logger; verify uses thin single-line dividers (sections are longer
  // and less frequent than in lint).
  const appendLog = createLogger(st._onLog, "thin");

  async function runVerifyOnce(rtl, tb) {
    let cmds = (st._config.simCmds || "").split("\n").filter(function(c) { return c.trim(); });
    // Defensive: if user accidentally cleared simCmds, surface a clear error
    // rather than silently sending an empty command list to the backend.
    if (cmds.length === 0 && st._config.backendUrl) {
      const msg = "No simulation commands configured. Set Settings → CLI → Simulation Commands before running verify.";
      appendLog("⛔ Verify configuration error", msg);
      if (_strictCli) throw new CliBackendError(msg, 0);
      // Non-strict mode: fall through to LLM with a clear annotation
      let p = promptVerify(tb, rtl, st.spec);
      p = await applySkillsToPrompt(p, st, "verify");
      const _sc = getStageConfig(st._config, "verify");
      p.config = _sc;
      p.maxTokens = _sc._maxTokens;
      p.onChunk = function(t, m) { appendLog.stream("Verify (LLM)", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const r = await callLLM(p);
      allLlms.push(Object.assign({ stage: "verify" }, r));
      const vResult = extractJSON(r.text);
      vResult._cliError = msg;
      return vResult;
    }

    // When `enableCoverage` is on, ensure --coverage is in the
    // verilator compile step, and append a `verilator_coverage` post-step
    // so logs/coverage.dat is produced and (in newer Verilator versions)
    // a summary report is emitted. The check is idempotent — if the user
    // already has --coverage in their simCmds we leave them alone.
    if (st._config.enableCoverage) {
      cmds = cmds.map(function(c) {
        // Add --coverage to the verilator compile line (the one that
        // takes {RTL}{TB} and produces a binary). We detect it by the
        // presence of "verilator" + "--binary" or "-o " — the standard
        // template. Skip standalone verilator_coverage / runtime commands.
        const isCompile = /verilator(\s|$)/.test(c) &&
          /(--binary|--cc|--main|--exe|-o\s)/.test(c) &&
          !/verilator_coverage/.test(c);
        if (isCompile && !/--coverage/.test(c)) {
          return c.replace(/verilator(\s|$)/, "verilator --coverage$1");
        }
        return c;
      });
      // Append a verilator_coverage step if the user hasn't added one.
      // This produces a summary at logs/coverage.dat that the backend
      // harvests and verify-side parseCoverageDat reads.
      const hasCovStep = cmds.some(function(c) { return /verilator_coverage/.test(c); });
      if (!hasCovStep) {
        // verilator_coverage reads coverage.dat from logs/ and writes
        // a per-file summary back to logs/coverage_summary.txt. We
        // don't strictly need the summary — parseCoverageDat handles
        // raw coverage.dat — but running this step ensures coverage.dat
        // is in canonical form. Use 2>/dev/null to keep stderr clean.
        cmds.push("verilator_coverage --write logs/coverage.dat logs/coverage.dat 2>/dev/null || true");
      }
    }

    // ── SVA-in-simulation ──────────────────────────────────────────────────
    // Bind the formal_props properties into this build so Verilator checks
    // them at runtime (a violated assertion fails the sim and routes through
    // the normal fix loops). Opt out with config.svaInSim = false. The
    // checker is appended to the RTL file so user-customized simCmds keep
    // working unchanged; --assert is injected into the compile line so the
    // assertions actually fire (without it Verilator ignores them).
    const _svaEnabled = st._config.svaInSim !== false;
    const svaChecker = _svaEnabled
      ? buildSvaChecker(st.formal_props, st.spec, moduleName)
      : null;
    if (svaChecker) {
      appendLog("SVA → simulation",
        svaChecker.included.length + " propert" + (svaChecker.included.length === 1 ? "y" : "ies")
        + " bound into the build" + (svaChecker.skipped.length > 0
          ? " (" + svaChecker.skipped.length + " skipped):\n"
            + svaChecker.skipped.map(function(s) { return "  - " + s.id + ": " + s.reason; }).join("\n")
          : ""));
    }

    async function execCli(withSva) {
      const attemptCmds = withSva ? injectVerilatorFlag(cmds, "--assert") : cmds;
      const rtlPayload = withSva ? rtl + "\n" + svaChecker.text : rtl;
      return runCli(st._config.backendUrl, {
        commands: attemptCmds.map(function(c) { return c.replace("{RTL}", rtlFileName).replace("{TB}", tbFileName); }),
        files: { [rtlFileName]: rtlPayload, [tbFileName]: tb },
      }, st._signal, _cliOpts);
    }

    let _svaActive = !!svaChecker;
    let cliResult = await execCli(_svaActive);
    // Second safety net (the first is svaBind's identifier filter): if the
    // SVA-augmented build failed to COMPILE with errors naming the checker,
    // the generated property file is at fault — not the design. Retry the
    // build without SVA rather than failing a good design on a bad property.
    let _svaBindFailed = false;
    if (_svaActive && cliResult && !cliResult._error
        && svaCompileFailed(cliResult, svaChecker.checkerName)) {
      appendLog("⚠ SVA checker broke the build — retrying without it",
        "The generated property checker failed to compile (see log tail). "
        + "The build is retried without bound SVA; the properties remain "
        + "visible in the Formal Props stage for manual review.");
      _svaActive = false;
      _svaBindFailed = true;
      cliResult = await execCli(false);
    }
    let _verifyCliError = null;
    if (cliResult && cliResult._error) {
      console.warn("[RTL Forge] CLI backend error (verify):", cliResult._msg, "(after " + (cliResult._attempts || 1) + " attempts)");
      _verifyCliError = cliResult._msg + " — after " + (cliResult._attempts || 1) + " attempt(s)";
      if (_strictCli) {
        appendLog("⛔ STRICT CLI MODE — failing", _verifyCliError + "\n\nDisable Strict CLI mode in Settings → CLI to allow LLM fallback.");
        throw new CliBackendError(_verifyCliError, cliResult._attempts || 1);
      }
      cliResult = null;
    }
    if (cliResult && cliResult.exitCode !== undefined) {
      const tests = [];
      // Build a task→req map from the testbench so we can attribute each
      // [PASS]/[FAIL] line to the requirement it covers.
      const coversMap = parseCoversAnnotations(tb);
      (cliResult.stdout || "").split("\n").forEach(function(l) {
        // Extract cycles + wall-time from the test line, falling back to plain
        // [PASS] x / [FAIL] x parsing when no metrics are present (cyc/ms = 0).
        const parsed = parseTestLine(l);
        if (!parsed) return;
        const req = attributeTestToReq(parsed.name, coversMap, tb);
        tests.push({
          name: parsed.name,
          st: parsed.status,
          cyc: parsed.cyc,
          ms:  parsed.ms,
          req: req,
        });
      });
      if (tests.length === 0 && cliResult.exitCode !== 0) {
        tests.push({ name: "compilation", st: "FAIL", cyc: 0, ms: 0 });
      }
      // A non-zero exit with ONLY [PASS] markers parsed means the sim died
      // abnormally after the last marker — e.g. a bound SVA assertion fired
      // (Verilator's $stop exits non-zero without printing a [FAIL] line),
      // or the process crashed mid-run. Surface it as a failing pseudo-test
      // so the eval gate can't read a truncated run as success. (A normal
      // TB failure exits non-zero WITH [FAIL] markers, so it never lands
      // here.)
      if (cliResult.exitCode !== 0 && tests.length > 0
          && tests.every(function(t) { return t.st === "PASS"; })) {
        tests.push({
          name: _svaActive ? "sva_assertion_or_abnormal_exit" : "abnormal_exit",
          st: "FAIL", cyc: 0, ms: 0,
        });
      }
      // If the CLI completed with exit 0 but produced no PASS/FAIL markers at
      // all, the testbench is missing its $display([PASS]/[FAIL]) lines.
      if (tests.length === 0 && cliResult.exitCode === 0) {
        appendLog("⚠ Verify warning",
          "Backend exited cleanly but no [PASS]/[FAIL] lines were found in stdout. " +
          "The testbench should print '[PASS] <name>' or '[FAIL] <name>' per check, " +
          "or your simCmds should be adjusted to invoke a self-checking flow.");
      }
      const pass = tests.filter(function(t) { return t.st === "PASS"; }).length;

      // Coverage extraction. The backend may attach logs/coverage.dat
      // (Verilator's coverage output) under several conventional keys, tried in
      // order:
      //   cliResult.coverage  — explicit field
      //   cliResult.files["logs/coverage.dat"] — generic file passthrough
      //   cliResult.artifacts["coverage.dat"]  — alt artifact map
      // parseCoverageDat understands both the '# COVERAGE: <kind> <pct>%'
      // summary lines and the raw bucket-record format; with no data every kind
      // stays 0.
      let covRaw = cliResult.coverage;
      if (typeof covRaw !== "string") {
        covRaw = (cliResult.files && (cliResult.files["logs/coverage.dat"]
          || cliResult.files["coverage.dat"]))
          || (cliResult.artifacts && cliResult.artifacts["coverage.dat"])
          || null;
      }
      const covParsed = parseCoverageDat(covRaw || "");
      // Translate nulls to 0 for backward compatibility with downstream
      // consumers that check `cov.line >= threshold` directly. The eval
      // gate distinguishes "0% because no data" from "0% because nothing
      // hit" via the denominator field on the criterion result; the
      // verify slot itself doesn't carry that distinction yet (could be
      // a follow-up).
      const cov = {
        line:   covParsed.line   != null ? covParsed.line   : 0,
        branch: covParsed.branch != null ? covParsed.branch : 0,
        toggle: covParsed.toggle != null ? covParsed.toggle : 0,
        fsm:    covParsed.fsm    != null ? covParsed.fsm    : 0,
        expr:   covParsed.expr   != null ? covParsed.expr   : 0,
        // _source helps the GUI distinguish "real 0%" from "no data"
        _source: covRaw ? "verilator-coverage-dat" : "no-data",
      };

      return {
        sim: "Verilator (CLI)",
        total: tests.length || 1,
        pass,
        fail: (tests.length || 1) - pass,
        cov: cov,
        tests,
        log: (cliResult.stdout || "") + "\n" + (cliResult.stderr || ""),
        cli: true,
        _noMarkers: tests.length === 0 && cliResult.exitCode === 0,
        // SVA binding provenance: which formal properties were actually
        // checked during this simulation (and which were skipped/why).
        // null when there was nothing to bind or svaInSim is disabled.
        sva: svaChecker ? {
          bound: _svaActive ? svaChecker.included : [],
          skipped: svaChecker.skipped,
          bindFailed: _svaBindFailed,
        } : null,
      };
    }
    let p = promptVerify(tb, rtl, st.spec);
    // Same skill overlay as the CLI-fallback verify path.
    p = await applySkillsToPrompt(p, st, "verify");
    const _sc = getStageConfig(st._config, "verify");
    p.config = _sc;
    p.maxTokens = _sc._maxTokens;
    p.onChunk = function(t, m) { appendLog.stream("Verify (LLM)", t); if (st._onLog) st._onLog(appendLog.buf, m); };
    const r = await callLLM(p);
    allLlms.push(Object.assign({ stage: "verify" }, r));
    const vResult = extractJSON(r.text);
    if (_verifyCliError) vResult._cliError = _verifyCliError;
    return vResult;
  }

  let baselineTests = null; // first iteration's test results
  // Chain-eligibility check: when verify decides RTL or TB needs regenerating
  // to fix sim failures, prefer the K-to-X chain (rtl_generate → ... → verify)
  // over the inline RTL-fix-then-TB-fix sequence. Inner verify inside its own
  // chain takes the legacy path so recursion terminates.
  const _hasServices = !!(st._services && typeof st._services.invokeNode === "function");
  const _loggerCtx   = (st._logger && st._logger.context) || {};
  const _alreadyInOwnChain = _loggerCtx.parentStageKey === "verify";
  const _canChain = _hasServices && !_alreadyInOwnChain;
  const verifyChainHistory = [];

  const _maxVerifyIters = st._config.maxVerifyIters || 3;
  let vData;
  // previousFixes accumulator, mirroring lint's promptRTLFix contract. Threaded
  // into both RTL and TB fix prompts so the LLM has memory of prior attempts
  // across iterations.
  let previousFixes = [];

  for (let vIter = 1; vIter <= _maxVerifyIters; vIter++) {
    appendLog("Verify — iteration " + vIter + "/" + _maxVerifyIters, "Running simulation…");
    if (st._logger) st._logger.state({
      iter: vIter, message: "Verify iteration " + vIter + "/" + _maxVerifyIters,
    });
    vData = await runVerifyOnce(currentRTL, currentTB);

    // Track baseline from first iteration
    if (vIter === 1) baselineTests = vData.tests || [];

    let passed = vData.fail === 0 && vData.total > 0;
    const treatVerifyWarningsAsErrors = !!st._config.verifyWarningsAsErrors;
    if (passed && treatVerifyWarningsAsErrors && vData.cov) {
      if ((vData.cov.line || 0) < 80 || (vData.cov.branch || 0) < 70) {
        passed = false;
        vData._covWarning = true;
      }
    }

    // Classify against baseline (not previous iteration)
    let testClass = null;
    if (vIter > 1 && baselineTests) {
      testClass = classifyTestResults(baselineTests, vData.tests || []);
      const testClassLog = "PATCH VALIDATION (verify iter " + vIter + "):\n" +
        "  PATCH_DECISION: " + testClass.patchDecision + "\n" +
        "  TASK_STATUS:    " + testClass.taskStatus + "\n" +
        "  Resolved (FAIL→PASS): " + testClass.resolved.length + "\n" +
        "  Persisting (FAIL→FAIL): " + testClass.persisting.length + "\n" +
        "  Introduced (PASS→FAIL): " + testClass.introduced.length + "\n" +
        "  Revealed (new FAIL): " + testClass.revealed.length + "\n" +
        "  Score: " + testClass.score;
      appendLog("Patch Validation (verify iter " + vIter + ")", testClassLog);

      // Full five-tier classifier handling, mirroring lint.js. Each decision
      // has distinct semantics:
      //
      //   ACCEPT_PROGRESS       — keep candidate (already in currentRTL/TB)
      //   ACCEPT_EQUIVALENT     — keep candidate (no improvement, no regression)
      //   REJECT_NO_IMPROVEMENT — revert this iter's edits to best-known
      //   REJECT_REGRESSION     — revert to best-known
      //   REJECT_INVALID_PATCH  — should never reach here (caught earlier)
      //
      // The candidate code is what the previous iter's fix wrote into
      // currentRTL/currentTB. If we reject, we revert those to bestRTL/bestTB
      // and replay vData from bestVerify so verifyHistory reflects the
      // pinned state, not the rejected one.
      // Convergence: forward the candidate code (currentRTL/currentTB) to
      // the next iter regardless of patch
      // decision. The fix LLM in iter N+1 then sees the actual current
      // state (the previous iter's fix attempt) rather than re-attempting
      // against the same baseline. Best-known state is still tracked via
      // bestVerify and restored at the end via the bestVerify > finalVerify
      // check below.
      // Previously REJECT_REGRESSION and REJECT_NO_IMPROVEMENT both reset
      // currentRTL/currentTB to bestRTL/bestTB which caused iter N+1 to
      // fix a copy of the same code N already saw, often producing the
      // same fix and delaying convergence.
      if (testClass.patchDecision === "REJECT_REGRESSION") {
        appendLog("⚠ REJECT_REGRESSION (verify iter " + vIter + ")",
          "Fix broke " + testClass.introduced.length + " previously passing tests. Forwarding candidate (best-known restore at end).");
      } else if (testClass.patchDecision === "REJECT_NO_IMPROVEMENT") {
        appendLog("○ REJECT_NO_IMPROVEMENT (verify iter " + vIter + ")",
          "No baseline failures resolved and no regression. Forwarding candidate so the next fix call sees fresh diagnostics.");
      } else if (testClass.patchDecision === "ACCEPT_PROGRESS") {
        appendLog("✓ ACCEPT_PROGRESS (verify iter " + vIter + ")",
          "Resolved " + testClass.resolved.length + " failing tests" +
          (testClass.revealed.length > 0 ? ", " + testClass.revealed.length + " newly revealed failures to address next iter" : "") + ".");
      } else if (testClass.patchDecision === "ACCEPT_EQUIVALENT") {
        appendLog("≈ ACCEPT_EQUIVALENT (verify iter " + vIter + ")",
          "No net improvement but no regression. Keeping candidate.");
      }
    }

    // Track best-known state (most tests passing vs baseline)
    const currentScore = (vData.pass || 0) - (vData.fail || 0) * 2;
    if (currentScore > bestScore) {
      bestScore = currentScore;
      bestRTL = currentRTL;
      bestTB = currentTB;
      bestVerify = vData;
    }

    const histEntry = {
      iter: vIter,
      trigger: vIter === 1 ? "initial" : "retry",
      status: passed ? "PASS" : "FAIL",
      pass: vData.pass,
      total: vData.total,
    };
    if (testClass) {
      histEntry.classification = {
        resolved: testClass.resolved.length,
        introduced: testClass.introduced.length,
        revealed: testClass.revealed.length,
        score: testClass.score,
        patchDecision: testClass.patchDecision,
        taskStatus: testClass.taskStatus,
      };
    }
    verifyHistory.push(histEntry);

    if (passed || vIter >= _maxVerifyIters) { finalVerify = vData; break; }

    // ── Stagnation detection ──
    // Stagnation also considers the patch decision: if the last two iterations
    // both produced REJECT_NO_IMPROVEMENT or REJECT_INVALID_PATCH, breaking
    // sooner saves tokens.
    const verifySig = (vData.pass || 0) + "/" + (vData.total || 0) + "|" + (vData.fail || 0)
      + (testClass ? "|" + testClass.patchDecision : "");
    if (verifySig === lastOutcomeSig) {
      stagnationCount++;
      if (stagnationCount >= 2) {
        appendLog("⛔ STAGNATION DETECTED (verify iter " + vIter + ")",
          "Same outcome signature repeated " + stagnationCount + "× with no improvement. Stopping verify fix loop.");
        finalVerify = vData;
        break;
      }
    } else {
      stagnationCount = 0;
    }
    lastOutcomeSig = verifySig;

    // ── Triage: determine root cause ──
    appendLog("Triage — iter " + vIter, "Classifying failure root cause…");
    const tp = promptVerifyTriage(vData, st.spec, st.elicit);
    const _scT = getStageConfig(st._config, "verify");
    tp.config = _scT;
    tp.maxTokens = _scT._maxTokens;
    tp.onChunk = function(t, m) { appendLog.stream("Triage", t); if (st._onLog) st._onLog(appendLog.buf, m); };
    const tr = await callLLM(tp);
    allLlms.push(Object.assign({ stage: "verify-triage-" + vIter }, tr));
    let triage;
    try { triage = extractJSON(tr.text); }
    catch (e) { triage = { target: "test_generate", reason: "triage parse error — defaulting to TB fix" }; }
    verifyHistory[verifyHistory.length - 1].triageTarget = triage.target;
    verifyHistory[verifyHistory.length - 1].triageReason = triage.reason;
    appendLog("Routing", "→ " + triage.target + ": " + (triage.reason || ""));

    // ── Fix RTL if root cause is RTL or spec ──
    // When chaining is available, replace the inline RTL-fix + TB-fix sequence
    // with one K-to-X chain walk. The chain regenerates whichever artifact
    // triage picked, plus all stages downstream of it through verify itself.
    //
    // Triage→chain triage mapping:
    //   triage.target = "spec"           → chain starts at rtl_generate (chain
    //                                       can't reach spec; verify's tail
    //                                       only goes back to rtl_generate)
    //   triage.target = "rtl_generate"   → chain starts at rtl_generate
    //   triage.target = "test_generate"  → chain starts at test_generate
    //   anything else                    → chain starts at test_generate
    //                                       (default: regen TB)
    let chainEntryUsed = false;
    // Track patch integrity for the stagnation check at the end of the loop
    // body. On the chain path these are set based on whether artifacts changed.
    let rtlPatchNoOp = false;
    let tbPatchNoOp = false;

    if (_canChain) {
      const activeStages = (st._services.allStages || []).slice();
      const tail = getReflowTail("verify", activeStages);
      const mode = resolveReflowMode("verify", st._config);
      // Map triage target to chain trigger
      let triggerStage = "test_generate";
      if (triage.target === "rtl_generate" || triage.target === "spec") {
        triggerStage = "rtl_generate";
      } else if (triage.target === "test_generate") {
        triggerStage = "test_generate";
      }
      // Informed loopback: the chain's triage entry (whichever generation stage
      // we picked) gets the full verify failure data so it can call
      // promptRTLFromVerifyFail or promptTBFromVerifyFail with vData, the
      // previous code, and accumulated fixes — instead of cold-regenerating.
      //
      // Note: previousCode targets the artifact being regenerated.
      // triggerStage="rtl_generate" → previousCode is the RTL.
      // triggerStage="test_generate" → previousCode is the TB.
      const fixContext = {
        source:        "verify",
        ownerIter:     vIter,
        previousCode:  (triggerStage === "rtl_generate") ? currentRTL : currentTB,
        previousFixes: previousFixes,
        verifyResult:  vData,
      };
      const chain = planStageReflow({
        ownerKey:     "verify",
        triggerStage: triggerStage,
        tail:         tail,
        state:        Object.assign({}, st, {
          rtl_generate:  { code: currentRTL },
          test_generate: { code: currentTB },
        }),
        mode:         mode,
        fixContext:   fixContext,
      });
      if (chain.length > 0) {
        appendLog("Reflow chain (verify, " + mode + ", trigger=" + triggerStage + ", " + chain.length + " entries)",
          chain.map(function(c) { return c.stageKey + "[" + c.reason + "]"; }).join(" → "));
        if (st._onLoopback) st._onLoopback(4);  // Signal loopback to RTL gen badge
        const parentDepth = (_loggerCtx.depth != null) ? _loggerCtx.depth : 0;
        const walk = await runReflowChain({
          chain:        chain,
          st:           st,
          ownerKey:     "verify",
          ownerIter:    vIter,
          parentDepth:  parentDepth,
          currentState: Object.assign({}, st, {
            rtl_generate:  { code: currentRTL },
            test_generate: { code: currentTB },
          }),
          allLlms:      allLlms,
          appendLog:    appendLog,
          strictOnError: false,
        });
        if (st._onLoopback) st._onLoopback(null);
        if (!walk.fallbackToLegacy) {
          chainEntryUsed = true;
          verifyChainHistory.push({
            iter: vIter,
            mode: mode,
            trigger: triggerStage,
            entries: walk.chainHistory,
          });
          // Pull regenerated artifacts out of currentState
          const rtlAfter = (walk.currentState && walk.currentState.rtl_generate
                              && walk.currentState.rtl_generate.code) || currentRTL;
          const tbAfter  = (walk.currentState && walk.currentState.test_generate
                              && walk.currentState.test_generate.code) || currentTB;
          if (rtlAfter === currentRTL) rtlPatchNoOp = true;
          if (tbAfter  === currentTB)  tbPatchNoOp  = true;
          // The chain ALSO ran an inner verify at its tail; that result is in
          // walk.currentState.verify and represents the actual simulation
          // outcome AFTER regeneration. We adopt it as the iteration's vData so the
          // outer loop's PASS/FAIL gating reflects the post-chain state.
          if (walk.currentState && walk.currentState.verify) {
            vData = walk.currentState.verify;
          }
          currentRTL = rtlAfter;
          currentTB  = tbAfter;
          // Stash structured iteration data for the UI viewer
          verifyHistory[verifyHistory.length - 1]._structured = {
            kind: "verify_fix_via_chain",
            chain: walk.chainHistory,
            chainMode: mode,
            trigger: triggerStage,
            beforeRtl: (walk.chainHistory.length > 0) ? currentRTL : null,
            afterRtl:  rtlAfter,
            beforeTb:  (walk.chainHistory.length > 0) ? currentTB : null,
            afterTb:   tbAfter,
          };
        }
      }
    }

    if (!chainEntryUsed && (triage.target === "rtl_generate" || triage.target === "spec")) {
      // ── Legacy inline RTL-fix path (unchanged) ──
      appendLog("RTL Fix — iter " + vIter, "Fixing RTL for functional failures…");
      // Signal that we're looping back to fix rtl_generate (stage 4).
      // The UI uses this to render the rtl_generate badge with a brighter
      // yellow at faster pulse cadence while the fix is in flight.
      if (st._onLoopback) st._onLoopback(4);
      // Pass previousFixes for non-monotonic-policy memory.
      // testClass (this iteration's classifyTestResults vs the original
      // baseline) rides along so the fix prompt's patch-outcome section can
      // tell the model which tests its previous edits fixed/broke.
      let rp = promptRTLFromVerifyFail(currentRTL, vData, st.spec, st.elicit, previousFixes, testClass);
      // Regenerating RTL → apply rtl_generate skills. (The triage call above is
      // intentionally NOT overlaid — it's a structural classifier prompt that
      // should stay clean of user style rules.)
      rp = await applySkillsToPrompt(rp, st, "rtl_generate");
      const _scR = getStageConfig(st._config, "rtl_fix");
      rp.config = _scR;
      rp.maxTokens = _scR._maxTokens;
      rp.onChunk = function(t, m) { appendLog.stream("RTL Fix", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const rr = await callLLM(rp);
      allLlms.push(Object.assign({ stage: "rtl-fix-verify-" + vIter }, rr));
      // Capture pre-fix RTL so the structured viewer can show before/after.
      // We snapshot BEFORE we mutate currentRTL below.
      const beforeRtl = currentRTL;
      let parsedRtl = null;
      const rrText = (rr && rr.text) || "";
      try {
        const rd = extractJSON(rrText);
        parsedRtl = rd && typeof rd === "object" ? rd : null;
        if (rd.code && rd.code !== currentRTL) {
          currentRTL = rd.code;
          // Tag each fix with its iter for the UI fix-list.
          previousFixes = previousFixes.concat(tagFixes(rd.fixes, vIter));
        } else if (rd.code === currentRTL) {
          rtlPatchNoOp = true;
          appendLog("⚠ RTL fix returned identical code (verify iter " + vIter + ")",
            "Patch integrity: no change detected.");
        }
      } catch (e) {
        appendLog(
          "⚠ RTL fix JSON parse failed (verify iter " + vIter + ")",
          "Keeping current RTL. Reason: " + (e && e.message ? e.message : String(e)),
        );
      }
      // Attach structured data for the UI viewer. We store under
      // _structured.rtlFix because a verify iter can also have a tbFix
      // attached below — both share the same iter slot.
      if (!verifyHistory[verifyHistory.length - 1]._structured) {
        verifyHistory[verifyHistory.length - 1]._structured = {};
      }
      verifyHistory[verifyHistory.length - 1]._structured.rtlFix = {
        rawText: rrText,
        parsed: parsedRtl,
        parseOk: !!(parsedRtl && parsedRtl.code),
        beforeCode: beforeRtl,
        afterCode: currentRTL,
        kind: "rtl_fix",
      };
      // Clear the loopback signal — the rtl_generate fix has finished.
      if (st._onLoopback) st._onLoopback(null);
    }

    // ── Fix / regenerate TB ──
    // Skipped when the chain ran (the chain handles both RTL and TB in one walk).
    if (!chainEntryUsed) {
    appendLog("TB Fix — iter " + vIter, "Regenerating testbench…");
    // Signal loopback to test_generate (stage 7).
    if (st._onLoopback) st._onLoopback(7);
    // Pass previousFixes + this iteration's test classification (same
    // patch-outcome plumbing as the RTL fix call above).
    let tbp = promptTBFromVerifyFail(currentTB, currentRTL, vData, st.spec, st.elicit, previousFixes, testClass);
    // Regenerating TB → apply test_generate skills.
    tbp = await applySkillsToPrompt(tbp, st, "test_generate");
    const _scB = getStageConfig(st._config, "test_generate");
    tbp.config = _scB;
    tbp.maxTokens = _scB._maxTokens;
    tbp.onChunk = function(t, m) { appendLog.stream("TB Fix", t); if (st._onLog) st._onLog(appendLog.buf, m); };
    const tbr = await callLLM(tbp);
    allLlms.push(Object.assign({ stage: "tb-fix-verify-" + vIter }, tbr));
    const beforeTb = currentTB;
    let parsedTb = null;
    const tbrText = (tbr && tbr.text) || "";
    try {
      const tbd = extractJSON(tbrText);
      parsedTb = tbd && typeof tbd === "object" ? tbd : null;
      if (tbd.code && tbd.code !== currentTB) {
        currentTB = tbd.code;
        // Tag each fix with its iter for the UI fix-list.
        previousFixes = previousFixes.concat(tagFixes(tbd.fixes, vIter));
      } else if (tbd.code === currentTB) {
        tbPatchNoOp = true;
        appendLog("⚠ TB fix returned identical code (verify iter " + vIter + ")",
          "Patch integrity: no change detected.");
      }
    } catch (e) {
      appendLog(
        "⚠ TB fix JSON parse failed (verify iter " + vIter + ")",
        "Keeping current TB. Reason: " + (e && e.message ? e.message : String(e)),
      );
    }
    if (!verifyHistory[verifyHistory.length - 1]._structured) {
      verifyHistory[verifyHistory.length - 1]._structured = {};
    }
    verifyHistory[verifyHistory.length - 1]._structured.tbFix = {
      rawText: tbrText,
      parsed: parsedTb,
      parseOk: !!(parsedTb && parsedTb.code),
      beforeCode: beforeTb,
      afterCode: currentTB,
      kind: "tb_fix",
    };
    // Clear loopback after the test_generate fix completes.
    if (st._onLoopback) st._onLoopback(null);
    } // close legacy TB fix !chainEntryUsed block

    // If BOTH fix calls returned no-ops, the next iter would be a deterministic
    // repeat. Increment stagnation directly (don't wait for the post-iter
    // signature compare, which catches it one iter later).
    const bothNoOp = rtlPatchNoOp && tbPatchNoOp;
    const onlyTbCalled = (triage.target !== "rtl_generate" && triage.target !== "spec");
    if (bothNoOp || (onlyTbCalled && tbPatchNoOp)) {
      stagnationCount++;
      verifyHistory[verifyHistory.length - 1].patchInvalid = true;
      if (stagnationCount >= 2) {
        appendLog("⛔ STAGNATION DETECTED (verify iter " + vIter + ")",
          "Both fix calls returned identical code 2× in a row. Stopping verify fix loop.");
        finalVerify = vData;
        break;
      }
    } else {
      // ── Candidate-churn check (oscillation across iterations) ──
      // The RTL/TB pair changed vs this iteration's base — but if it matches
      // a pair from an EARLIER iteration (A→B→A ping-pong), re-simulating it
      // would burn a full Verilator run on an outcome we already measured.
      // Mutually exclusive with the no-op branch above so a single no-op
      // iteration isn't double-counted toward stagnation.
      const pairKey = currentRTL + " " + currentTB;
      const churn = churnTracker.assess(pairKey);
      if (churn.verdict !== "new") {
        stagnationCount++;
        verifyHistory[verifyHistory.length - 1].patchRepeat = {
          verdict: churn.verdict,
          matchedIter: churn.matchedIter,
        };
        appendLog("⚠ " + (churn.verdict === "repeat" ? "REPEAT" : "NEAR-REPEAT")
            + " CANDIDATE PAIR (verify iter " + vIter + ")",
          "The fixed RTL/TB pair " + (churn.verdict === "repeat" ? "matches" : "nearly matches")
          + " the pair from iteration " + churn.matchedIter
          + " — its simulation outcome is already known.");
        if (stagnationCount >= 2) {
          appendLog("⛔ STAGNATION DETECTED (verify iter " + vIter + ")",
            "The fix loop is cycling between already-tried RTL/TB pairs. Stopping verify fix loop.");
          finalVerify = vData;
          break;
        }
      } else {
        churnTracker.record(pairKey, vIter);
      }
    }
  }

  // Use best-known state if final isn't better
  if (!finalVerify) finalVerify = bestVerify || vData;
  if (bestVerify && (bestVerify.pass || 0) > (finalVerify.pass || 0)) {
    finalVerify = bestVerify;
    currentRTL = bestRTL;
    currentTB = bestTB;
    appendLog("Best-known state restored", "Final iteration was not the best — using iteration with " + bestVerify.pass + "/" + bestVerify.total + " passing tests.");
  }

  finalVerify.verifyHistory = verifyHistory;
  // Expose the full streaming log so the VerifyStage UI can slice it
  // per-iteration the same way LintStage does.
  finalVerify._fullLog = appendLog.buf;
  // Surface accumulated fix descriptions so the RTL Gen / Test Gen split-view
  // fix panels can show what verify did, using the same shape as lint._fixes
  // (with iter info preserved for UI annotation).
  finalVerify._fixes = previousFixes.map(function(f) {
    if (typeof f === "string") return { text: f, iter: null };
    if (f && typeof f === "object") {
      const test = f.test ? "[" + f.test + "] " : "";
      const text = test + (f.desc || f.description || f._text || JSON.stringify(f));
      return { text: text, iter: typeof f._iter === "number" ? f._iter : null };
    }
    return { text: String(f), iter: null };
  });
  const rtlChanged = currentRTL !== originalRTL;
  const tbChanged  = currentTB  !== originalTB;
  const rtlOut = { code: currentRTL };
  if (rtlChanged) {
    rtlOut._originalCode = originalRTL;
    rtlOut._fixSource = "fixed post verify";
    rtlOut._fixes = finalVerify._fixes;
  }
  const tbOut = { code: currentTB };
  if (tbChanged) {
    tbOut._originalCode  = originalTB;
    tbOut._fixSource  = "fixed post verify";
    tbOut._fixes = finalVerify._fixes;
  }

  finalVerify._llms = allLlms.slice();
  // Expose chain history when the chain ran.
  if (verifyChainHistory.length > 0) {
    finalVerify._chain = verifyChainHistory;
  }
  return {
    verify: finalVerify,
    rtl_generate: rtlOut,
    test_generate: tbOut,
    // Full per-call LLM ledger for the Duration/Tokens tabs.
    _llms: allLlms.slice(),
    _llm: allLlms.length > 0
      ? allLlms[allLlms.length - 1]
      : { stage: "verify", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "cli", provider: "cli" },
  };
}
