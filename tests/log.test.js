// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../src/pipeline/log.js";

describe("createLogger — Improvement B (extracted from pipeline nodes)", function() {
  it("returns a callable function with .buf accessor", function() {
    const log = createLogger(null);
    expect(typeof log).toBe("function");
    expect(log.buf).toBe("");
  });

  it("accumulates text into buf", function() {
    const log = createLogger(null);
    log("Section A", "hello");
    expect(log.buf).toContain("Section A");
    expect(log.buf).toContain("hello");
  });

  it("calls the streaming callback with (buf, {}) on each call", function() {
    const onLog = vi.fn();
    const log = createLogger(onLog);
    log("Section A", "first");
    log("Section B", "second");
    expect(onLog).toHaveBeenCalledTimes(2);
    expect(onLog.mock.calls[0][0]).toContain("first");
    expect(onLog.mock.calls[1][0]).toContain("first");   // buf is cumulative
    expect(onLog.mock.calls[1][0]).toContain("second");
    expect(onLog.mock.calls[0][1]).toEqual({});
  });

  it("uses thick dividers when style='thick'", function() {
    const log = createLogger(null, "thick");
    log("Lint", "test");
    // Thick style includes triple ━━━━ rows
    expect(log.buf).toContain("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    expect(log.buf).toContain("━━━ Lint ━━━");
  });

  it("uses thin dividers when style='thin' (default)", function() {
    const log = createLogger(null);
    log("Verify", "test");
    expect(log.buf).toContain("━━━ Verify ━━━");
    // Thin should NOT have the triple-line bar
    expect(log.buf).not.toContain("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  });

  it("treats null/undefined text as empty string (no crash)", function() {
    const log = createLogger(null);
    log("Section", null);
    log("Section", undefined);
    expect(log.buf).toContain("Section");
    expect(log.buf).not.toContain("null");
    expect(log.buf).not.toContain("undefined");
  });

  it("works with no onLog callback (silent mode)", function() {
    const log = createLogger(null);
    expect(function() { log("X", "Y"); }).not.toThrow();
    expect(log.buf).toContain("X");
    expect(log.buf).toContain("Y");
  });

  it("reset() clears the buffer", function() {
    const log = createLogger(null);
    log("A", "hi");
    expect(log.buf.length).toBeGreaterThan(0);
    log.reset();
    expect(log.buf).toBe("");
  });

  it("falls back to thin style on unknown style key", function() {
    const log = createLogger(null, "rainbow");
    log("X", "y");
    expect(log.buf).toContain("━━━ X ━━━");
    expect(log.buf).not.toContain("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  });

  it(".buf is a getter, not a settable property", function() {
    const log = createLogger(null);
    log("A", "hello");
    const before = log.buf;
    // Attempting to set .buf should not actually mutate (getter without setter
    // is silently ignored in non-strict mode or throws in strict).
    try { log.buf = "tampered"; } catch (_) { /* strict-mode error is fine */ }
    expect(log.buf).toBe(before);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Streaming-aware logger tests (this turn's bug fix)
//
// The bug: every LLM streaming chunk was wired through `appendLog(section,
// chunk)`, which fired the section divider for every chunk. The CLI Output
// tab showed the same header repeated dozens of times with progressively
// longer body text underneath each one. The fix is `log.stream(section,
// chunk)` which writes the divider once and accumulates chunks below it.
// ═════════════════════════════════════════════════════════════════════════
describe("createLogger — log.stream (streaming-duplication fix)", function() {
  it("emits the section header ONCE per section, then keeps only the LATEST cumulative text (cumulative-mode)", function() {
    // Under cumulative-mode, the LLM streaming API passes the full
    // cumulative buffer-to-date as each chunk's `fullText`. The streaming
    // region of the buffer should always reflect the freshest state, not
    // accumulate prior chunks.
    const log = createLogger(null, "thick");
    log.stream("RTL Fix output (iter 1)", "{");
    log.stream("RTL Fix output (iter 1)", "{\"code");
    log.stream("RTL Fix output (iter 1)", "{\"code\":\"");
    log.stream("RTL Fix output (iter 1)", "{\"code\":\"module x; endmodule\"}");
    const headerCount = (log.buf.match(/RTL Fix output \(iter 1\)/g) || []).length;
    expect(headerCount).toBe(1);
    // The buffer should ONLY have the final fullText, not the concat of
    // all prior chunks. Specifically, NO `{{`, `{ "code{`, or any artefact
    // of the accumulation bug should appear.
    expect(log.buf).toContain("{\"code\":\"module x; endmodule\"}");
    expect(log.buf).not.toContain("{{");
    expect(log.buf).not.toContain("\"\"code");
  });

  it("switching to a different section finalises the prior stream and starts fresh", function() {
    const log = createLogger(null, "thin");
    log.stream("Section A", "alpha");
    log.stream("Section A", "alpha and beta");
    log.stream("Section B", "first chunk for B");
    log.stream("Section B", "first chunk for B + more");
    expect((log.buf.match(/Section A/g) || []).length).toBe(1);
    expect((log.buf.match(/Section B/g) || []).length).toBe(1);
    // Section A's body should be the final cumulative ("alpha and beta"),
    // and Section B's body should be its final cumulative.
    expect(log.buf).toContain("alpha and beta");
    expect(log.buf).toContain("first chunk for B + more");
    // Crucially, the prior streaming text shouldn't have been doubly
    // appended — the body region between headers should NOT show
    // "alphaalpha" or similar.
    expect(log.buf).not.toContain("alphaalpha");
  });

  it("a non-stream log() call after streaming resets the streaming state but preserves the streamed body", function() {
    const log = createLogger(null, "thin");
    log.stream("Section A", "streamed cumulative state");
    log("Other Section", "regular body");
    log.stream("Section A", "another streamed cumulative state");
    // Section A should appear twice — once from the original stream, once
    // when the post-reset stream re-emits its header.
    expect((log.buf.match(/Section A/g) || []).length).toBe(2);
    // Both the first and second cumulative texts should be in the buffer
    // because the regular log() call between them finalised the first.
    expect(log.buf).toContain("streamed cumulative state");
    expect(log.buf).toContain("another streamed cumulative state");
    expect(log.buf).toContain("regular body");
  });

  it("invokes onLog for each stream chunk so the UI sees streaming progress", function() {
    let calls = 0;
    let lastBuf = "";
    const log = createLogger(function(buf, m) { calls++; lastBuf = buf; }, "thin");
    log.stream("S", "a");
    log.stream("S", "ab");
    log.stream("S", "abc");
    expect(calls).toBe(3);
    expect(lastBuf).toContain("abc");
    // The lastBuf should NOT show duplicated body — only "abc", not
    // "aababc" or any concat artefact.
    const bodyAfterHeader = lastBuf.split("━━━ S ━━━").pop();
    expect(bodyAfterHeader.trim()).toBe("abc");
  });

  it("reset() clears both buffer AND streaming state including offset", function() {
    const log = createLogger(null, "thin");
    log.stream("S", "x");
    log.reset();
    log.stream("S", "y");
    expect((log.buf.match(/S/g) || []).length).toBe(1);
    expect(log.buf).toContain("y");
    expect(log.buf).not.toContain("x");
  });

  it("treats null chunks safely (no crash, no 'null' string)", function() {
    const log = createLogger(null, "thin");
    log.stream("S", null);
    log.stream("S", undefined);
    log.stream("S", "real");
    expect(log.buf).toContain("S");
    expect(log.buf).toContain("real");
    expect(log.buf).not.toContain("null");
    expect(log.buf).not.toContain("undefined");
  });

  it("REGRESSION (user-reported): cumulative chunks like '{', '{ \"code', '{ \"code\":\"' produce ONLY the final state in buf", function() {
    // This is the exact pattern the user reported in v16. Previously each
    // cumulative chunk was appended raw, producing `{{ "code{ "code":"` etc.
    const log = createLogger(null, "thin");
    const chunks = [
      "{",
      "{\"",
      "{\"code",
      "{\"code\":",
      "{\"code\":\"",
      "{\"code\":\"`timescale 1ns",
      "{\"code\":\"`timescale 1ns/1ps",
    ];
    chunks.forEach(function(c) { log.stream("RTL Fix output", c); });
    // The buffer body should be ONLY the final cumulative text.
    const body = log.buf.split("━━━ RTL Fix output ━━━").pop().trim();
    expect(body).toBe("{\"code\":\"`timescale 1ns/1ps");
  });
});
