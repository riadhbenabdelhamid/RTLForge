// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/lint — Stage 6: Lint Analysis (LLM fallback) + RTL Fix  (REVISED)
//
// promptLint     — LLM-based Verilator-like analysis of RTL  (when no CLI)
// promptRTLFix   — fixes RTL lint errors/warnings without changing functionality
// promptTBLint   — LLM-based Verilator-like analysis of TESTBENCH (NEW)
// promptTBLintFix — fixes testbench lint findings (NEW)
//
// REVISION GOALS:
//   - Keep the false-positive rate low: forbid inventing issues that the
//     code does not exhibit; require concrete evidence (line N, signal name).
//   - Make outputs machine-checkable: every error/warning carries a code
//     from a fixed vocabulary so downstream classifiers can rank them.
//   - Fix loop: minimal-diff guarantee, single-driver preservation, and
//     explicit ban on changing the module's external contract.
//   - Add a "no fix invented" rule: every entry in `fixes` must point to a
//     specific issue id the lint stage produced.
//   - NEW: testbench-aware variants. Testbenches use `initial`/`$display`/
//     `$urandom` etc. which are valid in TB but would be flagged on RTL,
//     so the TB-lint prompts have their own vocabulary and false-positive
//     guards.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j } from "./base.js";

// ---------------------------------------------------------------------------
// promptLint — LLM-estimated Verilator analysis
// ---------------------------------------------------------------------------

