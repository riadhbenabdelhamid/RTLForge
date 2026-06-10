// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/architect — Stage 3: Micro-Architecture  (REVISED)
//
// Designs block-level micro-architecture and a Mermaid diagram.
//
// REVISION GOALS (vs. previous version):
//   - Tighten Mermaid output rules. The old prompt said "use graph TD",
//     "wrap labels with spaces in double-quoted brackets", and "≤12 nodes".
//     The new prompt enumerates the exact escape rules required to survive
//     JSON embedding, forbids subgraphs (which often broke the parser),
//     and forbids the Mermaid features Claude tends to over-use (style,
//     classDef, click handlers — all unused downstream).
//   - Add a "no premature implementation choice" guard. The architect
//     stage decides high-level strategy (FSM vs combinational, pipelined
//     vs single-cycle) — it must NOT decide low-level RTL details
//     (encoding style, specific FSM coding pattern, register placement)
//     that belong to the RTL gen stage. Old prompt didn't separate these.
//   - Block-name discipline: each block name is unique within the diagram,
//     PascalCase, and matches what the RTL stage will produce.
//   - Strategy/description must be testable claims, not marketing prose.
//   - Add a self-check that the Mermaid graph references only block names
//     declared in the `blocks` array (no orphan nodes).
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j } from "./base.js";

