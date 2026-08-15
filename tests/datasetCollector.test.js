// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Every artifact a run produces, labelled — including the ones that failed.
//
// trainingExport reads a finished checkpoint and emits only what PASSED. That
// discards exactly what a repair-trained model needs: the code that did not
// lint, the fix that did not help, and the name of the model that wrote each.
// This collects at stage completion, before any of that is filtered or shed.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { artifactRecords, specId } from "../src/pipeline/datasetCollector.js";

const IDENT = {
  specId: "abc123", specName: "uart_rx", project: "p1",
  module: "uart_rx", model: "meta/muse-glimmer", provider: "lmstudio",
  ts: "2026-08-09T00:00:00.000Z",
};

const rec = (stageKey, result) => artifactRecords({ stageKey, result, ident: IDENT });

describe("specId", () => {
  it("is stable for the same text and different for different text", () => {
    expect(specId("a uart")).toBe(specId("a uart"));
    expect(specId("a uart")).not.toBe(specId("a fifo"));
    expect(specId("a uart")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("generated artifacts", () => {
  it("captures generated RTL with the producing model", () => {
    const r = rec("rtl_generate", { code: "module uart_rx; endmodule" });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      artifact: "rtl", role: "generate", model: "meta/muse-glimmer",
      provider: "lmstudio", stage: "rtl_generate", spec_id: "abc123",
    });
    expect(r[0].code).toContain("module uart_rx");
  });

  it("captures a generated testbench as a tb artifact", () => {
    const r = rec("test_generate", { code: "module uart_rx_tb; endmodule" });
    expect(r[0]).toMatchObject({ artifact: "tb", role: "generate" });
  });

  it("emits nothing when a stage produced no code", () => {
    expect(rec("rtl_generate", {})).toEqual([]);
  });
});

describe("measurements and repairs", () => {
  // Two lint iterations that did NOT improve — glimmer's actual shape: seven
  // warnings in, seven warnings out. The export would have dropped this
  // entirely; it is the most instructive record in the run.
  const LINT_NO_PROGRESS = {
    status: "FAIL",
    iterations: [
      { iter: 1, status: "FAIL", errors: 0, warnings: 7,
        warningList: [{ code: "WIDTHEXPAND", msg: "div_cnt" }],
        _structured: { beforeCode: "module a; endmodule", afterCode: "module b; endmodule" } },
      { iter: 2, status: "FAIL", errors: 0, warnings: 7, warningList: [] },
    ],
  };

  it("keeps a FAILING artifact with its measurement", () => {
    const r = rec("lint", LINT_NO_PROGRESS);
    const measures = r.filter((x) => x.role === "measure");
    expect(measures.length).toBeGreaterThan(0);
    expect(measures[0].outcome).toMatchObject({ status: "FAIL", errors: 0, warnings: 7 });
    expect(measures[0].findings).toContain("WIDTHEXPAND");
  });

  it("records a repair and marks it as not having improved", () => {
    const r = rec("lint", LINT_NO_PROGRESS);
    const repair = r.find((x) => x.role === "repair");
    expect(repair).toBeTruthy();
    expect(repair.before_code).toBe("module a; endmodule");
    expect(repair.code).toBe("module b; endmodule");
    expect(repair.outcome).toEqual({ errors_before: 0, errors_after: 0 });
    // measured from the NEXT iteration, never asserted by the model
    expect(repair.improved).toBe(false);
  });

  it("marks a repair that did improve", () => {
    const r = rec("lint", {
      iterations: [
        { iter: 1, errors: 4, errorList: [{ code: "SYNTAX", msg: "bad" }],
          _structured: { beforeCode: "before", afterCode: "after" } },
        { iter: 2, errors: 0 },
      ],
    });
    expect(r.find((x) => x.role === "repair").improved).toBe(true);
  });

  it("does not record a repair when the code did not change", () => {
    const r = rec("lint", {
      iterations: [
        { iter: 1, errors: 3, _structured: { beforeCode: "same", afterCode: "same" } },
        { iter: 2, errors: 3 },
      ],
    });
    expect(r.some((x) => x.role === "repair")).toBe(false);
  });

  it("labels testbench repairs as tb artifacts", () => {
    const r = rec("lint_test", {
      iterations: [
        { iter: 1, errors: 2, _structured: { beforeCode: "tb1", afterCode: "tb2" } },
        { iter: 2, errors: 1 },
      ],
    });
    expect(r.every((x) => x.artifact === "tb")).toBe(true);
  });
});

// Run 52. lint and lint_test publish `iterations`; rtl_review and test_review
// publish `_iterations`. Reading only the unprefixed name captured NOTHING from
// the review stages — which is where review-driven repair data lives, and the
// whole reason the review stages get switched on.
describe("review stages use the underscore-prefixed field", () => {
  it("captures each review iteration's verdict and score", () => {
    const r = rec("rtl_review", {
      verdict: "NEEDS_FIX", score: 53, issues: [1, 2, 3, 4, 5, 6],
      _reviewedCode: "module uart_rx; endmodule",
      _iterations: [
        { iter: 1, score: 53, verdict: "NEEDS_FIX" },
        { iter: 2, score: 53, verdict: "NEEDS_FIX" },
      ],
    });
    const perIter = r.filter((x) => x.iteration === 1 || x.iteration === 2);
    expect(perIter).toHaveLength(2);
    expect(perIter[0].outcome).toEqual({ verdict: "NEEDS_FIX", score: 53 });
    // counts belong to lint, not to a review — they must not appear as nulls
    expect(perIter[0].outcome).not.toHaveProperty("errors");
    expect(perIter[0].outcome).not.toHaveProperty("warnings");
  });

  it("still captures a review repair when the fix changed the code", () => {
    const r = rec("test_review", {
      verdict: "NEEDS_FIX", score: 60,
      _iterations: [
        { iter: 1, score: 60, verdict: "NEEDS_FIX",
          _structured: { beforeCode: "tb_before", afterCode: "tb_after" } },
        { iter: 2, score: 88, verdict: "PASS" },
      ],
    });
    const repair = r.find((x) => x.role === "repair");
    expect(repair).toMatchObject({ artifact: "tb", before_code: "tb_before", code: "tb_after" });
  });
});

describe("terminal verdicts", () => {
  it("records a simulation result", () => {
    const r = rec("verify", { pass: 14, total: 26, fail: 12, sim: "Verilator" });
    expect(r[0].outcome).toMatchObject({ pass: 14, total: 26, fail: 12 });
  });

  it("records a judge verdict", () => {
    const r = rec("judge", { overall: "FAIL", score: 40 });
    expect(r[0].outcome).toEqual({ verdict: "FAIL", score: 40 });
  });

  it("records a review verdict against the reviewed code", () => {
    const r = rec("rtl_review", { verdict: "NEEDS_FIX", score: 55, issues: [1, 2, 3],
                                  _reviewedCode: "module fixed; endmodule" });
    expect(r[0]).toMatchObject({ artifact: "rtl", role: "measure" });
    expect(r[0].outcome).toEqual({ verdict: "NEEDS_FIX", score: 55, issues: 3 });
    expect(r[0].code).toContain("module fixed");
  });
});

describe("model attribution", () => {
  it("stamps every record, so rows from two models never merge silently", () => {
    const a = artifactRecords({ stageKey: "rtl_generate", result: { code: "x" },
      ident: Object.assign({}, IDENT, { model: "meta/muse-glimmer" }) });
    const b = artifactRecords({ stageKey: "rtl_generate", result: { code: "x" },
      ident: Object.assign({}, IDENT, { model: "qwen/qwen3.8-27b" }) });
    expect(a[0].model).toBe("meta/muse-glimmer");
    expect(b[0].model).toBe("qwen/qwen3.8-27b");
    // identical code, different provenance — the whole point of the field
    expect(a[0].code).toBe(b[0].code);
  });
});
