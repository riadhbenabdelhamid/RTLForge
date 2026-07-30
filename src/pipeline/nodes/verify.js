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
import { runCli, CliBackendError, parseTestLine, extractInfoEvidence, attachInfoEvidence, parseCoverageDat, parseCLIOutput } from "../../cli/index.js";
import { classifyTestResultsByReq, hasCompileFailure } from "../classifiers.js";
import { createLogger } from "../log.js";
import { parseCoversAnnotations, attributeTestToReq } from "../coversParser.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { tagFixes, createCodeChurnTracker, detectGuttedRewrite, noDeletionDirective, detectTbInfraLoss, attemptRowsFromHistory } from "../fixLoopHelpers.js";
import { investigateTriage } from "../triageInvestigator.js";
// Per-stage K-to-X reflow: when verify's iteration decides RTL or TB needs
// regenerating, the chain runs rtl_generate → rtl_review → lint → formal_props
// → test_generate → test_review → lint_test → verify instead of inline
// promptRTLFromVerifyFail / promptTBFromVerifyFail calls. The triage target
// picked by promptVerifyTriage becomes the chain's regen entry point.
import { planStageReflow } from "../reflowPlanner.js";
import { runReflowChain, resolveReflowMode } from "../reflowRunner.js";
import { getReflowTail, filterEnabledStages } from "../../constants/stages.js";
// SVA-in-simulation: bind the formal_props properties into the Verilator
// build so they're actually checked at runtime. See svaBind.js for the full
// rationale, the safety filter, and the compile-failure fallback contract.
import { buildSvaChecker, injectVerilatorFlag, svaCompileFailed } from "../svaBind.js";
import { injectDumpvars, signalWindow, firstFailTime } from "../vcdWindow.js";
// Mutation gate: opt-in TB-strength measurement after a real-CLI PASS.
import { runMutationGate } from "../mutation.js";
// Coverage strengthening (#19): opt-in additive TB pass after a real-CLI PASS.
import { runCoverageStrengthening, withCoverageCmds } from "../coverageStrengthen.js";
import { normalizeEvalConfig } from "../../eval/criteria.js";
import { buildLedgerForState } from "../acceptanceLedger.js";
import {
  promptVerify,
  promptVerifyTriage,
  promptRTLFromVerifyFail,
  promptTBFromVerifyFail,
  patchModeFixPrompt,
} from "../../prompts/index.js";
import { PATCH_SCHEMA } from "../../prompts/schemas.js";
import { applyEdits } from "../applyEdits.js";

/**
 * Whether to roll the verify result back to the best-known iteration. Uses the
 * SAME metric the loop tracks best-known by (score = pass - 2*fail), so a final
 * iteration that ties on pass but regressed on FAIL is correctly restored — the
 * old `best.pass > final.pass` check missed that, leaving avoidable failures for
 * the judge to re-triage. Pure + exported for testing.
 *
 * COMPILING DOMINATES THE SCORE (measured, run 10): a compile failure surfaces
 * as one synthetic FAIL test (score -2), which outranked a real 4/9 sim
 * (score -6) and "restored" a state with no test signal at all — the stage
 * then reported "1 fail" for a design that measurably passed 4 of 9 tests.
 * A measurement with real sim results is never rolled back to one without.
 */
export function shouldRestoreBest(best, final) {
  if (!best) return false;
  const compiles = function(v) { return !hasCompileFailure(v && v.tests); };
  if (compiles(final) !== compiles(best)) return compiles(best);
  // NEITHER compiles: rank by distance from compiling (run 39). Every
  // compile failure scores the same synthetic 0/1 (-2), so the score line
  // below ties and the LAST candidate ships — which let a fix-loop mutation
  // with 8 blocking errors replace a TB that was one error from compiling;
  // the champion then banked the mutilation and the judge restored it.
  // _blocking is parsed from verify's own stderr (ddaef79); when either
  // side lacks it (old snapshots, LLM-estimated runs) fall through.
  if (!compiles(final)) {
    const b = best && best._blocking, f = final && final._blocking;
    if (typeof b === "number" && typeof f === "number" && b !== f) return b < f;
  }
  const score = function(v) { return ((v && v.pass) || 0) - ((v && v.fail) || 0) * 2; };
  return score(best) > score(final);
}

/**
 * Run-level champion comparison (run 28 generalization): the best-known
 * machinery above protects ONE verify invocation; the champion — carried on
 * verify.champion across chain re-entries and judge reflows — protects the
 * whole run, so no later stage can ship fewer passing tests than the best
 * (RTL, TB) pair any verify actually measured. A candidate must carry a real
 * compiled test signal to qualify; among qualifiers: more passing tests wins,
 * a pass tie breaks on fewer failures, and a full tie keeps the incumbent
 * (no churn). Pure + exported for testing.
 */
/**
 * A mutation result that ran valid mutants and killed NONE means the
 * testbench cannot detect injected RTL bugs — as an oracle it proves
 * nothing. Used to flag a green verify whose TB changed during the fix
 * loop (the weakened-until-it-passed transition). Pure + exported.
 */
export function oracleSuspect(mutation) {
  if (!mutation) return false;
  const valid = (mutation.total || 0) - (mutation.invalid || 0);
  return valid > 0 && (mutation.killed || 0) === 0;
}

