// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// slang enrichment merge policy (pipeline/slangEnrich.js): complete error
// lists for the fix loops, without ever becoming a new failure source.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/cli/index.js", function() {
  return { runCli: vi.fn() };
});

const { slangEnrich } = await import("../src/pipeline/slangEnrich.js");
const { runCli } = await import("../src/cli/index.js");

const CFG = { slangCmd: "python3 slang_check.py {RTL} {TB}", backendUrl: "local" };
const FILES = { "ctr.sv": "module ctr; endmodule", "ctr_tb.sv": "module ctr_tb; endmodule" };
const sidecar = (obj) => ({ stdout: JSON.stringify(obj), stderr: "", exitCode: 0 });

beforeEach(() => { runCli.mockReset(); });

describe("slangEnrich merge policy", () => {
  it("appends slang-only errors, tagged SLANG, deduped against Verilator's lines", async () => {
    runCli.mockResolvedValue(sidecar({ ok: true, errors: [
      { file: "/tmp/x/ctr_tb.sv", line: 79, col: 9, code: "DiagCode(DeclarationsAtStart)", msg: "declaration must come before all statements in the block" },
      { file: "/tmp/x/ctr_tb.sv", line: 12, col: 3, code: "DiagCode(UndeclaredIdentifier)", msg: "use of undeclared identifier 'clk'" },
    ] }));
    const existing = [{ code: "SYNTAX", file: "ctr_tb.sv", line: 79, msg: "unexpected IDENTIFIER" }];

    const extra = await slangEnrich(CFG, FILES, existing, null, null);

    expect(extra).toHaveLength(1);                     // line 79 already covered
    expect(extra[0]).toMatchObject({ code: "SLANG", file: "ctr_tb.sv", line: 12 });
    expect(extra[0].msg).toContain("undeclared identifier");
  });

  it("excludes stricter-than-Verilator codes (measured: UsedBeforeDeclared)", async () => {
    runCli.mockResolvedValue(sidecar({ ok: true, errors: [
      { file: "ctr_tb.sv", line: 11, code: "DiagCode(UsedBeforeDeclared)", msg: "identifier 'clk' used before its declaration" },
    ] }));
    expect(await slangEnrich(CFG, FILES, [], null, null)).toBeNull();
  });

  it("caps the merged extras", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ({ file: "ctr_tb.sv", line: 100 + i, code: "DiagCode(X)", msg: "e" + i }));
    runCli.mockResolvedValue(sidecar({ ok: true, errors: many }));
    const extra = await slangEnrich(CFG, FILES, [], null, null);
    expect(extra.length).toBeLessThanOrEqual(10);
  });

  it("never a failure source: no config / backend error / bad JSON / ok:false → null", async () => {
    expect(await slangEnrich({ slangCmd: "", backendUrl: "local" }, FILES, [], null, null)).toBeNull();
    expect(runCli).not.toHaveBeenCalled();

    runCli.mockResolvedValue({ _error: true, _msg: "down" });
    expect(await slangEnrich(CFG, FILES, [], null, null)).toBeNull();

    runCli.mockResolvedValue({ stdout: "not json", stderr: "", exitCode: 0 });
    expect(await slangEnrich(CFG, FILES, [], null, null)).toBeNull();

    runCli.mockResolvedValue(sidecar({ ok: false, reason: "pyslang unavailable" }));
    expect(await slangEnrich(CFG, FILES, [], null, null)).toBeNull();

    runCli.mockRejectedValue(new Error("boom"));
    expect(await slangEnrich(CFG, FILES, [], null, null)).toBeNull();
  });
});
