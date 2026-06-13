// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// bench/run — drive the golden suite through the pipeline and score each run
//
//   node bench/run.mjs                       # whole suite, live LLM + backend
//   node bench/run.mjs --spec=fifo_sync,pwm  # a subset
//   node bench/run.mjs --baseline=bench/results/<old>.json   # run + diff
//   node bench/run.mjs --diff=new.json,old.json              # diff only, no run
//   node bench/run.mjs --mock                # offline self-test (no LLM/backend)
//
// LIVE config comes from env (with CLI overrides):
//   RTLFORGE_PROVIDER · RTLFORGE_MODEL · RTLFORGE_API_KEY · RTLFORGE_BACKEND_URL
// A backend (CLI ✓) is what makes verify/mutation/sva numbers REAL; without
// one, verify falls back to LLM estimation and judge caps at UNVERIFIED —
// which the scorer records faithfully, so a no-backend run is still a valid
// (cheaper, weaker) data point.
//
// Results are written to bench/results/<sha>-<timestamp>.json (gitignored;
// commit the ones you want to track). The pure scoring/aggregation lives in
// scorer.mjs / report.mjs and is unit-tested; this file is just the wiring.
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

import { selectSpecs } from "./specs.mjs";
import { scoreRun } from "./scorer.mjs";
import { aggregate, formatRunTable, formatAggregate, formatComparison } from "./report.mjs";

// ─── arg parsing (no deps) ───────────────────────────────────────────────────
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] == null ? true : m[2];
}

function gitSha() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch (_) { return "nogit"; }
}

// ─── --diff: compare two existing result files, no run ───────────────────────
if (args.diff) {
  const [curPath, basePath] = String(args.diff).split(",");
  const cur = JSON.parse(readFileSync(curPath, "utf8"));
  const base = JSON.parse(readFileSync(basePath, "utf8"));
  const curAgg = cur.aggregate || aggregate(cur.records || []);
  const baseAgg = base.aggregate || aggregate(base.records || []);
  console.log("CURRENT:  " + curPath + "  (" + (cur.sha || "?") + ")");
  console.log(formatAggregate(curAgg));
  console.log("\nBASELINE: " + basePath + "  (" + (base.sha || "?") + ")");
  console.log(formatAggregate(baseAgg));
  console.log("\n── Δ current vs baseline ──");
  console.log(formatComparison(curAgg, baseAgg));
  process.exit(0);
}

// ─── config ──────────────────────────────────────────────────────────────────
// Reuse the CLI's config resolution so `npm run bench` picks up everything
// the terminal app already knows — provider, model, baseUrl (local-LLM port),
// backendUrl, simCmds, API key from auth.json — instead of forcing the user
// to re-specify it all in env vars. Resolution chain (later wins):
//   DEFAULT_CONFIG → ~/.rtlforge/config.json → ./.rtlforge.json → RTLFORGE_*
//   env → CLI flags (below)
// loadConfig falls back to plain defaults if no config file exists.
const { loadConfig, loadApiKey } = await import("../src/term/config.js");
const flags = {};
if (args.provider) flags.provider = args.provider;
if (args.model) flags.model = args.model;
if (args.backend) flags.backendUrl = args.backend;
if (args.baseurl) flags.baseUrl = args.baseurl;
if (args.apikey) flags.apiKey = args.apikey;

const config = loadConfig({ flags: flags });
// loadConfig deliberately omits the API key (kept in auth.json); resolve it
// the same way the CLI does (flag → RTLFORGE_API_KEY / provider env → auth).
config.apiKey = flags.apiKey || loadApiKey(config.provider) || "";
config.useGlobalLLM = true;

const provider = config.provider;
const model = config.model || "";
const backendUrl = config.backendUrl || null;

// Benchmark overlay: turn the measurement gates ON when a backend is present
// (a real CLI run is what makes verify/SVA/mutation numbers meaningful), and
// keep the optional pipeline stages we want to score. A user-set value in
// config still wins where it makes sense.
config.optionalStages = Object.assign(
  { formal_props: true, lint: true, lint_test: !!backendUrl },
  config.optionalStages || {},
);
if (!config.simCmds) config.simCmds = "verilator --binary --assert -Wall -j 0 {RTL} {TB} -o sim\n./obj_dir/sim";
if (!config.lintCmd) config.lintCmd = "verilator --lint-only -Wall {RTL}";
config.svaInSim = backendUrl ? (config.svaInSim !== false) : false;
config.mutationTesting = backendUrl ? (config.mutationTesting !== false) : false;
config.maxJudgeIters = config.maxJudgeIters || 3;

