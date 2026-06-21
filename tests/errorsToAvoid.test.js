// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Tasks #26–28: cross-run error memory. Pure core + adapters (mock fs).

import { describe, it, expect } from "vitest";
import {
  normalizeMessage, errorSignature, aggregateErrors, formatErrorsToAvoid,
  mergeErrorCatalogs, createInMemoryErrorMemory, createFileErrorMemory,
} from "../src/pipeline/errorsToAvoid.js";
import { promptRTL } from "../src/prompts/rtl.js";
import { promptTB } from "../src/prompts/testGen.js";

describe("normalizeMessage / errorSignature", () => {
  it("collapses identifiers, numbers and paths so variants share a template", () => {
    // Placeholders (X/N/FILE) stay upper-case — they're applied after lowercasing.
    expect(normalizeMessage("Operand 'a' width 8 != 4")).toBe("operand X width N != N");
    expect(normalizeMessage("Operand 'bus' width 16 != 32")).toBe("operand X width N != N");
    expect(normalizeMessage("Signal not driven: top.sv:42")).toBe("signal not driven: FILE:N");
  });

  it("two errors of the same code+template share a signature; different codes don't", () => {
    const a = errorSignature({ code: "WIDTH", msg: "Operand 'a' width 8 != 4" });
    const b = errorSignature({ code: "WIDTH", msg: "Operand 'q' width 1 != 9" });
    const c = errorSignature({ code: "LATCH", msg: "Operand 'a' width 8 != 4" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(errorSignature({ msg: "x" })).toMatch(/^GENERIC\|/);
  });
});

describe("aggregateErrors", () => {
  it("dedups by signature+domain, sums counts, sorts most-recurring first", () => {
    const recs = [
      { signature: "WIDTH|w", domain: "rtl", count: 2, lastTs: 1, sample: "old" },
      { signature: "WIDTH|w", domain: "rtl", count: 3, lastTs: 5, sample: "new" },
      { signature: "LATCH|l", domain: "rtl", count: 1, lastTs: 2 },
      { signature: "WIDTH|w", domain: "tb", count: 1, lastTs: 1 },   // distinct domain
    ];
    const agg = aggregateErrors(recs);
    expect(agg[0]).toMatchObject({ signature: "WIDTH|w", domain: "rtl", count: 5, sample: "new" });
    expect(agg.find((r) => r.domain === "tb").count).toBe(1);
    expect(agg.map((r) => r.count)).toEqual([5, 1, 1]);   // sorted desc
  });
});

describe("formatErrorsToAvoid", () => {
  const recs = [
    { signature: "WIDTH|w", code: "WIDTH", domain: "rtl", count: 6, sample: "operand width mismatch" },
    { signature: "LATCH|l", code: "LATCH", domain: "rtl", count: 2, sample: "inferred latch" },
    { signature: "TBX|x", code: "TBX", domain: "tb", count: 3, sample: "tb thing" },
  ];
  it("renders a section filtered by domain, capped by topN", () => {
    const md = formatErrorsToAvoid(recs, { domain: "rtl", topN: 1 });
    expect(md).toMatch(/COMMON MISTAKES TO AVOID/);
    expect(md).toMatch(/\[WIDTH\] operand width mismatch  \(seen 6×\)/);
    expect(md).not.toMatch(/LATCH/);   // capped to 1
    expect(md).not.toMatch(/tb thing/); // domain-filtered
  });
  it("returns empty string when there is nothing to inject", () => {
    expect(formatErrorsToAvoid([], {})).toBe("");
    expect(formatErrorsToAvoid(recs, { domain: "nope" })).toBe("");
  });
});

describe("mergeErrorCatalogs (federation)", () => {
  it("adds new lessons and sums counts on overlap; idempotent re-merge", () => {
    const dest = [{ signature: "A|a", domain: "rtl", count: 2 }];
    const src = [{ signature: "A|a", domain: "rtl", count: 3 }, { signature: "B|b", domain: "tb", count: 1 }];
    const r1 = mergeErrorCatalogs(dest, src);
    expect(r1.added).toBe(1);
    expect(r1.summed).toBe(1);
    expect(r1.merged.find((x) => x.signature === "A|a").count).toBe(5);
    // re-merging the SAME source again only sums (no new rows)
    const r2 = mergeErrorCatalogs(r1.merged, src);
    expect(r2.added).toBe(0);
    expect(r2.merged.find((x) => x.signature === "A|a").count).toBe(8);
  });
});

describe("createInMemoryErrorMemory", () => {
  it("records merge by signature+domain and increment count", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({ code: "WIDTH", msg: "Operand 'a' width 8 != 4", domain: "rtl" });
    mem.record({ code: "WIDTH", msg: "Operand 'q' width 1 != 9", domain: "rtl" }); // same template
    mem.record({ code: "WIDTH", msg: "Operand 'a' width 8 != 4", domain: "tb" });  // diff domain
    const all = mem.all();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.domain === "rtl").count).toBe(2);
    expect(all.find((r) => r.domain === "tb").count).toBe(1);
  });
  it("ignores records with neither signature nor code/msg", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({});
    mem.record(null);
    expect(mem.all()).toEqual([]);
  });
});

