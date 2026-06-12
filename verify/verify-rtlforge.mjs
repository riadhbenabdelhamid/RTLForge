// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// verify-rtlforge.mjs — Structural tests for src/react/components/RTLForge.jsx
//
// Companion test to verify.mjs. Validates that the minimal RTLForge root
// component parses, exports cleanly, and renders the right phase-specific
// content when invoked with a mocked useProject return value.
//
// ─── Why this verifier is more complex than the others ─────────────────────
//
// RTLForge imports useProject from `../useProject.jsx`, and that hook
// internally calls useReducer / useCallback / useEffect / useMemo with
// REAL logic — the reducer's return shape, the dispatch closure, the
// memoized orchestrators. Our standard test-runtime hook shim returns
// no-op stubs that return the initial value on every render, so if we
// bundle RTLForge + useProject together and run it under the shim, the
// hook's internal state machine produces garbage that makes phase-based
// branching tests meaningless.
//
// Solution: rsync the entire `src/` tree to /tmp, overwrite just the
// `src/react/useProject.jsx` file with a mock that reads a test fixture
// from `globalThis.__TEST_USEPROJECT_FIXTURE__`, then bundle RTLForge
// from the temp tree. All the relative imports (../../constants/*.js,
// ./atoms.jsx, ./stages.jsx, ./panels.jsx, etc) resolve naturally
// because the directory layout is preserved.
//
// Every test then sets a different fixture on the global and invokes
// RTLForge() to get a rendered element tree to walk.

