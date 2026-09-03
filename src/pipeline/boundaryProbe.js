// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// ═══════════════════════════════════════════════════════════════════════════
// boundaryProbe — measure where behaviour actually changes, don't assert it
//
// WHY THIS EXISTS:
//
// A requirement that names a duration ("splatters after falling for more than
// 20 clock cycles") gets translated three times on its way to a green run —
// into a requirement, into RTL, and into testbench stimulus — and every
// translation is an opportunity for the same off-by-one. Measured on
// run 55: the requirement restated "more than 20 cycles" as "counter
// reached 21 or more", the RTL implemented `fall_counter > 20`, and the
// generated testbench's OWN reference model contained the identical
// `ref_fall_count > 20`. Design and oracle agreed perfectly, verify reported
// 128/128, judge passed at 100, and the shipped design splatted one cycle
// late — and an independent reference implementation rejected it.
//
// Nothing already in the pipeline can see that:
//   - the testbench can't: its oracle came from the same misconception;
//   - the mutation gate can't: the TB *does* kill a `>`→`>=` mutant, because
//     the mutant disagrees with the (wrong) oracle. Mutation score measures
//     whether a TB notices change, not whether it demands correct behaviour;
//   - review can't: the RTL faithfully implements the requirement it was given.
//
// So this gate measures instead. It sweeps the physical quantity the prose
// names, finds the smallest value at which the observable event first fires,
// and compares that against the number the prose implies. No reference model
// is involved, and no reference design — only "did the event happen", which is
// directly observable, plus arithmetic on the requirement's own wording.
//
// THE ONE DESIGN RULE: the harness owns the counting.
//
// The whole defect class is a miscount, so the count must not come from the
// same place as the design. The model supplies four small primitives
// (precondition / apply-one-unit / settle / event-occurred) and this module
// emits the `repeat (n)` around them. `bp_apply_one` is rejected outright if
// it contains a loop — see validatePrimitives.
//
// HOW IT FITS THE PIPELINE:
//
// verify.js calls runBoundaryGate after a CLI-backed verify, like the
// mutation gate. Results land on verify.boundaries = [{req, measuredFirst,
// expectedFirst, status, …}] and the `boundary_match` criterion gates on
// them. A mismatch triages to rtl_generate carrying both numbers, which is a
// far stronger repair instruction than a list of failing test names.
// ═══════════════════════════════════════════════════════════════════════════
import { runCli } from "../cli/index.js";
import { withSharedPackage, childRtlFiles, cmdWithFiles } from "./cliFiles.js";

// ── 1. Deterministic threshold extraction ───────────────────────────────────
// Fires only on ONE unambiguous comparator + integer + time unit in a
// requirement's prose. Everything else is skipped with a reason: declining to
// measure costs nothing, a wrong verdict costs a regeneration round.
const UNIT_RE = "(clock cycles?|cycles?|clocks?)";
// Comparator BEFORE the number: "more than 20 clock cycles".
const PREFIX_COMPARATORS = [
  { src: "\\bmore than\\b",           kind: "strict",    offset: 1 },
  { src: "\\bexceed(?:s|ed|ing)?\\b", kind: "strict",    offset: 1 },
  { src: "\\blonger than\\b",         kind: "strict",    offset: 1 },
  { src: "\\bgreater than\\b",        kind: "strict",    offset: 1 },
  { src: "\\bat least\\b",            kind: "inclusive", offset: 0 },
  { src: "\\bminimum of\\b",          kind: "inclusive", offset: 0 },
];
// Comparator AFTER the unit: "5 clock cycles or more".
const SUFFIX_COMPARATORS = [
  { src: "or more\\b",    kind: "inclusive", offset: 0 },
  { src: "or longer\\b",  kind: "inclusive", offset: 0 },
  { src: "or greater\\b", kind: "inclusive", offset: 0 },
];

/**
 * @param {Array} requirements  spec.requirements ({id, desc, pri, …})
 * @returns {Array} one entry per requirement: {req, status:"measure"|"skip", …}
 */
