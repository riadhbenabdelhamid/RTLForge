// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Working-set curation for the verify fix loop (run 18 follow-up).
//
// Three properties pinned here:
//   1. LAYOUT — static instruction blocks (rules/checklist) precede the
//      volatile per-iteration material (code, failures, logs), so local
//      servers reuse prefix KV state across fix iterations and the rules sit
//      at an attention edge. The compile-error section stays FIRST (bug 3,
//      measured — position pinned by verifyFixPromptCompileFirst.test.js).
//   2. CAPS — failing tests enter as {name, req, evidence} capped at 15 with
//      an explicit omission note (run 18 sent 21 full objects per iteration);
//      previousFixes keeps the most recent 8.
//   3. LEDGER — completed attempts render as one measured-outcome line each
//      (attemptRowsFromHistory pairs iteration i's triage decision with
//      iteration i+1's measurement).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { attemptLedgerSection, cappedJson } from "../src/prompts/base.js";
import { promptRTLFromVerifyFail, promptTBFromVerifyFail } from "../src/prompts/verify.js";
import { promptRTLReviewFix } from "../src/prompts/rtlReview.js";
import { promptTestReviewFix } from "../src/prompts/testReview.js";
import { attemptRowsFromHistory } from "../src/pipeline/fixLoopHelpers.js";

const spec = {
  requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "stores words" }],
  iface: [{ name: "clk", dir: "input", width: "1" }],
  params: [],
};
const el = { modName: "sync_fifo" };

function verifyResultWith(nFails) {
  const tests = [];
  for (let i = 0; i < nFails; i++) {
    tests.push({ name: "REQ-FUNC-003." + i, st: "FAIL", cyc: 63 + 2 * i, ms: 1,
      req: "REQ-FUNC-003", evidence: "dout mismatch at cycle " + (63 + 2 * i) });
  }
  return { tests: tests, pass: 33, fail: nFails, total: 33 + nFails, log: "[FAIL] x\n" };
}

// ─── attemptRowsFromHistory ───────────────────────────────────────────────
describe("attemptRowsFromHistory", function() {
  it("pairs iteration i's decision with iteration i+1's measurement (run-18 shape)", function() {
    const rows = attemptRowsFromHistory([
      { iter: 1, pass: 33, total: 54, triageTarget: "test_generate" },
      { iter: 2, pass: 33, total: 54, triageTarget: "test_generate",
        classification: { patchDecision: "REJECT_NO_IMPROVEMENT" } },
      { iter: 3, pass: 33, total: 54 },
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ iter: 1, target: "test_generate", pass: 33, total: 54,
      decision: "REJECT_NO_IMPROVEMENT", flipped: false });
    expect(rows[1].pass).toBe(33);
  });

  it("skips entries without a triage decision and carries the flip flag", function() {
    const rows = attemptRowsFromHistory([
      { iter: 1, pass: 10, total: 20 },                                      // no target — skipped
      { iter: 2, pass: 10, total: 20, triageTarget: "rtl_generate", triageFlipped: true },
      { iter: 3, pass: 15, total: 20 },
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].flipped).toBe(true);
    expect(rows[0].pass).toBe(15);
  });

  it("returns [] for empty or single-entry history", function() {
    expect(attemptRowsFromHistory([])).toEqual([]);
    expect(attemptRowsFromHistory([{ iter: 1, pass: 1, triageTarget: "x" }])).toEqual([]);
    expect(attemptRowsFromHistory(null)).toEqual([]);
  });
});

// ─── attemptLedgerSection ─────────────────────────────────────────────────
describe("attemptLedgerSection", function() {
  it("renders one measured-outcome line per attempt with deltas", function() {
    const s = attemptLedgerSection([
      { iter: 1, target: "test_generate", pass: 33, total: 54, decision: "REJECT_NO_IMPROVEMENT" },
      { iter: 2, target: "test_generate", pass: 33, total: 54 },
      { iter: 3, target: "rtl_generate", pass: 40, total: 54, flipped: true },
    ]);
    expect(s).toContain("PREVIOUS FIX ATTEMPTS");
    expect(s).toContain("iter 1: test_generate regenerated → 33/54");
    expect(s).toContain("REJECT_NO_IMPROVEMENT");
    expect(s).toContain("iter 2: test_generate regenerated → 33/54 (no change)");
    expect(s).toContain("iter 3: rtl_generate regenerated → 40/54 (+7)");
    expect(s).toContain("[target forced by no-improvement flip]");
  });

  it("is empty with no completed attempts", function() {
    expect(attemptLedgerSection([])).toBe("");
    expect(attemptLedgerSection(null)).toBe("");
    expect(attemptLedgerSection([{ iter: 1, pass: 3 }])).toBe("");  // no target
  });
});

