// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Pins the live-progress counter contract that the in-flight stage panel
// depends on. The old inline logic recomputed counts as
// `events.filter(type).length` over a 500-capped array, so a stage emitting
// >500 live events silently UNDERCOUNTED. accumulateProgressSlot tracks the
// counters monotonically, independent of the bounded event tail.

import { describe, it, expect } from "vitest";
import {
  accumulateProgressSlot,
  countType,
  LIVE_EVENTS_CAP,
} from "../src/react/liveProgressReducer.js";

function llm(n) { const a = []; for (let i = 0; i < n; i++) a.push({ type: "llm" }); return a; }
function cli(n) { const a = []; for (let i = 0; i < n; i++) a.push({ type: "cli" }); return a; }

describe("countType", () => {
  it("counts only matching event types; tolerates junk", () => {
    expect(countType([{ type: "llm" }, { type: "cli" }, { type: "llm" }], "llm")).toBe(2);
    expect(countType([{ type: "state" }, null, undefined, 7], "llm")).toBe(0);
    expect(countType(null, "llm")).toBe(0);
  });
});

describe("accumulateProgressSlot", () => {
  it("initializes from a null existing slot", () => {
    const s = accumulateProgressSlot(null, {
      events: [{ type: "llm" }, { type: "cli" }],
      startedAtMs: 100, lastUpdatedMs: 200, modId: 3,
    });
    expect(s.llmCount).toBe(1);
    expect(s.cliCount).toBe(1);
    expect(s.events).toHaveLength(2);
    expect(s.startedAtMs).toBe(100);
    expect(s.lastUpdatedMs).toBe(200);
    expect(s.modId).toBe(3);
  });

  it("accumulates counts across batches (monotonic)", () => {
    let s = accumulateProgressSlot(null, { events: llm(2).concat(cli(1)), startedAtMs: 0, lastUpdatedMs: 1 });
    s = accumulateProgressSlot(s, { events: llm(3), lastUpdatedMs: 2 });
    s = accumulateProgressSlot(s, { events: cli(4), lastUpdatedMs: 3 });
    expect(s.llmCount).toBe(5);
    expect(s.cliCount).toBe(5);
    expect(s.startedAtMs).toBe(0);        // preserved from first batch
    expect(s.lastUpdatedMs).toBe(3);      // advances
  });

  it("counts correctly even after the event tail is capped (the >500 bug)", () => {
    // Emit far more than the cap. The retained events array is bounded, but the
    // counters must reflect EVERY emitted call.
    let s = null;
    const total = LIVE_EVENTS_CAP * 3;     // 1500 llm events in batches of 100
    for (let i = 0; i < total; i += 100) {
      s = accumulateProgressSlot(s, { events: llm(100), startedAtMs: 0, lastUpdatedMs: i });
    }
    expect(s.events.length).toBe(LIVE_EVENTS_CAP);   // tail bounded
    expect(s.llmCount).toBe(total);                  // count NOT bounded
  });

  it("does not mutate the existing slot or the incoming batch", () => {
    const existing = accumulateProgressSlot(null, { events: llm(1), startedAtMs: 0, lastUpdatedMs: 1 });
    const incoming = { events: llm(1), lastUpdatedMs: 2 };
    const out = accumulateProgressSlot(existing, incoming);
    expect(existing.llmCount).toBe(1);     // untouched
    expect(out.llmCount).toBe(2);
    expect(out).not.toBe(existing);
    expect(incoming.events).toHaveLength(1);
  });
});