export function extractThresholds(requirements) {
  const out = [];
  for (const r of (requirements || [])) {
    const id = r && r.id;
    if (!id) continue;
    // Parentheticals are stripped FIRST. A requirement that restates a duration
    // as an internal counter value ("(counter reached 21 or more)") is smuggling
    // an implementation decision into a requirement, and on run 55 that
    // parenthetical was the half that was wrong — the prose half was right.
    const prose = String(r.desc || "").replace(/\([^)]*\)/g, " ");
    const hits = [];
    for (const c of PREFIX_COMPARATORS) {
      const re = new RegExp(c.src + "\\s+(\\d+)\\s+" + UNIT_RE, "gi");
      let m;
      while ((m = re.exec(prose)) !== null) {
        hits.push({ number: parseInt(m[1], 10), kind: c.kind, offset: c.offset, unit: m[2] });
      }
    }
    for (const c of SUFFIX_COMPARATORS) {
      const re = new RegExp("(\\d+)\\s+" + UNIT_RE + "\\s+" + c.src, "gi");
      let m;
      while ((m = re.exec(prose)) !== null) {
        hits.push({ number: parseInt(m[1], 10), kind: c.kind, offset: c.offset, unit: m[2] });
      }
    }
    if (hits.length !== 1) {
      out.push({ req: id, status: "skip",
                 why: hits.length === 0 ? "no unambiguous threshold phrase"
                                        : hits.length + " threshold phrases — ambiguous" });
      continue;
    }
    const h = hits[0];
    if (!isFinite(h.number) || h.number < 1 || h.number > 10000) {
      out.push({ req: id, status: "skip", why: "threshold out of measurable range" });
      continue;
    }
    out.push({
      req: id, status: "measure", desc: r.desc, pri: r.pri || null,
      number: h.number, kind: h.kind, unit: h.unit,
      expectedFirst: h.number + h.offset,
    });
  }
  return out;
}

