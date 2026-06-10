// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// smoke.mjs — End-to-end smoke test: LM Studio + Verilator backend
//                + reducer/checkpoint integration round-trip
//
// Prerequisites:
//   1. LM Studio running with local server enabled (default port 1234).
//      Developer tab → Start Server. Load a coder-tuned model.
//   2. Optional but recommended: backend.mjs running for real Verilator.
//      In another terminal: `node backend.mjs` (default port 5174).
//      Without it, lint/verify fall back to LLM estimation and are unreliable.
//   3. Node 18+ (built-in fetch).
//
// Usage:
//   node smoke.mjs                              # LM Studio auto-detect + backend on 5174
//   node smoke.mjs --no-backend                 # skip Verilator backend (LLM fallback)
//   node smoke.mjs --backend=http://host:5174   # custom backend URL
//   node smoke.mjs --model=qwen2.5-coder-32b    # force a specific model
//   node smoke.mjs --url=http://192.168.1.5:1234/v1   # remote LM Studio
//   node smoke.mjs --skip-judge                 # stop before judge
//   node smoke.mjs --skip-formal                # also skip formal_props
//   node smoke.mjs --skip-llm                   # synthetic state, no LLM calls (CI mode)
//
// What it does:
//   1. Probes LM Studio endpoint and auto-selects a loaded model
//   2. Probes the Verilator backend (if enabled) and confirms it's reachable
//   3. Runs the pipeline through runStages, AND mirrors every stage result
//      into a reducer-managed project state via dispatch
//   4. After the run, serializes a checkpoint, saves it through the
//      checkpoint manager + memory storage, lists the index, loads it back,
//      deserializes it, and asserts the round-trip is faithful
//   5. Writes RTL + testbench + checkpoint payload to ./smoke-output/
//   6. Exits 0 if PASS verdict AND checkpoint round-trip is clean, 1 otherwise
//
// The reducer + checkpoint round-trip is the integration test for the
// modular core against a real LLM pipeline. If the modular core is
// faithful, the deserialized state will be byte-for-byte equivalent to
// what the reducer accumulated during the run.

import { writeFileSync, mkdirSync } from "node:fs";
import {
  // pipeline orchestration
  buildPipeline, runStages, stageKeysFromActive,
  // stage registry
  getActiveStages, ALL_STAGES,
  // projectState helpers
  blankModule, computeContentHash,
  // reducer + actions
  createInitialProjectState, projectReducer,
  MODULE_UPSERT, MODULE_STAGE_DATA_SET, MODULE_STAGE_COMPLETE,
  MODULE_CONTENT_HASH_SET, LEDGER_APPEND, SET_ACTIVE_MOD,
  PROJECT_PHASE_SET, LOAD_STATE,
  // checkpoint serialization + storage
  serializeCheckpoint, deserializeCheckpoint,
  createMemoryStorage, createCheckpointManager,
} from "./src/index.js";

// ─── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const found = args.find((a) => a.startsWith("--" + name + "="));
  return found ? found.split("=")[1] : fallback;
}
function hasFlag(name) { return args.includes("--" + name); }

const skipJudge  = hasFlag("skip-judge");
const skipFormal = hasFlag("skip-formal");
const noBackend  = hasFlag("no-backend");
const skipLlm    = hasFlag("skip-llm");

const baseUrl = getArg("url", "http://localhost:1234/v1");
const model   = getArg("model", "loaded-model");
const backendUrl = getArg("backend", "http://localhost:5174");

const FIXTURE = "An 8-bit synchronous FIFO with depth 16, active-low async reset, "
              + "full and empty status flags, and standard write/read enable signals.";

// ─── Config ─────────────────────────────────────────────────────────────────
const config = {
  provider: "lmstudio",
  baseUrl,
  model,
  apiKey: "lm-studio-not-actually-used",  // intentionally non-empty so leak test
                                          // catches it if it ever gets into a checkpoint
  maxRetries: 1,
  retryBaseDelayMs: 1000,
  useGlobalLLM: true,

  backendUrl: null,
  lintCmd: "verilator --lint-only -Wall {RTL}",
  simCmds: [
    "verilator --binary -Wall --Mdir obj_dir {TB} {RTL}",
    "find obj_dir -maxdepth 1 -type f -executable -name 'V*' -exec {} \\;",
  ].join("\n"),
};

