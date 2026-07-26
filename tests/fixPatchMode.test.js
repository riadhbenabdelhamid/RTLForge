// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Patch-mode fixes + tiered convergence (docs/improvement-roadmap.md #2).

import { describe, it, expect } from "vitest";
import { applyEdits } from "../src/pipeline/applyEdits.js";
import { lintConverged } from "../src/pipeline/fixLoopHelpers.js";
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
