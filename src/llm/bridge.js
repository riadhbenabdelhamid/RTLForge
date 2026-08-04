// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// llmBridge — put an EXTERNAL model (or a human) in the pipeline's LLM seat
//
// callLLM's `config._llmReplay` hook resolves a call without touching the
// network. recordReplay's replayer answers from pre-recorded fixtures and
// MISSES loudly; this bridge instead *asks* and *waits*: on a miss it writes
// the full prompt to `<dir>/pending/` and blocks until an answer file appears
// in `<dir>/answers/`, then returns it as the model's response.
//
// That makes "run the pipeline, but I'll write the completions myself" a
// first-class mode — for a frontier model reachable only through a chat
// surface, for a human expert answering one hard stage, or for pinning a
// known-good response mid-run without re-recording a whole fixture set.
//
// Answer files are looked up by the first 8 hex of the prompt hash:
//   <dir>/answers/<short>.txt   ← raw completion text (PREFERRED — the model's
//                                 reply verbatim; no JSON re-escaping of code)
//   <dir>/answers/<short>.json  ← { "text": "…" } (or a recordReplay-shaped
//                                 { "response": { "text": … } })
// An answer already on disk is returned immediately, so re-asks of an
// identical prompt cost nothing and a run can be resumed against the answers
// it already collected.
//
// The hook callLLM calls is SYNCHRONOUS, so the wait is a synchronous park
// (Atomics.wait on a throwaway SharedArrayBuffer — no CPU spin). The whole
// process is idle while parked, which also means exactly one prompt is
// outstanding at a time: the bridge serializes the run by construction.
//
// NODE-ONLY (node:fs) — imported by the CLI, never from the browser bundle.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { promptHash } from "./recordReplay.js";

/** Synchronous park. Never busy-waits; falls back to a no-op if SAB is off. */
function parkMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    // SharedArrayBuffer unavailable (locked-down runtime) — degrade to a
    // short blocking read of /dev/null-ish work rather than pinning a core.
    const until = Date.now() + Math.min(ms, 250);
    while (Date.now() < until) { /* bounded fallback */ }
  }
}

/** Read an answer for `short`, or null when none is on disk yet. */
function readAnswer(answerDir, short) {
  const txt = path.join(answerDir, short + ".txt");
  if (fs.existsSync(txt)) {
    const raw = fs.readFileSync(txt, "utf8");
    return { text: raw, source: txt };
  }
  const js = path.join(answerDir, short + ".json");
  if (fs.existsSync(js)) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(js, "utf8"));
    } catch (e) {
      throw new Error("LLM BRIDGE: answer file is not valid JSON: " + js + " — " + e.message);
    }
    const body = rec && rec.response ? rec.response : rec;
    const text = body && typeof body.text === "string" ? body.text : null;
    if (text == null) {
      throw new Error("LLM BRIDGE: answer JSON has no `text` string: " + js);
    }
    return { text: text, tokensOut: body.tokensOut, stopReason: body.stopReason, source: js };
  }
  return null;
}

/**
 * Build a `config._llmReplay` that asks an external model on disk.
 *
 * @param {string} dir            bridge directory (pending/ + answers/ live here)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=3600000]  how long to wait for one answer
 * @param {number} [opts.pollMs=1500]        park interval between disk checks
 * @param {function} [opts.onWait]           called once per new prompt (logging)
 * @param {string[]} [opts.models]           bridge ONLY calls whose model is in
 *   this list; every other call is declined with { passthrough: true } and goes
 *   to the configured provider. With config.modelRouting sending some stages to
 *   the bridge model and the rest to a local one, this is what lets a single run
 *   mix tiers — an external model on one path, a local model on the other.
 * @returns {function} resolver with .stats = { asked, cached, answered, declined }
 */
export function createLLMBridge(dir, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 3600000;
  const pollMs    = o.pollMs    != null ? o.pollMs    : 1500;
  const pendingDir = path.join(dir, "pending");
  const answerDir  = path.join(dir, "answers");
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(answerDir,  { recursive: true });

  const stats = { asked: 0, cached: 0, answered: 0, declined: 0 };
  const only = Array.isArray(o.models) && o.models.length > 0
    ? new Set(o.models.map(function(m) { return String(m); })) : null;
  let seq = 0;

  function bridge(call) {
    if (only && !only.has(String(call.model || ""))) {
      stats.declined++;
      return { passthrough: true };
    }
    const hash  = promptHash(call);
    const short = hash.slice(0, 8);

    const have = readAnswer(answerDir, short);
    if (have) {
      stats.cached++;
      return shape(have, call);
    }

    // Park a prompt for the external model. Written once per distinct prompt;
    // a resumed run re-uses the file already sitting there.
    seq++;
    const pFile = path.join(pendingDir, String(seq).padStart(3, "0") + "-" + short + ".json");
    if (!fs.existsSync(pFile)) {
      fs.writeFileSync(pFile, JSON.stringify({
        hash: hash,
        short: short,
        model: call.model || "",
        answerFile: path.join(answerDir, short + ".txt"),
        systemPrompt: call.systemPrompt || "",
        userMessage: call.userMessage || "",
      }, null, 2));
    }
    stats.asked++;
    if (typeof o.onWait === "function") {
      try { o.onWait({ short: short, file: pFile, promptLen: (call.userMessage || "").length }); }
      catch (e) { /* logging must never break the run */ }
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ans = readAnswer(answerDir, short);
      if (ans) {
        stats.answered++;
        return shape(ans, call);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "LLM BRIDGE TIMEOUT — no answer for prompt " + short + " after "
          + Math.round(timeoutMs / 1000) + "s.\n"
          + "  prompt:  " + pFile + "\n"
          + "  write:   " + path.join(answerDir, short + ".txt") + "\n"
          + "  head:    " + String(call.userMessage || "").slice(0, 160));
      }
      parkMs(pollMs);
    }
  }

  function shape(ans, call) {
    return {
      text: ans.text,
      tokensIn: 0,
      tokensOut: ans.tokensOut || 0,
      stopReason: ans.stopReason || "stop",
      model: call.model || "bridge",
      provider: "bridge",
    };
  }

  bridge.stats = stats;
  bridge.pendingDir = pendingDir;
  bridge.answerDir = answerDir;
  return bridge;
}