// ─── Probe LM Studio (skipped in --skip-llm mode) ───────────────────────────
console.log("═══════════════════════════════════════════════════════════════");
console.log("  rtl-forge smoke test — pipeline + reducer + checkpoint");
console.log("═══════════════════════════════════════════════════════════════");

if (!skipLlm) {
  console.log("  LM Studio: " + baseUrl);
  try {
    const probe = await fetch(baseUrl + "/models", { method: "GET" });
    if (!probe.ok) {
      console.error("\nERROR: " + baseUrl + "/models returned HTTP " + probe.status);
      console.error("Is LM Studio running and the local server enabled?");
      process.exit(2);
    }
    const data = await probe.json();
    const loaded = (data.data || []).map((m) => m.id);
    if (loaded.length === 0) {
      console.error("\nERROR: LM Studio reports no loaded models.");
      console.error("Load a model in LM Studio and try again.");
      process.exit(2);
    }
    if (model === "loaded-model") {
      config.model = loaded[0];
      console.log("  Model:     " + config.model + " (auto-selected)");
    } else if (!loaded.includes(model)) {
      console.warn("  Model:     " + model + " (⚠ not in loaded list: " + loaded.join(", ") + ")");
    } else {
      console.log("  Model:     " + model);
    }
  } catch (e) {
    console.error("\nERROR: cannot reach " + baseUrl + " — " + e.message);
    console.error("Is LM Studio running with the local server enabled?");
    process.exit(2);
  }
} else {
  console.log("  LM Studio: (--skip-llm mode — using synthetic stage data)");
}

// ─── Probe Verilator backend ────────────────────────────────────────────────
if (noBackend || skipLlm) {
  console.log("  Backend:   " + (skipLlm ? "(skipped in --skip-llm mode)"
                                          : "(disabled — lint/verify will use LLM fallback)"));
} else {
  try {
    const healthResp = await fetch(backendUrl + "/api/health", { method: "GET" });
    if (!healthResp.ok) {
      console.error("\nERROR: " + backendUrl + "/api/health returned HTTP " + healthResp.status);
      console.error("Is backend.mjs running? Start it with: node backend.mjs");
      process.exit(2);
    }
    const health = await healthResp.json();
    config.backendUrl = backendUrl;
    console.log("  Backend:   " + backendUrl + " (workdir: " + (health.workdir || "?") + ")");

    const probeResp = await fetch(backendUrl + "/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "verilator --version", files: {} }),
    });
    if (probeResp.ok) {
      const probeResult = await probeResp.json();
      if (probeResult.exitCode === 0) {
        console.log("  Verilator: " + (probeResult.stdout || "").trim().split("\n")[0]);
      } else {
        console.error("\nERROR: backend reports Verilator is not installed");
        console.error("Install: sudo apt install verilator  (Ubuntu)");
        console.error("Or re-run with --no-backend to skip the lint/verify backend.");
        process.exit(2);
      }
    }
  } catch (e) {
    console.error("\nERROR: cannot reach backend " + backendUrl + " — " + e.message);
    console.error("Start it in another terminal with: node backend.mjs");
    process.exit(2);
  }
}

// ─── Build pipeline + stage list ───────────────────────────────────────────
const pipeline = buildPipeline();

let stageKeys = stageKeysFromActive(getActiveStages({})).filter((k) => k !== "elicit");
if (skipFormal) stageKeys = stageKeys.filter((k) => k !== "formal_props");
if (skipJudge)  stageKeys = stageKeys.filter((k) => k !== "judge");

// stageKey → stageId map (e.g. "spec" → 2). Used by the reducer dispatches
// to mirror runStages results into the per-module stageData[stageId] store.
const stageKeyToId = {};
ALL_STAGES.forEach((s) => { stageKeyToId[s.key] = s.id; });

console.log("  Stages:    " + stageKeys.join(" → "));
console.log("  Fixture:   " + FIXTURE.substring(0, 60) + "…");
console.log("───────────────────────────────────────────────────────────────");

// ─── Reducer state setup ────────────────────────────────────────────────────
// We mirror the runStages accumulator into a reducer-managed project state
// so we can integration-test slices 4a/4b/4c against a real pipeline run.
const MOD_ID = "smoke_module";
let reducerState = createInitialProjectState();
reducerState = projectReducer(reducerState, { type: MODULE_UPSERT, modId: MOD_ID, module: blankModule() });
reducerState = projectReducer(reducerState, { type: SET_ACTIVE_MOD, modId: MOD_ID });
reducerState = projectReducer(reducerState, { type: PROJECT_PHASE_SET, phase: "running" });

