// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Fix-loop escalation (run 46). The RTL lint loop ran its iterations against
// the model that had written the broken RTL and ended on the same blocking
// count it started with — 6 errors in, 6 errors out. Iterating harder against
// the same model buys nothing; escalating the next attempt to a different one
// is what the mixed-tier work made possible.
//
// Escalation is opt-in: a run that sets no fixEscalation behaves exactly as
// before, which is why the stall test and the config lookup are separate.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { fixLoopStalled, fixEscalationConfig } from "../src/pipeline/fixLoopHelpers.js";

describe("fixLoopStalled", () => {
  it("is true when the count has not improved over the window", () => {
    // run 46's measured RTL lint loop
    expect(fixLoopStalled([{ iter: 1, errors: 6 }, { iter: 2, errors: 6 }, { iter: 3, errors: 6 }]))
      .toBe(true);
  });

  it("is false while the loop is still converging", () => {
    // run 46's measured TB lint loop: 9 → 1 is progress, do not escalate
    expect(fixLoopStalled([{ errors: 9 }, { errors: 4 }, { errors: 1 }])).toBe(false);
  });

  it("is false once the errors are gone", () => {
    expect(fixLoopStalled([{ errors: 3 }, { errors: 0 }, { errors: 0 }])).toBe(false);
  });

  it("needs a full window before it decides", () => {
    expect(fixLoopStalled([{ errors: 6 }])).toBe(false);
    expect(fixLoopStalled([{ errors: 6 }, { errors: 6 }])).toBe(false);
    expect(fixLoopStalled([{ errors: 6 }, { errors: 6 }, { errors: 6 }])).toBe(true);
  });

  it("honours a wider window", () => {
    const h = [{ errors: 5 }, { errors: 5 }, { errors: 5 }];
    expect(fixLoopStalled(h, { after: 2 })).toBe(true);
    expect(fixLoopStalled(h, { after: 3 })).toBe(false);   // needs 4 records
  });

  it("counts a regression as a stall too", () => {
    expect(fixLoopStalled([{ errors: 2 }, { errors: 5 }, { errors: 7 }])).toBe(true);
  });

  it("reads blockingAfter and errorCount as well as errors", () => {
    expect(fixLoopStalled([{ blockingAfter: 4 }, { blockingAfter: 4 }, { blockingAfter: 4 }])).toBe(true);
    expect(fixLoopStalled([{ errorCount: 4 }, { errorCount: 4 }, { errorCount: 4 }])).toBe(true);
  });

  it("ignores records carrying no count", () => {
    expect(fixLoopStalled([{}, {}, {}])).toBe(false);
    expect(fixLoopStalled(null)).toBe(false);
  });
});

describe("fixEscalationConfig", () => {
  const base = { provider: "ollama", model: "small", _maxTokens: 8000, temperature: 0.2 };

  it("returns null when the run configured no escalation", () => {
    expect(fixEscalationConfig({}, base)).toBeNull();
    expect(fixEscalationConfig({ fixEscalation: {} }, base)).toBeNull();
    expect(fixEscalationConfig({ fixEscalation: { after: 3 } }, base)).toBeNull();
  });

  it("overlays only the identity fields, keeping the stage's own settings", () => {
    const out = fixEscalationConfig({ fixEscalation: { model: "big" } }, base);
    expect(out.model).toBe("big");
    expect(out.provider).toBe("ollama");
    expect(out._maxTokens).toBe(8000);      // stage settings survive
    expect(out.temperature).toBe(0.2);
  });

  it("can switch provider, key and base URL together", () => {
    const out = fixEscalationConfig({
      fixEscalation: { provider: "anthropic", model: "big", apiKey: "k", baseUrl: "https://x" },
    }, base);
    expect(out).toMatchObject({ provider: "anthropic", model: "big", apiKey: "k", baseUrl: "https://x" });
  });

  it("does not mutate the stage config it was given", () => {
    const copy = { ...base };
    fixEscalationConfig({ fixEscalation: { model: "big" } }, base);
    expect(base).toEqual(copy);
  });
});
