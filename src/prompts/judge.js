// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/judge — Stage 9: Final Quality Gate  (REVISED)
//
// promptJudge       — produces overall pass/fail verdict with traceability
// promptJudgeTriage — picks the earliest stage to fix when verdict is FAIL
//
// REVISION GOALS (vs. previous version):
//   - Scoring rubric integrates the new Lint Test stage. The previous
//     rubric only checked `lint.status` (RTL lint); a TB that fails Lint
//     Test could still pass the judge. New rubric awards points for both
//     and the verdict gate requires both to be PASS.
//   - Trace completeness rule made stricter: the trace must contain one
//     entry per Must requirement, and `ok: true` requires evidence that
//     SOME test (by name) covered it — not just that the testbench
//     contained the right `// covers:` annotation.
//   - Verdict gate now explicit: it's a *conjunction* of three conditions
//     (score, lint, traceability), not the model's discretion.
//   - Recommendations get an explicit forbidden-words list so the model
//     stops emitting generic "improve coverage" advice.
//   - Triage prompt now requires evidence (specific failing test, requirement
//     id) for the chosen target. Adds a fallback rule for ambiguous cases:
//     when uncertain, prefer the cheapest stage to fix (test_generate).
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j } from "./base.js";

// ---------------------------------------------------------------------------
// promptJudge — Final quality-gate verdict
// ---------------------------------------------------------------------------