// Tracking
let dispatchCount = 0;

// ─── Initial state for runStages ───────────────────────────────────────────
const initialState = skipLlm
  ? buildSyntheticState()
  : {
      _userDesc: FIXTURE,
      _config: config,
      _childInterfaces: null,
      _sharedPackageCode: null,
      _lastError: null,
      _onLog: (text, metrics) => {
        if (metrics && metrics.done) process.stdout.write(" ✓");
        else process.stdout.write(".");
      },
    };

function buildSyntheticState() {
  // CI-friendly stub: builds canned per-stage outputs without calling any LLM.
  // Lets the reducer/checkpoint integration test run with `--skip-llm` for free.
  const synthetic = {
    _userDesc: FIXTURE,
    _config: { ...config, backendUrl: null },
    _childInterfaces: null,
    _sharedPackageCode: null,
    _lastError: null,
    _onLog: () => process.stdout.write("."),
  };
  return synthetic;
}

// ─── Run with progress + reducer dispatch ──────────────────────────────────
const t0 = Date.now();
let totalTokensIn = 0;
let totalTokensOut = 0;
let lastStageStart = t0;

let finalState;
try {
  if (skipLlm) {
    // Bypass runStages entirely — synthesize a final state matching what
    // a real run would produce. Useful for CI / fast smoke validation.
    finalState = synthesizeFinalState(stageKeys);
    // Walk the synthesized state and fire reducer dispatches per stage
    stageKeys.forEach((key) => {
      mirrorStageIntoReducer(key, finalState);
    });
  } else {
    finalState = await runStages(pipeline, stageKeys, initialState, {
      onStageStart: (key) => {
        lastStageStart = Date.now();
        process.stdout.write("\n[" + key.padEnd(15) + "] ");
      },
      onStageComplete: (key, st) => {
        const elapsed = ((Date.now() - lastStageStart) / 1000).toFixed(1);
        const llm = st._llm || {};
        if (llm.tokensIn)  totalTokensIn  += llm.tokensIn;
        if (llm.tokensOut) totalTokensOut += llm.tokensOut;
        process.stdout.write(
          " (" + elapsed + "s, " +
          (llm.tokensIn  || 0) + " in / " +
          (llm.tokensOut || 0) + " out)"
        );
        // ── Reducer dispatch: mirror this stage's result into project state ──
        mirrorStageIntoReducer(key, st);
      },
      onStageError: (key, err) => {
        console.error("\n  ✗ " + key + " FAILED: " + err.message);
        return false;
      },
    });
  }
} catch (e) {
  console.error("\n\nPipeline aborted: " + e.message);
  if (/extractJSON|TRUNCATED|DIAGNOSIS/.test(e.message)) {
    console.error("\nThis usually means the model returned malformed JSON.");
    console.error("Try a larger coder model (Qwen2.5-Coder-32B, DeepSeek-Coder-V2).");
  }
  process.exit(1);
}

reducerState = projectReducer(reducerState, { type: PROJECT_PHASE_SET, phase: "done" });

// Helper: dispatch the reducer actions that mirror one stage's result
function mirrorStageIntoReducer(key, st) {
  const stageId = stageKeyToId[key];
  if (stageId == null) return;
  const stageData = st[key];
  if (stageData != null) {
    reducerState = projectReducer(reducerState, {
      type: MODULE_STAGE_DATA_SET, modId: MOD_ID, stageId, data: stageData,
    });
    dispatchCount++;
  }
  reducerState = projectReducer(reducerState, {
    type: MODULE_STAGE_COMPLETE, modId: MOD_ID, stageId,
  });
  dispatchCount++;
  // Token ledger
  if (st._llm) {
    reducerState = projectReducer(reducerState, {
      type: LEDGER_APPEND, entry: {
        stage: st._llm.stage || key,
        tokensIn:  st._llm.tokensIn  || 0,
        tokensOut: st._llm.tokensOut || 0,
        latencyMs: st._llm.latencyMs || 0,
        model:     st._llm.model     || "",
        provider:  st._llm.provider  || "",
      },
    });
    dispatchCount++;
  }
  // Content hash on spec (2) and rtl_generate (4)
  if (stageId === 2 || stageId === 4) {
    const mod = reducerState.modules[MOD_ID];
    const spec = mod.stageData[2] || {};
    const rtlCode = mod.stageData[4] ? mod.stageData[4].code || "" : "";
    const hash = computeContentHash(spec, rtlCode);
    reducerState = projectReducer(reducerState, {
      type: MODULE_CONTENT_HASH_SET, modId: MOD_ID, contentHash: hash,
    });
    dispatchCount++;
  }
}

