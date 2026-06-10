// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// stageLogger — Per-stage structured event log
//
// Each pipeline node receives a `services.logger` instance scoped to
// the stage it's running. Nodes (and the helpers they call) push
// structured events to the logger; runStage.js attaches the resulting
// event array to the stage's result so the GUI Log panel can render it.
//
// EVENT TYPES (Q1 — user-configurable filter):
//
//   "llm"        — an LLM call:
//                   { ts, type: "llm", iter, model, provider,
//                     systemPrompt, userMessage, response,
//                     tokensIn, tokensOut, latencyMs, startedAtMs, endedAtMs,
//                     promptTruncated: bool, responseTruncated: bool }
//   "cli"        — a CLI/backend command execution:
//                   { ts, type: "cli", command, files: { name: size },
//                     stdout, stderr, exitCode, latencyMs }
//   "skill"      — a skill overlay was applied:
//                   { ts, type: "skill", skillId, mode, stageKey }
//   "prompt"     — a prompt override took effect:
//                   { ts, type: "prompt", stageKey, sectionCount, mode }
//   "state"      — a notable state transition (iter increment, loopback, etc.):
//                   { ts, type: "state", message, iter? }
//   "result"     — final stage outcome (status, brief summary):
//                   { ts, type: "result", status, summary }
//
// Each entry carries `ts` (Date.now() at emit time). Entries also carry
// `iter` when applicable so the user can filter by iteration in the
// Log panel.
//
// TRUNCATION (Q4):
//   The `llm` event's systemPrompt / userMessage / response fields are
//   stored full, but the logger marks `promptTruncated` and
//   `responseTruncated` flags as a hint to the UI: render truncated by
//   default with a "show full" toggle. We don't truncate at capture
//   time so re-downloading with json format yields complete data.
// ═══════════════════════════════════════════════════════════════════════════

const TRUNCATION_LIMIT = 200;

/**
 * Create a logger scoped to one stage run. Returns an object with
 * .emit(event) and .events (the accumulated array).
 *
 * Nodes call logger.llm({...}), logger.cli({...}), etc. — convenience
 * helpers that fill in the `type` field and `ts` automatically.
 *
 * `context` carries nesting metadata. When judge triggers a downstream stage
 * as part of its K-to-X reflow, runStage
 * passes a context like { depth: 1, parentStageKey: "judge",
 * parentIter: 2 }. The logger stamps these onto every event so the
 * trace panel can reconstruct the hierarchy from a flat event list.
 *
 *   depth=0          — top-level stage run (outside any judge loop)
 *   depth=1          — inside a judge iteration
 *   depth=2          — inside a nested per-stage loop (lint fix-loop
 *                      inside a judge reflow, for instance)
 *
 * `parentIter` is the judge iteration that owns this run; `parentStageKey`
 * names the stage whose loop spawned this run ("judge" for K-to-X
 * triggers, or e.g. "lint" for an in-stage fix-loop sub-iter).
 */
export function createStageLogger(stageKey, context, onEmit) {
  const ctx = context || {};
  const emit = (typeof onEmit === "function") ? onEmit : null;
  const events = [];
  function push(type, payload) {
    const ts = Date.now();
    const entry = Object.assign({
      ts: ts,
      type: type,
      // Nesting fields default to depth=0 when no context is provided so
      // context-free call sites keep working.
      depth:          ctx.depth          == null ? 0    : ctx.depth,
      parentStageKey: ctx.parentStageKey || null,
      parentIter:     ctx.parentIter     == null ? null : ctx.parentIter,
    }, payload || {});
    events.push(entry);
    // Live progress hook. When the orchestrator (runStage) wires an onEmit
    // callback, fire it for every event so the UI can render in-flight progress
    // while the stage is running.
    // Default behavior unchanged when no callback supplied.
    if (emit) {
      try { emit(entry); }
      catch (_) { /* progress emission must never break logging */ }
    }
    return entry;
  }
  return {
    stageKey: stageKey,
    context:  ctx,
    events:   events,
    emit(type, payload) { return push(type, payload); },
    llm(payload) {
      // Flag truncation needs so the UI can render compact rows by
      // default. Both prompt fields are checked because some calls
      // have a tiny system prompt + long user message and vice versa.
      const sp = payload.systemPrompt || "";
      const um = payload.userMessage  || "";
      const r  = payload.response     || "";
      const promptLen = sp.length + um.length;
      const respLen = r.length;
      return push("llm", Object.assign({}, payload, {
        promptTruncated:   promptLen > TRUNCATION_LIMIT,
        responseTruncated: respLen > TRUNCATION_LIMIT,
      }));
    },
    cli(payload) { return push("cli", payload); },
    skill(payload) { return push("skill", payload); },
    prompt(payload) { return push("prompt", payload); },
    state(payload) { return push("state", payload); },
    result(payload) { return push("result", payload); },
  };
}