export function promptArch(spec, el, childInterfaces) {
  // `el` is optional (callers may pass undefined for a project resumed without
  // elicit data). resolveModName falls back el.modName → spec.modName /
  // spec.moduleName → "module" so `${el.modName}` can't crash on a missing el.
  const _el = el || {};
  const modName =
    _el.modName ||
    (spec && (spec.modName || spec.moduleName)) ||
    "module";

  const schema = `{
  "strategy":    "<one short noun phrase, e.g. 'Synchronous FIFO with Gray-code pointers' or 'Single-cycle combinational decoder'>",
  "description": "<2–3 sentences. Each sentence states a CONCRETE design decision and the trade-off it makes.>",
  "blocks": [
    { "name": "<PascalCaseName>", "desc": "<one sentence: WHAT this block does, not how>" }
  ],
  "mermaid": "graph TD\\n  A[\\"Input\\"] --> B[\\"WriteCtrl\\"]\\n  B --> C[\\"MemArray\\"]\\n  C --> D[\\"ReadCtrl\\"]"
}`;

  const ci = childInterfaces || [];
  const childSection = ci.length > 0 ? `

CHILD MODULES TO INSTANTIATE:
${j(ci)}

ARCHITECTURE RULES FOR HIERARCHICAL MODULES:
• \`blocks\` must include one entry per child instance, with \`name\` set to
  the instance name (PascalCase preserved if possible) and \`desc\` stating
  what the parent uses it for.
• The Mermaid diagram shows child instances as nodes. Draw edges representing
  data and control flow between children and parent-side blocks.
• Do NOT re-describe internal logic of child modules — they are black boxes
  defined by their iface.` : '';

  return {
    systemPrompt: sys(
      'MERMAID OUTPUT RULES (must hold exactly): ' +
      'The "mermaid" value is a single JSON string. ' +
      'Use \\n for newlines, \\" for quotes inside node labels. ' +
      'Use only "graph TD" syntax — no flowchart, no graph LR, no subgraph, ' +
      'no classDef, no style, no click handlers. ' +
      'Every node label containing whitespace MUST be wrapped in ' +
      'double-quoted square brackets: A[\\"Write Controller\\"]. ' +
      'Single-word labels may use bare brackets: A[Mux]. ' +
      'Use only ASCII characters in node ids and labels.'
    ),
    maxTokens: 4000,
    userMessage: `\
TASK: Design the micro-architecture for the "${modName}" module.

SPECIFICATION:
${j(spec)}

INPUT ASSUMPTIONS — what the model MAY rely on:
• The SPECIFICATION above is fixed — your architecture must satisfy every
  Must requirement and not contradict any Should requirement.
• The interface (\`spec.iface\`) and parameters (\`spec.params\`) are fixed
  port-level decisions. You are choosing INTERNAL structure only.

LAYERING RULE — the architect stage decides ONLY:
  ✓ High-level strategy (combinational vs pipelined vs FSM-controlled).
  ✓ How the module decomposes into named functional blocks.
  ✓ Top-level data and control flow between blocks.

  ✗ NOT specific FSM encoding (binary vs one-hot — that's RTL gen).
  ✗ NOT specific register placement at gate level.
  ✗ NOT clock-gating, retiming, or back-end implementation choices.
  ✗ NOT testbench structure or assertion choices.
  Anything in the second list is for downstream stages.

THINKING STEPS (mental):
1. Read every Must requirement. Identify the minimum strategy that
   satisfies them all.
2. Decompose into the SMALLEST set of named blocks that captures the
   actual functional structure. A single-block design is valid for simple
   modules.
3. For each block, write one sentence stating WHAT it does. Avoid
   implementation language ("uses non-blocking assignments", "two-process
   FSM") — that belongs in RTL gen.
4. Sketch the Mermaid graph: each block is a node, edges are data or
   control flows.
5. Verify every Mermaid node id maps to a name in \`blocks\`.
6. Emit JSON.

SIMPLICITY RULE (hard):
• Choose the simplest architecture that meets the spec.
• Do NOT add pipeline stages, FSMs, arbitration logic, or extra blocks
  unless requirements explicitly demand them.
• A straightforward combinational or single-cycle design is preferred over
  a multi-stage pipeline when the spec does not require high throughput.
• When in doubt, fewer blocks with more functionality is better than
  more blocks with split functionality.

BLOCK RULES:
• \`name\` is PascalCase, ASCII only, ≤ 24 characters, unique within
  \`blocks\`. Examples: "WriteCtrl", "MemArray", "ReadCtrl", "GrayCounter".
• \`desc\` is one sentence stating the block's responsibility. No
  implementation details, no future-tense, no marketing words like
  "robust", "efficient", "elegant".
• \`blocks\` may contain just 1 entry for simple modules.

MERMAID RULES:
• Syntax is exactly \`graph TD\` (top-down).
• ≤ 12 nodes. If you need more, your decomposition is too fine.
• Every node id used in an edge appears as a node declaration with a
  label.
• Every node id corresponds to a name in \`blocks\` (or to a child
  instance if this is a hierarchical module). NO orphan nodes.
• External inputs/outputs may appear as nodes labelled with the port
  name (e.g. \`In[\\"data_i\\"]\`); these do not need to be in \`blocks\`.
• Edges use \`-->\` for data flow. Use \`-.->\` for control / handshake
  flow if you want to distinguish. No other arrow styles.
• No subgraphs, no classDef, no style, no click handlers.

STRATEGY / DESCRIPTION RULES:
• \`strategy\` is one short noun phrase naming the chosen approach.
  Good: "Synchronous FIFO with Gray-code pointers".
  Bad:  "A robust and scalable FIFO solution".
• \`description\` has 2–3 sentences. EACH sentence states ONE concrete
  decision and the trade-off it makes. No filler.
  Good: "Pointers are Gray-coded to allow safe two-FF synchronisation
  across the read and write clock domains. Memory is implemented as a
  registered array; this trades area for predictable timing on FPGAs.
  Empty/full are derived combinationally from synchronised pointers."
  Bad:  "This module implements a high-performance, robust FIFO suitable
  for many applications."

SELF-CHECK (mental, before emit):
[ ] Every Mermaid node id is either in \`blocks\` or an external port.
[ ] Every block in \`blocks\` appears in the diagram.
[ ] No subgraph, classDef, style, click in mermaid.
[ ] No implementation details that belong to RTL gen.
[ ] Strategy is a noun phrase, not marketing prose.
${childSection}

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}
