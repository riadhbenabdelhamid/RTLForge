// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { extractJSON, addRetryHint } from "../src/llm/extractJSON.js";

describe("extractJSON", () => {
  it("parses pure JSON directly", () => {
    expect(extractJSON('{"a":1,"b":"hi"}')).toEqual({ a: 1, b: "hi" });
  });

  it("parses fenced JSON in markdown code block", () => {
    const raw = 'Here is the response:\n```json\n{"x": 42}\n```\nDone.';
    expect(extractJSON(raw)).toEqual({ x: 42 });
  });

  it("parses fenced JSON without language tag", () => {
    const raw = '```\n{"x": 42}\n```';
    expect(extractJSON(raw)).toEqual({ x: 42 });
  });

  it("extracts brace-balanced JSON from prose preamble", () => {
    const raw = 'Sure! Here you go: {"name":"clk","width":1} — let me know if you need more.';
    expect(extractJSON(raw)).toEqual({ name: "clk", width: 1 });
  });

  it("handles trailing commas", () => {
    const raw = '{"a":1,"b":2,}';
    expect(extractJSON(raw)).toEqual({ a: 1, b: 2 });
  });

  it("handles NaN and Infinity → null", () => {
    const raw = '{"score":NaN,"max":Infinity,"min":-Infinity}';
    expect(extractJSON(raw)).toEqual({ score: null, max: null, min: null });
  });

  it("handles safe HTML entities in strings (via recovery path)", () => {
    // Note 1: entity substitution only runs in the recovery branch (step 4),
    //   so the input must FAIL direct JSON.parse first. Trailing comma forces it.
    // Note 2: we deliberately exclude &quot; here. The original App28.jsx
    //   substitution unescapes &quot; → " which produces invalid JSON if
    //   the bare quote ends up inside a string delimiter — a latent bug
    //   inherited from the monolith. Only &amp; / &lt; / &gt; are safe in
    //   practice. Documented for slice 2 review.
    const raw = '{"label":"a&amp;b","tag":"&lt;clk&gt;",}';
    expect(extractJSON(raw)).toEqual({ label: "a&b", tag: "<clk>" });
  });

  it("falls back to array extraction when only [ exists", () => {
    const raw = "Output: [1, 2, 3]";
    expect(extractJSON(raw)).toEqual([1, 2, 3]);
  });

  it("throws TRUNCATED OUTPUT for unbalanced braces", () => {
    const raw = '{"requirements":[{"id":"REQ-01","desc":"foo"';
    expect(() => extractJSON(raw)).toThrow(/TRUNCATED OUTPUT/);
  });

  it("throws with diagnostic for prose-only output", () => {
    expect(() => extractJSON("I cannot help with that.")).toThrow(/DIAGNOSIS/);
  });

  it("throws on empty input", () => {
    expect(() => extractJSON("")).toThrow(/empty or non-string/);
  });

  it("throws on non-string input", () => {
    expect(() => extractJSON(null)).toThrow(/empty or non-string/);
    expect(() => extractJSON(undefined)).toThrow(/empty or non-string/);
    expect(() => extractJSON(42)).toThrow(/empty or non-string/);
  });

  it("handles control characters in strings", () => {
    const raw = '{"text":"line1\nline2"}'; // literal newline embedded
    const out = extractJSON(raw);
    expect(out.text).toContain("line");
  });

  it("survives nested objects with embedded braces", () => {
    const raw = '{"a":{"b":{"c":42}}}';
    expect(extractJSON(raw)).toEqual({ a: { b: { c: 42 } } });
  });
});

