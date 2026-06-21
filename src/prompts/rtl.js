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

import { j, resolveModName } from "./base.js";

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
• Use named (.port(signal)) connections only — never positional.
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
${j(arch)}

SPECIFICATION (interface, parameters, requirements):
${j({ iface: spec.iface, params: spec.params, requirements: spec.requirements })}
${pkgSection}${childSection}${avoidSection}
INPUT ASSUMPTIONS — what the model MAY rely on:
• The spec above is the source of truth for all ports, parameters, widths.
• Reset polarity is decided by the spec: \`rst_n\` ⇒ active-low; \`rst\` ⇒ active-high.
• Async reset if the port is named \`rst_n\` or \`arst_n\`; sync reset for \`srst\`.
• Default clock name is \`clk\` (rising-edge active) unless the spec says otherwise.

ASSUMPTION HANDLING — required:
• Do NOT silently invent specs. If the spec is silent on a detail you must
  decide (e.g. depth, FSM encoding, byte-order), pick the simplest valid choice
  AND emit a header comment of the form:
      // ASSUMPTION: <one-line decision and why it is safe>
  one comment per assumption, immediately after the timescale.
• If a spec port/parameter is missing required info to make any choice safe
  (e.g. clock period for an async-only block), emit instead:
      // GAP: <one-line description of what is missing>
  These will be surfaced by the lint stage.

SYNTHESISABILITY RULES — every item is mandatory:
1. Header order: \`timescale 1ns/1ps\` → optional package import → module
   declaration. Put parameters before ports. End with \`endmodule // ${modName}\`.
2. Sequential: ALL flip-flop logic uses \`always_ff @(posedge clk <reset_edge>)\`,
   where \`<reset_edge>\` is \`or negedge rst_n\` for async-low or omitted for sync.
3. Combinational: ALL combinational logic uses \`always_comb\` or \`assign\`. NEVER
   \`always @(*)\`. Every \`always_comb\` must assign every output of that block on
   every path; otherwise add a default at the top.
4. Case statements: full \`case\`/\`unique case\` with a \`default:\` branch always.
5. No latches. If you write \`always_comb\` you commit to driving every LHS on every path.
6. Reset rule: every flip-flop MUST be reset to a defined value in the reset
   branch. No \`X\`-initial state. If a flop is intentionally non-reset, mark it
   with a comment and emit an \`// ASSUMPTION:\` line.
7. Single driver: every signal has exactly one driver block. No \`assign\` and
   \`always\` driving the same wire.
8. Blocking vs non-blocking: \`<=\` in sequential blocks, \`=\` in combinational.
9. Widths: never use \`'b1\` for a multi-bit literal. Use \`{N{1'b0}}\` or \`'0\`/\`'1\`
   for replicated literals; size-cast every parameter-derived literal.
10. No implicit nets. Every signal is declared with \`logic\` (or \`wire\` if multi-driven
    by gate-level constructs, but prefer \`logic\`).
11. SVA: place inside \\\`ifdef FORMAL … \\\`endif guards within the module,
    after the body. Never bind, never separate checker module.
12. FORBIDDEN constructs (not synthesisable): \`force\`/\`release\`, \`fork\`/\`join_any\`,
    \`real\`, \`shortreal\`, dynamic arrays, queues, classes, \`while\`/\`do\` outside
    generate-static-loop usage, \`#delay\` in always blocks.
13. Hierarchical references (e.g. \`top.sub.x\`) are forbidden in synthesisable RTL.
14. Add a one-line comment above every \`always\` block stating its purpose.

INTERFACE COMPLIANCE — must hold exactly:
• Every port from \`spec.iface\` appears in the module header with the same
  name, direction, and width expression.
• No extra ports beyond what the spec declares (children are instantiated
  internally, never re-exposed).
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
[ ] No blocking \`=\` inside \`always_ff\`.
[ ] Every assumption is captured in a header comment.
[ ] The output is the module body only — no testbench, no bind, no package definition.

STRICT OUTPUT — \`code\` must contain ONLY:
• The timescale line.
• At most one package import.
• ASSUMPTION/GAP comments.
• The single module body, ending with endmodule.
NO testbench, NO standalone checker module, NO bind, NO package definition.

Return {"code":"<full module source>"}.`,
  };
}
