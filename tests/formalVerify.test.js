// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Formal BMC stage (docs/improvement-roadmap.md #8) — pure parts + skip paths.
// The live proof (buggy counter FAILs with a counterexample window, fixed
// design PASSes via real sby) runs outside CI; see the commit message.

import { describe, it, expect } from "vitest";
import { buildSbyFile, parseSbyOutput } from "../src/cli/formalRunner.js";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";
import { stripDutFormalRegions, inlineFormalAsserts } from "../src/pipeline/svaBind.js";
import { getActiveStages } from "../src/constants/stages.js";

describe("stripDutFormalRegions — DUT-authored ifdef FORMAL blocks (run 10)", () => {
  const rtl = [
    "module ctr(input logic clk, output logic [3:0] q);",
    "always_ff @(posedge clk) q <= q + 1'b1;",
    "`ifdef FORMAL",
    "assert property (@(negedge clk) q == 4'd0);",   // yosys: syntax error, unexpected '@'
    "`endif",
    "endmodule",
  ].join("\n");

  it("removes the FORMAL region yosys cannot parse, keeps the rest", () => {
    const out = stripDutFormalRegions(rtl);
    expect(out).not.toContain("`ifdef FORMAL");
    expect(out).not.toContain("assert property");
    expect(out).toContain("always_ff @(posedge clk)");
    expect(out).toContain("endmodule");
  });

  it("keeps an `else branch and handles nested conditionals", () => {
    const src = [
      "`ifdef FORMAL",
      "bad_formal_stuff();",
      "`ifdef DEEP",
      "deeper();",
      "`endif",
      "`else",
      "kept_sim_code();",
      "`endif",
      "`ifdef SIM",
      "sim_only();",
      "`endif",
    ].join("\n");
    const out = stripDutFormalRegions(src);
    expect(out).not.toContain("bad_formal_stuff");
    expect(out).not.toContain("deeper");
    expect(out).toContain("kept_sim_code();");
    expect(out).toContain("`ifdef SIM");   // unrelated conditionals untouched
    expect(out).toContain("sim_only();");
  });

  it("inlineFormalAsserts strips the DUT block before inlining ours", () => {
    const out = inlineFormalAsserts(rtl, ["always @(posedge clk) assert (q < 16);"]);
    expect(out).not.toContain("`ifdef FORMAL");
    expect(out).toContain("rtlforge formal assertions");
    expect(out).toContain("assert (q < 16);");
  });

  it("normalizes '{default: '0} fill patterns yosys cannot parse (run 26 TOK_DEFAULT)", () => {
    const src = [
      "module m(input logic clk, output logic [7:0] dout);",
      "always_ff @(posedge clk) begin",
      "  dout <= '{default: '0};",
      "  dout <= '{ default : 1'b1 };",
      "end",
      "endmodule",
    ].join("\n");
    const out = inlineFormalAsserts(src, ["always @(posedge clk) assert (1);"]);
    expect(out).not.toContain("default:");
    expect(out).not.toContain("default :");
    expect(out).toContain("dout <= '0;");
    expect(out).toContain("dout <= '1;");
  });
});

describe("buildSbyFile / parseSbyOutput", () => {
  it("renders a bmc job with depth and top", () => {
    const sby = buildSbyFile({ top: "cnt", depth: 12 });
    expect(sby).toMatch(/mode bmc/);
    expect(sby).toMatch(/depth 12/);
    expect(sby).toMatch(/prep -top cnt/);
    expect(sby).toMatch(/read -formal -sv dut\.sv/);
  });
  it("renders a prove (k-induction) job on request; anything else stays bmc", () => {
    expect(buildSbyFile({ top: "cnt", depth: 12, mode: "prove" })).toMatch(/mode prove/);
    expect(buildSbyFile({ top: "cnt", depth: 12, mode: "nonsense" })).toMatch(/mode bmc/);
  });
  it("classifies sby outcomes", () => {
    expect(parseSbyOutput("... DONE (PASS, rc=0)", 0)).toBe("PASS");
    expect(parseSbyOutput("... DONE (FAIL, rc=2)", 2)).toBe("FAIL");
    expect(parseSbyOutput("... DONE (TIMEOUT, rc=8)", 8)).toBe("TIMEOUT");
    expect(parseSbyOutput("garbage", 1)).toBe("TOOL_ERROR");
  });
  it("UNKNOWN is a prove-mode-only classification; bmc keeps its documented states", () => {
    // prove mode: induction didn't close — "not proven", NOT a design defect
    expect(parseSbyOutput("... DONE (UNKNOWN, rc=4)", 4, "prove")).toBe("UNKNOWN");
    // bmc mode: an UNKNOWN abort stays TOOL_ERROR — consumers and the GUI
    // verdict legend only know PASS/FAIL/TIMEOUT/SKIPPED/TOOL_ERROR.
    expect(parseSbyOutput("... DONE (UNKNOWN, rc=4)", 4)).toBe("TOOL_ERROR");
    expect(parseSbyOutput("... DONE (UNKNOWN, rc=4)", 4, "bmc")).toBe("TOOL_ERROR");
  });
});

