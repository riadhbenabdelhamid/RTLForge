// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Tasks #26–28: cross-run error memory. Pure core + adapters (mock fs).

import { describe, it, expect } from "vitest";
import {
  normalizeMessage, errorSignature, aggregateErrors, formatErrorsToAvoid,
  mergeErrorCatalogs, createInMemoryErrorMemory, createFileErrorMemory,
  distillRule, rulesNeedingReview,
} from "../src/pipeline/errorsToAvoid.js";
import { promptRTL } from "../src/prompts/rtl.js";
import { promptTB } from "../src/prompts/testGen.js";

describe("normalizeMessage / errorSignature", () => {
  it("collapses identifiers, numbers and paths so variants share a template", () => {
    // Placeholders (X/N/FILE) stay upper-case — they're applied after lowercasing.
    expect(normalizeMessage("Operand 'a' width 8 != 4")).toBe("operand X width N != N");
    expect(normalizeMessage("Operand 'bus' width 16 != 32")).toBe("operand X width N != N");
    expect(normalizeMessage("Signal not driven: top.sv:42")).toBe("signal not driven: FILE:N");
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

  it("maps common lint codes (WIDTH, LATCH, BLKSEQ) by code alone", () => {
    expect(distillRule({ code: "WIDTH", msg: "Operand 'a' width 8 != 4" })).toMatch(/bit-width/i);
    expect(distillRule({ code: "LATCH", msg: "anything" })).toMatch(/latch/i);
    expect(distillRule({ code: "BLKSEQ", msg: "x" })).toMatch(/non-blocking/i);
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

  it("collapses several symptoms that distil to the SAME rule into one line", () => {
    const mem = createInMemoryErrorMemory();
    // Two DIFFERENT raw messages (distinct signatures — the source line varies)
    // that both distil to the mid-block-declaration rule.
    mem.record({ code: "SYNTAX", msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\" 87 | logic prev = clk;", domain: "tb" });
    mem.record({ code: "SYNTAX", msg: "syntax error, unexpected IDENTIFIER, expecting \"'{\" 201 | logic pre_full = full;", domain: "tb" });
    expect(mem.all()).toHaveLength(2);                 // catalog keeps both (for rewrite)
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
