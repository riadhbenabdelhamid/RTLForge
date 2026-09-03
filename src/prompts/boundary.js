// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// ═══════════════════════════════════════════════════════════════════════════
// prompts/boundary — probe primitives for the boundary-measurement gate
//
// The model's ONLY job here is to say what one unit of the measured quantity
// looks like in pin wiggles, and what the observable event is. It never counts
// anything: pipeline/boundaryProbe.js emits the `repeat (n)` loop. That split
// is deliberate — the defect this gate exists to catch (run 55) was one
// miscount repeated independently in the requirement, the RTL and the
// testbench stimulus, so the count must not come from the model a fourth time.
// ═══════════════════════════════════════════════════════════════════════════
import { sys } from "./base.js";

/** Structured output for the four probe primitives. */
export const BOUNDARY_PROBE_SCHEMA = {
  name: "boundary_probe",
  strict: false,
  schema: {
    type: "object",
    properties: {
      applicable:   { type: "boolean" },
      quantity:     { type: "string" },
      precondition: { type: "string" },
      applyOne:     { type: "string" },
      settle:       { type: "string" },
      eventExpr:    { type: "string" },
      reason:       { type: "string" },
    },
    required: ["applicable"],
    additionalProperties: true,
  },
};

/**
 * @param {string} rtl        the design under measurement (for port/behaviour context)
 * @param {object} threshold  one extractThresholds() row ({req, desc, number, kind, unit, expectedFirst})
 * @param {Array}  iface      spec.iface — the probe declares one logic per port
 * @param {string} clk        clock port name
 * @param {object} el         elicit data (modName)
 */
export function promptBoundaryPrimitives(rtl, threshold, iface, clk, el) {
  const ports = (iface || []).map(function(p) {
    return "  " + (p.dir || "input") + " " + (p.name || "?")
      + (p.width && String(p.width) !== "1" ? " [" + p.width + "]" : "")
      + (p.desc ? "   // " + p.desc : "");
  }).join("\n");
  return {
    systemPrompt: sys(
      "You are writing a measurement fixture, not a test. It has no expected "
      + "values and no reference model: it establishes a starting condition, "
      + "advances one unit of a physical quantity, and reports whether an "
      + "observable event happened. Something else decides how many units to apply."),
    maxTokens: 1200,
    jsonSchema: BOUNDARY_PROBE_SCHEMA,
    userMessage: `\
TASK: write four small SystemVerilog fragments that let a harness MEASURE where
this requirement's behaviour actually changes.

MODULE: ${el && el.modName ? el.modName : "TopModule"}
PORTS:
${ports}

REQUIREMENT UNDER MEASUREMENT (${threshold.req}):
${threshold.desc}

THE QUANTITY TO MEASURE: ${threshold.unit} — the requirement's threshold is
"${threshold.kind} ${threshold.number} ${threshold.unit}".

DESIGN (context only — describe the SPEC's behaviour, never copy the design's
own threshold arithmetic into your fragments):
${rtl}

Return JSON with these fields. Each fragment is a BODY only: no module, no
initial/always block, no $finish.

  "applicable"   true if this threshold has an observable event at the module's
                 outputs. false (with "reason") if it is internal-only — say so
                 rather than inventing a proxy.
  "quantity"     one short phrase naming what one unit is, e.g. "clock cycles
                 with ground held low while falling".
  "precondition" statements that reset the module and establish the state from
                 which the quantity starts accumulating. End it at the exact
                 moment the first unit is about to be applied.
  "applyOne"     statements that advance the quantity by EXACTLY ONE unit.
                 A single clock step is typical: bp_step() is provided
                 (@(posedge ${clk}); #1;). This MUST NOT contain repeat/for/
                 while/forever — a probe that loops is rejected, because the
                 harness owns the count.
  "settle"       statements that end the accumulation and let the module react,
                 e.g. restore the input that was driving it and step once.
  "eventExpr"    ONE boolean expression over the module's OUTPUTS that is true
                 iff the requirement's event has occurred. No internal signals.

Available helper: bp_step() — one clock edge plus settle delay.
Every port above is declared as a variable of the same name; drive inputs
directly, read outputs directly.

Write for the SPECIFICATION's behaviour. If the design implements the
threshold incorrectly, these fragments must still measure the truth — that
disagreement is exactly what the harness is looking for.`,
  };
}
