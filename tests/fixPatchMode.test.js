// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Patch-mode fixes + tiered convergence (docs/improvement-roadmap.md #2).

import { describe, it, expect } from "vitest";
import { applyEdits } from "../src/pipeline/applyEdits.js";
import { lintConverged, splitWarnings, lintStatusOf } from "../src/pipeline/fixLoopHelpers.js";
import { repairSV } from "../src/pipeline/syntaxRepair.js";
import { patchModeFixPrompt, promptRTLFix, promptTBLintFix } from "../src/prompts/lint.js";
import { promptRTLFromVerifyFail, promptTBFromVerifyFail } from "../src/prompts/verify.js";
import { PATCH_SCHEMA } from "../src/prompts/schemas.js";

describe("applyEdits (fail-closed exact-match patcher)", () => {
  const code = "module m;\n  logic a;\n  assign a = 1;\nendmodule";

  it("applies a unique exact-match edit", () => {
    const r = applyEdits(code, [{ find: "assign a = 1;", replace: "assign a = 0;" }]);
    expect(r.ok).toBe(true);
    expect(r.code).toContain("assign a = 0;");
    expect(r.applied).toBe(1);
  });
  it("applies several edits in order, later edits seeing earlier results", () => {
    const r = applyEdits(code, [
      { find: "logic a;", replace: "logic a, b;" },
      { find: "assign a = 1;", replace: "assign a = 1;\n  assign b = 0;" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(2);
  });
  it("fails closed: not-found edit applies NOTHING", () => {
    const r = applyEdits(code, [
      { find: "assign a = 1;", replace: "assign a = 0;" },
      { find: "does not exist", replace: "x" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);                       // untouched
    expect(r.failReason).toMatch(/not found/);
  });
  it("fails closed on a non-unique match", () => {
    const dup = "x = 1;\nx = 1;\n";
    const r = applyEdits(dup, [{ find: "x = 1;", replace: "x = 2;" }]);
    expect(r.ok).toBe(false);
    expect(r.failReason).toMatch(/more than once/);
  });
  it("rejects empty/malformed edit lists and identical results", () => {
    expect(applyEdits(code, []).ok).toBe(false);
    expect(applyEdits(code, null).ok).toBe(false);
    expect(applyEdits(code, [{ find: "logic a;", replace: "logic a;" }]).failReason).toMatch(/identical/);
    expect(applyEdits(code, [{ find: "", replace: "x" }]).failReason).toMatch(/malformed/);
  });
});

describe("lintConverged (tiered exit)", () => {
  it("errors keep the loop going; clean converges", () => {
    expect(lintConverged({ errors: [{}], warnings: [], status: "FAIL" }, false)).toBe(false);
    expect(lintConverged({ errors: [], warnings: [], status: "PASS" }, false)).toBe(true);
  });
  it("0 errors + warnings converges (the measured -Wall exit-code trap)…", () => {
    expect(lintConverged({ errors: [], warnings: [{}, {}], status: "FAIL" }, false)).toBe(true);
  });
  it("…unless lintWarningsAsErrors opts into strict", () => {
    expect(lintConverged({ errors: [], warnings: [{}], status: "FAIL" }, true)).toBe(false);
  });
  it("a FAIL with NOTHING parsed is an unparsed diagnostic — never clean", () => {
    expect(lintConverged({ errors: [], warnings: [], status: "FAIL" }, false)).toBe(false);
  });
});

describe("patchModeFixPrompt", () => {
  const lint = { errors: [{ code: "X", msg: "y" }], warnings: [] };
  const spec = { iface: { ports: [] }, params: {}, requirements: [] };

  it("rewrites the RTL fix prompt to the edits shape and flags _patchMode", () => {
    const p = patchModeFixPrompt(promptRTLFix("module m; endmodule", lint, { modName: "m" }, [], null));
    expect(p._patchMode).toBe(true);
    expect(p.systemPrompt).toMatch(/"edits"/);
    expect(p.systemPrompt).not.toMatch(/"code":"<fixed SystemVerilog source>"/);
    expect(p.userMessage).toMatch(/Return \{"edits"/);
  });
  it("rewrites the TB fix prompt too", () => {
    const p = patchModeFixPrompt(promptTBLintFix("module tb; endmodule", "module m; endmodule", lint, spec, { modName: "m" }, [], null));
    expect(p._patchMode).toBe(true);
    expect(p.systemPrompt).toMatch(/"edits"/);
  });
  it("unknown prompt shapes pass through untouched (fail-open to full-file)", () => {
    const p = patchModeFixPrompt({ systemPrompt: "something else", userMessage: "x" });
    expect(p._patchMode).toBeUndefined();
    expect(p.systemPrompt).toBe("something else");
  });
  it("PATCH_SCHEMA requires edits with find/replace", () => {
    expect(PATCH_SCHEMA.schema.required).toEqual(["edits"]);
    expect(PATCH_SCHEMA.schema.properties.edits.items.required).toEqual(["find", "replace"]);
  });

  // Run 28 extension: the VERIFY fix loop's full-file rewrites are where
  // drive-by regressions ride in (the judge-loop TB rewrite added an
  // unrequested ref_dout staging flop). Patch mode must cover those prompts.
  it("rewrites the verify RTL-fix prompt (promptRTLFromVerifyFail)", () => {
    const vr = { pass: 1, total: 3, tests: [{ name: "t1", st: "FAIL" }] };
    const p = patchModeFixPrompt(promptRTLFromVerifyFail("module m; endmodule", vr, spec, {}, [], null));
    expect(p._patchMode).toBe(true);
    expect(p.systemPrompt).toMatch(/"edits"/);
    expect(p.systemPrompt).not.toMatch(/"code":"<fixed SystemVerilog>"/);
    expect(p.userMessage).toMatch(/Return \{"edits"/);
  });
  it("rewrites the verify TB-fix prompt (promptTBFromVerifyFail)", () => {
    const vr = { pass: 1, total: 3, tests: [{ name: "t1", st: "FAIL" }] };
    const p = patchModeFixPrompt(promptTBFromVerifyFail("module tb; endmodule", "module m; endmodule", vr, spec, {}, [], null));
    expect(p._patchMode).toBe(true);
    expect(p.systemPrompt).toMatch(/"edits"/);
    expect(p.systemPrompt).not.toMatch(/"code":"<fixed testbench>"/);
    expect(p.userMessage).toMatch(/Return \{"edits"/);
  });
});

describe("two-tier warning policy (runs 33/34/35)", () => {
  const w = (code) => ({ code, sev: "warning", msg: code + " thing" });

  it("hygiene-only warnings no longer gate under warnings-as-errors", () => {
    expect(lintConverged({ errors: [], warnings: [w("UNUSEDPARAM"), w("WIDTHEXPAND"), w("DECLFILENAME")] }, true)).toBe(true);
  });
  it("bug-hiding warnings still gate", () => {
    for (const code of ["LATCH", "WIDTHTRUNC", "CASEINCOMPLETE", "BLKSEQ", "MULTIDRIVEN", "IMPLICITSTATIC"]) {
      expect(lintConverged({ errors: [], warnings: [w(code)] }, true)).toBe(false);
    }
  });
  it("DEFPARAM gates explicitly — a silently-failed override tests the wrong design (run 34)", () => {
    expect(lintConverged({ errors: [], warnings: [w("DEFPARAM")] }, true)).toBe(false);
    expect(splitWarnings([w("DEFPARAM")]).semantic.map((x) => x.code)).toEqual(["DEFPARAM"]);
  });
  it("unclassified codes fail closed (new Verilator warnings gate until triaged)", () => {
    expect(lintConverged({ errors: [], warnings: [w("SOMENEWCODE")] }, true)).toBe(false);
  });
  it("errors always gate, and warnings-as-errors OFF keeps the old behaviour", () => {
    expect(lintConverged({ errors: [{ code: "SYNTAX" }], warnings: [] }, true)).toBe(false);
    expect(lintConverged({ errors: [], warnings: [w("LATCH")] }, false)).toBe(true);
  });
  it("splitWarnings partitions by class", () => {
    const s = splitWarnings([w("UNUSEDPARAM"), w("LATCH"), w("EOFNEWLINE")]);
    expect(s.hygiene.map((x) => x.code)).toEqual(["UNUSEDPARAM", "EOFNEWLINE"]);
    expect(s.semantic.map((x) => x.code)).toEqual(["LATCH"]);
  });
});

describe("unused-localparam repair (run 35)", () => {
  it("deletes a localparam mentioned only by its own declaration", () => {
    const r = repairSV("module tb;\n  localparam int MAX_CYCLES = 100;\n  localparam int USED = 4;\n  initial $display(USED);\nendmodule");
    expect(r.code).not.toContain("MAX_CYCLES");
    expect(r.code).toContain("localparam int USED");
    expect(r.total).toBeGreaterThan(0);
  });
  it("never touches `parameter` (an externally overridable knob)", () => {
    const src = "module m #(parameter int W = 8) ();\nendmodule";
    expect(repairSV(src).code).toContain("parameter int W = 8");
  });
  it("keeps a localparam referenced only inside a comment-free expression, and is idempotent", () => {
    const src = "module m;\n  localparam int N = 4;\n  logic [N-1:0] bus;\nendmodule";
    const r = repairSV(src);
    expect(r.code).toContain("localparam int N = 4");
    expect(repairSV(r.code).code).toBe(r.code);
  });
});

describe("lintStatusOf — one policy for stage status too (run 36)", () => {
  const w = (code) => ({ code, sev: "warning" });
  it("hygiene-only stamps PASS (run 36 stamped FAIL from a third inline copy)", () => {
    expect(lintStatusOf({ errors: [], warnings: [w("WIDTHEXPAND"), w("WIDTHEXPAND")] }, true)).toBe("PASS");
  });
  it("semantic warnings and errors stamp FAIL", () => {
    expect(lintStatusOf({ errors: [], warnings: [w("LATCH")] }, true)).toBe("FAIL");
    expect(lintStatusOf({ errors: [{ code: "SYNTAX" }], warnings: [] }, true)).toBe("FAIL");
  });
  it("agrees with lintConverged on every input (single source of truth)", () => {
    const cases = [
      { errors: [], warnings: [] },
      { errors: [], warnings: [w("UNUSEDPARAM")] },
      { errors: [], warnings: [w("DEFPARAM")] },
      { errors: [{ code: "X" }], warnings: [] },
    ];
    for (const c of cases) {
      expect(lintStatusOf(c, true) === "PASS").toBe(lintConverged(c, true));
    }
  });
});
