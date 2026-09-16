// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/cli/index.js", async () => ({ ...await vi.importActual("../src/cli/index.js"), runCli: vi.fn() }));
import { runCli } from "../src/cli/index.js";
import { buildPipeline } from "../src/pipeline/buildPipeline.js";
import { ALL_STAGES } from "../src/constants/stages.js";
import { reviewRepairBudget } from "../src/pipeline/reviewRepairBudget.js";

const review = { verdict: "NEEDS_FIX", score: 40, issues: [{ id: "TR-001", severity: "critical", description: "Missing boundary test", fix: "Add boundary test" }] };
const tb = "module Sample_tb;\nlogic pulse;\ninitial pulse = 0;\nendmodule";
function setup(chain, limit = 4) {
  const graph = buildPipeline(), calls = [];
  let count = 0;
  const st = { elicit: { modName: "Sample" }, spec: { requirements: [], iface: [], params: [] },
    rtl_generate: { code: "module Sample; endmodule" }, test_generate: { code: tb },
    _config: { maxTestReviewIters: limit, syntaxRepair: false, backendUrl: "mock", cliRetryCount: 0,
      optionalStages: { test_review: true }, stageSettings: {},
      _llmReplay: request => {
        calls.push(request);
        const fixing = request.userMessage.includes("TASK: Fix the listed issues");
        return { text: JSON.stringify(fixing ? { code: tb + "\n// change " + (++count), fixes: [] } : review) };
      },
    },
  };
  if (chain) st._services = { invokeNode: graph.invokeNode, allStages: ALL_STAGES };
  return { graph, st, calls };
}
beforeEach(() => { runCli.mockReset(); runCli.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }); });

describe("bounded production review trees", () => {
  it.each([false, true])("spends at most four repairs including nested review (chain=%s)", async chain => {
    const { graph, st, calls } = setup(chain);
    const result = await graph.invokeNode("test_review", st);
    expect(calls.filter(c => c.userMessage.includes("TASK: Fix the listed issues"))).toHaveLength(4);
    expect(calls).toHaveLength(9); // initial assessment + 4 fixes + 4 assessments
    expect(result.test_review._repairBudget).toMatchObject({ limit: 4, used: 4, stopReason: "shared repair budget exhausted" });
    if (chain) expect(result.test_review._chain).toHaveLength(4);
  });
  it("respects a zero repair cap", async () => {
    const { graph, st, calls } = setup(true, 0);
    const result = await graph.invokeNode("test_review", st);
    expect(calls).toHaveLength(1);
    expect(result.test_generate.code).toBe(tb);
    expect(result.test_review._repairBudget.used).toBe(0);
  });
  it.each([false, true])("feeds compiler evidence back and stops repeated rejected repairs (chain=%s)", async chain => {
    const { graph, st, calls } = setup(chain, 8);
    const broken = tb.replace("initial", "BROKEN initial");
    st._config._llmReplay = request => {
      calls.push(request);
      return { text: JSON.stringify(request.userMessage.includes("TASK: Fix the listed issues") ? { code: broken, fixes: [] } : review) };
    };
    runCli.mockImplementation((_url, req) => {
      const bad = req.files["Sample_tb.sv"].includes("BROKEN");
      return { exitCode: bad ? 1 : 0, stdout: "", stderr: bad ? "%Error: Sample_tb.sv:3: syntax error, unexpected BROKEN" : "" };
    });
    const result = await graph.invokeNode("test_review", st);
    const fixes = calls.filter(c => c.userMessage.includes("TASK: Fix the listed issues"));
    expect(fixes).toHaveLength(2);
    expect(fixes[1].userMessage).toContain("unexpected BROKEN");
    expect(fixes[1].userMessage).toContain("PREVIOUS REPAIR REJECTED");
    expect(result.test_generate.code).toBe(tb);
    expect(result.test_review._repairBudget.stopReason).toBe("repeated rejected repair");
  });
  it("shares the same allowance with corrective re-asks", () => {
    const st = {}, owner = reviewRepairBudget(st, "rtl_review", 2);
    expect(owner.take()).toBe(true);
    const nested = reviewRepairBudget({ ...st }, "rtl_review", 99);
    expect(nested.nested).toBe(true);
    expect(nested.take()).toBe(true);
    expect(owner.take()).toBe(false);
    expect(owner.report()).toMatchObject({ limit: 2, used: 2 });
  });
});