describe("formalVerifyNode skip paths (never fails a run)", () => {
  it("skips without RTL", async () => {
    const st = await formalVerifyNode({ _config: {} });
    expect(st.formal_verify.status).toBe("SKIPPED");
    expect(st.formal_verify.reason).toMatch(/no RTL/);
  });
  it("skips without bindable properties", async () => {
    const st = await formalVerifyNode({
      _config: {},
      rtl_generate: { code: "module m; endmodule" },
      formal_props: { properties: [] },
      elicit: { modName: "m" },
    });
    expect(st.formal_verify.status).toBe("SKIPPED");
    expect(st.formal_verify.reason).toMatch(/no bindable/);
  });
});

describe("formal fix loop (injected runner + replayed LLM)", () => {
  const FIXED = "module cnt(input logic clk); /* fixed */ endmodule";
  const stBase = () => ({
    _config: {
      formalDepth: 10, maxFormalIters: 2,
      formalProve: false,   // these tests target the FIX LOOP call counts; prove mode has its own suite below
      // Replayed LLM (roadmap #5 hook): every fix call returns the fixed module.
      _llmReplay: () => ({ text: JSON.stringify({ code: FIXED, fixes: [{ id: "SVA-1", desc: "corrected increment" }] }) }),
    },
    elicit: { modName: "cnt" },
    rtl_generate: { code: "module cnt(input logic clk); /* buggy */ endmodule", _syntaxRepairs: [{ rule: "x", count: 1 }] },
    spec: { iface: [{ name: "clk", dir: "input", width: 1 }], params: [] },
    formal_props: { properties: [{ id: "SVA-1", code: "assert property (@(posedge clk) 1);" }] },
  });

  it("FAIL → LLM fix → re-check PASS mirrors the repaired code onto rtl_generate", async () => {
    let calls = 0;
    const runner = {
      sbyAvailable: () => true,
      runBmc: () => (++calls === 1
        ? { status: "FAIL", log: "DONE (FAIL)", cexVcd: "$enddefinitions $end\n#0\n0!\n#5\n1!", elapsedMs: 5 }
        : { status: "PASS", log: "DONE (PASS)", cexVcd: null, elapsedMs: 5 }),
    };
    const st = await formalVerifyNode(Object.assign(stBase(), { _services: { formalRunner: runner } }));
    expect(calls).toBe(2);
    expect(st.formal_verify.status).toBe("PASS");
    expect(st.formal_verify.fixIterations).toBe(1);
    expect(st.formal_verify._llms).toHaveLength(1);
    expect(st.rtl_generate.code).toBe(FIXED);            // mirrored on PASS only
  });

  it("a persistent FAIL keeps the ORIGINAL rtl_generate (best-known semantics)", async () => {
    const runner = {
      sbyAvailable: () => true,
      runBmc: () => ({ status: "FAIL", log: "DONE (FAIL)", cexVcd: null, elapsedMs: 5 }),
    };
    const base = stBase();
    // Each fix must CHANGE the code or the loop stalls — replay two variants.
    let n = 0;
    base._config._llmReplay = () => ({ text: JSON.stringify({ code: FIXED + " // v" + (++n), fixes: [] }) });
    const st = await formalVerifyNode(Object.assign(base, { _services: { formalRunner: runner } }));
    expect(st.formal_verify.status).toBe("FAIL");
    expect(st.formal_verify.fixIterations).toBe(2);      // capped by maxFormalIters
    expect(st.rtl_generate).toBeUndefined();             // no mirror on FAIL
  });

  it("identical fix output stalls the loop instead of spinning", async () => {
    const base = stBase();
    base._config._llmReplay = () => ({ text: JSON.stringify({ code: base.rtl_generate.code, fixes: [] }) });
    const runner = { sbyAvailable: () => true, runBmc: () => ({ status: "FAIL", log: "", cexVcd: null, elapsedMs: 1 }) };
    const st = await formalVerifyNode(Object.assign(base, { _services: { formalRunner: runner } }));
    expect(st.formal_verify.fixIterations).toBe(0);
    expect(st.formal_verify.status).toBe("FAIL");
  });
});

