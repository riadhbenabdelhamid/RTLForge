// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
vi.mock("../src/cli/index.js", async () => ({ ...await vi.importActual("../src/cli/index.js"), runCli: vi.fn() }));
import { runCli } from "../src/cli/index.js";
import { createReviewAcceptance } from "../src/pipeline/reviewAcceptance.js";
import { rtlReviewNode } from "../src/pipeline/nodes/rtl_review.js";
import { buildSourceContract, unsupportedBehaviorCitations } from "../src/pipeline/sourceContract.js";
import { assembleFormalProperties, qualifyFormalExamples } from "../src/pipeline/formalQualification.js";
import { formalPropsNode } from "../src/pipeline/nodes/formal_props.js";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";
import { checkFormalSyntax } from "../src/cli/formalRunner.js";
import { promptFormalProps } from "../src/prompts/formalProps.js";

const good = "module copy_word(input [2:0] d, output [2:0] q); assign q=d; endmodule";
const bad = good.replace("q=d", "q=d ^ 3'b010");
function state() { return {
  _userDesc: "d q\n3'b001 3'b001\n3'b110 3'b110",
  spec: { modName: "copy_word", iface: [{ name: "d", dir: "input", width: 3 }, { name: "q", dir: "output", width: 3 }], params: [], requirements: [] },
  elicit: { modName: "copy_word" }, architect: {}, rtl_generate: { code: good, _standaloneCandidate: { code: good } },
  _config: { backendUrl: "local", simCmds: "iverilog -g2012 -s copy_word_tb -o sim {RTL} {TB}\nvvp sim", maxRtlReviewIters: 4 },
}; }
beforeEach(() => { runCli.mockReset(); runCli.mockImplementation(async (_, request) => {
  const dir = mkdtempSync(join(tmpdir(), "review-acceptance-"));
  try {
    for (const [name, code] of Object.entries(request.files)) writeFileSync(join(dir, name), code);
    try { return { exitCode: 0, stdout: execFileSync("bash", ["-c", request.command], { cwd: dir, timeout: 10000, encoding: "utf8", stdio: "pipe" }), stderr: "" }; }
    catch (e) { return { exitCode: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}); });

describe("pre-review candidate protection", () => {
  it("requires a strict improvement under identical source checks", async () => {
    const st = state(), guard = createReviewAcceptance(st, good);
    expect((await guard.compare(bad, good)).reason).toBe("PASSED_CHECK_REGRESSION");
    expect((await guard.compare(good + "\n// formatting", good)).reason).toBe("TIE");
    expect((await guard.compare(good, bad)).adopted).toBe(true);
  });
  it("freezes the suite before stage slots can change", async () => {
    const st = state(), guard = createReviewAcceptance(st, good);
    st._userDesc = "d q\n3'b001 3'b011";
    st.spec.iface = [];
    expect((await guard.compare(bad, good)).adopted).toBe(false);
  });
  it("rejects incomplete and unavailable execution evidence", async () => {
    runCli.mockResolvedValue({ exitCode: 0, stdout: "[PASS] SOURCE.T1.L2.q", stderr: "" });
    expect((await createReviewAcceptance(state(), good).compare(bad, good)).reason).toBe("INCUMBENT_UNVERIFIED");
    runCli.mockResolvedValue({ _error: true, _msg: "offline" });
    expect((await createReviewAcceptance(state(), good).compare(bad, good)).adopted).toBe(false);
  });
  it("retains incoming RTL and metadata when a review proposes a timing change without qualified evidence", async () => {
    const st = state(); st._userDesc = "Unspecified behavior.";
    let calls = 0;
    st._config._llmReplay = () => ({ text: JSON.stringify(++calls === 1
      ? { verdict: "NEEDS_FIX", score: 30, issues: [{ severity: "critical", description: "Delay completion" }] }
      : { code: bad, fixes: [{ desc: "Delay completion" }] }) });
    st._config.backendUrl = "";
    const out = await rtlReviewNode(st);
    expect(calls).toBe(2);
    expect(out.rtl_generate.code).toBe(good);
    expect(out.rtl_generate._standaloneCandidate).toEqual(st.rtl_generate._standaloneCandidate);
    expect(out.rtl_generate._preReviewCandidate.code).toBe(good);
    expect(out.rtl_review._acceptance.decisions[0].reason).toBe("CHECKER_UNQUALIFIED");
  });
});

describe("source conventions and assumption provenance", () => {
  it("resolves aliases and bare numerals only from explicit source declarations", () => {
    const st = state();
    const source = "Signal alias: value = d.\nColumn value is hexadecimal.\nColumn q is hexadecimal.\nvalue q\n6 6\n1 1";
    const contract = buildSourceContract(source, st.spec, "copy_word");
    expect(contract.status).toBe("READY");
    expect(contract.conventions).toHaveLength(3);
    expect(contract.tables[0].raw).toContain("value q");
    expect(buildSourceContract(source.replace("Signal alias: value = d.\n", ""), st.spec, "copy_word").status).toBe("UNRESOLVED");
    expect(buildSourceContract(source + "\nSignal alias: value = q.", st.spec, "copy_word").status).toBe("UNRESOLVED");
  });
  it("does not promote skipped behavioral questions into verified requirements", () => {
    const req = { id: "REQ-FUNC-002", src: "", rat: "[default — question skipped]" };
    expect(unsupportedBehaviorCitations("", { requirements: [req] })).toHaveLength(1);
    expect(unsupportedBehaviorCitations("", { requirements: [{ ...req, id: "REQ-INTF-001", cat: "Interface" }] })).toEqual([]);
  });
});

describe("property qualification", () => {
  it("compares property expectations with source output witnesses, independent of the RTL", async () => {
    const st = state(), contract = buildSourceContract(st._userDesc, st.spec, "copy_word");
    for (const [expr, status] of [["q == d", "PASS"], ["q == (d ^ 3'b010)", "UNVERIFIED"]]) {
      const assembled = assembleFormalProperties({ properties: [{ id: "P-COPY", code: "assert (" + expr + ");" }] }, st.spec, "copy_word", bad);
      const qualified = await qualifyFormalExamples(st, contract, assembled);
      expect(qualified.status, JSON.stringify(qualified)).toBe(status);
    }
  });
  it("detects shifted temporal obligations against post-edge source observations", async () => {
    const st = state();
    st.spec.iface = ["clk", "rst", "d", "q"].map(name => ({ name, width: 1, dir: name === "q" ? "output" : "input" }));
    st._userDesc = "time clk rst d q\n0ns 0 1 0 0\n5ns 1 1 0 0\n10ns 0 1 0 0\n12ns 0 0 1 0\n15ns 1 0 1 1\n20ns 0 0 1 1\n22ns 0 0 0 1\n25ns 1 0 0 0\n30ns 0 0 0 0\n32ns 0 0 1 0\n35ns 1 0 1 1\n40ns 0 0 1 1\n45ns 1 0 1 1";
    const contract = buildSourceContract(st._userDesc, st.spec, "copy_word");
    expect(contract.status).toBe("READY");
    for (const [operator, expected] of [["|=>", "PASS"], ["|->", "UNVERIFIED"]]) {
      const props = { properties: [{ id: "P-DELAY", code: "assert property (@(posedge clk) disable iff (rst) d " + operator + " q);" }] };
      const assembled = assembleFormalProperties(props, st.spec, "copy_word", good);
      const result = await qualifyFormalExamples(st, contract, assembled);
      expect(result.status, JSON.stringify(result)).toBe(expected);
    }
  });
  it("withholds the implementation body from functional property generation", () => {
    const st = state(), p = promptFormalProps(bad, st.spec, st.elicit, [], []);
    expect(p.userMessage).not.toContain("assign q=");
    expect(p.userMessage).toContain("input [2:0] d");
  });
  it("repairs invalid Boolean implication in properties once and compile-checks the result", async () => {
    const st = state(); let calls = 0;
    st._config._llmReplay = () => ({ text: JSON.stringify({ properties: [{ id: "P-COPY", code: ++calls === 1 ? "assert ((d == 0) -> (q == 0));" : "assert (!(d == 0) || (q == 0));" }] }) });
    const out = await formalPropsNode(st);
    expect(calls).toBe(2);
    expect(out.formal_props._syntaxQualification.status).toBe("PASS");
    expect(out.formal_props._syntaxQualification.attempts).toHaveLength(2);
    expect(out.rtl_generate).toBeUndefined();
  });
  it("does not enter the solver or repair RTL after checker compilation failure", async () => {
    const st = state(), runBmc = vi.fn();
    st.formal_props = { properties: [{ id: "P-COPY", code: "assert (q == d);" }] };
    st._services = { formalRunner: { sbyAvailable: () => true, runBmc, checkFormalSyntax: async () => ({ status: "TOOL_ERROR", log: "syntax error" }) } };
    const out = await formalVerifyNode(st);
    expect(out.formal_verify.status).toBe("SKIPPED");
    expect(runBmc).not.toHaveBeenCalled();
    expect(out.rtl_generate).toBeUndefined();
  });
  it("the actual compiler rejects invalid immediate implication", async () => {
    expect((await checkFormalSyntax({ top: "m", source: "module m(input a,b); always @* assert(a -> b); endmodule" })).status).toBe("TOOL_ERROR");
    expect((await checkFormalSyntax({ top: "m", source: "module m(input a,b); always @* assert(!a || b); endmodule" })).status).toBe("PASS");
  });
});
