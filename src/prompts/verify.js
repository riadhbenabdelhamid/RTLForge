// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/verify — Stage 8: Simulation Verification  (REVISED)
//
// promptVerify              — LLM-estimated sim result (fallback only)
// promptVerifyTriage        — root-cause classifier
// promptRTLFromVerifyFail   — fixes RTL given failing tests
// promptTBFromVerifyFail    — fixes TB given failing tests
//
// REVISION GOALS:
//   - The LLM-estimated path is a LAST RESORT. The prompt now warns the model
//     that this estimate will be marked clearly as estimated, and forbids it
//     from claiming PASS when there is no real simulator output to ground on.
//   - Triage is constrained to evidence: must point to a specific failing
//     test name and a specific cause (signal / cycle / expected vs actual).
//   - Fix prompts: error localisation first, then minimal-diff repair, with
//     external-contract preservation as a hard constraint.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j, resolveModName, patchOutcomeSection, attemptLedgerSection, cappedJson } from "./base.js";
import { extractModuleInterface } from "../utils/svInterface.js";
import { deriveLedger, unmetMustRequirements } from "../pipeline/acceptanceLedger.js";
import { hasCompileFailure } from "../pipeline/classifiers.js";

// Bug 3 (e2e convergence): when the source does not COMPILE, the verify fix
// prompt used to bury the Verilator error in a 40-line log tail under
// test-logic guidance ("timing / stimulus / expectation"), so the model fixed
// WARNINGS instead of the hard syntax error and the loop never converged. When
// a compile failure is present (the synthetic "compilation" FAIL, or a
// _compileError carried forward from lint_test), lead the prompt with the
// verbatim error and a MUST-FIX-FIRST instruction. Returns "" when it compiles.
/**
 * Waveform context (roadmap #7): the verify node attaches a compact
 * signals-over-time window around the first failure (verifyResult._waveExcerpt,
 * extracted from the sim VCD). Byte-identical prompts when absent.
 */
function waveSection(verifyResult) {
  const w = verifyResult && verifyResult._waveExcerpt;
  if (!w) return "";
  return "\n" + w + "\nUse the signal window above as ground truth for what the design actually did.\n";
}

function compileFirstSection(verifyResult) {
  const vr = verifyResult || {};
  const fromLog = hasCompileFailure(vr.tests)
    ? (vr.log || "").split("\n")
        .filter(function(l) { return /%Error|syntax error|unexpected|cannot find|exiting due to/i.test(l); })
        .slice(0, 8).join("\n")
    : "";
  const compileErr = vr._compileError || fromLog;
  if (!compileErr) return "";
  return `
⛔ DOES NOT COMPILE — FIX THIS FIRST. A non-compiling source runs zero tests, so
nothing else (timing, stimulus, expected values, warnings) matters until it
builds. Do not touch warnings or test logic until the error below is gone.

COMPILER ERROR (Verilator):
${compileErr}

COMMON CAUSE: in SystemVerilog every variable declaration inside a begin…end
block, task, function, or initial/always block MUST appear BEFORE any procedural
statement in that block. Move any stray mid-block declaration to the top of its
block.
`;
}

// Acceptance-ledger convergence target (Phase 3): a focused list of the Must
// requirements that are NOT yet green — including UNTESTED ones, which never
// appear in a failing-tests list. "" when every Must req is green, so the fix
// prompt is byte-identical when there's nothing to steer.
function acceptanceTargetSection(verifyResult, spec) {
  const tests = (verifyResult && verifyResult.tests) || [];
  const reqs = (spec && spec.requirements) || [];
  if (reqs.length === 0) return "";
  const estimated = !(verifyResult && verifyResult.cli === true);
  const compiled = !tests.some(function(t) { return t && t.name === "compilation" && t.st === "FAIL"; });
  const unmet = unmetMustRequirements(deriveLedger(reqs, tests, { estimated: estimated, compiled: compiled }));
  if (unmet.length === 0) return "";
  return "\n\nMUST REQUIREMENTS NOT YET GREEN — the convergence target (make every one pass):\n"
    + unmet.map(function(r) { return "  • " + r.id + " [" + r.status + "]: " + r.desc; }).join("\n") + "\n";
}

