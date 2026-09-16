// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
vi.mock("../src/cli/index.js", async () => ({ ...await vi.importActual("../src/cli/index.js"), runCli: vi.fn() }));
import { runCli } from "../src/cli/index.js";
import * as proposals from "../src/pipeline/syntaxRepair.js";
import { repairCandidate } from "../src/pipeline/syntaxRepairGate.js";
import { buildPipeline } from "../src/pipeline/buildPipeline.js";

const moduleCode = "module Probe; endmodule";
const tb = "module Probe_tb;\nlogic pulse;\ninitial pulse = 0;\nendmodule";
const interfaceCode = "interface Channel;\nlogic pulse;\nendinterface\n";
const unrelated = "module First;\nlogic pulse;\nendmodule\n";
const state = () => ({ elicit: { modName: "Probe" }, spec: { requirements: [], iface: [], params: [] },
  rtl_generate: { code: moduleCode }, _config: { syntaxRepair: true, backendUrl: "local", cliRetryCount: 0,
    tbLintCmd: "iverilog -g2012 -s Probe_tb -o check.out {RTL} {TB}",
    lintCmd: "iverilog -g2012 -s Probe -o check.out {RTL}" },
});
function realCompile(_url, request) {
  const dir = mkdtempSync(join(tmpdir(), "rtlforge-syntax-safety-"));
  try {
    for (const [file, code] of Object.entries(request.files)) writeFileSync(join(dir, file), code);
    try {
      const stdout = execFileSync("bash", ["-c", request.command], { cwd: dir, encoding: "utf8", timeout: 10000, stdio: "pipe" });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (e) {
      // Transport failures must fail the test, not masquerade as HDL errors.
      if (!Number.isInteger(e.status)) throw e;
      return { exitCode: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
beforeEach(() => { runCli.mockReset(); runCli.mockImplementation(realCompile); });
afterEach(() => vi.restoreAllMocks());

function assertCompiles(code) {
  expect(realCompile("", { command: "iverilog -g2012 -s Probe_tb -o out a.sv", files: { "a.sv": code } })).toMatchObject({ exitCode: 0 });
}

describe("scope preservation with generic compiler fixtures", () => {
  it.each([unrelated, interfaceCode, "package Symbols;\nint count;\nendpackage\n"])("preserves independent design units: %s", prefix => {
    const raw = prefix + tb;
    expect(proposals.repairSV(raw).code).toBe(raw);
    assertCompiles(raw);
    assertCompiles(proposals.repairSV(raw).code);
  });
  it("adding an unrelated module cannot change a valid module", () => {
    const fixed = proposals.repairSV(tb).code;
    expect(proposals.repairSV(unrelated + tb).code).toBe(unrelated + fixed);
  });
  it("removes duplicates only within their own module", () => {
    const raw = unrelated + tb.replace("initial", "logic pulse;\ninitial");
    const fixed = proposals.repairSV(raw).code;
    expect(fixed).toBe(unrelated + tb);
    assertCompiles(fixed);
  });
  it.each([
    "module Probe_tb;\nlogic pulse;\ngenerate if (1) begin : G\nlogic pulse;\nend endgenerate\nendmodule",
    "module Probe_tb;\ntask a;\nint count;\nendtask\ntask b;\nint count;\nendtask\nendmodule",
    "module Probe_tb;\ninitial begin : A\nint count;\nend\ninitial begin : B\nint count;\nend\nendmodule",
    "module Probe_tb;\n`ifdef FIRST\nlogic pulse;\n`else\nlogic pulse;\n`endif\nendmodule",
    "`ifdef FIRST\nmodule Probe_tb;\n`else\nmodule Probe_tb;\n`endif\nlogic pulse;\nendmodule",
  ])("preserves nested/conditional declarations", raw => {
    expect(proposals.repairSV(raw).code).toBe(raw);
    assertCompiles(raw);
  });
  it.each([
    "class Holder;\nint count;\nendclass\nmodule Probe_tb;\nint count;\nendmodule",
    "module Probe_tb;\nlogic pulse;\n`DECLARE_PULSE\nlogic pulse;\nendmodule",
    "module Probe_tb;\nlogic pulse;\nlogic pulse;\nendinterface",
    "module Probe_tb;\nlogic pulse;\nlogic pulse;\n",
    "module Probe_tb;\nlogic pulse;\nif (1)\nlogic pulse;\nendmodule",
    "module Probe_tb;\nlogic pulse;\nstruct packed {\nlogic pulse;\n} data;\nendmodule",
    "module Probe_tb;\nlogic pulse;\nproperty p; 1; endproperty\nlogic pulse;\nendmodule",
  ])("leaves unsupported or incomplete scope evidence untouched", raw => {
    expect(proposals.repairProposals(raw, { syntaxOnly: true }).edits).toEqual([]);
  });
});

describe("production transform acceptance", () => {
  it.each([unrelated + tb, interfaceCode + tb])("preserves declarations through actual generation", async raw => {
    const st = state();
    st._config._llmReplay = () => ({ text: JSON.stringify({ code: raw, tests: [] }) });
    const result = await buildPipeline().invokeNode("test_generate", st);
    expect(result.test_generate.code).toBe(raw);
    assertCompiles(result.test_generate.code);
  });
  it("accepts a compiler-qualified duplicate repair through actual generation", async () => {
    const st = state(), raw = unrelated + tb.replace("initial", "logic pulse;\ninitial");
    st._config._llmReplay = () => ({ text: JSON.stringify({ code: raw, tests: [] }) });
    const result = await buildPipeline().invokeNode("test_generate", st);
    expect(result.test_generate.code).toBe(unrelated + tb);
    const audit = result.test_generate._syntaxRepairSafety.audit[0];
    expect(audit).toMatchObject({ rawCode: raw, rawCompile: { passed: false }, proposedCompile: { passed: true } });
    expect(audit.edits[0].rule).toBe("duplicate-module-decl");
    const replayed = audit.edits.reduce((code, e) => {
      expect(code.slice(e.offset, e.offset + e.removed.length)).toBe(e.removed);
      return code.slice(0, e.offset) + e.inserted + code.slice(e.offset + e.removed.length);
    }, audit.rawCode);
    expect(replayed).toBe(result.test_generate.code);
    expect(audit.rawCompile.command).toBe(audit.proposedCompile.command);
    const first = runCli.mock.calls[0][1], second = runCli.mock.calls[1][1];
    expect(first.files["Probe.sv"]).toBe(second.files["Probe.sv"]);
    expect(first.files["Probe_tb.sv"]).toBe(raw);
    expect(second.files["Probe_tb.sv"]).toBe(unrelated + tb);
    assertCompiles(result.test_generate.code);
  });
  it("rolls back a faulty transform and quarantines it across nested calls and stage resume", async () => {
    const original = proposals.repairProposals;
    vi.spyOn(proposals, "repairProposals").mockImplementation((raw, options) => {
      if (options.disabled.includes("duplicate-module-decl")) return original(raw, options);
      const broken = raw.replace("logic pulse;\n", "");
      return { code: broken, edits: [{ rule: "duplicate-module-decl", count: 1, before: raw, after: broken }], deferred: [] };
    });
    const st = state();
    st._config._llmReplay = () => ({ text: JSON.stringify({ code: tb, tests: [] }) });
    const result = await buildPipeline().invokeNode("test_generate", st);
    expect(result.test_generate.code).toBe(tb);
    expect(result.test_generate._syntaxRepairSafety.disabled).toEqual(["duplicate-module-decl"]);
    expect(result.test_generate._syntaxRepairSafety.audit[0]).toMatchObject({ rawCompile: { passed: true }, proposedCompile: { passed: false }, failure: { rule: "duplicate-module-decl" } });
    const calls = runCli.mock.calls.length;
    expect((await repairCandidate({ ...result }, tb)).code).toBe(tb);
    const resumed = { ...state(), test_generate: result.test_generate };
    expect((await repairCandidate(resumed, tb)).code).toBe(tb);
    expect(runCli.mock.calls.length).toBe(calls);
    expect((await repairCandidate(state(), tb)).code).toBe(tb); // fresh run checks again
    expect(runCli.mock.calls.length).toBeGreaterThan(calls);
  });
  it("does not turn unavailable compilation into adoption", async () => {
    runCli.mockResolvedValue({ _error: true, _msg: "compiler unavailable" });
    const raw = tb.replace("initial", "logic pulse;\ninitial"), st = state();
    expect((await repairCandidate(st, raw)).code).toBe(raw);
    expect(st._syntaxRepairSession.audit[0].outcome).toBe("repair unqualified; raw preserved");
  });
  it("defers timing and width interpretations without treating compilation as behavioral evidence", async () => {
    const raw = "module Probe_tb;\nlogic [3] data;\ninitial begin\n@(posedge clk);\ncheck(data == 0);\nend\nendmodule";
    const st = state();
    expect((await repairCandidate(st, raw)).code).toBe(raw);
    expect(st._syntaxRepairSession.audit[0].deferred.map(e => e.rule)).toContain("packed-range-bound");
    expect(runCli).not.toHaveBeenCalled();
  });
  it("keeps legal raw code even when the proposed rewrite also compiles", async () => {
    vi.spyOn(proposals, "repairProposals").mockReturnValue({ code: tb + "\n// changed", edits: [{ rule: "fence-backtick-strip", count: 1, before: tb, after: tb + "\n// changed" }], deferred: [] });
    expect((await repairCandidate(state(), tb)).code).toBe(tb);
  });
  it("preserves abort semantics", async () => {
    runCli.mockRejectedValue(Object.assign(new Error("stop"), { name: "AbortError" }));
    await expect(repairCandidate(state(), tb.replace("initial", "logic pulse;\ninitial"))).rejects.toMatchObject({ name: "AbortError" });
  });
});
