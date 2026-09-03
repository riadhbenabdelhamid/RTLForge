// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// Measurement provenance (run 55): a lint / lint_test / verify result
// is only a statement about the artifact it measured. Results now carry
// `_forHash`; producers stamp at measurement time, and runStage mirrors a
// non-owner stage's fresh measurements into their slots — but only when they
// match the code being shipped.
import { describe, it, expect } from "vitest";
import {
  artifactHash, stampMeasurement, measurementFreshness, isFreshFor,
  carriedMeasurements, MEASURED_STAGES,
} from "../src/utils/measurement.js";
import { runStage } from "../src/projectState/runStage.js";
import { blankModule } from "../src/projectState/moduleRegistry.js";
import { MODULE_STAGE_DATA_SET } from "../src/projectState/actions.js";
import { runReflowChain } from "../src/pipeline/reflowRunner.js";

const RTL_A = "module m; logic a; endmodule";
const RTL_B = "module m; logic b; endmodule";
const TB_A  = "module tb; endmodule";

describe("measurement helpers", function() {
  it("hashes empty/non-string sources to '' and distinct sources differently", function() {
    expect(artifactHash("")).toBe("");
    expect(artifactHash(null)).toBe("");
    expect(artifactHash(RTL_A)).not.toBe(artifactHash(RTL_B));
    expect(artifactHash(RTL_A)).toBe(artifactHash(RTL_A));
  });

  it("stamps only the artifacts a stage depends on and reports freshness per stage", function() {
    const lint = stampMeasurement("lint", { status: "PASS" }, { rtl: RTL_A, tb: TB_A });
    expect(Object.keys(lint._forHash)).toEqual(["rtl"]);
    expect(measurementFreshness("lint", lint, { rtl: RTL_A, tb: "anything" })).toBe("fresh");
    expect(measurementFreshness("lint", lint, { rtl: RTL_B })).toBe("stale");
    const verify = stampMeasurement("verify", { pass: 1, total: 1 }, { rtl: RTL_A, tb: TB_A });
    expect(Object.keys(verify._forHash).sort()).toEqual(["rtl", "tb"]);
    expect(isFreshFor("verify", verify, { rtl: RTL_A, tb: TB_A })).toBe(true);
    expect(isFreshFor("verify", verify, { rtl: RTL_A, tb: "changed" })).toBe(false);
    expect(measurementFreshness("lint", { status: "PASS" }, { rtl: RTL_A })).toBe("unstamped");
    expect(stampMeasurement("rtl_generate", { code: "x" }, {})).toEqual({ code: "x" });
    expect(MEASURED_STAGES).toEqual(["lint", "lint_test", "verify"]);
  });

  it("carriedMeasurements keeps only changed, fresh entries", function() {
    const base = { lint: { status: "FAIL" } };
    const chain = {
      lint: stampMeasurement("lint", { status: "PASS" }, { rtl: RTL_A }),
      lint_test: stampMeasurement("lint_test", { status: "PASS" }, { rtl: RTL_A, tb: TB_A }),
    };
    const out = carriedMeasurements(chain, base, { rtl: RTL_A, tb: "rewritten tb" });
    expect(Object.keys(out)).toEqual(["lint"]);           // lint_test is stale for the shipped TB
    expect(carriedMeasurements(chain, { lint: chain.lint }, { rtl: RTL_A, tb: TB_A }).lint).toBeUndefined(); // unchanged
    expect(carriedMeasurements(null, base, {})).toEqual({});
  });
});

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

