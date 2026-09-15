// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// An observation ledger, not a circuit or latency inference engine. All
// values come from labelled source rows, including unknown initial inputs.
// No candidate RTL, generated requirements, or reference design is consulted.
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function clockBit(value) {
  const s = String(value || "").toLowerCase().replace(/_/g, "");
  if (/^(?:1'[bhd]|0[bxd])?[01]$/.test(s)) return s.at(-1);
  return null;
}

export function sourceClockPorts(source, ports) {
  return (ports || []).filter(p => p.dir === "input" && (/^(clk|clock|clk_i)$/i.test(p.name)
    || new RegExp("\\b(?:posedge|negedge|(?:positive|negative|rising|falling)\\s+edge(?:\\s+of)?(?:\\s+the)?)\\s+" + escape(p.name) + "\\b", "i").test(String(source || ""))));
}

export function traceTimingAudit(source, tables, ports) {
  const text = String(source || "");
  const inputs = (ports || []).filter(p => p.dir === "input");
  const outputs = (ports || []).filter(p => p.dir === "output");
  const clocks = sourceClockPorts(text, ports);
  const before = /^\s*Inputs (?:are )?driven before (?:the )?clock edge\.\s*$/im.test(text);
  const after = /^\s*Inputs (?:are )?(?:driven|changed) after (?:the )?clock edge\.\s*$/im.test(text);
  const convention = before && after ? "CONFLICT" : before ? "inputs-before-clock" : after ? "clock-before-inputs" : "UNSPECIFIED";
  const result = [];
  for (const table of tables || []) {
    if (!table.header.includes("time") || clocks.length !== 1) continue;
    const clock = clocks[0].name;
    if (!table.header.includes(clock)) continue;
    // A single source clock may be referred to as "the clock" in prose.
    const target = "(?:" + escape(clock) + "|clock)";
    const positive = new RegExp("\\b(?:posedge\\s+" + escape(clock) + "|(?:positive|rising)\\s+edge(?:\\s+of)?(?:\\s+the)?\\s+" + target + ")\\b", "i").test(text);
    const negative = new RegExp("\\b(?:negedge\\s+" + escape(clock) + "|(?:negative|falling)\\s+edge(?:\\s+of)?(?:\\s+the)?\\s+" + target + ")\\b", "i").test(text);
    const edge = positive && !negative ? "posedge" : negative && !positive ? "negedge" : "UNSPECIFIED";
    const value = (row, name) => row.cells[table.header.indexOf(name)];
    const data = inputs.filter(p => p.name !== clock && table.header.includes(p.name));
    const observed = outputs.filter(p => table.header.includes(p.name));
    const events = [];
    for (let i = 1; i < table.rows.length; i++) {
      const previous = table.rows[i - 1], row = table.rows[i];
      const oldClock = clockBit(value(previous, clock)), newClock = clockBit(value(row, clock));
      if (oldClock === null || newClock === null || oldClock === newClock) continue;
      const transition = newClock === "1" ? "posedge" : "negedge";
      if (edge !== "UNSPECIFIED" && edge !== transition) continue;
      events.push({ line: row.line, time: value(row, "time"), transition,
        inputsBefore: Object.fromEntries(data.map(p => [p.name, value(previous, p.name)])),
        inputsAtRow: Object.fromEntries(data.map(p => [p.name, value(row, p.name)])),
        outputsAtRow: Object.fromEntries(observed.map(p => [p.name, value(row, p.name)])),
        coincidentInputs: data.filter(p => value(previous, p.name) !== value(row, p.name)).map(p => p.name),
      });
    }
    const coincidentLines = events.filter(e => e.coincidentInputs.length).map(e => e.line);
    result.push({ table: table.id, clock, edge, convention, coincidentLines,
      status: convention === "CONFLICT" || coincidentLines.length && convention === "UNSPECIFIED" ? "UNRESOLVED" : "OBSERVED",
      eventCount: events.length, events: events.slice(0, 32), truncated: events.length > 32 });
  }
  return result;
}

export function traceTimingPrompt(audits) {
  if (!audits?.length) return "";
  return "\n\nCLOCKED TRACE OBSERVATIONS (source-only; not inferred latency)\n"
    + JSON.stringify(audits)
    + "\ninputsBefore is the previous displayed row; inputsAtRow is the current displayed row. "
    + "Neither automatically defines the value sampled at a coincident clock edge. Unknown initial values remain unknown. "
    + "Consider input-before-clock and clock-before-input orderings when the source does not specify one; "
    + "list any circuit/ordering combinations consistent with the defined observations. "
    + "An input first displayed at an edge can become available only after that edge. Waiting for the next sampling edge "
    + "does not by itself require another storage register. Do not translate this into a proven cycle delay. "
    + "Ask one question about the unresolved sampling convention before inferring extra latency. "
    + "If unanswered, choose a simplest source-consistent implementation only as a provisional hypothesis; "
    + "explicit latency/history requirements take precedence. A passing replay under a chosen ordering is conditional evidence, "
    + "not resolution of the ambiguity. Never change a frozen checker's phase to make a repair pass.";
}
