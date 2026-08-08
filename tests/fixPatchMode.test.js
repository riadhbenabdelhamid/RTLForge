// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Patch-mode fixes + tiered convergence (docs/improvement-roadmap.md #2).

import { describe, it, expect } from "vitest";
import { applyEdits } from "../src/pipeline/applyEdits.js";
import { lintConverged, splitWarnings, lintStatusOf, lastFixWasNoOp, reviewFixRegressed, lintAdoptionRegression, headerlessReplacement, detectTbInfraLoss, formalEvidenceOf, portsClauseOf, moduleParagraphOf, systemModuleDesc, specFidelityViolations, detectMalformedSpec} from "../src/pipeline/fixLoopHelpers.js";
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
  it("IMPORTSTAR does not gate — every module in a system run imports the package (run 49)", () => {
    // Measured: rr_arbiter failed BOTH lint stages with 0 errors, burned all
    // three maxLintIters, and shipped with the import untouched. Unclassified,
    // it fell to the fail-closed default and made the lint verdict carry no
    // information for any module in any system run.
    expect(lintConverged({ errors: [], warnings: [w("IMPORTSTAR")] }, true)).toBe(true);
    expect(lintStatusOf({ errors: [], warnings: [w("IMPORTSTAR")] }, true)).toBe("PASS");
    expect(splitWarnings([w("IMPORTSTAR")]).hygiene.map((x) => x.code)).toEqual(["IMPORTSTAR"]);
  });
  it("IMPORTSTAR alongside a real semantic warning still gates", () => {
    expect(lintConverged({ errors: [], warnings: [w("IMPORTSTAR"), w("LATCH")] }, true)).toBe(false);
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

// ═══════════════════════════════════════════════════════════════════════════
// No-op fix iteration (run 37). RTL Review spent 36 minutes on 3 iterations
// scoring 68 → 60 → 60; iteration 3's beforeCode and afterCode were
// byte-identical, so it re-reviewed unchanged code for the verdict it already
// had. At devstral's ~3-4 output tokens/sec that pair of calls is ~9.5 min.
// ═══════════════════════════════════════════════════════════════════════════
describe("lastFixWasNoOp (run 37 thrash stop)", () => {
  const entry = (kind, before, after) => ({
    iter: 1, _structured: { kind: kind, beforeCode: before, afterCode: after },
  });

  it("a fix that returned byte-identical code is a no-op", () => {
    expect(lastFixWasNoOp([entry("review_fix_via_chain", "module m; endmodule", "module m; endmodule")])).toBe(true);
  });

  // Run 39 made the distinction matter. `beforeCode === afterCode` covers TWO
  // opposite situations: the model returned what it was given (a real no-op),
  // or it returned something WORSE that a gate kept out. Only the first makes
  // another attempt pointless — a rejection is exactly what the next iteration's
  // forward candidate is meant to converge from, so ending the loop there throws
  // away a retry the cap had budgeted.
  it("a REJECTED candidate is NOT a no-op — the loop must retry", () => {
    const rejected = (why) => ({ iter: 2, _structured: {
      kind: "review_fix_via_chain", beforeCode: "same", afterCode: "same",
      fixOutcome: "rejected:" + why } });
    for (const why of ["errors", "semantic", "regression", "infra", "unknown"]) {
      expect(lastFixWasNoOp([rejected(why)])).toBe(false);
    }
  });

  it("fixOutcome 'identical' IS a no-op even with the codes recorded", () => {
    expect(lastFixWasNoOp([{ iter: 2, _structured: {
      kind: "review_fix_via_chain", beforeCode: "same", afterCode: "same",
      fixOutcome: "identical" } }])).toBe(true);
  });

  it("fixOutcome wins over the code comparison in both directions", () => {
    // adopted (codes differ) is never a no-op…
    expect(lastFixWasNoOp([{ iter: 2, _structured: {
      kind: "review_fix_via_chain", beforeCode: "a", afterCode: "b",
      fixOutcome: "adopted" } }])).toBe(false);
    // …and an absent outcome falls back to the old comparison (old checkpoints)
    expect(lastFixWasNoOp([entry("review_fix_via_chain", "same", "same")])).toBe(true);
  });

  it("a fix that changed the code is NOT a no-op", () => {
    expect(lastFixWasNoOp([entry("review_fix_via_chain", "module m; endmodule", "module m; logic a; endmodule")])).toBe(false);
  });

  // THE TRAP: initial_review records beforeCode === afterCode by construction
  // (it reviews without fixing). Counting it would break the loop at iter 1
  // and disable every review fix loop in the pipeline.
  it("initial_review is NEVER a no-op, though its code is unchanged by construction", () => {
    expect(lastFixWasNoOp([entry("initial_review", "module m; endmodule", "module m; endmodule")])).toBe(false);
  });

  it("only the LAST entry decides — an earlier no-op does not stop a productive loop", () => {
    expect(lastFixWasNoOp([
      entry("review_fix_via_chain", "a", "a"),
      entry("review_fix_via_chain", "a", "b"),
    ])).toBe(false);
  });

  it("run 37's actual ledger: iter 3 was the no-op, iter 2 was not", () => {
    const iter2 = entry("review_fix_via_chain", "x".repeat(2742), "y".repeat(2777));
    const iter3 = entry("review_fix_via_chain", "y".repeat(2777), "y".repeat(2777));
    expect(lastFixWasNoOp([entry("initial_review", "x".repeat(2742), "x".repeat(2742)), iter2])).toBe(false);
    expect(lastFixWasNoOp([iter2, iter3])).toBe(true);
  });

  it("covers the reask kind too, and tolerates junk ledgers", () => {
    expect(lastFixWasNoOp([entry("review_fix_reask", "a", "a")])).toBe(true);
    expect(lastFixWasNoOp([])).toBe(false);
    expect(lastFixWasNoOp(null)).toBe(false);
    expect(lastFixWasNoOp([{ iter: 1 }])).toBe(false);
    expect(lastFixWasNoOp([entry("review_fix_via_chain", "", "")])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Review-score regression (measured across runs 20-37). The review fix loops
// were the only ones with no monotonicity rule on their own headline metric.
// The ledger holds five regressions, and two of them REDUCED the issue count —
// so the gate needs both signals to agree before it discards a fix.
// ═══════════════════════════════════════════════════════════════════════════
describe("reviewFixRegressed (two-signal gate)", () => {
  const R = (score, crit, major, minor) => ({
    score: score,
    issues: [].concat(
      Array.from({ length: crit || 0 }, () => ({ severity: "critical" })),
      Array.from({ length: major || 0 }, () => ({ severity: "major" })),
      Array.from({ length: minor || 0 }, () => ({ severity: "minor" })),
    ),
  });

  it("run 37 test_review 59/6 → 16/11: rejected (the campaign's worst regression)", () => {
    expect(reviewFixRegressed(R(59, 3, 3), R(16, 6, 5))).toBe(true);
  });

  it("run 28 test_review 75/5 → 60/6: rejected (this one SHIPPED)", () => {
    expect(reviewFixRegressed(R(75, 2, 3), R(60, 3, 3))).toBe(true);
  });

  it("run 36 rtl_review 47/8 → 45/12: rejected on a -2 score because issues rose", () => {
    expect(reviewFixRegressed(R(47, 4, 4), R(45, 6, 6))).toBe(true);
  });

  // The two the gate must NOT touch: score noise against a real issue reduction.
  it("run 36 test_review 58/27 → 55/25: ADOPTED — fewer issues outweighs -3 score", () => {
    expect(reviewFixRegressed(R(58, 13, 14), R(55, 12, 13))).toBe(false);
  });

  it("run 37 rtl_review 68/8 → 60/7: ADOPTED — an issue was removed", () => {
    expect(reviewFixRegressed(R(68, 4, 4), R(60, 4, 3))).toBe(false);
  });

  it("an improving score is never a regression, whatever the issues do", () => {
    expect(reviewFixRegressed(R(45, 4, 4), R(100, 4, 4))).toBe(false);
    expect(reviewFixRegressed(R(45, 1, 1), R(46, 9, 9))).toBe(false);
  });

  it("equal scores are not a regression (no churn on a tie)", () => {
    expect(reviewFixRegressed(R(60, 3, 3), R(60, 3, 3))).toBe(false);
  });

  it("counts critical+major, not minors — polish churn cannot trigger it", () => {
    // score down, crit/major identical, minors reduced → still a regression
    expect(reviewFixRegressed(R(70, 2, 2, 9), R(60, 2, 2, 0))).toBe(true);
  });

  it("falls back to the total when no severities are present anywhere", () => {
    const bare = (score, n) => ({ score: score, issues: Array.from({ length: n }, () => ({})) });
    expect(reviewFixRegressed(bare(70, 3), bare(60, 5))).toBe(true);
    expect(reviewFixRegressed(bare(70, 5), bare(60, 3))).toBe(false);
  });

  it("a missing or non-numeric score reports NO regression (existing gates govern)", () => {
    expect(reviewFixRegressed({ issues: [] }, R(10, 5, 5))).toBe(false);
    expect(reviewFixRegressed(R(90, 0, 0), { issues: [] })).toBe(false);
    expect(reviewFixRegressed(R(90, 0, 0), { score: "bad", issues: [] })).toBe(false);
    expect(reviewFixRegressed(null, null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared lint-adoption predicate (run 39). test_review adopted a headerless
// TB candidate carrying 7 compile errors — it had only the infra-loss check,
// while rtl_review has had a lint gate since run 7. Both nodes now route
// through this one predicate.
// ═══════════════════════════════════════════════════════════════════════════
describe("lintAdoptionRegression (one predicate, two review nodes)", () => {
  it("the run-39 shape: 7 errors vs 1 → 'errors'", () => {
    expect(lintAdoptionRegression({ errors: 7, semantic: 0 }, { errors: 1, semantic: 0 })).toBe("errors");
  });
  it("the run-38 shape: semantic warnings rose under equal errors → 'semantic'", () => {
    expect(lintAdoptionRegression({ errors: 0, semantic: 7 }, { errors: 0, semantic: 5 })).toBe("semantic");
  });
  it("equal or improving counts adopt", () => {
    expect(lintAdoptionRegression({ errors: 1, semantic: 2 }, { errors: 1, semantic: 2 })).toBe(null);
    expect(lintAdoptionRegression({ errors: 0, semantic: 1 }, { errors: 3, semantic: 4 })).toBe(null);
  });
  it("errors outrank semantic: fewer warnings never excuse more errors", () => {
    expect(lintAdoptionRegression({ errors: 2, semantic: 0 }, { errors: 1, semantic: 9 })).toBe("errors");
  });
  it("a missing side abstains (no CLI, no baseline) — adopt as before", () => {
    expect(lintAdoptionRegression(null, { errors: 0, semantic: 0 })).toBe(null);
    expect(lintAdoptionRegression({ errors: 9, semantic: 9 }, null)).toBe(null);
  });
});

describe("headerlessReplacement + detectTbInfraLoss header floor (runs 30/39)", () => {
  const HEADERED = "`timescale 1ns/1ps\nmodule m_tb;\n  task automatic check(input bit c, input string l); endtask\n  task automatic step(input int n = 1); endtask\n  int ref_x;\nendmodule";
  const HEADCUT = HEADERED.split("\n").slice(2).join("\n");

  it("flags headered → headerless; nothing else", () => {
    expect(headerlessReplacement(HEADERED, HEADCUT)).toBe(true);
    expect(headerlessReplacement(HEADERED, HEADERED)).toBe(false);
    expect(headerlessReplacement(HEADCUT, HEADCUT)).toBe(false);   // was already headerless
    expect(headerlessReplacement("", HEADCUT)).toBe(false);        // cold gen
    expect(headerlessReplacement(HEADERED, "")).toBe(false);       // empty ≠ headerless rewrite
  });

  it("detectTbInfraLoss rejects a head-cut even when the infra below survives", () => {
    expect(detectTbInfraLoss(HEADERED, HEADCUT)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Formal counterexample evidence (run 40). The judge loop held a
// counterexample naming dut.sv:266 step 2 and NONE of its fix prompts
// mentioned it — while the LLM triage sent the fix to test_generate with an
// RTL defect proven. formalEvidenceOf is the routing predicate.
// ═══════════════════════════════════════════════════════════════════════════
describe("formalEvidenceOf (run 40)", () => {
  it("carries the violated assertion for a real FAIL", () => {
    const e = formalEvidenceOf({ formal_verify: {
      status: "FAIL", depth: 20, cexWindow: "cyc0: done=1",
      violated: "assert property (@(posedge clk) $rose(done) |=> !done);   // violated at step 2",
    } });
    expect(e.violated).toContain("violated at step 2");
    expect(e.depth).toBe(20);
  });
  it("null for PASS, SKIPPED, TOOL_ERROR, or no formal stage — absence is not evidence", () => {
    for (const status of ["PASS", "SKIPPED", "TOOL_ERROR"]) {
      expect(formalEvidenceOf({ formal_verify: { status } })).toBe(null);
    }
    expect(formalEvidenceOf({})).toBe(null);
    expect(formalEvidenceOf(null)).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The user's description must reach each module's validators (run 49).
//
// In a system run each module's pipeline is driven by the description
// DECOMPOSE wrote for it. Measured: the user's text enumerates
// "Ports: clk, rst_n, req, done, gnt" for rr_arbiter; the paraphrase dropped
// the reset entirely, so portsClauseOf returned [], the port validator
// abstained by design, and elicit correctly applied its documented
// "description is silent → active-high `rst`" default. Every stage behaved
// correctly on what it was handed — the information died upstream.
// ═══════════════════════════════════════════════════════════════════════════
describe("system module description attribution (run 49)", () => {
  const DESC = [
    "A two-port merge subsystem.",
    "",
    "The leaf module, sync_fifo, is a synchronous FIFO of beats. Ports: clk, rst_n, wr_en, full.",
    "",
    "The middle module, ingress_channel, buffers one stream. Ports: clk, rst_n, in_valid, req. "
      + "It passes DEPTH unchanged to the sync_fifo it instantiates.",
    "",
    "The other middle module, rr_arbiter, grants the egress. Ports: clk, rst_n, req, done, gnt.",
    "",
    "The top level, pkt_merge_top, instantiates two ingress_channel modules and one rr_arbiter. "
      + "Ports: clk, rst_n, in0_valid, out_valid.",
  ].join("\n");
  const ALL = ["sync_fifo", "ingress_channel", "rr_arbiter", "pkt_merge_top"];

  it("attributes each paragraph to the module it is about", () => {
    expect(portsClauseOf(moduleParagraphOf(DESC, "rr_arbiter", ALL)))
      .toEqual(["clk", "rst_n", "req", "done", "gnt"]);
    expect(portsClauseOf(moduleParagraphOf(DESC, "sync_fifo", ALL)))
      .toEqual(["clk", "rst_n", "wr_en", "full"]);
    expect(portsClauseOf(moduleParagraphOf(DESC, "pkt_merge_top", ALL)))
      .toEqual(["clk", "rst_n", "in0_valid", "out_valid"]);
  });

  it("is not fooled by a paragraph that merely MENTIONS another module", () => {
    // the top's paragraph names ingress_channel and rr_arbiter before its own
    // Ports: clause — neither may inherit the top's ports
    const ch = portsClauseOf(moduleParagraphOf(DESC, "ingress_channel", ALL));
    expect(ch).toEqual(["clk", "rst_n", "in_valid", "req"]);
    expect(ch).not.toContain("in0_valid");
  });

  it("abstains rather than guess when a module cannot be attributed", () => {
    expect(moduleParagraphOf(DESC, "not_a_module", ALL)).toBeNull();
    expect(moduleParagraphOf("", "rr_arbiter", ALL)).toBeNull();
    expect(moduleParagraphOf(DESC, "rr_arbiter", [])).toBeNull();
  });

  it("the driving description leads with the user's words, keeping the paraphrase", () => {
    const paraphrase = "Two-channel round-robin arbiter. Inputs: req[1:0], done. Output: gnt[1:0].";
    const d = systemModuleDesc(DESC, paraphrase, "rr_arbiter", ALL);
    // the validator now reads the USER's enumerated clause…
    expect(portsClauseOf(d)).toEqual(["clk", "rst_n", "req", "done", "gnt"]);
    expect(portsClauseOf(d)).toContain("rst_n");
    // …and decompose's elaboration is still there for the model
    expect(d).toContain("Two-channel round-robin arbiter");
  });

  // A user who describes a module without enumerating its ports still
  // deserves to have those words reach the model. Requiring a Ports: clause
  // to attach ANYTHING made the clause do double duty — attribution signal
  // and attach condition — and silently dropped the user's prose.
  it("keeps the user's prose when they never enumerated ports", () => {
    const sys = "A merge subsystem.\n\n"
      + "The arbiter, rr_arbiter, grants the egress fairly and never starves a channel.";
    const d = systemModuleDesc(sys, "Round-robin arbiter. Ports: clk, rst, req, done, gnt.",
      "rr_arbiter", ALL);
    expect(d).toContain("never starves a channel");
    // nothing of the user's to enforce, so the model's own list stands
    expect(portsClauseOf(d)).toEqual(["clk", "rst", "req", "done", "gnt"]);
  });

  it("keeps the user's prose when neither side enumerates ports", () => {
    const sys = "A merge subsystem.\n\nThe arbiter, rr_arbiter, holds a grant for a whole packet.";
    const d = systemModuleDesc(sys, "Round-robin arbiter.", "rr_arbiter", ALL);
    expect(d).toContain("holds a grant for a whole packet");
  });

  it("an enumerated user clause still beats the paraphrase's", () => {
    const sys = "A merge subsystem.\n\n"
      + "The arbiter, rr_arbiter, grants the egress. Ports: clk, rst_n, req, done, gnt.";
    const d = systemModuleDesc(sys, "Round-robin arbiter. Ports: clk, rst, req, gnt.",
      "rr_arbiter", ALL);
    expect(portsClauseOf(d)).toEqual(["clk", "rst_n", "req", "done", "gnt"]);
    expect(portsClauseOf(d)).toContain("rst_n");
  });

  it("the loose path still abstains when a module is named first in two paragraphs", () => {
    // an intro sentence naming sync_fifo, plus its own paragraph — ambiguous,
    // so no prose is attached, but the strict Ports: anchor still resolves
    const sys = "The sync_fifo is the smallest part of this system.\n\n"
      + "The leaf module, sync_fifo, is a FIFO. Ports: clk, rst_n, wr_en, full.";
    const d = systemModuleDesc(sys, "paraphrase", "sync_fifo", ALL);
    expect(d).not.toContain("smallest part");
    expect(portsClauseOf(d)).toEqual(["clk", "rst_n", "wr_en", "full"]);
  });

  it("requirePorts:false is opt-in — the default still demands the clause", () => {
    const sys = "A subsystem.\n\nThe arbiter, rr_arbiter, grants the egress.";
    expect(moduleParagraphOf(sys, "rr_arbiter", ALL)).toBeNull();
    expect(moduleParagraphOf(sys, "rr_arbiter", ALL, { requirePorts: false })).toContain("grants the egress");
  });

  // A user who lists only the interesting ports — "Ports: req, gnt" for an
  // arbiter that plainly needs a clock — had the fidelity check tell a
  // COMPLIANT model to delete clk and rst_n, yielding an unclockable module.
  // Same contradiction shape as run 44's b0e860d, reached from the opposite
  // direction: one check demands a port, another rejects it as an extra.
  //
  // Note this was NOT new in system mode — a single-module run had always
  // behaved this way; the system path was accidentally exempt only because
  // decompose's paraphrase carried no Ports: clause at all.
  it("a partial port list does not condemn the clock and reset", () => {
    const desc = "The arbiter, rr_arbiter, grants the egress. Ports: req, gnt.";
    const spec = {
      requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "x" }],
      iface: [
        { name: "clk", dir: "input", width: "1" },
        { name: "rst_n", dir: "input", width: "1" },
        { name: "req", dir: "input", width: "2" },
        { name: "gnt", dir: "output", width: "2", reset: "0" },
      ],
      params: [],
    };
    expect(specFidelityViolations(spec, desc)).toEqual([]);
    expect(detectMalformedSpec(spec, desc)).toBeNull();
  });

  it("accepts the common clock and reset spellings", () => {
    const desc = "Ports: req, gnt.";
    for (const pair of [["clk", "rst_n"], ["clock", "resetn"], ["i_clk", "arst_n"], ["clk_i", "reset"]]) {
      const spec = { iface: pair.concat(["req", "gnt"]).map((n) => ({ name: n, dir: "input", width: "1" })),
        params: [], requirements: [] };
      expect(specFidelityViolations(spec, desc)).toEqual([]);
    }
  });

  it("still rejects a port the description never mentions", () => {
    const desc = "Ports: req, gnt.";
    const spec = { iface: ["clk", "rst_n", "req", "gnt", "debug_bus"].map((n) => ({ name: n, dir: "input", width: "1" })),
      params: [], requirements: [] };
    const v = specFidelityViolations(spec, desc);
    expect(v.join(" ")).toContain("debug_bus");
  });

  it("does not exempt a data port that merely contains clk or reset", () => {
    const desc = "Ports: req, gnt.";
    for (const extra of ["clk_div_ratio", "reset_count"]) {
      const spec = { iface: ["clk", "req", "gnt", extra].map((n) => ({ name: n, dir: "input", width: "1" })),
        params: [], requirements: [] };
      expect(specFidelityViolations(spec, desc).join(" ")).toContain(extra);
    }
  });

  it("falls back to the paraphrase alone when attribution abstains", () => {
    const paraphrase = "Some module with no enumerated ports.";
    expect(systemModuleDesc(DESC, paraphrase, "unknown_mod", ALL)).toBe(paraphrase);
  });
});