/** One-line label for a test result in the patch-outcome section. */
function testLabel(t) {
  return (t.name || "?") + (t.req ? " (covers " + t.req + ")" : "");
}

// Working-set curation (run 18): failing tests enter the fix prompt as
// {name, req, evidence} — not full result objects with cyc/ms noise — capped
// with an explicit omission note. Run 18 sent 21 full objects per iteration.
const FAILING_TESTS_CAP = 15;
function curatedFailingTests(failedTests) {
  return cappedJson(failedTests.map(function(t) {
    return { name: t.name, req: t.req || null, evidence: t.evidence || "" };
  }), FAILING_TESTS_CAP, "failing tests");
}

// previousFixes keeps the MOST RECENT entries (the old ones are superseded by
// the attempt ledger's one-line-per-iteration summary).
const PREV_FIXES_CAP = 8;
function cappedPrevFixes(previousFixes) {
  const a = previousFixes || [];
  if (a.length <= PREV_FIXES_CAP) return j(a);
  return "(" + (a.length - PREV_FIXES_CAP) + " earlier fixes omitted — do not revert ANY applied fix)\n"
    + j(a.slice(-PREV_FIXES_CAP));
}

// Root-cause diagnosis hand-off (run 19): the triage investigator correctly
// named the failure mechanism ("pointers truncated on update; difference
// becomes 0, preventing full assertion") — and the fix prompt never saw it.
// The diagnosis routed the chain and was then discarded, so the fixer
// re-derived the root cause from raw failing tests and didn't. This section
// carries triage's reason (investigated or not) into the fix prompt.
function diagnosisSection(diagnosis) {
  const s = String(diagnosis || "").trim();
  if (!s) return "";
  return `

ROOT-CAUSE DIAGNOSIS (from triage — verify it against the code first, then
fix THAT mechanism rather than patching symptoms test-by-test):
${s}`;
}

// Cross-run fix recipes (triageMemory.formatRecipeEvidence output): measured
// wins from past runs with this exact failure signature, retrieved at the
// decision point. "" in, "" out.
function recipesSection(priorRecipes) {
  const r = String(priorRecipes || "").trim();
  if (!r) return "";
  return `

PRIOR SUCCESSFUL FIX RECIPES (measured wins from past runs with this SAME
failure signature — strong hints, not orders):
${r}`;
}

// ---------------------------------------------------------------------------
// promptVerify — LLM-estimated simulation result (no real CLI available)
// ---------------------------------------------------------------------------

