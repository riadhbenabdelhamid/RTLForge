// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// The code-churn tracker seeds its history with the baseline (iter 0). A
// candidate within the near-repeat threshold of the BASELINE is the normal
// shape of a small, correct fix — not churn. Run 55: a one-line fix
// to a 117-line module was flagged "98.1% similar to iteration 0", skipped
// unvalidated twice, and the lint stage stagnated on the original error.
import { describe, it, expect } from "vitest";
import { createCodeChurnTracker } from "../src/pipeline/fixLoopHelpers.js";

describe("code churn tracker: the baseline is not a repeat", function() {
  it("a one-line fix to the original is 'new', an exact repeat of the original is still 'repeat'", function() {
    const lines = [];
    for (let i = 0; i < 116; i++) lines.push("  assign w" + i + " = in" + i + " & en;");
    const original = "module m;\n" + lines.join("\n") + "\n  logic FALLING;\nendmodule";
    const fixed = "module m;\n" + lines.join("\n") + "\nendmodule";    // ~98% similar
    const churn = createCodeChurnTracker();
    churn.record(original, 0);
    expect(churn.assess(fixed).verdict).toBe("new");
    expect(churn.assess(original).verdict).toBe("repeat");
    churn.record(fixed, 1);
    const nearFixed = fixed.replace("in1 &", "in1x &");   // one token off a TRIED candidate
    expect(churn.assess(nearFixed).verdict).toBe("near-repeat");   // repeats of a tried candidate still count
  });
});