// ── 2. Primitive validation ─────────────────────────────────────────────────
const BANNED_ANYWHERE = [
  { re: /\bmodule\b|\bendmodule\b/, why: "declares a module" },
  { re: /\$finish|\$stop/,          why: "ends the simulation" },
  { re: /\binitial\b|\balways\b/,   why: "declares a procedural block" },
];
// apply_one must advance the quantity by EXACTLY one unit. A loop in there
// would hand the counting back to the model, which is the entire bug class.
const BANNED_IN_APPLY = [
  { re: /\brepeat\s*\(/, why: "contains repeat()" },
  { re: /\bfor\s*\(/,    why: "contains a for loop" },
  { re: /\bwhile\s*\(/,  why: "contains a while loop" },
  { re: /\bforever\b/,   why: "contains forever" },
];

/** @returns {{ok:true}|{ok:false, why:string}} */
export function validatePrimitives(p) {
  if (!p || typeof p !== "object") return { ok: false, why: "no primitives returned" };
  const fields = ["precondition", "applyOne", "settle", "eventExpr"];
  for (const f of fields) {
    if (typeof p[f] !== "string" || !p[f].trim()) return { ok: false, why: "missing " + f };
    for (const b of BANNED_ANYWHERE) {
      if (b.re.test(p[f])) return { ok: false, why: f + " " + b.why };
    }
  }
  for (const b of BANNED_IN_APPLY) {
    if (b.re.test(p.applyOne)) return { ok: false, why: "apply_one " + b.why };
  }
  return { ok: true };
}

// ── 3. Probe source ─────────────────────────────────────────────────────────
/** Port declarations + connection list for the DUT, from spec.iface. */
function portsOf(iface) {
  const decls = [];
  const conns = [];
  for (const p of (iface || [])) {
    if (!p || !p.name) continue;
    const w = String(p.width == null ? "1" : p.width).trim();
    const range = (w === "1" || w === "") ? "" : "[" + (/[:\[]/.test(w) ? w.replace(/^\[|\]$/g, "") : (String(parseInt(w, 10) - 1) + ":0")) + "] ";
    decls.push("  logic " + range + p.name + ";");
    conns.push("." + p.name + "(" + p.name + ")");
  }
  return { decls: decls.join("\n"), conns: conns.join(", ") };
}

/**
 * Emit the probe. The `repeat (N)` below is the point of the whole module:
 * it is written here, deterministically, never by the model.
 */
export function buildProbeSource(opts) {
  const { decls, conns } = portsOf(opts.iface);
  // The harness owns time as well as the count: it generates the clock and
  // carries its own watchdog, so a probe can neither stall the backend nor
  // depend on the model remembering to tick anything.
  const half = (opts.halfPeriod || 5);
  const timeout = 2 * half * (Number(opts.n) + 64) + 100;
  return `\`timescale 1ns/1ps
// AUTO-GENERATED boundary probe — ${opts.req} (n = ${opts.n} ${opts.unit})
module boundary_probe;
${decls}
  ${opts.dutName} dut (${conns});
  initial ${opts.clk} = 1'b0;
  always #${half} ${opts.clk} = ~${opts.clk};
  initial begin : watchdog
    #${timeout};
    $display("BOUNDARY_PROBE n=%0d TIMEOUT", ${opts.n});
    $finish;
  end
  task automatic bp_step(); @(posedge ${opts.clk}); #1; endtask
  task automatic bp_precondition();
${opts.primitives.precondition}
  endtask
  task automatic bp_apply_one();
${opts.primitives.applyOne}
  endtask
  task automatic bp_settle();
${opts.primitives.settle}
  endtask
  function automatic logic bp_event();
    return (${opts.primitives.eventExpr});
  endfunction
  initial begin : sweep
    bp_precondition();
    repeat (${opts.n}) bp_apply_one();     // <- harness-owned count
    bp_settle();
    $display("BOUNDARY_PROBE n=%0d event=%0d", ${opts.n}, bp_event());
    $finish;
  end
endmodule
`;
}

// ── 4. Verdict ──────────────────────────────────────────────────────────────
/**
 * A usable measurement is a single clean false→true transition inside the
 * window. Anything else is inconclusive — never a failure, because a shaky
 * probe must not manufacture a defect.
 */
export function verdictOf(seen, expectedFirst) {
  const ns = Object.keys(seen).map(Number).sort(function(a, b) { return a - b; });
  if (ns.length < 2) return { status: "inconclusive", why: "not enough sample points" };
  if (seen[ns[0]] !== 0) return { status: "inconclusive", why: "event already true at the bottom of the range" };
  if (seen[ns[ns.length - 1]] !== 1) return { status: "inconclusive", why: "event never fires within the swept range" };
  const first = ns.find(function(n) { return seen[n] === 1; });
  for (const n of ns) {
    if (n > first && seen[n] === 0) {
      return { status: "inconclusive", why: "non-monotonic: the event toggles back off at n=" + n };
    }
  }
  return {
    status: first === expectedFirst ? "match" : "mismatch",
    measuredFirst: first, expectedFirst: expectedFirst, delta: first - expectedFirst,
  };
}

/** Human-readable one-liner used in logs, the report and the repair prompt. */
export function describeBoundary(b) {
  const head = b.req + ": \"" + b.kind + " " + b.number + " " + b.unit + "\" → first event expected at " + b.expectedFirst;
  if (b.status === "match") return "✓ " + head + ", measured " + b.measuredFirst;
  if (b.status === "mismatch") {
    return "✗ " + head + ", MEASURED " + b.measuredFirst
      + " (off by " + (b.delta > 0 ? "+" : "") + b.delta + ")";
  }
  return "? " + head + " — inconclusive: " + (b.why || "");
}

// ── 5. The gate ─────────────────────────────────────────────────────────────
/**
 * @param {object} args {rtl, iface, requirements, clk, cmds, rtlFileName,
 *                       config, cliOpts, signal, appendLog, askPrimitives,
 *                       runCli (optional override),
 *                       sharedPackageCode, childInterfaces, dutName}
 *   askPrimitives(threshold) -> {applicable, quantity, precondition, applyOne,
 *                                settle, eventExpr, reason}
 * @returns {Array|null} verify.boundaries rows, or null when nothing measurable
 */
export async function runBoundaryGate(args) {
  // Injectable so the sweep can be exercised without a simulator backend.
  const cli = (args && args.runCli) || runCli;
  const thresholds = extractThresholds(args.requirements).filter(function(t) { return t.status === "measure"; });
  if (thresholds.length === 0) return null;
  const WINDOW = (args.config && args.config.boundaryProbeWindow) || 3;
  const rows = [];
  for (const t of thresholds) {
    if (args.signal && args.signal.aborted) {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }
    let prim = null;
    try {
      prim = await args.askPrimitives(t);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      rows.push(Object.assign({}, t, { status: "inconclusive", why: "probe generation failed: " + ((e && e.message) || e) }));
      continue;
    }
    if (prim && prim.applicable === false) {
      rows.push(Object.assign({}, t, { status: "inconclusive", why: prim.reason || "no observable event for this threshold" }));
      continue;
    }
    const v = validatePrimitives(prim);
    if (!v.ok) {
      args.appendLog("⚠ Boundary probe rejected (" + t.req + ")",
        "The generated probe " + v.why + " — the harness must own the count, so this probe is not used.");
      rows.push(Object.assign({}, t, { status: "inconclusive", why: "probe rejected: " + v.why }));
      continue;
    }
    const lo = Math.max(0, t.expectedFirst - WINDOW);
    const hi = t.expectedFirst + WINDOW;
    const seen = {};
    let broke = null;
    for (let n = lo; n <= hi; n++) {
      const src = buildProbeSource({
        req: t.req, n: n, unit: t.unit, iface: args.iface,
        dutName: args.dutName, clk: args.clk, primitives: prim,
      });
      const probeFile = "boundary_probe.sv";
      const files = withSharedPackage(
        Object.assign(childRtlFiles(args.childInterfaces),
                      { [args.rtlFileName]: args.rtl, [probeFile]: src }),
        args.sharedPackageCode);
      const res = await cli(args.config.backendUrl, {
        commands: args.cmds.map(function(c) {
          const srcs = files.order.filter(function(f) { return f !== probeFile; });
          return cmdWithFiles(c, srcs, args.rtlFileName).replace(/\{TB\}/g, probeFile);
        }),
        files: files.files,
      }, args.signal, args.cliOpts);
      if (!res || res._error) { broke = "backend error at n=" + n; break; }
      const m = /BOUNDARY_PROBE n=\d+ event=(\d)/.exec(res.stdout || "");
      if (!m) { broke = "probe produced no result at n=" + n; break; }
      seen[n] = parseInt(m[1], 10);
    }
    if (broke) {
      rows.push(Object.assign({}, t, { status: "inconclusive", why: broke }));
      continue;
    }
    const row = Object.assign({}, t, verdictOf(seen, t.expectedFirst), { sweep: seen, quantity: (prim && prim.quantity) || t.unit });
    rows.push(row);
    args.appendLog(
      row.status === "mismatch" ? "✗ Boundary mismatch — " + t.req : "Boundary probe — " + t.req,
      describeBoundary(row) + "\n  sweep: "
        + Object.keys(seen).map(Number).sort(function(a, b) { return a - b; })
            .map(function(n) { return n + ":" + (seen[n] ? "X" : "."); }).join(" ")
        + "   (X = event fired)"
        + (row.status === "mismatch"
            ? "\n  The design's own behaviour disagrees with the requirement's wording. "
              + "No reference model was used — this is the measured transition point."
            : ""));
  }
  return rows.length > 0 ? rows : null;
}
