// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// pipeline/log.js — Shared log-builder for pipeline nodes
//
// Improvement B: extracts the duplicated `appendLog` function pattern from
// lint.js, verify.js, and judge.js into a single factory. Each node still
// gets to choose its own divider style (lint uses thick triple lines, verify
// and judge use a single mid line) so log output remains visually distinct
// when a user is reading the streamed log.
//
// Usage:
//   const log = createLogger(st._onLog, "thick");
//   log("Section title", "body text");
//   log.buf;            // the full accumulated buffer
//
// Returns a callable function with a `.buf` getter so callers don't need to
// thread their own `logBuf` variable.
// ═══════════════════════════════════════════════════════════════════════════

const DIVIDERS = {
  // Thick triple-line dividers — used by `lint` for high-visibility iter
  // markers (lint can produce many short sections, so the triple line helps
  // a reader scan the log quickly).
  thick: function(section) {
    return "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n━━━ " + section + " ━━━\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
  },
  // Thin single-line divider — used by verify/judge whose sections are
  // typically longer and less frequent.
  thin: function(section) {
    return "\n\n━━━ " + section + " ━━━\n";
  },
};

/**
 * Create a logger function bound to a streaming callback.
 *
 * @param {Function|null} onLog  Streaming callback (logBuf, metrics) → void
 * @param {"thick"|"thin"} [style="thin"]  Divider style
 * @returns {Function & { buf: string, reset: Function, stream: Function }}
 *   The returned function is callable as `log(section, text)`. It also has:
 *     - `log.buf`     — getter returning the current accumulated buffer
 *     - `log.reset()` — clear the buffer (rarely used)
 *     - `log.stream(section, fullText)` — for LLM streaming output. The
 *       fullText argument is treated as the CUMULATIVE buffer-to-date for
 *       the streaming response (which is what callLLM's `onChunk` callback
 *       provides — fullText, not a delta). On first call for a given section
 *       the header is emitted and the streaming-start offset recorded; on
 *       subsequent calls the buffer is truncated back to that offset and
 *       the fresh fullText appended. The next non-stream `log()` call
 *       finalises the current stream by clearing the streaming state, so
 *       the fullText already in the buffer stays put.
 *
 * STREAMING-DUPLICATION FIX (v17, second attempt — v16 only fixed the
 * header repeat; this also fixes the body content duplicating because
 * each chunk passes the cumulative-not-delta buffer):
 *
 * Before v16:  every chunk → log("Section", chunk) → divider+chunk appended.
 *              Result: header repeats N times, body shows growing
 *              cumulative text under each header.
 * After v16:   every chunk → log.stream("Section", chunk) → divider once,
 *              then chunks appended raw.
 *              Result: header appears once, but body STILL duplicates
 *              because chunks are cumulative — each chunk includes all
 *              prior text, so `{` then `{ "code"` then `{ "code": "..."`
 *              gets appended as `{{ "code"{ "code": "..."`.
 * After v17:   every chunk → log.stream("Section", fullText) → divider
 *              once, then on each call buf is truncated back to the
 *              streaming-start offset and the new fullText appended. The
 *              streaming region of the buffer always holds exactly the
 *              latest cumulative state.
 */
export function createLogger(onLog, style) {
  const fmt = DIVIDERS[style] || DIVIDERS.thin;
  let buf = "";
  let streamingSection = null;   // tracks the active streaming section name
  let streamingOffset = -1;      // buf length AFTER divider was written for current stream
  function log(section, text) {
    streamingSection = null;
    streamingOffset = -1;
    buf += fmt(section) + (text == null ? "" : String(text));
    if (onLog) onLog(buf, {});
  }
  log.stream = function(section, fullText) {
    if (streamingSection !== section) {
      // First chunk for this section — emit header + record offset.
      streamingSection = section;
      buf += fmt(section);
      streamingOffset = buf.length;
    } else {
      // Same section, new chunk — truncate buf back to where the streaming
      // started and re-append the latest cumulative content. The body
      // section of the buffer always reflects the freshest streaming
      // state without accumulating the duplications that came before.
      buf = buf.slice(0, streamingOffset);
    }
    if (fullText != null) buf += String(fullText);
    if (onLog) onLog(buf, {});
  };
  Object.defineProperty(log, "buf", { get: function() { return buf; } });
  log.reset = function() {
    buf = "";
    streamingSection = null;
    streamingOffset = -1;
  };
  return log;
}
