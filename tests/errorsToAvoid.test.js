// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Tasks #26–28: cross-run error memory. Pure core + adapters (mock fs).

import { describe, it, expect } from "vitest";
import {
  normalizeMessage, errorSignature, aggregateErrors, formatErrorsToAvoid,
  mergeErrorCatalogs, createInMemoryErrorMemory, createFileErrorMemory,
  distillRule, rulesNeedingReview, isProseLeak, resolveAvoidSection, RULE_TABLE,
  migrateCatalog, resolveAvoidSectionRanked,
} from "../src/pipeline/errorsToAvoid.js";
import { KNOWLEDGE_PACKS } from "../src/pipeline/knowledgePacks.js";
import { promptRTL } from "../src/prompts/rtl.js";
import { promptTB } from "../src/prompts/testGen.js";

describe("normalizeMessage / errorSignature", () => {
  it("collapses identifiers, numbers and paths so variants share a template", () => {
    // Placeholders (X/N/FILE) stay upper-case — they're applied after lowercasing.
    expect(normalizeMessage("Operand 'a' width 8 != 4")).toBe("operand X width N != N");
    expect(normalizeMessage("Operand 'bus' width 16 != 32")).toBe("operand X width N != N");
    expect(normalizeMessage("Signal not driven: top.sv:42")).toBe("signal not driven: FILE:N");
  });

  it("strips the Verilator source-line gutter so the same class at different lines collapses", () => {
    // The embedded "  NN | <source>  | ^~~~" and the doc-link trailer are dropped.
    expect(normalizeMessage("syntax error, unexpected always_ff 104 | always_ff @(posedge clk or")).toBe("syntax error, unexpected always_ff");
    expect(normalizeMessage("syntax error, unexpected always_ff 12 | always_ff @(posedge rst")).toBe("syntax error, unexpected always_ff");
    expect(errorSignature({ code: "SYNTAX", msg: "syntax error, unexpected ']', expecting ':' 29 | logic [BIT_WIDTH-1]" }))
      .toBe(errorSignature({ code: "SYNTAX", msg: "syntax error, unexpected ']', expecting ':' 30 | logic [OTHER-1]" }));
  });

  it("two errors of the same code+template share a signature; different codes don't", () => {
    const a = errorSignature({ code: "WIDTH", msg: "Operand 'a' width 8 != 4" });
    const b = errorSignature({ code: "WIDTH", msg: "Operand 'q' width 1 != 9" });
    const c = errorSignature({ code: "LATCH", msg: "Operand 'a' width 8 != 4" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(errorSignature({ msg: "x" })).toMatch(/^GENERIC\|/);
  });
});

describe("aggregateErrors", () => {
  it("dedups by signature+domain, sums counts, sorts most-recurring first", () => {
    const recs = [
      { signature: "WIDTH|w", domain: "rtl", count: 2, lastTs: 1, sample: "old" },
      { signature: "WIDTH|w", domain: "rtl", count: 3, lastTs: 5, sample: "new" },
      { signature: "LATCH|l", domain: "rtl", count: 1, lastTs: 2 },
      { signature: "WIDTH|w", domain: "tb", count: 1, lastTs: 1 },   // distinct domain
    ];
    const agg = aggregateErrors(recs);
    expect(agg[0]).toMatchObject({ signature: "WIDTH|w", domain: "rtl", count: 5, sample: "new" });
    expect(agg.find((r) => r.domain === "tb").count).toBe(1);
    expect(agg.map((r) => r.count)).toEqual([5, 1, 1]);   // sorted desc
  });
});

describe("formatErrorsToAvoid", () => {
  const recs = [
    { signature: "WIDTH|w", code: "WIDTH", domain: "rtl", count: 6, sample: "operand width mismatch" },
    { signature: "LATCH|l", code: "LATCH", domain: "rtl", count: 2, sample: "inferred latch" },
    { signature: "TBX|x", code: "TBX", domain: "tb", count: 3, sample: "tb thing" },
  ];
  it("renders a section filtered by domain, capped by topN", () => {
    const md = formatErrorsToAvoid(recs, { domain: "rtl", topN: 1 });
    expect(md).toMatch(/COMMON MISTAKES TO AVOID/);
    expect(md).toMatch(/\[WIDTH\] operand width mismatch  \(seen 6×\)/);
    expect(md).not.toMatch(/LATCH/);   // capped to 1
    expect(md).not.toMatch(/tb thing/); // domain-filtered
  });
  it("returns empty string when there is nothing to inject", () => {
    expect(formatErrorsToAvoid([], {})).toBe("");
    expect(formatErrorsToAvoid(recs, { domain: "nope" })).toBe("");
  });
});

describe("distillRule + injection of rules (Part D)", () => {
  it("maps the mid-block declaration syntax error to its rule", () => {
    const rule = distillRule({ code: "SYNTAX", msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\"" });
    expect(rule).toMatch(/TOP of its block/);
  });

  it("maps the bit-select-of-expression syntax error to its rule", () => {
    const rule = distillRule({ code: "SYNTAX", msg: "syntax error, unexpected '[', expecting ';'" });
    expect(rule).toMatch(/bit-select.*parenthesized|parenthesized expression/i);
  });

  it("maps the missing-backtick compiler-directive syntax error to its rule", () => {
    // Exact symptom harvested live from nvidia/nemotron-3-nano-omni: `timescale`
    // written without its leading backtick → Verilator "unexpected IDENTIFIER".
    const sample = "syntax error, unexpected IDENTIFIER 1 | timescale 1ns/1ps | ^~~~~~~~~ ... See the manual at https://verilator.org/verilator_doc.html?v=5.049 for more assistance.";
    const rule = distillRule({ code: "SYNTAX", msg: sample });
    expect(rule).toMatch(/backtick/i);
    expect(rule).toMatch(/`timescale/);
  });

  it("maps common lint codes (WIDTH, LATCH, BLKSEQ) by code alone", () => {
    expect(distillRule({ code: "WIDTH", msg: "Operand 'a' width 8 != 4" })).toMatch(/bit-width/i);
    expect(distillRule({ code: "LATCH", msg: "anything" })).toMatch(/every branch|combinational/i);
    expect(distillRule({ code: "BLKSEQ", msg: "x" })).toMatch(/non-blocking/i);
  });

  it("maps the recurring lfm2-24b SYNTAX classes to rules", () => {
    expect(distillRule({ code: "SYNTAX", msg: "Illegal character in binary constant: 2 26 | localparam MAX_W = 32'b2" })).toMatch(/sized literal|'b/i);
    expect(distillRule({ code: "SYNTAX", msg: "too many digits for 2 bit number: '2'b10000000' 26 |" })).toMatch(/sized literal|fit the declared width/i);
    expect(distillRule({ code: "SYNTAX", msg: "syntax error, unexpected ']', expecting ':' 29 | logic [BIT_WIDTH-1]" })).toMatch(/full range|both bounds|:0/i);
    expect(distillRule({ code: "SYNTAX", msg: "syntax error, unexpected ':', expecting ';' 19 | (input rst_n : logic" })).toMatch(/direction type name|input logic/i);
    expect(distillRule({ code: "SYNTAX", msg: "Unsupported: complex ports (IEEE 1800-2023 23.2.2.1/2)" })).toMatch(/ANSI port|complex/i);
    expect(distillRule({ code: "SYNTAX", msg: "syntax error, unexpected always_ff 104 | always_ff @(posedge clk" })).toMatch(/module body|always_ff/i);
    expect(distillRule({ code: "SYNTAX", msg: "syntax error, unexpected assign 76 | assign B = (rst_n) ? 0 : 1" })).toMatch(/continuous 'assign'|module scope/i);
    expect(distillRule({ code: "SYNTAX", msg: "syntax error, unexpected parameter, expecting '[' 6 | parameter DATA_W" })).toMatch(/ANSI header|parameter/i);
  });

  it("every rule is phrased POSITIVELY — no avoid/never/don't/do-not clauses (F2)", () => {
    // A/B measured that naming the anti-pattern primes it; rules state only the
    // correct form. Lock it in for RULE_TABLE and every shipped pack.
    const NEG = /\b(avoid|never|don't|do not)\b/i;
    for (const r of RULE_TABLE) expect(r.rule, r.rule).not.toMatch(NEG);
    for (const p of KNOWLEDGE_PACKS) for (const rec of p.records) expect(rec.rule, rec.rule).not.toMatch(NEG);
  });

  it("returns null for an unknown error (raw symptom kept as fallback)", () => {
    expect(distillRule({ code: "SYNTAX", msg: "some other unrecognized syntax problem" })).toBe(null);
    expect(distillRule({ code: "NOVELCODE", msg: "x" })).toBe(null);
    expect(distillRule(null)).toBe(null);
  });

  it("record() distils the rule AND keeps the raw sample connected", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({ code: "SYNTAX", msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\"", domain: "tb" });
    const r = mem.all()[0];
    expect(r.rule).toMatch(/TOP of its block/);   // distilled rule
    expect(r.ruleSource).toBe("table");
    expect(r.sample).toMatch(/unexpected IDENTIFIER/); // raw symptom preserved
  });

  it("formatErrorsToAvoid injects the RULE, not the raw symptom, when present", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({ code: "SYNTAX", msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\"", domain: "tb" });
    const md = formatErrorsToAvoid(mem.all(), { domain: "tb" });
    expect(md).toMatch(/TOP of its block/);            // the actionable rule
    expect(md).not.toMatch(/unexpected IDENTIFIER/);   // not the cryptic symptom
  });

  it("collapses the SAME error class at different source lines into one lesson", () => {
    const mem = createInMemoryErrorMemory();
    // Two raw messages for the SAME mistake, differing only in the embedded
    // Verilator source line — normalizeMessage strips that gutter, so they now
    // share a signature and merge into one catalog row (count summed).
    mem.record({ code: "SYNTAX", msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\" 87 | logic prev = clk;", domain: "tb" });
    mem.record({ code: "SYNTAX", msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\" 201 | logic pre_full = full;", domain: "tb" });
    expect(mem.all()).toHaveLength(1);                 // collapsed (was 2 before the gutter strip)
    expect(mem.all()[0].count).toBe(2);
    const md = formatErrorsToAvoid(mem.all(), { domain: "tb" });
    const ruleLines = md.split("\n").filter((l) => /TOP of its block/.test(l));
    expect(ruleLines).toHaveLength(1);                 // injected ONCE
    expect(ruleLines[0]).toMatch(/seen 2×/);           // counts summed
  });

  it("falls back to the raw sample for an un-distilled error (old catalog / unknown)", () => {
    const recs = [{ signature: "FOO|bar", code: "FOO", domain: "rtl", sample: "raw foo symptom" }];
    const md = formatErrorsToAvoid(recs, { domain: "rtl" });
    expect(md).toMatch(/raw foo symptom/);
  });

  it("rulesNeedingReview lists un-distilled + auto(table) rules with their sample", () => {
    const recs = [
      { signature: "S1|x", code: "SYNTAX", domain: "tb", sample: "raw1", rule: "the rule", ruleSource: "table" },
      { signature: "S2|y", code: "FOO", domain: "rtl", sample: "raw2", rule: null },
      { signature: "S3|z", code: "BAR", domain: "rtl", sample: "raw3", rule: "human rule", ruleSource: "model" },
    ];
    const review = rulesNeedingReview(recs);
    const sigs = review.map((r) => r.signature).sort();
    expect(sigs).toEqual(["S1|x", "S2|y"]);            // table + null, NOT the model-authored one
    expect(review.every((r) => r.sample)).toBe(true);  // each keeps its connected raw error
  });
});

describe("isProseLeak (harvest-quality guard)", () => {
  // Real prose-leak noise harvested from liquid/lfm2.5-1.2b — spec text dumped
  // into the RTL, which Verilator rejects. These must be DROPPED at harvest.
  it("drops spec prose / markdown leaked into the source", () => {
    const drop = [
      "syntax error, unexpected IDENTIFIER 14 | - Require: Proper width matching, clock | ^",
      "syntax error, unexpected IDENTIFIER 13 | - Must: Synchronous FIFO with Gray pointers | ^",
      "syntax error, unexpected IDENTIFIER 3 | This module implements a single-port RAM | ^",
      "syntax error, unexpected with 5 | The output is a 10-bit result aligned | ^",
      "syntax error, unexpected ':', expecting ',' or ';' 1 | RTL Forge: Synchronous FIFO with Gray | ^",
      "Define or directive not defined: '`json' 1 | `json | ^~~~~",
    ];
    for (const msg of drop) expect(isProseLeak({ code: "SYNTAX", msg })).toBe(true);
  });

  // Genuine code-shaped errors — MUST be kept (never over-filter real mistakes).
  it("keeps real syntax/code errors", () => {
    const keep = [
      "syntax error, unexpected and",                                   // bare message, no source line
      "syntax error, unexpected IDENTIFIER-for-type",                   // bare message
      "syntax error, unexpected '{' 2 | { | ^",                         // stray brace (single token)
      "syntax error, unexpected ']', expecting ':' 25 | count[3 | ^",   // bit-select (has brackets)
      "Operand 'a' width 8 != 4 12 | assign x = a + b; | ^",            // real code line with SV tokens
    ];
    for (const msg of keep) expect(isProseLeak({ code: "SYNTAX", msg })).toBe(false);
    expect(isProseLeak({})).toBe(false);
    expect(isProseLeak(null)).toBe(false);
  });
});

describe("resolveAvoidSection (single injection source of truth)", () => {
  const harvested = [{ signature: "A|x", code: "WIDTH", domain: "rtl", model: "M", sample: "width mismatch", count: 2 }];
  const shipped   = [{ signature: "S|s", code: "SYNTAX", domain: "rtl", model: "M", rule: "shipped rule", ruleSource: "curated", count: 5 }];

  it("returns '' when errorsToAvoid is off and there are no shipped records", () => {
    expect(resolveAvoidSection({ model: "M" }, harvested, [], "rtl")).toBe("");
  });
  it("injects harvested records only when errorsToAvoid is on", () => {
    expect(resolveAvoidSection({ model: "M" }, harvested, [], "rtl")).toBe("");                    // off
    expect(resolveAvoidSection({ model: "M", errorsToAvoid: true }, harvested, [], "rtl")).toMatch(/width mismatch/);
  });
  it("injects shipped records independent of errorsToAvoid (their gate is upstream)", () => {
    const md = resolveAvoidSection({ model: "M" }, harvested, shipped, "rtl");    // errorsToAvoid off
    expect(md).toMatch(/shipped rule/);
    expect(md).not.toMatch(/width mismatch/);                                     // harvested still gated off
  });
  it("scopes to the active model (default same-model-only) and the domain", () => {
    expect(resolveAvoidSection({ model: "OTHER", errorsToAvoid: true }, harvested, shipped, "rtl")).toBe(""); // neither matches OTHER
    expect(resolveAvoidSection({ model: "M", errorsToAvoid: true }, harvested, shipped, "tb")).toBe("");      // no tb records
    const both = resolveAvoidSection({ model: "M", errorsToAvoid: true }, harvested, shipped, "rtl");
    expect(both).toMatch(/width mismatch/);
    expect(both).toMatch(/shipped rule/);
  });
});

describe("resolveAvoidSectionRanked (spec-relevance injection)", () => {
  const cfg = { model: "M", errorsToAvoid: true };
  // Three harvested lessons: the FIFO one is least frequent but most relevant
  // to a FIFO spec; the counter one dominates by count.
  const harvested = [
    { signature: "C|c", code: "WIDTH", domain: "rtl", model: "M", rule: "counter lesson", count: 9 },
    { signature: "F|f", code: "LATCH", domain: "rtl", model: "M", rule: "fifo lesson", count: 1 },
    { signature: "M|m", code: "SYNTAX", domain: "rtl", model: "M", rule: "mux lesson", count: 5 },
  ];
  const shipped = [{ signature: "S|s", code: "SYNTAX", domain: "rtl", model: "M", rule: "shipped rule", ruleSource: "curated", count: 1 }];
  // Fake embedder: the spec vector points at the fifo lesson's axis.
  const AXES = { "a fifo spec": [1, 0], "fifo lesson": [0.9, 0.1], "mux lesson": [0.5, 0.5], "counter lesson": [0, 1], "shipped rule": [0, 1] };
  const embedFn = async (texts) => texts.map((t) => AXES[t] || [0, 0]);

  function lineOrder(md) {
    return md.split("\n").filter((l) => l.trim().startsWith("•")).map((l) => l.replace(/^\s*•\s*(\[\w+\]\s*)?/, "").replace(/\s+\(seen.*$/, ""));
  }

  it("orders harvested lessons by spec similarity, curated always first", async () => {
    const md = await resolveAvoidSectionRanked(cfg, harvested, shipped, "rtl", "a fifo spec", embedFn);
    expect(lineOrder(md)).toEqual(["shipped rule", "fifo lesson", "mux lesson", "counter lesson"]);
  });
  it("without an embedder it is byte-identical to the sync section", async () => {
    const sync = resolveAvoidSection(cfg, harvested, shipped, "rtl");
    expect(await resolveAvoidSectionRanked(cfg, harvested, shipped, "rtl", "a fifo spec", null)).toBe(sync);
    expect(await resolveAvoidSectionRanked(cfg, harvested, shipped, "rtl", "", embedFn)).toBe(sync);   // no spec text
  });
  it("an embed failure falls back to the count-ordered section, never throws", async () => {
    const boom = async () => { throw new Error("embed down"); };
    const md = await resolveAvoidSectionRanked(cfg, harvested, shipped, "rtl", "a fifo spec", boom);
    expect(md).toBe(resolveAvoidSection(cfg, harvested, shipped, "rtl"));
  });
  it("errorsToAvoid off → shipped only, and the embedder is never called", async () => {
    let called = false;
    const spy = async (texts) => { called = true; return embedFn(texts); };
    const md = await resolveAvoidSectionRanked({ model: "M" }, harvested, shipped, "rtl", "a fifo spec", spy);
    expect(md).toMatch(/shipped rule/);
    expect(md).not.toMatch(/fifo lesson/);
    expect(called).toBe(false);
  });
  it("relevance ranking keeps the least-frequent lesson inside a tight topN", async () => {
    const md = await resolveAvoidSectionRanked(cfg, harvested, [], "rtl", "a fifo spec", embedFn, /* topN via format default */);
    expect(lineOrder(md)[0]).toBe("fifo lesson");   // count-ordered would lead with the counter lesson
  });
});

describe("catalog migration + stale-rule refresh (review findings)", () => {
  const NEG_RULE = "Use simple ANSI port declarations in the module header ('input logic clk, output logic [7:0] q'); avoid the complex/expression port forms Verilator reports as unsupported.";
  const CP_MSG = "Unsupported: complex ports (IEEE 1800-2023 23.2.2.1/2)";

  it("migrateCatalog refreshes stale table rules to the CURRENT positive text", () => {
    const old = [{
      signature: errorSignature({ code: "UNSUPPORTED", msg: CP_MSG }),
      code: "UNSUPPORTED", sample: CP_MSG,
      rule: NEG_RULE, ruleSource: "table", domain: "rtl", model: "M", count: 5,
    }];
    const { rows, changed } = migrateCatalog(old);
    expect(changed).toBe(true);
    expect(rows[0].rule).not.toMatch(/avoid/i);            // the backfiring phrasing is gone
    expect(rows[0].rule).toBe(distillRule({ code: "UNSUPPORTED", msg: CP_MSG }));
  });

  it("migrateCatalog re-signs pre-gutter-strip rows and merges the duplicates", () => {
    const oldSigA = "SYNTAX|syntax error, unexpected always_ff N | always_ff @(posedge clk";
    const oldSigB = "SYNTAX|syntax error, unexpected always_ff N | always_ff @(negedge rst";
    const old = [
      { signature: oldSigA, code: "SYNTAX", sample: "syntax error, unexpected always_ff 104 | always_ff @(posedge clk", domain: "rtl", model: "M", count: 2 },
      { signature: oldSigB, code: "SYNTAX", sample: "syntax error, unexpected always_ff 12 | always_ff @(negedge rst", domain: "rtl", model: "M", count: 3 },
    ];
    const { rows } = migrateCatalog(old);
    expect(rows).toHaveLength(1);                          // line-variants merged
    expect(rows[0].count).toBe(5);                         // counts summed
    expect(rows[0].signature).toBe(errorSignature({ code: "SYNTAX", msg: old[0].sample }));
  });

  it("migrateCatalog never touches model-authored or curated rules", () => {
    const old = [
      { signature: "S|m", code: "SYNTAX", sample: CP_MSG, rule: "human insight", ruleSource: "model", domain: "rtl", count: 1 },
      { signature: "S|c", code: "SYNTAX", sample: CP_MSG, rule: "shipped wisdom", ruleSource: "curated", domain: "tb", count: 1 },
    ];
    const { rows } = migrateCatalog(old);
    expect(rows.find((r) => r.ruleSource === "model").rule).toBe("human insight");
    expect(rows.find((r) => r.ruleSource === "curated").rule).toBe("shipped wisdom");
  });

  it("createFileErrorMemory migrates an old on-disk catalog on load and persists it", () => {
    const oldJson = JSON.stringify([{
      signature: "UNSUPPORTED|unsupported: complex ports (ieee N-N N.N.N.N/N) extra-old-cruft",
      code: "UNSUPPORTED", sample: CP_MSG, rule: NEG_RULE, ruleSource: "table",
      domain: "rtl", model: "M", count: 4,
    }]);
    const store = { "/cat.json": oldJson };
    const fs = { existsSync: (p) => p in store, readFileSync: (p) => store[p], writeFileSync: (p, v) => { store[p] = v; } };
    const mem = createFileErrorMemory("/cat.json", { fs });
    expect(mem.all()[0].rule).not.toMatch(/avoid/i);
    expect(JSON.parse(store["/cat.json"])[0].rule).not.toMatch(/avoid/i);   // persisted migrated
  });

  it("record() refreshes a stale auto rule on re-harvest (live path, no reload)", () => {
    const sig = errorSignature({ code: "UNSUPPORTED", msg: CP_MSG });
    const mem = createInMemoryErrorMemory([
      { signature: sig, code: "UNSUPPORTED", sample: CP_MSG, rule: NEG_RULE, ruleSource: "table", domain: "rtl", model: null, count: 5 },
    ]);
    mem.record({ code: "UNSUPPORTED", msg: CP_MSG, domain: "rtl" });
    expect(mem.all()).toHaveLength(1);
    expect(mem.all()[0].rule).not.toMatch(/avoid/i);       // refreshed, not preserved
  });

  it("colon rule only distils port/param context — ternary and case colons stay raw", () => {
    expect(distillRule({ code: "SYNTAX", msg: "syntax error, unexpected ':', expecting ';' 12 | y = a ? b : : c;" })).toBe(null);
    expect(distillRule({ code: "SYNTAX", msg: "syntax error, unexpected ':', expecting ',' 30 | 3: y = 1;" })).toBe(null);
    expect(distillRule({ code: "SYNTAX", msg: "syntax error, unexpected ':', expecting ';' 19 | (input rst_n : logic" })).toMatch(/direction type name/);
  });
});

describe("mergeErrorCatalogs (federation)", () => {
  it("adds new lessons and sums counts on overlap; idempotent re-merge", () => {
    const dest = [{ signature: "A|a", domain: "rtl", count: 2 }];
    const src = [{ signature: "A|a", domain: "rtl", count: 3 }, { signature: "B|b", domain: "tb", count: 1 }];
    const r1 = mergeErrorCatalogs(dest, src);
    expect(r1.added).toBe(1);
    expect(r1.summed).toBe(1);
    expect(r1.merged.find((x) => x.signature === "A|a").count).toBe(5);
    // re-merging the SAME source again only sums (no new rows)
    const r2 = mergeErrorCatalogs(r1.merged, src);
    expect(r2.added).toBe(0);
    expect(r2.merged.find((x) => x.signature === "A|a").count).toBe(8);
  });
});

describe("model attribution + cross-model gating (Part E)", () => {
  it("record() stores the generating model", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({ code: "WIDTH", msg: "Operand 'a' width 8 != 4", domain: "rtl", model: "modelA" });
    expect(mem.all()[0].model).toBe("modelA");
  });

  it("keys by model: the SAME error from two models is tracked separately", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({ code: "WIDTH", msg: "Operand 'a' width 8 != 4", domain: "rtl", model: "A" });
    mem.record({ code: "WIDTH", msg: "Operand 'q' width 1 != 9", domain: "rtl", model: "A" }); // same template
    mem.record({ code: "WIDTH", msg: "Operand 'a' width 8 != 4", domain: "rtl", model: "B" }); // diff model
    const all = mem.all();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.model === "A").count).toBe(2);
    expect(all.find((r) => r.model === "B").count).toBe(1);
  });

  const mixed = [
    { signature: "WA|w", code: "WIDTH", domain: "rtl", count: 5, sample: "A-only mistake", model: "A" },
    { signature: "WB|w", code: "WIDTH", domain: "rtl", count: 9, sample: "B-only mistake", model: "B" },
    { signature: "SH|s", code: "LATCH", domain: "rtl", count: 1, sample: "shared legacy lesson", model: null },
  ];

  it("default (crossModel off) injects only this model's lessons + unattributed", () => {
    const md = formatErrorsToAvoid(mixed, { domain: "rtl", model: "A" });
    expect(md).toMatch(/A-only mistake/);
    expect(md).toMatch(/shared legacy lesson/); // unattributed always allowed
    expect(md).not.toMatch(/B-only mistake/);   // another model's error excluded
  });

  it("crossModel:true injects every model's lessons", () => {
    const md = formatErrorsToAvoid(mixed, { domain: "rtl", model: "A", crossModel: true });
    expect(md).toMatch(/A-only mistake/);
    expect(md).toMatch(/B-only mistake/);
    expect(md).toMatch(/shared legacy lesson/);
  });

  it("no current model given → cannot scope, injects all", () => {
    const md = formatErrorsToAvoid(mixed, { domain: "rtl" });
    expect(md).toMatch(/A-only mistake/);
    expect(md).toMatch(/B-only mistake/);
  });

  it("no-regression: model-less records + no model opt are byte-identical to pre-Part-E", () => {
    const legacy = [{ signature: "WIDTH|w", code: "WIDTH", domain: "rtl", count: 4, sample: "operand width mismatch" }];
    const before = formatErrorsToAvoid(legacy, { domain: "rtl" });
    const withEmptyOpts = formatErrorsToAvoid(legacy, { domain: "rtl", model: undefined, crossModel: false });
    expect(withEmptyOpts).toBe(before);
    expect(before).toMatch(/operand width mismatch/);
  });

  it("mergeErrorCatalogs keys by model: same signature, different models → two rows", () => {
    const res = mergeErrorCatalogs(
      [{ signature: "A|a", domain: "rtl", count: 2, model: "X" }],
      [{ signature: "A|a", domain: "rtl", count: 3, model: "Y" }],
    );
    expect(res.added).toBe(1);   // not merged — different model
    expect(res.merged).toHaveLength(2);
  });
});

