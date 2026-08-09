// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// wiringCheck — deterministic system-wiring checker (SoC roadmap S2)
//
// The dominant integration bug class — connections to nonexistent child ports,
// unconnected child inputs, bogus paramOverrides, instances that were planned
// but never placed — is structurally checkable from artifacts that already
// exist: the child RTL headers and the instance list decompose emits. This
// runs FIRST inside int_lint (zero tokens, instant) so the classic bugs are
// caught and attributed before any LLM or even Verilator is consulted.
//
// Degradation contract: anything this parser cannot read (exotic formatting,
// positional connections) produces a WARNING, never a false error — real
// Verilator lint still sees the full sources right after.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Comments out, before anything is parsed as structure.
 *
 * A port list is commented like any other code, and those comments sit INSIDE
 * the parentheses this parser splits on commas:
 *
 *   (
 *       input  logic            clk,
 *       input  logic            rst_n,
 *       // Instruction memory: address out in fetch, word back in decode
 *       output logic [XLEN-1:0] imem_addr,
 *
 * Splitting that on commas yields "… address out in fetch" as an entry. Its
 * last identifier is `fetch`, and the direction keyword is sticky from the
 * port above, so a phantom `input fetch` joins the interface. Measured
 * (run 51): rv_pipeline gained two — `fetch` and `memory`, one from each
 * memory-interface comment — and the top was told to connect ports that do
 * not exist. The repair prompt asks for the MINIMAL fix, so obeying it means
 * inventing connections that cannot compile; refusing means burning the
 * retries. Neither is recoverable, which is why this runs before the split
 * rather than filtering the result afterwards.
 */
function stripComments(code) {
  return String(code || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/** Split a comma-separated list at depth 0 (respects (), [], {}). */
function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of String(s || "")) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Parse a module header from source → { ports: [{name, dir}], params: [name] } | null. */
export function parseModuleHeader(code, modName) {
  const re = new RegExp("module\\s+" + modName + "\\b([\\s\\S]*?)\\)\\s*;");
  const m = stripComments(code).match(re);
  if (!m) return null;
  const header = m[1];
  const params = [];
  const pm = header.match(/#\s*\(([\s\S]*?)\)\s*\(/);
  if (pm) {
    for (const entry of splitTop(pm[1])) {
      const nm = entry.match(/([A-Za-z_]\w*)\s*=\s*/);
      if (nm) params.push(nm[1]);
    }
  }
  // Port section = everything after the LAST "(" that starts the port list.
  const portSrc = pm ? header.slice(header.indexOf(pm[0]) + pm[0].length) : header.replace(/^[\s\S]*?\(/, "");
  const ports = [];
  let dir = null;
  for (const entry of splitTop(portSrc)) {
    const t = entry.trim();
    const dm = t.match(/^(input|output|inout)\b/);
    if (dm) dir = dm[1];
    const nm = t.match(/([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*$/);   // last identifier = the name
    if (nm && dir && nm[1] !== "logic" && nm[1] !== "wire" && nm[1] !== "reg") {
      ports.push({ name: nm[1], dir });
    }
  }
  return { ports, params };
}

/** Find `<moduleId> [#(overrides)] <instanceName> ( … );` in the top RTL with
 *  balanced parens → { connections: [names], overrides: [names] } | null. */
export function parseInstantiation(topRTL, moduleId, instanceName) {
  // Comments out here too: a port map is commented as freely as a port list,
  // and a mention of the module type inside one would anchor the scan below on
  // prose rather than on the instantiation.
  const src = stripComments(topRTL);
  // EVERY occurrence of the module type, not just the first. A module type
  // placed twice — `ingress_channel … u_ch0` then `ingress_channel … u_ch1` —
  // let the non-global match anchor on u_ch0's occurrence and scan forward to
  // `u_ch1(`, so the span between them held u_ch0's own `);` and the
  // statement guard below rejected it. Every instance after the first read as
  // MISSING_INSTANCE, and the repair prompt was asked to add an instance that
  // was already there (measured, run 48: u_ch1).
  // Scan from EVERY occurrence of the type name. matchAll cannot help here:
  // its matches never overlap, so the first (rejected) match starting at
  // u_ch0 already consumes the u_ch1 occurrence that would have matched.
  const typeRe = new RegExp("\\b" + moduleId + "\\b", "g");
  const tailRe = new RegExp("^([\\s\\S]*?)\\b" + instanceName + "\\s*\\(");
  let m = null;
  let between = null;
  let tm;
  while ((tm = typeRe.exec(src)) !== null) {
    const rest = src.slice(tm.index + tm[0].length);
    const cand = rest.match(tailRe);
    if (!cand) continue;
    if (/;|endmodule/.test(cand[1])) continue;    // spans a statement — not this instance
    between = cand[1];
    m = { index: tm.index + tm[0].length + cand.index, 0: cand[0] };
    break;
  }
  if (!m) return null;
  const overrides = [];
  for (const om of between.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) overrides.push(om[1]);
  // Balance the connection body from the "(" after the instance name.
  let i = m.index + m[0].length, depth = 1, body = "";
  while (i < src.length && depth > 0) {
    const ch = src[i++];
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) break; }
    if (depth > 0) body += ch;
  }
  if (depth !== 0) return null;
  const connections = [];
  for (const cm of body.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) connections.push(cm[1]);
  return { connections, overrides, body };
}

/**
 * Check the assembled system's wiring. Pure.
 * @param {{topRTL: string, children: Array<{modName, code}>, instances: Array}} sys
 * @returns {{issues: Array<{sev, kind, msg, instance?}>}}
 */
export function checkSystemWiring(sys) {
  const { topRTL, children, instances, topModuleId } = sys || {};
  const issues = [];
  const push = (sev, kind, msg, instance) => issues.push(
    instance ? { sev, kind, msg, instance, structural: true } : { sev, kind, msg, structural: true });

  const ifaceByMod = {};
  for (const c of (children || [])) {
    ifaceByMod[c.modName] = parseModuleHeader(c.code, c.modName);
  }

  // Only the instances the TOP is responsible for placing. A deeper instance
  // — sync_fifo inside ingress_channel — is placed by its own parent, and
  // demanding it appear in the top's source reports a correct system as
  // broken and asks the repair prompt to instantiate a grandchild the top
  // must not touch (measured, run 48: u_fifo). At depth one every instance's
  // parent IS the top, which is why this could not surface before.
  // Deeper placements are checked where they belong: a parent's own stages
  // compile against its children, so a missing instantiation fails to
  // elaborate there.
  const planList = (instances || []).filter(function(inst) {
    if (!topModuleId || !inst || !inst.parentModuleId) return true;
    return inst.parentModuleId === topModuleId;
  });

  const seenNames = new Set();
  const instantiatedMods = new Set();
  for (const inst of planList) {
    const name = inst.instanceName || "?";
    if (seenNames.has(name)) {
      push("error", "DUPLICATE_INSTANCE", "instance name '" + name + "' is used more than once", name);
      continue;
    }
    seenNames.add(name);

    const iface = ifaceByMod[inst.moduleId];
    if (iface === undefined) {
      push("error", "UNKNOWN_MODULE", "instance '" + name + "' references module type '" + inst.moduleId + "' which has no RTL", name);
      continue;
    }
    const parsed = parseInstantiation(topRTL, inst.moduleId, name);
    if (!parsed) {
      push("error", "MISSING_INSTANCE", "planned instance '" + name + "' (" + inst.moduleId + ") is not instantiated in the top module", name);
      continue;
    }
    instantiatedMods.add(inst.moduleId);
    if (iface === null) {
      push("warning", "UNPARSED_HEADER", "could not parse the header of '" + inst.moduleId + "' — port checks skipped for '" + name + "'", name);
      continue;
    }
    if (parsed.connections.length === 0 && iface.ports.length > 0) {
      push("warning", "UNPARSED_CONNECTIONS", "no named connections found for '" + name + "' (positional or exotic style) — connection checks skipped", name);
      continue;
    }
    const portByName = Object.fromEntries(iface.ports.map((p) => [p.name, p]));
    for (const conn of parsed.connections) {
      if (!portByName[conn]) {
        push("error", "NO_SUCH_PORT", "'" + name + "' connects '." + conn + "' but module '" + inst.moduleId + "' has no such port", name);
      }
    }
    const connected = new Set(parsed.connections);
    for (const p of iface.ports) {
      if (connected.has(p.name)) continue;
      if (p.dir === "input") push("error", "UNCONNECTED_INPUT", "'" + name + "' leaves input '" + p.name + "' of '" + inst.moduleId + "' unconnected", name);
      else push("warning", "UNCONNECTED_OUTPUT", "'" + name + "' leaves output '" + p.name + "' of '" + inst.moduleId + "' unconnected", name);
    }
    for (const ov of Object.keys(inst.paramOverrides || {})) {
      if (!iface.params.includes(ov)) {
        push("error", "BAD_PARAM", "'" + name + "' overrides parameter '" + ov + "' which '" + inst.moduleId + "' does not declare", name);
      }
    }
  }

  for (const c of (children || [])) {
    // "planned" spans the WHOLE system: a module placed by a child rather
    // than by the top is still placed, and must not be called unused.
    const planned = (instances || []).some((i) => i.moduleId === c.modName);
    const placedByTop = planList.some((i) => i.moduleId === c.modName);
    if (planned && !placedByTop) continue;        // someone deeper places it
    if (planned && !instantiatedMods.has(c.modName)) continue;   // already reported per-instance
    if (!planned) {
      push("warning", "UNUSED_MODULE", "module '" + c.modName + "' was generated but no instance places it", null);
    }
  }

  return { issues };
}
