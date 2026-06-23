// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Regression: the verify loop tracks best-known by score = pass - 2*fail, but
// the restore used to gate on `best.pass > final.pass` (pass-count only). When
// the final iteration tied on pass but regressed on FAIL, the strictly-better
// best-known state was NOT restored — verify reported avoidable failures and
// the judge re-triaged them (extra iterations). shouldRestoreBest aligns the
// restore with the tracking metric.

import { describe, it, expect } from "vitest";
import { shouldRestoreBest } from "../src/pipeline/nodes/verify.js";

describe("shouldRestoreBest", () => {
  it("RESTORES when final ties on pass but has MORE failures (the bug)", () => {
    // 5/0 best vs 5/3 final: old `pass > pass` was false → not restored.
    expect(shouldRestoreBest({ pass: 5, fail: 0 }, { pass: 5, fail: 3 })).toBe(true);
    expect(shouldRestoreBest({ pass: 5, fail: 1 }, { pass: 5, fail: 3 })).toBe(true);
  });

  it("does NOT restore when scores tie (no-op) or final is strictly better", () => {
    expect(shouldRestoreBest({ pass: 5, fail: 0 }, { pass: 5, fail: 0 })).toBe(false);
    expect(shouldRestoreBest({ pass: 3, fail: 0 }, { pass: 5, fail: 0 })).toBe(false); // final more pass
    expect(shouldRestoreBest({ pass: 4, fail: 1 }, { pass: 5, fail: 1 })).toBe(false); // final higher score
  });

  it("restores when best has more passing tests at equal failures", () => {
    expect(shouldRestoreBest({ pass: 6, fail: 1 }, { pass: 4, fail: 1 })).toBe(true);
  });

  it("returns false when there is no best-known", () => {
    expect(shouldRestoreBest(null, { pass: 1, fail: 0 })).toBe(false);
  });
});