describe("createInMemoryErrorMemory", () => {
  it("records merge by signature+domain and increment count", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({ code: "WIDTH", msg: "Operand 'a' width 8 != 4", domain: "rtl" });
    mem.record({ code: "WIDTH", msg: "Operand 'q' width 1 != 9", domain: "rtl" }); // same template
    mem.record({ code: "WIDTH", msg: "Operand 'a' width 8 != 4", domain: "tb" });  // diff domain
    const all = mem.all();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.domain === "rtl").count).toBe(2);
    expect(all.find((r) => r.domain === "tb").count).toBe(1);
  });
  it("ignores records with neither signature nor code/msg", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({});
    mem.record(null);
    expect(mem.all()).toEqual([]);
  });
  it("replaceAll swaps the whole catalog (training Q2 rewrite write-back)", () => {
    const mem = createInMemoryErrorMemory();
    mem.record({ code: "WIDTH", msg: "x", domain: "rtl", model: "A" });
    mem.replaceAll([{ signature: "NEW|n", domain: "rtl", model: "A", rule: "rewritten", ruleSource: "model", count: 1 }]);
    expect(mem.all()).toHaveLength(1);
    expect(mem.all()[0].rule).toBe("rewritten");
  });
});

describe("createFileErrorMemory (mock fs)", () => {
  function mockFs(initial) {
    const store = { "/cat.json": initial };
    return {
      _store: store,
      existsSync: (p) => p in store,
      readFileSync: (p) => store[p],
      writeFileSync: (p, v) => { store[p] = v; },
    };
  }

  it("persists records and merges across re-open", () => {
    const fs = mockFs(undefined);
    const m1 = createFileErrorMemory("/cat.json", { fs });
    m1.record({ code: "WIDTH", msg: "Operand 'a' width 8", domain: "rtl" });
    m1.record({ code: "WIDTH", msg: "Operand 'b' width 4", domain: "rtl" });
    // Re-open from the same backing store → state survived.
    const m2 = createFileErrorMemory("/cat.json", { fs });
    expect(m2.all()).toHaveLength(1);
    expect(m2.all()[0].count).toBe(2);
  });

  it("importCatalog merges an external catalog and persists", () => {
    const fs = mockFs(JSON.stringify([{ signature: "A|a", domain: "rtl", count: 1 }]));
    const m = createFileErrorMemory("/cat.json", { fs });
    const res = m.importCatalog([{ signature: "A|a", domain: "rtl", count: 4 }, { signature: "B|b", domain: "tb", count: 1 }]);
    expect(res).toMatchObject({ added: 1, summed: 1, total: 2 });
    expect(m.all().find((r) => r.signature === "A|a").count).toBe(5);
  });

  it("requires an injected fs", () => {
    expect(() => createFileErrorMemory("/x.json", {})).toThrow(/opts\.fs/);
  });
});

