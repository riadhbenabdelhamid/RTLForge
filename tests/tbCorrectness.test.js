// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// TB correctness measures (docs/tb-correctness.md): reference-model TB
// architecture (selectable), review criteria, wave-grounded default, and the
// formal arbiter in verify's triage.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promptTB } from "../src/prompts/testGen.js";
import { promptTestReview } from "../src/prompts/testReview.js";
import { defaultProjectConfig } from "../src/react/useProject.jsx";
import { _internal as termConfigInternal } from "../src/term/config.js";

const SPEC = {
  modName: "ctr",
  requirements: [{ id: "REQ-FUNC-001", pri: "Must", desc: "counts up when en" }],
  iface: [], params: [],
};
const EL = { modName: "ctr" };
const RTL = "module ctr(input clk, input rst_n, input en, output logic [3:0] q);\nendmodule";

describe("reference-model TB architecture (tbArchitecture)", () => {
  it("default (reference-model) prompt demands shadow model + step() + ref-compared checks", () => {
    const p = promptTB(RTL, SPEC, EL, [], null, "reference-model");
    expect(p.userMessage).toContain("REFERENCE MODEL + STEP TASK");
    expect(p.userMessage).toContain("ref_count");
    expect(p.userMessage).toContain("task automatic step(");
    expect(p.userMessage).toMatch(/check\(count == ref_count/);
  });

  it("directed mode omits the reference-model section (classic style preserved)", () => {
    const p = promptTB(RTL, SPEC, EL, [], null, "directed");
    expect(p.userMessage).not.toContain("REFERENCE MODEL + STEP TASK");
    // classic sections intact
    expect(p.userMessage).toContain("DIRECTED TESTS");
    expect(p.userMessage).toContain("CHECK TASK");
  });

  it("architecture param omitted → reference-model (safe default at the prompt layer)", () => {
    const p = promptTB(RTL, SPEC, EL, [], null);
    expect(p.userMessage).toContain("REFERENCE MODEL + STEP TASK");
  });

  it("test review gains the reference-model criterion only in that mode", () => {
    const ref = promptTestReview("module tb; endmodule", RTL, SPEC, EL, "reference-model");
    expect(ref.userMessage).toContain("REFERENCE MODEL");
    expect(ref.userMessage).toMatch(/ref_ counterpart/);
    const dir = promptTestReview("module tb; endmodule", RTL, SPEC, EL, "directed");
    expect(dir.userMessage).not.toContain("ref_ counterpart");
  });
});

describe("defaults (both config sources)", () => {
  it("GUI: reference-model default, wave-grounded on, formal arbiter opt-in", () => {
    const c = defaultProjectConfig();
    expect(c.tbArchitecture).toBe("reference-model");
    expect(c.waveGroundedFixes).toBe(true);
    expect(c.formalArbiter).toBe(false);
  });
  it("CLI matches", () => {
    const c = termConfigInternal.DEFAULT_CONFIG;
    expect(c.tbArchitecture).toBe("reference-model");
    expect(c.waveGroundedFixes).toBe(true);
    expect(c.formalArbiter).toBe(false);
  });
});

// ─── formal arbiter in verify's triage ──────────────────────────────────────
vi.mock("../src/llm/index.js", async function() {
  const actual = await vi.importActual("../src/llm/extractJSON.js");
  return { callLLM: vi.fn(), extractJSON: actual.extractJSON, addRetryHint: function(s) { return s; } };
});
vi.mock("../src/cli/index.js", function() {
  return {
    runCli: vi.fn(),
    parseTestLine: function(l) {
      const m = /\[(PASS|FAIL)\] (\S+)/.exec(l);
      return m ? { name: m[2], status: m[1], cyc: 1, ms: 1 } : null;
    },
    parseCLIOutput: function() { return { errors: [], warnings: [] }; },
    parseCoverageDat: function() { return { line: 90, branch: 80, toggle: 70 }; },
    CliBackendError: class extends Error {},
  };
});

const { verifyNode } = await import("../src/pipeline/nodes/verify.js");
const { callLLM } = await import("../src/llm/index.js");
const { runCli } = await import("../src/cli/index.js");

function verifyState(cfg) {
  return {
    elicit: { modName: "ctr" },
    spec: SPEC,
    rtl_generate: { code: RTL },
    test_generate: { code: "module ctr_tb; endmodule" },
    formal_verify: { status: "PASS", depth: 20, properties: ["P_count_incr", "P_reset"] },
    _config: Object.assign({
      provider: "openai", model: "gpt-4o", apiKey: "sk-test",
      maxVerifyIters: 1,                       // one iteration: measure + triage, then cap
      backendUrl: "http://localhost:3001", strictCli: false,
      simCmds: "verilator --binary {RTL} {TB} -o sim\n./obj_dir/sim",
      cliRetryCount: 0, backendTimeoutSec: 10, stageSettings: {},
    }, cfg || {}),
    _onLog: null, _signal: null,
  };
}

const llmReply = (json) => ({
  text: JSON.stringify(json), tokensIn: 10, tokensOut: 5, latencyMs: 1,
  model: "gpt-4o", provider: "openai", stopReason: "stop",
});

beforeEach(() => { callLLM.mockReset(); runCli.mockReset(); });

describe("formal arbiter (opt-in) in verify triage", () => {
  const failingSim = { stdout: "[PASS] REQ-FUNC-001.1\n[FAIL] REQ-FUNC-001.2\n", stderr: "", exitCode: 1 };

  it("BMC PASS + formalArbiter → failing tests routed to the TB with NO triage LLM call", async () => {
    const st = verifyState({ formalArbiter: true, maxVerifyIters: 2 });
    runCli.mockResolvedValue(failingSim);
    // Only the TB fix should be requested — return an identical TB so the
    // loop stalls out quickly (patch no-op path).
    callLLM.mockResolvedValue(llmReply({ code: "module ctr_tb; endmodule", fixes: [] }));

    const d = await verifyNode(st);

    const h = d.verify.verifyHistory.find((x) => x.triageTarget);
    expect(h.triageTarget).toBe("test_generate");
    expect(h.triageReason).toMatch(/formal arbiter/);
    expect(h.triageReason).toMatch(/depth 20/);
    // No LLM call carried the triage prompt (all calls are fixes).
    const triageCalls = callLLM.mock.calls.filter((c) => /root cause|triage/i.test(c[0].userMessage || ""));
    expect(triageCalls).toHaveLength(0);
  });

  it("arbiter off (default) → the LLM triage runs as before", async () => {
    const st = verifyState({ maxVerifyIters: 2 });
    runCli.mockResolvedValue(failingSim);
    callLLM
      .mockResolvedValueOnce(llmReply({ target: "test_generate", reason: "tb checks wrong cycle" }))
      .mockResolvedValue(llmReply({ code: "module ctr_tb; endmodule", fixes: [] }));

    const d = await verifyNode(st);
    const h = d.verify.verifyHistory.find((x) => x.triageTarget);
    expect(h.triageReason).toBe("tb checks wrong cycle");
  });

  it("no formal PASS (status FAIL) → arbiter stays out even when enabled", async () => {
    const st = verifyState({ formalArbiter: true, maxVerifyIters: 2 });
    st.formal_verify = { status: "FAIL", depth: 20, properties: ["P_x"] };
    runCli.mockResolvedValue(failingSim);
    callLLM
      .mockResolvedValueOnce(llmReply({ target: "rtl_generate", reason: "property violated too" }))
      .mockResolvedValue(llmReply({ code: RTL + "\n// v2", fixes: [] }));

    const d = await verifyNode(st);
    const h = d.verify.verifyHistory.find((x) => x.triageTarget);
    expect(h.triageReason).toBe("property violated too");
  });

  it("compile failure → DETERMINISTIC triage by failing filename, no LLM triage call (run 9)", async () => {
    const st = verifyState({ maxVerifyIters: 2 });
    st.formal_verify = null;
    // Verilator compile failure naming the TB file — no test lines at all.
    runCli.mockResolvedValue({
      stdout: "",
      stderr: "%Error: ctr_tb.sv:179: syntax error, unexpected invalid token\n%Error: Exiting due to 1 error(s)\n",
      exitCode: 1,
    });
    // Only fix calls should occur; identical TB stalls the loop quickly.
    callLLM.mockResolvedValue(llmReply({ code: "module ctr_tb; endmodule", fixes: [] }));

    const d = await verifyNode(st);

    const h = d.verify.verifyHistory.find((x) => x.triageTarget);
    expect(h.triageTarget).toBe("test_generate");
    expect(h.triageReason).toMatch(/deterministic/);
    expect(h.triageReason).toContain("ctr_tb.sv");
    const triageCalls = callLLM.mock.calls.filter((c) => /root cause|triage/i.test(c[0].userMessage || ""));
    expect(triageCalls).toHaveLength(0);
  });
});