function synthesizeFinalState(keys) {
  // Build a fake finalState that looks like what runStages would return,
  // for --skip-llm mode. Used purely for CI integration testing of the
  // reducer/checkpoint round-trip.
  const fake = { _userDesc: FIXTURE, _config: config };
  const stub = (stage) => ({ stage, tokensIn: 100, tokensOut: 50, latencyMs: 1000, model: "stub", provider: "stub" });
  if (keys.includes("spec"))          { fake.spec = { iface: [{ name: "clk", dir: "input", width: "1" }], params: [], requirements: [{ id: "REQ-FUNC-001", pri: "Must", desc: "synthetic" }] }; fake._llm = stub("spec"); }
  if (keys.includes("architect"))     { fake.architect = { strategy: "synthetic", blocks: [], mermaid: "graph TD\n  A --> B" }; fake._llm = stub("architect"); }
  if (keys.includes("rtl_generate"))  { fake.rtl_generate = { code: "module smoke_module; endmodule" }; fake._llm = stub("rtl_generate"); }
  if (keys.includes("formal_props"))  { fake.formal_props = { properties: [], autoAssumptions: [] }; fake._llm = stub("formal_props"); }
  if (keys.includes("lint"))          { fake.lint = { status: "PASS", errors: [], warnings: [], iterations: [{ iter: 1, status: "PASS", errors: 0, warnings: 0 }], _taskStatus: "COMPLETE" }; fake._llm = stub("lint"); }
  if (keys.includes("test_generate")) { fake.test_generate = { code: "module smoke_module_tb; initial $finish; endmodule" }; fake._llm = stub("test_generate"); }
  if (keys.includes("verify"))        { fake.verify = { sim: "stub", total: 1, pass: 1, fail: 0, tests: [{ name: "synthetic", st: "PASS" }] }; fake._llm = stub("verify"); }
  if (keys.includes("judge"))         { fake.judge = { overall: "PASS", score: 90, trace: [], recs: [] }; fake._llm = stub("judge"); }
  return fake;
}

const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);

// ─── Pipeline summary ───────────────────────────────────────────────────────
console.log("\n\n═══════════════════════════════════════════════════════════════");
console.log("  Pipeline Summary");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  Total time:    " + totalElapsed + "s");
console.log("  Total tokens:  " + totalTokensIn + " in / " + totalTokensOut + " out");
if (finalState.spec) {
  const reqCount = (finalState.spec.requirements || []).length;
  const mustCount = (finalState.spec.requirements || []).filter((r) => r.pri === "Must").length;
  console.log("  Spec:          " + reqCount + " requirements (" + mustCount + " Must)");
}
if (finalState.lint) {
  const errs  = (finalState.lint.errors   || []).length;
  const warns = (finalState.lint.warnings || []).length;
  const iters = (finalState.lint.iterations || []).length;
  const tag = finalState.lint.cli ? " [real CLI]" : " [LLM/synth]";
  console.log("  Lint:          " + finalState.lint.status + " (" + errs + " errors, " + warns + " warnings) after " + iters + " iter(s)" + tag);
}
if (finalState.verify) {
  const tag = finalState.verify.cli ? " [real CLI]" : " [LLM/synth]";
  console.log("  Verify:        " + finalState.verify.pass + "/" + finalState.verify.total + " tests passed" + tag);
}
if (finalState.judge) {
  console.log("  Judge:         " + finalState.judge.overall + " (score " + finalState.judge.score + ")");
}

// ─── Reducer summary ───────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Reducer State Summary");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  Modules:       " + Object.keys(reducerState.modules).length);
const mod = reducerState.modules[MOD_ID];
console.log("  Active mod:    " + reducerState.activeModId);
console.log("  Phase:         " + reducerState.projectPhase);
console.log("  Completed:     [" + Array.from(mod.completed).join(", ") + "] (Set of " + mod.completed.size + ")");
console.log("  StageData ks:  [" + Object.keys(mod.stageData).join(", ") + "]");
console.log("  Content hash:  " + (mod.contentHash || "(none)"));
console.log("  Ledger entries:" + reducerState.ledger.length);
console.log("  Total dispatches: " + dispatchCount);