describe("opportunistic unbounded proof (k-induction, PASS-only)", () => {
  const stProve = (cfg) => ({
    _config: Object.assign({ formalDepth: 10, maxFormalIters: 0 }, cfg || {}),
    elicit: { modName: "cnt" },
    rtl_generate: { code: "module cnt(input logic clk); endmodule" },
    spec: { iface: [{ name: "clk", dir: "input", width: 1 }], params: [] },
    formal_props: { properties: [{ id: "SVA-1", code: "assert property (@(posedge clk) 1);" }] },
  });
  function runnerWith(proveStatus) {
    const modes = [];
    return {
      modes,
      sbyAvailable: () => true,
      runBmc: (o) => {
        modes.push(o.mode || "bmc");
        return o.mode === "prove"
          ? { status: proveStatus, log: "DONE (" + proveStatus + ")", cexVcd: null, elapsedMs: 3 }
          : { status: "PASS", log: "DONE (PASS)", cexVcd: null, elapsedMs: 3 };
      },
    };
  }

  it("BMC PASS + induction PASS → proven:true (default ON, second task in prove mode)", async () => {
    const runner = runnerWith("PASS");
    const st = await formalVerifyNode(Object.assign(stProve(), { _services: { formalRunner: runner } }));
    expect(runner.modes).toEqual(["bmc", "prove"]);
    expect(st.formal_verify.status).toBe("PASS");
    expect(st.formal_verify.proven).toBe(true);
    expect(st.formal_verify.proveStatus).toBe("PASS");
  });

  it("BMC PASS + induction UNKNOWN → verdict UNCHANGED, result discarded (not a defect signal)", async () => {
    const runner = runnerWith("UNKNOWN");
    const st = await formalVerifyNode(Object.assign(stProve(), { _services: { formalRunner: runner } }));
    expect(st.formal_verify.status).toBe("PASS");     // bounded PASS stands
    expect(st.formal_verify.proven).toBe(false);
    expect(st.formal_verify.proveStatus).toBe("UNKNOWN");
    expect(st.formal_verify.proveLog).toMatch(/UNKNOWN/);   // prove log preserved for diagnosis
    expect(st.formal_verify.fixIterations).toBe(0);   // never reaches the fix loop
  });

  it("prove task TOOL_ERROR → verdict unchanged, log preserved, message names a tool failure not an induction result", async () => {
    let logBuf = "";
    const runner = runnerWith("TOOL_ERROR");
    const st = await formalVerifyNode(Object.assign(stProve(), {
      _services: { formalRunner: runner },
      _onLog: function(b) { logBuf = b; },
    }));
    expect(st.formal_verify.status).toBe("PASS");
    expect(st.formal_verify.proven).toBe(false);
    expect(st.formal_verify.proveLog).toMatch(/TOOL_ERROR/);
    expect(logBuf).toMatch(/prove task itself did not complete/);
    expect(logBuf).not.toMatch(/routinely fail induction/);
  });

  it("formalProve:false → single bmc task, no prove attempt", async () => {
    const runner = runnerWith("PASS");
    const st = await formalVerifyNode(Object.assign(stProve({ formalProve: false }), { _services: { formalRunner: runner } }));
    expect(runner.modes).toEqual(["bmc"]);
    expect(st.formal_verify.proveStatus).toBeNull();
    expect(st.formal_verify.proven).toBe(false);
  });

  it("BMC FAIL → prove is never attempted (nothing to upgrade)", async () => {
    const modes = [];
    const runner = {
      sbyAvailable: () => true,
      runBmc: (o) => { modes.push(o.mode || "bmc"); return { status: "FAIL", log: "", cexVcd: null, elapsedMs: 1 }; },
    };
    const st = await formalVerifyNode(Object.assign(stProve(), { _services: { formalRunner: runner } }));
    expect(modes).toEqual(["bmc"]);
    expect(st.formal_verify.status).toBe("FAIL");
    expect(st.formal_verify.proven).toBe(false);
  });
});

describe("stage registry", () => {
  it("formal_verify is optional, default off, ordered between SVA props and test gen", () => {
    const off = getActiveStages({ optionalStages: { formal_props: true, lint: true } });
    expect(off.some((s) => s.key === "formal_verify")).toBe(false);
    const on = getActiveStages({ optionalStages: { formal_props: true, formal_verify: true, lint: true } });
    const keys = on.map((s) => s.key);
    const i = keys.indexOf("formal_verify");
    expect(i).toBeGreaterThan(keys.indexOf("formal_props"));
    expect(i).toBeLessThan(keys.indexOf("test_generate"));
  });
});

