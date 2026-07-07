// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Lint findings are distilled into a clean, de-duplicated, RULE-annotated list
// before reaching the RTL/TB fixer — reusing the same distillRule table the
// `train` command harvests lint errors into (pipeline/errorsToAvoid).

import { describe, it, expect } from "vitest";
import { distillFindings, formatFindings } from "../src/prompts/lintFindings.js";
import { promptRTLFix } from "../src/prompts/lint.js";
import { distillRule, errorSignature, buildRuleIndex } from "../src/pipeline/errorsToAvoid.js";

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

  it("PROCASSWIRE (measured: nemotron counter) gets the declare-as-variable rule, by code AND by message", () => {
    const byCode = distillFindings([{ code: "PROCASSWIRE", line: 4, msg: "Procedural assignment to wire, perhaps intended var: 'q'" }], RTL);
    expect(byCode[0].rule).toMatch(/output logic/);
    const byMsg = distillFindings([{ code: "LINT", line: 4, msg: "procedural assignment to a wire 'q'" }], RTL);
    expect(byMsg[0].rule).toMatch(/output logic/);
  });

  it("prefers a trained-catalog upgrade (model/curated) over the static table rule", () => {
    // A model-rewritten rule for WIDTH, keyed by the same signature the finding produces.
    const sig = errorSignature({ code: "WIDTH", msg: "operand width mismatch" });
    const idx = new Map([[sig, { rule: "SHARPENED: cast both operands to the wider type before the op." }]]);
    const out = distillFindings([{ code: "WIDTH", line: 4, msg: "operand width mismatch" }], RTL, idx);
    expect(out[0].rule).toBe("SHARPENED: cast both operands to the wider type before the op.");
    expect(out[0].rule).not.toBe(distillRule({ code: "WIDTH", msg: "x" }));   // not the table rule
  });

  it("falls back to the table rule when the index has no entry for the signature", () => {
    const idx = new Map([[errorSignature({ code: "LATCH", msg: "latch" }), { rule: "unrelated" }]]);
    const out = distillFindings([{ code: "WIDTH", line: 4, msg: "operand width mismatch" }], RTL, idx);
    expect(out[0].rule).toBe(distillRule({ code: "WIDTH", msg: "x" }));       // table default
  });

  it("gives an unknown code a LEARNED rule from the index (where the table has none)", () => {
    const sig = errorSignature({ code: "NOVELCODE", msg: "some novel diagnostic" });
    const idx = new Map([[sig, { rule: "LEARNED: do the correct thing for novel-code." }]]);
    const out = distillFindings([{ code: "NOVELCODE", line: 2, msg: "some novel diagnostic" }], RTL, idx);
    expect(out[0].rule).toBe("LEARNED: do the correct thing for novel-code.");
  });
});

describe("buildRuleIndex", () => {
  const sig = (code, msg) => errorSignature({ code, msg });

  it("indexes only model/curated upgrades (skips table-sourced and ruleless rows)", () => {
    const cfg = { errorsToAvoid: true, useShippedRules: true };
    const harvested = [
      { signature: sig("WIDTH", "w"), rule: "model rule", ruleSource: "model", domain: "rtl" },
      { signature: sig("LATCH", "l"), rule: "table rule", ruleSource: "table", domain: "rtl" },   // skipped
      { signature: sig("BLKSEQ", "b"), rule: null, ruleSource: "model", domain: "rtl" },           // skipped (no rule)
    ];
    const shipped = [{ signature: sig("PINMISSING", "p"), rule: "curated rule", ruleSource: "curated" }];
    const idx = buildRuleIndex(cfg, harvested, shipped, "rtl");
    expect(idx.get(sig("WIDTH", "w")).rule).toBe("model rule");
    expect(idx.get(sig("PINMISSING", "p")).rule).toBe("curated rule");
    expect(idx.has(sig("LATCH", "l"))).toBe(false);
    expect(idx.has(sig("BLKSEQ", "b"))).toBe(false);
  });

  it("prefers a model rule over a curated one for the same signature", () => {
    const cfg = { errorsToAvoid: true, useShippedRules: true };
    const s = sig("WIDTH", "w");
    const idx = buildRuleIndex(cfg,
      [{ signature: s, rule: "model", ruleSource: "model", domain: "rtl" }],
      [{ signature: s, rule: "curated", ruleSource: "curated" }], "rtl");
    expect(idx.get(s).rule).toBe("model");
  });

  it("excludes the harvested catalog entirely when errorsToAvoid is off (shipped still count)", () => {
    const s1 = sig("WIDTH", "w"), s2 = sig("PINMISSING", "p");
    const idx = buildRuleIndex({ errorsToAvoid: false, useShippedRules: true },
      [{ signature: s1, rule: "harvested", ruleSource: "model", domain: "rtl" }],
      [{ signature: s2, rule: "curated", ruleSource: "curated" }], "rtl");
    expect(idx.has(s1)).toBe(false);      // harvested dropped
    expect(idx.get(s2).rule).toBe("curated");
  });

  it("filters by domain (a tb-tagged rule is excluded from an rtl index; domainless passes)", () => {
    const cfg = { errorsToAvoid: true };
    const s = sig("WIDTH", "w"), sd = sig("BLKSEQ", "b");
    const idx = buildRuleIndex(cfg, [
      { signature: s,  rule: "tb rule",   ruleSource: "model", domain: "tb"  },   // excluded from rtl
      { signature: sd, rule: "rtl rule",  ruleSource: "model", domain: "rtl" },
    ], [], "rtl");
    expect(idx.has(s)).toBe(false);
    expect(idx.get(sd).rule).toBe("rtl rule");
  });

  it("respects model scoping (default: same model or unattributed only)", () => {
    const cfg = { errorsToAvoid: true, model: "A" };
    const s1 = sig("WIDTH", "w"), s2 = sig("LATCH", "l"), s3 = sig("BLKSEQ", "b");
    const idx = buildRuleIndex(cfg, [
      { signature: s1, rule: "from A",  ruleSource: "model", domain: "rtl", model: "A" },
      { signature: s2, rule: "from B",  ruleSource: "model", domain: "rtl", model: "B" },   // other model → excluded
      { signature: s3, rule: "shared",  ruleSource: "model", domain: "rtl" },               // unattributed → included
    ], [], "rtl");
    expect(idx.get(s1).rule).toBe("from A");
    expect(idx.has(s2)).toBe(false);
    expect(idx.get(s3).rule).toBe("shared");
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

  it("honors a trained-rule index passed by the node (6th arg) over the static table", () => {
    const idx = new Map([
      [errorSignature({ code: "WIDTH", msg: "operand width mismatch" }), { rule: "TRAINED-WIDTH-RULE-xyz" }],
    ]);
    const p = promptRTLFix(RTL, lint, el, null, null, idx);
    expect(p.userMessage).toContain("TRAINED-WIDTH-RULE-xyz");           // model/curated upgrade used
    expect(p.userMessage).not.toMatch(/fix    ↳ Match operand bit-widths/); // table rule replaced
  });
});
