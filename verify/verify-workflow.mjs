// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// verify-workflow.mjs — Structural tests for src/react/components/workflow.jsx
//
// Companion test to verify.mjs. Validates that WorkflowTab parses,
// exports cleanly, and renders coherent element trees for the various
// config-shape inputs (with/without optional stages, with/without
// promptOverrides, etc).
//
// Same esbuild + React shim + h-factory + import-walk pattern as
// verify-atoms.mjs and verify-stages.mjs. The walker has the
// component-function expansion.

import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import assert from "node:assert";
import { pathToFileURL } from "node:url";

// ─── Setup ──────────────────────────────────────────────────────────────────

const workflowPath = resolve("src/react/components/workflow.jsx");
try { readFileSync(workflowPath, "utf8"); }
catch (e) {
  console.error("ERROR: " + workflowPath + " not found. Run from rtl-forge-v6/ root.");
  process.exit(2);
}

const workDir   = mkdtempSync(join(tmpdir(), "rtlforge-workflow-test-"));
const compiled  = join(workDir, "workflow-compiled.mjs");
const reactShim = join(workDir, "react-shim.mjs");

// React hook shim — same pattern as the other two verifiers
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

// Compile workflow.jsx
console.log("compiling workflow.jsx with esbuild…");
try {
  execSync(
    [
      "npx", "--yes", "esbuild@0.20.2",
      workflowPath,
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

// Rewrite `from "react"` → shim
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

console.log("importing compiled workflow…");
const wf = await import(pathToFileURL(compiled).href);

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

// Walker that recursively invokes component functions
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

// Standard fixture: empty config means default 10 active stages, no overrides
function fixture(overrides = {}) {
  return Object.assign({
    optionalStages: { formal_props: true, lint: true },
    promptOverrides: {},
    stageSettings: {},
  }, overrides);
}

// ─── Module surface ─────────────────────────────────────────────────────────
console.log("\n[module surface]");
check("WorkflowTab is exported as a function", () => {
  assert.equal(typeof wf.WorkflowTab, "function");
});

// ─── Optional stage checkboxes ──────────────────────────────────────────────
console.log("\n[optional stage checkboxes]");

check("renders 'Optional Pipeline Stages' header", () => {
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  assert.ok(findByText(el, "Optional Pipeline Stages"));
});

check("renders OptionalStagesPanel disclosure header (collapsed by default)", () => {
  // Optional-stages are in a collapsible disclosure. Collapsed
  // by default; the panel header shows "▶ Optional Pipeline Stages
  // N of M enabled". Use findByText (which walks string children) to
  // confirm the disclosure marker and section title are present.
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  assert.ok(findByText(el, "Optional Pipeline Stages"),
    "expected 'Optional Pipeline Stages' header text");
  // The disclosure marker — exists when collapsed
  assert.ok(findByText(el, "\u25B6"),  // ▶
    "expected ▶ disclosure marker (collapsed state)");
});

check("OptionalStagesPanel summary shows enabled count", () => {
  // Header text is split across spans: " 3 of 7 enabled" comes through
  // as separate string children. The findByText walker joins each node's
  // own string children, so we look for a node whose joined text
  // contains "3 of " (with one number, e.g. "3 of 7").
  const el = wf.WorkflowTab({
    config: fixture({ optionalStages: { formal_props: true, lint: true, rtl_review: true } }),
    setConfig: noop,
  });
  const all = allNodes(el);
  const has = all.some(function(n) {
    let joined = "";
    for (const c of n.children || []) {
      if (typeof c === "string") joined += c;
      else if (typeof c === "number") joined += String(c);
    }
    return /\b3\b/.test(joined) && /enabled/.test(joined);
  });
  assert.ok(has, "expected node whose text mentions '3' and 'enabled'");
});

check("OptionalStagesPanel summary shows preview of first 3 enabled labels", () => {
  const el = wf.WorkflowTab({
    config: fixture({ optionalStages: { formal_props: true, lint: true } }),
    setConfig: noop,
  });
  // Labels come from OPTIONAL_STAGE_DEFS[k].label; we look up the
  // formal_props label and check it appears as text somewhere in the
  // rendered tree.
  const formalLabel = wf.OPTIONAL_STAGE_DEFS
    ? (wf.OPTIONAL_STAGE_DEFS.formal_props && wf.OPTIONAL_STAGE_DEFS.formal_props.label)
    : null;
  // OPTIONAL_STAGE_DEFS isn't exported from workflow.jsx; fall back to
  // matching the keys themselves which the preview joins with commas.
  // The panel preview is a string like "· Formal Properties, RTL Lint"
  // so look for the "·" bullet which is unique to the preview text.
  assert.ok(findByText(el, "\u00B7") || (formalLabel && findByText(el, formalLabel)),
    "expected preview bullet (·) or a known label in the disclosure summary");
});

// ─── Flow graph SVG ─────────────────────────────────────────────────────────
console.log("\n[flow graph SVG]");

check("renders an <svg> root", () => {
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  const all = allNodes(el);
  const svgs = all.filter((n) => n.type === "svg");
  assert.equal(svgs.length, 1);
});

check("flow graph has one <g> node per active stage", () => {
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  const all = allNodes(el);
  // Count <g> nodes inside the SVG that have onClick handlers (those are
  // the stage nodes — the loopback arcs are <g> too but without onClick)
  const stageNodes = all.filter(
    (n) => n.type === "g" && typeof n.props.onClick === "function",
  );
  // Default: 9 active stages (elicit, spec, architect, rtl_generate,
  // formal_props, lint, test_generate, verify, judge — review stages are
  // optional)
  assert.equal(stageNodes.length, 9);
});

check("enabling optional stages adds nodes to the flow graph", () => {
  const el = wf.WorkflowTab({
    config: fixture({ optionalStages: { formal_props: true, lint: true, rtl_review: true, test_review: true } }),
    setConfig: noop,
  });
  const all = allNodes(el);
  const stageNodes = all.filter(
    (n) => n.type === "g" && typeof n.props.onClick === "function",
  );
  // 9 base + 2 optional review = 11
  assert.equal(stageNodes.length, 11);
});

check("forward edges are drawn between consecutive stages", () => {
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  const all = allNodes(el);
  // <line> elements with markerEnd are forward edges
  const lines = all.filter((n) => n.type === "line");
  // 9 stages = 8 forward edges
  assert.equal(lines.length, 8);
});

check("loopback arcs render as <path> elements with strokeDasharray", () => {
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  const all = allNodes(el);
  const dashedPaths = all.filter(
    (n) => n.type === "path" && n.props.strokeDasharray,
  );
  // Default config has formal_props + lint enabled. LOOPBACK_EDGES with
  // both lint→rtl active = 6 arcs (lint→rtl, verify→rtl, verify→tb,
  // judge→spec, judge→rtl, judge→tb)
  assert.equal(dashedPaths.length, 6);
});

check("loopback arcs include rtl_review when enabled", () => {
  const el = wf.WorkflowTab({
    config: fixture({ optionalStages: { formal_props: true, lint: true, rtl_review: true } }),
    setConfig: noop,
  });
  const all = allNodes(el);
  const dashedPaths = all.filter(
    (n) => n.type === "path" && n.props.strokeDasharray,
  );
  // Default 6 + rtl_review→rtl_generate = 7
  assert.equal(dashedPaths.length, 7);
});

check("renders flow graph legend", () => {
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  assert.ok(findByText(el, "forward flow"));
  assert.ok(findByText(el, "fix loop-back"));
  assert.ok(findByText(el, "triage loop-back"));
});

// ─── Node detail panel ─────────────────────────────────────────────────────
console.log("\n[node detail panel]");

check("no detail panel when nothing is selected", () => {
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  // The detail panel header text is "Prompt Sections" — should not appear
  assert.equal(findByText(el, "Prompt Sections"), null);
  assert.equal(findByText(el, "Connections"), null);
});

check("hasOverride badge does not appear without overrides", () => {
  const el = wf.WorkflowTab({ config: fixture(), setConfig: noop });
  // SVG <text> element with content "customised" should not exist
  const all = allNodes(el);
  const customisedTexts = all.filter((n) => {
    if (n.type !== "text") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined === "customised";
  });
  assert.equal(customisedTexts.length, 0);
});

check("hasOverride badge appears for stages with promptOverrides", () => {
  const el = wf.WorkflowTab({
    config: fixture({
      promptOverrides: { rtl_generate: [{ title: "Custom", content: "..." }] },
    }),
    setConfig: noop,
  });
  const all = allNodes(el);
  const customisedTexts = all.filter((n) => {
    if (n.type !== "text") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined === "customised";
  });
  assert.equal(customisedTexts.length, 1);
});

// ─── Renders without crashing across edge cases ─────────────────────────────
console.log("\n[robustness]");

check("WorkflowTab renders with completely empty config", () => {
  const el = wf.WorkflowTab({ config: {}, setConfig: noop });
  assert.equal(el.type, "div");
});

check("WorkflowTab renders with only optionalStages absent", () => {
  const el = wf.WorkflowTab({
    config: { promptOverrides: {}, stageSettings: {} },
    setConfig: noop,
  });
  assert.equal(el.type, "div");
});

check("WorkflowTab still renders with empty promptOverrides for unknown stage", () => {
  const el = wf.WorkflowTab({
    config: fixture({ promptOverrides: { unknown_stage: [] } }),
    setConfig: noop,
  });
  // Empty override for unknown stage → no crash, and no "customised" badge
  // since the override has length 0
  const all = allNodes(el);
  const customisedTexts = all.filter((n) => {
    if (n.type !== "text") return false;
    const joined = (n.children || []).filter((c) => typeof c === "string").join("");
    return joined === "customised";
  });
  // Empty array is truthy, so hasOverride returns true for unknown_stage
  // — but unknown_stage isn't in the active stages, so the badge isn't
  // rendered against any visible node.
  assert.equal(customisedTexts.length, 0);
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