// ─── Checkpoint round-trip integration test ─────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Checkpoint Round-Trip Integration Test");
console.log("═══════════════════════════════════════════════════════════════");

const uiState = {
  userDesc: FIXTURE,
  designMode: "module",
  mode: "semi-auto",
  config,                                  // includes the (fake) apiKey above
  lintWarningsAsErrors: false,
  verifyWarningsAsErrors: false,
};

let roundTripErrors = [];
function rtAssert(name, cond, detail) {
  if (cond) {
    console.log("  ✓ " + name);
  } else {
    console.log("  ✗ " + name + (detail ? "  →  " + detail : ""));
    roundTripErrors.push(name);
  }
}

// Step 1: serialize
const payload = serializeCheckpoint(reducerState, uiState);
console.log("\n  Step 1 — serializeCheckpoint");
console.log("    payload version:  " + payload.version);
console.log("    payload size:     " + payload._sizeKB + " KB");

// Critical: apiKey must NOT appear anywhere in the payload
const payloadJson = JSON.stringify(payload);
rtAssert("apiKey is not leaked into payload",
  !payloadJson.includes("lm-studio-not-actually-used"),
  "found 'lm-studio-not-actually-used' in payload JSON");

rtAssert("payload version matches CHECKPOINT_VERSION", payload.version === 3);
rtAssert("payload modules.completed is array (not Set)",
  Array.isArray(payload.modules[MOD_ID].completed));
rtAssert("payload preserves all dispatched stage ids",
  Array.from(mod.completed).every((id) => payload.modules[MOD_ID].completed.includes(id)));
rtAssert("payload ledger length matches", payload.ledger.length === reducerState.ledger.length);

// Step 2: save through CheckpointManager + memory storage
console.log("\n  Step 2 — createCheckpointManager + storage save/load");
const storage = createMemoryStorage();
const cm = createCheckpointManager(storage, { allStages: ALL_STAGES, maxCheckpoints: 3 });
const saveOk = await cm.save(payload.projectId, payload);
rtAssert("manager.save returns true", saveOk === true);

const idx = await cm.listIndex();
rtAssert("manager.listIndex returns 1 entry", idx.length === 1);
rtAssert("index entry projectId matches", idx[0].projectId === payload.projectId);
rtAssert("index entry has furthestStage label", typeof idx[0].furthestStage === "string");

const loaded = await cm.load(payload.projectId);
rtAssert("manager.load returns the payload", loaded != null);
rtAssert("loaded payload version matches", loaded.version === payload.version);
rtAssert("loaded payload byte-equals saved",
  JSON.stringify(loaded) === JSON.stringify(payload));

// Step 3: deserialize
console.log("\n  Step 3 — deserializeCheckpoint");
const restored = deserializeCheckpoint(loaded);
rtAssert("deserialize returns non-null", restored != null);
rtAssert("restored.reducerState exists", restored && restored.reducerState != null);
rtAssert("restored.uiState exists", restored && restored.uiState != null);
rtAssert("restored module.completed is a Set",
  restored && restored.reducerState.modules[MOD_ID].completed instanceof Set);
rtAssert("restored Set has same members",
  restored && Array.from(restored.reducerState.modules[MOD_ID].completed).sort().join(",") ===
              Array.from(reducerState.modules[MOD_ID].completed).sort().join(","));
rtAssert("restored stageData keys match",
  restored && JSON.stringify(Object.keys(restored.reducerState.modules[MOD_ID].stageData).sort()) ===
              JSON.stringify(Object.keys(reducerState.modules[MOD_ID].stageData).sort()));
rtAssert("restored ledger length matches",
  restored && restored.reducerState.ledger.length === reducerState.ledger.length);
rtAssert("restored contentHash matches",
  restored && restored.reducerState.modules[MOD_ID].contentHash === reducerState.modules[MOD_ID].contentHash);
rtAssert("restored uiState.userDesc matches", restored && restored.uiState.userDesc === FIXTURE);
rtAssert("restored uiState.config has no apiKey", restored && restored.uiState.config.apiKey === undefined);

// Step 4: feed restored state back through reducer via LOAD_STATE
console.log("\n  Step 4 — LOAD_STATE re-hydration");
const reloaded = projectReducer(createInitialProjectState(),
  { type: LOAD_STATE, state: restored.reducerState });