describe("createFileErrorMemory (mock fs)", () => {
  function mockFs(initial) {
    const store = { "/cat.json": initial };
    return {
      _store: store,
      existsSync: (p) => p in store,
      readFileSync: (p) => store[p],
      writeFileSync: (p, v) => { store[p] = v; },
    };
  }

  it("persists records and merges across re-open", () => {
    const fs = mockFs(undefined);
    const m1 = createFileErrorMemory("/cat.json", { fs });
    m1.record({ code: "WIDTH", msg: "Operand 'a' width 8", domain: "rtl" });
    m1.record({ code: "WIDTH", msg: "Operand 'b' width 4", domain: "rtl" });
    // Re-open from the same backing store → state survived.
    const m2 = createFileErrorMemory("/cat.json", { fs });
    expect(m2.all()).toHaveLength(1);
    expect(m2.all()[0].count).toBe(2);
  });

  it("importCatalog merges an external catalog and persists", () => {
    const fs = mockFs(JSON.stringify([{ signature: "A|a", domain: "rtl", count: 1 }]));
    const m = createFileErrorMemory("/cat.json", { fs });
    const res = m.importCatalog([{ signature: "A|a", domain: "rtl", count: 4 }, { signature: "B|b", domain: "tb", count: 1 }]);
    expect(res).toMatchObject({ added: 1, summed: 1, total: 2 });
    expect(m.all().find((r) => r.signature === "A|a").count).toBe(5);
  });

  it("requires an injected fs", () => {
    expect(() => createFileErrorMemory("/x.json", {})).toThrow(/opts\.fs/);
  });
});

describe("prompt injection (no-regression lock)", () => {
  const spec = { iface: { ports: [] }, params: {}, requirements: [{ id: "REQ-A-1", pri: "Must", desc: "do x" }] };
  const arch = { plan: "x" };
  const el = { moduleName: "m" };

  it("promptRTL is byte-identical when errorsToAvoid is absent/empty", () => {
    const a = promptRTL(arch, spec, el, [], null).userMessage;
    const b = promptRTL(arch, spec, el, [], null, "").userMessage;
    expect(b).toBe(a);
  });
  it("promptRTL adds the AVOID section when supplied", () => {
    const avoid = formatErrorsToAvoid(
      [{ signature: "WIDTH|w", code: "WIDTH", domain: "rtl", count: 4, sample: "operand width mismatch" }],
      { domain: "rtl" });
    const um = promptRTL(arch, spec, el, [], null, avoid).userMessage;
    expect(um).toMatch(/COMMON MISTAKES TO AVOID/);
    expect(um).toMatch(/operand width mismatch/);
  });
  it("promptTB is byte-identical when errorsToAvoid is absent/empty", () => {
    const a = promptTB("module m; endmodule", spec, el, []).userMessage;
    const b = promptTB("module m; endmodule", spec, el, [], "").userMessage;
    expect(b).toBe(a);
  });
  it("promptTB adds the AVOID section when supplied", () => {
    const um = promptTB("module m; endmodule", spec, el, [], "COMMON MISTAKES TO AVOID\n  • [X] y").userMessage;
    expect(um).toMatch(/COMMON MISTAKES TO AVOID/);
  });
});
