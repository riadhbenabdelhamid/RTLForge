// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../src/cli/index.js", async () => ({ ...await vi.importActual("../src/cli/index.js"), runCli: vi.fn() }));
import { runCli } from "../src/cli/index.js";
import { selectInitialCandidate } from "../src/pipeline/initialCandidateSelection.js";
import { rtlGenerateNode } from "../src/pipeline/nodes/rtl_generate.js";
import { sealDesignContract, checkerInputHash } from "../src/pipeline/designContract.js";
import { extractModuleInterface } from "../src/utils/svInterface.js";
import { djb2 } from "../src/utils/hash.js";
import { simulationCommands, simulationIdentity } from "../src/pipeline/simulationExecution.js";
import { classifySimulationOutcome } from "../src/pipeline/classifiers.js";

const good = "module CopyUnit(input d, output q); assign q=d; endmodule";
const bad = good.replace("q=d", "q=1'b0");
const tb = 'module CopyUnit_tb; reg d; wire q; CopyUnit dut(d,q); initial begin d=0; #1; if(q===0) $display("[PASS] low"); else $display("[FAIL] low"); d=1; #1; if(q===1) $display("[PASS] high"); else $display("[FAIL] high"); $finish; end endmodule';
function fixture() {
  const st = { _userDesc: "The output q copies input d without storage.", elicit: { modName: "CopyUnit" }, architect: {},
    _config: { backendUrl: "local", simCmds: "verilator --binary -Wall {RTL} {TB}\n./obj_dir/sim", standaloneFallback: true },
    spec: { modName: "CopyUnit", iface: [{ name: "d", dir: "input", width: "1" }, { name: "q", dir: "output", width: "1" }],
      requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "The output copies the input.", src: "The output q copies input d without storage." }] } };
  st.spec._designContract = sealDesignContract(st._userDesc, st.spec, st.elicit);
  const output = { rtl_generate: { code: bad, _standaloneCandidate: { code: good, status: "READY" },
    _standaloneCheckerCandidate: { code: tb, status: "READY", qualification: { status: "PASS", sourceHash: djb2(tb),
      inputHash: checkerInputHash(st, extractModuleInterface(good, "CopyUnit")) } } } };
  return { st, output };
}
beforeEach(() => {
  runCli.mockReset();
  runCli.mockImplementation(async (_, request) => {
    const faulty = request.files["CopyUnit.sv"] === bad;
    if (faulty && !request.command.includes("-Wno-fatal")) return { exitCode: 1, stdout: "", stderr: "%Error: Exiting due to 1 warning(s)" };
    return { exitCode: faulty ? 1 : 0, stdout: "[PASS] low\n[" + (faulty ? "FAIL" : "PASS") + "] high\n", stderr: "" };
  });
});

describe("initial measured selection", () => {
  it("selects an improvement before review and keeps both original candidates for audit", async () => {
    const { st, output } = fixture();
    const chosen = await selectInitialCandidate(st, output);
    expect(chosen.rtl_generate.code).toBe(good);
    expect(chosen.rtl_generate._initialComparison).toMatchObject({ adopted: true, phase: "before-rtl-review",
      primary: { code: bad, verify: { pass: 1, fail: 1, total: 2 } }, alternative: { verify: { pass: 2, fail: 0, total: 2 } } });
    expect(chosen.rtl_generate._initialCandidate.code).toBe(bad);
    expect(output.rtl_generate.code).toBe(bad);
    expect(runCli).toHaveBeenCalledTimes(2);
  });

  it.each(["regression", "unknown-exit", "partial", "stale-checker", "interface", "source-conflict"])("keeps the primary on %s evidence", async kind => {
    const { st, output } = fixture();
    if (kind === "regression") { output.rtl_generate.code = good; output.rtl_generate._standaloneCandidate.code = bad; }
    if (kind === "unknown-exit") runCli.mockResolvedValue({ stdout: "[PASS] low\n[PASS] high\n", stderr: "" });
    if (kind === "partial") runCli.mockResolvedValue({ exitCode: 0, stdout: "[PASS] low\n", stderr: "" });
    if (kind === "stale-checker") output.rtl_generate._standaloneCheckerCandidate.qualification.inputHash = "stale";
    if (kind === "interface") output.rtl_generate._standaloneCandidate.code = good.replace("input d", "input [2:0] d");
    if (kind === "source-conflict") st.spec.requirements[0].src = "a nonexistent quote";
    expect((await selectInitialCandidate(st, output)).rtl_generate.code).toBe(output.rtl_generate.code);
  });

  it("returns the selected RTL from the real generation node before downstream stages start", async () => {
    const { st } = fixture();
    const responses = [{ code: good }, { code: tb }, { status: "PASS", findings: [], summary: "Independent checks" }, { code: bad }];
    let calls = 0;
    st._config = { ...st._config, provider: "openai", model: "offline-test", stageSettings: {},
      _llmReplay: () => ({ text: JSON.stringify(responses[calls++]) }) };
    const out = await rtlGenerateNode(st);
    expect(calls).toBe(4);
    expect(out.rtl_generate.code).toBe(good);
    expect(out.rtl_generate._initialComparison.adopted).toBe(true);
    expect(out.formal_verify).toBeUndefined();
  });
});

describe("consistent simulator policy", () => {
  it("shares warning policy and preserves other simulator commands", () => {
    const cfg = { simCmds: "verilator --binary -Wall {RTL} {TB}\n./obj_dir/sim" };
    expect(simulationCommands(cfg)[0]).toContain("-Wno-fatal");
    expect(simulationCommands({ ...cfg, verifyWarningsAsErrors: true })[0]).not.toContain("-Wno-fatal");
    expect(simulationCommands({ simCmds: "iverilog -g2012 {RTL} {TB}\nvvp sim" })).toEqual(["iverilog -g2012 {RTL} {TB}", "vvp sim"]);
    expect(simulationIdentity(cfg)).not.toBe(simulationIdentity({ ...cfg, verifyWarningsAsErrors: true }));
  });
  it("classifies compiler warning termination separately from incomplete runtime execution", () => {
    expect(classifySimulationOutcome({ exitCode: 1, stderr: "%Error: Exiting due to 2 warning(s)", tests: [] })).toBe("COMPILE_FAILURE");
    expect(classifySimulationOutcome({ exitCode: 1, stderr: "Aborting...", tests: [{ name: "low", st: "PASS" }] })).toBe("RUNTIME_EXIT");
  });
});
