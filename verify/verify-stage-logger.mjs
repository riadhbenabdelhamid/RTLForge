// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// verify-stage-logger — Per-stage event log
//
// Pins the structured-event capture, the .log / .json serializers, and
// the truncation-flag semantics.
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") await r;
    process.stdout.write("  \u001b[32m✓\u001b[0m " + name + "\n");
    passed++;
  } catch (e) {
    process.stdout.write("  \u001b[31m✗\u001b[0m " + name + "  →  " + (e.message || e) + "\n");
    failures.push({ name, message: e.message || String(e) });
  }
}

const { createStageLogger, nullLogger, logToText, logToJson } =
  await import("../src/projectState/stageLogger.js");

console.log("\n[stageLogger — event capture]");

await check("createStageLogger: empty initial state", () => {
  const lg = createStageLogger("lint");
  assert.equal(lg.stageKey, "lint");
  assert.deepEqual(lg.events, []);
});

await check("llm event: captures all fields + adds ts and type", () => {
  const lg = createStageLogger("rtl_generate");
  lg.llm({
    iter: 1, model: "claude-sonnet-4", provider: "anthropic",
    systemPrompt: "sys",
    userMessage: "make me a fifo",
    response: '{"code":"module foo;"}',
    tokensIn: 100, tokensOut: 50, latencyMs: 800,
    startedAtMs: 1000, endedAtMs: 1800,
  });
  assert.equal(lg.events.length, 1);
  const e = lg.events[0];
  assert.equal(e.type, "llm");
  assert.equal(e.iter, 1);
  assert.equal(e.tokensIn, 100);
  assert.ok(typeof e.ts === "number");
  // Both prompt and response are SHORT (under truncation limit)
  assert.equal(e.promptTruncated, false);
  assert.equal(e.responseTruncated, false);
});

await check("llm event: long systemPrompt + userMessage → promptTruncated=true", () => {
  const lg = createStageLogger("verify");
  lg.llm({
    systemPrompt: "x".repeat(150),     // 150 + 100 = 250 chars total prompt > 200 limit
    userMessage:  "y".repeat(100),
    response:     "ok",
    tokensIn: 50, tokensOut: 1, latencyMs: 100,
  });
  const e = lg.events[0];
  assert.equal(e.promptTruncated, true,  "combined prompt over 200 chars should mark truncated");
  assert.equal(e.responseTruncated, false);
});

await check("llm event: long response → responseTruncated=true", () => {
  const lg = createStageLogger("verify");
  lg.llm({
    systemPrompt: "sys", userMessage: "u",
    response: "z".repeat(500),
  });
  const e = lg.events[0];
  assert.equal(e.promptTruncated, false);
  assert.equal(e.responseTruncated, true);
});

await check("cli event: stores command + stdout + stderr + exitCode", () => {
  const lg = createStageLogger("verify");
  lg.cli({
    command: "verilator --binary --coverage foo.sv",
    stdout: "Simulation complete.",
    stderr: "",
    exitCode: 0,
    latencyMs: 4200,
  });
  const e = lg.events[0];
  assert.equal(e.type, "cli");
  assert.equal(e.exitCode, 0);
  assert.equal(e.latencyMs, 4200);
});

await check("skill, prompt, state, result events emit correctly", () => {
  const lg = createStageLogger("lint");
  lg.skill({ skillId: "rtl-style", mode: "append", stageKey: "lint" });
  lg.prompt({ stageKey: "lint", sectionCount: 6, mode: "append" });
  lg.state({ iter: 2, message: "iter increment → fix loop" });
  lg.result({ status: "PASS", summary: "lint clean after 2 iters" });
  assert.equal(lg.events.length, 4);
  assert.equal(lg.events[0].type, "skill");
  assert.equal(lg.events[1].type, "prompt");
  assert.equal(lg.events[2].type, "state");
  assert.equal(lg.events[3].type, "result");
});

await check("nullLogger: no-op methods, empty events", () => {
  const lg = nullLogger();
  lg.llm({ foo: "bar" });
  lg.cli({ exitCode: 0 });
  assert.equal(lg.events.length, 0);
});

console.log("\n[stageLogger — serializers]");

