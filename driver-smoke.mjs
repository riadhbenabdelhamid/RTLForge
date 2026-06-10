// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// driver-smoke.mjs — Integration test for the pipeline drivers
//
// Integration test for the three driver functions: runStage,
// runAllPipelines, runIntegrationPipeline. It drives a 2-module
// multi-module system through the full pipeline end-to-end, exactly the
// way a thin React useProject hook would, so any regressions in the driver
// layer show up as broken assertions here rather than as subtle UI
// misbehavior.
//
// Unlike smoke.mjs (which uses the runStages primitive), this test
// exercises the full driver chain:
//
//   runAllPipelines(execMode: "full-auto")
//     → for each module in topological order:
//         runStage(stageId, stageKey, ...) for every active stage
//           → pipeline.invokeNode(stageKey, accState)
//           → dispatch(MODULE_STAGE_DATA_SET)
//           → dispatch(MODULE_STAGE_COMPLETE)
//           → dispatch(LEDGER_APPEND) if _llm present
//           → dispatch(MODULE_CONTENT_HASH_SET) for stages 2/4
//           → dispatch(MODULE_CHILD_HASHES_SET) for multi-module
//           → dispatch(MODULE_STAGE_RUN_START/UPDATE/FINISH)
//     → runIntegrationPipeline()
//         → 4 sequential LLM calls (int_lint → int_test/int_verify → int_judge)
//         → dispatch(INTEGRATION_STAGE_DATA_SET/COMPLETE) per stage
//     → dispatch(PROJECT_PHASE_SET "done")
//     → services.deleteCheckpoint (if provided)
//
// After the full run completes, the script serializes the reducer state,
// round-trips it through a memory-backed checkpoint manager, and asserts
// the deserialized state byte-equals the original. That proves the entire
// reducer/checkpoint/driver pipeline is self-consistent under realistic load.
//
// ─── Usage ──────────────────────────────────────────────────────────────
//
//   node driver-smoke.mjs --skip-llm           # CI mode (default, fast)
//   node driver-smoke.mjs                      # same (auto-detects)
//   node driver-smoke.mjs --real-llm           # opt in to real LM Studio
//   node driver-smoke.mjs --real-llm --backend=http://127.0.0.1:5174
//   node driver-smoke.mjs --skip-integration   # stop after runAllPipelines
//
// Real-LLM mode takes 5-10 minutes because it runs 2 modules × 8 stages
// plus the 4-stage integration pipeline. Default is --skip-llm with a
// deterministic mock pipeline so the test completes in < 1 second.

import {
  // Pipeline orchestration
  buildPipeline, ALL_STAGES, getActiveStages,
  // pure helpers
  blankModule, computeContentHash, computeIfaceHash,
  // Reducer + actions
  createInitialProjectState, projectReducer,
  MODULE_UPSERT, MODULE_PATCH, INSTANCE_UPSERT, DECOMPOSITION_SET,
  // Drivers
  runAllPipelines, runIntegrationPipeline,
  // Checkpoint + storage
  serializeCheckpoint, deserializeCheckpoint,
  createMemoryStorage, createCheckpointManager,
  // LLM (real mode)
  callLLM, extractJSON, estimateCost,
} from "./src/index.js";

// ─── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const found = args.find((a) => a.startsWith("--" + name + "="));
  return found ? found.split("=")[1] : fallback;
}
function hasFlag(name) { return args.includes("--" + name); }

const skipLlm         = !hasFlag("real-llm"); // default: skip
const skipIntegration = hasFlag("skip-integration");
const baseUrl         = getArg("url",     "http://localhost:1234/v1");
const modelOverride   = getArg("model",   null);
const backendUrl      = getArg("backend", null);

// ─── Fixture: 2-module AND gate wrapping a NAND gate ───────────────────────
const FIXTURE = {
  top: {
    id: "and2",
    description: "A 2-input AND gate built from a NAND gate followed by an inverter.",
  },
  leaf: {
    id: "nand2",
    description: "A 2-input NAND gate with active-high inputs.",
  },
};

// ─── Progress tracking ──────────────────────────────────────────────────────
const t0 = Date.now();
const progressLog = [];
let dispatchCount = 0;

function ts() {
  const s = ((Date.now() - t0) / 1000).toFixed(2);
  return "[" + s.padStart(6) + "s]";
}