export function promptJudge(state) {
  const fp       = state.formal_props || {};
  const maxLint  = (state._config && state._config.maxLintIters) || 3;

  const lintInfo = state.lint
    ? `${state.lint.status} (iteration ${state.lint.iteration || 1}/${maxLint}, `
      + `${(state.lint.errors || []).length} errors, `
      + `${(state.lint.warnings || []).length} warnings)`
    : 'N/A';

  // New: surface lint_test status alongside RTL lint
  const lintTestInfo = state.lint_test
    ? `${state.lint_test.status} (iteration ${state.lint_test.iteration || 1}/${maxLint}, `
      + `${(state.lint_test.errors || []).length} errors, `
      + `${(state.lint_test.warnings || []).length} warnings)`
    : 'SKIPPED';

  const verifyInfo = state.verify
    ? `${state.verify.pass}/${state.verify.total} tests passed; `
      + `line coverage ${state.verify.cov && state.verify.cov.line != null ? state.verify.cov.line : '?'}%; `
      + `branch coverage ${state.verify.cov && state.verify.cov.branch != null ? state.verify.cov.branch : '?'}%`
    : 'N/A';

  // Surface test names from verify.tests so the trace can cite real tests
  const testNames = ((state.verify && state.verify.tests) || [])
    .map(function(t) { return { name: t.name, st: t.st, req: t.req || "" }; });

  const schema = `{
  "overall": "PASS | FAIL",
  "score":   82,
  "trace": [
    { "req": "REQ-INTF-001", "ok": true,  "test": "test_intf_001", "note": "<one-sentence justification>" },
    { "req": "REQ-FUNC-002", "ok": false, "test": null,            "note": "<reason for failure>" }
  ],
  "recs": [
    "<specific, actionable, ≤ 25-word recommendation>"
  ]
}`;

  // state.elicit may be absent (a project resumed without elicit data, or one
  // where elicit was cleared). Fall back to spec, then to "module".
  const _el = (state && state.elicit) || {};
  const _modName =
    _el.modName ||
    (state && state.spec && (state.spec.modName || state.spec.moduleName)) ||
    "module";

  return {
    systemPrompt: sys(),
    maxTokens: 3000,
    userMessage: `\
TASK: Produce a final quality-gate verdict for the "${_modName}"
design flow. Be strict — downstream consumers treat PASS as a green light
to integrate.

EVIDENCE SUMMARY:
• Requirements    : ${j((state.spec.requirements || []).map(function(r) { return r.id + " [" + r.pri + "]: " + r.desc; }))}
• Lint RTL        : ${lintInfo}
• Lint Test       : ${lintTestInfo}
• Formal props    : ${(fp.properties || []).length} assertions, ${(fp.covers || []).length} cover statements
• Simulation      : ${verifyInfo}
• Tests run       : ${j(testNames)}

SCORING RUBRIC (mechanical — sum the categories that apply):

  RTL LINT:
    +20  Lint RTL PASS on first iteration with 0 errors and 0 warnings
    +15  Lint RTL PASS on first iteration with 0 errors but ≥1 warnings
    +10  Lint RTL PASS after fix iterations
     0   Lint RTL FAIL
    (Pick the highest applicable.)

  TB LINT:
    +10  Lint Test PASS (or stage skipped — counts as best-effort)
     0   Lint Test FAIL
    (If Lint Test was skipped — lint_test info is "SKIPPED" — award the
    full +10 only if Verify passed all tests; otherwise award 0.)

  REQUIREMENT COVERAGE:
    +25  Every Must requirement has a passing test (verify.tests with st="PASS"
         and matching req id)
    +12  ≥80% of Must requirements have a passing test
     0   <80% of Must requirements covered

  FORMAL PROPERTIES:
    +10  ≥1 SVA assertion exists per Must requirement
    +5   Some SVA assertions exist but coverage incomplete
     0   No SVA assertions

  SIMULATION:
    +20  100% test pass rate (verify.fail == 0 AND verify.total > 0)
    +10  ≥90% pass rate
     0   <90% pass rate

  COVERAGE:
    +10  Line coverage ≥ 90% AND branch coverage ≥ 80%
    +5   Line coverage 75-89% OR branch coverage 70-79%
     0   Below those thresholds, OR coverage marked _estimated

  FORMAL COVERAGE:
    +5   ≥3 cover statements present
     0   Fewer

  Sum the categories — maximum score is 100.

VERDICT RULE — overall is "PASS" iff ALL of:
  1. score ≥ 70, AND
  2. state.lint.status === "PASS" (RTL lint clean), AND
  3. (state.lint_test == null OR state.lint_test.status === "PASS") (TB
     lint clean OR stage skipped), AND
  4. Every Must requirement appears in trace with ok:true AND a non-null
     test name that exists in the simulation Tests run list.
Otherwise overall is "FAIL".

TRACE RULES:
• trace contains EXACTLY ONE entry per requirement id from the EVIDENCE
  SUMMARY. No omissions. No duplicates.
• \`ok\` is true iff a test in "Tests run" with status "PASS" has \`req\`
  matching this requirement id. The model does not award ok:true on the
  basis of "the testbench probably covers it" — only on real test results.
• \`test\` is the name of the test that covered the requirement, or null
  if no such test ran.
• \`note\` is one sentence:
    - For ok:true: cite the specific test name and what it verified.
    - For ok:false: state whether the gap is in test (no test exists),
      RTL (test exists but failed because RTL is wrong), or spec (test
      exists, would pass except the requirement is ambiguous).

RECOMMENDATION RULES:
• 2–5 recommendations. Specific and actionable. ≤ 25 words each.
• Each cites a specific requirement id, test name, signal, or coverage
  number where applicable.
• Forbidden words/phrases (will be rejected as generic):
    "improve quality", "more robust", "enhance", "consider adding",
    "increase coverage" (unless followed by a specific number),
    "add more tests" (unless naming the gap),
    "review the code", "ensure correctness".
  Good example: "Add a test_overflow task covering REQ-FUNC-003 (write
  when full=1); current coverage is 0 cycles."
  Bad example:  "Improve test coverage and add more edge cases."

SELF-CHECK (mental, before emit):
[ ] Score arithmetic — write each category's contribution and sum.
[ ] Trace has one entry per Must requirement.
[ ] Every \`test\` in trace is a real entry from "Tests run" or null.
[ ] Verdict gate evaluated as a conjunction, not by score alone.
[ ] No forbidden words in recommendations.

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

// ---------------------------------------------------------------------------
// promptJudgeTriage — Earliest-stage classifier for unvalidated requirements
// ---------------------------------------------------------------------------

export function promptJudgeTriage(judgeResult, spec, el) {
  const unmet = (judgeResult.trace || []).filter(function(t) { return !t.ok; });
  // el may be undefined (called from judge.js, which may not have full elicit
  // state). Same guard pattern as above.
  const _el = el || {};
  const _modName =
    _el.modName ||
    (spec && (spec.modName || spec.moduleName)) ||
    "module";
  return {
    systemPrompt: sys(),
    maxTokens: 800,
    userMessage: `\
TASK: Pick the EARLIEST stage that, if re-run, has the best chance of
covering the unvalidated requirements for "${_modName}".

UNVALIDATED REQUIREMENTS:
${j(unmet.map(function(t) { return { req: t.req, test: t.test, note: t.note }; }))}

ALL REQUIREMENTS:
${j((spec.requirements || []).map(function(r) { return r.id + " [" + r.pri + "]: " + r.desc; }))}

JUDGE SCORE: ${judgeResult.score} — ${judgeResult.overall}

DECISION RULES — read \`note\` for each unvalidated entry. Choose the
SINGLE most likely root cause:

A) "test_generate" — pick this if any of:
   • An unvalidated requirement has \`test: null\` (no test exists).
   • The note says the test exists but checks the wrong thing or at the
     wrong cycle.
   • Multiple unvalidated requirements share the symptom "test missing".
   This is the cheapest stage to re-run, so prefer it when ambiguous.

B) "rtl_generate" — pick this if any of:
   • An unvalidated requirement has a test_NAME but the note explicitly
     states the RTL produced the wrong output for spec-compliant stimulus.
   • The unvalidated requirement is interface-related (port missing,
     wrong width, wrong direction) — the RTL contract is broken.

C) "spec" — pick ONLY if:
   • Two or more unvalidated requirements contradict each other and no
     RTL+TB combination could satisfy them all.
   • The note explicitly cites ambiguity in the requirement text.

EVIDENCE REQUIREMENT:
The \`reason\` field MUST cite at least one specific unvalidated
requirement id and one concrete symptom from its note. No generic reasons
like "tests are weak" or "RTL needs improvement".

RETURN exactly this JSON:
{"target":"test_generate|rtl_generate|spec","reason":"<one sentence citing a REQ-ID and a concrete symptom>"}`,
  };
}
