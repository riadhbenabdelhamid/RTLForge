// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// verify-term — Standalone verifier for src/term/* modules
//
// Following the same pattern as verify.mjs / verify-rtlforge.mjs:
//   - No vitest dependency; runs with `node verify-term.mjs`
//   - One file per concern, all asserts collected, exit code reports total
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

// ─── Setup: redirect RTLFORGE_HOME for every config/storage test ─────────
const TMP = path.join(os.tmpdir(), "rtlforge-verify-term-" + process.pid);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.RTLFORGE_HOME = TMP;
delete process.env.NO_COLOR;
delete process.env.RTLFORGE_PROVIDER;
delete process.env.RTLFORGE_MODEL;
delete process.env.RTLFORGE_BACKEND_URL;
delete process.env.RTLFORGE_MAX_LINT_ITERS;
delete process.env.RTLFORGE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

// ═══════════════════════════════════════════════════════════════════════════
// argv parser
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[argv]");
const { parseArgs } = await import("../src/term/argv.js");

await check("parseArgs: positional only", () => {
  const a = parseArgs(["a", "b", "c"]);
  assert.deepEqual(a._, ["a", "b", "c"]);
});
await check("parseArgs: --name=value", () => {
  const a = parseArgs(["--provider=openai"]);
  assert.equal(a.provider, "openai");
});
await check("parseArgs: --name value (next token)", () => {
  const a = parseArgs(["--model", "claude-sonnet-4-5"]);
  assert.equal(a.model, "claude-sonnet-4-5");
});
await check("parseArgs: bool flag declared", () => {
  const a = parseArgs(["--no-checkpoint", "extra"], { boolFlags: ["no-checkpoint"] });
  assert.equal(a["no-checkpoint"], true);
  assert.deepEqual(a._, ["extra"]);
});
await check("parseArgs: short alias", () => {
  const a = parseArgs(["-p", "fifo01"], { aliases: { p: "project" } });
  assert.equal(a.project, "fifo01");
});
await check("parseArgs: -- separator preserves positional", () => {
  const a = parseArgs(["run", "--", "--not-a-flag", "a"]);
  assert.deepEqual(a._, ["run", "--not-a-flag", "a"]);
});
await check("parseArgs: undeclared boolean does NOT eat next subcommand-looking token", () => {
  // Edge: `rtlforge run --resume xyz` — resume is not declared bool, so it
  // picks up `xyz` as its value (correct). But `rtlforge --help status`
  // should treat --help as bool, not consume "status".
  const a = parseArgs(["--help", "status"], { boolFlags: ["help"] });
  assert.equal(a.help, true);
  assert.deepEqual(a._, ["status"]);
});
await check("parseArgs: numeric value for non-bool flag", () => {
  const a = parseArgs(["--maxLintIters", "5"]);
  assert.equal(a.maxLintIters, "5");  // we don't auto-coerce here
});

// ═══════════════════════════════════════════════════════════════════════════
// config
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[config]");
const cfgMod = await import("../src/term/config.js");
const { loadConfig, saveUserConfig, saveApiKey, loadApiKey, userConfigPath, userAuthPath, _internal } = cfgMod;

await check("config: rtlforgeHome honours RTLFORGE_HOME", () => {
  assert.equal(cfgMod.rtlforgeHome(), TMP);
});

await check("config: defaults when no file exists", () => {
  const c = loadConfig({ skipFiles: false });
  assert.equal(c.provider, "anthropic");
  assert.equal(c.maxLintIters, 3);
  assert.equal(c.optionalStages.lint, true);
});

await check("config: env override applies", () => {
  process.env.RTLFORGE_PROVIDER = "openai";
  process.env.RTLFORGE_MAX_LINT_ITERS = "7";
  const c = loadConfig();
  assert.equal(c.provider, "openai");
  assert.equal(c.maxLintIters, 7);
  delete process.env.RTLFORGE_PROVIDER;
  delete process.env.RTLFORGE_MAX_LINT_ITERS;
});

