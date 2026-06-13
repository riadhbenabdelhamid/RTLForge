// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// triageMemory — cross-run learning primitives + adapters.

import { describe, it, expect } from "vitest";
import {
  failureSignature, aggregateTriageStats, recommendFromStats, formatTriageEvidence,
  createInMemoryTriageMemory, createFileTriageMemory,
} from "../src/pipeline/triageMemory.js";

describe("failureSignature", () => {
  it("is the sorted failing-id set, score-independent", () => {
    expect(failureSignature({ failingIds: ["verify_pass_rate", "req_func_must"] }))
      .toBe("req_func_must|verify_pass_rate");
    // Order doesn't matter — same failure, same key, across runs.
    expect(failureSignature({ failingIds: ["req_func_must", "verify_pass_rate"] }))
      .toBe("req_func_must|verify_pass_rate");
  });
  it("is 'none' for a clean verdict", () => {
    expect(failureSignature({ failingIds: [] })).toBe("none");
    expect(failureSignature(null)).toBe("none");
  });
});

describe("aggregateTriageStats", () => {
  const recs = [
    { signature: "S", target: "test_generate", improved: true },
    { signature: "S", target: "test_generate", improved: true },
    { signature: "S", target: "test_generate", improved: false },
    { signature: "S", target: "rtl_generate", improved: false },
    { signature: "S", target: "rtl_generate", improved: false },
    { signature: "OTHER", target: "test_generate", improved: false }, // wrong sig
  ];
  it("groups by target, filters by signature, sorts best-first", () => {
    const stats = aggregateTriageStats(recs, "S");
    expect(stats[0]).toMatchObject({ target: "test_generate", attempts: 3, improvements: 2 });
    expect(stats[0].successRate).toBeCloseTo(2 / 3, 3);
    expect(stats[1]).toMatchObject({ target: "rtl_generate", attempts: 2, improvements: 0, successRate: 0 });
    // OTHER-signature record excluded
    expect(stats.reduce((a, s) => a + s.attempts, 0)).toBe(5);
  });
});

describe("recommendFromStats", () => {
  it("prefers the best positive target, avoids the repeated-failure ones", () => {
    const stats = aggregateTriageStats([
      { signature: "S", target: "test_generate", improved: true },
      { signature: "S", target: "rtl_generate", improved: false },
      { signature: "S", target: "rtl_generate", improved: false },
    ], "S");
    const s = recommendFromStats(stats);
    expect(s.prefer).toBe("test_generate");
    expect(s.avoid).toEqual(["rtl_generate"]);
  });
  it("prefers null when nothing has ever worked", () => {
    const stats = aggregateTriageStats([
      { signature: "S", target: "rtl_generate", improved: false },
    ], "S");
    expect(recommendFromStats(stats).prefer).toBeNull();
  });
});

describe("formatTriageEvidence", () => {
  it("renders one line per target, empty string when no stats", () => {
    expect(formatTriageEvidence([])).toBe("");
    const s = formatTriageEvidence([{ target: "test_generate", attempts: 4, improvements: 3, successRate: 0.75 }]);
    expect(s).toContain("test_generate: fixed 3/4");
    expect(s).toContain("75%");
  });
});

describe("createInMemoryTriageMemory", () => {
  it("records and looks up by signature; ignores incomplete records", () => {
    const mem = createInMemoryTriageMemory();
    mem.record({ signature: "S", target: "test_generate", improved: true });
    mem.record({ signature: "S", target: "rtl_generate", improved: false });
    mem.record({ signature: "T", target: "spec", improved: true });
    mem.record({ target: "no-signature" });        // dropped
    mem.record(null);                               // dropped
    expect(mem.lookup("S").length).toBe(2);
    expect(mem.lookup("T").length).toBe(1);
    expect(mem.all().length).toBe(3);
  });
  it("seeds from existing rows", () => {
    const mem = createInMemoryTriageMemory([{ signature: "S", target: "x", improved: true }]);
    expect(mem.lookup("S").length).toBe(1);
  });
});

describe("createFileTriageMemory", () => {
  // Mock fs — an in-memory file map, so no real disk I/O.
  function mockFs() {
    const files = {};
    return {
      files,
      existsSync: (p) => p in files,
      readFileSync: (p) => files[p],
      writeFileSync: (p, data) => { files[p] = data; },
    };
  }
  it("persists across re-opens of the same path", () => {
    const fs = mockFs();
    const a = createFileTriageMemory("/tmp/tm.json", { fs });
    a.record({ signature: "S", target: "test_generate", improved: true });
    // Re-open: a fresh adapter on the same file sees the prior record.
    const b = createFileTriageMemory("/tmp/tm.json", { fs });
    expect(b.lookup("S").length).toBe(1);
    expect(b.lookup("S")[0].target).toBe("test_generate");
  });
  it("caps to maxRows, keeping the most recent", () => {
    const fs = mockFs();
    const a = createFileTriageMemory("/tmp/cap.json", { fs, maxRows: 3 });
    for (let i = 0; i < 5; i++) a.record({ signature: "S", target: "t" + i, improved: false });
    expect(a.all().length).toBe(3);
    expect(a.all().map((r) => r.target)).toEqual(["t2", "t3", "t4"]);
  });
  it("starts fresh on a corrupt file, never throws", () => {
    const fs = mockFs();
    fs.files["/tmp/bad.json"] = "{not json";
    const a = createFileTriageMemory("/tmp/bad.json", { fs });
    expect(a.all()).toEqual([]);
    a.record({ signature: "S", target: "x", improved: true });
    expect(a.lookup("S").length).toBe(1);
  });
  it("requires an injected fs (browser-safety)", () => {
    expect(() => createFileTriageMemory("/tmp/x.json", {})).toThrow(/fs.*required/);
  });
});