export function promptVerify(tb, rtl, spec) {
  const tbSnippet  = tb.split('\n').slice(0,  80).join('\n');
  const rtlSnippet = rtl.split('\n').slice(0, 60).join('\n');

  const mustReqs = (spec.requirements || [])
    .filter(function(r) { return r.pri === 'Must'; })
    .map(function(r) { return r.id; });

  const schema = `{
  "sim":   "Verilator (AI-estimated — NOT a real simulation)",
  "estimated": true,
  "total": <int>,
  "pass":  <int>,
  "fail":  <int>,
  "cov":   { "line": <0-100>, "branch": <0-100>, "toggle": <0-100>, "_estimated": true },
  "tests": [
    { "name": "test_<id>", "req": "<REQ-ID>", "st": "PASS | FAIL", "cyc": <int>, "ms": 0,
      "evidence": "<one-line: which TB lines and which RTL lines you matched>" }
  ],
  "log": "<one [PASS] or [FAIL] line per test, joined with \\n>"
}`;

  return {
    systemPrompt: sys(
      'IMPORTANT: there is NO real simulator running. You are producing a ' +
      'best-effort estimate that will be flagged as such in the UI. Be ' +
      'conservative — when in doubt, mark a test FAIL and explain why.'
    ),
    maxTokens: 3000,
    userMessage: `\
TASK: Estimate what would happen if the testbench below were run against the
RTL below in Verilator. The result will be clearly marked "AI-estimated".

RTL (first 60 lines):
${rtlSnippet}

TESTBENCH (first 80 lines):
${tbSnippet}

MUST REQUIREMENTS UNDER TEST: ${j(mustReqs)}

ESTIMATION RULES — every item is mandatory:
1. Test names: derive ONLY from \`task automatic test_<id>(...)\` declarations
   actually present in the testbench. Do NOT invent test names.
2. \`total\` = number of those test tasks. \`pass + fail == total\` exactly.
3. PASS criterion: you can match each check(cond, label) call in the task to a
   plausibly-correct RTL behaviour. If you cannot, the test is FAIL.
4. \`evidence\` is one sentence per test: which TB lines were checked and
   which RTL lines satisfy them.
5. Coverage is ALWAYS estimated; mark with \`_estimated: true\`. Use
   conservative numbers: line ≤ 90, branch ≤ 80, toggle ≤ 70 unless you can
   point to specific reasons for higher coverage.
6. \`log\` lists one [PASS] or [FAIL] line per test, in the same order as
   \`tests\`, ending with [SUMMARY] passes=N fails=M.

CONSERVATIVE-FAIL RULE:
• If the testbench expects a specific cycle of latency and you cannot
  determine that latency from the RTL, mark FAIL.
• If the testbench drives stimulus while the DUT is in reset, mark FAIL.
• If the testbench depends on signals not actually present in the RTL ports,
  mark FAIL.

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

// ---------------------------------------------------------------------------
// promptVerifyTriage — Root-cause classifier
// ---------------------------------------------------------------------------

export function promptVerifyTriage(verifyResult, spec, el) {
  const modName = resolveModName(el, spec);
  return {
    systemPrompt: sys(),
    maxTokens: 800,
    userMessage: `\
TASK: Classify the root cause of simulation failures for "${modName}".

FAILED TESTS:
${j((verifyResult.tests || []).filter(function(t) { return t.st === "FAIL"; }).map(function(t) { return { name: t.name, req: t.req, evidence: t.evidence || "" }; }))}

SIMULATION LOG (tail):
${(verifyResult.log || "").split("\n").slice(-30).join("\n")}

REQUIREMENTS:
${j((spec.requirements || []).map(function(r) { return r.id + ": " + r.desc; }))}

DECISION RULES — choose the SINGLE most likely root cause:

A) "test_generate" — pick this if:
   • The TB drives stimulus that violates the spec's interface contract
     (e.g. asserts data while reset is active), OR
   • The TB checks at the wrong cycle (registered output read combinationally), OR
   • The TB's expected value is computed incorrectly.

B) "rtl_generate" — pick this if:
   • The DUT clearly produces the wrong output for spec-compliant stimulus, OR
   • A required port is missing or wrong-width, OR
   • A reset value is wrong.

C) "spec" — pick ONLY if:
   • Two or more requirements contradict each other and no single
     RTL/TB can satisfy them all.

OUTPUT — return exactly:
{"target":"test_generate|rtl_generate|spec","reason":"<one sentence pointing to a specific test, cycle, signal, or REQ-ID>"}

If you cannot be confident, prefer "test_generate" (cheapest fix).`,
  };
}

// ---------------------------------------------------------------------------
// promptRTLFromVerifyFail — Fix RTL given a failing simulation
// ---------------------------------------------------------------------------

/**
 * @param {object|null} lastPatchOutcome  classifyTestResults result from the
 *        previous fix iteration (resolved/persisting/introduced test names vs
 *        the original baseline), or null on the first attempt. Lets the model
 *        see which tests its last edit fixed/broke instead of re-trying a
 *        strategy that already failed.
 */
/**
 * @param {Array|null} attemptHistory  compact rows for attemptLedgerSection
 *        ({iter, target, pass, total, decision, flipped}), or null. One line
 *        per completed fix iteration so the model sees measured outcomes
 *        without re-deriving them from accumulated fix lists.
 *
 * PROMPT LAYOUT (run 18 working-set curation): compile error first when
 * present (bug 3 — measured, position-pinned by test), then the STATIC
 * instruction block (rules/checklist — identical every iteration), then the
 * per-run-stable requirements, then all VOLATILE per-iteration material
 * (code, failures, logs, ledger) last. Static-prefix ordering lets local
 * servers (LM Studio/llama.cpp, Ollama) reuse prefix KV state across fix
 * iterations — the loops that dominate run wall-clock — and keeps the
 * load-bearing rules at an attention edge instead of buried mid-prompt.
 */
export function promptRTLFromVerifyFail(code, verifyResult, spec, el, previousFixes, lastPatchOutcome, attemptHistory, priorRecipes, diagnosis) {
  const modName = resolveModName(el, spec);
  const failedTests = (verifyResult.tests || []).filter(function(t) { return t.st === "FAIL"; });
  const outcomeSection = patchOutcomeSection(lastPatchOutcome, testLabel);
  const ledgerSection = attemptLedgerSection(attemptHistory);
  const recipeSection = recipesSection(priorRecipes);
  const diagSection = diagnosisSection(diagnosis);
  // Thread previousFixes context into the RTL fix prompt so the LLM has memory
  // of fixes already applied across iterations. Without this,
  // each iteration starts fresh and the model can re-apply (or revert) its
  // own prior fixes — the same non-monotonic behaviour the lint stage's
  // promptRTLFix guards against.
  const prevSection = (previousFixes && previousFixes.length > 0) ? `