// ─── cappedJson ───────────────────────────────────────────────────────────
describe("cappedJson", function() {
  it("renders plainly under the cap, notes omissions over it", function() {
    expect(cappedJson([1, 2], 3, "things")).not.toContain("omitted");
    const s = cappedJson([1, 2, 3, 4, 5], 3, "things");
    expect(s).toContain("…and 2 more things omitted");
  });
});

// ─── prompt layout + caps ─────────────────────────────────────────────────
describe("verify fix prompts — working-set layout", function() {
  it("RTL fix: static rules and requirements precede the volatile artifacts", function() {
    const p = promptRTLFromVerifyFail("module m; endmodule", verifyResultWith(2), spec, el);
    const u = p.userMessage;
    expect(u.indexOf("FIX RULES")).toBeGreaterThan(-1);
    expect(u.indexOf("FIX RULES")).toBeLessThan(u.indexOf("CURRENT RTL"));
    expect(u.indexOf("REQUIREMENTS")).toBeLessThan(u.indexOf("CURRENT RTL"));
    expect(u.indexOf("CURRENT RTL")).toBeLessThan(u.indexOf("FAILING TESTS"));
  });

  it("TB fix: rules and spec precede the volatile artifacts; DUT interface stays header-only", function() {
    const p = promptTBFromVerifyFail("module tb; endmodule", "module m; endmodule",
      verifyResultWith(2), spec, el);
    const u = p.userMessage;
    expect(u.indexOf("FIX RULES")).toBeLessThan(u.indexOf("CURRENT TESTBENCH"));
    expect(u.indexOf("SPEC REQUIREMENTS")).toBeLessThan(u.indexOf("CURRENT TESTBENCH"));
    expect(u).toContain("implementation withheld");
  });

  it("caps the failing-test list at 15 with an explicit omission note (run 18: 21 fails)", function() {
    const p = promptRTLFromVerifyFail("module m; endmodule", verifyResultWith(21), spec, el);
    expect(p.userMessage).toContain("FAILING TESTS (21)");
    expect(p.userMessage).toContain("…and 6 more failing tests omitted");
    // Curated shape: cyc/ms noise stripped, evidence kept.
    expect(p.userMessage).not.toContain('"cyc"');
    expect(p.userMessage).toContain("dout mismatch at cycle 63");
  });

  it("keeps the MOST RECENT 8 previous fixes with an omission note", function() {
    const fixes = [];
    for (let i = 1; i <= 12; i++) fixes.push({ test: "t" + i, desc: "fix " + i });
    const p = promptRTLFromVerifyFail("module m; endmodule", verifyResultWith(1), spec, el, fixes);
    expect(p.userMessage).toContain("4 earlier fixes omitted");
    expect(p.userMessage).toContain("fix 12");       // newest kept
    expect(p.userMessage).not.toContain('"fix 1"');  // oldest dropped
  });

  it("review fix prompts: static rules precede the volatile code/issues too", function() {
    const review = { issues: [{ id: "RR-001", severity: "critical", description: "x" }] };
    const r = promptRTLReviewFix("module m; endmodule", review, spec, el);
    expect(r.userMessage.indexOf("FIX RULES")).toBeLessThan(r.userMessage.indexOf("CURRENT RTL"));
    expect(r.userMessage.indexOf("CURRENT RTL")).toBeLessThan(r.userMessage.indexOf("ISSUES TO FIX"));
    const t = promptTestReviewFix("module tb; endmodule", "module m; endmodule",
      { issues: [{ id: "TR-001", severity: "major", description: "y" }] }, spec, el);
    expect(t.userMessage.indexOf("FIX RULES")).toBeLessThan(t.userMessage.indexOf("CURRENT TESTBENCH"));
    expect(t.userMessage.indexOf("CURRENT TESTBENCH")).toBeLessThan(t.userMessage.indexOf("ISSUES TO FIX"));
    expect(t.userMessage).toContain("implementation withheld");
  });

  it("includes the attempt ledger when history is supplied, omits it when absent", function() {
    const rows = [{ iter: 1, target: "test_generate", pass: 33, total: 54 }];
    const withLedger = promptTBFromVerifyFail("module tb; endmodule", "module m; endmodule",
      verifyResultWith(1), spec, el, [], null, rows);
    expect(withLedger.userMessage).toContain("PREVIOUS FIX ATTEMPTS");
    const without = promptTBFromVerifyFail("module tb; endmodule", "module m; endmodule",
      verifyResultWith(1), spec, el, [], null, null);
    expect(without.userMessage).not.toContain("PREVIOUS FIX ATTEMPTS");
  });
});
