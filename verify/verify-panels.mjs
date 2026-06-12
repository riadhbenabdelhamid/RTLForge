// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// verify-panels.mjs — Structural tests for src/react/components/panels.jsx
//
// Companion test to verify.mjs. Validates that all 4 extracted panel
// components (SplitCodeView, ResumeDialog, SettingsPanel, DecompReview)
// parse, export cleanly, and render coherent element trees for various
// prop shapes including edge cases.
//
// Same esbuild + React shim + h-factory + import-walk pattern as
// verify-atoms.mjs, verify-stages.mjs, verify-workflow.mjs.

import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import assert from "node:assert";
import { pathToFileURL } from "node:url";

// ─── Setup ──────────────────────────────────────────────────────────────────

const panelsPath = resolve("src/react/components/panels.jsx");
try { readFileSync(panelsPath, "utf8"); }
catch (e) {
  console.error("ERROR: " + panelsPath + " not found. Run from rtl-forge-v6/ root.");
  process.exit(2);
}

const workDir   = mkdtempSync(join(tmpdir(), "rtlforge-panels-test-"));
const compiled  = join(workDir, "panels-compiled.mjs");
const reactShim = join(workDir, "react-shim.mjs");

writeFileSync(reactShim, `
export function useState(initial) {
  const value = typeof initial === "function" ? initial() : initial;
  return [value, function noop() {}];
}
export function useRef(initial) { return { current: initial != null ? initial : null }; }
export function useEffect() { /* no-op */ }
export function useMemo(fn) { return fn(); }
export function useCallback(fn) { return fn; }
`);