await check("config: STRICT_CLI parses true/false", () => {
  process.env.RTLFORGE_STRICT_CLI = "false";
  const c1 = loadConfig({ skipFiles: true });
  assert.equal(c1.strictCli, false);
  process.env.RTLFORGE_STRICT_CLI = "1";
  const c2 = loadConfig({ skipFiles: true });
  assert.equal(c2.strictCli, true);
  delete process.env.RTLFORGE_STRICT_CLI;
});

await check("config: flags override env override file", () => {
  process.env.RTLFORGE_PROVIDER = "openai";
  const c = loadConfig({ flags: { provider: "ollama" } });
  assert.equal(c.provider, "ollama");
  delete process.env.RTLFORGE_PROVIDER;
});

await check("config: optionalStages merges deeply (env + file + defaults)", () => {
  // Save a partial optionalStages override, ensure defaults survive
  saveUserConfig({ optionalStages: { formal_props: true } });
  const c = loadConfig();
  assert.equal(c.optionalStages.formal_props, true);    // overridden
  assert.equal(c.optionalStages.lint, true);            // default kept
  fs.unlinkSync(userConfigPath());
});

await check("config: saveUserConfig strips apiKey defensively", () => {
  saveUserConfig({ provider: "anthropic", apiKey: "should-not-persist" });
  const raw = fs.readFileSync(userConfigPath(), "utf8");
  assert.ok(!raw.includes("should-not-persist"), "apiKey leaked into config.json");
  fs.unlinkSync(userConfigPath());
});

await check("config: saveApiKey writes auth.json mode 0600", () => {
  saveApiKey("anthropic", "sk-test-key-12345");
  const stat = fs.statSync(userAuthPath());
  // On unix, the lower 9 bits of mode are the permission bits.
  // On Windows, modes don't map perfectly; only enforce on POSIX.
  if (process.platform !== "win32") {
    const perms = stat.mode & 0o777;
    assert.equal(perms, 0o600, "auth.json permissions = " + perms.toString(8) + ", want 0600");
  }
  assert.equal(loadApiKey("anthropic"), "sk-test-key-12345");
  fs.unlinkSync(userAuthPath());
});

await check("config: loadApiKey precedence env > auth.json", () => {
  saveApiKey("anthropic", "from-file");
  process.env.ANTHROPIC_API_KEY = "from-env";
  assert.equal(loadApiKey("anthropic"), "from-env");
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(loadApiKey("anthropic"), "from-file");
  fs.unlinkSync(userAuthPath());
});

await check("config: RTLFORGE_API_KEY beats provider-specific env", () => {
  process.env.ANTHROPIC_API_KEY = "anthropic-specific";
  process.env.RTLFORGE_API_KEY  = "agnostic";
  assert.equal(loadApiKey("anthropic"), "agnostic");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.RTLFORGE_API_KEY;
});

await check("config: missing API key returns null", () => {
  assert.equal(loadApiKey("anthropic"), null);
});

await check("config: mergeConfig two-level shallow", () => {
  const m = _internal.mergeConfig(
    { a: 1, optionalStages: { lint: true, formal_props: false } },
    { b: 2, optionalStages: { formal_props: true } },
  );
  assert.deepEqual(m, { a: 1, b: 2, optionalStages: { lint: true, formal_props: true } });
});

// ═══════════════════════════════════════════════════════════════════════════
// fsStorage
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[fsStorage]");
const { createFsStorage, defaultProjectsDir } = await import("../src/term/fsStorage.js");

await check("fsStorage: defaultProjectsDir under RTLFORGE_HOME", () => {
  assert.equal(defaultProjectsDir(), path.join(TMP, "projects"));
});

