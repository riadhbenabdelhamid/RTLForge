// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// constraints — Spec-to-RTL constraint propagation (auto SVA assume properties)
// Pure function — no LLM call.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Derives SVA `assume property` statements from spec parameter ranges
 * and interface width constraints.
 */
export function deriveConstraints(spec) {
  if (!spec) return [];
  const constraints = [];
  let idCounter = 1;

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
      code:
        "assume property (@(posedge clk) disable iff (!rst_n)\n" +
        "  (" + pName + " >= " + min + ") && (" + pName + " <= " + max + "));",
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
      code: "assume property (@(posedge clk) $bits(" + port.name + ") == " + wStr + ");",
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