PREVIOUSLY APPLIED FIXES (do NOT revert these):
${cappedPrevFixes(previousFixes)}

NON-MONOTONIC POLICY:
• Fixing one failing test may REVEAL new failures in adjacent logic. That
  is acceptable progress.
• A REGRESSION is: previously-passing tests now failing, syntax errors, or
  reverting a fix from the list above.` : '';
  return {
    systemPrompt:
      'You are RTL Forge. Respond ONLY with JSON: ' +
      '{"code":"<fixed SystemVerilog>","fixes":[{"test":"<test name>","desc":"<minimal change>"}]}',
    maxTokens: 8000,
    userMessage: `\
${compileFirstSection(verifyResult)}TASK: Repair the "${modName}" RTL so the listed failing tests pass —
without changing the module's external contract.

LOCALISATION FIRST (before editing):
0. When a ROOT-CAUSE DIAGNOSIS section is present below, verify it against
   the code and failing tests FIRST — it is grounded in observed simulation
   evidence — and prefer one edit that fixes THAT mechanism.
1. For each failing test, identify the specific RTL signal or block that
   produces the wrong value. When a failing test carries an \`evidence\`
   field ("expected=… actual=…"), those are MEASURED values from the run —
   anchor the fix to the exact mechanism that reconciles those two numbers.
2. Confirm the spec actually requires what the test expects (otherwise the
   bug is in the TB or spec — but at this point we are committed to RTL).
3. Form the smallest possible code edit that flips the failing test to PASS.

FIX RULES:
1. EVERY entry in \`fixes\` references a failing test name. No invented fixes.
2. EXTERNAL CONTRACT PRESERVATION (hard): module name, port list, directions,
   widths, parameter names/types/defaults all unchanged.
3. PRESERVE PASSING TESTS: do not change logic that the passing tests cover.
4. SINGLE-DRIVER, RESET-VALUE, NO-LATCH preservation.
5. MINIMAL-DIFF: change only the lines needed.
6. NO NEW FUNCTIONALITY beyond what the failing tests require.

VERIFICATION CHECKLIST:
[ ] Every failing test name is referenced in \`fixes\`.
[ ] No port/parameter changed.
[ ] No new always_comb path that fails to assign one of its outputs.
[ ] No \`X\` introduced in reset values.

REQUIREMENTS:
${j((spec.requirements || []).map(function(r) { return { id: r.id, pri: r.pri, desc: r.desc }; }))}

CURRENT RTL:
${code}

FAILING TESTS (${failedTests.length}):
${curatedFailingTests(failedTests)}${diagSection}

SIMULATION LOG (tail):
${(verifyResult.log || "").split("\n").slice(-40).join("\n")}${acceptanceTargetSection(verifyResult, spec)}${waveSection(verifyResult)}${ledgerSection}${recipeSection}${prevSection}${outcomeSection}

Return {"code":"<complete fixed module>","fixes":[{"test":"<name>","desc":"<change>"}]}.`,
  };
}

// ---------------------------------------------------------------------------
// promptTBFromVerifyFail — Fix testbench given a failing simulation
// ---------------------------------------------------------------------------

/**
 * @param {object|null} lastPatchOutcome  classifyTestResults result from the
 *        previous fix iteration, or null — see promptRTLFromVerifyFail.
 */