export function promptLint(code, el) {
  const schema = `{
  "tool":     "Verilator 5.x (AI analysis)",
  "status":   "PASS | FAIL",
  "warnings": [
    { "id": "W-001", "code": "UNUSED",   "sev": "warning", "line": 42, "signal": "tmp_q",  "msg": "<one-line description>" }
  ],
  "errors": [
    { "id": "E-001", "code": "IMPLICIT", "sev": "error",   "line": 17, "signal": "wr_en",  "msg": "<one-line description>" }
  ],
  "summary": "<e.g. 0 errors, 2 warnings — PASS>",
  "log":     "<one Verilator-style line per finding, joined with \\n>"
}`;

  return {
    systemPrompt: sys(),
    maxTokens: 3000,
    userMessage: `\
TASK: Lint-analyse the SystemVerilog module below as Verilator --lint-only -Wall would.

MODULE: ${el.modName}
SOURCE:
${code}

VOCABULARY — \`code\` MUST be one of (extend only with named subtypes):
  UNUSED, UNDRIVEN, WIDTH, WIDTHCONCAT, WIDTHTRUNC,
  CASEINCOMPLETE, CASEOVERLAP, LATCH, IMPLICIT, MULTIDRIVEN,
  INITVAR, BLKSEQ, COMBDLY, REALCVT, TIMESCALE,
  PORTSHORT, PINMISSING, PINNOCONNECT, GENCLK, SYMRSVDWORD.

EVIDENCE RULES — every finding must be substantiated:
• \`line\` MUST be an integer ≥ 1 that points to a real line in the SOURCE above.
• \`signal\` MUST name an identifier that appears on that line (or "" if the
  finding is whole-module like TIMESCALE).
• \`msg\` is one sentence: what the issue is. Do NOT include a fix.
• If you cannot point to a concrete line and signal, do NOT emit the finding.

FALSE-POSITIVE GUARD:
• Do not flag \`UNUSED\` for ports — Verilator only flags unused INTERNAL signals.
• Do not flag \`WIDTH\` when the literal already carries an explicit size cast.
• Do not flag \`LATCH\` for \`always_ff\` blocks — they are flops by definition.
• Do not flag \`CASEINCOMPLETE\` for \`unique case\` with all enum values covered.

STATUS RULE — \`status\` is "PASS" iff \`errors.length === 0\`. Warnings alone never
trigger FAIL (that is the lint stage's policy, not the model's).

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

// ---------------------------------------------------------------------------
// promptRTLFix — Fix lint errors/warnings without changing functionality
// ---------------------------------------------------------------------------

export function promptRTLFix(code, lintResult, el, previousFixes) {
  const issues = [
    ...(lintResult.errors   || []),
    ...(lintResult.warnings || []),
  ];

  const prevSection = (previousFixes && previousFixes.length > 0) ? `

PREVIOUSLY APPLIED FIXES (do NOT revert these):
${j(previousFixes)}

NON-MONOTONIC POLICY:
• Fixing one issue may REVEAL new issues (e.g. removing a dead driver reveals
  an UNUSED). That is acceptable — those are follow-on items for the next iter.
• A REGRESSION is: introducing a syntax error, breaking ports, changing
  functional behaviour, or producing errors in unrelated regions.
• Make MINIMAL, surgical edits. Less diff = less regression risk.` : '';

  return {
    systemPrompt:
      'You are RTL Forge, a SystemVerilog expert. ' +
      'Respond with ONLY a JSON object of this exact shape: ' +
      '{"code":"<fixed SystemVerilog source>","fixes":[{"id":"<lint id>","desc":"<what was changed>"}]}. ' +
      'No markdown. No preamble. No text outside the JSON object.',
    maxTokens: 8000,
    userMessage: `\
TASK: Fix every listed lint finding in the "${el.modName}" module without
altering its functional behaviour.

CURRENT CODE:
${code}

LINT FINDINGS TO RESOLVE (${issues.length}):
${j(issues)}

LINT LOG (raw output for context):
${lintResult.log || '(none)'}
${prevSection}

FIX RULES — every item is mandatory:
1. ADDRESS EVERY LISTED FINDING. Each entry in \`fixes\` must reference the
   finding's \`id\` (e.g. "E-001", "W-002"). No fixes for issues not listed.
2. PRESERVE FUNCTION: state-machine transitions, datapath equations, protocol
   handshaking, and interface widths must be observably identical.
3. PRESERVE EXTERNAL CONTRACT — DO NOT CHANGE:
   - Module name, port list, port directions, port widths.
   - Parameter names, types, default values.
   - Connections of signals to ports.
   If a finding can ONLY be resolved by changing the contract, suppress it
   with \`/* verilator lint_off <CODE> */ … /* verilator lint_on <CODE> */\`
   and document in \`fixes\` with desc starting "SUPPRESSED: ".
4. ACCEPTABLE FIXES: add defaults, declare missing logic, correct widths via
   size casts, add timescale, add case default branches, complete sensitivity
   lists.
5. SINGLE-DRIVER PRESERVATION: do not introduce a second driver for any net.
6. RESET-VALUE PRESERVATION: do not remove or alter reset values of any
   existing flip-flop.
7. MINIMAL-DIFF: change only the lines required by the findings. Do NOT
   reformat untouched code, rename signals, restructure unaffected always
   blocks, or move declarations.
8. NO NEW FUNCTIONALITY: do not add features the spec did not request,
   even if "obvious" or "useful".

VERIFICATION CHECKLIST (mental, before emit):
[ ] Every finding id is referenced in \`fixes\`.
[ ] No port/parameter changed.
[ ] No new lint warnings introduced in untouched regions.
[ ] No new drivers, no new latches.
[ ] Code still compiles (mentally walk the diff).

Return {"code":"<complete fixed module>","fixes":[{"id":"<lint id>","desc":"<minimal change>"}]}.`,
  };
}

// ---------------------------------------------------------------------------
// promptTBLint — LLM-estimated lint of a SystemVerilog testbench
//
// Differences from promptLint (RTL):
//   - Allowed (must NOT flag): `initial`, `task automatic`, `$display`, `$finish`,
//     `$urandom`, `#delay`, blocking assignments inside initial/task. These are
//     legitimate testbench constructs.
//   - Required to flag: `$error`/`$fatal` (halts simulation, breaks our loop),
//     missing watchdog, missing [PASS]/[FAIL] markers, missing $finish, missing
//     // covers: REQ-XXX annotations on test tasks, hardcoded magic numbers
//     where a parameter is preferred, race conditions between clock and stimulus.
// ---------------------------------------------------------------------------