// ─── State setup ────────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════════════");
console.log("  driver-smoke — driver end-to-end integration test");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  Mode:       " + (skipLlm ? "--skip-llm (mock pipeline)" : "--real-llm (LM Studio)"));
console.log("  Fixture:    " + FIXTURE.top.id + " (top) ← " + FIXTURE.leaf.id + " (leaf)");
console.log("  Integration:" + (skipIntegration ? " disabled" : " enabled (4 LLM calls)"));
console.log("───────────────────────────────────────────────────────────────");

let state = createInitialProjectState();
state = projectReducer(state, { type: MODULE_UPSERT, modId: FIXTURE.top.id });
state = projectReducer(state, { type: MODULE_UPSERT, modId: FIXTURE.leaf.id });
state = projectReducer(state, {
  type: MODULE_PATCH, modId: FIXTURE.top.id,
  patch: { description: FIXTURE.top.description, level: 0 },
});
state = projectReducer(state, {
  type: MODULE_PATCH, modId: FIXTURE.leaf.id,
  patch: { description: FIXTURE.leaf.description, level: 1 },
});
state = projectReducer(state, {
  type: INSTANCE_UPSERT, instId: "i1",
  instance: {
    parentModuleId: FIXTURE.top.id,
    moduleId: FIXTURE.leaf.id,
    instanceName: "u_nand",
    paramOverrides: {},
    description: "internal NAND instance",
  },
});
state = projectReducer(state, {
  type: DECOMPOSITION_SET,
  decomposition: {
    topModule: FIXTURE.top.id,
    modules: [
      { id: FIXTURE.top.id,  name: FIXTURE.top.id,  description: FIXTURE.top.description,  level: 0 },
      { id: FIXTURE.leaf.id, name: FIXTURE.leaf.id, description: FIXTURE.leaf.description, level: 1 },
    ],
    interconnects: [
      { from: FIXTURE.top.id + ".a_in", to: FIXTURE.leaf.id + ".a" },
      { from: FIXTURE.top.id + ".b_in", to: FIXTURE.leaf.id + ".b" },
    ],
    sharedTypes: [],
  },
});

// Dispatch wrapper: tracks state updates and counts total dispatches
function dispatch(action) {
  dispatchCount++;
  state = projectReducer(state, action);
}
function getState() { return state; }

// ─── Real vs. mock pipeline ─────────────────────────────────────────────────
let pipeline;
let runIntegrationService;
let config;

