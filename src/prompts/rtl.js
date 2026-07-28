// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/rtl — Stage 4: RTL Code Generation  (REVISED)
//
// Generates a complete, synthesisable SystemVerilog module.
//
// REVISION GOALS (vs. previous version):
//   - Tighten synthesis discipline: forbid latches, blocking-in-seq, multi-driven
//     nets, real types, dynamic arrays, force/release, and unsynthesisable constructs.
//   - Make reset behaviour fully deterministic and require explicit reset values
//     for every state element (no implicit X-init).
//   - Lock interface compliance to the spec: every spec port appears in the
//     module header, in the same direction, in the same width.
//   - Lift the assumption-handling rule: instead of guessing, the model must
//     emit an `// ASSUMPTION:` comment in the file header listing every gap.
//   - Add a self-review checklist the model must run before emitting JSON.
//   - Output schema unchanged — fully back-compatible with rtl_generate node.
// ═══════════════════════════════════════════════════════════════════════════

import { j, resolveModName, stripMeta } from "./base.js";

export function promptRTL(arch, spec, el, childInterfaces, sharedPackageCode, errorsToAvoid) {
  // el may be undefined when resumed projects skip elicit — resolve safely.
  const modName = resolveModName(el, spec);
  const ci = childInterfaces || [];

  // Cross-run "errors to avoid" (#26–28). Empty/absent → byte-identical prompt.
  const avoidSection = errorsToAvoid ? `

${errorsToAvoid}
` : '';

  const pkgSection = sharedPackageCode ? `

SHARED PACKAGE — import only if your module uses any of its types/constants:
\`\`\`systemverilog
${sharedPackageCode}
\`\`\`
Add \`import <package_name>::*;\` directly after the timescale, before the module.` : '';

  const childSection = ci.length > 0 ? `

CHILD INSTANCES (this module is a parent):
${j(ci)}

INSTANTIATION RULES — must be followed exactly:
• Connect every child port by name: .port(signal).
• Each instance has a unique instance name; declare separate internal wires
  per instance (e.g. logic [DATA_W-1:0] u_fifo0_dout, u_fifo0_full;).
• Apply paramOverrides via the # parameter list; do not change child ports.
• Tie unused child outputs to a clearly-named net (e.g. u_fifo0_unused);
  do not leave them dangling.
• Width-correct every port connection; if widths differ, use a SystemVerilog
  cast.
` : '';

  return {
    systemPrompt:
      'You are RTL Forge, a SystemVerilog expert. ' +
      'Respond with ONLY a JSON object of this exact shape: ' +
      '{"code":"<complete SystemVerilog source as a single JSON string>"}. ' +
      'No markdown. No preamble. No text outside the JSON object. ' +
      'Inside the "code" string: use \\n for newlines, \\" for quotes.',
    maxTokens: 8000,
    userMessage: `\
TASK: Produce ONE complete, synthesisable IEEE 1800-2017 SystemVerilog module
named "${modName}" that satisfies the spec below.

ARCHITECTURE:
${j(stripMeta(arch))}

SPECIFICATION (interface, parameters, requirements):
${j({ iface: spec.iface, params: spec.params, requirements: spec.requirements })}
${pkgSection}${childSection}${avoidSection}
INPUT ASSUMPTIONS — what the model MAY rely on:
• The spec above is the source of truth for all ports, parameters, widths.
• Reset polarity is decided by the spec: \`rst_n\` ⇒ active-low; \`rst\` ⇒ active-high.
• Async reset if the port is named \`rst_n\` or \`arst_n\`; sync reset for \`srst\`.
• Default clock name is \`clk\` (rising-edge active) unless the spec says otherwise.

ASSUMPTION HANDLING — required:
• Every open decision must be DECLARED: when the spec is silent on a detail
  you must decide (e.g. depth, FSM encoding, byte-order), pick the simplest
  valid choice AND emit a header comment of the form:
      // ASSUMPTION: <one-line decision and why it is safe>
  one comment per assumption, immediately after the timescale.
• If a spec port/parameter is missing required info to make any choice safe
  (e.g. clock period for an async-only block), emit instead:
      // GAP: <one-line description of what is missing>
  These will be surfaced by the lint stage.

SYNTHESISABILITY RULES — every item is mandatory:
1. Header order: \`timescale 1ns/1ps\` → optional package import → module
   declaration. Put parameters before ports. End with \`endmodule // ${modName}\`.
2. Sequential: ALL flip-flop logic uses \`always_ff @(posedge clk <reset_edge>)\`.
   The RESET KIND comes from the spec's reset port \`desc\`: an ASYNCHRONOUS
   reset appears in the sensitivity list (\`or negedge rst_n\` / \`or posedge
   rst\`); a SYNCHRONOUS reset is omitted from the sensitivity list and
   checked first inside the clocked block. Polarity likewise follows the
   spec's \`desc\`.
3. Combinational: ALL combinational logic uses \`always_comb\` or \`assign\` —
   \`always_comb\` is the only always-flavor for combinational blocks. Every
   \`always_comb\` assigns every output of the block on every path; defaults
   at the top of the block make this trivial.
4. Case statements: full \`case\`/\`unique case\` with a \`default:\` branch always.
5. Latch-free by construction: every \`always_comb\` drives every LHS on every path.
6. Reset rule: implement exactly the spec's reset contract. Internal
   control state (pointers, counters, FSM state, valid flags) resets to a
   defined value in the reset branch — no \`X\`-initial control state. Each
   OUTPUT register follows its iface \`reset\` field: a stated value is
   assigned in the reset branch; an output whose \`reset\` states RETENTION
   ("retains last value") keeps ALL of its update logic outside the reset
   branch — its register simply persists, and it appears nowhere in the
   reset branch. A retention output is EXPECTED to hold an undefined value
   until its first write: that is the contract, not an oversight, and
   \`X\`-avoidance is not a reason to override it. Writing a "safe default"
   into a retention output (\`dout <= '0;\` in the reset branch, however
   commented) breaks the contract the testbench and the formal properties
   both check, so a design that resets it fails verification while its
   comment claims to follow the spec. When an iface entry has no
   \`reset\` field, reset that register to a defined value and emit an
   \`// ASSUMPTION:\` line.
7. Single driver: every signal is driven from exactly one block — one
   \`assign\` or one \`always\` owns each signal.
8. Blocking vs non-blocking: \`<=\` in sequential blocks, \`=\` in combinational.
9. Widths: size every literal to its context — \`'0\`/\`'1\` or \`{N{1'b0}}\` for
   replicated values, explicit sized forms (e.g. \`8'h00\`, \`4'd9\`) elsewhere;
   size-cast every parameter-derived literal. A comparison or assignment
   involving a PARAMETER is width-matched too: an \`int\` parameter is 32 bits,
   so \`cnt == CLKS_PER_BIT-1\` widens a narrow counter — write
   \`cnt == CNT_W'(CLKS_PER_BIT-1)\` (or declare the counter
   \`[$clog2(CLKS_PER_BIT)-1:0]\` and cast) so both sides carry the same width.
10. Declare every signal explicitly with \`logic\` before its first use.
11. SVA: place inside \\\`ifdef FORMAL … \\\`endif guards INSIDE this same
    module, after the main body — assertions live inline here.
12. Synthesisable subset only: procedural logic is \`always_ff\`/\`always_comb\`/
    \`assign\`; loops are \`for\` with static bounds (or generate); data types are
    \`logic\`, packed vectors, enums, and packed structs; the only timing
    controls in the module are the clock/reset edge events of \`always_ff\`.
13. Every signal reference stays within this module's own scope: ports,
    locally declared signals, and named child ports.
14. Add a one-line comment above every \`always\` block stating its purpose.
15. Capacity representability: when the design tracks the occupancy of
    N-entry storage (FIFO, buffer, queue), hold occupancy in state that can
    represent ALL N+1 values 0..N — an occupancy counter of \`$clog2(N)+1\`
    bits maintained by explicit increment/decrement, or read/write pointers
    carrying one extra wrap bit — BOTH pointers get that bit and BOTH are
    declared the same width, so the pair can be compared directly
    (\`full = (wr[N-2:0] == rd[N-2:0]) && (wr[N-1] != rd[N-1]);\`,
    \`empty = (wr == rd);\`). Derive \`full\` (occupancy==N) and \`empty\`
    (occupancy==0) COMBINATIONALLY from that registered state so the flags
    reflect the current cycle, and drive the output ports DIRECTLY from that
    combinational expression (\`assign full = full_comb;\`) unless the spec
    explicitly states the flags are REGISTERED — an unrequested extra
    register on the derived value asserts a cycle after the occupancy
    actually changed. A status output is a function of REGISTERED STATE
    ONLY: never let a request input (\`wr_en\`/\`rd_en\`) or another status
    output appear in a flag's expression — a flag that reacts to a request
    in the same cycle reports occupancy the design does not yet have, and
    routing one flag through another closes a combinational loop.
16. Completion signalling: when a design reports the END of a multi-cycle
    operation (a \`*_valid\`/\`*_done\`/\`*_ready\` strobe, a result register),
    the signal that produces it must still be ACTIVE on the cycle that
    produces it. An enable, phase flag, or "active" register that clears on
    the transition INTO the idle/finished state kills the very event the
    final state exists to generate — clear such a flag one cycle AFTER the
    last state that reads it, or derive the strobe from the state itself.
    Trace each strobe end to end before emitting: name the cycle it asserts
    and confirm every term in its expression is still true on that cycle.
17. Parameter validation is an initial guard:
    \`initial if (!(<condition>)) $fatal(1, "<message>");\` — this is the
    SystemVerilog form of a compile-time parameter check (\`static_assert\`
    is C++ and does not parse as SV).

INTERFACE COMPLIANCE — must hold exactly:
• Every port from \`spec.iface\` appears in the module header with the same
  name, direction, and width expression.
• The port list is exactly the spec interface (children are instantiated and
  wired entirely inside this module).
• Every parameter from \`spec.params\` appears with the same name, type, and
  default. Range comments ("[1:1024]") become \`localparam\` checks
  if needed, not enforced ranges.
• If a spec port name conflicts with a SV reserved word, append \`_i\`/\`_o\`
  and emit an \`// ASSUMPTION:\` comment.

SELF-REVIEW BEFORE EMIT (mental checklist — go through every item):
[ ] Every spec port is present, same name, direction, width.
[ ] Every state element has a reset value.
[ ] No \`always_comb\` block has a path that fails to assign one of its outputs.
[ ] Every \`case\` has a \`default\`.
[ ] \`always_ff\` blocks use \`<=\` exclusively; \`always_comb\` uses \`=\`.
[ ] Every assumption is captured in a header comment.
[ ] The output contains the single module only (timescale + import + comments + module).

STRICT OUTPUT — \`code\` must contain ONLY:
• The timescale line.
• At most one package import.
• ASSUMPTION/GAP comments.
• The single module body, ending with endmodule.
Nothing else.

Return {"code":"<full module source>"}.`,
  };
}