export function betterChampion(cand, champ) {
  const usable = function(c) {
    return !!(c && c.rtl && c.tb && (c.total || 0) > 0 && !hasCompileFailure(c.tests));
  };
  if (usable(cand)) {
    if (!usable(champ)) return true;                  // measured beats unmeasured
    if ((cand.pass || 0) !== (champ.pass || 0)) return (cand.pass || 0) > (champ.pass || 0);
    return (cand.fail || 0) < (champ.fail || 0);
  }
  // COMPILE TIER (run 36). A run where NOTHING ever compiles banks nothing —
  // the champion is blind exactly when it is most needed, and the run ships
  // whatever the last stage produced. Run 36 held a TB one declaration short
  // of running (1 error) and shipped one corrupted at two sites (2 errors).
  // So rank non-compiling pairs by how far they are from compiling: fewer
  // blocking errors wins, and such a pair NEVER displaces one that compiled.
  if (usable(champ)) return false;
  const near = function(c) {
    return !!(c && c.rtl && c.tb && typeof c.blocking === "number");
  };
  if (!near(cand)) return false;                      // unknown distance banks nothing
  if (!near(champ)) return true;
  return cand.blocking < champ.blocking;
}

/**
 * No-improvement triage flip (measured: run 18). LLM triage blamed the
 * testbench on every iteration while a one-line RTL bug sat untouched — the
 * TB was regenerated 5× and the pass count never moved off 33/54. When the
 * SAME side (rtl vs tb) has already been regenerated twice in a row with no
 * pass-count gain, a third same-side opinion is a measured dead end: force
 * the alternate target.
 *
 * TWO strikes, not one: a single failed attempt earns a same-target retry —
 * the forward-candidate machinery (iter N+1's fix sees iter N's candidate
 * plus its patch outcome) is a designed convergence path and often needs the
 * second attempt. The flip only overrides the third consecutive same-side
 * opinion, after both informed attempts measurably went nowhere.
 *
 * Returns the FLIPPED target ("rtl_generate" | "test_generate") when the flip
 * should apply, or null to keep the LLM's pick. Never flips evidence-based
 * triage (formal arbiter, compile-log routing) — that is a measurement, not
 * an opinion. Pure + exported for testing.
 *
 * @param {Array}   history  verifyHistory entries ({pass, triageTarget}); the
 *                           LAST entry is the current iteration (no target yet)
 * @param {string}  target   the triage target just chosen
 * @param {boolean} evidence true when triage came from measured evidence
 */
