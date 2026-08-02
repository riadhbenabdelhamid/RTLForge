// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Bug 2 (e2e convergence): when lint_test ends with the TB still not compiling,
// it must extract the hard compile/syntax error so it can be carried forward to
// verify (instead of letting a broken TB through silently and making verify
// re-discover it via an LLM triage call). extractCompileError is that detector.

import { describe, it, expect } from "vitest";
import { extractCompileError } from "../src/pipeline/nodes/lint_test.js";

describe("extractCompileError (Bug 2 compile gate)", () => {
  it("detects a SYNTAX-coded Verilator error (the fifo_sync case)", () => {
    const errs = [{ code: "SYNTAX", sev: "error", line: 135,
      msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\"" }];
    const tail = extractCompileError(errs);
    expect(tail).toContain("line 135");
    expect(tail).toContain("syntax error");
  });

  it("detects by message even when the code is empty/unknown", () => {
    expect(extractCompileError([{ code: "", line: 12, msg: "Cannot find file foo.sv" }])).toContain("line 12");
    expect(extractCompileError([{ line: 4, msg: "Exiting due to 1 error(s)" }])).toContain("line 4");
  });

  it("returns null when there are no hard compile errors", () => {
    expect(extractCompileError([])).toBe(null);
    expect(extractCompileError(null)).toBe(null);
    // A lint error that is NOT a compile blocker (e.g. WIDTH-as-error) is ignored.
    expect(extractCompileError([{ code: "WIDTH", sev: "error", line: 9, msg: "Operator width mismatch" }])).toBe(null);
    // Warnings never block compilation.
    expect(extractCompileError([{ code: "UNUSEDSIGNAL", sev: "warning", line: 3, msg: "Signal unused" }])).toBe(null);
  });

  it("caps the tail at 3 errors and truncates long messages", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ code: "SYNTAX", line: i, msg: "x".repeat(300) }));
    const tail = extractCompileError(many);
    expect(tail.split("\n")).toHaveLength(3);
    // 160-char message cap + "line N: " prefix
    expect(tail.split("\n")[0].length).toBeLessThan(180);
  });
});

// Runs 38/41: the RTL's own SEMANTIC warnings (MULTIDRIVEN, WIDTHTRUNC) gate
// lint_test under warnings-as-errors, and the TB fix loop burned cycles on
// diagnostics no TB edit can clear. Same principle as the run-21 RTL-errors
// short-circuit, one tier down.
describe("RTL-owned semantic warnings short-circuit the TB fix loop (runs 38/41)", () => {
  it("splitWarnings + file attribution express the firing condition", async () => {
    const { splitWarnings } = await import("../src/pipeline/fixLoopHelpers.js");
    const w = (code, file) => ({ code, sev: "warning", file, msg: code });
    // the run-38 shape: errors 0, all semantic warnings name the RTL
    const warns = [w("MULTIDRIVEN", "m.sv"), w("MULTIDRIVEN", "m.sv"), w("UNUSEDSIGNAL", "m_tb.sv")];
    const sem = splitWarnings(warns).semantic;
    expect(sem.length).toBe(2);
    expect(sem.every((x) => x.file === "m.sv")).toBe(true);      // → short-circuit fires
    // one TB-attributed semantic warning keeps the loop
    const mixed = splitWarnings(warns.concat([w("PROCASSINIT", "m_tb.sv")])).semantic;
    expect(mixed.every((x) => x.file === "m.sv")).toBe(false);   // → loop keeps running
  });
});