describe("addRetryHint", () => {
  it("appends hint when previous error mentions JSON parse", () => {
    const p = { userMessage: "Generate spec for FIFO." };
    addRetryHint(p, "JSON parse failed: TRUNCATED OUTPUT");
    expect(p.userMessage).toContain("RETRY CONTEXT");
    expect(p.userMessage).toContain("Generate spec for FIFO.");
  });

  it("appends hint when previous error mentions truncated", () => {
    const p = { userMessage: "Original prompt." };
    addRetryHint(p, "Output appears truncated at line 30");
    expect(p.userMessage).toContain("RETRY CONTEXT");
  });

  it("does NOT append for unrelated errors", () => {
    const p = { userMessage: "Original prompt." };
    addRetryHint(p, "Network timeout");
    expect(p.userMessage).toBe("Original prompt.");
  });

  it("does NOT append when lastError is null", () => {
    const p = { userMessage: "Original." };
    addRetryHint(p, null);
    expect(p.userMessage).toBe("Original.");
  });

  it("does NOT append when lastError is not a string", () => {
    const p = { userMessage: "Original." };
    addRetryHint(p, new Error("oops"));
    expect(p.userMessage).toBe("Original.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Strengthened extraction — string-aware scanning + repair ladder.
//
// These pin the two failure classes that used to be MISDIAGNOSED as
// "TRUNCATED OUTPUT (hit max_tokens)", sending users to tune token limits
// that were never the problem.
// ═══════════════════════════════════════════════════════════════════════════
import { extractJSON as xj, looksTruncatedJSON } from "../src/llm/extractJSON.js";

describe("extractJSON string-aware repairs", () => {
  it("repairs unescaped inner quotes instead of misreporting truncation", () => {
    // The desync defect: after the bad quote around "valid", a naive scanner
    // reads the rest of the document out of phase and never balances.
    const raw = '{"desc":"asserts "valid" when full","nested":{"ok":1}}';
    const out = xj(raw);
    expect(out.desc).toBe('asserts "valid" when full');
    expect(out.nested.ok).toBe(1);
  });

  it("inner-quote repair works even with structural braces after the bad quote", () => {
    const raw = '{"a":"say "x" {brace in text}","b":{"c":2}}';
    const out = xj(raw);
    expect(out.a).toContain("{brace in text}");
    expect(out.b.c).toBe(2);
  });

  it("escapes raw newlines inside strings WITHOUT corrupting pretty-printed JSON", () => {
    // The old global control-char fix rewrote structural newlines into
    // literal \n tokens, breaking pretty-printed output that only had one
    // in-string defect.
    const raw = '{\n  "a": "line1\nline2",\n  "b": 1\n}';
    const out = xj(raw);
    expect(out.a).toBe("line1\nline2");
    expect(out.b).toBe(1);
  });

  it("braces inside string values never unbalance the scan", () => {
    const raw = 'Here is the result: {"code":"assign y = {a, {b, c}};"} hope that helps!';
    const out = xj(raw);
    expect(out.code).toBe("assign y = {a, {b, c}};");
  });

  it("balanced-but-malformed output is NOT reported as truncation", () => {
    // Unquoted key — structurally balanced, syntactically invalid. The
    // error must be the generic diagnosis, not a token-limit wild goose
    // chase.
    let msg = "";
    try { xj('{key: "unquoted key name", "weird": @@}'); } catch (e) { msg = e.message; }
    expect(msg).not.toContain("TRUNCATED");
    expect(msg).toContain("JSON parse failed");
  });

  it("genuine truncation carries verified-prefix evidence and the output TAIL", () => {
    const raw = '{"requirements":[{"id":"REQ-1","desc":"The module shall be cut right abou';
    let msg = "";
    try { xj(raw, { stopReason: "max_tokens", maxTokensRequested: 1000 }); } catch (e) { msg = e.message; }
    expect(msg).toContain("TRUNCATED OUTPUT");
    expect(msg).toContain("unclosed structure");
    expect(msg).toContain("INSIDE a string value");        // EOF mid-string
    expect(msg).toContain("genuine truncation");           // close-and-parse verified
    expect(msg).toContain("Last 200 chars");                // tail evidence
    expect(msg).toContain("stop reason: max_tokens");       // provenance intact
  });

  it("looksTruncatedJSON flags quote-desync and real cuts, passes complete output", () => {
    expect(looksTruncatedJSON('{"a":{"b":1}}')).toBe(false);
    expect(looksTruncatedJSON('{"a":{"b":')).toBe(true);                 // real cut
    expect(looksTruncatedJSON('{"a":"ends inside a string')).toBe(true); // cut mid-string
    // In-string braces on COMPLETE parseable output: not truncated
    expect(looksTruncatedJSON('{"code":"y = {a,b};"}')).toBe(false);
  });
});
