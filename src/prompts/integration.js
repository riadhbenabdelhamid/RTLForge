// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/integration — Integration Pipeline Prompts (Step 10)
//
// promptIntegrationLint  — cross-module wiring check (int_lint stage)
// promptSystemTB         — top-level testbench generation (int_test stage)
// promptIntegrationJudge — system-level verdict (int_judge stage)
//
// Used by runIntegrationPipeline() after all per-module pipelines complete
// in multi-module systems. Iterates through INT_STAGES from constants/stages.js.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j } from "./base.js";

// ---------------------------------------------------------------------------
// promptIntegrationLint — Cross-module wiring check
// ---------------------------------------------------------------------------

export function promptIntegrationLint(topRTL, childRTLs, sharedPkg, instances) {
  return {
    systemPrompt: sys(),
    maxTokens: 4000,
    userMessage: `\
TASK: Perform cross-module integration lint on the system RTL.

TOP MODULE RTL:
${topRTL}

CHILD MODULE INTERFACES (headers only — port/param declarations are
authoritative; bodies are withheld on purpose, and full sources are checked
by real tooling separately):
${j(childRTLs)}

INSTANCES:
${j(instances)}

${sharedPkg ? "SHARED PACKAGE:\n" + sharedPkg.split("\n").slice(0, 20).join("\n") : "No shared package."}

CHECK THE FOLLOWING:
1. Every instance in the instance map is actually instantiated in the top RTL.
2. Port widths at instantiation sites match the child module's port declarations \
   (accounting for paramOverrides).
3. No child port is left unconnected.
4. Parameter override values are within the child module's declared ranges.
5. Signal naming consistency between parent wires and child port connections.

Return JSON:
{
  "status": "PASS | FAIL",
  "issues": [
    {
      "type": "WIDTH_MISMATCH | UNCONNECTED | PARAM_RANGE | MISSING_INSTANCE | NAMING",
      "module": "<modId>",
      "instance": "<instId>",
      "signal": "<signal name>",
      "msg": "<description>",
      "sev": "error | warning"
    }
  ],
  "summary": "<one line>"
}

RULES:
• status is "PASS" only if there are zero errors (warnings are OK).
• Do not invent issues that cannot be verified from the RTL provided.
• Be thorough but precise.`,
  };
}

// ---------------------------------------------------------------------------
// promptSystemTB — Top-level system testbench generation
// ---------------------------------------------------------------------------

export function promptSystemTB(topRTL, spec, instances, interconnects, topModName) {
  var tbModName = (topModName || "system_top") + "_tb";
  return {
    systemPrompt: 'You are RTL Forge, a SystemVerilog verification expert. ' +
      'Respond with ONLY a JSON object: {"code":"<testbench source>"}. ' +
      'No markdown. No preamble. Use \\n for newlines inside the string.',
    maxTokens: 8000,
    userMessage: `\
TASK: Generate a top-level system testbench that exercises the entire \
module hierarchy through the top module's ports.

TOP MODULE RTL:
${topRTL}

TOP MODULE SPEC:
${j({ iface: spec.iface, params: spec.params, requirements: (spec.requirements || []).filter(function(r) { return r.pri === "Must"; }).map(function(r) { return { id: r.id, desc: r.desc }; }) })}

INSTANCES IN THE SYSTEM:
${j(instances)}

INTERCONNECTS:
${j(interconnects || [])}

TESTBENCH REQUIREMENTS:
1. Module name: ${tbModName}
2. Instantiate the top module with default parameters.
3. Clock: 10ns period. Reset: active-low, 4 cycles.
4. Timeout watchdog: 50,000 cycles.
5. Write at least one directed test per interconnect — verify that data \
   flows end-to-end through the path described.
6. If multiple instances of the same module exist with different parameters, \
   test at least one scenario that exercises each unique configuration.
7. Use [PASS]/[FAIL] display format.
8. End with $finish and a summary.

Return {"code":"<complete testbench source>"}.`,
  };
}

// ---------------------------------------------------------------------------
// promptIntegrationJudge — System-level integration verdict
// ---------------------------------------------------------------------------

export function promptIntegrationJudge(intLint, intVerify, perModuleJudges) {
  return {
    systemPrompt: sys(),
    maxTokens: 3000,
    userMessage: `\
TASK: Produce a system-level integration verdict.

INTEGRATION LINT:
${j({ status: intLint.status, issueCount: (intLint.issues || []).length, summary: intLint.summary })}

SYSTEM TESTBENCH RESULTS:
${intVerify ? j({ pass: intVerify.pass, total: intVerify.total, fail: intVerify.fail }) : "N/A"}

PER-MODULE JUDGE SCORES:
${j(perModuleJudges)}

SCORING (for your understanding — the score and verdict are COMPUTED from the
measurements above, not taken from your reply, so do not spend effort on the
arithmetic):

  Each component scores its BEST matching tier; the tiers are alternatives,
  not additions. A component that does not apply to this design is removed
  from the denominator rather than counted as a loss.

  Integration lint      35   no errors and no warnings
                        21   warnings only
                         0   any error, or lint did not run
  System testbench      35   every check passing
                        21   at least 80% passing
                         0   below 80%, or no results
  Per-module judges     25   every module judged PASS
                        15   every module scoring at least 70
                         0   otherwise
  Shared package         5   present when the modules import one
                         0   modules import one and it is absent
                         n/a no module imports a package

  VERDICT is PASS only when the score reaches 70 AND integration lint ran with
  no errors AND every module individually passed.

Your job is the part measurement cannot do: name what is actually wrong or
weak about this integration, and say what to do about it. Report the score and
verdict as you read them, and if you believe the measurements are misleading,
say so in integrationIssues — a disagreement between your reading and the
computed one is recorded rather than discarded.

Return JSON:
{
  "overall": "PASS | FAIL",
  "score": 0-100,
  "moduleScores": [ { "modId": "...", "score": 82, "ok": true } ],
  "integrationIssues": [ "..." ],
  "recs": [ "<specific, actionable recommendation>" ]
}`,
  };
}