import { writeFileSync, readFileSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import assert from "node:assert";
import { pathToFileURL } from "node:url";

// ─── Setup: rsync src/ tree to /tmp and patch useProject.jsx ────────────────

const srcDir = resolve("src");
try { readFileSync(resolve("src/react/components/RTLForge.jsx"), "utf8"); }
catch (e) {
  console.error("ERROR: src/react/components/RTLForge.jsx not found. Run from rtl-forge-v6/ root.");
  process.exit(2);
}

const workDir  = mkdtempSync(join(tmpdir(), "rtlforge-root-test-"));
const srcCopy  = join(workDir, "src");
const reactShim = join(workDir, "react-shim.mjs");
const compiled = join(workDir, "rtlforge-compiled.mjs");

console.log("copying src/ tree to " + workDir + " …");
cpSync(srcDir, srcCopy, { recursive: true });

// Overwrite the copied useProject.jsx with a mock that reads a global
// test fixture. The mock must export `useProject` as a named export
// because RTLForge imports it that way.
const mockUseProjectSrc = `
export function useProject() {
  if (typeof globalThis.__TEST_USEPROJECT_FIXTURE__ !== "function") {
    throw new Error("useProject mock: set globalThis.__TEST_USEPROJECT_FIXTURE__ before importing RTLForge");
  }
  return globalThis.__TEST_USEPROJECT_FIXTURE__();
}
`;
writeFileSync(join(srcCopy, "react", "useProject.jsx"), mockUseProjectSrc);

// React hook shim
writeFileSync(reactShim, `
export function useState(initial) {
  const value = typeof initial === "function" ? initial() : initial;
  return [value, function noop() {}];
}
export function useRef(initial) { return { current: initial != null ? initial : null }; }
export function useEffect() { /* no-op */ }
export function useMemo(fn) { return fn(); }
export function useCallback(fn) { return fn; }
export function useReducer(reducer, initialArg, init) {
  // Test shim: a fresh useReducer always returns the initial state and a
  // no-op dispatch. The verifier doesn't simulate React reducer state
  // changes — it only needs the initial render shape.
  const initial = typeof init === "function" ? init(initialArg) : initialArg;
  return [initial, function noop() {}];
}
`);

// Bundle RTLForge from the patched tree
console.log("compiling RTLForge.jsx with esbuild…");
try {
  execSync(
    [
      "npx", "--yes", "esbuild@0.20.2",
      join(srcCopy, "react", "components", "RTLForge.jsx"),
      "--loader:.jsx=jsx",
      "--jsx=transform",
      "--jsx-factory=h",
      "--jsx-fragment=Fragment",
      "--format=esm",
      "--bundle",
      "--external:react",
      "--outfile=" + compiled,
    ].join(" "),
    { stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (e) {
  console.error("ERROR: esbuild compile failed:");
  console.error(e.stderr && e.stderr.toString());
  process.exit(2);
}

// Rewrite the React import to our shim
let src = readFileSync(compiled, "utf8");
src = src.replace(
  /from\s+["']react["']/g,
  'from "' + pathToFileURL(reactShim).href + '"',
);

// Inject h() factory
const hFactory = `
const h = (type, props, ...children) => {
  const flat = [];
  const flatten = (arr) => {
    for (const c of arr) {
      if (Array.isArray(c)) flatten(c);
      else if (c != null && c !== false && c !== true) flat.push(c);
    }
  };
  flatten(children);
  return { type, props: props || {}, children: flat };
};
const Fragment = "__fragment__";
`;
writeFileSync(compiled, hFactory + src);

console.log("importing compiled RTLForge…");
const mod = await import(pathToFileURL(compiled).href);
const RTLForge = mod.default;

if (typeof RTLForge !== "function") {
  console.error("ERROR: RTLForge default export is not a function (got " + typeof RTLForge + ")");
  process.exit(2);
}

// ─── Assertion helpers ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const fails = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    fails.push({ name, msg: e.message });
    console.log("  ✗ " + name + "  →  " + e.message);
  }
}

function allNodes(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || !("type" in node)) return out;
  out.push(node);
  if (typeof node.type === "function" && depth < 20) {
    try {
      const expandedProps = Object.assign({}, node.props || {});
      if (node.children && node.children.length > 0) {
        expandedProps.children = node.children.length === 1 ? node.children[0] : node.children;
      }
      const expanded = node.type(expandedProps);
      if (expanded && typeof expanded === "object" && "type" in expanded) {
        allNodes(expanded, out, depth + 1);
      }
    } catch (_e) { /* skip */ }
  }
  (node.children || []).forEach((c) => allNodes(c, out, depth + 1));
  return out;
}

function findByText(node, text) {
  const target = String(text);
  const all = allNodes(node);
  for (const n of all) {
    let joined = "";
    for (const c of n.children || []) {
      if (c == null) continue;
      if (typeof c === "string") joined += c;
      else if (typeof c === "number") joined += String(c);
    }
    if (joined.includes(target)) return n;
  }
  return null;
}

const noop = () => {};
const noopAsync = async () => ({ ok: true });

// Build a useProject fixture with sensible defaults
function mkHook(overrides = {}) {
  const state = Object.assign({
    projectPhase: "idle",
    modules: {},
    instances: {},
    activeModId: null,
    ledger: [],
    decomposition: null,
    decompError: null,
    integrationState: { stageData: {}, completed: new Set(), errors: {} },
    sharedPackage: null,
    pipelineProgress: null,
  }, overrides.state || {});
  const activeMod = overrides.activeMod !== undefined ? overrides.activeMod : null;
  const activeStages = overrides.activeStages || [
    { id: 1, key: "elicit",        label: "Elicit",   desc: "Spec discovery" },
    { id: 2, key: "spec",          label: "Spec",     desc: "Requirements" },
    { id: 3, key: "architect",     label: "Architect", desc: "Micro-architecture" },
    { id: 4, key: "rtl_generate",  label: "RTL",      desc: "SystemVerilog" },
    { id: 5, key: "formal_props",  label: "Formal",   desc: "SVA properties" },
    { id: 6, key: "lint",          label: "Lint",     desc: "Static analysis" },
    { id: 7, key: "test_generate", label: "TB",       desc: "Testbench" },
    { id: 8, key: "verify",        label: "Verify",   desc: "Simulation" },
    { id: 9, key: "judge",         label: "Judge",    desc: "Final verdict" },
  ];
  return Object.assign({
    state, dispatch: noop,
    activeMod, activeStages,
    isMultiModule: false, allModulesComplete: false, ledgerTotals: {},
    // Backward-compat derived shortcuts
    modules: state.modules, instances: state.instances,
    projectPhase: state.projectPhase,
    decomposition: state.decomposition, decompError: state.decompError,
    ledger: state.ledger, totals: {},
    integrationState: state.integrationState,
    sharedPackage: state.sharedPackage,
    pipelineProgress: state.pipelineProgress,
    activeModId: state.activeModId,
    stageData: activeMod ? (activeMod.stageData || {}) : {},
    stageErrors: activeMod ? (activeMod.stageErrors || {}) : {},
    completed: activeMod ? (activeMod.completed || new Set()) : new Set(),
    stageRuns: activeMod ? (activeMod.stageRuns || {}) : {},
    executionPath: activeMod ? (activeMod.executionPath || []) : [],
    modName: "_init", LAST_STAGE: 9,
    // Dispatch wrappers
    setActiveModId: noop, setProjectPhase: noop, setModules: noop, setInstances: noop,
    setDecomposition: noop, setDecompError: noop, setSharedPackage: noop,
    // Module helpers
    getModule: noop, updateModule: noop, updateSD: noop, addLedger: noop,
    runStageForModule: noopAsync, moduleProgress: () => ({ total: 0, complete: 0, errors: 0, pct: 0 }),
    moduleProgressSummary: { total: 0, complete: 0, errors: 0, pct: 0 },
    nextStageId: () => null, stageIdsFrom: () => [], isStageActive: () => false,
    // Navigation
    userDesc: "", setUserDesc: noop,
    activeStage: 0, setActiveStage: noop,
    viewingStage: 1, setViewingStage: noop,
    processing: false, propagating: false, setPropagating: noop,
    mode: "semi-auto", setMode: noop,
    designMode: "module", setDesignMode: noop,
    // UI panels
    showSettings: false, setShowSettings: noop,
    showLedger: false, setShowLedger: noop,
    showDebug: {}, setShowDebug: noop,
    // Config
    config: {
      provider: "anthropic", model: "claude-sonnet-4", apiKey: "sk-test",
      optionalStages: { formal_props: true, lint: true }, promptOverrides: {}, stageSettings: {},
    },
    setConfig: noop,
    // Actions
    runStage: noopAsync, runAllPipelines: noopAsync, runIntegrationPipeline: noopAsync,
    proceed: noop, abortCurrentStage: noop, switchModule: noop,
    handleLaunch: noopAsync, handleRerun: noopAsync, handleExport: noop, handleManualImport: noop,
    // Run tabs
    activeRunTab: null, setActiveRunTab: noop,
    // Decomposition
    confirmDecomp: noop, handleBackToIdle: noop, handleRedecompose: noopAsync,
    // Sidebar
    showSidebar: true, setShowSidebar: noop,
    sidebarSearch: "", setSidebarSearch: noop,
    sidebarTab: "level", setSidebarTab: noop,
    // Shared package
    viewingSharedPkg: false, setViewingSharedPkg: noop,
    editingSharedPkg: false, setEditingSharedPkg: noop,
    // Integration
    viewingIntegration: false, setViewingIntegration: noop,
    activeIntStage: null, setActiveIntStage: noop,
    // Export
    exportModulePackage: noop, exportSystemPackage: noop,
    handleExportAll: noop, handleCopyManifest: noop,
    // Import / Library
    importedPackages: {}, setImportedPackages: noop,
    importPackage: noopAsync, importModuleFromPkg: noop,
    importSystemBlackBox: noop, importSystemExploded: noop,
    importDialog: null, setImportDialog: noop,
    importFileRef: { current: null }, triggerImport: noop,
    detachModule: noop,
    libraryMatches: [], setLibraryMatches: noop, applyLibraryMatches: noop,
    deletePackageFromLibrary: noopAsync, redownloadPackage: noop, clearLibrary: noopAsync,
    buildAvailableModules: () => [],
    // Staleness
    staleModules: {}, setStaleModules: noop, propagateChanges: noopAsync,
    // Warnings
    lintWarningsAsErrors: false, setLintWarningsAsErrors: noop,
    verifyWarningsAsErrors: false, setVerifyWarningsAsErrors: noop,
    // Manual import
    manualImportDialog: null, setManualImportDialog: noop,
    manualImportText: "", setManualImportText: noop,
    manualImportFileRef: { current: null },
    // Checkpoint
    projectId: null,
    pendingResume: null, setPendingResume: noop,
    checkpointIndex: [], setCheckpointIndex: noop,
    lastCheckpointTs: null, saveFlash: null,
    saveCheckpointNow: noopAsync, resumeFromCheckpoint: noopAsync, discardCheckpoint: noopAsync,
    // Backend
    backendVerified: null, setBackendVerified: noop,
    // Escape hatches
    pipeline: null, services: null,
  }, overrides);
}

function runWithHook(hookReturn) {
  globalThis.__TEST_USEPROJECT_FIXTURE__ = () => hookReturn;
  return RTLForge();
}

// ─── Module surface ─────────────────────────────────────────────────────────
console.log("\n[module surface]");
check("RTLForge is a default export function", () => {
  assert.equal(typeof RTLForge, "function");
});

// ─── Header (rendered in all phases) ───────────────────────────────────────
console.log("\n[header]");

check("renders RTL Forge brand", () => {
  const el = runWithHook(mkHook());
  assert.ok(findByText(el, "RTL Forge"));
});

check("renders banner subtitle from active workflow label", () => {
  // The banner subtitle is derived from the active workflow, not a static
  // string. With the default workflow ("rtl"), the label is
  // "Spec-based RTL flow".
  const el = runWithHook(mkHook());
  assert.ok(findByText(el, "Spec-based RTL flow"),
    "expected workflow label 'Spec-based RTL flow' in banner");
});

check("renders MODE label", () => {
  const el = runWithHook(mkHook());
  assert.ok(findByText(el, "MODE"));
});

check("renders mode selector as <select>", () => {
  const el = runWithHook(mkHook());
  const all = allNodes(el);
  const selects = all.filter((n) => n.type === "select");
  assert.ok(selects.length >= 1);
});

check("renders model tag", () => {
  const el = runWithHook(mkHook());
  assert.ok(findByText(el, "claude-sonnet-4"));
});

check("settings button is present", () => {
  const el = runWithHook(mkHook());
  const all = allNodes(el);
  const gearButtons = all.filter((n) => {
    if (n.type !== "button") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined.includes("⚙");
  });
  assert.ok(gearButtons.length >= 1);
});

check("checkpoint save button hidden when not running (idle phase)", () => {
  const el = runWithHook(mkHook({
    state: { projectPhase: "idle", modules: {}, activeModId: null, ledger: [] },
  }));
  const all = allNodes(el);
  const saveButtons = all.filter((n) => {
    if (n.type !== "button") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined.includes("💾");
  });
  assert.equal(saveButtons.length, 0);
});

check("checkpoint save button visible when running", () => {
  const el = runWithHook(mkHook({
    state: { projectPhase: "running", modules: { m1: {} }, activeModId: "m1", ledger: [] },
    activeMod: { modId: "m1", completed: new Set(), stageErrors: {}, stageData: {} },
  }));
  const all = allNodes(el);
  const saveButtons = all.filter((n) => {
    if (n.type !== "button") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined.includes("💾");
  });
  assert.equal(saveButtons.length, 1);
});

// ─── Idle phase ─────────────────────────────────────────────────────────────
console.log("\n[idle phase]");

check("idle: renders 'Describe Your Design' heading", () => {
  const el = runWithHook(mkHook());
  assert.ok(findByText(el, "Describe Your Design"));
});

check("idle: renders textarea for description", () => {
  const el = runWithHook(mkHook());
  const all = allNodes(el);
  const textareas = all.filter((n) => n.type === "textarea");
  assert.equal(textareas.length, 1);
});

check("idle: renders Launch button", () => {
  const el = runWithHook(mkHook());
  assert.ok(findByText(el, "Launch Module Pipeline"));
});

check("idle: Launch button disabled when userDesc is empty", () => {
  const el = runWithHook(mkHook({ userDesc: "" }));
  const all = allNodes(el);
  const launchBtn = all.find((n) => {
    if (n.type !== "button") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined.includes("Launch");
  });
  assert.ok(launchBtn);
  // Btn unbinds onClick when disabled
  assert.equal(launchBtn.props.onClick, undefined);
});

check("idle: Launch button enabled when userDesc present", () => {
  const el = runWithHook(mkHook({ userDesc: "A FIFO with configurable depth" }));
  const all = allNodes(el);
  const launchBtn = all.find((n) => {
    if (n.type !== "button") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined.includes("Launch");
  });
  assert.ok(launchBtn);
  assert.notEqual(launchBtn.props.onClick, undefined);
});

check("idle: does NOT render the stage sidebar", () => {
  const el = runWithHook(mkHook());
  assert.equal(findByText(el, "Run Next"), null);
  assert.equal(findByText(el, "Rerun Stage"), null);
});

// ─── Running phase ──────────────────────────────────────────────────────────
console.log("\n[running phase]");

function runningHook(overrides = {}) {
  const modData = Object.assign({
    modId: "m1",
    modName: "my_fifo",
    activeStage: 3,
    viewingStage: 2,
    completed: new Set([1, 2]),
    stageErrors: {},
    stageData: {
      1: {
        domain: "FIFO",
        questions: [],
        assumptions: [],
        answers: {},
        customAnswers: {},
      },
      2: {
        requirements: [
          { id: "REQ-FUNC-001", cat: "Functional", pri: "Must", desc: "Must buffer data" },
        ],
        iface: [{ name: "clk", dir: "input", width: "1", desc: "Clock" }],
        params: [],
      },
    },
  }, overrides.activeMod || {});
  return mkHook(Object.assign({}, overrides, {
    state: Object.assign({
      projectPhase: "running",
      modules: { m1: modData },
      instances: {},
      activeModId: "m1",
      ledger: [],
      decomposition: null, decompError: null,
      integrationState: { stageData: {}, completed: new Set(), errors: {} },
      sharedPackage: null, pipelineProgress: null,
    }, overrides.state || {}),
    activeMod: modData,
    modName: overrides.modName || modData.modName || "my_fifo",
    stageData: modData.stageData || {},
    stageErrors: modData.stageErrors || {},
    completed: modData.completed || new Set(),
    stageRuns: modData.stageRuns || {},
    executionPath: modData.executionPath || [],
    modules: { m1: modData },
    instances: {},
    activeModId: "m1",
    viewingStage: overrides.viewingStage != null ? overrides.viewingStage : 2,
    activeStage: overrides.activeStage != null ? overrides.activeStage : 3,
  }));
}

check("running: renders stage tabs with stage labels", () => {
  const el = runWithHook(runningHook());
  // Full RTLForge uses horizontal stage tabs, not a "Stages" sidebar
  assert.ok(findByText(el, "Elicit"));
  assert.ok(findByText(el, "Spec"));
  assert.ok(findByText(el, "Judge"));
});

check("running: renders per-stage labels in sidebar", () => {
  const el = runWithHook(runningHook());
  assert.ok(findByText(el, "Elicit"));
  assert.ok(findByText(el, "Spec"));
  assert.ok(findByText(el, "Judge"));
});

check("running: sidebar shows check marks for completed stages", () => {
  const el = runWithHook(runningHook());
  const all = allNodes(el);
  const checks = all.filter((n) => {
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined === "✓";
  });
  // At least 2 completed stages → at least 2 check marks
  assert.ok(checks.length >= 2, "expected >= 2 check marks, got " + checks.length);
});

check("running: stage header renders the viewing stage label", () => {
  const el = runWithHook(runningHook({ viewingStage: 2, activeStage: 3 }));
  // The full RTLForge renders viewMeta.label in the stage content header
  assert.ok(findByText(el, "Spec"));
});

check("running: COMPLETE tag on completed stage", () => {
  const el = runWithHook(runningHook({ viewingStage: 2, activeStage: 3 }));
  // Full version uses "COMPLETE" not "DONE"
  assert.ok(findByText(el, "COMPLETE"));
});

check("running: Re-run button renders for completed stage", () => {
  const el = runWithHook(runningHook({ viewingStage: 2, activeStage: 3, processing: false }));
  // Full version has "⟲ Re-run" in the stage header actions
  assert.ok(findByText(el, "Re-run"));
});

check("running: Abort button renders when processing on active stage", () => {
  const el = runWithHook(runningHook({ viewingStage: 3, activeStage: 3, processing: true }));
  assert.ok(findByText(el, "Abort"));
});

check("running: Proceed button after completing active stage", () => {
  // When viewingStage === activeStage AND it's completed AND < LAST_STAGE
  const hook = runningHook({
    viewingStage: 2, activeStage: 2, processing: false,
    activeMod: {
      modId: "m1", modName: "my_fifo", activeStage: 2,
      completed: new Set([1, 2]),
      stageErrors: {},
      stageData: {
        1: { domain: "FIFO", questions: [], assumptions: [], answers: {}, customAnswers: {} },
        2: { requirements: [{ id: "R1", cat: "Functional", pri: "Must", desc: "x" }], iface: [], params: [] },
      },
    },
  });
  const el = runWithHook(hook);
  assert.ok(findByText(el, "Proceed"));
});

check("running: module name appears in header when set", () => {
  const hook = runningHook({ modName: "my_fifo" });
  const el = runWithHook(hook);
  assert.ok(findByText(el, "my_fifo"));
});

check("running: renders stage content when viewing a stage with data", () => {
  const el = runWithHook(runningHook({ viewingStage: 2 }));
  // SpecStage default tab is Requirements — the REQ ID from our fixture
  assert.ok(findByText(el, "REQ-FUNC-001"));
});

check("running: renders 'No data yet' for stage with no data", () => {
  const el = runWithHook(runningHook({ viewingStage: 5, activeStage: 5 }));
  assert.ok(findByText(el, "No data yet"));
});

check("running: stage with error shows ERROR tag + error message", () => {
  const hook = runningHook({
    viewingStage: 4, activeStage: 4,
    activeMod: {
      modId: "m1", modName: "my_fifo", activeStage: 4,
      completed: new Set([1, 2, 3]),
      stageErrors: { 4: "RTL generation failed — LLM timeout" },
      stageData: {
        1: { domain: "x", questions: [], assumptions: [], answers: {}, customAnswers: {} },
        2: { requirements: [], iface: [], params: [] },
        3: { strategy: "x", description: "y", blocks: [] },
      },
    },
  });
  const el = runWithHook(hook);
  assert.ok(findByText(el, "ERROR"));
  assert.ok(findByText(el, "RTL generation failed"));
});

// Errored stage tabs must remain clickable + visually active. If `reachable`
// were `done || isCur || isStale`, a failed lint or verify stage (where
// done=false because failed stages aren't marked completed) would get
// opacity: 0.25 and cursor: default when the user navigated to a different
// stage to look at it — they'd see the red failed tab but couldn't click it
// to review or retry. `reachable` must include hasErr.
//
// IMPORTANT: this test must place activeStage on a DIFFERENT stage than the
// failing one — that's the user-flow that actually triggered the bug. If
// activeStage equals the errored stage's id, `isCur` rescues `reachable`
// even with the buggy predicate, masking the bug.
check("running: errored stage tab is clickable (not greyed out)", () => {
  // Real-world scenario: pipeline halted on Lint (stage 6). User clicked
  // back to RTL (stage 4) to inspect the generated code, then tried to
  // click the red Lint tab to retry — and couldn't. Reproduces by setting
  // the active stage to RTL (4) while stage 6 carries a stageError.
  const hook = runningHook({
    viewingStage: 4, activeStage: 4,
    activeMod: {
      modId: "m1", modName: "my_fifo", activeStage: 4,
      completed: new Set([1, 2, 3, 4, 5]),
      stageErrors: { 6: "Verilator returned %Error: undeclared signal" },
      stageData: {
        1: { domain: "x", questions: [], assumptions: [], answers: {}, customAnswers: {} },
        2: { requirements: [], iface: [], params: [] },
        3: { strategy: "x", description: "y", blocks: [] },
        4: { code: "module x; endmodule" },
        5: { properties: [] },
      },
    },
  });
  const el = runWithHook(hook);
  // Find the Lint stage tab button. Stage tab buttons live in the tab row
  // and have two children: a circular badge span (text "!"/"✓"/digit) and
  // a label span (the stage label text). We disambiguate by looking for a
  // button that has at least one span child whose text equals exactly
  // "Lint" (and no Lint-Test confusion since that label is "Lint Test").
  const all = allNodes(el);
  const lintTab = all.find(function(n) {
    if (!n || n.type !== "button") return false;
    for (const c of (n.children || [])) {
      if (!c || typeof c !== "object" || c.type !== "span") continue;
      // Check this single span's direct text content.
      let spanText = "";
      for (const cc of (c.children || [])) {
        if (typeof cc === "string") spanText += cc;
      }
      if (spanText.trim() === "Lint") return true;
    }
    return false;
  });
  assert.ok(lintTab, "could not locate the Lint stage tab button");
  const style = (lintTab.props && lintTab.props.style) || {};
  // Both opacity and cursor must reflect reachable=true.
  assert.equal(style.opacity, 1,
    "errored Lint tab should not be greyed out (opacity must be 1, got " + style.opacity + ")");
  assert.equal(style.cursor, "pointer",
    "errored Lint tab cursor should be 'pointer' (got " + style.cursor + ")");
  assert.equal(typeof lintTab.props.onClick, "function",
    "errored Lint tab must have an onClick handler");
});

// Partial stage data with no `completed` entry must also
// keep the tab reachable. Scenario: a stage's pipeline produced output
// (DATA_SET landed) but the surrounding state machine never reached the
// COMPLETE dispatch — e.g. a checkpoint restored from an older format
// that has stageData but no completed Set entry, or a synchronous error
// after DATA_SET. Without the `(sd != null)` clause the user could see
// a populated lint result on disk but no way to navigate to it.
check("running: partial-stage-data tab is clickable even if not in completed Set", () => {
  // viewingStage and activeStage are both stage 4 (RTL Gen) so neither
  // isCur nor isView rescues stage 6 (Lint). We deliberately omit 6 from
  // `completed` but provide `stageData[6]` with a populated lint report.
  // We also DO NOT set stageErrors[6], so hasErr is false. This isolates
  // the (sd != null) path from the hasErr path.
  const hook = runningHook({
    viewingStage: 4, activeStage: 4,
    activeMod: {
      modId: "m1", modName: "my_fifo", activeStage: 4,
      completed: new Set([1, 2, 3, 4, 5]),  // 6 deliberately missing
      stageErrors: {},                        // no error either
      stageData: {
        1: { domain: "x", questions: [], assumptions: [], answers: {}, customAnswers: {} },
        2: { requirements: [], iface: [], params: [] },
        3: { strategy: "x", description: "y", blocks: [] },
        4: { code: "module x; endmodule" },
        5: { properties: [] },
        6: { tool: "Verilator", status: "FAIL", errors: [{ msg: "undeclared signal" }], warnings: [], summary: "1 error" },
      },
    },
  });
  const el = runWithHook(hook);
  const all = allNodes(el);
  const lintTab = all.find(function(n) {
    if (!n || n.type !== "button") return false;
    for (const c of (n.children || [])) {
      if (!c || typeof c !== "object" || c.type !== "span") continue;
      let spanText = "";
      for (const cc of (c.children || [])) {
        if (typeof cc === "string") spanText += cc;
      }
      if (spanText.trim() === "Lint") return true;
    }
    return false;
  });
  assert.ok(lintTab, "could not locate the Lint stage tab button");
  const style = (lintTab.props && lintTab.props.style) || {};
  assert.equal(style.opacity, 1,
    "lint tab with stageData but no completed entry must not be greyed (opacity 1, got " + style.opacity + ")");
  assert.equal(style.cursor, "pointer",
    "lint tab with partial data must have pointer cursor (got " + style.cursor + ")");
});

check("running: ElicitStage renders for viewingStage=1", () => {
  const el = runWithHook(runningHook({ viewingStage: 1, activeStage: 1 }));
  // ElicitStage renders a "Domain: FIFO" tag from our fixture
  assert.ok(findByText(el, "Domain: FIFO"));
});

// In system mode (multi-module) a loopback signal MUST be scoped to the
// module that originated it. If the signal were a single global stageId,
// when module B's pipeline triggered a loopback to stage 1, module A's
// already-completed stage 1 tab would also pulse bright-yellow.
check("running: loopback animation is scoped to the originating module", () => {
  // Set up: viewing module A (m1, completed stages 1+2). A loopback is
  // active but it's targeting module B's stage 1, NOT A's.
  const hook = runningHook({
    processing: true,
    loopbackStageId: 1,            // drives the `=== s.id` check
    loopbackModId: "m2",           // but it's module B that's looping
    activeModId: "m1",             // viewing module A
  });
  const el = runWithHook(hook);
  const all = allNodes(el);
  // Find the badge spans inside the stage-tab buttons. Each button has
  // exactly one inner span with a 20×20 round badge (the icon).
  const badges = all.filter(function(n) {
    if (!n || n.type !== "span") return false;
    const s = n.props && n.props.style;
    if (!s || s.width !== 20 || s.height !== 20) return false;
    return true;
  });
  // None of the active-module's tab badges should carry a pulseFast
  // animation, because the loopback originates in module B.
  for (const b of badges) {
    const anim = String((b.props && b.props.style && b.props.style.animation) || "");
    assert.ok(!/pulseFast/.test(anim),
      "stage badge must not pulse when loopback is for a different module (got " + anim + ")");
  }
});

check("running: loopback animation IS shown when modId matches the active module", () => {
  // Same setup but the loopback IS for the viewing module — pulse should fire.
  const hook = runningHook({
    processing: true,
    loopbackStageId: 1,
    loopbackModId: "m1",   // matches activeModId
    activeModId: "m1",
    activeStage: 8,         // current is somewhere downstream so isCur != s.id
    viewingStage: 8,
  });
  const el = runWithHook(hook);
  const all = allNodes(el);
  const pulsing = all.filter(function(n) {
    if (!n || n.type !== "span") return false;
    const s = n.props && n.props.style;
    return s && s.width === 20 && s.height === 20 && /pulseFast/.test(String(s.animation || ""));
  });
  assert.ok(pulsing.length === 1,
    "exactly one stage badge should pulseFast for active-mod loopback (got " + pulsing.length + ")");
});

check("running: loopback with null modId falls back to 'matches any' (single-mod compat)", () => {
  // Older code paths and tests that don't carry modId (loopbackModId === null)
  // should still pulse the active-mod tab — backward compat for single-
  // module callers that never set modId.
  const hook = runningHook({
    processing: true,
    loopbackStageId: 1,
    loopbackModId: null,    // not provided
    activeModId: "m1",
    activeStage: 8, viewingStage: 8,
  });
  const el = runWithHook(hook);
  const all = allNodes(el);
  const pulsing = all.filter(function(n) {
    if (!n || n.type !== "span") return false;
    const s = n.props && n.props.style;
    return s && s.width === 20 && s.height === 20 && /pulseFast/.test(String(s.animation || ""));
  });
  assert.ok(pulsing.length === 1,
    "null modId should not block the pulse (got " + pulsing.length + " pulsing badges)");
});

// ─── Decomposing / review_decomp ─────────────────────────────────────────────
console.log("\n[system mode phases]");

check("decomposing phase: shows spinner text", () => {
  const el = runWithHook(mkHook({
    state: { projectPhase: "decomposing", modules: {}, instances: {}, activeModId: null, ledger: [], decomposition: null, decompError: null, integrationState: { stageData: {}, completed: new Set(), errors: {} }, sharedPackage: null, pipelineProgress: null },
  }));
  assert.ok(findByText(el, "Decomposing"));
});

check("review_decomp phase: shows DecompReview header", () => {
  const el = runWithHook(mkHook({
    state: {
      projectPhase: "review_decomp",
      modules: { top: { name: "top", description: "Top", level: 0, params: [] } },
      instances: {},
      activeModId: null,
      ledger: [],
      decomposition: { systemName: "test_sys", topModule: "top" },
      decompError: null,
      integrationState: { stageData: {}, completed: new Set(), errors: {} },
      sharedPackage: null,
      pipelineProgress: null,
    },
    modules: { top: { name: "top", description: "Top", level: 0, params: [] } },
    instances: {},
    decomposition: { systemName: "test_sys", topModule: "top" },
  }));
  assert.ok(findByText(el, "System Decomposition"));
});

// ─── Done phase ─────────────────────────────────────────────────────────────
console.log("\n[done phase]");

check("done: still renders stage tabs", () => {
  const hook = runningHook({
    state: { projectPhase: "done" },
  });
  const el = runWithHook(hook);
  // Stage tab labels should still be visible
  assert.ok(findByText(el, "Elicit"));
  assert.ok(findByText(el, "Judge"));
});

check("done: completed stages show check marks", () => {
  const hook = runningHook({
    state: { projectPhase: "done" },
    processing: false,
  });
  const el = runWithHook(hook);
  const all = allNodes(el);
  const checks = all.filter((n) => {
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined === "✓";
  });
  assert.ok(checks.length >= 2, "expected >= 2 check marks, got " + checks.length);
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failed);
if (failed > 0) {
  console.log("\nFailures:");
  fails.forEach((f) => console.log("  • " + f.name + ": " + f.msg));
  process.exit(1);
}
console.log("  Status: ALL PASS ✓");
console.log("═══════════════════════════════════════");
