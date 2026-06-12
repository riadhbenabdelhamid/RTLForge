// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// callLLMJson — call the LLM, parse JSON, and re-ask once on parse failure
//
// WHY THIS EXISTS:
//
// Every RTL Forge prompt demands a JSON reply, and the recovery story had a
// hole between two existing layers:
//
//   - callLLM's truncation ladder fixes LENGTH problems (output cut by a
//     token cap) — it cannot fix malformed syntax.
//   - extractJSON's repair ladder fixes the COMMON syntax defects (inner
//     quotes, junk after closing quotes, control chars, trailing commas) —
//     but when repairs fail, the stage simply errored, even though the
//     addRetryHint machinery for "tell the model what it got wrong and ask
//     again" already existed and no node used it in-call.
//
// This helper closes the hole for one-shot generation stages: on a parse
// failure it appends the actual parse error to the prompt (addRetryHint)
// and re-asks once. One hinted retry converts most residual formatting
// failures into a slow-but-successful stage instead of a dead one.
//
// USAGE (single-call nodes — spec, formal_props, …):
//
//   const jr = await callLLMJson(p);          // p: normal callLLM args
//   const data = jr.data;                      // parsed JSON
//   const _llms = jr.llms.map((r) => Object.assign({ stage: "spec" }, r));
//
// jr.llms holds EVERY attempt (failed ones included) so nodes can ledger
// the real token spend. On final failure the parse error is re-thrown with
// `.llms` attached for the same reason.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM } from "./callLLM.js";
import { extractJSON, addRetryHint } from "./extractJSON.js";

/**
 * @param {object} args  exactly what callLLM takes (systemPrompt,
 *                       userMessage, maxTokens, config, onChunk, signal)
 * @param {object} [opts]
 * @param {number} [opts.parseRetries] hinted re-asks after a parse failure;
 *        defaults to config.parseRetries, then 1. Zero disables the re-ask
 *        (pure callLLM + extractJSON).
 * @returns {Promise<{data: object, llms: Array, parseRetried: number}>}
 */
export async function callLLMJson(args, opts) {
  const o = opts || {};
  const cfg = args.config || {};
  const parseRetries = o.parseRetries != null ? o.parseRetries
    : (cfg.parseRetries != null ? cfg.parseRetries : 1);

  const llms = [];
  let lastErr = null;

  for (let attempt = 0; attempt <= parseRetries; attempt++) {
    let attemptArgs = args;
    if (attempt > 0) {
      // Shallow copy: addRetryHint mutates userMessage on the copy, leaving
      // the caller's prompt object untouched for any later use.
      attemptArgs = Object.assign({}, args);
      addRetryHint(attemptArgs, lastErr.message);
      // Seed nudge — same reasoning as callLLM's truncation ladder: a
      // pinned sampling seed makes an identical re-ask reproduce the
      // identical malformed output on seeded backends (LM Studio/Ollama).
      // Offset by 1000 so these nudges can't collide with the truncation
      // ladder's (+attempt) nudges within the same call.
      if (cfg.seed != null) {
        attemptArgs.config = Object.assign({}, cfg, { seed: cfg.seed + 1000 + attempt });
      }
    }
    const r = await callLLM(attemptArgs);
    llms.push(r);
    try {
      const data = extractJSON(r.text, r);
      return { data: data, llms: llms, parseRetried: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < parseRetries) {
        console.warn(
          "[callLLMJson] JSON parse failed (attempt " + (attempt + 1) + "/"
          + (parseRetries + 1) + ") — re-asking with the parse error as a hint: "
          + String(e.message || "").slice(0, 160),
        );
      }
    }
  }

  // All attempts failed. Attach the spend so callers can still ledger it.
  lastErr.llms = llms;
  throw lastErr;
}