export function promptTBFromVerifyFail(tbCode, rtlCode, verifyResult, spec, el, previousFixes, lastPatchOutcome, attemptHistory, priorRecipes, diagnosis) {
  const failedTests = (verifyResult.tests || []).filter(function(t) { return t.st === "FAIL"; });
  const outcomeSection = patchOutcomeSection(lastPatchOutcome, testLabel);
  const ledgerSection = attemptLedgerSection(attemptHistory);
  const recipeSection = recipesSection(priorRecipes);
  const diagSection = diagnosisSection(diagnosis);

  // ── Anti-self-confirmation guard (fix path) ───────────────────────────────
  // Triage already decided the TESTBENCH is at fault here, so the repair must
  // align the TB with the SPEC — not with the DUT. If this prompt showed the
  // implementation, the cheapest "fix" would be adjusting the TB's expected
  // values to whatever the (possibly buggy) RTL produces, converting RTL bugs
  // into "expected behavior". We pass the module header only (instantiation
  // ground truth) and the spec requirements (expected-value ground truth).
  const dutInterface = extractModuleInterface(rtlCode || "", resolveModName(el, spec));
  const reqTable = j(((spec && spec.requirements) || []).map(function(r) {
    return { id: r.id, desc: r.desc, pri: r.pri };
  }));
  // Thread previousFixes through the TB fix prompt for the same
  // non-monotonic-policy reason as the RTL fix prompt above.
  const prevSection = (previousFixes && previousFixes.length > 0) ? `

PREVIOUSLY APPLIED FIXES (do NOT revert these):
${cappedPrevFixes(previousFixes)}

NON-MONOTONIC POLICY:
• Fixing one TB issue may reveal new ones (e.g. a stimulus timing fix
  exposes a missing reset assertion). That is acceptable progress.
• A REGRESSION is: removing a test_<id>() task, removing a covers
  annotation, or reverting a fix from the list above.` : '';
  return {
    systemPrompt:
      'You are RTL Forge. Respond ONLY with JSON: ' +
      '{"code":"<fixed testbench>","fixes":[{"test":"<test name>","desc":"<minimal change>"}]}',
    maxTokens: 8000,
    userMessage: `\
${compileFirstSection(verifyResult)}TASK: Repair the testbench so the listed failing tests correctly exercise
the DUT and pass — without reducing coverage.

LOCALISATION FIRST:
0. When a ROOT-CAUSE DIAGNOSIS section is present below, verify it against
   the testbench and failing tests FIRST — it is grounded in observed
   simulation evidence — and prefer one edit that fixes THAT mechanism.
1. For each failing test, identify whether the cause is timing (wrong cycle),
   stimulus (wrong driving sequence), or expectation (wrong reference value).
   When a failing test carries an \`evidence\` field ("expected=… actual=…"),
   those are MEASURED values from the run — anchor the fix to the exact
   mechanism that reconciles those two numbers.
2. Form the smallest possible TB edit that fixes the issue.

FIX RULES:
1. EVERY entry in \`fixes\` references a failing test name.
2. NEVER REDUCE COVERAGE: every Must requirement still has a \`test_<id>()\`
   task with \`// covers: <REQ-ID>\` on its first line.
3. PRESERVE INFRASTRUCTURE: watchdog, [SUMMARY] line, pass/fail counters,
   final \$finish-with-exitcode all unchanged.
4. NO \$error / \$fatal / raw assert-with-error escape — keep using CHECK.
5. KEEP THE DUT INSTANCE UNCHANGED (RTL contract is fixed at this point).
6. MINIMAL-DIFF.

SPEC REQUIREMENTS (source of truth for expected values):
${reqTable}

DUT INTERFACE (header only — implementation withheld; judge expected values
from the SPEC REQUIREMENTS above, never from observed DUT behavior):
${dutInterface || "(module header could not be extracted — keep the existing DUT instantiation unchanged)"}

CURRENT TESTBENCH:
${tbCode}

FAILING TESTS (${failedTests.length}):
${curatedFailingTests(failedTests)}${diagSection}

SIMULATION LOG (tail):
${(verifyResult.log || "").split("\n").slice(-40).join("\n")}${acceptanceTargetSection(verifyResult, spec)}${waveSection(verifyResult)}${ledgerSection}${recipeSection}${prevSection}${outcomeSection}

Return {"code":"<complete testbench>","fixes":[{"test":"<name>","desc":"<change>"}]}.`,
  };
}