rtAssert("reloaded reducer has the module", reloaded.modules[MOD_ID] != null);
rtAssert("reloaded module.completed is a Set",
  reloaded.modules[MOD_ID].completed instanceof Set);
rtAssert("reloaded completed matches original",
  Array.from(reloaded.modules[MOD_ID].completed).sort().join(",") ===
  Array.from(reducerState.modules[MOD_ID].completed).sort().join(","));
rtAssert("reloaded ledger matches",
  JSON.stringify(reloaded.ledger) === JSON.stringify(reducerState.ledger));
rtAssert("reloaded activeModId matches", reloaded.activeModId === reducerState.activeModId);

// Step 5: deep equivalence — re-serialize the reloaded state and compare
console.log("\n  Step 5 — second serialize is byte-identical to first");
const repayload = serializeCheckpoint(reloaded, uiState);
// timestamp + projectId will differ unless we copy them
repayload.timestamp = payload.timestamp;
repayload.projectId = payload.projectId;
// _sizeKB may differ due to timestamp string length — recompute
repayload._sizeKB = payload._sizeKB;
rtAssert("re-serialized payload byte-equals original",
  JSON.stringify(repayload) === JSON.stringify(payload),
  "re-serialization is not deterministic");

// ─── Write outputs ──────────────────────────────────────────────────────────
mkdirSync("./smoke-output", { recursive: true });
const modName = (finalState.elicit && finalState.elicit.modName) || MOD_ID;
if (finalState.rtl_generate && finalState.rtl_generate.code) {
  writeFileSync("./smoke-output/" + modName + ".sv", finalState.rtl_generate.code);
}
if (finalState.test_generate && finalState.test_generate.code) {
  writeFileSync("./smoke-output/" + modName + "_tb.sv", finalState.test_generate.code);
}
writeFileSync("./smoke-output/checkpoint.json", JSON.stringify(payload, null, 2));
writeFileSync("./smoke-output/final-state.json", JSON.stringify({
  reducer: {
    modules: Object.keys(reducerState.modules),
    activeModId: reducerState.activeModId,
    phase: reducerState.projectPhase,
    completed: Array.from(mod.completed),
    stageDataKeys: Object.keys(mod.stageData),
    contentHash: mod.contentHash,
    ledgerEntries: reducerState.ledger.length,
    dispatchCount,
  },
  pipeline: {
    spec: finalState.spec ? { reqCount: (finalState.spec.requirements || []).length } : null,
    lint: finalState.lint ? { status: finalState.lint.status, iterations: (finalState.lint.iterations || []).length, cli: finalState.lint.cli || false } : null,
    verify: finalState.verify ? { pass: finalState.verify.pass, total: finalState.verify.total, cli: finalState.verify.cli || false } : null,
    judge: finalState.judge,
  },
  checkpoint: {
    version: payload.version,
    projectId: payload.projectId,
    sizeKB: payload._sizeKB,
    roundTripErrors: roundTripErrors.length,
  },
}, null, 2));
console.log("\n  → ./smoke-output/" + modName + ".sv");
console.log("  → ./smoke-output/" + modName + "_tb.sv");
console.log("  → ./smoke-output/checkpoint.json");
console.log("  → ./smoke-output/final-state.json");

// ─── Verdict + exit code ────────────────────────────────────────────────────
let pipelineVerdict;
if (finalState.judge)       pipelineVerdict = finalState.judge.overall;
else if (finalState.verify) pipelineVerdict = (finalState.verify.fail === 0 && finalState.verify.total > 0) ? "PASS" : "FAIL";
else if (finalState.lint)   pipelineVerdict = finalState.lint.status;

const pipelineOk    = pipelineVerdict === "PASS";
const checkpointOk  = roundTripErrors.length === 0;
const overall       = pipelineOk && checkpointOk;

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Final Verdict");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  Pipeline:   " + (pipelineOk   ? "✓ PASS" : "✗ FAIL") + " (verdict: " + (pipelineVerdict || "?") + ")");
console.log("  Checkpoint: " + (checkpointOk ? "✓ PASS" : "✗ FAIL") + " (" + roundTripErrors.length + " errors)");
if (roundTripErrors.length > 0) {
  console.log("    failed assertions:");
  roundTripErrors.forEach((e) => console.log("    - " + e));
}
console.log("");
console.log("  " + (overall ? "✓ SMOKE TEST PASSED" : "✗ SMOKE TEST FAILED"));

process.exit(overall ? 0 : 1);
