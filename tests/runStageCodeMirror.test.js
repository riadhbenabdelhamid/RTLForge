// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Generalized code-slot mirror in runStage (found by stage-replay on run 23):
// the cross-stage side-effect block was a hand-enumerated stage list, and
// formal_verify was missing from it — so the node's BMC-proven RTL repair
// (out.rtl_generate, guarded on PASS) was returned and then silently dropped
// at the dispatch layer. The stage reported PASS + fixIterations:1 while the
// checkpoint kept the violated RTL. Now ANY non-owner stage that returns an
// rtl_generate / test_generate delta gets it merged into the code slot.

import { describe, it, expect } from "vitest";
import { runStage } from "../src/projectState/runStage.js";
import { blankModule } from "../src/projectState/moduleRegistry.js";
import { djb2 } from "../src/utils/hash.js";
import { formalPropsSourceOf, stampMeasurement } from "../src/utils/measurement.js";

function drive(opts) {
  const dispatched = [];
  const mod = blankModule();
  Object.assign(mod.stageData, opts.stageData || {});
  const args = {
    stageId: opts.stageId,
    stageKey: opts.stageKey,
    targetModId: "m1",
    reducerState: { modules: { m1: mod }, ledger: undefined },
    uiState: { config: {} },
    services: {
      allStages: opts.allStages || [],
      pipeline: {
        invokeNode: async function(_key, acc) {
          return Object.assign({}, acc, opts.delta);
        },
      },
    },
    dispatch: function(a) { dispatched.push(a); },
  };
  return runStage(args).then(function() { return dispatched; });
}

import { MODULE_STAGE_DATA_MERGE } from "../src/projectState/actions.js";

describe("runStage specification-review transitions", () => {
  it.each([[2, "spec"], [9, "judge"]])("persists invalidated verification from %s/%s over an old CLI result", async (stageId, stageKey) => {
    const review = { decision: "revise", reason: "Corrected extraction against the original description." };
    const dispatched = await drive({
      stageId, stageKey,
      stageData: { 8: { cli: true, total: 2, pass: 2, fail: 0,
        _specConflict: { reason: "Contradictory requirements" }, champion: { rtl: "old RTL" } } },
      delta: { [stageKey]: {}, verify: { cli: false, status: "UNVERIFIED", total: 0,
        pass: 0, fail: 0, _specConflict: null, _specConflictReview: review } },
    });
    const sets = dispatched.filter(a => a.type === "MODULE_STAGE_DATA_SET" && a.stageId === 8);
    expect(sets).toHaveLength(1);
    expect(sets[0].data._specConflict).toBeNull();
    expect(sets[0].data.champion).toBeUndefined();
    expect(sets[0].data.cli).toBe(false);
  });
});

