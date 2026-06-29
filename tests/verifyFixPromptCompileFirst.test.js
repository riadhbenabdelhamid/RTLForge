// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Bug 3 (e2e convergence): when the source does not compile, the verify fix
// prompt must LEAD with the verbatim Verilator error and a MUST-FIX-FIRST
// instruction — otherwise the model chases warnings/test-logic (observed:
// verify "fixed" PROCASSINIT warnings while the prev_full syntax error sat
// untouched) and the loop never converges.

import { describe, it, expect } from "vitest";
import {
  promptTBFromVerifyFail,
  promptRTLFromVerifyFail,
} from "../src/prompts/verify.js";

const spec = { requirements: [{ id: "REQ-FUNC-001", desc: "writes", pri: "Must" }] };
const el = {};
const rtl = "module fifo_sync(input clk); endmodule";
const compileFailResult = {
  tests: [{ name: "compilation", st: "FAIL" }],
  log: "%Error: fifo_sync_tb.sv:135:15: syntax error, unexpected IDENTIFIER, expecting \"'{\"\n  135 | logic prev_full;",
};
const runtimeFailResult = {
  tests: [{ name: "REQ-FUNC-001.1", st: "FAIL" }],
  log: "[FAIL] REQ-FUNC-001.1 expected 8'h01 got 8'h00",
};

describe("promptTBFromVerifyFail — compile-first (Bug 3)", () => {
  it("leads with the compile error + MUST-FIX-FIRST when the TB does not compile", () => {
    const p = promptTBFromVerifyFail("tb", rtl, compileFailResult, spec, el, [], null);
    expect(p.userMessage).toContain("DOES NOT COMPILE");
    expect(p.userMessage).toContain("syntax error, unexpected IDENTIFIER");
    expect(p.userMessage).toContain("BEFORE any procedural");
    // The compile section comes BEFORE the normal TASK framing.
    expect(p.userMessage.indexOf("DOES NOT COMPILE")).toBeLessThan(p.userMessage.indexOf("TASK:"));
  });

  it("does NOT inject the compile section for an ordinary runtime test failure", () => {
    const p = promptTBFromVerifyFail("tb", rtl, runtimeFailResult, spec, el, [], null);
    expect(p.userMessage).not.toContain("DOES NOT COMPILE");
  });

  it("uses a carried _compileError even if the log lacks the error", () => {
    const carried = { tests: [{ name: "compilation", st: "FAIL" }], log: "", _compileError: "line 42: cannot find module foo" };
    const p = promptTBFromVerifyFail("tb", rtl, carried, spec, el, [], null);
    expect(p.userMessage).toContain("line 42: cannot find module foo");
  });
});

describe("promptRTLFromVerifyFail — compile-first (Bug 3)", () => {
  it("leads with the compile error when the RTL does not compile", () => {
    const p = promptRTLFromVerifyFail(rtl, compileFailResult, spec, el, [], null);
    expect(p.userMessage).toContain("DOES NOT COMPILE");
    expect(p.userMessage.indexOf("DOES NOT COMPILE")).toBeLessThan(p.userMessage.indexOf("TASK:"));
  });

  it("does NOT inject for an ordinary runtime failure", () => {
    const p = promptRTLFromVerifyFail(rtl, runtimeFailResult, spec, el, [], null);
    expect(p.userMessage).not.toContain("DOES NOT COMPILE");
  });
});
