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

// ═══════════════════════════════════════════════════════════════════════════
// Context-aware string-value salvage — the failure class that flaky local
// models (gpt-oss-120b et al.) hit constantly: code-in-JSON whose INNER quotes
// are left unescaped and happen to be followed by `,` or `:`, which the local
// escapeInnerQuotes heuristic mis-reads as the string's close. Pins the exact
// bench failure (uart_rx: lint RTL-fix reply unparseable at ~char 5559).
// ═══════════════════════════════════════════════════════════════════════════
describe("extractJSON context-aware string-value salvage", () => {
  it("recovers $display(\"x\", y) — inner close-quote followed by a comma", () => {
    // The killer pattern: the inner `"` after `%d` is followed by `,` so the
    // local heuristic thinks the JSON string ended; lookahead past the comma
    // sees `x);` (not a new key) → it's an inner quote.
    const raw = '{"code":"$display("got %d", y); assign z = 1;"}';
    expect(xj(raw)).toEqual({ code: '$display("got %d", y); assign z = 1;' });
  });

  it("recovers ternary string literals — inner close-quote followed by a colon", () => {
    const raw = '{"code":"x = sel ? "a" : "b";"}';
    expect(xj(raw)).toEqual({ code: 'x = sel ? "a" : "b";' });
  });

  it("keeps a genuine value-comma that introduces a real next key", () => {
    // `","fixes"` must be read as a real close (next token is a key), while the
    // inner `"hi"` quotes are escaped.
    const raw = '{"code":"$display("hi");","fixes":["wrote x"]}';
    expect(xj(raw)).toEqual({ code: '$display("hi");', fixes: ["wrote x"] });
  });

  it("handles a realistic RTL-fix reply with quotes, braces and newlines together", () => {
    const raw =
      '{"code":"module m;\n  always_comb begin\n    if (sel) $error("bad: %s", name);\n    y = {a, b};\n  end\nendmodule","fixes":["escaped the "valid" signal"]}';
    const out = xj(raw);
    expect(out.code).toContain('$error("bad: %s", name)');
    expect(out.code).toContain("y = {a, b};");
    expect(out.fixes[0]).toBe('escaped the "valid" signal');
  });

  it("salvages inner quotes inside an array of objects (lint fixes list)", () => {
    const raw = '{"fixes":[{"id":"F1","desc":"renamed "clk" to "clock""},{"id":"F2","desc":"ok"}]}';
    const out = xj(raw);
    expect(out.fixes).toHaveLength(2);
    expect(out.fixes[0].desc).toBe('renamed "clk" to "clock"');
    expect(out.fixes[1].desc).toBe("ok");
  });

  it("recovers when the unescaped quotes also desync the structural scan", () => {
    // Odd number of stray quotes → scanStructure never balances → would have
    // been misreported as TRUNCATED. The salvage rescue must close it instead.
    const raw = '{"code":"a = "x"; b = "y";"}';
    expect(xj(raw)).toEqual({ code: 'a = "x"; b = "y";' });
  });

  it("does not corrupt already-valid JSON with escaped inner quotes", () => {
    const raw = '{"code":"$display(\\"hi %d\\", n);","ok":true}';
    expect(xj(raw)).toEqual({ code: '$display("hi %d", n);', ok: true });
  });

  it("coerces a bareword VALUE so the rest of the object still parses (the {line: sixty} bench defect)", () => {
    const raw = '{"line": sixty, "msg": "unexpected token", "sev": "error"}';
    expect(xj(raw)).toEqual({ line: "sixty", msg: "unexpected token", sev: "error" });
  });

  it("maps Python-style literals True/False/None to JSON true/false/null", () => {
    expect(xj('{"a": True, "b": False, "c": None}')).toEqual({ a: true, b: false, c: null });
  });

  it("maps NaN / Infinity barewords to null", () => {
    expect(xj('{"x": NaN, "y": Infinity}')).toEqual({ x: null, y: null });
  });

  it("quotes bareword values inside arrays", () => {
    expect(xj('{"items":[foo, bar, true, 3]}')).toEqual({ items: ["foo", "bar", true, 3] });
  });

  it("still REJECTS an unquoted KEY (coercion is value-position only)", () => {
    // Key-position barewords must NOT be auto-quoted — that path stays a
    // deliberate diagnostic so genuinely broken output is surfaced.
    let msg = "";
    try { xj('{key: "value here", "ok": 1}'); } catch (e) { msg = e.message; }
    expect(msg).toContain("JSON parse failed");
    expect(msg).not.toContain("TRUNCATED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool-call markup salvage (measured: run 39, laguna-s-2.1).
//
// laguna returned a COMPLETE 4220-char module whose JSON ended:
//   {"code":"`timescale ... endmodule // restoring_divider</arg_value>}
// It had emitted tool-call framing where the closing quote belonged. Every
// check downstream read an unterminated string and reported TRUNCATED OUTPUT
// — with a "verified prefix" note, since closing the structures does make it
// parse — so a finished module was discarded and the stage lost 33 minutes.
// ═══════════════════════════════════════════════════════════════════════════
describe("tool-call markup salvage (run 39)", () => {
  const CODE = [
    "`timescale 1ns/1ps",
    "// ASSUMPTION: FSM state encoded in binary.",
    "module restoring_divider #(parameter int WIDTH = 8)(input logic clk);",
    "endmodule // restoring_divider",
  ].join("\\n");                       // escaped \n, as real JSON output has

  const recovered = (raw) => extractJSON(raw, { stopReason: "stop" });

  it("recovers when the closing tag REPLACED the string terminator", () => {
    const v = recovered('{"code":"' + CODE + '</arg_value>}');
    expect(v.code).toContain("endmodule // restoring_divider");
    expect(v.code).not.toContain("arg_value");
  });

  it("recovers when the tag was pure framing after a closed value", () => {
    const v = recovered('{"code":"' + CODE + '"</arg_value>}');
    expect(v.code).toContain("endmodule");
  });

  it("recovers a value wrapped in opening AND closing tags", () => {
    const v = recovered('<arg_value>{"code":"' + CODE + '"}</arg_value>');
    expect(v.code).toContain("endmodule");
  });

  it("covers the other framing dialects a model might emit", () => {
    for (const tag of ["tool_call", "function_call", "parameter", "invoke"]) {
      const v = recovered('{"code":"' + CODE + "</" + tag + ">}");
      expect(v.code).toContain("endmodule");
    }
  });

  it("leaves valid JSON completely untouched", () => {
    const raw = '{"code":"' + CODE + '","fixes":["a"]}';
    const v = recovered(raw);
    expect(v.code).toContain("endmodule");
    expect(v.fixes).toEqual(["a"]);
  });

  it("a GENUINE truncation still reports truncation, not a false recovery", () => {
    // Cut mid-string with no framing anywhere — must still throw.
    expect(() => recovered('{"code":"`timescale 1ns/1ps\\nmodule foo')).toThrow(/TRUNCATED/);
  });

  it("does not corrupt a payload that merely mentions the tag inside a string", () => {
    const v = recovered('{"code":"x","note":"emit </arg_value> here"}');
    expect(v.note).toBe("emit </arg_value> here");   // direct parse wins first
  });
});