// ---------------------------------------------------------------------------
// S3 fix-loop prompts (docs/soc-roadmap.md): integration failures must
// CONVERGE, not halt. Triage routes a system failure to its owner; the two
// inline fix prompts repair the top's wiring or the system TB with child
// INTERFACE VIEWS only (bodies stay withheld).
// ---------------------------------------------------------------------------

export function promptIntegrationTriage(failures, topRTL, childViews, instances) {
  return {
    systemPrompt: sys(),
    maxTokens: 800,
    userMessage: `\
TASK: A system-level simulation of the integrated design ran and some tests
FAILED. Decide which single component owns the root cause.

FAILING TESTS / EVIDENCE:
${j(failures)}

TOP MODULE RTL (owns all wiring between instances):
${topRTL}

CHILD MODULE INTERFACES (headers only):
${j(childViews)}

INSTANCES:
${j(instances)}

Pick exactly ONE target:
• "top"            — the wiring/glue in the top module is wrong
• "tb"             — the system testbench drives or checks incorrectly
• "<moduleId>"     — one child module's internal logic is wrong (name it)

Return JSON: {"target":"top | tb | <moduleId>","reason":"<one sentence pointing at specific evidence>"}
Base the choice only on the evidence above; when the evidence cannot separate
top from tb, choose "tb" (a wrong check is cheaper to fix than wrong wiring).`,
  };
}

export function promptIntegrationTopFix(topRTL, findings, childViews, instances, previousFixes) {
  const prev = (previousFixes && previousFixes.length > 0)
    ? "\n\nPREVIOUSLY APPLIED FIXES (do NOT revert these):\n" + j(previousFixes) + "\n"
    : "";
  return {
    systemPrompt:
      'You are RTL Forge, a SystemVerilog expert. ' +
      'Respond with ONLY a JSON object of this exact shape: ' +
      '{"code":"<complete fixed top module source>","fixes":[{"id":"<finding ref>","desc":"<what was changed>"}]}. ' +
      'No markdown. No preamble. No text outside the JSON object.',
    maxTokens: 8000,
    userMessage: `\
TASK: Repair the TOP module of an integrated multi-module system. The findings
below come from real tooling (structural wiring check / Verilator / a real
system simulation) — fix the top's wiring and glue logic with the MINIMAL
change.

FINDINGS:
${j(findings)}

CHILD MODULE INTERFACES (headers only — port/param declarations are
authoritative; child internals are correct as far as this fix is concerned):
${j(childViews)}

INSTANCES (planned placements — instance names and paramOverrides are the
contract):
${j(instances)}

CURRENT TOP MODULE RTL:
${topRTL}
${prev}
HARD CONSTRAINTS:
- Keep the top's own port list and module name exactly as they are.
- Every planned instance stays present, connected by name (.port(signal)).
- Return the COMPLETE fixed top module in "code".`,
  };
}

export function promptSystemTBFix(tbCode, failures, topHeader, previousFixes) {
  const prev = (previousFixes && previousFixes.length > 0)
    ? "\n\nPREVIOUSLY APPLIED FIXES (do NOT revert these):\n" + j(previousFixes) + "\n"
    : "";
  return {
    systemPrompt:
      'You are RTL Forge, a SystemVerilog verification expert. ' +
      'Respond with ONLY a JSON object of this exact shape: ' +
      '{"code":"<complete fixed system testbench source>","fixes":[{"id":"<test/finding ref>","desc":"<what was changed>"}]}. ' +
      'No markdown. No preamble. No text outside the JSON object.',
    maxTokens: 8000,
    userMessage: `\
TASK: Repair the SYSTEM TESTBENCH of an integrated multi-module design. The
failures below come from a REAL simulation run of the assembled system.

FAILURES / EVIDENCE:
${j(failures)}

TOP MODULE INTERFACE (headers only — drive and observe through these ports;
derive expected values from the system's intent, never from implementation
internals):
${topHeader}

CURRENT SYSTEM TESTBENCH:
${tbCode}
${prev}
HARD CONSTRAINTS:
- Keep the [PASS]/[FAIL]/[SUMMARY] marker protocol exactly as it is.
- Fix drive timing, reset sequencing, and expected values as the evidence
  indicates; keep every existing test present.
- Return the COMPLETE fixed testbench in "code".`,
  };
}
