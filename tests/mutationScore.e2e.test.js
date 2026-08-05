// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// The claim mutation testing exists to support, measured end to end.
//
// Two testbenches for run 45's proven SHA-256 core. One compares the digest
// against five published FIPS vectors. The other is that same testbench with
// every digest comparison replaced by "digest is not zero" — the exact
// vacuity a local model shipped in run 46.
//
// Both report 60/60 passing. The eval gate cannot separate them. Mutation
// testing separates them by an order of magnitude, which is the whole point:
// a pass rate measures how much a suite AGREES with the design, and a
// mutation score measures how much it CONSTRAINS it.
//
// Measured on run 45 (2026-08-05), 14 mutants sampled across 41 sites:
//
//                        pass rate      mutation score
//   real testbench        60/60             93%
//   weakened testbench    60/60              7%
//
// The real suite's single survivor is `|`→`^` inside rotr, where the two
// shifted halves are disjoint and the operators are therefore identical — an
// EQUIVALENT mutant, so its effective score is 13/13.
//
// Gated on Verilator AND on RTLFORGE_MUTATION_E2E; each mutant is a real
// build-and-run, and the full sweep lives in tools/mutationTest.mjs.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { haveVerilator, runPair, scoreTestbench } from "../tools/mutationTest.mjs";

const ANSWERS = path.join(process.cwd(), "tests", "fixtures", "runs", "run45", "answers");

function loadPair() {
  if (!fs.existsSync(ANSWERS)) return null;
  let rtl = null, tb = null;
  for (const f of fs.readdirSync(ANSWERS)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ANSWERS, f), "utf8"));
      if (!j.code) continue;
      if (/module sha256_core\b/.test(j.code) && !/_tb\b/.test(j.code)) rtl = j.code;
      if (/REQ-TIME-003\.4/.test(j.code)) tb = j.code;
    } catch (e) { /* not a JSON answer */ }
  }
  return rtl && tb ? { rtl, tb } : null;
}

const pair = loadPair();
// Every mutant is a real Verilator build-and-run, so a meaningful sweep costs
// minutes — measured at 7m24s for the twelve builds below. That is too slow
// for a gate that runs on every commit, so the end-to-end scoring is opt-in:
//
//   RTLFORGE_MUTATION_E2E=1 npx vitest run tests/mutationScore.e2e.test.js
//
// It has been run and passes; the numbers it produced are recorded in the
// header above, and tools/mutationTest.mjs is the way to sweep a full file.
const canRun = haveVerilator() && !!pair && !!process.env.RTLFORGE_MUTATION_E2E;

// The weakening is mechanical and mirrors the measured failure: keep every
// check, keep the count, remove only the comparison against a published value.
const weaken = (tb) => tb.replace(/check\(digest === (DIG_\w+|VERSION_VALUE)/g, "check(digest !== 256'h0");

describe.skipIf(!canRun)("mutation score separates a real suite from a vacuous one", () => {
  it("both testbenches pass the unmutated design identically", () => {
    const good = runPair(pair.rtl, pair.tb, "sha256_core_tb");
    const weak = runPair(pair.rtl, weaken(pair.tb), "sha256_core_tb");
    expect(good.compiled && weak.compiled).toBe(true);
    expect(good.passed).toBe(true);
    expect(weak.passed).toBe(true);      // ← the eval gate sees no difference
    expect(weak.fails).toBe(good.fails);
  }, 300000);

  it("the real suite kills the datapath mutants the weakened one lets through", () => {
    const opts = { limit: 5, kinds: ["arithmetic"] };
    const good = scoreTestbench(pair.rtl, pair.tb, "sha256_core_tb", opts);
    const weak = scoreTestbench(pair.rtl, weaken(pair.tb), "sha256_core_tb", opts);

    expect(good.compiled).toBeGreaterThan(0);
    expect(weak.compiled).toBe(good.compiled);
    // An arithmetic edit in a hash datapath changes the digest, so a suite
    // that checks published digests must catch every one of them.
    expect(good.score).toBe(100);
    // …and one that only asks "not zero" catches essentially none.
    expect(weak.score).toBeLessThan(30);
    expect(good.score - weak.score).toBeGreaterThan(60);
  }, 900000);
});

describe("mutation scoring refuses to score what it cannot trust", () => {
  it("declines when the baseline testbench does not pass the real design", () => {
    // Scoring kills against a baseline that already fails would attribute the
    // testbench's own defects to the mutation.
    const rtl = "module m(input logic clk, output logic y); assign y = 1'b1; endmodule\n";
    const tb = "module m_tb; logic clk = 0, y; m u(.clk(clk), .y(y));\n"
      + "  initial begin $display(\"[FAIL] always\"); $finish(1); end\nendmodule\n";
    if (!haveVerilator()) return;
    const res = scoreTestbench(rtl, tb, "m_tb", { limit: 1 });
    expect(res.score).toBeNull();
    expect(res.note).toMatch(/baseline/i);
  }, 300000);
});
