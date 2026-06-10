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

CHILD MODULE RTL:
${j(childRTLs.map(function(c) { return { modName: c.modName, code: c.code.split("\n").slice(0, 40).join("\n") + "\n// ... truncated" }; }))}

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

SCORING RUBRIC (out of 100):
  - Integration lint PASS (no errors)    : +30
  - Integration lint warnings only       : +15
  - System TB pass rate 100%             : +30
  - System TB pass rate ≥ 80%            : +15
  - All modules individually PASS        : +25
  - All modules score ≥ 70              : +15
  - Shared package present               : +5

VERDICT: "PASS" if score ≥ 70 AND integration lint has no errors AND all \
modules individually pass. Otherwise "FAIL".

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
