// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Fine-tuning data export (docs/improvement-roadmap.md #11).

import { describe, it, expect } from "vitest";
import { sftPairs, repairPairs } from "../src/pipeline/trainingExport.js";

const PASSED = {
  2: { modName: "m", requirements: [{ id: "R1" }], _llms: [{ model: "big" }] },
  3: { plan: "two-stage datapath", _llms: [{ model: "big" }] },
  4: { code: "module m; endmodule", _llms: [{ model: "big" }] },
  7: { code: "module m_tb; endmodule", _llms: [{ model: "big" }] },
  9: { overall: "PASS" },
};

describe("sftPairs", () => {
  it("emits RTL + TB pairs from a judge-PASSED module, meta-stamped", () => {
    const rows = sftPairs(PASSED, { project: "p1", module: "m" });
    expect(rows).toHaveLength(2);
    const rtl = rows.find((r) => r.meta.kind === "sft-rtl");
    expect(rtl.prompt).toMatch(/SPECIFICATION:/);
    expect(rtl.prompt).toMatch(/ARCHITECTURE:/);
    expect(rtl.prompt).not.toMatch(/_llms/);                 // meta stripped from embeds
    expect(rtl.completion).toBe("module m; endmodule");
    expect(rtl.meta).toMatchObject({ model: "big", project: "p1", verdict: "PASS" });
    expect(rows.find((r) => r.meta.kind === "sft-tb").prompt).toMatch(/RTL:/);
  });
  it("emits NOTHING from unverified code (judge FAIL or absent)", () => {
    expect(sftPairs(Object.assign({}, PASSED, { 9: { overall: "FAIL" } }))).toEqual([]);
    expect(sftPairs(Object.assign({}, PASSED, { 9: undefined }))).toEqual([]);
  });
});

describe("repairPairs", () => {
  const lintWithFix = (errsBefore, errsAfter, before, after) => ({
    6: { iterations: [
      { iter: 1, errors: errsBefore, errorList: [{ code: "SYNTAX", msg: "unexpected token" }],
        _structured: { beforeCode: before, afterCode: after } },
      { iter: 2, errors: errsAfter, errorList: [] },
    ], _llms: [{ model: "big" }] },
  });

  it("keeps only iterations that measurably improved", () => {
    const rows = repairPairs(lintWithFix(5, 1, "bad code", "better code"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chosen: "better code", rejected: "bad code" });
    expect(rows[0].prompt).toMatch(/\[SYNTAX\] unexpected token/);
    expect(rows[0].meta).toMatchObject({ kind: "repair-rtl", errorsBefore: 5, errorsAfter: 1, model: "big" });
  });
  it("drops non-improving, identical, or structureless iterations", () => {
    expect(repairPairs(lintWithFix(5, 5, "a", "b"))).toEqual([]);       // no improvement
    expect(repairPairs(lintWithFix(5, 1, "same", "same"))).toEqual([]); // identical code
    expect(repairPairs({ 6: { iterations: [{ iter: 1, errors: 5 }, { iter: 2, errors: 0 }] } })).toEqual([]);
  });
  it("covers lint_test as repair-tb", () => {
    const sd = { 12: { iterations: [
      { iter: 1, errors: 3, errorList: [], _structured: { beforeCode: "tb0", afterCode: "tb1" } },
      { iter: 2, errors: 0 },
    ] } };
    expect(repairPairs(sd)[0].meta.kind).toBe("repair-tb");
  });
});