describe("prompt injection (no-regression lock)", () => {
  const spec = { iface: { ports: [] }, params: {}, requirements: [{ id: "REQ-A-1", pri: "Must", desc: "do x" }] };
  const arch = { plan: "x" };
  const el = { moduleName: "m" };

  it("promptRTL is byte-identical when errorsToAvoid is absent/empty", () => {
    const a = promptRTL(arch, spec, el, [], null).userMessage;
    const b = promptRTL(arch, spec, el, [], null, "").userMessage;
    expect(b).toBe(a);
  });
  it("promptRTL adds the AVOID section when supplied", () => {
    const avoid = formatErrorsToAvoid(
      [{ signature: "WIDTH|w", code: "WIDTH", domain: "rtl", count: 4, sample: "operand width mismatch" }],
      { domain: "rtl" });
    const um = promptRTL(arch, spec, el, [], null, avoid).userMessage;
    expect(um).toMatch(/COMMON MISTAKES TO AVOID/);
    expect(um).toMatch(/operand width mismatch/);
  });
  it("promptTB is byte-identical when errorsToAvoid is absent/empty", () => {
    const a = promptTB("module m; endmodule", spec, el, []).userMessage;
    const b = promptTB("module m; endmodule", spec, el, [], "").userMessage;
    expect(b).toBe(a);
  });
  it("promptTB adds the AVOID section when supplied", () => {
    const um = promptTB("module m; endmodule", spec, el, [], "COMMON MISTAKES TO AVOID\n  • [X] y").userMessage;
    expect(um).toMatch(/COMMON MISTAKES TO AVOID/);
  });
});