// ── Fix-prompt evidence quality (replay-C findings, run 23) ────────────────
// Live, the fix prompt listed every property as the literal fallback "prop"
// (checker.included holds id STRINGS, not objects) and the cex window showed
// 2 rows of an 11-tick trace with a solver-internal anyseq_* net occupying a
// column while wr_en/rd_en — the inputs driving the violation — were cut by
// the 8-column cap. The 120b fixed the bug DESPITE the evidence; these pin
// the evidence itself.
describe("formal fix-prompt evidence quality", () => {
  const CEX_VCD = [
    "$timescale 1ns $end",
    "$scope module dut $end",
    "$var wire 1 ! clk $end",
    "$var wire 1 \" rst_n $end",
    "$var wire 1 # wr_en $end",
    "$var wire 1 $ rd_en $end",
    "$var wire 1 % empty $end",
    "$var wire 3 & f_occ [2:0] $end",
    "$var wire 1 ' anyseq_auto_setundef_cc_1 $end",
    "$upscope $end",
    "$enddefinitions $end",
    "#0", "0!", "0\"", "0#", "0$", "1%", "b000 &", "0'",
    "#5", "1!", "1\"",
    "#15", "1!", "1#",
    "#25", "1!", "1$", "b001 &",
    "#35", "1!", "0#", "0$",
    "#45", "1!", "1%",
    "#50",
  ].join("\n");

  const stRich = () => ({
    _config: {
      formalDepth: 10, maxFormalIters: 1, formalProve: false,
      _llmReplay: null,   // set per test
    },
    elicit: { modName: "fifo" },
    rtl_generate: { code: "module fifo(input logic clk); /* buggy */ endmodule" },
    spec: {
      iface: [
        { name: "clk", dir: "input", width: 1 },
        { name: "rst_n", dir: "input", width: 1 },
        { name: "wr_en", dir: "input", width: 1 },
        { name: "rd_en", dir: "input", width: 1 },
        { name: "empty", dir: "output", width: 1 },
      ],
      params: [],
    },
    formal_props: {
      properties: [
        { id: "SVA-2", code: "assert property (@(posedge clk) disable iff (!rst_n) empty |-> f_occ == 0);" },
      ],
      aux: "logic [2:0] f_occ;\nalways_ff @(posedge clk or negedge rst_n) begin\n  if (!rst_n) f_occ <= '0;\n  else f_occ <= f_occ + (wr_en) - (rd_en);\nend",
    },
  });

  it("prompt lists real property ids WITH their code, never the 'prop' fallback", async () => {
    let captured = null;
    const base = stRich();
    base._config._llmReplay = (call) => {
      captured = call.userMessage;
      return { text: JSON.stringify({ code: "module fifo(input logic clk); /* fixed */ endmodule", fixes: [{ id: "SVA-2", desc: "net-zero occupancy on simultaneous rd+wr" }] }) };
    };
    const runner = {
      sbyAvailable: () => true,
      runBmc: (() => { let n = 0; return () => (++n === 1
        ? { status: "FAIL", log: "DONE (FAIL)", cexVcd: CEX_VCD, elapsedMs: 1 }
        : { status: "PASS", log: "DONE (PASS)", cexVcd: null, elapsedMs: 1 }); })(),
    };
    const st = await formalVerifyNode(Object.assign(base, { _services: { formalRunner: runner } }));
    expect(st.formal_verify.status).toBe("PASS");
    expect(captured).toContain("SVA-2: assert property");
    expect(captured).not.toMatch(/- prop\b/);
    // The slot's properties field stays plain ids for the GUI.
    expect(st.formal_verify.properties).toEqual(["SVA-2"]);
  });

  it("cex window IN THE FIX PROMPT shows the whole short trace, prefers cause signals, drops anyseq_* noise", async () => {
    // The slot's cexWindow is null after fix→PASS (last iteration has no
    // counterexample) — the window's job is prompt evidence, so assert there.
    let captured = null;
    const base = stRich();
    base._config._llmReplay = (call) => {
      captured = call.userMessage;
      return { text: JSON.stringify({ code: "module fifo(input logic clk); /* fixed */ endmodule", fixes: [] }) };
    };
    const runner = {
      sbyAvailable: () => true,
      runBmc: (() => { let n = 0; return () => (++n === 1
        ? { status: "FAIL", log: "DONE (FAIL)", cexVcd: CEX_VCD, elapsedMs: 1 }
        : { status: "PASS", log: "DONE (PASS)", cexVcd: null, elapsedMs: 1 }); })(),
    };
    await formalVerifyNode(Object.assign(base, { _services: { formalRunner: runner } }));
    const w = captured.slice(captured.indexOf("COUNTEREXAMPLE"), captured.indexOf("SOLVER LOG"));
    expect(w).toContain("wr_en");
    expect(w).toContain("rd_en");
    expect(w).toContain("f_occ");
    expect(w).not.toContain("anyseq");
    // Whole trace: the first stimulus tick (t=5) is in the window, not just
    // the 15%-span tail around the end.
    expect(w).toMatch(/\n5 \|/);
  });

  it("the PASS-after-fix mirror carries _fixDescs for the recipe rail", async () => {
    const base = stRich();
    base._config._llmReplay = () => ({ text: JSON.stringify({ code: "module fifo(input logic clk); /* fixed */ endmodule", fixes: [{ id: "SVA-2", desc: "net-zero occupancy on simultaneous rd+wr" }] }) });
    const runner = {
      sbyAvailable: () => true,
      runBmc: (() => { let n = 0; return () => (++n === 1
        ? { status: "FAIL", log: "DONE (FAIL)", cexVcd: null, elapsedMs: 1 }
        : { status: "PASS", log: "DONE (PASS)", cexVcd: null, elapsedMs: 1 }); })(),
    };
    const st = await formalVerifyNode(Object.assign(base, { _services: { formalRunner: runner } }));
    expect(st.rtl_generate.code).toContain("/* fixed */");
    expect(st.rtl_generate._fixDescs).toEqual(["net-zero occupancy on simultaneous rd+wr"]);
  });
});