await check("logToText: one line per event, ISO timestamps, type labels", () => {
  const events = [
    { ts: Date.UTC(2026, 0, 1, 12, 0, 0), type: "llm", iter: 1, model: "x",
      tokensIn: 100, tokensOut: 50, latencyMs: 800 },
    { ts: Date.UTC(2026, 0, 1, 12, 0, 5), type: "cli",
      command: "verilator foo.sv", exitCode: 0, latencyMs: 1000 },
  ];
  const out = logToText(events);
  const lines = out.split("\n").filter(function(l) { return l.length > 0; });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[2026-01-01T12:00:00\.000Z\].*\[LLM\].*iter=1.*tokensIn=100/);
  assert.match(lines[1], /\[CLI\].*verilator foo\.sv.*exit=0/);
});

await check("logToText: handles state and result entries", () => {
  const events = [
    { ts: 1000, type: "state", iter: 3, message: "loop-back to rtl_generate" },
    { ts: 2000, type: "result", status: "FAIL", summary: "3 criteria below threshold" },
  ];
  const out = logToText(events);
  assert.match(out, /\[STATE\].*iter=3.*loop-back to rtl_generate/);
  assert.match(out, /\[RESULT\].*status=FAIL.*3 criteria below threshold/);
});

await check("logToText: truncates long CLI commands to 120 chars + ellipsis", () => {
  const events = [
    { ts: 1000, type: "cli",
      command: "verilator " + "--very-long-flag ".repeat(20),
      exitCode: 0 },
  ];
  const out = logToText(events);
  // Look for the ellipsis marker — exact length depends on the truncation point
  assert.match(out, /\.\.\./);
});

await check("logToText: empty events array → empty string", () => {
  assert.equal(logToText([]), "");
});

