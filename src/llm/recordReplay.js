// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// recordReplay — deterministic LLM fixtures for pipeline regression (roadmap #5)
//
// Record one good run per bench spec into JSON fixtures, then replay them in
// CI: prompt/parsing/wiring regressions become catchable without a model, a
// network, or LM Studio's flakiness. Calls are keyed by a sha256 of
// system + user + model; a replay MISS fails loudly (callLLM throws with the
// prompt head) — a changed prompt is the regression signal, and the assertion
// tells you to re-record or bless the change.
//
// NODE-ONLY (node:crypto / node:fs) — imported by the CLI and tests, and
// deliberately NOT exported from the browser-bundled src/llm/index.js barrel.
// The callLLM hooks themselves (config._llmTap / config._llmReplay) are plain
// injected functions, so the bundled code never touches this file.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Stable fixture key for one call. */
export function promptHash(call) {
  return crypto.createHash("sha256")
    .update(call.systemPrompt || "", "utf8").update("\x1f")
    .update(call.userMessage || "", "utf8").update("\x1f")
    .update(call.model || "", "utf8")
    .digest("hex");
}

/**
 * Recorder: returns a config._llmTap that writes one fixture per call to
 * `dir/<seq>-<hash8>.json`. Re-recording the same prompt overwrites (the last
 * response wins — recordings should be made with temp 0 / a pinned seed).
 */
export function createLLMRecorder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let seq = 0;
  const seen = new Map();   // hash → filename (dedupe re-asks of the same prompt)
  return function tap(rec) {
    const hash = promptHash(rec);
    let file = seen.get(hash);
    if (!file) {
      seq++;
      file = String(seq).padStart(3, "0") + "-" + hash.slice(0, 8) + ".json";
      seen.set(hash, file);
    }
    fs.writeFileSync(path.join(dir, file), JSON.stringify({
      hash,
      model: rec.model,
      provider: rec.provider,
      systemPrompt: rec.systemPrompt,
      userMessage: rec.userMessage,
      response: rec.response,
    }, null, 2));
  };
}

/**
 * Replayer: returns a config._llmReplay resolving calls from the fixtures in
 * `dir`. A miss returns null → callLLM throws the loud REPLAY MISS (by
 * design). `stats.misses` collects miss heads for diagnostics.
 */
export function createReplayLLM(dir) {
  const byHash = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    byHash.set(rec.hash, rec);
  }
  const stats = { hits: 0, misses: [] };
  function replay(call) {
    const rec = byHash.get(promptHash(call));
    if (!rec) {
      stats.misses.push({ model: call.model, head: String(call.userMessage || "").slice(0, 160) });
      return null;
    }
    stats.hits++;
    return {
      text: rec.response.text,
      tokensIn: rec.response.tokensIn || 0,
      tokensOut: rec.response.tokensOut || 0,
      stopReason: rec.response.stopReason || "stop",
      model: rec.model,
      provider: rec.provider || "replay",
    };
  }
  replay.stats = stats;
  replay.size = byHash.size;
  return replay;
}