console.log("compiling panels.jsx with esbuild…");
try {
  execSync(
    [
      "npx", "--yes", "esbuild@0.20.2",
      panelsPath,
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

let src = readFileSync(compiled, "utf8");
src = src.replace(
  /from\s+["']react["']/g,
  'from "' + pathToFileURL(reactShim).href + '"',
);

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

console.log("importing compiled panels…");
const panels = await import(pathToFileURL(compiled).href);

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

// Walker with component-function expansion
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
const noopAsync = async () => {};

// ─── Module surface ─────────────────────────────────────────────────────────
console.log("\n[module surface]");
const expectedExports = ["SplitCodeView", "ResumeDialog", "SettingsPanel", "DecompReview"];
expectedExports.forEach((name) => {
  check(name + " is exported as a function", () => {
    assert.equal(typeof panels[name], "function", "got " + typeof panels[name]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SplitCodeView
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[SplitCodeView]");

check("SplitCodeView: renders Code Only toggle button", () => {
  const el = panels.SplitCodeView({ code: "let x=1;", fixes: [], label: "rtl" });
  assert.ok(findByText(el, "Code Only"));
});

check("SplitCodeView: fixes button hidden when no fixes", () => {
  const el = panels.SplitCodeView({ code: "let x=1;", fixes: [], label: "rtl" });
  assert.equal(findByText(el, "Fixes Only"), null);
});

check("SplitCodeView: fixes button shown when fixes exist", () => {
  const el = panels.SplitCodeView({
    code: "let x=1;",
    fixes: ["fix 1", "fix 2"],
    label: "rtl",
  });
  assert.ok(findByText(el, "Fixes Only"));
});

check("SplitCodeView: fixSource banner renders when provided", () => {
  const el = panels.SplitCodeView({
    code: "let x=1;",
    fixes: [],
    label: "rtl",
    fixSource: "lint iter 2",
  });
  assert.ok(findByText(el, "Code modified"));
  assert.ok(findByText(el, "lint iter 2"));
});

check("SplitCodeView: manualImport banner renders when flag set", () => {
  const el = panels.SplitCodeView({
    code: "x",
    fixes: [],
    label: "TB",
    manualImport: true,
    importedAt: "2025-01-01T12:00:00Z",
  });
  assert.ok(findByText(el, "Manually imported"));
});

check("SplitCodeView: no banners when flags absent", () => {
  const el = panels.SplitCodeView({ code: "x", fixes: [], label: "rtl" });
  assert.equal(findByText(el, "Code modified"), null);
  assert.equal(findByText(el, "Manually imported"), null);
});

check("SplitCodeView: iteration selector appears when iterations.length > 1", () => {
  const el = panels.SplitCodeView({
    code: "x",
    fixes: [],
    iterations: [{ label: "Iter 1" }, { label: "Iter 2" }],
    label: "rtl",
    currentIteration: 0,
    onSelectIteration: noop,
  });
  assert.ok(findByText(el, "Snapshot"));
});

check("SplitCodeView: iteration selector hidden when single iteration", () => {
  const el = panels.SplitCodeView({
    code: "x",
    fixes: [],
    iterations: [{ label: "Iter 1" }],
    label: "rtl",
  });
  assert.equal(findByText(el, "Snapshot"), null);
});

check("SplitCodeView: fix panel shows 'No fixes applied' when empty", () => {
  const el = panels.SplitCodeView({ code: "x", fixes: [], label: "rtl" });
  assert.ok(findByText(el, "No fixes applied"));
});

check("SplitCodeView: fix panel shows each fix", () => {
  const el = panels.SplitCodeView({
    code: "x",
    fixes: ["Added always_ff", "Removed latch"],
    label: "rtl",
  });
  assert.ok(findByText(el, "Added always_ff"));
  assert.ok(findByText(el, "Removed latch"));
});

check("SplitCodeView: fix count displayed in header", () => {
  const el = panels.SplitCodeView({
    code: "x",
    fixes: ["a", "b", "c"],
    label: "rtl",
  });
  assert.ok(findByText(el, "Fixes (3)"));
});

// ═══════════════════════════════════════════════════════════════════════════
// ResumeDialog
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[ResumeDialog]");

check("ResumeDialog: returns null when checkpoint is null", () => {
  const result = panels.ResumeDialog({ checkpoint: null, onResume: noop, onDiscard: noop });
  assert.equal(result, null);
});

check("ResumeDialog: returns null when checkpoint is undefined", () => {
  const result = panels.ResumeDialog({ onResume: noop, onDiscard: noop });
  assert.equal(result, null);
});

function ckFixture(overrides = {}) {
  return Object.assign({
    projectId: "p1",
    userDesc: "An 8-bit carry-save adder",
    designMode: "module",
    timestamp: new Date().toISOString(),
    modules: {
      adder: { completed: { size: 3 } },
    },
  }, overrides);
}

check("ResumeDialog: renders header text", () => {
  const el = panels.ResumeDialog({ checkpoint: ckFixture(), onResume: noop, onDiscard: noop });
  assert.ok(findByText(el, "Unfinished Project Detected"));
});

check("ResumeDialog: shows user description truncated", () => {
  const el = panels.ResumeDialog({ checkpoint: ckFixture(), onResume: noop, onDiscard: noop });
  assert.ok(findByText(el, "8-bit carry-save adder"));
});

check("ResumeDialog: truncates descriptions longer than 150 chars with ellipsis", () => {
  const longDesc = "A".repeat(200);
  const el = panels.ResumeDialog({
    checkpoint: ckFixture({ userDesc: longDesc }),
    onResume: noop, onDiscard: noop,
  });
  assert.ok(findByText(el, "…"));
});

check("ResumeDialog: module mode shows 'Module' label", () => {
  const el = panels.ResumeDialog({
    checkpoint: ckFixture({ designMode: "module" }),
    onResume: noop, onDiscard: noop,
  });
  assert.ok(findByText(el, "Module"));
});

check("ResumeDialog: system mode shows 'System' label", () => {
  const el = panels.ResumeDialog({
    checkpoint: ckFixture({ designMode: "system" }),
    onResume: noop, onDiscard: noop,
  });
  assert.ok(findByText(el, "System"));
});

check("ResumeDialog: shows Resume button", () => {
  const el = panels.ResumeDialog({ checkpoint: ckFixture(), onResume: noop, onDiscard: noop });
  assert.ok(findByText(el, "Resume"));
});

check("ResumeDialog: shows Discard button", () => {
  const el = panels.ResumeDialog({ checkpoint: ckFixture(), onResume: noop, onDiscard: noop });
  assert.ok(findByText(el, "Discard"));
});

check("ResumeDialog: mentions API key warning", () => {
  const el = panels.ResumeDialog({ checkpoint: ckFixture(), onResume: noop, onDiscard: noop });
  assert.ok(findByText(el, "API key"));
});

check("ResumeDialog: Resume button triggers onResume with checkpoint", () => {
  let resumedWith = null;
  const ck = ckFixture();
  const el = panels.ResumeDialog({
    checkpoint: ck,
    onResume: (c) => { resumedWith = c; },
    onDiscard: noop,
  });
  // Find the resume button — has "▶ Resume" text
  const all = allNodes(el);
  const resumeBtn = all.find((n) => {
    if (n.type !== "button") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined.includes("Resume");
  });
  assert.ok(resumeBtn);
  resumeBtn.props.onClick();
  assert.equal(resumedWith, ck);
});

check("ResumeDialog: Discard button triggers onDiscard with projectId", () => {
  let discardedId = null;
  const el = panels.ResumeDialog({
    checkpoint: ckFixture({ projectId: "proj-42" }),
    onResume: noop,
    onDiscard: (id) => { discardedId = id; },
  });
  const all = allNodes(el);
  const discardBtn = all.find((n) => {
    if (n.type !== "button") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined.includes("Discard");
  });
  assert.ok(discardBtn);
  discardBtn.props.onClick();
  assert.equal(discardedId, "proj-42");
});

// ═══════════════════════════════════════════════════════════════════════════
// SettingsPanel
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[SettingsPanel]");

function spFixture(overrides = {}) {
  return Object.assign({
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4",
      apiKey: "sk-test",
      useGlobalLLM: true,
      optionalStages: {},
      promptOverrides: {},
      stageSettings: {},
    },
    setConfig: noop,
    onClose: noop,
    importedPackages: null,
    onDeletePackage: noop,
    onRedownloadPackage: noop,
    onClearLibrary: noop,
    checkpointIndex: null,
    onDeleteCheckpoint: noop,
    onClearCheckpoints: noop,
    onBackendVerified: noop,
  }, overrides);
}

check("SettingsPanel: renders 'Settings' heading", () => {
  const el = panels.SettingsPanel(spFixture());
  assert.ok(findByText(el, "Settings"));
});

check("SettingsPanel: renders all 5 tab labels", () => {
  const el = panels.SettingsPanel(spFixture());
  assert.ok(findByText(el, "Workflow"));
  assert.ok(findByText(el, "LLM"));
  assert.ok(findByText(el, "CLI"));
  assert.ok(findByText(el, "Library"));
  assert.ok(findByText(el, "Checkpoints"));
});

check("SettingsPanel: library tab label shows count", () => {
  const el = panels.SettingsPanel(spFixture({
    importedPackages: { p1: {}, p2: {}, p3: {} },
  }));
  assert.ok(findByText(el, "Library (3)"));
});

check("SettingsPanel: checkpoints tab label shows count", () => {
  const el = panels.SettingsPanel(spFixture({
    checkpointIndex: [{}, {}],
  }));
  assert.ok(findByText(el, "Checkpoints (2)"));
});

check("SettingsPanel: default tab is LLM — renders Global LLM toggle", () => {
  const el = panels.SettingsPanel(spFixture());
  assert.ok(findByText(el, "Global LLM"));
});

check("SettingsPanel: renders provider chips in LLM tab", () => {
  const el = panels.SettingsPanel(spFixture());
  // PROVIDERS includes anthropic, openai, etc — at least the Anthropic label should render
  assert.ok(findByText(el, "Anthropic"));
});

check("SettingsPanel: renders API Key label for cloud provider", () => {
  const el = panels.SettingsPanel(spFixture({
    config: { provider: "anthropic", model: "x", apiKey: "", useGlobalLLM: true, optionalStages: {}, promptOverrides: {}, stageSettings: {} },
  }));
  assert.ok(findByText(el, "API Key"));
});

check("SettingsPanel: renders Model label", () => {
  const el = panels.SettingsPanel(spFixture());
  assert.ok(findByText(el, "Model"));
});

check("SettingsPanel: renders Test LLM button", () => {
  const el = panels.SettingsPanel(spFixture());
  assert.ok(findByText(el, "Test LLM"));
});

check("SettingsPanel: renders Per-Stage Settings section", () => {
  const el = panels.SettingsPanel(spFixture());
  assert.ok(findByText(el, "Per-Stage Settings"));
});

check("SettingsPanel: renders Save & Close button", () => {
  const el = panels.SettingsPanel(spFixture());
  assert.ok(findByText(el, "Save & Close"));
});

check("SettingsPanel: onClose triggered by × button", () => {
  let closed = false;
  const el = panels.SettingsPanel(spFixture({ onClose: () => { closed = true; } }));
  // Find the × close button (fontSize: 18)
  const all = allNodes(el);
  const closeBtn = all.find((n) => {
    if (n.type !== "button") return false;
    if (!n.props.style || n.props.style.fontSize !== 18) return false;
    return true;
  });
  assert.ok(closeBtn);
  closeBtn.props.onClick();
  assert.equal(closed, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// DecompReview
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[DecompReview]");

function drFixture(overrides = {}) {
  return Object.assign({
    modules: {
      top: { name: "top", description: "Top level", level: 0, params: [] },
      fifo: { name: "fifo", description: "Data FIFO", level: 1, params: [{ name: "DEPTH", default: 16 }] },
      arbiter: { name: "arbiter", description: "Round-robin arbiter", level: 1, params: [] },
    },
    setModules: noop,
    instances: {
      "u_fifo": { instId: "u_fifo", moduleId: "fifo", parentModuleId: "top", instanceName: "u_fifo", paramOverrides: {} },
      "u_arb": { instId: "u_arb", moduleId: "arbiter", parentModuleId: "top", instanceName: "u_arb", paramOverrides: {} },
    },
    setInstances: noop,
    decomposition: {
      systemName: "packet_buffer",
      topModule: "top",
      interconnects: [
        { from: "u_fifo", to: "u_arb", protocol: "ready/valid", description: "data hand-off" },
      ],
    },
    decompError: null,
    onConfirm: noop,
    onRedecompose: noop,
    onBack: noop,
    onImport: noop,
    libraryMatches: null,
    importedPackages: {},
    onApplyMatches: noop,
  }, overrides);
}

check("DecompReview: renders header 'System Decomposition'", () => {
  const el = panels.DecompReview(drFixture());
  assert.ok(findByText(el, "System Decomposition"));
});

check("DecompReview: shows decomposition system name tag", () => {
  const el = panels.DecompReview(drFixture());
  assert.ok(findByText(el, "packet_buffer"));
});

check("DecompReview: shows module count (3 modules)", () => {
  const el = panels.DecompReview(drFixture());
  assert.ok(findByText(el, "3 modules"));
});

check("DecompReview: shows instance count (2 instances)", () => {
  const el = panels.DecompReview(drFixture());
  assert.ok(findByText(el, "2 instances"));
});

check("DecompReview: renders all action buttons", () => {
  const el = panels.DecompReview(drFixture());
  assert.ok(findByText(el, "Add Module"));
  assert.ok(findByText(el, "Import"));
  assert.ok(findByText(el, "Re-decompose"));
  assert.ok(findByText(el, "Back"));
  assert.ok(findByText(el, "Confirm"));
});

check("DecompReview: hierarchy tree shows each module name", () => {
  const el = panels.DecompReview(drFixture());
  assert.ok(findByText(el, "top"));
  assert.ok(findByText(el, "fifo"));
  assert.ok(findByText(el, "arbiter"));
});

check("DecompReview: 'No modules' message when empty", () => {
  const el = panels.DecompReview(drFixture({ modules: {}, instances: {} }));
  assert.ok(findByText(el, "No modules"));
});

check("DecompReview: shows 'Select a module from the tree' when nothing selected", () => {
  const el = panels.DecompReview(drFixture());
  assert.ok(findByText(el, "Select a module"));
});

check("DecompReview: renders decompError via ErrorBox", () => {
  const el = panels.DecompReview(drFixture({ decompError: "LLM returned malformed JSON" }));
  assert.ok(findByText(el, "LLM returned malformed JSON"));
});

check("DecompReview: renders interconnects panel when present", () => {
  const el = panels.DecompReview(drFixture());
  assert.ok(findByText(el, "Interconnects"));
  assert.ok(findByText(el, "ready/valid"));
  assert.ok(findByText(el, "data hand-off"));
});

check("DecompReview: hides interconnects panel when empty", () => {
  const el = panels.DecompReview(drFixture({
    decomposition: { systemName: "x", topModule: "top", interconnects: [] },
  }));
  assert.equal(findByText(el, "Interconnects"), null);
});

check("DecompReview: renders library matches banner when present", () => {
  const el = panels.DecompReview(drFixture({
    libraryMatches: [
      { decompModId: "fifo", matchType: "exact_id", confidence: 0.95, interfaceCompatible: true, suggestedMode: "blackbox", libraryType: "module", overall: "PASS", score: 92 },
    ],
  }));
  assert.ok(findByText(el, "module match your library"));
  assert.ok(findByText(el, "exact match"));
});

check("DecompReview: library match signature type renders correct label", () => {
  const el = panels.DecompReview(drFixture({
    libraryMatches: [
      { decompModId: "fifo", matchType: "signature_match", confidence: 0.88, interfaceCompatible: true, suggestedMode: "blackbox", libraryType: "module" },
    ],
  }));
  assert.ok(findByText(el, "signature"));
});

check("DecompReview: Apply Selected button in library matches", () => {
  const el = panels.DecompReview(drFixture({
    libraryMatches: [
      { decompModId: "fifo", matchType: "exact_id", confidence: 0.95, interfaceCompatible: true, suggestedMode: "blackbox", libraryType: "module" },
    ],
  }));
  assert.ok(findByText(el, "Apply Selected"));
  assert.ok(findByText(el, "Skip All"));
});

check("DecompReview: no library matches banner when libraryMatches is empty", () => {
  const el = panels.DecompReview(drFixture({ libraryMatches: [] }));
  assert.equal(findByText(el, "Apply Selected"), null);
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