export function promptTBLint(tbCode, rtlCode, spec, el) {
  const schema = `{
  "tool":     "Verilator-TB (AI analysis)",
  "status":   "PASS | FAIL",
  "warnings": [
    { "id": "TBW-001", "code": "MISSING_COVERS", "sev": "warning", "line": 42, "task": "test_reset", "msg": "<one-line>" }
  ],
  "errors": [
    { "id": "TBE-001", "code": "USES_DOLLAR_ERROR", "sev": "error", "line": 17, "task": "test_full", "msg": "<one-line>" }
  ],
  "summary": "<e.g. 0 errors, 2 warnings — PASS>",
  "log":     "<one Verilator-style line per finding, joined with \\n>"
}`;

  const mustReqs = (spec.requirements || [])
    .filter(function(r) { return r.pri === "Must"; })
    .map(function(r) { return r.id; });

  return {
    systemPrompt:
      'You are RTL Forge, a SystemVerilog verification expert. ' +
      'Respond with ONLY a JSON object matching the schema. ' +
      'Do NOT flag legitimate testbench constructs (initial, $display, $urandom, ' +
      '#delay in initial blocks, blocking assignments inside tasks). Flag ONLY ' +
      'real testbench problems.',
    maxTokens: 3000,
    userMessage: `\
TASK: Lint-analyse the testbench below. Apply testbench-aware rules — many
constructs that would be invalid in RTL are perfectly legal in a TB.

TESTBENCH SOURCE:
${tbCode}

RTL UNDER TEST (first 60 lines, for cross-checking signal names):
${(rtlCode || "").split("\n").slice(0, 60).join("\n")}

MUST REQUIREMENTS THE TB SHOULD COVER: ${j(mustReqs)}

VOCABULARY — \`code\` MUST be one of:
  USES_DOLLAR_ERROR     — uses \\$error / \\$fatal (halts sim; breaks our flow).
  USES_DOLLAR_RANDOM    — uses \\$random instead of \\$urandom (Verilator pitfall).
  MISSING_WATCHDOG      — no absolute-time timeout that calls \\$finish(1).
  MISSING_FINISH        — main initial block does not call \\$finish.
  MISSING_SUMMARY       — no [SUMMARY] passes=… fails=… line.
  MISSING_PASS_FAIL     — checks emit messages but not [PASS]/[FAIL] markers.
  MISSING_COVERS        — test task lacks // covers: <REQ-ID> first-line annotation.
  COVERS_MISMATCH       — // covers: <ID> references a REQ-ID not in the spec.
  REQ_NOT_TESTED        — a Must REQ-ID has no test_<id>() task.
  HARDCODED_LITERAL     — magic number that should reference a parameter.
  RACE_RISK             — drives a signal on @(posedge clk) that the DUT also
                          drives on the same edge (read-after-write race).
  STIMULUS_DURING_RESET — drives non-zero stimulus while reset is asserted.
  WIDTH                 — signal width mismatch in TB→DUT connection.
  IMPLICIT              — undeclared identifier used in TB.
  PORT_MISSING          — DUT instance does not connect a port that appears in spec.iface.
  PORT_TYPO             — DUT instance connects a port name that does not exist in RTL.

EVIDENCE RULES:
• \`line\` MUST be an integer ≥ 1 pointing at a real line in TESTBENCH SOURCE.
• \`task\` is the enclosing task or block name (e.g. "test_reset", "initial",
  "watchdog_block"), or "" for whole-TB findings.
• \`msg\` is one sentence: WHAT is wrong. Do NOT include the fix.
• If you cannot localise a finding to a specific line + task, do NOT emit it.

FALSE-POSITIVE GUARDS — do NOT flag:
• \`initial\` blocks (these are how a TB starts).
• \`task automatic\` declarations.
• \`$display\`, \`$write\`, \`$strobe\`, \`$monitor\`, \`$urandom\`.
• Blocking \`=\` inside an \`initial\` or task body.
• \`#delay\` for clock-period waits in initial/task scope.
• \`@(posedge clk)\` waits in tasks.
• Local \`int\` / \`logic\` declarations inside tasks (TB scope is permissive).
• Widths flagged by the RTL lint stage on the DUT itself — those are not TB issues.

STATUS RULE: \`status\` is "PASS" iff \`errors.length === 0\`. Warnings alone
never trigger FAIL.

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}

// ---------------------------------------------------------------------------
// promptTBLintFix — Fix testbench lint findings without reducing coverage
// ---------------------------------------------------------------------------

export function promptTBLintFix(tbCode, rtlCode, lintResult, spec, el, previousFixes) {
  const issues = [
    ...(lintResult.errors   || []),
    ...(lintResult.warnings || []),
  ];

  const prevSection = (previousFixes && previousFixes.length > 0) ? `

PREVIOUSLY APPLIED FIXES (do NOT revert these):
${j(previousFixes)}

NON-MONOTONIC POLICY:
• Fixing one TB finding may REVEAL new ones (e.g. adding a watchdog reveals
  a missing summary line). That is acceptable.
• A REGRESSION is: introducing a syntax error, removing a covers annotation,
  removing a test task, or producing failures on currently-passing tests.` : '';

  return {
    systemPrompt:
      'You are RTL Forge. Respond ONLY with JSON: ' +
      '{"code":"<fixed testbench>","fixes":[{"id":"<TB lint id>","desc":"<minimal change>"}]}',
    maxTokens: 8000,
    userMessage: `\
TASK: Fix every listed testbench lint finding for "${el.modName}_tb" without
reducing coverage or altering DUT-side behaviour.

CURRENT TESTBENCH:
${tbCode}

RTL UNDER TEST (first 60 lines for reference):
${(rtlCode || "").split("\n").slice(0, 60).join("\n")}

LINT FINDINGS TO RESOLVE (${issues.length}):
${j(issues)}

MUST REQUIREMENTS:
${j((spec.requirements || []).filter(function(r) { return r.pri === "Must"; }).map(function(r) { return { id: r.id, desc: r.desc }; }))}
${prevSection}

FIX RULES:
1. EVERY entry in \`fixes\` references a finding \`id\` (TBE-NNN / TBW-NNN). No
   invented fixes.
2. NEVER REDUCE COVERAGE: every Must requirement must STILL have a
   \`test_<id>()\` task with \`// covers: <REQ-ID>\` on its first line.
3. PRESERVE INFRASTRUCTURE: keep clock generator, reset task, watchdog,
   pass/fail counters, [SUMMARY] line, and \\$finish-with-exitcode logic.
4. NO \\$error / \\$fatal anywhere — replace with the CHECK macro pattern.
5. NO \\$random — replace with \\$urandom.
6. KEEP DUT INSTANCE PORTS UNCHANGED — the DUT contract is fixed.
7. MINIMAL-DIFF: change only the lines required by the findings. Do NOT
   reformat untouched test tasks or rename signals.
8. ADDITIVE-ONLY for missing-coverage findings: ADD test tasks; do NOT
   replace passing ones.

VERIFICATION CHECKLIST:
[ ] Every finding id is referenced in \`fixes\`.
[ ] Every Must REQ-ID still has a matching \`test_<id>()\` task.
[ ] Watchdog, [SUMMARY], \\$finish exit-code logic intact.
[ ] No \\$error / \\$fatal / \\$random remain.
[ ] DUT instance unchanged.

Return {"code":"<complete testbench>","fixes":[{"id":"TBx-NNN","desc":"<change>"}]}.`,
  };
}
