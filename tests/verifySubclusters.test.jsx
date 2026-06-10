// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VerifyStage } from "../src/react/components/stages.jsx";

describe("VerifyStage REQ ID sub-clustering (V22-bug-pass-6 #2)", function() {
  const baseFixture = function(overrides) {
    return Object.assign({
      pass: 0, fail: 0, total: 0,
      cov: {}, cli: true, tests: [],
      log: "",
      verifyHistory: [],
    }, overrides);
  };

  function expandCategory(container, catName) {
    // Find the category header (the clickable div with cursor:pointer
    // that contains the category name + chevron ▸).
    const headers = Array.from(container.querySelectorAll("div"));
    const target = headers.find(function(d) {
      return d.style && d.style.cursor === "pointer" &&
        d.textContent && d.textContent.includes(catName) &&
        d.textContent.includes("▸");
    });
    if (target) fireEvent.click(target);
  }

  it("expanded category sub-groups tests by their REQ ID", function() {
    const data = baseFixture({
      tests: [
        { name: "test_a", st: "PASS", cyc: 100, ms: 10, req: "REQ-FUNC-001" },
        { name: "test_b", st: "PASS", cyc: 200, ms: 15, req: "REQ-FUNC-002" },
        { name: "test_c", st: "PASS", cyc: 50,  ms: 5,  req: "REQ-FUNC-001" },
      ],
    });
    const { container } = render(<VerifyStage data={data} />);
    expandCategory(container, "Functionality");
    const txt = container.textContent;
    // Both REQ IDs appear as sub-cluster headers
    expect(txt).toMatch(/REQ-FUNC-001/);
    expect(txt).toMatch(/REQ-FUNC-002/);
    // All individual test names visible
    expect(txt).toMatch(/test_a/);
    expect(txt).toMatch(/test_b/);
    expect(txt).toMatch(/test_c/);
  });

  it("multi-target test attributes to first REQ ID (Q1 answer)", function() {
    const data = baseFixture({
      tests: [
        { name: "test_overflow_underflow", st: "PASS", cyc: 100, ms: 10,
          req: "REQ-FUNC-004, REQ-FUNC-005" },
        { name: "test_simple", st: "PASS", cyc: 50, ms: 5, req: "REQ-FUNC-004" },
      ],
    });
    const { container } = render(<VerifyStage data={data} />);
    expandCategory(container, "Functionality");
    const txt = container.textContent;
    // Only REQ-FUNC-004 appears (test_overflow_underflow attributed to its FIRST target)
    expect(txt).toMatch(/REQ-FUNC-004/);
    // REQ-FUNC-005 must NOT appear as a sub-cluster header since no test
    // is attributed to it primarily
    const headers = Array.from(container.querySelectorAll("span"));
    const has005AsHeader = headers.some(function(s) {
      return s.style && s.style.fontWeight === "700" && /REQ-FUNC-005/.test(s.textContent || "");
    });
    expect(has005AsHeader).toBe(false);
  });

  it("sub-cluster shows PASS/FAIL state and test count per REQ", function() {
    const data = baseFixture({
      tests: [
        { name: "test_a", st: "PASS", cyc: 10, ms: 1, req: "REQ-FUNC-001" },
        { name: "test_b", st: "FAIL", cyc: 20, ms: 2, req: "REQ-FUNC-001" },
        { name: "test_c", st: "PASS", cyc: 30, ms: 3, req: "REQ-FUNC-002" },
      ],
    });
    const { container } = render(<VerifyStage data={data} />);
    expandCategory(container, "Functionality");
    const txt = container.textContent;
    // REQ-FUNC-001 sub-cluster has 1/2 passing → FAIL 1/2
    expect(txt).toMatch(/FAIL 1\/2/);
    // REQ-FUNC-002 has 1/1 passing; sub-cluster shows "1 test" (singular)
    // and REQ-FUNC-001 has 2 tests (plural). Use lookahead/lookbehind-style
    // checks that don't require word boundaries on the trailing side
    // (textContent concatenates "1 test" + "Test" → "1 testTest").
    expect(/1 test[^s]/.test(txt)).toBe(true);   // "1 test" but NOT "1 tests"
    expect(/2 tests/.test(txt)).toBe(true);
  });

  it("tests without REQ attribution land in '(No REQ attribution)' sub-bucket", function() {
    const data = baseFixture({
      tests: [
        { name: "test_a", st: "PASS", cyc: 10, ms: 1, req: "REQ-FUNC-001" },
        { name: "test_b", st: "PASS", cyc: 20, ms: 2 },  // no req
      ],
    });
    const { container } = render(<VerifyStage data={data} />);
    // REQ-FUNC tests bucket under Functionality; unattributed under Uncategorized
    expandCategory(container, "Functionality");
    expect(container.textContent).toMatch(/REQ-FUNC-001/);
    // The no-req test is in Uncategorized, not Functionality
    expandCategory(container, "Uncategorized");
    expect(container.textContent).toMatch(/No REQ attribution/);
  });

  it("REQ IDs render in deterministic order (numeric-aware sort)", function() {
    const data = baseFixture({
      tests: [
        { name: "t10", st: "PASS", cyc: 1, ms: 1, req: "REQ-FUNC-010" },
        { name: "t2",  st: "PASS", cyc: 1, ms: 1, req: "REQ-FUNC-002" },
        { name: "t1",  st: "PASS", cyc: 1, ms: 1, req: "REQ-FUNC-001" },
      ],
    });
    const { container } = render(<VerifyStage data={data} />);
    expandCategory(container, "Functionality");
    // REQ-FUNC-001 must appear before REQ-FUNC-002 must appear before REQ-FUNC-010
    const txt = container.textContent;
    const i1  = txt.indexOf("REQ-FUNC-001");
    const i2  = txt.indexOf("REQ-FUNC-002");
    const i10 = txt.indexOf("REQ-FUNC-010");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i10).toBeGreaterThan(i2);
  });
});
