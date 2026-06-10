// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/testGen — Stage 7: Self-Checking Directed Testbench  (REVISED)
//
// Generates a complete, self-checking SystemVerilog testbench for the DUT.
//
// REVISION GOALS:
//   - Make the [PASS]/[FAIL] markers MANDATORY and exhaustive — every check
//     prints exactly one [PASS] or [FAIL] line (preventing testbenches that
//     exit 0 with no markers, which would make a run look like it passed).
//   - Force a single error counter and a deterministic exit:
//        $display("[SUMMARY] passes=%0d fails=%0d", passes, fails);
//        $finish(fails == 0 ? 0 : 1);
//   - Require an actual coverage attempt: every Must requirement has at least
//     one directed test AND at least one negative/edge test where applicable.
//   - Force timescale, watchdog, reset, and seed to fixed defaults so simulator
//     output is reproducible.
//   - Forbid `$error`/`$fatal` — they halt simulation and break the loop.
// ═══════════════════════════════════════════════════════════════════════════

import { j, resolveModName } from "./base.js";

export function promptTB(code, spec, el, childInterfaces) {
  // el may be undefined — resolve safely.
  const modName = resolveModName(el, spec);
  const ci = childInterfaces || [];

  const childSection = ci.length > 0 ? `

NOTE: The DUT instantiates child modules (${ci.map(function(c) { return c.instanceName; }).join(', ')}).
The TB does NOT separately instantiate children; test at the parent's port boundary only.` : '';

  const mustReqs = (spec.requirements || [])
    .filter(function(r) { return r.pri === 'Must'; })
    .map(function(r) { return { id: r.id, desc: r.desc }; });

  return {
    systemPrompt:
      'You are RTL Forge, a SystemVerilog verification expert. ' +
      'Respond with ONLY a JSON object of this exact shape: ' +
      '{"code":"<testbench source>"}. ' +
      'No markdown. No preamble. Use \\n for newlines inside the string.',
    maxTokens: 8000,
    userMessage: `\
TASK: Generate a complete, self-checking SystemVerilog testbench for the
"${modName}" module that runs under Verilator without modification.

DUT SOURCE:
${code}

PORT LIST:
${j(spec.iface)}

PARAMETERS:
${j(spec.params)}

MUST-PRIORITY REQUIREMENTS (every one needs a directed test):
${j(mustReqs)}
${childSection}

INPUT ASSUMPTIONS:
• The DUT clock is named \`clk\` and is rising-edge active unless the spec says otherwise.
• Reset polarity follows the port name: \`rst_n\` ⇒ active-low, \`rst\` ⇒ active-high.
• Verilator is the target simulator; use only constructs Verilator supports.

TESTBENCH STRUCTURE — every section is mandatory:

1. HEADER
   - \`timescale 1ns/1ps at top.
   - Top module \`${modName}_tb\` (no ports).
   - Define \`localparam int CLK_PERIOD_NS = 10;\` and \`localparam int TIMEOUT_NS = 100_000;\`.

2. DUT INSTANCE
   - Override every parameter with its default from PARAMETERS above (explicit is safer).
   - Wire every DUT port to a TB-side \`logic\` of the matching width.

3. CLOCK + RESET INFRASTRUCTURE (use these exact patterns)
   - Clock:
       initial clk = 1'b0;
       always #(CLK_PERIOD_NS/2) clk = ~clk;
   - Reset task (adjust polarity to actual port name):
       task automatic apply_reset();
         rst_n = 1'b0;        // or rst = 1'b1
         repeat (4) @(posedge clk);
         rst_n = 1'b1;        // or rst = 1'b0
         @(posedge clk);
       endtask
   - Watchdog:
       initial begin
         #(TIMEOUT_NS) $display("[FAIL] watchdog: simulation exceeded %0d ns", TIMEOUT_NS);
         fails++;
         $finish(1);
       end

4. ERROR COUNTERS (declared at TB scope):
       int passes = 0;
       int fails  = 0;

5. CHECK MACRO — use everywhere instead of $error/assert:
       \`define CHECK(cond, label) \\
         if (cond) begin \\
           $display("[PASS] %s @%0d cycles", label, cycle_count); passes++; \\
         end else begin \\
           $display("[FAIL] %s @%0d cycles @ t=%0t", label, cycle_count, $time); fails++; \\
         end

   You MUST declare and maintain \`int cycle_count = 0;\` in the testbench
   and increment it on every positive clock edge:
       always @(posedge clk) cycle_count <= cycle_count + 1;
   This lets RTL Forge's Duration tab attribute simulation time to each
   test. The "@<N> cycles" suffix is REQUIRED — do not omit it.

6. DIRECTED TESTS (one task per Must requirement)
   - Task name: \`test_<req_id_lowercased>()\`.
   - First line of body MUST be the comment:  // covers: <REQ-ID>
   - Each task uses \`CHECK(...)\` to record results — DO NOT use \`$error\`,
     \`$fatal\`, or \`assert ... else $error\` (these halt or escape Verilator).
   - For each Must requirement:
        a) one positive case exercising the typical flow,
        b) where applicable, one boundary case (zero, max, min),
        c) where applicable, one back-pressure / reset-during-op case.

7. MAIN INITIAL BLOCK — exact form:
       initial begin
         apply_reset();
         test_<id_1>();
         test_<id_2>();
         // ... one call per requirement
         $display("[SUMMARY] passes=%0d fails=%0d", passes, fails);
         $finish(fails == 0 ? 0 : 1);
       end

CODING RULES:
• Use \`automatic\` tasks to avoid scope leaks.
• All clocked stimulus drives values via @(posedge clk) → non-blocking.
• Random seeding: call \`void'($urandom(32'hC0FFEE));\` at the top of \`initial\`
  for reproducibility.
• Do NOT use \`$random\` (Verilator-incompatible seeding); use \`$urandom\` only.
• Do NOT \`\\\`include\` external files. Self-contained TB only.
• Do NOT introduce SVA / immediate assertions in the TB body — assertions belong
  in the DUT under \`\\\`ifdef FORMAL\`.
• Do NOT print anything that starts with "[PASS]" or "[FAIL]" except via
  \`CHECK\`. The \`[SUMMARY]\` line is the ONE other allowed marker.

REQUIREMENT COVERAGE GUARD:
• It is a hard error to omit any Must requirement: every id in MUST-PRIORITY
  REQUIREMENTS above must have a corresponding \`test_<id>()\` task and a
  matching call from the main initial block.
• If a requirement cannot be tested at the port boundary (e.g. internal-only
  property), still emit a task that prints
  \`[PASS] <REQ-ID>: not testable at port boundary [skipped]\`
  so the verify stage can attribute coverage.

SELF-REVIEW BEFORE EMIT:
[ ] Every Must requirement has its own task with // covers: <ID> on the first line.
[ ] Main initial block calls every task before the [SUMMARY] line.
[ ] Watchdog is present and uses \$finish(1) on timeout.
[ ] No \`$error\`, \`$fatal\`, or bare \`assert\` (with $error escape) anywhere.
[ ] Final \$finish exit code reflects fails (0 if passes only, 1 otherwise).

Return {"code":"<complete testbench source>"}.`,
  };
}