await check("fsStorage: set + get roundtrips", async () => {
  const s = createFsStorage(path.join(TMP, "fs1"));
  await s.set("rtlforge:project:abc", '{"hello":"world"}');
  const r = await s.get("rtlforge:project:abc");
  assert.equal(r.value, '{"hello":"world"}');
});

await check("fsStorage: get on missing key throws", async () => {
  const s = createFsStorage(path.join(TMP, "fs2"));
  let threw = false;
  try { await s.get("nope"); } catch (e) { threw = /Key not found/.test(e.message); }
  assert.equal(threw, true);
});

await check("fsStorage: list filters by prefix and excludes .tmp", async () => {
  const dir = path.join(TMP, "fs3");
  const s = createFsStorage(dir);
  await s.set("rtlforge:project:a", "1");
  await s.set("rtlforge:project:b", "2");
  await s.set("other:key", "3");
  // Plant a stray .tmp to prove it's filtered
  fs.writeFileSync(path.join(dir, "junk.tmp"), "incomplete");
  const r = await s.list("rtlforge:project:");
  assert.deepEqual(r.keys.sort(), ["rtlforge:project:a", "rtlforge:project:b"]);
});

await check("fsStorage: delete removes the file", async () => {
  const s = createFsStorage(path.join(TMP, "fs4"));
  await s.set("k", "v");
  const d1 = await s.delete("k");
  assert.equal(d1.deleted, true);
  const d2 = await s.delete("k");  // already gone
  assert.equal(d2.deleted, false);
});

await check("fsStorage: atomic write — no partial file on success", async () => {
  const dir = path.join(TMP, "fs5");
  const s = createFsStorage(dir);
  await s.set("rtlforge:project:atom", "abc");
  // .tmp shouldn't survive a successful write
  const lingering = fs.readdirSync(dir).filter(function(f) { return f.endsWith(".tmp"); });
  assert.deepEqual(lingering, []);
});