export function triageFlipTarget(history, target, evidence) {
  if (evidence || !Array.isArray(history) || history.length < 3) return null;
  const side = function(t) {
    return (t === "rtl_generate" || t === "spec") ? "rtl_generate" : "test_generate";
  };
  const cur   = history[history.length - 1];
  const prev1 = history[history.length - 2];
  const prev2 = history[history.length - 3];
  if (!cur || !prev1 || !prev1.triageTarget || !prev2 || !prev2.triageTarget) return null;
  if (side(prev1.triageTarget) !== side(target)) return null;
  if (side(prev2.triageTarget) !== side(target)) return null;
  if (typeof prev2.pass !== "number" || typeof prev1.pass !== "number"
      || typeof cur.pass !== "number") return null;
  // Monotonically non-improving across both attempts → dead end.
  if (cur.pass > prev1.pass || prev1.pass > prev2.pass) return null;
  return side(target) === "test_generate" ? "rtl_generate" : "test_generate";
}

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
      const vResult = extractJSON(r.text, r);
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

    // Waveform-grounded fixes (roadmap #7): dump a VCD so a failing run's fix
    // prompt can see signals around the failure. Local backend only — the
    // embedded executor harvests wave.vcd back.
    const _waveEnabled = !!st._config.waveGroundedFixes && st._config.backendUrl === "local";

    async function execCli(withSva) {
      let attemptCmds = withSva ? injectVerilatorFlag(cmds, "--assert") : cmds;
      // Verilator's default is exit-on-warning, which turns a style warning
      // into a 0-test compile failure (measured: run 10, PROCASSINIT killed
      // verify iter 1). Warning POLICY belongs to the lint stages and the
      // verifyWarningsAsErrors flag — when that flag is off, warnings must
      // not block the simulation.
      if (!st._config.verifyWarningsAsErrors) {
        attemptCmds = injectVerilatorFlag(attemptCmds, "-Wno-fatal");
      }
      let tbPayload = tb;
      if (_waveEnabled) {
        attemptCmds = injectVerilatorFlag(attemptCmds, "--trace");
        tbPayload = injectDumpvars(tbPayload);
      }
      const rtlPayload = withSva ? rtl + "\n" + svaChecker.text : rtl;
      return runCli(st._config.backendUrl, {
        commands: attemptCmds.map(function(c) { return c.replace("{RTL}", rtlFileName).replace("{TB}", tbFileName); }),
        files: { [rtlFileName]: rtlPayload, [tbFileName]: tbPayload },
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
        && svaCompileFailed(cliResult, svaChecker.checkerName,
             { rtlFileName: rtlFileName, rtlLineCount: rtl.split("\n").length })) {
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
      // Attach measured expected-vs-actual evidence from the TB's [INFO]
      // lines (check_eq prints one per failing value comparison), so the
      // fix prompts' failing-test entries carry the fact to reconcile
      // instead of an empty evidence field. Prefix-matched: parsed names
      // keep the label's trailer, and labels may carry prose (run 29).
      attachInfoEvidence(tests, extractInfoEvidence(cliResult.stdout));
      if (tests.length === 0 && cliResult.exitCode !== 0) {
        tests.push({ name: "compilation", st: "FAIL", cyc: 0, ms: 0 });
      }
      // How far this pair is from compiling, parsed from the same stderr the
      // lint stages parse. Only meaningful on a failed compile; it is what
      // lets the champion's compile tier rank two broken artifacts (run 36).
      const _blocking = (tests.length === 1 && tests[0].name === "compilation")
        ? (parseCLIOutput(cliResult.stderr || "").errors || []).length
        : null;
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

      // Waveform-grounded fixes (roadmap #7): on a FAILING run, extract a
      // compact signal window around the first failure from the harvested VCD
      // and carry it on the verify result — the fix prompts read
      // verifyResult._waveExcerpt (no signature changes). Best-effort.
      let _waveExcerpt = null;
      if (_waveEnabled && ((tests.length || 1) - pass) > 0
          && cliResult.files && cliResult.files["wave.vcd"]) {
        try {
          const simOut = (cliResult.stdout || "") + "\n" + (cliResult.stderr || "");
          const failNames = tests.filter(function(x) { return x.st === "FAIL"; }).map(function(x) { return x.name; });
          _waveExcerpt = signalWindow(cliResult.files["wave.vcd"], {
            aroundTime: firstFailTime(simOut),
            preferSignals: failNames,
          }) || null;
        } catch (_e) { _waveExcerpt = null; /* the window is optional context */ }
      }

      // Waveform-grounded triage (run 18): keep the raw VCD on the result so
      // the triage investigator can probe arbitrary windows without
      // re-simulating. In-memory only — stripped before the node returns
      // (checkpoints must not carry megabytes of waveform). Size-capped so a
      // pathological dump can't balloon the loop's working set.
      const _vcdRaw = (cliResult.files && cliResult.files["wave.vcd"]) || null;
      const _vcdText = (_vcdRaw && _vcdRaw.length <= 2000000) ? _vcdRaw : null;

      return {
        sim: "Verilator (CLI)",
        total: tests.length || 1,
        pass,
        fail: (tests.length || 1) - pass,
        cov: cov,
        tests,
        log: (cliResult.stdout || "") + "\n" + (cliResult.stderr || ""),
        cli: true,
        _waveExcerpt: _waveExcerpt,
        _vcdText: _vcdText,
        _noMarkers: tests.length === 0 && cliResult.exitCode === 0,
        _blocking: _blocking,
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
    const vResult = extractJSON(r.text, r);
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
      // Compare at the REQUIREMENT level: a TB regeneration that renumbers/
      // rewords subtests (REQ-X.1 → REQ-X.7) must not read as resolved+revealed
      // churn (false progress that dodges stagnation). reqKeyOf collapses
      // REQ-X.<n> subtests to their req; legacy free-text names are unaffected.
      testClass = classifyTestResultsByReq(baselineTests, vData.tests || []);
      const testClassLog = "PATCH VALIDATION (verify iter " + vIter + "):\n" +
        "  PATCH_DECISION: " + testClass.patchDecision + "\n" +
        "  TASK_STATUS:    " + testClass.taskStatus + "\n" +
        "  Resolved (FAIL→PASS): " + testClass.resolved.length + "\n" +
        "  Persisting (FAIL→FAIL): " + testClass.persisting.length + "\n" +
        "  Introduced (PASS→FAIL): " + testClass.introduced.length + "\n" +
        "  Revealed (new FAIL): " + testClass.revealed.length + "\n" +
        "  Dropped (removed from TB): " + ((testClass.dropped || []).length) + "\n" +
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
      if (testClass.patchDecision === "REJECT_COMPILE_FAIL") {
        appendLog("⛔ REJECT_COMPILE_FAIL (verify iter " + vIter + ")",
          "Candidate testbench does not compile — no trustworthy test signal. " +
          "Best-known restore keeps the last compiling candidate; next fix must " +
          "target the syntax error first.");
      } else if (testClass.patchDecision === "REJECT_REGRESSION") {
        appendLog("⚠ REJECT_REGRESSION (verify iter " + vIter + ")",
          "Fix broke " + testClass.introduced.length + " previously passing tests" +
          ((testClass.dropped || []).length > 0 ? " and removed " + testClass.dropped.length + " baseline tests from the TB" : "") +
          ". Forwarding candidate (best-known restore at end).");
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

    // Track best-known state (most tests passing vs baseline). Compiling
    // dominates the score — see shouldRestoreBest: a compile failure's
    // synthetic single-FAIL entry must never pin best-known against real
    // sim results (run 10).
    const currentScore = (vData.pass || 0) - (vData.fail || 0) * 2;
    const _candCompiles = !hasCompileFailure(vData.tests);
    const _bestCompiles = bestVerify != null && !hasCompileFailure(bestVerify.tests);
    // Same blocking-distance tiebreak as shouldRestoreBest (run 39): between
    // two compile failures the scores always tie at -2, so without this a
    // loop that IMPROVES from 8 blocking errors to 1 never updates best.
    const _closerToCompiling = !_candCompiles && !_bestCompiles
      && typeof vData._blocking === "number"
      && typeof (bestVerify && bestVerify._blocking) === "number"
      && vData._blocking < bestVerify._blocking;
    const _newBest = bestVerify == null
      ? true
      : (_candCompiles !== _bestCompiles ? _candCompiles
         : (currentScore > bestScore || _closerToCompiling));
    if (_newBest) {
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

    // ── Run-budget gate (before the expensive triage + fix work) ──
    // st._budget is the run-wide guard from runStage (pipeline/budget.js).
    // The simulation above is CLI-side (cheap); triage + RTL/TB fixes below
    // are the LLM spend — so this is the natural in-stage stopping point.
    if (st._budget && st._budget.enabled) {
      const over = st._budget.overWith(allLlms);
      if (over) {
        appendLog("⛔ RUN BUDGET EXHAUSTED (verify iter " + vIter + ")",
          over.message + "\nStopping the verify fix loop; keeping the current result.");
        finalVerify = vData;
        finalVerify._budgetHalted = true;
        break;
      }
    }

    // ── Reject means reject (docs/reliability.md R1) ──
    // A candidate the classifier REJECTED (it broke passing tests, or does
    // not compile) is DISCARDED before the fix step: this iteration's triage
    // + repair target the best-known RTL/TB pair, with evidence from the
    // best-known measurement — a fix prompt must describe the code it is
    // fixing, never the damaged candidate. The history entry above already
    // recorded the regressed run honestly (the Convergence strip shows the
    // spike); only the WORKING SET reverts. The earlier forward-always design
    // predates the churn tracker (which now turns a re-produced rejected fix
    // into a fast stagnation stop) and the patch-outcome section (which tells
    // the model what its rejected attempt broke).
    if (testClass && bestVerify
        && (testClass.patchDecision === "REJECT_REGRESSION"
            || testClass.patchDecision === "REJECT_COMPILE_FAIL")) {
      appendLog("↩ REVERT TO BEST-KNOWN (verify iter " + vIter + ")",
        testClass.patchDecision + " — repairing the best-known RTL/TB ("
        + (bestVerify.pass || 0) + "/" + (bestVerify.total || 0)
        + " passing) instead of the rejected candidate.");
      currentRTL = bestRTL;
      currentTB  = bestTB;
      vData      = bestVerify;
      verifyHistory[verifyHistory.length - 1].revertedToBest = true;
    }

    // ── Triage: determine root cause ──
    // Formal arbiter (opt-in, docs/tb-correctness.md): when BMC PROVED the
    // bound properties (real sby run, non-empty property set), failing tests
    // are attributed to the testbench on measured evidence — no LLM opinion
    // needed, no triage call spent. Honest limits stated in the reason:
    // bounded depth, and only the bound properties are covered.
    let triage = null;
    // True when triage came from measured evidence (formal arbiter, compile
    // log) rather than LLM opinion — evidence-based routing is never flipped
    // by the no-improvement rule below.
    let triageEvidence = false;
    const _fv = st.formal_verify;
    if (st._config.formalArbiter && _fv && _fv.status === "PASS"
        && Array.isArray(_fv.properties) && _fv.properties.length > 0
        && vData.tests && vData.tests.length > 0 && !hasCompileFailure(vData.tests)) {
      triage = {
        target: "test_generate",
        reason: "formal arbiter: all " + _fv.properties.length + " bound propert"
          + (_fv.properties.length === 1 ? "y" : "ies") + " hold to depth " + _fv.depth
          + " (BMC) — failing tests are attributed to the testbench. "
          + "Limits: bounded proof (depth " + _fv.depth + "), only the bound properties are covered.",
      };
      appendLog("Triage — iter " + vIter + " (formal arbiter)", triage.reason);
      triageEvidence = true;
    }
    // Deterministic triage on a compile failure (measured, run 9: an obvious
    // TB compile failure got an empty LLM triage — target None — and the loop
    // stopped without a fix). The compile log NAMES the failing file; routing
    // is a string match, not a judgment call, and costs zero LLM minutes.
    if (!triage && hasCompileFailure(vData.tests)) {
      const _clog = String(vData.log || "");
      const _rtlNamed = _clog.indexOf(rtlFileName + ":") >= 0;
      const _tbNamed  = _clog.indexOf(tbFileName + ":") >= 0;
      // RTL errors take precedence (they cascade into the TB compile); a log
      // naming NEITHER file falls through to the LLM triage below.
      if (_rtlNamed || _tbNamed) {
        const _target = _rtlNamed ? "rtl_generate" : "test_generate";
        triage = {
          target: _target,
          reason: "deterministic: compilation failed and the compile log names "
            + (_rtlNamed ? rtlFileName : tbFileName)
            + " — routing straight to its fix (no LLM triage needed).",
        };
        appendLog("Triage — iter " + vIter + " (deterministic, compile failure)", triage.reason);
        triageEvidence = true;
      }
    }
    // Waveform investigation (run 18): before falling back to the one-shot
    // opinion, let a bounded probe loop interrogate the failing sim's VCD —
    // the model requests signal windows and must ground its verdict in what
    // it observed. Strictly bounded (triageProbes rounds); every failure path
    // returns null and the classic triage below takes over. The verdict is
    // waveform-grounded but still LLM judgment, so triageEvidence stays
    // false — the no-improvement flip keeps authority over it.
    if (!triage && st._config.triageInvestigation !== false && vData._vcdText
        && !hasCompileFailure(vData.tests)) {
      appendLog("Triage — iter " + vIter + " (waveform investigation)",
        "Probing the failing simulation's VCD before routing…");
      const _scI = getStageConfig(st._config, "verify_triage");
      let _inv = null;
      try {
        _inv = await investigateTriage({
          vcdText: vData._vcdText,
          simOut: vData.log,
          tests: vData.tests,
          spec: st.spec,
          rtlCode: currentRTL,
          tbCode: currentTB,
          llmConfig: _scI,
          maxTokens: _scI._maxTokens,
          maxProbes: typeof st._config.triageProbes === "number" ? st._config.triageProbes : 3,
          allLlms: allLlms,
          iter: vIter,
          onLog: appendLog,
          onChunk: function(t, m) { appendLog.stream("Investigation", t); if (st._onLog) st._onLog(appendLog.buf, m); },
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        _inv = null;
      }
      if (_inv && _inv.target) {
        triage = {
          target: _inv.target,
          reason: "waveform investigation (" + _inv.probes.length + " probe"
            + (_inv.probes.length === 1 ? "" : "s") + "): " + _inv.reason
            + (_inv.evidence ? " | observed: " + _inv.evidence : ""),
        };
        verifyHistory[verifyHistory.length - 1].triageInvestigated = true;
        appendLog("Triage — iter " + vIter + " (investigated)", triage.reason);
      } else {
        appendLog("Investigation inconclusive",
          "No waveform-grounded verdict — falling back to one-shot triage.");
      }
    }
    if (!triage) {
      appendLog("Triage — iter " + vIter, "Classifying failure root cause…");
      const tp = promptVerifyTriage(vData, st.spec, st.elicit);
      const _scT = getStageConfig(st._config, "verify");
      tp.config = _scT;
      tp.maxTokens = _scT._maxTokens;
      tp.onChunk = function(t, m) { appendLog.stream("Triage", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      const tr = await callLLM(tp);
      allLlms.push(Object.assign({ stage: "verify-triage-" + vIter }, tr));
      try { triage = extractJSON(tr.text, tr); }
      catch (e) { triage = { target: "test_generate", reason: "triage parse error — defaulting to TB fix" }; }
      // An LLM triage that parses but names no target is as useless as a parse
      // error (measured: run 9 recorded target None and stopped) — same default.
      if (!triage || !triage.target) {
        triage = { target: "test_generate", reason: "triage returned no target — defaulting to TB fix" };
      }
    }
    // No-improvement target flip — see triageFlipTarget (run 18: LLM triage
    // re-blamed the TB every iteration while a one-line RTL bug sat untouched).
    const _flipped = triageFlipTarget(verifyHistory, triage.target, triageEvidence);
    if (_flipped) {
      const _p1 = verifyHistory[verifyHistory.length - 2];
      const _p2 = verifyHistory[verifyHistory.length - 3];
      const _cp = verifyHistory[verifyHistory.length - 1].pass;
      appendLog("↔ TRIAGE FLIP (two attempts, no improvement)",
        "The last two iterations both routed to the same side and the pass count "
        + "never improved (" + _p2.pass + " → " + _p1.pass + " → " + _cp
        + "). Overriding LLM triage (" + triage.target + ") to " + _flipped + ".");
      triage = {
        target: _flipped,
        reason: "no-improvement flip: this side was already regenerated twice with no "
          + "pass-count gain (" + _p2.pass + " → " + _p1.pass + " → " + _cp
          + "); trying the other artifact. "
          + "(LLM had said: " + (triage.reason || triage.target) + ")",
      };
      verifyHistory[verifyHistory.length - 1].triageFlipped = true;
    }
    verifyHistory[verifyHistory.length - 1].triageTarget = triage.target;
    verifyHistory[verifyHistory.length - 1].triageReason = triage.reason;
    appendLog("Routing", "→ " + triage.target + ": " + (triage.reason || ""));

    // Compact attempt ledger for the fix prompts (run 18 working-set
    // curation): one measured-outcome line per completed prior attempt.
    const attemptRows = attemptRowsFromHistory(verifyHistory);

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
      const activeStages = filterEnabledStages(st._services.allStages, st._config);
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
        attemptHistory: attemptRows,
        // The triage reason IS the root-cause analysis (waveform-grounded
        // when the investigator ran) — run 19 measured it being discarded
        // one hop after routing, leaving the fixer to re-derive (and miss)
        // the mechanism it had already named.
        diagnosis: triage.reason || "",
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
          let tbAfter  = (walk.currentState && walk.currentState.test_generate
                              && walk.currentState.test_generate.code) || currentTB;
          if (tbAfter !== currentTB && detectTbInfraLoss(currentTB, tbAfter)) {
            // Architectural regression (measured: a late TB rewrite dropped
            // step()/check()/ref_ model and shipped) — keep the current TB.
            appendLog("⛔ TB fix rejected — infrastructure lost (verify chain iter " + vIter + ")",
              "The chain's TB candidate dropped the step()/check()/reference-model infrastructure. Keeping the current TB.");
            tbAfter = currentTB;
          }
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
      // Patch-mode (roadmap #2, gated fixPatchMode — extended to the verify
      // fix loop after run 28: the full-file TB/RTL rewrites are where
      // drive-by regressions ride in). Fail-closed exactly like lint.js:
      // edits that don't apply fall back to ONE full-file ask.
      const _patchTryR = !!st._config.fixPatchMode;
      const _scR = getStageConfig(st._config, "rtl_fix");
      let rr = null;
      let rrText = "";
      let _patchedRtl = null;   // pre-parsed {code, fixes} when patch edits applied
      for (let _fa = 0; _fa < (_patchTryR ? 2 : 1); _fa++) {
        let rp = promptRTLFromVerifyFail(currentRTL, vData, st.spec, st.elicit, previousFixes, testClass, attemptRows, null, triage.reason);
        if (_patchTryR && _fa === 0) rp = patchModeFixPrompt(rp);
        // Regenerating RTL → apply rtl_generate skills. (The triage call above is
        // intentionally NOT overlaid — it's a structural classifier prompt that
        // should stay clean of user style rules.)
        rp = await applySkillsToPrompt(rp, st, "rtl_generate");
        rp.config = _scR;
        rp.maxTokens = _scR._maxTokens;
        if (rp._patchMode) rp.jsonSchema = PATCH_SCHEMA;   // full-file path keeps its schema-less contract
        rp.onChunk = function(t, m) { appendLog.stream("RTL Fix", t); if (st._onLog) st._onLog(appendLog.buf, m); };
        rr = await callLLM(rp);
        allLlms.push(Object.assign({ stage: "rtl-fix-verify-" + vIter }, rr));
        rrText = (rr && rr.text) || "";
        if (rp._patchMode) {
          let pd = null;
          try { pd = extractJSON(rrText); } catch (_e) { pd = null; }
          const _ap = applyEdits(currentRTL, pd && pd.edits);
          if (_ap.ok) {
            appendLog("Patch mode (RTL fix, iter " + vIter + ")", _ap.applied + " edit(s) applied cleanly.");
            _patchedRtl = {
              code: _ap.code,
              fixes: (pd.fixes || []).map(function(f) { return { test: f.test || f.id || "", desc: f.desc || "" }; }),
            };
            break;
          }
          appendLog("Patch mode fallback (RTL fix, iter " + vIter + ")",
            "Edits failed to apply (" + _ap.failReason + ") — re-asking for the full file.");
          continue;   // second pass: full-file prompt (today's behavior)
        }
        break;
      }
      // Capture pre-fix RTL so the structured viewer can show before/after.
      // We snapshot BEFORE we mutate currentRTL below.
      const beforeRtl = currentRTL;
      let parsedRtl = null;
      try {
        let rd = _patchedRtl || extractJSON(rrText);
        parsedRtl = rd && typeof rd === "object" ? rd : null;
        if (rd.code && rd.code !== currentRTL && detectGuttedRewrite(currentRTL, rd.code)) {
          // Structural-collapse guard → corrective re-ask. Rather than accept
          // the deletion (or keep the failing original), re-ask ONCE for a
          // complete, working replacement; adopt it only if it isn't gutted.
          appendLog("↻ COMPLETE-MODULE RE-ASK (verify iter " + vIter + ")",
            "RTL fix collapsed the module body — re-asking for a complete, working replacement.");
          let rp2 = noDeletionDirective(promptRTLFromVerifyFail(currentRTL, vData, st.spec, st.elicit, previousFixes, testClass, attemptRows, null, triage.reason));
          rp2 = await applySkillsToPrompt(rp2, st, "rtl_generate");
          rp2.config = _scR;
          rp2.maxTokens = _scR._maxTokens;
          rp2.onChunk = function(t, m) { appendLog.stream("RTL Fix (re-ask)", t); if (st._onLog) st._onLog(appendLog.buf, m); };
          const rr2 = await callLLM(rp2);
          allLlms.push(Object.assign({ stage: "rtl-fix-verify-reask-" + vIter }, rr2));
          const rd2 = extractJSON((rr2 && rr2.text) || "");
          if (rd2.code && rd2.code !== currentRTL && !detectGuttedRewrite(currentRTL, rd2.code)) {
            rd = rd2;
            parsedRtl = rd2 && typeof rd2 === "object" ? rd2 : null;
            currentRTL = rd2.code;
            previousFixes = previousFixes.concat(tagFixes(rd2.fixes, vIter));
          } else {
            appendLog("⚠ REJECT_GUTTED (verify iter " + vIter + ")",
              "Re-ask still returned an empty module — keeping current RTL.");
            rtlPatchNoOp = true;
          }
        } else if (rd.code && rd.code !== currentRTL) {
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
    // Patch-mode for the TB fix — the run 28 regression (a full-file TB
    // rewrite quietly adding a ref_dout staging flop) is exactly the class
    // exact-match edits structurally prevent. Fail-closed, same as above.
    const _patchTryT = !!st._config.fixPatchMode;
    const _scB = getStageConfig(st._config, "test_generate");
    let tbr = null;
    let tbrText = "";
    let _patchedTb = null;
    for (let _fb = 0; _fb < (_patchTryT ? 2 : 1); _fb++) {
      let tbp = promptTBFromVerifyFail(currentTB, currentRTL, vData, st.spec, st.elicit, previousFixes, testClass, attemptRows, null, triage.reason);
      if (_patchTryT && _fb === 0) tbp = patchModeFixPrompt(tbp);
      // Regenerating TB → apply test_generate skills.
      tbp = await applySkillsToPrompt(tbp, st, "test_generate");
      tbp.config = _scB;
      tbp.maxTokens = _scB._maxTokens;
      if (tbp._patchMode) tbp.jsonSchema = PATCH_SCHEMA;
      tbp.onChunk = function(t, m) { appendLog.stream("TB Fix", t); if (st._onLog) st._onLog(appendLog.buf, m); };
      tbr = await callLLM(tbp);
      allLlms.push(Object.assign({ stage: "tb-fix-verify-" + vIter }, tbr));
      tbrText = (tbr && tbr.text) || "";
      if (tbp._patchMode) {
        let pd = null;
        try { pd = extractJSON(tbrText); } catch (_e) { pd = null; }
        const _ap = applyEdits(currentTB, pd && pd.edits);
        if (_ap.ok) {
          appendLog("Patch mode (TB fix, iter " + vIter + ")", _ap.applied + " edit(s) applied cleanly.");
          _patchedTb = {
            code: _ap.code,
            fixes: (pd.fixes || []).map(function(f) { return { test: f.test || f.id || "", desc: f.desc || "" }; }),
          };
          break;
        }
        appendLog("Patch mode fallback (TB fix, iter " + vIter + ")",
          "Edits failed to apply (" + _ap.failReason + ") — re-asking for the full file.");
        continue;
      }
      break;
    }
    const beforeTb = currentTB;
    let parsedTb = null;
    try {
      const tbd = _patchedTb || extractJSON(tbrText);
      parsedTb = tbd && typeof tbd === "object" ? tbd : null;
      if (tbd.code && tbd.code !== currentTB && detectTbInfraLoss(currentTB, tbd.code)) {
        // Architectural regression — keep the current TB (see chain path).
        tbPatchNoOp = true;
        appendLog("⛔ TB fix rejected — infrastructure lost (verify iter " + vIter + ")",
          "The candidate dropped the step()/check()/reference-model infrastructure. Keeping the current TB.");
      } else if (tbd.code && tbd.code !== currentTB) {
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
      const pairKey = currentRTL.length + ":" + currentRTL + currentTB; // length-prefixed: collision-proof, no NUL separator
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

  // Use best-known state if final isn't better. BUG FIX: best-known is tracked
  // by score = pass - 2*fail (above), so the restore must compare by the SAME
  // metric — not pass-count alone. Otherwise a final iteration that ties on
  // pass but REGRESSED on fail (e.g. 5/0 best vs a 5/3 final) was kept, leaving
  // verify reporting avoidable failures and the judge re-triaging them — extra
  // iterations for nothing.
  if (!finalVerify) finalVerify = bestVerify || vData;
  if (shouldRestoreBest(bestVerify, finalVerify)) {
    const _prev = finalVerify;
    finalVerify = bestVerify;
    currentRTL = bestRTL;
    currentTB = bestTB;
    appendLog("Best-known state restored",
      "Final iteration (" + (_prev.pass || 0) + "/" + (_prev.total || 0) + ", " + (_prev.fail || 0) + " fail) "
      + "was not the best — using iteration with " + (bestVerify.pass || 0) + "/" + (bestVerify.total || 0)
      + " passing, " + (bestVerify.fail || 0) + " fail.");
  }

  // ── Mutation gate (opt-in, config.mutationTesting) ────────────────────────
  // Only meaningful when the design PASSed on the REAL backend: a failing
  // design measures nothing, and the LLM-estimate path has no simulator to
  // run mutants on. Mutation runs are plain builds — no SVA append, no
  // --assert, no coverage — so the score measures the TESTBENCH alone, not
  // the bound formal properties. See pipeline/mutation.js for the operator
  // set and scoring rules. The result is advisory data on verify.mutation;
  // the opt-in eval criterion `mutation_score` turns it into a gate.
  //
  // TB-FIX ACCEPTANCE EVIDENCE (run 28 program): a green verify whose TB
  // CHANGED during this loop is the suspicious transition — "the tests now
  // pass" and "the oracle got weakened until it passed" look identical to
  // the pass/fail classifier. When that transition happens the gate also
  // runs under tbFixMutationCheck (default on): a changed TB that kills
  // ZERO valid mutants is flagged _oracleSuspect, and the judge downgrades
  // a PASS built on it to UNVERIFIED (same plumbing as the provenance gate).
  const _tbChangedInLoop = currentTB !== originalTB;
  if ((st._config.mutationTesting === true
        || (st._config.tbFixMutationCheck !== false && _tbChangedInLoop))
      && finalVerify.cli === true
      && (finalVerify.fail || 0) === 0
      && st._config.backendUrl) {
    try {
      const mutationCmds = (st._config.simCmds || "")
        .split("\n").filter(function(c) { return c.trim(); });
      finalVerify.mutation = await runMutationGate({
        rtl: currentRTL,
        tb: currentTB,
        cmds: mutationCmds,
        rtlFileName: rtlFileName,
        tbFileName: tbFileName,
        config: st._config,
        cliOpts: _cliOpts,
        signal: st._signal,
        appendLog: appendLog,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      // The gate is advisory — backend hiccups here must not fail a verify
      // that already passed. Log and move on; the criterion measures
      // "no data" as 0/denominator-0 (skippable).
      appendLog("⚠ Mutation gate error (non-fatal)",
        (e && e.message) || String(e));
    }
    if (_tbChangedInLoop && oracleSuspect(finalVerify.mutation)) {
      finalVerify._oracleSuspect = true;
      appendLog("⚠ ORACLE SUSPECT — changed TB kills zero mutants",
        "This verify went green after TB edits, but the resulting testbench "
        + "killed 0 of " + ((finalVerify.mutation.total || 0) - (finalVerify.mutation.invalid || 0))
        + " valid RTL mutants — a checker that cannot detect injected bugs "
        + "proves nothing. The judge will downgrade a PASS built on this to UNVERIFIED.");
    }
  }

  // ── Coverage strengthening (opt-in, config.coverageStrengthening) ─────────
  // Same gating as the mutation gate: meaningful only after a real-backend
  // PASS. When tests are green but coverage is weak (or Must/Should reqs are
  // untested), ask the LLM to ADD targeted tests; adopt the result only if it
  // provably helps (no regression + a gated metric improves). The strengthened
  // TB flows to test_generate.code via the tbOut writeback below.
  if (st._config.coverageStrengthening === true
      && finalVerify.cli === true
      && (finalVerify.fail || 0) === 0
      && st._config.backendUrl) {
    try {
      const _evalCfg = normalizeEvalConfig((st._config && st._config.evalCriteria) || {}).config;
      const _covThresholds = {};
      ["line", "branch", "toggle", "fsm", "expr"].forEach(function(k) {
        const cc = _evalCfg["coverage_" + k];
        if (cc && cc.enabled) _covThresholds[k] = cc.threshold;
      });
      // No coverage criterion gated → chase a single default line target so an
      // opted-in run still has something to improve.
      if (Object.keys(_covThresholds).length === 0) _covThresholds.line = 80;

      const _csBaseCmds = (st._config.simCmds || "").split("\n").filter(function(c) { return c.trim(); });
      const _csResult = await runCoverageStrengthening({
        rtl: currentRTL,
        tb: currentTB,
        cmds: withCoverageCmds(_csBaseCmds),
        rtlFileName: rtlFileName,
        tbFileName: tbFileName,
        spec: st.spec,
        elicit: st.elicit,
        thresholds: _covThresholds,
        config: st._config,
        cliOpts: _cliOpts,
        signal: st._signal,
        appendLog: appendLog,
        runCli: runCli,
        callLLM: callLLM,
        extractJSON: extractJSON,
      });
      finalVerify.coverageStrengthening = _csResult;
      if (_csResult.strengthened && _csResult.code) {
        currentTB = _csResult.code;   // → test_generate.code (tbOut writeback)
        if (_csResult.after && _csResult.after.cov) finalVerify.cov = _csResult.after.cov;
      }
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      appendLog("⚠ Coverage strengthening error (non-fatal)", (e && e.message) || String(e));
    }
  }

  // ── History carry-forward (fixture-replay finding): a nested verify run —
  // e.g. the tail of a judge reflow chain — used to REPLACE the outer verify
  // slot wholesale, clobbering the investigated history (run 19's final
  // checkpoint kept a bare [{iter:1}] where the 40/63 pointer-truncation
  // investigation had been). Prior entries are carried forward (tagged
  // _prior, capped) so the judge's investigation steer, triageFlipTarget,
  // and attemptRowsFromHistory keep their signal across judge reflows —
  // and the pairing semantics stay right: the prior tail's triage decision
  // meets this run's first measurement as its outcome.
  const _priorHistory = (st.verify && Array.isArray(st.verify.verifyHistory))
    ? st.verify.verifyHistory.filter(function(h) { return h && typeof h === "object"; })
        .map(function(h) { return h._prior ? h : Object.assign({}, h, { _prior: true }); })
    : [];
  const HISTORY_CARRY_CAP = 12;
  finalVerify.verifyHistory = _priorHistory.concat(verifyHistory).slice(-HISTORY_CARRY_CAP);

  // ── Run-level champion (run 28 generalization) ────────────────────────────
  // Bank the best (RTL, TB) pair ANY verify invocation of this run measured,
  // carried in the slot like verifyHistory so chain re-entries and judge
  // reflows can't lose it. The judge's shipping gate restores it when the
  // final state has fewer passing tests (judge.js). Trimmed snapshot only —
  // code + the numbers the eval gate needs, never logs/LLM ledgers.
  {
    const _priorChampion = (st.verify && st.verify.champion) || null;
    const _candChampion = {
      pass: finalVerify.pass || 0,
      total: finalVerify.total || 0,
      fail: finalVerify.fail || 0,
      // KEEP `req`. championRestoreOf writes these tests back into the verify
      // slot, and req_func_must measures per-requirement greenness from
      // test.req — dropping it silently zeroed that criterion on run 38
      // (judge iterations scored 26 with req_func_must at 40; the final
      // verdict, computed after a restore, scored 13 with it at 0, on
      // BYTE-IDENTICAL RTL and TB). Three small fields, not the whole test.
      tests: (finalVerify.tests || []).map(function(t) {
        return { name: t.name, st: t.st, req: t.req };
      }),
      rtl: currentRTL,
      tb: currentTB,
      // Compile-tier key: blocking-error count when this pair did not compile,
      // null otherwise (a compiling pair is ranked by passes, not distance).
      blocking: typeof finalVerify._blocking === "number" ? finalVerify._blocking : null,
    };
    finalVerify.champion = betterChampion(_candChampion, _priorChampion)
      ? _candChampion
      : _priorChampion;
    if (finalVerify.champion === _candChampion) {
      appendLog("Champion banked",
        "This measurement (" + _candChampion.pass + "/" + _candChampion.total
        + ") is the run's best so far — banked for the shipping gate.");
    }
  }

  // Acceptance ledger (Phase 4): attach the per-requirement spine to the verify
  // result so it persists in checkpoints (stageData is serialized wholesale)
  // and the Requirements UI / exports can read it. Cheap, pure-derived.
  try {
    const _ledgerCfg = normalizeEvalConfig((st._config && st._config.evalCriteria) || {}).config;
    finalVerify._ledger = buildLedgerForState({ spec: st.spec, verify: finalVerify }, _ledgerCfg);
  } catch (_e) { /* advisory — never fail verify on a ledger derivation */ }

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
  // Strip the raw VCD before the result is persisted — it exists for the
  // in-loop triage investigator only, and a checkpoint carrying megabytes of
  // waveform per iteration would bloat every save/restore.
  const finalVerifyOut = Object.assign({}, finalVerify);
  delete finalVerifyOut._vcdText;

  return {
    verify: finalVerifyOut,
    rtl_generate: rtlOut,
    test_generate: tbOut,
    // Full per-call LLM ledger for the Duration/Tokens tabs.
    _llms: allLlms.slice(),
    _llm: allLlms.length > 0
      ? allLlms[allLlms.length - 1]
      : { stage: "verify", tokensIn: 0, tokensOut: 0, latencyMs: 0, model: "cli", provider: "cli" },
  };
}
