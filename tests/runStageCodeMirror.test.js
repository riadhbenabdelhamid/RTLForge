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

describe("runStage generalized code-slot mirror", function() {
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