/**
 * No-op logger used when running unit tests or nodes outside a real
 * orchestrator. All methods are present so call sites can use it
 * unconditionally without null checks.
 */
export function nullLogger() {
  const empty = [];
  return {
    stageKey: null,
    events: empty,
    emit() { return null; },
    llm() { return null; },
    cli() { return null; },
    skill() { return null; },
    prompt() { return null; },
    state() { return null; },
    result() { return null; },
  };
}

/**
 * Serialize a log to plain .log text.
 *
 * Format:
 *   • One HEADER line per event: timestamp + [TYPE] + summary fields.
 *   • For events with rich content (LLM prompts/responses, CLI stdout/
 *     stderr), CONTINUATION LINES follow, indented 4 spaces, with a
 *     ">" margin to make them visually distinct from headers. Each
 *     content block is prefixed by a labeled separator line.
 *
 * Example output:
 *   [2026-05-16T14:23:01.123Z] [LLM]    iter=2  model=claude-sonnet-4  tokensIn=1200  tokensOut=850  latencyMs=3200
 *       ┌─ System Prompt ─
 *       > You are an RTL designer...
 *       > Generate clean SystemVerilog code...
 *       ┌─ User Message ─
 *       > Implement a synchronous FIFO with parameterizable depth.
 *       ┌─ Response ─
 *       > {"code": "module sync_fifo (clk, rst_n, ...);"}
 *   [2026-05-16T14:23:08.451Z] [CLI]    cmd=verilator --binary ...  exit=0  latencyMs=4100
 *       ┌─ stdout ─
 *       > Simulation complete.
 *       > Line coverage: 92%
 *
 * This matches the user spec answer (Q2): "Indented continuation lines
 * after the header line" — preserves grep-ability of the header lines
 * while still including the full content the GUI shows.
 */
export function logToText(events) {
  const lines = [];
  for (const e of events) {
    const ts = new Date(e.ts).toISOString();
    const typeLabel = "[" + e.type.toUpperCase() + "]";
    const pad = "       ".slice(typeLabel.length);
    let main = "";
    if (e.type === "llm") {
      main = "iter=" + (e.iter != null ? e.iter : "-") +
        "  model=" + (e.model || "?") +
        "  tokensIn=" + (e.tokensIn != null ? e.tokensIn : "—") +
        "  tokensOut=" + (e.tokensOut != null ? e.tokensOut : "—") +
        "  latencyMs=" + (e.latencyMs != null ? e.latencyMs : "—");
    } else if (e.type === "cli") {
      const cmdShort = (e.command || "").length > 120
        ? e.command.slice(0, 117) + "..."
        : e.command;
      main = "cmd=" + cmdShort +
        "  exit=" + (e.exitCode != null ? e.exitCode : "—") +
        "  latencyMs=" + (e.latencyMs != null ? e.latencyMs : "—");
    } else if (e.type === "skill") {
      main = "skillId=" + (e.skillId || "?") + "  mode=" + (e.mode || "?");
    } else if (e.type === "prompt") {
      main = "stage=" + (e.stageKey || "?") +
        "  sections=" + (e.sectionCount || 0) +
        "  mode=" + (e.mode || "?");
    } else if (e.type === "state") {
      main = (e.iter != null ? "iter=" + e.iter + "  " : "") + (e.message || "");
    } else if (e.type === "result") {
      main = "status=" + (e.status || "?") + "  " + (e.summary || "");
    }
    lines.push("[" + ts + "] " + typeLabel + pad + main);

    // Full prompt/response/stdout content as indented continuation lines.
    // We emit a labeled section header
    // ("┌─ <label> ─") and then prefix each content line with "    > ".
    if (e.type === "llm") {
      pushContent(lines, "System Prompt", e.systemPrompt);
      pushContent(lines, "User Message",  e.userMessage);
      pushContent(lines, "Response",      e.response);
    } else if (e.type === "cli") {
      pushContent(lines, "stdout", e.stdout);
      pushContent(lines, "stderr", e.stderr);
    }
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

/**
 * Append a labeled content block to `lines` as indented continuation
 * lines (4-space indent + "> " prefix). Empty/null content is skipped
 * so the .log doesn't bloat with empty blocks. Multi-line content has
 * every line prefixed individually.
 */
function pushContent(lines, label, content) {
  if (!content || typeof content !== "string") return;
  if (content.length === 0) return;
  lines.push("    ┌─ " + label + " ─");
  const contentLines = content.split("\n");
  for (const ln of contentLines) {
    lines.push("    > " + ln);
  }
}

/**
 * Serialize a log to structured .json. Pretty-printed (2-space indent)
 * for human readability while still being machine-parseable.
 */
export function logToJson(events) {
  return JSON.stringify(events, null, 2);
}