describe("runStage measurement provenance", function() {
  it("stamps the owner's own measurement with the hashes of the code it ships", async function() {
    const dispatched = await drive({
      stageId: 6, stageKey: "lint",
      stageData: { 4: { code: RTL_A } },
      delta: { lint: { status: "PASS", errors: [], warnings: [] }, rtl_generate: { code: RTL_B, _fixSource: "fixed post lint" } },
    });
    const sets = dispatched.filter(function(a) { return a.type === MODULE_STAGE_DATA_SET && a.stageId === 6; });
    expect(sets).toHaveLength(1);
    expect(sets[0].data._forHash).toEqual({ rtl: artifactHash(RTL_B) });
  });

  it("mirrors a non-owner stage's fresh lint result into slot 6 (the stale-lint judge loop)", async function() {
    const freshLint = stampMeasurement("lint", { status: "PASS", errors: [], warnings: [] }, { rtl: RTL_B });
    const dispatched = await drive({
      stageId: 8, stageKey: "verify",
      stageData: { 4: { code: RTL_A }, 6: { status: "FAIL", errors: [{ msg: "old" }], warnings: [] } },
      delta: {
        verify: { total: 3, pass: 3, fail: 0, cli: true },
        rtl_generate: { code: RTL_B, _fixSource: "fixed post verify" },
        lint: freshLint,
      },
    });
    const sets = dispatched.filter(function(a) { return a.type === MODULE_STAGE_DATA_SET && a.stageId === 6; });
    expect(sets).toHaveLength(1);
    expect(sets[0].data.status).toBe("PASS");
  });

  it("does NOT mirror a lint result stamped for code that is not being shipped", async function() {
    const staleLint = stampMeasurement("lint", { status: "PASS", errors: [], warnings: [] }, { rtl: RTL_B });
    const dispatched = await drive({
      stageId: 8, stageKey: "verify",
      stageData: { 4: { code: RTL_A }, 6: { status: "FAIL", errors: [{ msg: "old" }], warnings: [] } },
      delta: {
        verify: { total: 3, pass: 3, fail: 0, cli: true },
        rtl_generate: { code: RTL_A },   // shipped RTL is still A; the lint measured B
        lint: staleLint,
      },
    });
    const sets = dispatched.filter(function(a) { return a.type === MODULE_STAGE_DATA_SET && a.stageId === 6; });
    expect(sets).toHaveLength(0);
  });

  it("leaves an unstamped (legacy) lint delta from a non-owner alone", async function() {
    const dispatched = await drive({
      stageId: 8, stageKey: "verify",
      stageData: { 4: { code: RTL_A } },
      delta: { verify: { total: 1, pass: 1, fail: 0 }, lint: { status: "PASS", errors: [], warnings: [] } },
    });
    expect(dispatched.filter(function(a) { return a.type === MODULE_STAGE_DATA_SET && a.stageId === 6; })).toHaveLength(0);
  });
});

describe("reflow chain runner stamps nested measurements", function() {
  it("a nested lint result carries the hash of the RTL it was invoked on (or returned)", async function() {
    const seen = [];
    async function invokeNode(stageKey, subState) {
      seen.push(stageKey);
      if (stageKey === "rtl_generate") return { rtl_generate: { code: RTL_B }, _llms: [] };
      if (stageKey === "lint") return { lint: { status: "PASS", errors: [], warnings: [] }, rtl_generate: { code: subState.rtl_generate.code }, _llms: [] };
      return { _llms: [] };
    }
    const st = {
      rtl_generate: { code: RTL_A }, test_generate: { code: TB_A },
      _config: { maxLintIters: 1, maxVerifyIters: 1 },
      _services: { invokeNode: invokeNode, allStages: [] },
      _logger: { events: [], llm() {}, cli() {}, skill() {}, prompt() {}, state() {}, result() {}, context: { depth: 0, parentStageKey: null, parentIter: null } },
    };
    const walk = await runReflowChain({
      chain: [
        { stageId: 4, stageKey: "rtl_generate", order: 40, reason: "triage" },
        { stageId: 6, stageKey: "lint",         order: 60, reason: "downstream" },
      ],
      st: st, ownerKey: "verify", ownerIter: 1, parentDepth: 0,
      currentState: Object.assign({}, st), allLlms: [], appendLog: function() {},
      strictOnError: false,
    });
    expect(walk.fallbackToLegacy).toBeFalsy();
    expect(seen).toEqual(["rtl_generate", "lint"]);
    expect(walk.currentState.lint._forHash).toEqual({ rtl: artifactHash(RTL_B) });
    expect(isFreshFor("lint", walk.currentState.lint, { rtl: RTL_B })).toBe(true);
    expect(isFreshFor("lint", walk.currentState.lint, { rtl: RTL_A })).toBe(false);
  });
});
