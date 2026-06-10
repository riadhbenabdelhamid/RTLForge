// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/formalProps — Stage 5: Formal SVA Property Generation
//
// Generates SVA assertions and cover statements bound to the DUT.
//
// Reliability features:
// - Requires one assert per Must requirement (traceable by req field).
// - bind_module is constrained to syntactically complete SV.
// - "disable iff" idiom is enforced for all safety properties.
// - Code strings use same JSON escaping rules.
// - Detects combinatorial vs single-clock vs multi-clock modules and adapts
//   the prompt instructions accordingly to avoid invalid SVA forms.
// - Includes auto-derived constraints in the prompt so the LLM doesn't
//   regenerate equivalent assume properties.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j, resolveModName } from "./base.js";

export function promptFormalProps(rtlCode, spec, el, childInterfaces, autoAssumptions) {
  const modName = resolveModName(el, spec);
  const ci = childInterfaces || [];
  const childSection = ci.length > 0 ? `

HIERARCHICAL PROPERTY GUIDANCE:
• Write interface-level properties at the parent's ports.
• For each child instance, add at least one property verifying the \
connection between parent signals and child instance ports is active \
(e.g. data flows through when valid is asserted).
• Child instances: ${j(ci.map(function(c) { return c.instanceName + " (" + c.moduleId + ")"; }))}` : '';

  // Include auto-derived constraints so the LLM doesn't duplicate them
  const aa = autoAssumptions || [];
  const constraintSection = aa.length > 0 ? `

AUTO-DERIVED CONSTRAINTS (already generated — do NOT duplicate these):
The following assume properties have been auto-generated from the spec's \
parameter ranges and interface width constraints. They will be included \
in the final SVA output automatically. Do NOT regenerate equivalent \
assume properties for these parameters or widths.
${aa.map(function(a) { return "// " + a.id + " — " + a.source + "\n" + a.code; }).join("\n\n")}` : '';

  // ── Analyse clock/reset nature from spec interface ──
  const iface = spec.iface || [];
  const clkSignals = iface.filter(function(p) {
    var n = (p.name || "").toLowerCase();
    return p.dir === "input" && (n === "clk" || n === "clock" || /^clk[_\d]/.test(n) || /^clock[_\d]/.test(n));
  });
  const rstSignals = iface.filter(function(p) {
    var n = (p.name || "").toLowerCase();
    return p.dir === "input" && (/rst/.test(n) || /reset/.test(n));
  });
  const isCombinatorialModule = clkSignals.length === 0;
  const isMultiClock = clkSignals.length > 1;

  // Derive reset polarity info
  var resetInfo = "";
  if (rstSignals.length > 0) {
    resetInfo = rstSignals.map(function(r) {
      var n = r.name || "";
      var desc = (r.desc || "").toLowerCase();
      var polarity = "unknown";
      if (/_n$/.test(n) || /^n_?rst/.test(n.toLowerCase()) || /^n_?reset/.test(n.toLowerCase()) || desc.indexOf("active-low") >= 0 || desc.indexOf("active low") >= 0) {
        polarity = "active-low (asserted when 0)";
      } else if (desc.indexOf("active-high") >= 0 || desc.indexOf("active high") >= 0 || !/n/.test(n.replace(/reset|rst/gi, ""))) {
        polarity = "active-high (asserted when 1)";
      }
      var syncAsync = desc.indexOf("async") >= 0 ? "asynchronous" : desc.indexOf("sync") >= 0 ? "synchronous" : "unspecified (check RTL)";
      return "  • " + n + ": polarity=" + polarity + ", type=" + syncAsync;
    }).join("\n");
  }

  var clockResetSection;
  if (isCombinatorialModule) {
    clockResetSection = `

MODULE NATURE: PURELY COMBINATORIAL (no clock signal detected)
This module has NO clock input. It is purely combinatorial logic.

CRITICAL RULES FOR COMBINATORIAL MODULES:
• Do NOT use @(posedge clk) or any clock-edge sampling — there is no clock.
• Do NOT use "disable iff" reset guards — there is no reset in a purely \
combinatorial context.
• Use immediate assertions (assert/assume/cover without "property") or \
use combinatorial SVA forms:
  - assert #0 (<boolean_expression>);       // immediate assertion
  - assume #0 (<boolean_expression>);       // immediate assumption
  - assert property (@(*) <expression>);    // deferred concurrent assertion (if tool supports)
• Cover statements should use immediate covers: cover #0 (<expression>);
• The bind module and property module must also be purely combinatorial.
${rstSignals.length > 0 ? "\nNote: Reset signal(s) detected despite no clock — these may be used for \
asynchronous clear/set logic. Reference them only if the RTL actually uses them:\n" + resetInfo : ""}`;
  } else if (isMultiClock) {
    clockResetSection = `

MODULE NATURE: MULTI-CLOCK SYNCHRONOUS (${clkSignals.length} clock domains detected)
Clock signals: ${clkSignals.map(function(c) { return c.name; }).join(", ")}
${rstSignals.length > 0 ? "Reset signals:\n" + resetInfo : "No reset signal detected — omit disable iff."}

CRITICAL RULES FOR MULTI-CLOCK MODULES:
• Each property must specify which clock domain it belongs to using \
the appropriate @(posedge <clk_signal>).
• Do NOT mix clock domains in a single property — this creates \
false failures.
• For cross-domain properties, use appropriate CDC-safe formulations \
(e.g. multi-cycle path assertions or synchroniser-aware checks).
• Use the correct reset signal and polarity for each clock domain. \
If a reset only applies to one domain, only guard properties in \
that domain with disable iff.`;
  } else {
    // Single-clock synchronous
    var clkName = clkSignals[0].name;
    clockResetSection = `

MODULE NATURE: SYNCHRONOUS (single clock domain)
Clock signal: ${clkName}
${rstSignals.length > 0 ? "Reset signals:\n" + resetInfo : "No reset signal detected — omit disable iff from all properties."}

RULES FOR SYNCHRONOUS MODULE:
• All concurrent properties must use @(posedge ${clkName}).
${rstSignals.length > 0 ? "• Use disable iff with the correct reset polarity as shown above. \\\nFor active-low reset (e.g. rst_n): disable iff (!rst_n). \\\nFor active-high reset (e.g. rst): disable iff (rst)." : "• Since no reset signal is present, do NOT include disable iff in any property."}`;
  }

  const schema = `{
  "properties": [
    {
      "id":   "SVA-001",
      "req":  "REQ-FUNC-001",
      "type": "assert | assume | restrict",
      "name": "<snake_case_property_name>",
      "desc": "<one sentence: what invariant this checks>",
      "code": "${isCombinatorialModule ? 'assert #0 (<boolean_expression>);' : 'assert property (@(posedge ' + (clkSignals[0] ? clkSignals[0].name : 'clk') + ')' + (rstSignals.length > 0 ? ' disable iff (' + (/_n$/.test((rstSignals[0] || {}).name || '') ? '!' + rstSignals[0].name : (rstSignals[0] || {}).name || 'rst') + ')' : '') + ' <antecedent> |-> <consequent>);'}"
    }
  ],
  "covers": [
    {
      "id":   "COV-001",
      "req":  "REQ-FUNC-001",
      "name": "<snake_case_cover_name>",
      "desc": "<one sentence: what scenario this witnesses>",
      "code": "${isCombinatorialModule ? 'cover #0 (<expression>);' : 'cover property (@(posedge ' + (clkSignals[0] ? clkSignals[0].name : 'clk') + ')' + (rstSignals.length > 0 ? ' disable iff (' + (/_n$/.test((rstSignals[0] || {}).name || '') ? '!' + rstSignals[0].name : (rstSignals[0] || {}).name || 'rst') + ')' : '') + ' <sequence>);'}"
    }
  ],
  "bind_module": "bind ${modName} ${modName}_props u_props (.*);"
}`;

  return {
    systemPrompt: sys(
      'You are RTL Forge, a formal verification expert. Every property you emit ' +
      'must reference signals that actually appear in the RTL source. Do not ' +
      'invent signal names. Do not duplicate auto-derived constraints.'
    ),
    maxTokens: 5000,
    userMessage: `\
TASK: Generate formal SVA properties and cover statements for the
"${modName}" module.

RTL SOURCE:
${rtlCode}

REQUIREMENTS:
${j(spec.requirements)}
${clockResetSection}
${constraintSection}
INPUT ASSUMPTIONS:
• Every signal name you reference MUST appear in either the spec interface
  above (\`spec.iface\`) or in the RTL source above. If a signal is internal,
  cite the line of its declaration in the property's \`desc\` field.
• Properties run inside a separate \`<modName>_props\` module bound to the DUT
  via \`bind\`. They observe DUT ports + visible internal signals.

THINKING STEPS (mental):
1. Map each Must requirement to at least one safety property (assert) or
   coverage scenario (cover).
2. Verify every referenced signal exists by name in the RTL source above.
3. ${isCombinatorialModule ? 'Use immediate assertion forms — no clock edges or disable iff.' : 'Ensure disable iff uses the correct reset polarity derived from the RTL.'}
4. Write the bind statement.
5. Emit JSON.

RULES — every item is mandatory:
• At least one \`assert property\` per Must requirement; the property's
  \`req\` field MUST equal an existing requirement \`id\`.
• 3–5 \`cover\` statements for key scenarios (e.g. empty/full, reset-in-flight,
  back-pressure, max value, overflow guard). Each cover's \`req\` field
  references a Must requirement when applicable, otherwise empty string.
• \`type\` is exactly one of: "assert" | "assume" | "restrict".
• \`name\` is snake_case, unique within the output.
• \`desc\` is one sentence stating the invariant or scenario.
• \`code\` is a complete, syntactically valid SV property line — no
  surrounding "property name; … endproperty" wrapper. The bind module emits
  named properties from these lines automatically.
• All multi-line code strings use \\n.
• \`bind_module\` is one complete \`bind <DUT> <modName>_props u_props (.*);\` line.
• Do NOT reference signals not in the RTL.
• Do NOT regenerate assume properties for parameter bounds / port widths
  already in the auto-derived constraints above.

EVIDENCE-BASED FALSE-CLAIM GUARD:
• If a Must requirement cannot be expressed as a property without referencing
  a signal that doesn't exist (e.g. an internal counter that wasn't declared),
  emit a property with \`type:"assert"\`, \`code:"// SKIPPED: <REQ-ID> requires
  signal <name> not present in RTL"\`, and \`desc\` explaining what is missing.
  The lint stage will surface these as gaps.
${childSection}
OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}
