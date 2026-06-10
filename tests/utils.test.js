// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { djb2, computeInterfaceSignature } from "../src/utils/hash.js";
import { levenshtein } from "../src/utils/levenshtein.js";
import { deriveConstraints, buildAutoAssumptionsSVA } from "../src/utils/constraints.js";
import { isInterfaceCompatible } from "../src/utils/library.js";

describe("djb2", () => {
  it("returns hex string", () => {
    expect(typeof djb2("hello")).toBe("string");
    expect(djb2("hello")).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(djb2("clk_input1bit")).toBe(djb2("clk_input1bit"));
  });

  it("differs for different inputs", () => {
    expect(djb2("foo")).not.toBe(djb2("bar"));
  });

  it("handles empty string", () => {
    expect(djb2("")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("computeInterfaceSignature", () => {
  it("returns matching hashes for identical interfaces in different orders", () => {
    const a = computeInterfaceSignature(
      [{ name: "data", dir: "input", width: "DATA_W" }, { name: "clk", dir: "input", width: "1" }],
      [{ name: "DATA_W", def: 8 }],
    );
    const b = computeInterfaceSignature(
      [{ name: "clk", dir: "input", width: "1" }, { name: "data", dir: "input", width: "DATA_W" }],
      [{ name: "DATA_W", def: 8 }],
    );
    expect(a.portHash).toBe(b.portHash);
    expect(a.paramHash).toBe(b.paramHash);
  });

  it("differs when port direction changes", () => {
    const a = computeInterfaceSignature([{ name: "data", dir: "input",  width: "8" }], []);
    const b = computeInterfaceSignature([{ name: "data", dir: "output", width: "8" }], []);
    expect(a.portHash).not.toBe(b.portHash);
  });

  it("handles empty arrays", () => {
    const sig = computeInterfaceSignature([], []);
    expect(sig.portHash).toBeDefined();
    expect(sig.paramHash).toBeDefined();
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("fifo", "fifo")).toBe(0);
  });

  it("returns length of other when one is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("counts single substitution", () => {
    expect(levenshtein("fifo", "fafo")).toBe(1);
  });

  it("counts single insertion", () => {
    expect(levenshtein("fifo", "fifos")).toBe(1);
  });

  it("counts single deletion", () => {
    expect(levenshtein("fifos", "fifo")).toBe(1);
  });

  it("matches classic example: kitten → sitting = 3", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("is symmetric", () => {
    expect(levenshtein("uart_tx", "uart_rx")).toBe(levenshtein("uart_rx", "uart_tx"));
  });

  it("works correctly when first arg is longer (forces internal swap)", () => {
    expect(levenshtein("longer_string", "short")).toBe(levenshtein("short", "longer_string"));
  });
});

describe("deriveConstraints", () => {
  it("returns empty array for null spec", () => {
    expect(deriveConstraints(null)).toEqual([]);
  });

  it("returns empty array for spec with no params", () => {
    expect(deriveConstraints({ params: [], iface: [] })).toEqual([]);
  });

  it("derives range constraint from parameter range", () => {
    const spec = {
      params: [{ name: "DEPTH", range: "[1:1024]" }],
      iface: [],
    };
    const c = deriveConstraints(spec);
    expect(c.length).toBe(1);
    expect(c[0].id).toBe("AUTO-ASSUME-001");
    expect(c[0].code).toContain("DEPTH >= 1");
    expect(c[0].code).toContain("DEPTH <= 1024");
    expect(c[0].source).toContain("DEPTH");
  });

  it("derives width-consistency constraint when port width references a parameter", () => {
    const spec = {
      params: [{ name: "DATA_W", range: "[1:64]" }],
      iface: [{ name: "data_i", dir: "input", width: "DATA_W" }],
    };
    const c = deriveConstraints(spec);
    // Should have 1 range + 1 width = 2 constraints
    expect(c.length).toBe(2);
    const widthConstraint = c.find((x) => x.code.includes("$bits"));
    expect(widthConstraint).toBeDefined();
    expect(widthConstraint.code).toContain("$bits(data_i) == DATA_W");
  });

  it("ignores ports with pure numeric widths", () => {
    const spec = {
      params: [],
      iface: [{ name: "clk", dir: "input", width: "1" }],
    };
    expect(deriveConstraints(spec)).toEqual([]);
  });

  it("ignores parameters without ranges", () => {
    const spec = {
      params: [{ name: "DATA_W", def: 8 }], // no range field
      iface: [],
    };
    expect(deriveConstraints(spec)).toEqual([]);
  });

  it("handles negative range values", () => {
    const spec = {
      params: [{ name: "OFFSET", range: "[-128:127]" }],
      iface: [],
    };
    const c = deriveConstraints(spec);
    expect(c.length).toBe(1);
    expect(c[0].code).toContain("OFFSET >= -128");
    expect(c[0].code).toContain("OFFSET <= 127");
  });
});

describe("buildAutoAssumptionsSVA", () => {
  it("returns empty string for empty input", () => {
    expect(buildAutoAssumptionsSVA([])).toBe("");
    expect(buildAutoAssumptionsSVA(null)).toBe("");
  });

  it("formats constraints with header and id comments", () => {
    const constraints = [
      { id: "AUTO-ASSUME-001", source: "Param FOO range [0:10]", code: "assume property (...);" },
    ];
    const sva = buildAutoAssumptionsSVA(constraints);
    expect(sva).toContain("AUTO-DERIVED CONSTRAINTS");
    expect(sva).toContain("AUTO-ASSUME-001");
    expect(sva).toContain("Param FOO range");
    expect(sva).toContain("assume property");
  });
});

describe("isInterfaceCompatible", () => {
  it("compatible when all required ports and params present", () => {
    const imported = {
      iface: [{ name: "clk", dir: "input", width: "1" }, { name: "data", dir: "input", width: "8" }],
      params: [{ name: "DATA_W" }],
    };
    const required = {
      iface: [{ name: "clk", dir: "input", width: "1" }, { name: "data", dir: "input", width: "8" }],
      params: [{ name: "DATA_W" }],
    };
    expect(isInterfaceCompatible(imported, required).compatible).toBe(true);
  });

  it("incompatible when port missing", () => {
    const imported = { iface: [{ name: "clk", dir: "input", width: "1" }], params: [] };
    const required = {
      iface: [{ name: "clk", dir: "input", width: "1" }, { name: "data", dir: "input", width: "8" }],
      params: [],
    };
    const r = isInterfaceCompatible(imported, required);
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain("Missing port: data");
  });

  it("incompatible when port direction differs", () => {
    const imported = { iface: [{ name: "data", dir: "input",  width: "8" }], params: [] };
    const required = { iface: [{ name: "data", dir: "output", width: "8" }], params: [] };
    const r = isInterfaceCompatible(imported, required);
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain("Dir mismatch");
  });

  it("incompatible when numeric widths differ", () => {
    const imported = { iface: [{ name: "data", dir: "input", width: "8"  }], params: [] };
    const required = { iface: [{ name: "data", dir: "input", width: "16" }], params: [] };
    const r = isInterfaceCompatible(imported, required);
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain("Width mismatch");
  });

  it("ignores width comparison when one side is parametric", () => {
    const imported = { iface: [{ name: "data", dir: "input", width: "DATA_W" }], params: [{ name: "DATA_W" }] };
    const required = { iface: [{ name: "data", dir: "input", width: "8"      }], params: [{ name: "DATA_W" }] };
    expect(isInterfaceCompatible(imported, required).compatible).toBe(true);
  });

  it("handles missing interface data gracefully", () => {
    expect(isInterfaceCompatible(null, {}).compatible).toBe(false);
    expect(isInterfaceCompatible({}, null).compatible).toBe(false);
  });
});