const specs = selectSpecs(args.spec);
if (specs.length === 0) { console.error("No specs match --spec=" + args.spec); process.exit(2); }

// ─── drive one spec ──────────────────────────────────────────────────────────
async function runSpec(spec) {
  const t0 = Date.now();
  if (args.mock) {
    // Offline self-test: synthesize a varied-but-deterministic finalState so
    // the whole harness (drive → score → aggregate → write → tables → diff)
    // is exercised without an LLM or backend. NOT a measurement of the
    // pipeline — the `mock: true` flag on the record marks it as such.
    const finalState = mockFinalState(spec.id);
    return { specId: spec.id, title: spec.title, ok: true, mock: true,
      durationMs: Date.now() - t0, metrics: scoreRun(finalState) };
  }
  // Live drive — lazy import so --mock needs no core/LLM at all.
  const { buildPipeline, runStages, stageKeysFromActive } = await import("../src/pipeline/index.js");
  const { getActiveStages } = await import("../src/constants/index.js");
  const pipeline = buildPipeline();
  const stageKeys = stageKeysFromActive(getActiveStages(config)).filter((k) => k !== "elicit");
  const initialState = { _userDesc: spec.description, _config: config };
  try {
    const finalState = await runStages(pipeline, stageKeys, initialState, {
      onStageStart: (key) => process.stdout.write("  [" + spec.id + "] " + key + "…\n"),
    });
    return { specId: spec.id, title: spec.title, ok: true,
      durationMs: Date.now() - t0, metrics: scoreRun(finalState) };
  } catch (e) {
    return { specId: spec.id, title: spec.title, ok: false,
      error: (e && e.message) ? e.message.slice(0, 300) : String(e),
      durationMs: Date.now() - t0, metrics: scoreRun({}) };
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
const sha = gitSha();
if (args.mock) {
  console.log("RTL Forge benchmark — " + specs.length + " spec(s) · MOCK (offline self-test)\n");
} else {
  console.log("RTL Forge benchmark — " + specs.length + " spec(s)");
  console.log("  provider : " + provider + (model ? " · model " + model : " · model (provider default)"));
  console.log("  backend  : " + (backendUrl
    ? backendUrl + " (real CLI — verify/SVA/mutation measured)"
    : "none (LLM-estimated verify; judge caps at UNVERIFIED)"));
  console.log("  gates    : svaInSim=" + config.svaInSim + " mutationTesting=" + config.mutationTesting
    + " lint_test=" + !!config.optionalStages.lint_test);
  if (!backendUrl) {
    console.log("  ⚠ No backend configured. backend.js running? Point bench at it:");
    console.log("      RTLFORGE_BACKEND_URL=http://localhost:3001 npm run bench");
    console.log("      (or `rtlforge config set backendUrl http://localhost:3001`, or --backend=…)");
  }
  if (!model) {
    console.log("  ⚠ No model set. Select one, e.g. a local LLM:");
    console.log("      RTLFORGE_PROVIDER=lmstudio RTLFORGE_MODEL=<id> npm run bench");
    console.log("      (LM Studio default URL :1234, Ollama :11434; override with --baseurl=…)");
  }
  console.log("");
}

const records = [];
for (const spec of specs) {
  const rec = await runSpec(spec);
  records.push(rec);
  if (!args.mock) {
    const m = rec.metrics;
    console.log("  → " + spec.id + ": " + (rec.ok ? (m.verdict || "—")
      + (m.score != null ? " (" + m.score + ")" : "") : "ERROR " + rec.error));
  }
}

const agg = aggregate(records);
console.log("\n" + formatRunTable(records));
console.log("\n── Summary ──");
console.log(formatAggregate(agg));

// ─── write results ───────────────────────────────────────────────────────────
const resultsDir = resolve(args.out || "bench/results");
if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(resultsDir, sha + "-" + ts + (args.mock ? "-mock" : "") + ".json");
writeFileSync(outPath, JSON.stringify({
  sha, timestamp: new Date().toISOString(),
  mock: !!args.mock, provider, model, backend: !!backendUrl,
  records, aggregate: agg,
}, null, 2));
console.log("\nWrote " + outPath);

// ─── optional baseline diff ──────────────────────────────────────────────────
if (args.baseline) {
  const base = JSON.parse(readFileSync(String(args.baseline), "utf8"));
  const baseAgg = base.aggregate || aggregate(base.records || []);
  console.log("\n── Δ vs baseline " + args.baseline + " (" + (base.sha || "?") + ") ──");
  console.log(formatComparison(agg, baseAgg));
}

// ─── mock fixture generator (offline self-test only) ─────────────────────────
// Three deterministic scenarios chosen by a hash of the spec id, each built
// with the real field shapes the scorer reads, so the harness sees realistic
// spread (clean PASS, fix-loop PASS, UNVERIFIED) without any LLM/backend.
function mockFinalState(id) {
  const scenario = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 3;
  const llms = (n) => Array.from({ length: n }, () =>
    ({ tokensIn: 800, tokensOut: 400, provider: "anthropic", model: "mock" }));
  if (scenario === 0) {
    // Clean: everything passes first try, real CLI, SVA + mutation present.
    return {
      lint: { status: "PASS", iterations: [{ iter: 1, status: "PASS", errors: 0, warnings: 0 }], _llms: llms(1) },
      verify: { pass: 6, fail: 0, total: 6, cli: true, cov: { line: 100, branch: 95, toggle: 90 },
        verifyHistory: [{ iter: 1, status: "PASS", pass: 6, total: 6 }],
        sva: { bound: ["SVA-001", "SVA-002"], skipped: [], bindFailed: false },
        mutation: { total: 5, invalid: 0, killed: 5, survived: [], score: 100 }, _llms: llms(1) },
      judge: { overall: "PASS", score: 100, verified: true, evalOverall: "PASS",
        judgeHistory: [{ iter: 1, overall: "PASS", score: 100 }], _llms: llms(1) },
      rtl_generate: { code: "module m; endmodule", _llms: llms(1) },
      spec: { requirements: [], _llms: llms(1) },
    };
  }
  if (scenario === 1) {
    // Fix-loop PASS: verify needed two iterations; mutation found a survivor.
    return {
      lint: { status: "PASS", iterations: [{ iter: 1, status: "FAIL", errors: 1, warnings: 0 },
        { iter: 2, status: "PASS", errors: 0, warnings: 0 }], _llms: llms(2) },
      verify: { pass: 5, fail: 0, total: 5, cli: true, cov: { line: 88, branch: 80, toggle: 70 },
        verifyHistory: [{ iter: 1, status: "FAIL", pass: 3, total: 5 },
          { iter: 2, status: "PASS", pass: 5, total: 5 }],
        sva: { bound: ["SVA-001"], skipped: ["SVA-002"], bindFailed: false },
        mutation: { total: 5, invalid: 1, killed: 3, survived: [{ id: "M2" }], score: 75 }, _llms: llms(3) },
      judge: { overall: "PASS", score: 92, verified: true, evalOverall: "PASS",
        judgeHistory: [{ iter: 1, overall: "PASS", score: 92 }], _llms: llms(1) },
      rtl_generate: { code: "module m; endmodule", _llms: llms(1) },
      spec: { requirements: [], _llms: llms(1) },
    };
  }
  // UNVERIFIED: gate passes on LLM-estimated sim (no backend).
  return {
    lint: { status: "PASS", iterations: [{ iter: 1, status: "PASS", errors: 0, warnings: 0 }], _llms: llms(1) },
    verify: { pass: 4, fail: 0, total: 4, cli: false, cov: null,
      verifyHistory: [{ iter: 1, status: "PASS", pass: 4, total: 4 }], _llms: llms(1) },
    judge: { overall: "UNVERIFIED", score: 100, verified: false, evalOverall: "PASS",
      judgeHistory: [{ iter: 1, overall: "PASS", score: 100 }], _llms: llms(1) },
    rtl_generate: { code: "module m; endmodule", _llms: llms(1) },
    spec: { requirements: [], _llms: llms(1) },
  };
}
