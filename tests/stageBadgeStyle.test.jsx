// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// stageBadgeStyle — V22 Items 2 + 3
//
// Pins:
//   Item 2 — awaiting-reflow members render as a triangle (clip-path);
//            the executing reflow member stays a circle.
//   Item 3 — completed stages in the reflow set show ↻ instead of ✓.
//
// We test stageBadgeStyle in isolation rather than rendering RTLForge.
// The helper returns plain objects we can introspect.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { stageBadgeStyle } from "../src/react/components/stageBadgeStyle.js";

function flags(overrides) {
  return Object.assign({
    stageId: 6,
    done: false,
    isCur: false,
    isStale: false,
    hasErr: false,
    hasFuncFail: false,
    inReflowSet: false,
    legacyLoopback: false,
    processing: false,
  }, overrides);
}

describe("stageBadgeStyle — Item 2 (triangle for awaiting reflow)", function() {
  it("circle for an idle, never-run stage", function() {
    const r = stageBadgeStyle(flags());
    expect(r.badgeStyle.borderRadius).toBe("50%");
    expect(r.badgeStyle.clipPath).toBeUndefined();
    expect(r.isAwaitingReflow).toBe(false);
  });

  it("circle for a currently-executing stage (not yet in reflow)", function() {
    const r = stageBadgeStyle(flags({ isCur: true, processing: true }));
    expect(r.badgeStyle.borderRadius).toBe("50%");
    expect(r.badgeStyle.clipPath).toBeUndefined();
    expect(r.isAwaitingReflow).toBe(false);
  });

  it("circle for a completed stage (not in reflow)", function() {
    const r = stageBadgeStyle(flags({ done: true }));
    expect(r.badgeStyle.borderRadius).toBe("50%");
    expect(r.badgeStyle.clipPath).toBeUndefined();
  });

  it("TRIANGLE when stage is in reflow set AND not currently executing (awaiting)", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      inReflowSet: true,
      isCur: false,
      processing: true,
    }));
    expect(r.badgeStyle.clipPath).toBe("polygon(50% 0%, 100% 100%, 0% 100%)");
    expect(r.badgeStyle.borderRadius).toBeUndefined();
    expect(r.isAwaitingReflow).toBe(true);
    expect(r.isExecutingInReflow).toBe(false);
  });

  it("circle when stage is in reflow set AND currently executing", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      inReflowSet: true,
      isCur: true,
      processing: true,
    }));
    expect(r.badgeStyle.clipPath).toBeUndefined();
    expect(r.badgeStyle.borderRadius).toBe("50%");
    expect(r.isAwaitingReflow).toBe(false);
    expect(r.isExecutingInReflow).toBe(true);
  });

  it("legacy single-target loopback (no reflow set) stays a CIRCLE", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      legacyLoopback: true,
      isCur: false,
      processing: true,
    }));
    expect(r.badgeStyle.clipPath).toBeUndefined();
    expect(r.badgeStyle.borderRadius).toBe("50%");
    expect(r.isLoopback).toBe(true);
  });
});

describe("stageBadgeStyle — Item 3 (replay arrow ↻ replaces ✓)", function() {
  it("completed stage NOT in reflow → ✓", function() {
    const r = stageBadgeStyle(flags({ done: true }));
    expect(r.badgeText).toBe("✓");
  });

  it("completed stage IN reflow → ↻", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      inReflowSet: true,
      processing: true,
    }));
    expect(r.badgeText).toBe("↻");
  });

  it("uncompleted stage IN reflow → ↻ (still shows replay, since it's queued for a re-run)", function() {
    const r = stageBadgeStyle(flags({
      done: false,
      inReflowSet: true,
      processing: true,
    }));
    expect(r.badgeText).toBe("↻");
  });

  it("executing stage IN reflow → ↻ (the running step is itself a re-run)", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      inReflowSet: true,
      isCur: true,
      processing: true,
    }));
    expect(r.badgeText).toBe("↻");
  });

  it("hard error still shows '!' even if in reflow", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      inReflowSet: true,
      hasErr: true,
      processing: true,
    }));
    expect(r.badgeText).toBe("!");
  });

  it("stale stage shows its stage ID, not ↻", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      isStale: true,
      stageId: 7,
    }));
    expect(r.badgeText).toBe("7");
  });

  it("after reflow finishes (set clears): completed stage reverts to ✓", function() {
    const r = stageBadgeStyle(flags({ done: true, inReflowSet: false }));
    expect(r.badgeText).toBe("✓");
  });
});

describe("stageBadgeStyle — animation behavior", function() {
  it("idle stage → no animation", function() {
    const r = stageBadgeStyle(flags());
    expect(r.badgeStyle.animation).toBe("none");
  });

  it("currently executing → slow pulse (1.2s)", function() {
    const r = stageBadgeStyle(flags({ isCur: true, processing: true }));
    expect(r.badgeStyle.animation).toBe("pulse 1.2s infinite");
  });

  it("awaiting in reflow set → fast pulse (0.6s)", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      inReflowSet: true,
      processing: true,
    }));
    expect(r.badgeStyle.animation).toBe("pulseFast 0.6s infinite");
  });

  it("legacy single-target loopback → fast pulse (0.6s)", function() {
    const r = stageBadgeStyle(flags({
      done: true,
      legacyLoopback: true,
      processing: true,
    }));
    expect(r.badgeStyle.animation).toBe("pulseFast 0.6s infinite");
  });

  it("processing OFF → no fast pulse even if flags set (defensive)", function() {
    const r = stageBadgeStyle(flags({
      inReflowSet: true,
      processing: false,
    }));
    expect(r.badgeStyle.animation).toBe("none");
  });
});

describe("stageBadgeStyle — combined behavior (real reflow scenario)", function() {
  // Scenario: a 3-stage reflow chain (rtl_generate → rtl_review → lint)
  // is in flight. rtl_review is currently executing; rtl_generate and
  // lint are both in the reflow set but waiting.
  // We assert that each gets the right shape, text, animation.
  it("3-stage reflow snapshot — rtl_review running, rtl_generate + lint awaiting", function() {
    // rtl_generate: completed earlier, now in reflow set, awaiting
    const rtlGen = stageBadgeStyle(flags({
      stageId: 4, done: true,
      inReflowSet: true, isCur: false, processing: true,
    }));
    expect(rtlGen.badgeStyle.clipPath).toBe("polygon(50% 0%, 100% 100%, 0% 100%)");
    expect(rtlGen.badgeText).toBe("↻");
    expect(rtlGen.badgeStyle.animation).toBe("pulseFast 0.6s infinite");

    // rtl_review: currently executing, in reflow set
    const rtlRev = stageBadgeStyle(flags({
      stageId: 10, done: true,
      inReflowSet: true, isCur: true, processing: true,
    }));
    expect(rtlRev.badgeStyle.borderRadius).toBe("50%");
    expect(rtlRev.badgeText).toBe("↻");
    expect(rtlRev.badgeStyle.animation).toBe("pulse 1.2s infinite");

    // lint: in reflow set, awaiting (will execute last)
    const lint = stageBadgeStyle(flags({
      stageId: 6, done: true,
      inReflowSet: true, isCur: false, processing: true,
    }));
    expect(lint.badgeStyle.clipPath).toBe("polygon(50% 0%, 100% 100%, 0% 100%)");
    expect(lint.badgeText).toBe("↻");
    expect(lint.badgeStyle.animation).toBe("pulseFast 0.6s infinite");
  });
});