if (skipLlm) {
  // Deterministic mock pipeline — fast and offline.
  // Every stage returns canned data that matches the shape the next stage expects.
  pipeline = {
    async invokeNode(key, acc) {
      const _llm = {
        stage:     key,
        tokensIn:  100,
        tokensOut: 50,
        latencyMs: 10,
        model:     "mock-model",
        provider:  "mock",
      };
      let result;
      switch (key) {
        case "elicit":
          result = {
            modName: acc._userDesc && acc._userDesc.match(/NAND/i) ? "nand2" : "and2",
            questions: [],
            topLevel: [],
          };
          break;
        case "spec":
          result = {
            iface: [
              { name: "a",   dir: "input",  width: "1" },
              { name: "b",   dir: "input",  width: "1" },
              { name: "y",   dir: "output", width: "1" },
            ],
            params: [],
            requirements: [
              { id: "REQ-FUNC-001", pri: "Must", cat: "Functional", desc: "Output computes the logical function" },
            ],
          };
          break;
        case "architect":
          result = {
            strategy: "Combinational logic with single output gate",
            blocks: [],
            mermaid: "graph TD\n  A[inputs] --> B[gate]\n  B --> C[output]",
          };
          break;
        case "rtl_generate":
          // Vary the module name based on which module we're generating for
          // (accState carries stage data via prior stage keys)
          result = {
            code: "module dut(input wire a, input wire b, output wire y);\n  assign y = a & b;\nendmodule",
          };
          break;
        case "formal_props":
          result = {
            properties: [{ id: "SVA-001", req: "REQ-FUNC-001", type: "assert", name: "p_basic", desc: "y = a AND b", code: "assert property (@(posedge clk) 1);" }],
            autoAssumptions: [],
          };
          break;
        case "lint":
          result = {
            status: "PASS",
            errors: [],
            warnings: [],
            iterations: [{ iter: 1, status: "PASS", errors: 0, warnings: 0 }],
            summary: "clean lint (mock)",
            _taskStatus: "COMPLETE",
          };
          break;
        case "test_generate":
          result = {
            code: "module dut_tb;\n  initial begin\n    $display(\"[PASS] test_00\");\n    $finish;\n  end\nendmodule",
          };
          break;
        case "verify":
          result = {
            sim: "mock",
            pass: 1,
            fail: 0,
            total: 1,
            tests: [{ name: "test_00", st: "PASS" }],
          };
          break;
        case "judge":
          result = {
            overall: "PASS",
            score: 88,
            trace: [],
            recs: [],
          };
          break;
        default:
          result = { synthetic: true, stageKey: key };
      }
      return Object.assign({}, acc, { [key]: result, _llm });
    },
  };

  config = {
    provider: "mock",
    model: "mock-model",
    apiKey: "mock-key-should-not-leak",  // security test
    useGlobalLLM: true,
    maxLintIters: 3,
    maxVerifyIters: 3,
    maxJudgeIters: 3,
  };

  // ── Mock runIntegrationPipeline wrapper with counter-based callLLM ──
  const mockIntegrationResponses = [
    // int_lint
    { text: JSON.stringify({ status: "PASS", issues: [], summary: "clean integration lint" }),
      tokensIn: 150, tokensOut: 80, latencyMs: 20, model: "mock-model", provider: "mock" },
    // int_test (system TB)
    { text: JSON.stringify({ code: "module system_tb;\n  initial begin $display(\"[PASS]\"); $finish; end\nendmodule" }),
      tokensIn: 300, tokensOut: 150, latencyMs: 30, model: "mock-model", provider: "mock" },
    // int_verify
    { text: JSON.stringify({ status: "PASS", pass: 1, fail: 0, total: 1, tests: [{ name: "sys_00", st: "PASS" }] }),
      tokensIn: 120, tokensOut: 60, latencyMs: 15, model: "mock-model", provider: "mock" },
    // int_judge
    { text: JSON.stringify({ overall: "PASS", score: 92, recs: [] }),
      tokensIn: 200, tokensOut: 100, latencyMs: 25, model: "mock-model", provider: "mock" },
  ];
  let mockCallIdx = 0;
  const mockCallLLM = async function(_p) {
    const r = mockIntegrationResponses[mockCallIdx++];
    if (!r) throw new Error("mockCallLLM: out of responses at call " + mockCallIdx);
    return r;
  };
  runIntegrationService = async function() {
    return await runIntegrationPipeline({
      reducerState: getState(),
      uiState: { config },
      services: {
        callLLM:     mockCallLLM,
        extractJSON: JSON.parse,
        estimateCost: () => 0,
        logger: console,
      },
      dispatch,
      lastHashes: {},
    });
  };
} else {
  // Real LM Studio mode
  pipeline = buildPipeline();
  config = {
    provider: "lmstudio",
    baseUrl,
    model: modelOverride || "loaded-model",
    apiKey: "lm-studio-unused",
    maxRetries: 1,
    retryBaseDelayMs: 1000,
    useGlobalLLM: true,
    backendUrl: backendUrl || null,
    lintCmd: "verilator --lint-only -Wall {RTL}",
    simCmds: [
      "verilator --binary -Wall --Mdir obj_dir {TB} {RTL}",
      "find obj_dir -maxdepth 1 -type f -executable -name 'V*' -exec {} \\;",
    ].join("\n"),
    maxLintIters: 2,
    maxVerifyIters: 2,
    maxJudgeIters: 1,
  };

  // Probe LM Studio first — fail fast if unreachable
  try {
    const probe = await fetch(baseUrl + "/models");
    if (!probe.ok) {
      console.error("\nERROR: LM Studio at " + baseUrl + " returned HTTP " + probe.status);
      process.exit(2);
    }
    const data = await probe.json();
    const loaded = (data.data || []).map((m) => m.id);
    if (loaded.length === 0) {
      console.error("\nERROR: LM Studio has no loaded models. Load a model and retry.");
      process.exit(2);
    }
    if (config.model === "loaded-model") {
      config.model = loaded[0];
      console.log("  Model:      " + config.model + " (auto-selected)");
    } else {
      console.log("  Model:      " + config.model);
    }
  } catch (e) {
    console.error("\nERROR: cannot reach LM Studio at " + baseUrl + " — " + e.message);
    console.error("Start LM Studio's local server and retry, or use --skip-llm.");
    process.exit(2);
  }

  runIntegrationService = async function() {
    return await runIntegrationPipeline({
      reducerState: getState(),
      uiState: { config },
      services: {
        callLLM, extractJSON, estimateCost,
        signal: null,
        logger: console,
      },
      dispatch,
      lastHashes: {},
    });
  };
}

