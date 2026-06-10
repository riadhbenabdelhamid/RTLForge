// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/testReview — Stage 7b: Optional Testbench Review  (REVISED)
//
// promptTestReview     — LLM reviews testbench for coverage and correctness
// promptTestReviewFix  — LLM fixes critical/major issues from the review
//
// REVISION GOALS:
//   - Make coverage pass mechanical: produce explicit must_reqs_total /
//     must_reqs_covered counts so downstream tooling can gate on them.
//   - Force evidence-based issue reporting (line + identifier).
//   - Forbid "improvements" that reduce test coverage or remove assertions.
//   - Match the pattern enforced by the new testGen prompt: every Must
//     requirement should have a `test_<id>()` task and a // covers: <ID>
//     annotation; the review now actively checks for both.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j, resolveModName } from "./base.js";

export function promptTestReview(tbCode, rtlCode, spec, el) {
  const modName = resolveModName(el, spec);
  const schema = `{
  "verdict": "PASS | NEEDS_FIX",
  "score":   0-100,
  "coverage_assessment": {
    "must_reqs_total":    <int>,
    "must_reqs_covered":  <int>,
    "missing_reqs":       ["<REQ-ID with no test>"],
    "covers_annotations_ok": true | false,
    "edge_cases_tested":   ["<short list>"],
    "edge_cases_missing":  ["<short list>"]
  },
  "infrastructure": {
    "uses_pass_fail_markers": true | false,
    "watchdog_present":       true | false,
    "summary_line_present":   true | false,
    "uses_disallowed_calls":  ["<\\$error|\\$fatal|...>"]
  },
  "issues": [
    {
      "id":          "TR-001",
      "severity":    "critical | major | minor | suggestion",
      "category":    "coverage | stimulus | timing | assertions | infrastructure | documentation",
      "line":        <int or null>,
      "task":        "<task or block name or empty>",
      "description": "<one-sentence problem statement>",
      "fix":         "<one-sentence suggestion>"
    }
  ],
  "strengths": ["<positive observations>"],
  "summary":   "<2-3 sentence executive summary>"
}`;

  const mustReqs = (spec.requirements || []).filter(function(r) { return r.pri === "Must"; });

  return {
    systemPrompt: sys(
      'You are a senior verification engineer reviewing a SystemVerilog testbench. ' +
      'Be precise. Cite line numbers and task names. Do not invent issues.'
    ),
    maxTokens: 6000,
    userMessage: `\
TASK: Review the testbench for "${modName}" against the spec and produce a
structured assessment.

TESTBENCH SOURCE:
${tbCode}

RTL UNDER TEST (first 80 lines for context):
${(rtlCode || "").split("\n").slice(0, 80).join("\n")}

MUST-PRIORITY REQUIREMENTS (every one needs a test):
${j(mustReqs.map(function(r) { return { id: r.id, desc: r.desc }; }))}

REVIEW PASSES — perform every pass:

PASS A — REQUIREMENT COVERAGE
• Count Must requirements that have BOTH a \`test_<id>()\` task AND a matching
  \`// covers: <REQ-ID>\` annotation in that task. That count goes in
  \`must_reqs_covered\`. The total goes in \`must_reqs_total\`.
• If a requirement is annotated as "[skipped]" by the TB (e.g. internal-only),
  count it as covered but list it under "skipped" in description of one issue
  with severity "suggestion".
• Set \`covers_annotations_ok\` true iff every test task has a \`// covers:\` line.

PASS B — INFRASTRUCTURE
• \`uses_pass_fail_markers\` true iff the TB only emits \`[PASS]\`/\`[FAIL]\` via the
  CHECK macro (or equivalent) — never via raw \$display in tests.
• \`watchdog_present\` true iff there is an absolute-time watchdog that calls
  \$finish(1) on timeout.
• \`summary_line_present\` true iff there is a final \`[SUMMARY] passes=… fails=…\`
  print, followed by a \$finish whose exit code reflects fails.
• \`uses_disallowed_calls\` lists any of: \$error, \$fatal, raw \`assert ... else
  $error\`, \`#delay\` in initial blocks for stimulus pacing, \$random.

PASS C — STIMULUS QUALITY
• Reset duration adequate (≥ 4 cycles).
• Clock period defined as a localparam, not a hardcoded number.
• Edge cases at least attempted: zero, max, full/empty, reset-during-op,
  back-pressure if applicable. Each one tested goes in \`edge_cases_tested\`.

PASS D — ASSERTIONS & CHECKING
• Each CHECK fires at the right time (after registered outputs settle —
  one cycle of margin minimum).
• Expected values are computed in the TB, not hardcoded magic numbers.

EVIDENCE RULES:
• \`line\` is an integer pointing into TESTBENCH SOURCE, or null only if the
  issue is whole-TB (e.g. "missing watchdog").
• \`task\` names a task or initial block, or "".
• \`description\` states the problem; \`fix\` is one sentence.

SCORING (apply mechanically):
  Start: 100.
  − 12 per missing Must requirement.
  − 8 per critical or major issue.
  − 2 per minor.
  − 5 if watchdog absent.
  − 5 if disallowed calls present.
  Clamp to [0,100].

VERDICT RULE: "PASS" iff
  score ≥ 75 AND
  must_reqs_covered == must_reqs_total AND
  uses_pass_fail_markers AND watchdog_present AND summary_line_present.
Otherwise "NEEDS_FIX".

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

export function promptTestReviewFix(tbCode, rtlCode, reviewResult, spec, el) {
  const modName = resolveModName(el, spec);
  const issues = (reviewResult.issues || []).filter(function(i) {
    return i.severity === "critical" || i.severity === "major";
  });
  return {
    systemPrompt:
      'You are RTL Forge. Respond ONLY with JSON: ' +
      '{"code":"<fixed testbench source>","fixes":[{"id":"<TR id>","desc":"<minimal change>"}]}',
    maxTokens: 10000,
    userMessage: `\
TASK: Fix the listed issues in the testbench for "${modName}" without
reducing coverage.

CURRENT TESTBENCH:
${tbCode}

ISSUES TO FIX (${issues.length} critical/major):
${j(issues)}

RTL UNDER TEST (first 60 lines for reference):
${(rtlCode || "").split("\n").slice(0, 60).join("\n")}

MUST REQUIREMENTS:
${j((spec.requirements || []).filter(function(r) { return r.pri === "Must"; }).map(function(r) { return { id: r.id, desc: r.desc }; }))}

FIX RULES:
1. EVERY entry in \`fixes\` references an issue \`id\`. No invented fixes.
2. NEVER REDUCE COVERAGE: every Must requirement must still have a
   \`test_<id>()\` task with \`// covers: <REQ-ID>\` on its first line.
3. PRESERVE INFRASTRUCTURE: keep the watchdog, the [SUMMARY] line, the
   pass/fail counters, and the final \$finish-with-exitcode.
4. KEEP DUT INSTANCE PORTS UNCHANGED (the DUT external contract is fixed).
5. NO \$error / \$fatal / raw assert-with-error escape — keep using CHECK or
   equivalent.
6. MINIMAL-DIFF: change only what is required to fix listed issues.
7. ADDITIVE-ONLY for coverage: if an issue says "missing edge case for X",
   ADD a new test task or extend an existing one. Do not rewrite passing tests.

VERIFICATION CHECKLIST:
[ ] Every issue id appears in \`fixes\`.
[ ] Every Must requirement still has a test task and // covers annotation.
[ ] Watchdog, [SUMMARY] line, and \$finish exit-code logic intact.
[ ] No new disallowed calls.

Return {"code":"<complete testbench>","fixes":[{"id":"TR-NNN","desc":"<change>"}]}.`,
  };
}
