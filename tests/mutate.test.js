// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Mutation testing — scoring a testbench by what it CATCHES.
//
// The eval gate scores verification by pass rate, and a vacuous suite
// maximises pass rate trivially. Measured on run 45's artifacts: the real
// testbench and one weakened by replacing every published-digest comparison
// with "digest is not zero" BOTH report 60/60 passing. Their mutation scores
// are 93% and 7%.
//
// The fast tests here cover enumeration and scoring. The end-to-end score
// needs Verilator and is gated on it.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  protectedMask, enumerateMutants, applyMutant, sampleMutants, mutationScore,
} from "../src/pipeline/mutate.js";

const MOD = `\`timescale 1ns/1ps
module m (input logic clk, input logic [31:0] a, output logic [31:0] y);
  // a comment with + and ^ and == that must never be mutated
  localparam logic [31:0] K = 32'hDEAD_BEEF;
  logic [31:0] t;
  always_comb begin
    t = (a + K) ^ (a & K);
    y = (t == 32'd0) ? a : t;
  end
  always_ff @(posedge clk) begin
    if (a == K) t <= a + 1;
  end
\`ifdef FORMAL
  always @(posedge clk) assert (y == t + 1);
\`endif
endmodule
`;

describe("protectedMask", () => {
  const mask = protectedMask(MOD);
  const offsetOf = (needle) => MOD.indexOf(needle);

  it("protects comments", () => {
    const i = offsetOf("a comment with +");
    expect(mask[i]).toBe(1);
    expect(mask[MOD.indexOf("+", i)]).toBe(1);
  });

  it("protects the timescale directive", () => {
    expect(mask[offsetOf("`timescale")]).toBe(1);
  });

  it("protects the FORMAL region — those assertions are not under test", () => {
    const i = MOD.indexOf("assert (y == t + 1)");
    expect(mask[i]).toBe(1);
    expect(mask[MOD.indexOf("+", i)]).toBe(1);
  });

  it("leaves ordinary logic mutable", () => {
    expect(mask[MOD.indexOf("t = (a + K)") + 7]).toBe(0);
  });
});

describe("enumerateMutants", () => {
  const muts = enumerateMutants(MOD);

  it("finds sites in the datapath", () => {
    expect(muts.length).toBeGreaterThan(3);
    expect(muts.map((m) => m.kind)).toContain("arithmetic");
    expect(muts.map((m) => m.kind)).toContain("bitwise");
    expect(muts.map((m) => m.kind)).toContain("equality");
  });

  it("never places a site inside a protected region", () => {
    const mask = protectedMask(MOD);
    for (const m of muts) expect(mask[m.offset]).toBe(0);
  });

  it("never mutates a non-blocking assignment as if it were a comparison", () => {
    // `t <= a + 1;` — the <= is an assignment; mutating it to `<` breaks the
    // design in a way that says nothing about the testbench.
    const asg = MOD.indexOf("t <= a + 1");
    expect(muts.some((m) => m.offset === MOD.indexOf("<=", asg))).toBe(false);
  });

  it("never mutates the interior of a sized literal", () => {
    const lit = MOD.indexOf("32'hDEAD_BEEF");
    expect(muts.some((m) => m.offset > lit && m.offset < lit + 13)).toBe(false);
  });

  it("is deterministic and ordered by position", () => {
    const again = enumerateMutants(MOD);
    expect(again.map((m) => m.offset)).toEqual(muts.map((m) => m.offset));
    const offs = muts.map((m) => m.offset);
    expect([...offs].sort((x, y) => x - y)).toEqual(offs);
  });

  it("can be filtered by kind", () => {
    const only = enumerateMutants(MOD, { kinds: ["arithmetic"] });
    expect(only.length).toBeGreaterThan(0);
    expect(new Set(only.map((m) => m.kind))).toEqual(new Set(["arithmetic"]));
  });
});

describe("applyMutant", () => {
  it("changes exactly one operator and nothing else", () => {
    for (const m of enumerateMutants(MOD)) {
      const out = applyMutant(MOD, m);
      expect(out).not.toBe(MOD);
      expect(out.length).toBeGreaterThan(MOD.length - 3);
      // everything before the site is untouched
      expect(out.slice(0, m.offset)).toBe(MOD.slice(0, m.offset));
    }
  });
});

describe("sampleMutants", () => {
  it("spreads the sample across the file rather than taking a prefix", () => {
    const all = Array.from({ length: 100 }, (_, i) => ({ offset: i }));
    const s = sampleMutants(all, 5);
    expect(s).toHaveLength(5);
    expect(s[0].offset).toBe(0);
    expect(s[4].offset).toBeGreaterThan(50);
  });

  it("returns everything when the limit is absent or larger than the set", () => {
    const all = [{ offset: 1 }, { offset: 2 }];
    expect(sampleMutants(all, 0)).toHaveLength(2);
    expect(sampleMutants(all, 9)).toHaveLength(2);
  });
});

describe("mutationScore", () => {
  it("scores killed over COMPILED, excluding mutants that never built", () => {
    const s = mutationScore([
      { compiled: true, killed: true }, { compiled: true, killed: true },
      { compiled: true, killed: false, line: 7, kind: "bitwise", from: "^", to: "&", context: "x" },
      { compiled: false, killed: false },
    ]);
    expect(s).toMatchObject({ total: 4, compiled: 3, uncompiled: 1, killed: 2, survived: 1, score: 67 });
    expect(s.survivors).toHaveLength(1);
    expect(s.survivors[0].line).toBe(7);
  });

  it("reports null rather than 0 when nothing compiled", () => {
    expect(mutationScore([{ compiled: false }]).score).toBeNull();
  });

  it("a suite that kills everything scores 100", () => {
    expect(mutationScore([{ compiled: true, killed: true }]).score).toBe(100);
  });
});