await check("fsStorage: rejects non-string values", async () => {
  const s = createFsStorage(path.join(TMP, "fs6"));
  let threw = false;
  try { await s.set("k", { not: "a string" }); }
  catch (e) { threw = /must be a string/.test(e.message); }
  assert.equal(threw, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// format helpers
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[format]");
process.env.NO_COLOR = "1";
const { c, ICON, pad, table, duration, indent } = await import("../src/term/format.js?nocolor");

await check("format: NO_COLOR suppresses ANSI", () => {
  // c.green should return raw text when NO_COLOR is set
  assert.equal(c.green("hi"), "hi");
});

await check("format: pad left and right", () => {
  assert.equal(pad("a", 5),         "a    ");
  assert.equal(pad("a", 5, "right"), "    a");
});

await check("format: pad truncates with ellipsis", () => {
  assert.equal(pad("abcdefgh", 4), "abc…");
});

await check("format: duration humanizes", () => {
  assert.equal(duration(500), "500ms");
  assert.equal(duration(2500), "2.5s");
  assert.equal(duration(125_000), "2m 5s");
});

await check("format: indent prefixes every line", () => {
  assert.equal(indent("a\nb", 2), "  a\n  b");
});

await check("format: ICON returns plain ASCII when NO_COLOR", () => {
  assert.equal(ICON.ok(), "✓");
  assert.equal(ICON.fail(), "✗");
});

await check("format: table renders with headers, separator, rows", () => {
  const out = table([
    { key: "name", label: "Name" },
    { key: "qty",  label: "Qty", align: "right" },
  ], [
    { name: "fifo", qty: 4 },
    { name: "ram",  qty: 16 },
  ]);
  assert.match(out, /Name.*Qty/);
  assert.match(out, /fifo.*4/);
  assert.match(out, /ram.*16/);
});

delete process.env.NO_COLOR;

// ═══════════════════════════════════════════════════════════════════════════
// progress renderer
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[progress]");
process.env.NO_COLOR = "1";
const { createProgressRenderer } = await import("../src/term/progress.js?p1");

function fakeStream() {
  const lines = [];
  return {
    isTTY: false,
    write(chunk) { lines.push(String(chunk)); return true; },
    get text() { return lines.join(""); },
  };
}

await check("progress: non-TTY prints one line per transition", () => {
  const stream = fakeStream();
  const stages = [{ id: 1, label: "Elicit" }, { id: 2, label: "Spec" }];
  const p = createProgressRenderer(stages, { stream: stream });
  p.start(1);
  p.finish(1, "ok");
  p.start(2);
  p.finish(2, "fail", "syntax error");
  // Should be 4 lines (one per transition), no cursor codes.
  const lines = stream.text.split("\n").filter(Boolean);
  assert.equal(lines.length, 4);
  assert.ok(!stream.text.includes("\u001b["));   // no ANSI cursor codes
  assert.match(stream.text, /Elicit/);
  assert.match(stream.text, /syntax error/);
});

await check("progress: stateOf reports current transition state", () => {
  const stages = [{ id: 1, label: "Elicit" }];
  const p = createProgressRenderer(stages, { stream: fakeStream() });
  assert.equal(p.stateOf(1).state, "pending");
  p.start(1);
  assert.equal(p.stateOf(1).state, "running");
  p.finish(1, "ok");
  assert.equal(p.stateOf(1).state, "ok");
});

await check("progress: tty mode emits cursor-up before redraw", () => {
  const stream = fakeStream();
  const stages = [{ id: 1, label: "Elicit" }, { id: 2, label: "Spec" }];
  const p = createProgressRenderer(stages, { stream: stream, tty: true });
  p.paint();
  p.start(1);
  // Second paint should include the cursor-up sequence \u001b[<n>A
  assert.ok(stream.text.includes("\u001b["), "expected ANSI cursor codes in TTY mode");
});

await check("progress: _buildLines reflects state colorlessly under NO_COLOR", () => {
  const stages = [{ id: 1, label: "A" }, { id: 2, label: "B" }, { id: 3, label: "C" }];
  const p = createProgressRenderer(stages, { stream: fakeStream() });
  p.start(1);
  p.finish(1, "ok");
  p.start(2);
  p.finish(2, "fail");
  p.start(3);
  const lines = p._buildLines();
  assert.equal(lines.length, 3);
  // Per-state icons
  assert.match(lines[0], /✓.*A/);
  assert.match(lines[1], /✗.*B/);
  assert.match(lines[2], /◐.*C/);
});

delete process.env.NO_COLOR;

// ═══════════════════════════════════════════════════════════════════════════
// store — round-trip + runStage with mocked LLM
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[store]");
const { createStore } = await import("../src/term/store.js?s1");
const { createMemoryStorage } = await import("../src/projectState/index.js");

await check("store: ensureModule sets activeModId and seeds entry", () => {
  const s = createStore({ config: { provider: "anthropic" }, storage: createMemoryStorage() });
  s.ensureModule("fifo");
  assert.equal(s.getState().activeModId, "fifo");
  assert.ok(s.activeMod());
});

await check("store: dispatch updates state synchronously and notifies listeners", () => {
  const s = createStore({ config: {}, storage: createMemoryStorage() });
  let calls = 0;
  s.subscribe(function() { calls++; });
  s.dispatch({ type: "MODULE_UPSERT", modId: "x" });
  assert.ok(s.getState().modules.x);
  assert.ok(calls >= 1);
});

await check("store: subscribe returns unsubscribe", () => {
  const s = createStore({ config: {}, storage: createMemoryStorage() });
  let calls = 0;
  const off = s.subscribe(function() { calls++; });
  s.dispatch({ type: "MODULE_UPSERT", modId: "a" });
  off();
  s.dispatch({ type: "MODULE_UPSERT", modId: "b" });
  assert.equal(calls, 1);
});

await check("store: saveCheckpoint then loadCheckpoint preserves state", async () => {
  const storage = createMemoryStorage();
  const s = createStore({ config: { provider: "anthropic", model: "claude-sonnet-4-5" }, storage: storage });
  s.ensureModule("fifo");
  s.dispatch({ type: "MODULE_STAGE_DATA_SET", modId: "fifo", stageId: 4, data: { code: "module fifo; endmodule" } });
  s.dispatch({ type: "MODULE_STAGE_COMPLETE", modId: "fifo", stageId: 4 });
  const okSave = await s.saveCheckpoint();
  assert.equal(okSave, true);

  const s2 = createStore({ config: {}, storage: storage, projectId: s.projectId });
  const loaded = await s2.loadCheckpoint();
  assert.ok(loaded, "loadCheckpoint returned null");
  assert.equal(s2.getState().activeModId, "fifo");
  assert.equal(s2.getState().modules.fifo.stageData[4].code, "module fifo; endmodule");
  assert.ok(s2.getState().modules.fifo.completed.has(4), "completed Set lost across save/load");
  // Config is restored from the checkpoint's uiState half.
  assert.equal(loaded.uiState.config.provider, "anthropic");
});

await check("store: loadCheckpoint returns null for unknown projectId", async () => {
  const s = createStore({ config: {}, storage: createMemoryStorage(), projectId: "definitely-not-saved" });
  const loaded = await s.loadCheckpoint();
  assert.equal(loaded, null);
});

await check("store: listCheckpoints returns the index", async () => {
  const storage = createMemoryStorage();
  const a = createStore({ config: {}, storage: storage, projectId: "test-list-a" });
  a.ensureModule("a");
  await a.saveCheckpoint();
  const b = createStore({ config: {}, storage: storage, projectId: "test-list-b" });
  b.ensureModule("b");
  await b.saveCheckpoint();
  const list = await a.listCheckpoints();
  assert.equal(list.length, 2);
});

// ─── phantom-checkpoint regression ─────────────────────────────────
const CKPT_INDEX_KEY = "rtlforge:checkpoint:_index";

await check("listIndex: filters out entries with no userDesc, no progress, AND no modules", async () => {
  const storage = createMemoryStorage();
  const phantom = {
    projectId: "phantom-1",
    userDesc:  "",
    designMode: "module",
    timestamp:  new Date().toISOString(),
    moduleCount: 0,
    completedStages: 0,
    totalStages: 18,
    furthestStage: "",
  };
  const legit = Object.assign({}, phantom, {
    projectId: "legit-1",
    userDesc:  "an 8-bit fifo",
  });
  await storage.set(CKPT_INDEX_KEY, JSON.stringify([phantom, legit]));
  const s = createStore({ config: {}, storage: storage, projectId: "anything" });
  const list = await s.listCheckpoints();
  assert.equal(list.length, 1, "phantom should be filtered; legit should remain");
  assert.equal(list[0].projectId, "legit-1");
  // Self-healing: re-reading should not re-find the phantom
  const list2 = await s.listCheckpoints();
  assert.equal(list2.length, 1);
});

await check("listIndex: KEEPS entry that has modules but no userDesc (test-only path)", async () => {
  const storage = createMemoryStorage();
  const entry = {
    projectId: "modules-only",
    userDesc:  "",
    designMode: "module",
    timestamp:  new Date().toISOString(),
    moduleCount: 1,
    completedStages: 0,
    totalStages: 18,
    furthestStage: "",
  };
  await storage.set(CKPT_INDEX_KEY, JSON.stringify([entry]));
  const s = createStore({ config: {}, storage: storage, projectId: "anything" });
  const list = await s.listCheckpoints();
  assert.equal(list.length, 1, "module-bearing entries must survive the filter");
});

await check("listIndex: KEEPS entry with completed stages even if userDesc empty", async () => {
  const storage = createMemoryStorage();
  const entry = {
    projectId: "progress-only",
    userDesc:  "",
    designMode: "module",
    timestamp:  new Date().toISOString(),
    moduleCount: 0,
    completedStages: 3,
    totalStages: 18,
    furthestStage: "Architect",
  };
  await storage.set(CKPT_INDEX_KEY, JSON.stringify([entry]));
  const s = createStore({ config: {}, storage: storage, projectId: "anything" });
  const list = await s.listCheckpoints();
  assert.equal(list.length, 1);
});

await check("store: runStage drives a mocked stage end-to-end", async () => {
  const storage = createMemoryStorage();
  // Mock the pipeline by injecting a stub that bypasses the real graph.
  // The real pipeline imports node functions at module level; the cleanest
  // way to test runStage is via the services.pipeline override.
  const fakeRtl = "module fifo; reg [3:0] q; endmodule";
  const fakePipeline = {
    async invokeNode(name, st) {
      if (name === "rtl_generate") {
        return Object.assign({}, st, { rtl_generate: { code: fakeRtl } });
      }
      throw new Error("mock saw unexpected node " + name);
    },
  };
  const s = createStore({
    config: { provider: "anthropic", model: "x", maxLintIters: 3, maxVerifyIters: 3 },
    storage: storage,
    callLLM: async () => ({ text: "{}", tokensIn: 0, tokensOut: 0, latencyMs: 1 }),
  });
  s.ensureModule("fifo");
  await s.runStage({
    stageId: 4, stageKey: "rtl_generate",
    targetModId: "fifo",
    overrideDesc: "an 8-bit fifo",
    services: { pipeline: fakePipeline },
  });
  const sd4 = s.getState().modules.fifo.stageData[4];
  assert.equal(sd4.code, fakeRtl);
  assert.ok(s.getState().modules.fifo.completed.has(4), "stage 4 not marked completed");
});

// ═══════════════════════════════════════════════════════════════════════════
// CLI dispatcher
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[cli]");
const { main } = await import("../src/term/cli.js");

function captureStream(stream) {
  const orig = stream.write.bind(stream);
  let buf = "";
  stream.write = function(chunk) { buf += String(chunk); return true; };
  return { restore: function() { stream.write = orig; }, get text() { return buf; } };
}

await check("cli: help exits 0 and lists commands", async () => {
  const cap = captureStream(process.stdout);
  try {
    const code = await main(["help"]);
    assert.equal(code, 0);
    assert.match(cap.text, /COMMANDS/);
    assert.match(cap.text, /run/);
    assert.match(cap.text, /status/);
  } finally { cap.restore(); }
});

await check("cli: version prints and exits 0", async () => {
  const cap = captureStream(process.stdout);
  try {
    const code = await main(["version"]);
    assert.equal(code, 0);
    assert.match(cap.text, /\d+\.\d+/);
  } finally { cap.restore(); }
});

await check("cli: unknown command returns 2", async () => {
  const cap1 = captureStream(process.stdout);
  const cap2 = captureStream(process.stderr);
  try {
    const code = await main(["definitely-not-a-command"]);
    assert.equal(code, 2);
    assert.match(cap2.text, /unknown command/);
  } finally { cap1.restore(); cap2.restore(); }
});

await check("cli: no args prints help (exits 0)", async () => {
  const cap = captureStream(process.stdout);
  try {
    const code = await main([]);
    assert.equal(code, 0);
    assert.match(cap.text, /USAGE/);
  } finally { cap.restore(); }
});

await check("cli: resume alias rewrites to run --resume", async () => {
  // We can't easily run `run --resume` end-to-end here without an LLM mock;
  // instead, verify the alias path produces a sensible error (no checkpoint
  // for a fake id), which proves it routed to cmdRun.
  const cap1 = captureStream(process.stdout);
  const cap2 = captureStream(process.stderr);
  try {
    process.env.RTLFORGE_API_KEY = "sk-fake-for-test";
    const code = await main(["resume", "nonexistent-project-id"]);
    // cmdRun reads the checkpoint, finds none, returns 1
    assert.equal(code, 1);
    assert.match(cap2.text, /no checkpoint found/);
  } finally {
    cap1.restore(); cap2.restore();
    delete process.env.RTLFORGE_API_KEY;
  }
});

await check("cli: resume with no id returns 2", async () => {
  const cap = captureStream(process.stderr);
  try {
    const code = await main(["resume"]);
    assert.equal(code, 2);
    assert.match(cap.text, /usage:/);
  } finally { cap.restore(); }
});

await check("cli: --no-color flag sets NO_COLOR env", async () => {
  delete process.env.NO_COLOR;
  await main(["status", "--no-color"]);
  assert.equal(process.env.NO_COLOR, "1");
  delete process.env.NO_COLOR;
});

// ═══════════════════════════════════════════════════════════════════════════
// ask — build/plan modes + tool execution
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[ask]");
const askMod = await import("../src/term/commands/ask.js");
const { toolsForMode, executeTool, READONLY_TOOL_NAMES, VALID_MODES, systemPromptFor } = askMod._internal;

await check("ask: VALID_MODES is exactly {build, plan}", () => {
  assert.deepEqual(Array.from(VALID_MODES).sort(), ["build", "plan"]);
});

await check("ask: build mode lists all 5 tools", () => {
  const names = toolsForMode("build").map(function(t) { return t.name; });
  assert.deepEqual(names.sort(), ["get_status", "list_stages", "read_module", "run_stage", "write_spec_answer"]);
});

await check("ask: plan mode lists ONLY read-only tools", () => {
  const names = toolsForMode("plan").map(function(t) { return t.name; });
  assert.deepEqual(names.sort(), ["get_status", "list_stages", "read_module"]);
  // Plan mode must hide write tools entirely (not just deny on call)
  assert.ok(!names.includes("run_stage"),         "run_stage leaked into plan mode tool list");
  assert.ok(!names.includes("write_spec_answer"), "write_spec_answer leaked into plan mode tool list");
});

await check("ask: plan mode prompt mentions read-only restriction", () => {
  const sp = systemPromptFor("plan");
  assert.match(sp, /PLAN MODE/);
  assert.match(sp, /cannot run/);
});

await check("ask: build mode prompt does not mention plan-mode restrictions", () => {
  const sp = systemPromptFor("build");
  assert.doesNotMatch(sp, /PLAN MODE/);
});

// Helper: build a store with a seeded elicit question for tool tests
async function makeAskTestStore() {
  const { createStore } = await import("../src/term/store.js?ask1");
  const { createMemoryStorage } = await import("../src/projectState/index.js");
  const store = createStore({
    config: { provider: "anthropic", model: "x" },
    storage: createMemoryStorage(),
  });
  store.ensureModule("fifo");
  store.dispatch({
    type: "MODULE_STAGE_DATA_SET", modId: "fifo", stageId: 1,
    data: {
      questions: [
        { id: "q1", text: "Sync or async reset?" },
        { id: "q2", text: "Depth?" },
      ],
      answers: {},
    },
  });
  return store;
}

await check("ask: executeTool blocks run_stage in plan mode (defense in depth)", async () => {
  const store = await makeAskTestStore();
  const r = await executeTool("run_stage", { stage: "verify" },
    { store: store, yolo: true, mode: "plan" });
  assert.equal(r.error, "plan_mode_blocked");
});

await check("ask: executeTool blocks write_spec_answer in plan mode", async () => {
  const store = await makeAskTestStore();
  const r = await executeTool("write_spec_answer",
    { questionId: "q1", answer: "sync" },
    { store: store, yolo: true, mode: "plan" });
  assert.equal(r.error, "plan_mode_blocked");
});

await check("ask: executeTool get_status surfaces elicit question ids", async () => {
  const store = await makeAskTestStore();
  const r = await executeTool("get_status", {}, { store: store, yolo: true, mode: "plan" });
  assert.equal(r.activeModId, "fifo");
  const eq = r.modules.fifo.elicitQuestions;
  assert.ok(Array.isArray(eq) && eq.length === 2);
  assert.equal(eq[0].id, "q1");
  assert.equal(eq[0].answered, false);
});

await check("ask: executeTool list_stages returns active + optional", async () => {
  const store = await makeAskTestStore();
  const r = await executeTool("list_stages", {}, { store: store, yolo: true, mode: "plan" });
  assert.ok(Array.isArray(r.activeStages) && r.activeStages.length > 0);
  // At least the always-on stages (elicit, spec, architect, rtl_generate, test_generate, verify, judge)
  const labels = r.activeStages.map(function(s) { return s.label; });
  assert.ok(labels.includes("Elicit"));
  assert.ok(labels.includes("RTL Gen"));
  assert.ok(labels.includes("Verify"));
  assert.ok(Array.isArray(r.optionalStages));
});

await check("ask: write_spec_answer persists answer + reports progress", async () => {
  const store = await makeAskTestStore();
  const r = await executeTool("write_spec_answer",
    { questionId: "q1", answer: "synchronous active-low reset" },
    { store: store, yolo: true, mode: "build" });
  assert.equal(r.ok, true);
  assert.equal(r.totalAnswered, 1);
  assert.equal(r.totalQuestions, 2);
  // Persisted in store
  const sd1 = store.getState().modules.fifo.stageData[1];
  assert.equal(sd1.answers.q1, "synchronous active-low reset");
  // Other elicit metadata (questions list) survived the merge
  assert.equal(sd1.questions.length, 2);
});

await check("ask: write_spec_answer rejects unknown question id with knownIds list", async () => {
  const store = await makeAskTestStore();
  const r = await executeTool("write_spec_answer",
    { questionId: "qZZZ", answer: "x" },
    { store: store, yolo: true, mode: "build" });
  assert.equal(r.error, "unknown_question");
  assert.deepEqual(r.knownIds.sort(), ["q1", "q2"]);
});

await check("ask: write_spec_answer rejects when module has no elicit data yet", async () => {
  const { createStore } = await import("../src/term/store.js?ask2");
  const { createMemoryStorage } = await import("../src/projectState/index.js");
  const store = createStore({ config: {}, storage: createMemoryStorage() });
  store.ensureModule("empty");
  const r = await executeTool("write_spec_answer",
    { questionId: "q1", answer: "x" },
    { store: store, yolo: true, mode: "build" });
  assert.equal(r.error, "no_elicit_data");
});

await check("ask: read_module in plan mode reads spec without mutating", async () => {
  const store = await makeAskTestStore();
  const before = JSON.stringify(store.getState().modules.fifo);
  const r = await executeTool("read_module",
    { fields: ["spec"] }, { store: store, yolo: true, mode: "plan" });
  assert.equal(r.modId, "fifo");
  // No mutation
  assert.equal(JSON.stringify(store.getState().modules.fifo), before,
    "read_module mutated state");
});

await check("ask: unknown_tool returns clear error rather than throwing", async () => {
  const store = await makeAskTestStore();
  const r = await executeTool("does_not_exist", {}, { store: store, yolo: true, mode: "build" });
  assert.equal(r.error, "unknown_tool");
  assert.equal(r.name, "does_not_exist");
});

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════
fs.rmSync(TMP, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════════════════
// Verdict
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failures.length);
console.log("  Status: " + (failures.length === 0 ? "ALL PASS ✓" : "FAILURES"));
console.log("═══════════════════════════════════════");
if (failures.length > 0) {
  for (const f of failures) console.log("  • " + f.name + ": " + f.message);
  process.exit(1);
}
