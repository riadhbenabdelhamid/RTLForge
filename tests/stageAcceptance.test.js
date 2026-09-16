// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
vi.mock("../src/cli/index.js", async () => ({ ...await vi.importActual("../src/cli/index.js"), runCli: vi.fn() }));
import { runCli } from "../src/cli/index.js";
import { guardStageReplacement } from "../src/pipeline/stageAcceptance.js";
import { StateGraph } from "../src/pipeline/StateGraph.js";
import { buildPipeline } from "../src/pipeline/buildPipeline.js";
import { sealDesignContract, checkerInputHash } from "../src/pipeline/designContract.js";
import { djb2 } from "../src/utils/hash.js";

const good = "module DelayWord(input clk,clear,input [3:0] sample,output reg [3:0] word); reg [3:0] history; always @(posedge clk) begin history<=sample; if(clear) word<=0; else word<=history; end endmodule";
const bad = good.replace("history<=sample; if(clear) word<=0; else word<=history;", "if(clear) begin history<=0; word<=0; end else begin history<=sample; word<=history; end");
const tb = `module DelayWord_tb;
reg clk=0,clear=1; reg [3:0] sample=9; wire [3:0] word; DelayWord dut(clk,clear,sample,word);
initial begin #1; clk=1; #1; if(word===0) $display("[PASS] clear.word"); else $display("[FAIL] clear.word");
clk=0; clear=0; sample=4; #1; clk=1; #1; if(word===9) $display("[PASS] clear.history"); else $display("[FAIL] clear.history"); $finish; end endmodule`;
function state(code = good) {
  const st = { _userDesc: "Delay each sampled word by one edge. Clear affects only the output; input history always samples.",
    _config: { backendUrl: "local", simCmds: "iverilog -g2012 -s DelayWord_tb -o sim {RTL} {TB}\nvvp sim" },
    elicit: { modName: "DelayWord" }, spec: { modName: "DelayWord", iface: [], requirements: [] }, rtl_generate: { code },
    test_generate: { code: tb }, verify: { cli: true, status: "PASS", pass: 2, fail: 0, total: 2 } };
  st.spec.requirements = [{ id: "REQ-FUNC-001", desc: st._userDesc, src: st._userDesc }];
  st.spec._designContract = sealDesignContract(st._userDesc, st.spec, st.elicit);
  st.rtl_generate._standaloneCheckerCandidate = { code: tb, status: "READY", designContractHash: st.spec._designContract.hash,
    qualification: { status: "PASS", sourceHash: djb2(tb), inputHash: checkerInputHash(st, "") } };
  return st;
}
beforeEach(() => { runCli.mockReset(); runCli.mockImplementation(async (_, request) => {
  const dir = mkdtempSync(join(tmpdir(), "stage-acceptance-"));
  try {
    for (const [name, code] of Object.entries(request.files)) writeFileSync(join(dir, name), code);
    try { return { exitCode: 0, stdout: execFileSync("bash", ["-c", request.command], { cwd: dir, timeout: 10000, encoding: "utf8", stdio: "pipe" }), stderr: "" }; }
    catch (e) { return { exitCode: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}); });
const invoke = (name, fn, st) => new StateGraph().addNode(name, guardStageReplacement(name, fn)).compile().invokeNode(name, st);

describe("stage boundaries preserve candidates against a frozen independent checker", () => {
  it("protects actual RTL generation through the production pipeline", async () => {
    const st = state();
    st._config._llmReplay = () => ({ text: JSON.stringify({ code: bad, fixes: [] }) });
    st._fixContext = { source: "judge", previousCode: good, verifyResult: st.verify };
    const out = await buildPipeline().invokeNode("rtl_generate", st);
    expect(out.rtl_generate.code).toBe(good);
    expect(out.rtl_generate._candidateAcceptance.at(-1).reason).toBe("PASSED_CHECK_REGRESSION");
  });
  it.each(["rtl_generate", "lint", "verify", "judge", "formal_verify"])("rejects a reset-scope regression from %s and restores dependent evidence", async name => {
    const st = state();
    const out = await invoke(name, async () => ({ rtl_generate: { code: bad }, test_generate: { code: "weakened checker" },
      verify: { cli: true, pass: 99, total: 99 }, formal_verify: { status: "PASS", proven: true } }), st);
    expect(out.rtl_generate.code).toBe(good);
    expect(out.test_generate.code).toBe(tb);
    expect(out.verify.pass).toBe(2);
    expect(out.formal_verify?.proven).not.toBe(true);
    expect(out.rtl_generate._candidateAcceptance.at(-1)).toMatchObject({ adopted: false, reason: "PASSED_CHECK_REGRESSION", proposal: bad });
  });
  it("accepts a strict measured improvement", async () => {
    const out = await invoke("verify", async () => ({ rtl_generate: { code: good, _standaloneCheckerCandidate: { code: "weakened checker" } } }), state(bad));
    expect(out.rtl_generate.code).toBe(good);
    expect(out.rtl_generate._candidateAcceptance.at(-1).adopted).toBe(true);
    expect(out.rtl_generate._standaloneCheckerCandidate.code).toBe(tb);
  });
  it("does not replace the incumbent on a tie", async () => {
    const out = await invoke("lint", async () => ({ rtl_generate: { code: good + "\n// reformat" } }), state());
    expect(out.rtl_generate.code).toBe(good);
    expect(out.rtl_generate._candidateAcceptance.at(-1).reason).toBe("TIE");
  });
  it("checks interface fidelity before comparing functional scores", async () => {
    const st = state();
    st.spec.iface = [{ name: "sample", dir: "input", width: "4" }];
    st.spec._designContract = sealDesignContract(st._userDesc, st.spec, st.elicit);
    const out = await invoke("verify", async () => ({ rtl_generate: { code: good.replace("[3:0] sample", "[2:0] sample") } }), st);
    expect(out.rtl_generate.code).toBe(good);
    expect(out.rtl_generate._candidateAcceptance.at(-1).reason).toBe("INTERFACE_CONTRACT_CHANGED");
    expect(runCli).not.toHaveBeenCalled();
  });
  it("retains useful RTL when the checker cannot run", async () => {
    runCli.mockResolvedValue({ _error: true, _msg: "tool unavailable" });
    const out = await invoke("judge", async () => ({ rtl_generate: { code: bad }, judge: { overall: "PASS" } }), state());
    expect(out.rtl_generate.code).toBe(good);
    expect(out.judge.overall).toBe("UNVERIFIED");
  });
  it("does not let a nested stage replace the checker to authorize a repair", async () => {
    const st = state();
    const graph = new StateGraph();
    graph.addNode("verify", guardStageReplacement("verify", async () => ({ rtl_generate: { code: bad, _standaloneCheckerCandidate: { code: "always passes" } } })));
    let compiled;
    graph.addNode("judge", guardStageReplacement("judge", async s => compiled.invokeNode("verify", s)));
    compiled = graph.compile();
    const out = await compiled.invokeNode("judge", st);
    expect(out.rtl_generate.code).toBe(good);
    expect(out.rtl_generate._standaloneCheckerCandidate.code).toBe(tb);
    expect(out.rtl_generate._candidateAcceptance.at(-1).stage).toBe("verify");
  });
  it("rejects a changed specification even if RTL text stays identical", async () => {
    const out = await invoke("judge", async s => ({ spec: { ...s.spec, requirements: [] }, judge: { overall: "PASS" } }), state());
    expect(out.spec.requirements).toHaveLength(1);
    expect(out.rtl_generate._candidateAcceptance.at(-1).reason).toBe("FROZEN_SPECIFICATION_CHANGED");
  });
  it("detects in-place specification mutation and restores the snapshot", async () => {
    const out = await invoke("judge", async s => { s.spec.requirements = []; return {}; }, state());
    expect(out.spec.requirements).toHaveLength(1);
    expect(out.rtl_generate._candidateAcceptance.at(-1).reason).toBe("FROZEN_SPECIFICATION_CHANGED");
  });
  it("carries the frozen checker when a stage returns only unchanged RTL", async () => {
    const out = await invoke("rtl_generate", async () => ({ rtl_generate: { code: good } }), state());
    expect(out.rtl_generate._standaloneCheckerCandidate.code).toBe(tb);
    expect(runCli).not.toHaveBeenCalled();
  });
  it("permits a separately sealed specification revision and preserves the prior candidate record", async () => {
    const st = state(); st.rtl_generate._initialCandidate = { code: good, contractHash: st.spec._designContract.hash };
    const out = await invoke("judge", async s => {
      const spec = { ...s.spec, requirements: [] };
      spec._designContract = sealDesignContract(s._userDesc, spec, s.elicit, s.spec._designContract);
      return { spec, rtl_generate: { code: bad } };
    }, st);
    expect(out.spec._designContract.revision).toBe(2);
    expect(out.rtl_generate._initialCandidate.code).toBe(good);
  });
  it("allows a measured compiling replacement for a syntactically broken incumbent", async () => {
    const out = await invoke("lint", async () => ({ rtl_generate: { code: good } }), state("module DelayWord( broken"));
    expect(out.rtl_generate.code).toBe(good);
  });
});
