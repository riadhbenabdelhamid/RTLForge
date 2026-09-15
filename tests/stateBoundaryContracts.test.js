// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildSourceContract } from "../src/pipeline/sourceContract.js";

// Authored behavioral traces, independent of generated RTL and benchmarks.
// Counterexamples also exercise sources that explicitly require a different
// reset or recovery policy: no universal implementation is baked into replay.
function sourceRows(ports, samples, prose) {
  const names = ports.map(p => p.name);
  const literal = (name, value) => {
    if (value === undefined) return "x";
    const p = ports.find(p => p.name === name);
    return p.width === 1 ? String(value) : `${p.width}'d${value}`;
  };
  const line = (time, values) => `${time}ns ` + names.map(name => literal(name, values[name])).join(" ");
  const rows = ["time " + names.join(" ")];
  samples.forEach((sample, i) => {
    const inputs = Object.fromEntries(ports.filter(p => p.dir === "input").map(p => [p.name, sample[p.name]]));
    rows.push(line(i * 12, { ...inputs, tick: 0 }));
    rows.push(line(i * 12 + 6, { ...sample, tick: 1 }));
  });
  return prose + "\nAll updates occur on the positive edge of tick.\n\n" + rows.join("\n");
}
function simulate(rtl, contract) {
  expect(contract.status).toBe("READY");
  const dir = mkdtempSync(join(tmpdir(), "rtlforge-boundary-"));
  try {
    writeFileSync(join(dir, "dut.sv"), rtl);
    writeFileSync(join(dir, "tb.sv"), contract.suites[0].code);
    execFileSync("iverilog", ["-g2012", "-s", "BoundaryUnit_tb", "-o", "sim", "dut.sv", "tb.sv"], { cwd: dir, timeout: 10000 });
    return execFileSync("vvp", ["sim"], { cwd: dir, timeout: 10000, encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function historyFixture(width, transition, restart = false) {
  const ports = [
    { name: "tick", dir: "input", width: 1 }, { name: "clear", dir: "input", width: 1 },
    { name: "sample", dir: "input", width }, { name: "seen", dir: "output", width },
  ];
  const mask = 2 ** width - 1;
  const after = transition === "rise" ? mask : 0;
  const stimulus = [[1, 0], [1, mask], [0, after], [0, 3], [0, mask], [1, 0], [1, mask], [0, after], [0, 0]];
  let previous = 0, seen = 0;
  const samples = stimulus.map(([clear, sample]) => {
    const event = transition === "rise" ? ~previous & sample : previous & ~sample;
    seen = clear ? 0 : seen | (event & mask);
    previous = clear && restart ? 0 : sample;
    return { clear, sample, seen };
  });
  const source = sourceRows(ports, samples, `Record sampled ${transition} transitions until clear. Clear suppresses capture and clears seen. `
    + (restart ? "Clear also restarts input history at zero." : "Input history samples on every edge, including while clear is asserted."));
  const contract = buildSourceContract(source, { iface: ports }, "BoundaryUnit");
  const rtl = (history = "sample", captureOnClear = false) => `module BoundaryUnit(input tick, clear, input [${width - 1}:0] sample, output reg [${width - 1}:0] seen);
    reg [${width - 1}:0] prior;
    wire [${width - 1}:0] event_bits = ${transition === "rise" ? "~prior & sample" : "prior & ~sample"};
    always @(posedge tick) begin
      ${history === "sample" ? "prior <= sample;" : history === "reset" ? "if (clear) prior <= 0; else prior <= sample;" : "if (!clear) prior <= sample;"}
      if (clear) seen <= ${captureOnClear ? "event_bits" : "0"};
      else seen <= seen | event_bits;
    end
  endmodule`;
  return { contract, rtl };
}

function framedFixture(width, length, lateCompletes = false) {
  const start = 2 ** width - 4, marker = 2 ** width - 1, bits = width * length;
  const ports = [
    { name: "tick", dir: "input", width: 1 }, { name: "clear", dir: "input", width: 1 },
    { name: "symbol", dir: "input", width }, { name: "accepted", dir: "output", width: 1 },
    { name: "packet", dir: "output", width: bits },
  ];
  const payload = seed => Array.from({ length }, (_, i) => (seed + i * 3) % start);
  const stimulus = [[1, 0], [0, marker], [0, start], [0, 2], [1, 0], [0, marker],
    ...[start, ...payload(1), marker, start, ...payload(2), 0, 1, marker,
      start, ...payload(3), marker, start, ...payload(4), marker, marker].map(symbol => [0, symbol])];
  let phase = "idle", words = [], held;
  const samples = stimulus.map(([clear, symbol]) => {
    let accepted = 0;
    if (clear) { phase = "idle"; words = []; }
    else if (phase === "idle") { if (symbol === start) { phase = "data"; words = []; } }
    else if (phase === "data") { words.push(symbol); if (words.length === length) phase = "validate"; }
    else if (phase === "validate") {
      if (symbol === marker) { accepted = 1; phase = "idle"; }
      else phase = "recover";
    } else if (symbol === marker) { accepted = lateCompletes ? 1 : 0; phase = "idle"; }
    if (accepted) held = words.reduce((value, word) => value * 2 ** width + word, 0);
    return { clear, symbol, accepted, packet: accepted ? held : undefined };
  });
  const source = sourceRows(ports, samples, `A frame starts with symbol ${start}, carries ${length} words, then requires marker ${marker}. `
    + "Clear aborts a frame. Idle markers are ignored. Packet is defined only with accepted. "
    + (lateCompletes ? "After a missing expected marker, a late marker completes the retained frame."
      : "A missing expected marker rejects the frame. A later marker only resynchronizes; it does not accept that frame.")
    + " The next frame can begin on the next sampling edge.");
  const contract = buildSourceContract(source, { iface: ports }, "BoundaryUnit");
  const rtl = (completeOnRecovery = false) => `module BoundaryUnit(input tick, clear, input [${width - 1}:0] symbol,
      output reg accepted, output reg [${bits - 1}:0] packet);
    integer phase, count;
    reg [${bits - 1}:0] buffer;
    always @(posedge tick) begin
      if (clear) begin phase <= 0; count <= 0; accepted <= 0; end
      else begin
        accepted <= 0;
        case (phase)
          0: if (symbol == ${start}) begin phase <= 1; count <= 0; end
          1: begin
            buffer <= (buffer << ${width}) | symbol;
            if (count == ${length - 1}) phase <= 2; else count <= count + 1;
          end
          2: if (symbol == ${marker}) begin accepted <= 1; packet <= buffer; phase <= 0; end else phase <= 3;
          3: if (symbol == ${marker}) begin phase <= 0; ${completeOnRecovery ? "accepted <= 1; packet <= buffer;" : ""} end
          default: phase <= 0;
        endcase
      end
    end
  endmodule`;
  return { contract, rtl };
}

describe("reset and transaction boundary evidence", () => {
  it.each([[5, "rise"], [11, "fall"]])("distinguishes history updates and reset priority at width %i (%s)", (width, transition) => {
    const f = historyFixture(width, transition);
    expect(simulate(f.rtl(), f.contract)).not.toContain("[FAIL]");
    for (const mutation of ["reset", "freeze"]) expect(simulate(f.rtl(mutation), f.contract)).toContain("[FAIL]");
    expect(simulate(f.rtl("sample", true), f.contract)).toContain("[FAIL]");
    const restart = historyFixture(width, transition, true);
    expect(simulate(restart.rtl("reset"), restart.contract)).not.toContain("[FAIL]");
    expect(simulate(restart.rtl(), restart.contract)).toContain("[FAIL]");
  });

  it.each([[4, 3], [5, 5]])("separates rejection, recovery and fresh acceptance at width %i, length %i", (width, length) => {
    const f = framedFixture(width, length);
    expect(simulate(f.rtl(), f.contract)).not.toContain("[FAIL]");
    expect(simulate(f.rtl(true), f.contract)).toContain("[FAIL]");
    const late = framedFixture(width, length, true);
    expect(simulate(late.rtl(true), late.contract)).not.toContain("[FAIL]");
    expect(simulate(late.rtl(), late.contract)).toContain("[FAIL]");
  });
});