await check("logToJson: pretty-printed, machine-parseable", () => {
  const events = [
    { ts: 1000, type: "llm", iter: 1, tokensIn: 100 },
  ];
  const out = logToJson(events);
  // 2-space indent
  assert.match(out, /^\[\n  \{/);
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "llm");
  assert.equal(parsed[0].tokensIn, 100);
});

await check("logToJson: preserves ALL fields including full prompt text", () => {
  const lg = createStageLogger("rtl_generate");
  lg.llm({
    systemPrompt: "x".repeat(150),
    userMessage:  "y".repeat(100),
    response:     "z".repeat(500),
    tokensIn: 100, tokensOut: 50,
  });
  const out = logToJson(lg.events);
  const parsed = JSON.parse(out);
  // Full text preserved despite truncation flags
  assert.equal(parsed[0].systemPrompt.length, 150);
  assert.equal(parsed[0].userMessage.length, 100);
  assert.equal(parsed[0].response.length, 500);
  // Truncation flags also serialized
  assert.equal(parsed[0].promptTruncated, true);
  assert.equal(parsed[0].responseTruncated, true);
});

// Plain .log includes full content as indented
// continuation lines after each header.
await check("logToText: LLM event emits System Prompt / User Message / Response continuation blocks", () => {
  const events = [
    { ts: Date.UTC(2026, 0, 1, 12, 0, 0), type: "llm", iter: 1,
      model: "claude-sonnet-4", tokensIn: 100, tokensOut: 50, latencyMs: 800,
      systemPrompt: "You are a helpful assistant.",
      userMessage:  "Generate a FIFO.",
      response:     '{"code": "module fifo;"}',
    },
  ];
  const out = logToText(events);
  // Header line still present
  assert.match(out, /\[LLM\].*iter=1/);
  // Section markers present
  assert.match(out, /┌─ System Prompt ─/);
  assert.match(out, /┌─ User Message ─/);
  assert.match(out, /┌─ Response ─/);
  // Each content line indented with "    > "
  assert.match(out, /    > You are a helpful assistant\./);
  assert.match(out, /    > Generate a FIFO\./);
  assert.match(out, /    > \{"code": "module fifo;"\}/);
});

await check("logToText: CLI event emits stdout/stderr continuation blocks", () => {
  const events = [
    { ts: Date.UTC(2026, 0, 1, 12, 0, 0), type: "cli",
      command: "verilator --binary foo.sv",
      stdout: "Simulation complete.\nLine coverage: 92%",
      stderr: "warning: blah",
      exitCode: 0, latencyMs: 4100,
    },
  ];
  const out = logToText(events);
  // Header still present
  assert.match(out, /\[CLI\].*verilator/);
  // Section markers
  assert.match(out, /┌─ stdout ─/);
  assert.match(out, /┌─ stderr ─/);
  // Multi-line stdout: each line gets its own ">" prefix
  assert.match(out, /    > Simulation complete\./);
  assert.match(out, /    > Line coverage: 92%/);
  assert.match(out, /    > warning: blah/);
});

await check("logToText: empty content blocks are skipped (no orphan section headers)", () => {
  const events = [
    { ts: 1000, type: "llm", iter: 1, model: "x", tokensIn: 10, tokensOut: 5, latencyMs: 100,
      systemPrompt: "", userMessage: "ask", response: "" },
  ];
  const out = logToText(events);
  // Should NOT include "System Prompt" or "Response" section since both empty
  assert.equal(out.indexOf("System Prompt"), -1, "empty systemPrompt should be skipped");
  assert.equal(out.indexOf("Response"), -1, "empty response should be skipped");
  // But User Message section IS present
  assert.match(out, /┌─ User Message ─/);
  assert.match(out, /    > ask/);
});

await check("logToText: state/skill/prompt/result events have NO continuation block", () => {
  const events = [
    { ts: 1000, type: "state",  iter: 2, message: "iter increment" },
    { ts: 1001, type: "skill",  skillId: "rtl-style", mode: "append" },
    { ts: 1002, type: "prompt", stageKey: "lint", sectionCount: 6, mode: "append" },
    { ts: 1003, type: "result", status: "PASS", summary: "ok" },
  ];
  const out = logToText(events);
  // Header lines present
  assert.match(out, /\[STATE\]/);
  assert.match(out, /\[SKILL\]/);
  assert.match(out, /\[PROMPT\]/);
  assert.match(out, /\[RESULT\]/);
  // No "┌─" continuation markers (those events have no rich content)
  assert.equal(out.indexOf("┌─"), -1);
});

// Logger context (depth + parentIter + parentStageKey)
console.log("\n[stageLogger — nesting context]");

await check("logger without context: events default to depth=0, parent=null", () => {
  const lg = createStageLogger("lint");
  lg.llm({ tokensIn: 100 });
  const e = lg.events[0];
  assert.equal(e.depth, 0);
  assert.equal(e.parentStageKey, null);
  assert.equal(e.parentIter, null);
});

await check("logger with context: stamps depth + parentIter on every event", () => {
  const lg = createStageLogger("lint", {
    depth: 2, parentStageKey: "judge", parentIter: 3,
  });
  lg.llm({ tokensIn: 100 });
  lg.cli({ command: "verilator foo.sv", exitCode: 0 });
  lg.state({ iter: 1, message: "lint iter 1/3" });
  assert.equal(lg.events.length, 3);
  for (const e of lg.events) {
    assert.equal(e.depth, 2);
    assert.equal(e.parentStageKey, "judge");
    assert.equal(e.parentIter, 3);
  }
});

await check("logger context: depth=1 represents inside-judge but top-level stage run", () => {
  const lg = createStageLogger("verify", {
    depth: 1, parentStageKey: "judge", parentIter: 2,
  });
  lg.cli({ command: "verilator", exitCode: 0 });
  assert.equal(lg.events[0].depth, 1);
});

await check("logger context: per-event payload can override stamped fields when needed", () => {
  const lg = createStageLogger("lint", { depth: 1, parentStageKey: "judge", parentIter: 1 });
  // The order of Object.assign means payload fields TAKE PRECEDENCE.
  // This is intentional: a node that needs to attribute a sub-event
  // to a deeper depth (e.g. a fix-loop within a fix-loop, theoretical)
  // can specify it on the payload itself.
  lg.emit("state", { depth: 5, message: "manually overridden" });
  assert.equal(lg.events[0].depth, 5);
});

await check("nullLogger has no context method but doesn't crash", () => {
  const lg = nullLogger();
  lg.llm({ tokensIn: 100, depth: 99 });
  // Events still empty (no-op logger)
  assert.equal(lg.events.length, 0);
});

console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failures.length);
console.log("  Status: " + (failures.length === 0 ? "ALL PASS ✓" : "FAILURES"));
console.log("═══════════════════════════════════════");
if (failures.length > 0) process.exit(1);
