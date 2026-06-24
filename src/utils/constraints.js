// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// constraints — Spec-to-RTL constraint propagation (auto SVA assume properties)
// Pure function — no LLM call.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect the clock + reset from the spec interface so auto-assumptions use the
 * design's ACTUAL clocking edge / reset polarity instead of a hardcoded
 * `@(posedge clk) disable iff (!rst_n)` (which breaks for `rst` active-high,
 * non-`clk` clock names, or combinational modules). Mirrors the analysis in
 * prompts/formalProps.js.
 * @returns {{clk: string|null, edge: string, reset: string|null, resetActive: string|null}}
 */
export function detectClockReset(spec) {
  const iface = (spec && spec.iface) || [];
  let clk = null, edge = "posedge", reset = null, resetActive = null;
  for (let i = 0; i < iface.length; i++) {
    const p = iface[i];
    if (!p || !p.name || p.dir !== "input") continue;
    const n = String(p.name).toLowerCase();
    const desc = String(p.desc || "").toLowerCase();
    if (!clk && (n === "clk" || n === "clock" || /^clk[_\d]/.test(n) || /^clock[_\d]/.test(n))) {
      clk = p.name;
      if (desc.indexOf("falling") >= 0 || desc.indexOf("negedge") >= 0) edge = "negedge";
    }
    if (!reset && (/rst/.test(n) || /reset/.test(n))) {
      reset = p.name;
      const low = /_n$/.test(n) || /^n_?rst/.test(n) || /^n_?reset/.test(n)
        || desc.indexOf("active-low") >= 0 || desc.indexOf("active low") >= 0;
      const high = desc.indexOf("active-high") >= 0 || desc.indexOf("active high") >= 0;
      // Active-low when the name/desc says so; otherwise active-high (bare `rst`).
      resetActive = (low && !high) ? ("!" + p.name) : p.name;
    }
  }
  return { clk: clk, edge: edge, reset: reset, resetActive: resetActive };
}

/** Wrap an SVA expression in an assumption that adapts to the detected clock/reset. */
function assumeProp(cr, expr) {
  if (cr.clk) {
    const dis = cr.resetActive ? " disable iff (" + cr.resetActive + ")" : "";
    return "assume property (@(" + cr.edge + " " + cr.clk + ")" + dis + "\n  " + expr + ");";
  }
  // Combinational module (no clock detected) → immediate assumption.
  return "always_comb assume (" + expr + ");";
}

/**
 * Derives SVA `assume property` statements from spec parameter ranges
 * and interface width constraints. The clocking event + reset disable condition
 * are derived from the spec interface (detectClockReset), not hardcoded.
 */
export function deriveConstraints(spec) {
  if (!spec) return [];
  const constraints = [];
  let idCounter = 1;
  const cr = detectClockReset(spec);

  // 1) Parameter range constraints: [min:max]
  const params = spec.params || [];
  const rangeRe = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]/;
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (!p.range) continue;
    const m = rangeRe.exec(String(p.range));
    if (!m) continue;
    const min = parseInt(m[1], 10);
    const max = parseInt(m[2], 10);
    if (Number.isNaN(min) || Number.isNaN(max)) continue;
    const pName = p.name || "UNKNOWN";
    constraints.push({
      id: "AUTO-ASSUME-" + String(idCounter++).padStart(3, "0"),
      code: assumeProp(cr, "(" + pName + " >= " + min + ") && (" + pName + " <= " + max + ")"),
      source: "Parameter " + pName + " range " + p.range,
    });
  }

  // 2) Width-consistency constraints: ports whose width references a parameter
  const paramNames = params.map((p) => p.name).filter(Boolean);
  const iface = spec.iface || [];
  for (let j = 0; j < iface.length; j++) {
    const port = iface[j];
    if (!port.width || !port.name) continue;
    const wStr = String(port.width);
    if (/^\d+$/.test(wStr)) continue; // skip pure numeric widths

    let referencesParam = false;
    for (let k = 0; k < paramNames.length; k++) {
      if (wStr.indexOf(paramNames[k]) >= 0) { referencesParam = true; break; }
    }
    if (!referencesParam) continue;

    constraints.push({
      id: "AUTO-ASSUME-" + String(idCounter++).padStart(3, "0"),
      code: assumeProp(cr, "$bits(" + port.name + ") == " + wStr),
      source: "Port " + port.name + " width = " + wStr,
    });
  }

  return constraints;
}

/** Builds the SVA source string for auto-assumptions (for export). */
export function buildAutoAssumptionsSVA(autoAssumptions) {
  if (!autoAssumptions || autoAssumptions.length === 0) return "";
  let lines = "// ═══════════════════════════════════════════════════════\n";
  lines += "// AUTO-DERIVED CONSTRAINTS (from spec parameter ranges)\n";
  lines += "// ═══════════════════════════════════════════════════════\n\n";
  for (let i = 0; i < autoAssumptions.length; i++) {
    const a = autoAssumptions[i];
    lines += "// " + a.id + " — " + a.source + "\n" + a.code + "\n\n";
  }
  return lines;
}
