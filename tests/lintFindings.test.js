// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Lint findings are distilled into a clean, de-duplicated, RULE-annotated list
// before reaching the RTL/TB fixer — reusing the same distillRule table the
// `train` command harvests lint errors into (pipeline/errorsToAvoid).

import { describe, it, expect } from "vitest";
import { distillFindings, formatFindings } from "../src/prompts/lintFindings.js";
import { promptRTLFix } from "../src/prompts/lint.js";
import { distillRule } from "../src/pipeline/errorsToAvoid.js";

const RTL = `module m(input clk, input rst_n, output reg [3:0] q);
  always @(posedge clk) q = q + 1;
  logic [7:0] wide;
  assign wide = q;
endmodule`;

describe("distillFindings", () => {
  it("gives each finding a stable CODE#LINE id, the offending source line, and a fix rule", () => {
    const out = distillFindings([
      { code: "BLKSEQ", sev: "warning", line: 2, col: 27, msg: "Blocking assignment '=' in sequential logic process" },
    ], RTL);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("BLKSEQ#2");
    expect(out[0].source).toBe("always @(posedge clk) q = q + 1;");   // pulled from the actual RTL
    expect(out[0].rule).toBe(distillRule({ code: "BLKSEQ", msg: "x" }));  // same rule the train table gives
    expect(out[0].rule).toMatch(/non-blocking/i);
  });

  it("strips Verilator gutter noise (source echo, caret, doc URL, lint_off hint) from the message", () => {
    const noisy = "Signal is not used: 'wide' "
      + "3 | logic [7:0] wide; | ^~~~ "
      + "... For warning description see https://verilator.org/warn/UNUSEDSIGNAL?v=5.049 "
      + "... Use \"/* verilator lint_off UNUSEDSIGNAL */\" and lint_on around source to disable this message.";
    const out = distillFindings([{ code: "UNUSEDSIGNAL", sev: "warning", line: 3, msg: noisy }], RTL);
    expect(out[0].message).toBe("Signal is not used: 'wide'");
    expect(out[0].message).not.toMatch(/verilator\.org|lint_off|\^~~~|\| /);
    expect(out[0].rule).toMatch(/read or drive every signal/i);
  });

  it("de-duplicates repeats of the same CODE#LINE(#COL)", () => {
    const out = distillFindings([
      { code: "WIDTH", line: 4, col: 3, msg: "operand width mismatch" },
      { code: "WIDTH", line: 4, col: 3, msg: "operand width mismatch" },   // exact repeat → dropped
      { code: "WIDTH", line: 4, col: 9, msg: "operand width mismatch" },   // different col → kept
    ], RTL);
    expect(out.map((f) => f.id + "#" + f.col)).toEqual(["WIDTH#4#3", "WIDTH#4#9"]);
  });

  it("tolerates the LLM-lint shape (type/severity/message) and missing line", () => {
    const out = distillFindings([{ type: "latch", severity: "error", message: "latch inferred on q" }], RTL);
    expect(out[0].id).toBe("LATCH");            // no line → bare code
    expect(out[0].sev).toBe("error");
    expect(out[0].message).toBe("latch inferred on q");
    expect(out[0].source).toBeNull();
    expect(out[0].rule).toMatch(/every branch/i);   // LATCH rule from the shared table
  });

  it("leaves the rule null for an unknown code (no fabricated guidance)", () => {
    const out = distillFindings([{ code: "SOMENEWCODE", line: 1, msg: "mystery" }], RTL);
    expect(out[0].rule).toBeNull();
  });
});

describe("formatFindings", () => {
  it("renders id, location, message, source, and fix rows; omits absent rows", () => {
    const text = formatFindings(distillFindings([
      { code: "BLKSEQ", sev: "warning", line: 2, msg: "Blocking assignment in sequential logic" },
      { code: "SOMENEWCODE", line: 99, msg: "mystery" },   // no rule, no source (line out of range)
    ], RTL));
    expect(text).toContain("[BLKSEQ#2] WARNING BLKSEQ (line 2): Blocking assignment in sequential logic");
    expect(text).toContain("source ↳ always @(posedge clk) q = q + 1;");
    expect(text).toMatch(/fix    ↳ .*non-blocking/i);
    // the unknown finding still lists, but with no "fix ↳" row
    expect(text).toContain("[SOMENEWCODE#99]");
  });

  it("empty findings → '(none)'", () => {
    expect(formatFindings([])).toBe("(none)");
  });
});

describe("promptRTLFix wiring", () => {
  const lint = {
    errors:   [{ code: "SYNTAX", line: 2, msg: "unexpected IDENTIFIER, expecting ';'" }],
    warnings: [{ code: "WIDTH",  line: 4, msg: "operand width mismatch" }],
    log: "RAW VERILATOR LOG THAT SHOULD NOT APPEAR",
  };
  const el = { modName: "m" };

  it("embeds the stable id and the class fix rule, and no longer dumps the raw log", () => {
    const p = promptRTLFix(RTL, lint, el, null);
    expect(p.userMessage).toContain("[WIDTH#4]");
    expect(p.userMessage).toMatch(/fix    ↳ .*operand bit-widths/i);       // WIDTH rule
    expect(p.userMessage).toContain("[SYNTAX#2]");
    expect(p.userMessage).not.toContain("RAW VERILATOR LOG THAT SHOULD NOT APPEAR");
    expect(p.userMessage).not.toContain("LINT LOG (raw output");
    // count still reflected
    expect(p.userMessage).toMatch(/LINT FINDINGS TO RESOLVE \(2\)/);
  });
});
