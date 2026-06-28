// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Regression for the verify-slot clobber found in the gpt-oss-120b e2e:
// when judge re-runs the sim during a fix iteration it used to REPLACE the
// verify slot with a bare re-sim result, destroying the verify stage's own
// verifyHistory + _llms (cost ledger) — blinding the bench and the Verify UI.
// mergeReverifyIntoVerify overlays the fresh numbers while preserving provenance.

import { describe, it, expect } from "vitest";
import { mergeReverifyIntoVerify } from "../src/pipeline/nodes/judge.js";

describe("mergeReverifyIntoVerify", () => {
  const priorVerify = {
    pass: 0, total: 1, fail: 1, cli: true,
    verifyHistory: [{ iter: 1, status: "FAIL" }, { iter: 2, status: "FAIL" }],
    _llms: [{ stage: "verify-triage-1", tokensIn: 500, tokensOut: 80 }],
    _ledger: { greenMust: 0, totalMust: 3 },
    _fixes: [{ text: "tightened reset", iter: 1 }],
  };
  const vd2 = { pass: 1, total: 1, fail: 0, cli: true, tests: [{ name: "t_basic", status: "PASS" }] };

  it("keeps the fresh re-sim numbers (vd2 wins on shared keys)", () => {
    const m = mergeReverifyIntoVerify(priorVerify, vd2);
    expect(m.pass).toBe(1);
    expect(m.fail).toBe(0);
    expect(m.tests).toEqual([{ name: "t_basic", status: "PASS" }]);
  });

  it("preserves the verify stage's provenance that the bare re-sim lacks", () => {
    const m = mergeReverifyIntoVerify(priorVerify, vd2);
    expect(m.verifyHistory).toHaveLength(2);            // was nulled by the clobber
    expect(m._llms).toEqual(priorVerify._llms);          // cost ledger survives
    expect(m._ledger).toEqual({ greenMust: 0, totalMust: 3 });
    expect(m._fixes).toHaveLength(1);
  });

  it("does not mutate the inputs", () => {
    const m = mergeReverifyIntoVerify(priorVerify, vd2);
    expect(m).not.toBe(priorVerify);
    expect(priorVerify.pass).toBe(0);                    // untouched
  });

  it("tolerates a null prior verify (first re-verify with nothing to preserve)", () => {
    expect(mergeReverifyIntoVerify(null, vd2)).toEqual(vd2);
    expect(mergeReverifyIntoVerify(undefined, vd2).pass).toBe(1);
  });
});