// ── Violated-assertion naming (validation replays 2-3 after the evidence fix):
// the solver log names the failing assert only as "dut.sv:<line>" — a line of
// the ASSEMBLED formal source the fix model never sees, so it could not tell
// which property broke and produced architectural rewrites that still violated
// the same assert. The prompt now quotes the failing line verbatim.
describe("violated assertion named in the fix prompt", () => {
  it("quotes the exact failing assert line from the assembled source", async () => {
    let captured = null;
    const base = {
      _config: {
        formalDepth: 10, maxFormalIters: 1, formalProve: false,
        _llmReplay: (call) => {
          captured = call.userMessage;
          return { text: JSON.stringify({ code: "module fifo(input logic clk); /* fixed */ endmodule", fixes: [] }) };
        },
      },
      elicit: { modName: "fifo" },
      rtl_generate: { code: "module fifo(input logic clk); /* buggy */ endmodule" },
      spec: {
        iface: [
          { name: "clk", dir: "input", width: 1 },
          { name: "rst_n", dir: "input", width: 1 },
          { name: "empty", dir: "output", width: 1 },
        ],
        params: [],
      },
      formal_props: {
        properties: [
          { id: "SVA-2", code: "assert property (@(posedge clk) disable iff (!rst_n) empty |-> f_occ == 0);" },
        ],
        aux: "logic [2:0] f_occ;\nalways_ff @(posedge clk or negedge rst_n) begin\n  if (!rst_n) f_occ <= '0;\n  else f_occ <= f_occ;\nend",
      },
    };
    // The mock solver derives its "failed assertion at dut.sv:<n>" line from
    // the source it is handed, exactly like sby does — self-consistent by
    // construction, so the test breaks if the source assembly reorders.
    let n = 0;
    const runner = {
      sbyAvailable: () => true,
      runBmc: (o) => {
        if (++n > 1) return { status: "PASS", log: "DONE (PASS)", cexVcd: null, elapsedMs: 1 };
        const lines = String(o.source || "").split("\n");
        const idx = lines.findIndex((l) => /assert \(f_occ == 0\)/.test(l));
        return {
          status: "FAIL",
          log: "summary:   failed assertion fifo._witness_.check at dut.sv:" + (idx + 1) + ".57 step 3\nDONE (FAIL, rc=2)",
          cexVcd: null, elapsedMs: 1,
        };
      },
    };
    const st = await formalVerifyNode(Object.assign(base, { _services: { formalRunner: runner } }));
    expect(st.formal_verify.status).toBe("PASS");
    expect(captured).toContain("VIOLATED ASSERTION");
    expect(captured).toContain("assert (f_occ == 0)");
    expect(captured).toContain("violated at step 3");
  });
});
