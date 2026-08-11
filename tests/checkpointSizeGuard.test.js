// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// The checkpoint size guard must never damage the design (run 48).
//
// It used to replace stage 4 (RTL) and stage 7 (TB) code with their LAST 500
// lines. A source file's header, ports and declarations are at the top, so
// the survivor could not parse — the next stage reported "syntax error,
// unexpected if" against a testbench that had been written correctly and had
// just simulated 136/136.
//
// Two independent defects made it worse than a bad heuristic:
//   1. modulesOut[modId].stageData is the LIVE reducer object, so trimming
//      in place mutated the design the run was still working on. Merely
//      SAVING a checkpoint corrupted the artifact in memory.
//   2. It was aimed at the wrong bytes. Measured on run 48's 5797 KB
//      payload: every code field together came to 98 KB — 1.7% — while
//      _log/_llms/_iterations telemetry was the rest. The guard destroyed
//      the design to reclaim a fiftieth of the payload and STILL left the
//      checkpoint over the cap.
//
// This is the "TB head-cut" class tracked since run 30 with an unidentified
// actor. The arithmetic identifies it: every sighting is a file longer than
// 500 lines cut to exactly 500 — run 30's champion-minus-7 (507 lines),
// run 39's 525-minus-25, run 48's 596-minus-97.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { serializeCheckpoint, CHECKPOINT_MAX_BYTES } from "../src/projectState/checkpoint.js";

/** A testbench longer than the old 500-line cut point, with a real header. */
function bigTb(lines) {
  const head = [
    "`timescale 1ns/1ps",
    "module pkt_merge_top_tb;",
    "  import merge_pkg::*;",
    "  logic clk;",
  ];
  const body = [];
  for (let i = head.length; i < lines - 1; i++) body.push("  // filler line " + i);
  return head.concat(body, ["endmodule"]).join("\n");
}

function stateWith(tbCode, logBytes) {
  return {
    modules: {
      pkt_merge_top: {
        stageData: {
          4:  { code: "module pkt_merge_top;\nendmodule" },
          7:  { code: tbCode, _log: "x".repeat(logBytes),
                _llms: [{ text: "y".repeat(logBytes), model: "claude-opus-5-bridge" },
                        { text: "z".repeat(16), model: "claude-opus-5-bridge" }] },
          11: { verdict: "PASS", _iterations: [{ iter: 1 }] },
        },
        completed: new Set([4, 7]),
      },
    },
    instances: {},
  };
}

const ui = { userDesc: "d", designMode: "system", config: {} };

describe("checkpoint size guard (run 48)", () => {
  it("keeps a 596-line testbench byte-identical when oversized", () => {
    const tb = bigTb(596);
    const st = stateWith(tb, 3 * 1024 * 1024);
    const payload = serializeCheckpoint(st, ui);
    expect(payload._oversized).toBe(true);
    expect(payload.modules.pkt_merge_top.stageData[7].code).toBe(tb);
    expect(payload.modules.pkt_merge_top.stageData[7].code.split("\n").length).toBe(596);
  });

  it("keeps the header — the fragment that used to survive could not parse", () => {
    const tb = bigTb(596);
    const payload = serializeCheckpoint(stateWith(tb, 3 * 1024 * 1024), ui);
    const kept = payload.modules.pkt_merge_top.stageData[7].code;
    expect(kept.startsWith("`timescale 1ns/1ps")).toBe(true);
    expect(kept).toContain("module pkt_merge_top_tb;");
    expect(kept.trimEnd().endsWith("endmodule")).toBe(true);
  });

  it("does not mutate the live reducer state it was handed", () => {
    const tb = bigTb(596);
    const st = stateWith(tb, 3 * 1024 * 1024);
    const liveStage = st.modules.pkt_merge_top.stageData[7];
    serializeCheckpoint(st, ui);
    // the running design must be exactly as it was before the save
    expect(liveStage.code).toBe(tb);
    expect(liveStage.code.split("\n").length).toBe(596);
    expect(liveStage._log).toBeDefined();
    expect(liveStage._trimmedForCheckpoint).toBeUndefined();
  });

  it("sheds the telemetry that actually holds the bytes", () => {
    const payload = serializeCheckpoint(stateWith(bigTb(596), 3 * 1024 * 1024), ui);
    const stage7 = payload.modules.pkt_merge_top.stageData[7];
    expect(stage7._log).toBeUndefined();
    expect(stage7._trimmedForCheckpoint).toContain("_log");
  });

  it("brings an oversized payload under the cap by dropping telemetry alone", () => {
    const payload = serializeCheckpoint(stateWith(bigTb(596), 3 * 1024 * 1024), ui);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(CHECKPOINT_MAX_BYTES);
    // …with the design intact
    expect(payload.modules.pkt_merge_top.stageData[7].code.split("\n").length).toBe(596);
    expect(payload.modules.pkt_merge_top.stageData[4].code).toContain("module pkt_merge_top;");
  });

  it("leaves a payload under the cap completely untouched", () => {
    const tb = bigTb(596);
    const payload = serializeCheckpoint(stateWith(tb, 1024), ui);
    expect(payload._oversized).toBeUndefined();
    const stage7 = payload.modules.pkt_merge_top.stageData[7];
    expect(stage7.code).toBe(tb);
    expect(stage7._log).toBeDefined();
    expect(stage7._trimmedForCheckpoint).toBeUndefined();
  });

  // Run 51. The guard fires on large runs, large runs are the ones worth
  // training on, and trainingExport reads the producing model out of _llms —
  // so every row exported from a trimmed checkpoint said model: null. A row a
  // model generated ITSELF and a row from a stronger teacher train very
  // differently, and after the trim nothing could tell them apart.
  it("keeps WHO produced a stage after shedding the bodies that said so", () => {
    // _llms is shed only when dropping _log first is not enough, so the
    // response bodies have to outweigh the cap on their own.
    const st = stateWith(bigTb(596), 1024);
    st.modules.pkt_merge_top.stageData[7]._llms = [
      { text: "y".repeat(5 * 1024 * 1024), model: "claude-opus-5-bridge" },
      { text: "z".repeat(16), model: "claude-opus-5-bridge" },
    ];
    const stage7 = serializeCheckpoint(st, ui).modules.pkt_merge_top.stageData[7];
    expect(stage7._trimmedForCheckpoint).toContain("_llms");
    expect(stage7._llms).toBeUndefined();          // the bulk is gone
    expect(stage7._models).toEqual(["claude-opus-5-bridge"]);   // the name is not
  });

  it("does not add a _models list when nothing was trimmed", () => {
    const payload = serializeCheckpoint(stateWith(bigTb(596), 1024), ui);
    expect(payload.modules.pkt_merge_top.stageData[7]._models).toBeUndefined();
  });
});
