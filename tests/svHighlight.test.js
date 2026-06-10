// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Tests for src/utils/svHighlight.js
//
// Pin the round-trip property (concatenating tokens.value reproduces the
// source) and basic token-type assignments. We don't pin every keyword —
// the keyword table is data, not behaviour. We pin the categories.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { tokenizeSV, svTokenColors } from "../src/utils/svHighlight.js";

describe("tokenizeSV", function() {
  it("returns empty for empty input", function() {
    expect(tokenizeSV("")).toEqual([]);
    expect(tokenizeSV(null)).toEqual([]);
    expect(tokenizeSV(undefined)).toEqual([]);
  });

  it("ROUND-TRIP: concatenating tokens.value reproduces the source verbatim", function() {
    const sources = [
      "module foo; endmodule",
      "logic [7:0] q = 8'hFF;",
      "always_ff @(posedge clk) q <= d;",
      "// line comment\nmodule x;\nendmodule",
      "/* block comment */\nlogic q;",
      "$display(\"hello, world!\");",
      "`timescale 1ns/1ps\n`define WIDTH 8",
    ];
    sources.forEach(function(src) {
      const tokens = tokenizeSV(src);
      const reconstructed = tokens.map(function(t) { return t.value; }).join("");
      expect(reconstructed).toBe(src);
    });
  });

  it("classifies keywords, types, comments, strings, numbers, directives, system tasks", function() {
    const src = '`timescale 1ns/1ps\nmodule fifo;\n  logic [7:0] data = 8\'hFF;\n  // a comment\n  initial $display("hello");\nendmodule';
    const tokens = tokenizeSV(src);
    const types = new Set(tokens.map(function(t) { return t.type; }));
    expect(types.has("directive")).toBe(true);   // `timescale
    expect(types.has("keyword")).toBe(true);     // module, initial, endmodule
    expect(types.has("type")).toBe(true);        // logic
    expect(types.has("comment")).toBe(true);     // // a comment
    expect(types.has("string")).toBe(true);      // "hello"
    expect(types.has("number")).toBe(true);      // 1, 1, 7, 0, 8'hFF
    expect(types.has("system")).toBe(true);      // $display
  });

  it("handles strings with escaped quotes", function() {
    const tokens = tokenizeSV('"a\\"b"');
    const stringToken = tokens.find(function(t) { return t.type === "string"; });
    expect(stringToken).toBeDefined();
    expect(stringToken.value).toBe('"a\\"b"');
  });

  it("handles block comments without nesting", function() {
    const tokens = tokenizeSV("/* hello */");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe("comment");
    expect(tokens[0].value).toBe("/* hello */");
  });

  it("recognises always_ff, always_comb as keywords (multi-char keyword variants)", function() {
    const tokens = tokenizeSV("always_ff always_comb always_latch");
    const keywordTokens = tokens.filter(function(t) { return t.type === "keyword"; });
    expect(keywordTokens.map(function(t) { return t.value; }))
      .toEqual(["always_ff", "always_comb", "always_latch"]);
  });

  it("recognises base-prefixed numbers (8'b1010, 4'hF, 32'd123)", function() {
    const tokens = tokenizeSV("8'b1010 4'hF 32'd123");
    const numberTokens = tokens.filter(function(t) { return t.type === "number"; });
    expect(numberTokens.map(function(t) { return t.value; }))
      .toEqual(["8'b1010", "4'hF", "32'd123"]);
  });

  it("recognises multi-char operators (<=, ==, &&, ::)", function() {
    const tokens = tokenizeSV("a <= b && c == d::e");
    const opTokens = tokens.filter(function(t) { return t.type === "operator"; });
    const opValues = opTokens.map(function(t) { return t.value; });
    expect(opValues).toContain("<=");
    expect(opValues).toContain("&&");
    expect(opValues).toContain("==");
    expect(opValues).toContain("::");
  });

  it("recognises directives (`define, `ifdef, `endif, `timescale)", function() {
    const tokens = tokenizeSV("`define A 1\n`ifdef A\nendif");
    const directiveTokens = tokens.filter(function(t) { return t.type === "directive"; });
    expect(directiveTokens.map(function(t) { return t.value; }))
      .toEqual(["`define", "`ifdef"]);
  });

  it("recognises system tasks ($display, $finish, $urandom)", function() {
    const tokens = tokenizeSV("$display($urandom, $finish);");
    const systemTokens = tokens.filter(function(t) { return t.type === "system"; });
    expect(systemTokens.map(function(t) { return t.value; }))
      .toEqual(["$display", "$urandom", "$finish"]);
  });
});

describe("svTokenColors", function() {
  it("returns a colour map keyed by token type", function() {
    const TH = {
      accent: "#a", blue: "#b", text2: "#c", green: "#d", orange: "#e",
      yellow: "#f", text1: "#g", text0: "#h",
    };
    const colors = svTokenColors(TH);
    expect(colors.keyword).toBe("#a");
    expect(colors.type).toBe("#b");
    expect(colors.comment).toBe("#c");
    expect(colors.string).toBe("#d");
    expect(colors.number).toBe("#e");
  });

  it("falls back to defaults when palette is incomplete", function() {
    const colors = svTokenColors({});
    Object.keys(colors).forEach(function(k) {
      expect(typeof colors[k]).toBe("string");
      expect(colors[k].length).toBeGreaterThan(0);
    });
  });
});
