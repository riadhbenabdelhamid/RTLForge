// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// pastVersionsReflow — V22 Item 6
//
// Pins:
//   • collectRTLSnapshots / collectTBSnapshots accept an optional stageRuns
//     argument WITHOUT breaking the old single-arg call signature
//   • Each completed reflow run (context.depth >= 1) with a .result.code
//     produces a snapshot with reflow=true and a provenance label
//   • Top-level runs (depth=0) are NOT duplicated as reflow snapshots
//   • Error / aborted runs and runs without code are skipped
//   • The label includes parent stage, parent iter, and depth
//   • The raw provenance metadata is preserved on the snapshot
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  collectRTLSnapshots,
  collectTBSnapshots,
} from "../src/utils/pastVersions.js";

// Minimal stageData with NO iterations[] — guarantees the only snapshot
// sources are the original code + the reflow stageRuns. Lets us isolate
// the provenance-from-reflow behavior cleanly.
function bareStageData() {
  return {
    4: { code: "module rtl_v1; endmodule" },
    7: { code: "module tb_v1; endmodule" },
  };
}

describe("collectRTLSnapshots — V22 Item 6 reflow provenance", function() {

  it("works without stageRuns (back-compat with old single-arg signature)", function() {
    const snaps = collectRTLSnapshots(bareStageData());
    // Just the original
    expect(snaps.length).toBe(1);
    expect(snaps[0].label).toBe("RTL Gen — original");
  });

  it("works with stageRuns=undefined (defensive)", function() {
    const snaps = collectRTLSnapshots(bareStageData(), undefined);
    expect(snaps.length).toBe(1);
  });

  it("emits a reflow snapshot for a chain re-run with code in result", function() {
    const stageRuns = {
      4: [
        // Top-level original run — should NOT appear as a reflow snapshot
        {
          runId: 1,
          trigger: "user",
          ts: 1000,
          finishedAt: 2000,
          status: "complete",
          result: { code: "module rtl_v1; endmodule" },
          context: null,
        },
        // Chain re-run — SHOULD appear
        {
          runId: 2,
          trigger: "reflow:judge",
          ts: 3000,
          finishedAt: 4000,
          status: "complete",
          result: { code: "module rtl_v2_regen; endmodule" },
          context: {
            depth: 1,
            parentStageKey: "judge",
            parentIter: 1,
            reason: "triage",
          },
        },
      ],
    };
    const snaps = collectRTLSnapshots(bareStageData(), stageRuns);
    // Find the reflow-marked snapshot
    const reflowSnap = snaps.find(function(s) { return s.reflow; });
    expect(reflowSnap).toBeTruthy();
    expect(reflowSnap.code).toBe("module rtl_v2_regen; endmodule");
    expect(reflowSnap.label).toContain("RTL Gen");
    expect(reflowSnap.label).toContain("reflow inside judge iter 1");
    expect(reflowSnap.label).toContain("depth 1");
    expect(reflowSnap.lineCount).toBe(1);
  });

  it("preserves raw provenance fields on the snapshot for downstream consumers", function() {
    const stageRuns = {
      4: [
        {
          runId: 5,
          trigger: "reflow:verify",
          ts: 1000, finishedAt: 1500,
          status: "complete",
          result: { code: "module x; endmodule" },
          context: {
            depth: 2,
            parentStageKey: "verify",
            parentIter: 3,
            reason: "triage",
          },
        },
      ],
    };
    const snaps = collectRTLSnapshots(bareStageData(), stageRuns);
    const r = snaps.find(function(s) { return s.reflow; });
    expect(r.provenance).toBeTruthy();
    expect(r.provenance.depth).toBe(2);
    expect(r.provenance.parentStageKey).toBe("verify");
    expect(r.provenance.parentIter).toBe(3);
    expect(r.provenance.reason).toBe("triage");
    expect(r.provenance.runId).toBe(5);
    expect(r.provenance.ts).toBe(1500);
  });

  it("does NOT emit a reflow snapshot for a top-level run (depth=0 or null)", function() {
    const stageRuns = {
      4: [
        {
          runId: 1, trigger: "user", ts: 1, finishedAt: 2, status: "complete",
          result: { code: "module top; endmodule" },
          context: null,
        },
        {
          runId: 2, trigger: "user", ts: 3, finishedAt: 4, status: "complete",
          result: { code: "module top2; endmodule" },
          context: { depth: 0, parentStageKey: null, parentIter: null },
        },
      ],
    };
    const snaps = collectRTLSnapshots(bareStageData(), stageRuns);
    expect(snaps.filter(function(s) { return s.reflow; })).toEqual([]);
  });

  it("skips runs with status='error' or 'aborted'", function() {
    const stageRuns = {
      4: [
        {
          runId: 2, trigger: "reflow:judge", ts: 1, finishedAt: 2,
          status: "error",
          result: null,
          context: { depth: 1, parentStageKey: "judge", parentIter: 1, reason: "triage" },
        },
        {
          runId: 3, trigger: "reflow:judge", ts: 3, finishedAt: 4,
          status: "aborted",
          result: { code: "module half; endmodule" },
          context: { depth: 1, parentStageKey: "judge", parentIter: 2, reason: "triage" },
        },
      ],
    };
    const snaps = collectRTLSnapshots(bareStageData(), stageRuns);
    expect(snaps.filter(function(s) { return s.reflow; })).toEqual([]);
  });

  it("skips runs whose result has no .code field (lint/review-style runs)", function() {
    const stageRuns = {
      6: [
        {
          runId: 1, trigger: "reflow:judge", ts: 1, finishedAt: 2,
          status: "complete",
          // lint result doesn't carry .code — it carries .status, .errors, etc.
          result: { status: "PASS", errors: [], warnings: [] },
          context: { depth: 1, parentStageKey: "judge", parentIter: 1, reason: "always" },
        },
      ],
    };
    const snaps = collectRTLSnapshots(bareStageData(), stageRuns);
    expect(snaps.filter(function(s) { return s.reflow; })).toEqual([]);
  });

  it("emits ONE snapshot per matching chain re-run, ordered by stageId", function() {
    const stageRuns = {
      4: [
        // rtl_generate chain re-run
        {
          runId: 2, trigger: "reflow:judge", ts: 100, finishedAt: 200,
          status: "complete",
          result: { code: "module a; endmodule" },
          context: { depth: 1, parentStageKey: "judge", parentIter: 1, reason: "triage" },
        },
        // Another rtl_generate chain re-run — separate iter
        {
          runId: 3, trigger: "reflow:lint", ts: 300, finishedAt: 400,
          status: "complete",
          result: { code: "module b; endmodule" },
          context: { depth: 1, parentStageKey: "lint", parentIter: 2, reason: "triage" },
        },
      ],
    };
    const snaps = collectRTLSnapshots(bareStageData(), stageRuns);
    const reflows = snaps.filter(function(s) { return s.reflow; });
    expect(reflows.length).toBe(2);
    // Provenance labels distinguish the two
    expect(reflows[0].label).toContain("judge iter 1");
    expect(reflows[1].label).toContain("lint iter 2");
  });

  it("nested depth 3 produces a label with depth annotation", function() {
    const stageRuns = {
      4: [
        {
          runId: 4, trigger: "reflow:lint", ts: 1, finishedAt: 2,
          status: "complete",
          result: { code: "module deep; endmodule" },
          context: { depth: 3, parentStageKey: "lint", parentIter: 1, reason: "triage" },
        },
      ],
    };
    const snaps = collectRTLSnapshots(bareStageData(), stageRuns);
    const r = snaps.find(function(s) { return s.reflow; });
    expect(r.label).toContain("depth 3");
  });
});