describe("runStage generalized code-slot mirror", function() {
  // Checked while auditing run 54, where the RTL review
  // was believed not to promote its repaired code. It does: the mirror below
  // is stage-agnostic. Run 2's reviews simply never produced changed code
  // (every iteration recorded beforeCode === afterCode); the repair that DID
  // exist was thrown away later by the lint fix loop's churn guard, fixed
  // separately. This test pins the promotion so the claim stays falsifiable.
  it("an rtl_review fix reaches slot 4", async function() {
    const dispatched = await drive({
      stageId: 10, stageKey: "rtl_review",
      stageData: { 4: { code: "module m; logic FALLING; endmodule" } },
      delta: {
        rtl_review: { verdict: "PASS", score: 90 },
        rtl_generate: { code: "module m; endmodule", _fixSource: "fixed post RTL review" },
      },
    });
    const merges = dispatched.filter(function(a) {
      return a.type === MODULE_STAGE_DATA_MERGE && a.stageId === 4;
    });
    expect(merges).toHaveLength(1);
    expect(merges[0].data.code).toBe("module m; endmodule");
    expect(merges[0].data._fixSource).toBe("fixed post RTL review");
  });

  it("formal_verify's repaired rtl_generate delta reaches slot 4 (the dropped-fix bug)", async function() {
    const dispatched = await drive({
      stageId: 13, stageKey: "formal_verify",
      delta: {
        formal_verify: { status: "PASS", fixIterations: 1 },
        rtl_generate: { code: "module fixed; endmodule", _fixSource: "fixed post formal_verify" },
      },
    });
    const merges = dispatched.filter(function(a) {
      return a.type === MODULE_STAGE_DATA_MERGE && a.stageId === 4;
    });
    expect(merges).toHaveLength(1);
    expect(merges[0].data.code).toBe("module fixed; endmodule");
  });

  it("keeps a fresh verify formal remeasure ahead of fallback invalidation", async function() {
    const rtl = "module selected; endmodule";
    const formal_props = {
      properties: [{ id: "p_ready", type: "assert", code: "assert property (ready);" }],
      bind_module: "bind selected selected_props u_props (.*);",
    };
    const formal_verify = stampMeasurement("formal_verify", {
      status: "PASS", remeasure: true, repairIterationsDisabled: true,
      sourceHash: djb2(rtl),
    }, { rtl: rtl, formal_props: formalPropsSourceOf(formal_props) });
    const dispatched = await drive({
      stageId: 8, stageKey: "verify",
      delta: {
        verify: { cli: true, status: "UNVERIFIED", _standaloneComparison: { formalInvalidated: true } },
        rtl_generate: { code: rtl },
        formal_props,
        formal_verify,
      },
    });
    const formalSets = dispatched.filter(function(a) {
      return a.type === "MODULE_STAGE_DATA_SET" && a.stageId === 13;
    });
    expect(formalSets).toHaveLength(1);
    expect(formalSets[0].data.remeasure).toBe(true);
    expect(dispatched.some(function(a) {
      return a.type === "MODULE_STAGE_DATA_MERGE" && a.stageId === 13
        && a.data.status === "STALE";
    })).toBe(false);
  });

  it("rejects a formal remeasure when the property artifact changed", async function() {
    const rtl = "module selected; endmodule";
    const measuredProps = {
      properties: [{ id: "p_ready", type: "assert", code: "assert property (ready);" }],
      bind_module: "bind selected selected_props u_props (.*);",
    };
    const currentProps = Object.assign({}, measuredProps, {
      properties: [{ id: "p_ready", type: "assume", code: "assert property (ready);" }],
    });
    const formal_verify = stampMeasurement("formal_verify", {
      status: "PASS", proven: true, remeasure: true, sourceHash: djb2(rtl),
    }, { rtl: rtl, formal_props: formalPropsSourceOf(measuredProps) });
    const dispatched = await drive({
      stageId: 8, stageKey: "verify",
      stageData: { 13: { status: "PASS", proven: true } },
      delta: {
        verify: { cli: true, status: "UNVERIFIED", _standaloneComparison: { formalInvalidated: true } },
        rtl_generate: { code: rtl },
        formal_props: currentProps,
        formal_verify,
      },
    });
    expect(dispatched.filter(function(a) {
      return a.type === "MODULE_STAGE_DATA_SET" && a.stageId === 13;
    })).toHaveLength(0);
    expect(dispatched.some(function(a) {
      return a.type === "MODULE_STAGE_DATA_MERGE" && a.stageId === 13
        && a.data.status === "STALE";
    })).toBe(true);
  });

  it("any future non-owner stage mirroring test_generate reaches slot 7", async function() {
    const dispatched = await drive({
      stageId: 12, stageKey: "lint_test",
      delta: {
        lint_test: { status: "PASS" },
        test_generate: { code: "module tb_fixed; endmodule" },
      },
    });
    const merges = dispatched.filter(function(a) {
      return a.type === MODULE_STAGE_DATA_MERGE && a.stageId === 7;
    });
    expect(merges).toHaveLength(1);
    expect(merges[0].data.code).toBe("module tb_fixed; endmodule");
  });

  it("the OWNER stage does not double-write its own slot via the mirror", async function() {
    const dispatched = await drive({
      stageId: 4, stageKey: "rtl_generate",
      delta: { rtl_generate: { code: "module m; endmodule" } },
    });
    const merges = dispatched.filter(function(a) {
      return a.type === MODULE_STAGE_DATA_MERGE && a.stageId === 4;
    });
    expect(merges).toHaveLength(0);
  });

  it("a stage that returns no code delta dispatches no mirror", async function() {
    const dispatched = await drive({
      stageId: 5, stageKey: "formal_props",
      delta: { formal_props: { properties: [] } },
    });
    const merges = dispatched.filter(function(a) {
      return a.type === MODULE_STAGE_DATA_MERGE && (a.stageId === 4 || a.stageId === 7);
    });
    expect(merges).toHaveLength(0);
  });
});