// ─── Services bag for runAllPipelines ──────────────────────────────────────
const services = {
  getState,
  pipeline,
  allStages: ALL_STAGES,
  computeContentHash,
  computeIfaceHash,
  estimateCost: skipLlm ? () => 0 : estimateCost,
  logger: {
    info:  (msg) => console.log("  " + ts() + " " + msg),
    warn:  (msg) => console.warn("  " + ts() + " ⚠ " + msg),
    error: (msg) => console.error("  " + ts() + " ✗ " + msg),
  },
  runIntegrationPipeline: skipIntegration ? null : runIntegrationService,
  deleteCheckpoint: async () => {
    // no-op for driver-smoke; real hook would call cm.remove
    return true;
  },
};

// ─── UI state ───────────────────────────────────────────────────────────────
const uiState = {
  userDesc: FIXTURE.top.description,
  designMode: "system",
  mode: "full-auto",
  config,
  lintWarningsAsErrors: false,
  verifyWarningsAsErrors: false,
  activeStages: getActiveStages({ optionalStages: {} }), // 9 stages, no optional
  sharedPackage: null,
  instances: state.instances,
};

// ─── Run it ─────────────────────────────────────────────────────────────────
console.log("\n  " + ts() + " Starting runAllPipelines (full-auto)");
const runResult = await runAllPipelines({
  execMode: "full-auto",
  reducerState: state,
  uiState,
  services,
  dispatch,
});
console.log("  " + ts() + " runAllPipelines completed: ok=" + runResult.ok +
            ", modulesCompleted=" + runResult.modulesCompleted +
            "/" + runResult.modulesTotal);
if (!runResult.ok) {
  console.error("  " + ts() + " ✗ runAllPipelines failed: " + runResult.error);
  process.exit(1);
}

// ─── Reducer state summary ──────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Reducer State After Full Run");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  modules:          " + Object.keys(state.modules).length);
console.log("  activeModId:      " + state.activeModId);
console.log("  projectPhase:     " + state.projectPhase);
console.log("  ledger entries:   " + state.ledger.length);
console.log("  total dispatches: " + dispatchCount);

Object.keys(state.modules).forEach(function(mId) {
  const mod = state.modules[mId];
  const completed = Array.from(mod.completed).sort((a, b) => a - b);
  console.log("  ─ " + mId + ":");
  console.log("      completed:   [" + completed.join(", ") + "]");
  console.log("      stageData:   [" + Object.keys(mod.stageData).sort((a, b) => a - b).join(", ") + "]");
  console.log("      stageRuns:   " + Object.keys(mod.stageRuns).length + " entries");
  console.log("      execPath:    " + mod.executionPath.length + " events");
  console.log("      contentHash: " + (mod.contentHash || "(none)"));
  const childHashKeys = Object.keys(mod.childHashes || {});
  if (childHashKeys.length > 0) {
    console.log("      childHashes: {" + childHashKeys.join(", ") + "}");
  }
});

if (!skipIntegration) {
  console.log("\n  Integration pipeline:");
  const integ = state.integrationState;
  const intCompleted = Array.from(integ.completed).sort();
  console.log("      completed:   [" + intCompleted.join(", ") + "]");
  console.log("      stageData:   [" + Object.keys(integ.stageData).sort().join(", ") + "]");
  const intErrors = Object.keys(integ.errors).filter((k) => integ.errors[k]);
  if (intErrors.length > 0) {
    console.log("      errors:      " + intErrors.join(", "));
  }
}

// ─── Assertions on the final state ──────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Assertions");
console.log("═══════════════════════════════════════════════════════════════");

let errors = [];
function assertT(name, cond, detail) {
  if (cond) {
    console.log("  ✓ " + name);
  } else {
    console.log("  ✗ " + name + (detail ? "  →  " + detail : ""));
    errors.push(name);
  }
}

// Every module completed every active stage from 2 onwards
const activeStageIds = uiState.activeStages.map((s) => s.id).filter((id) => id >= 2);
Object.keys(state.modules).forEach(function(mId) {
  const mod = state.modules[mId];
  const missing = activeStageIds.filter((id) => !mod.completed.has(id));
  assertT(mId + " completed all " + activeStageIds.length + " stages (2→9)",
    missing.length === 0,
    missing.length > 0 ? "missing: " + missing.join(",") : null);
});

// Both modules have contentHash set (stages 2 and 4 should have computed it)
assertT(FIXTURE.top.id + " has contentHash",
  !!state.modules[FIXTURE.top.id].contentHash);
assertT(FIXTURE.leaf.id + " has contentHash",
  !!state.modules[FIXTURE.leaf.id].contentHash);

// Top module has childHashes pointing to leaf
const topChildHashes = state.modules[FIXTURE.top.id].childHashes || {};
assertT("top.childHashes[" + FIXTURE.leaf.id + "] is populated",
  !!topChildHashes[FIXTURE.leaf.id] && !!topChildHashes[FIXTURE.leaf.id].contentHash);
