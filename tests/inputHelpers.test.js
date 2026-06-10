// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { clampIntInput } from "../src/utils/inputHelpers.js";

describe("clampIntInput — Audit #2 fix", function() {
  it("returns the parsed integer when in range", function() {
    const c = clampIntInput({ min: 1, max: 20, fallback: 3 });
    expect(c("5")).toBe(5);
    expect(c("20")).toBe(20);
    expect(c("1")).toBe(1);
  });

  it("clamps to min when value below min", function() {
    const c = clampIntInput({ min: 1, max: 20, fallback: 3 });
    expect(c("0")).toBe(1);
    expect(c("-5")).toBe(1);
  });

  it("clamps to max when value above max", function() {
    const c = clampIntInput({ min: 1, max: 20, fallback: 3 });
    expect(c("100")).toBe(20);
    expect(c("21")).toBe(20);
  });

  it("returns min on empty string (Audit #2 anti-snap-to-default)", function() {
    const c = clampIntInput({ min: 1, max: 20, fallback: 3 });
    expect(c("")).toBe(1);
    // Crucially, NOT 3 — this is the bug the helper fixes.
  });

  it("falls back to prev value on NaN if prev provided", function() {
    const c = clampIntInput({ min: 1, max: 20, fallback: 3 });
    expect(c("abc", 7)).toBe(7);
    expect(c("not-a-number", 12)).toBe(12);
  });

  it("falls back to fallback on NaN with no prev", function() {
    const c = clampIntInput({ min: 1, max: 20, fallback: 3 });
    expect(c("abc")).toBe(3);
  });

  it("handles 0 case correctly when min is 0", function() {
    const c = clampIntInput({ min: 0, max: 5, fallback: 1 });
    expect(c("0")).toBe(0);    // 0 is a valid value
    expect(c("")).toBe(0);     // empty clamps to min, which is 0
  });

  it("handles cliRetryCount-style options (min=0, fallback=1)", function() {
    const c = clampIntInput({ min: 0, max: 5, fallback: 1 });
    expect(c("0")).toBe(0);
    expect(c("3")).toBe(3);
    expect(c("10")).toBe(5);
    expect(c("")).toBe(0);
  });
});