describe("collectTBSnapshots — V22 Item 6 (mirror for TB code)", function() {

  it("emits reflow snapshot for test_generate chain re-run", function() {
    const stageRuns = {
      7: [
        {
          runId: 2, trigger: "reflow:verify", ts: 1, finishedAt: 2,
          status: "complete",
          result: { code: "module tb_regen; endmodule" },
          context: { depth: 1, parentStageKey: "verify", parentIter: 1, reason: "triage" },
        },
      ],
    };
    const snaps = collectTBSnapshots(bareStageData(), stageRuns);
    const r = snaps.find(function(s) { return s.reflow; });
    expect(r).toBeTruthy();
    expect(r.code).toBe("module tb_regen; endmodule");
    expect(r.kind).toBe("tb");
    expect(r.label).toContain("verify iter 1");
  });

  it("does NOT emit TB snapshots for RTL-only stages", function() {
    // rtl_generate (stage 4) is RTL-only — feeding a stage-4 run with code
    // into the TB collector should NOT produce a TB snapshot.
    const stageRuns = {
      4: [
        {
          runId: 2, trigger: "reflow:judge", ts: 1, finishedAt: 2,
          status: "complete",
          result: { code: "module rtl_only; endmodule" },
          context: { depth: 1, parentStageKey: "judge", parentIter: 1, reason: "triage" },
        },
      ],
    };
    const snaps = collectTBSnapshots(bareStageData(), stageRuns);
    expect(snaps.filter(function(s) { return s.reflow; })).toEqual([]);
  });
});