assertT("top.childHashes[" + FIXTURE.leaf.id + "].contentHash matches leaf.contentHash",
  topChildHashes[FIXTURE.leaf.id] &&
  topChildHashes[FIXTURE.leaf.id].contentHash === state.modules[FIXTURE.leaf.id].contentHash);

// Phase transitioned to "done"
assertT("projectPhase is 'done'", state.projectPhase === "done");

// Ledger has entries for every stage × every module + integration stages
const expectedMinLedger = 2 * activeStageIds.length; // per-module stages
assertT("ledger has at least " + expectedMinLedger + " entries",
  state.ledger.length >= expectedMinLedger,
  "got " + state.ledger.length);

// Integration pipeline ran if enabled
if (!skipIntegration) {
  assertT("integration int_lint completed",
    state.integrationState.completed.has("int_lint"));
  assertT("integration int_test completed",
    state.integrationState.completed.has("int_test"));
  assertT("integration int_judge completed",
    state.integrationState.completed.has("int_judge"));
}

// stageRuns has entries per module per stage (from MODULE_STAGE_RUN_START dispatches)
Object.keys(state.modules).forEach(function(mId) {
  const mod = state.modules[mId];
  const runsCount = Object.keys(mod.stageRuns).length;
  assertT(mId + " has stageRuns entries for every completed stage",
    runsCount === activeStageIds.length,
    "got " + runsCount + ", expected " + activeStageIds.length);
  assertT(mId + " executionPath has " + activeStageIds.length + " events",
    mod.executionPath.length === activeStageIds.length,
    "got " + mod.executionPath.length);
});

// ─── Checkpoint round-trip ──────────────────────────────────────────────────
console.log("\n  Checkpoint round-trip:");
const payload = serializeCheckpoint(state, uiState);
assertT("apiKey is NOT leaked in payload",
  !JSON.stringify(payload).includes("mock-key-should-not-leak") &&
  !JSON.stringify(payload).includes("lm-studio-unused"));
assertT("payload version is 3", payload.version === 3);
assertT("payload modules count matches", Object.keys(payload.modules).length === 2);

const storage = createMemoryStorage();
const cm = createCheckpointManager(storage, { allStages: ALL_STAGES });
const saveOk = await cm.save(payload.projectId, payload);
assertT("checkpoint manager save returned true", saveOk === true);

const loaded = await cm.load(payload.projectId);
assertT("checkpoint manager load returned payload", loaded != null);
assertT("loaded payload byte-equals saved",
  JSON.stringify(loaded) === JSON.stringify(payload));

const restored = deserializeCheckpoint(loaded);
assertT("deserialize returned non-null", restored != null);
assertT("restored " + FIXTURE.top.id + " completed is a Set",
  restored && restored.reducerState.modules[FIXTURE.top.id].completed instanceof Set);
assertT("restored " + FIXTURE.leaf.id + " completed matches original",
  restored &&
  Array.from(restored.reducerState.modules[FIXTURE.leaf.id].completed).sort().join(",") ===
  Array.from(state.modules[FIXTURE.leaf.id].completed).sort().join(","));
assertT("restored top.childHashes matches original",
  restored &&
  JSON.stringify(restored.reducerState.modules[FIXTURE.top.id].childHashes) ===
  JSON.stringify(state.modules[FIXTURE.top.id].childHashes));
if (!skipIntegration) {
  assertT("restored integrationState.completed matches original",
    restored &&
    Array.from(restored.reducerState.integrationState.completed).sort().join(",") ===
    Array.from(state.integrationState.completed).sort().join(","));
}

// ─── Final verdict ──────────────────────────────────────────────────────────
const totalElapsed = ((Date.now() - t0) / 1000).toFixed(2);
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Final Verdict");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  Elapsed:          " + totalElapsed + "s");
console.log("  Assertions:       " + (errors.length === 0 ? "all pass" : errors.length + " FAILED"));
console.log("  Dispatches:       " + dispatchCount);
console.log("  Reducer state:    " + Object.keys(state.modules).length + " modules, " +
            state.ledger.length + " ledger entries, phase=" + state.projectPhase);

if (errors.length > 0) {
  console.log("\n  ✗ DRIVER SMOKE FAILED");
  console.log("  Failed assertions:");
  errors.forEach((e) => console.log("    - " + e));
  process.exit(1);
}
console.log("\n  ✓ DRIVER SMOKE PASSED — drivers validated end-to-end");
process.exit(0);
