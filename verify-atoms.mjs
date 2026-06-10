// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// verify-atoms.mjs — Structural tests for src/react/components/atoms.jsx
//
// Companion test to verify.mjs. Runs alongside it. No install required
// beyond what the project already relies on (Node + npx-fetched esbuild for
// the JSX transform).
//
// Strategy:
//   1. Use esbuild (via npx) to compile atoms.jsx → classic createElement
//      calls with a custom factory name `h` that we control
//   2. Write the compiled output to /tmp/ as an ESM module
//   3. Provide a tiny React shim via import-map fallback: a data: URL module
//      that re-exports the hooks we need as no-op stubs
//   4. Import the compiled atoms module and walk the returned element trees
//
// The test philosophy: these are presentational components with no logic
// worth testing in isolation. The value of the test is catching REGRESSIONS
// when later changes touch these files. So we assert:
//
//   - Every atom is an exported function (module surface contract)
//   - Calling each atom with mock props returns a valid element tree
//   - Specific structural invariants per component (root tag, child shape,
//     conditional rendering branches, prop-driven styling)
//
// Exit:
//   0 — all assertions passed
//   1 — any assertion failed
//   2 — infrastructure failure (esbuild not available, compile error)

import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import assert from "node:assert";
import { pathToFileURL } from "node:url";

// ─── Setup ──────────────────────────────────────────────────────────────────

const atomsPath = resolve("src/react/components/atoms.jsx");
try { readFileSync(atomsPath, "utf8"); }
catch (e) {
  console.error("ERROR: " + atomsPath + " not found. Run from rtl-forge-v6/ root.");
  process.exit(2);
}

const workDir  = mkdtempSync(join(tmpdir(), "rtlforge-atoms-test-"));
const compiled = join(workDir, "atoms-compiled.mjs");
const reactShim = join(workDir, "react-shim.mjs");

// React shim: returns hooks as no-op stubs that let the components
// execute through their initial render. useState returns a fixed [value,
// noop] tuple so conditional rendering branches can be steered by the
// initial value. useRef returns a plain { current: null }. useEffect is
// skipped entirely (we only care about the initial render pass).
writeFileSync(reactShim, `
export function useState(initial) {
  const value = typeof initial === "function" ? initial() : initial;
  return [value, function noop() {}];
}
export function useRef(initial) { return { current: initial != null ? initial : null }; }
export function useEffect() { /* no-op for structural tests */ }
export function useMemo(fn) { return fn(); }
export function useCallback(fn) { return fn; }
`);

// Compile atoms.jsx with a custom h() factory. We don't want real React
// because:
//   1. It's not installed
//   2. We want to INSPECT the element tree, not render it
// The h() shim (defined in this test file below) returns a plain JS object
// { type, props, children } we can walk.
console.log("compiling atoms.jsx with esbuild…");
try {
  execSync(
    [
      "npx", "--yes", "esbuild@0.20.2",
      atomsPath,
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

// Rewrite the compiled output's `import { ... } from "react"` to point
// at our local shim — a simple find-and-replace since esbuild's external
// preserves the import verbatim.
let src = readFileSync(compiled, "utf8");
src = src.replace(
  /from\s+["']react["']/g,
  'from "' + pathToFileURL(reactShim).href + '"',
);
// Inject the h factory at the top so JSX elements are recorded as plain
// objects instead of calling React.createElement.
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

console.log("importing compiled atoms…");
const atoms = await import(pathToFileURL(compiled).href);

// ─── Assertions ─────────────────────────────────────────────────────────────

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

// Walk helpers for the { type, props, children } tree
function allNodes(node, out = []) {
  if (!node || typeof node !== "object" || !("type" in node)) return out;
  out.push(node);
  (node.children || []).forEach((c) => allNodes(c, out));
  return out;
}
function findByText(node, text) {
  const all = allNodes(node);
  for (const n of all) {
    for (const c of n.children || []) {
      if (c == null) continue;
      const s = typeof c === "string" ? c : (typeof c === "number" ? String(c) : null);
      if (s != null && s.includes(String(text))) return n;
    }
  }
  return null;
}
function countNodes(node, pred) {
  return allNodes(node).filter(pred).length;
}

// ─── Module surface ─────────────────────────────────────────────────────────
console.log("\n[module surface]");
const expectedExports = [
  "Spinner", "SubTab", "Chip", "Btn", "Tag", "MetricCard",
  "CodeBlock", "EditableCodeView", "DataTable", "ErrorBox", "Label",
  "RunHistoryPanel",
];
expectedExports.forEach((name) => {
  check(name + " is exported as a function", () => {
    assert.equal(typeof atoms[name], "function", "got " + typeof atoms[name]);
  });
});

// ─── Spinner ────────────────────────────────────────────────────────────────
console.log("\n[Spinner]");
check("Spinner: default caption is 'Processing…'", () => {
  const el = atoms.Spinner({});
  assert.ok(findByText(el, "Processing"), "no 'Processing' text found");
});
check("Spinner: custom caption overrides default", () => {
  const el = atoms.Spinner({ text: "Loading foo" });
  assert.ok(findByText(el, "Loading foo"));
});
check("Spinner: root is a div with centered flex", () => {
  const el = atoms.Spinner({});
  assert.equal(el.type, "div");
  assert.equal(el.props.style.display, "flex");
  assert.equal(el.props.style.justifyContent, "center");
});

// ─── SubTab ─────────────────────────────────────────────────────────────────
console.log("\n[SubTab]");
check("SubTab: renders one button per tab", () => {
  const el = atoms.SubTab({
    tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    active: "b",
    onChange: () => {},
  });
  const buttons = countNodes(el, (n) => n.type === "button");
  assert.equal(buttons, 3);
});
check("SubTab: active tab gets accent color", () => {
  const el = atoms.SubTab({
    tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    active: "b",
    onChange: () => {},
  });
  const buttons = allNodes(el).filter((n) => n.type === "button");
  const activeButton = buttons.find((b) => b.props.key === "b");
  const inactiveButton = buttons.find((b) => b.props.key === "a");
  assert.notEqual(activeButton.props.style.color, inactiveButton.props.style.color);
});
check("SubTab: renders count badge when provided", () => {
  const el = atoms.SubTab({
    tabs: [{ id: "a", label: "A", count: 7 }],
    active: "a",
    onChange: () => {},
  });
  assert.ok(findByText(el, "7"));
});
check("SubTab: no count badge when count is null", () => {
  const el = atoms.SubTab({
    tabs: [{ id: "a", label: "A" }],
    active: "a",
    onChange: () => {},
  });
  // The span containing "(" should not exist if no count
  const spans = allNodes(el).filter((n) => n.type === "span");
  assert.equal(spans.length, 0);
});
check("SubTab: onChange receives tab id when clicked", () => {
  let clickedId = null;
  const el = atoms.SubTab({
    tabs: [{ id: "foo", label: "Foo" }],
    active: "foo",
    onChange: (id) => { clickedId = id; },
  });
  const button = allNodes(el).find((n) => n.type === "button");
  button.props.onClick();
  assert.equal(clickedId, "foo");
});

// ─── Chip ───────────────────────────────────────────────────────────────────
console.log("\n[Chip]");
check("Chip: renders label text", () => {
  const el = atoms.Chip({ label: "My Chip", active: false, onClick: () => {} });
  assert.ok(findByText(el, "My Chip"));
});
check("Chip: active styling differs from inactive", () => {
  const active = atoms.Chip({ label: "X", active: true, onClick: () => {} });
  const inactive = atoms.Chip({ label: "X", active: false, onClick: () => {} });
  assert.notEqual(active.props.style.background, inactive.props.style.background);
});
check("Chip: disabled=true sets opacity and unbinds onClick", () => {
  let clicked = false;
  const el = atoms.Chip({ label: "X", disabled: true, onClick: () => { clicked = true; } });
  assert.equal(el.props.style.opacity, 0.5);
  assert.equal(el.props.onClick, undefined);
});

// ─── Btn ────────────────────────────────────────────────────────────────────
console.log("\n[Btn]");
check("Btn: primary is the default variant", () => {
  const el = atoms.Btn({ children: "OK" });
  // Primary has accent background
  assert.ok(typeof el.props.style.background === "string");
  assert.equal(el.props.style.background.startsWith("#"), true);
});
check("Btn: secondary variant is transparent", () => {
  const el = atoms.Btn({ children: "OK", variant: "secondary" });
  assert.equal(el.props.style.background, "transparent");
});
check("Btn: danger variant uses red", () => {
  const el = atoms.Btn({ children: "Delete", variant: "danger" });
  const style = el.props.style;
  assert.equal(style.borderColor, style.color); // red for both
});
check("Btn: disabled=true sets cursor and unbinds onClick", () => {
  let clicked = false;
  const el = atoms.Btn({ children: "X", disabled: true, onClick: () => { clicked = true; } });
  assert.equal(el.props.style.cursor, "not-allowed");
  assert.equal(el.props.onClick, undefined);
});
check("Btn: style prop overrides variant defaults", () => {
  const el = atoms.Btn({ children: "X", style: { borderRadius: 99 } });
  assert.equal(el.props.style.borderRadius, 99);
});

// ─── Tag ────────────────────────────────────────────────────────────────────
console.log("\n[Tag]");
check("Tag: renders children", () => {
  const el = atoms.Tag({ children: "HELLO" });
  assert.ok(findByText(el, "HELLO"));
});
check("Tag: custom color and bg are applied", () => {
  const el = atoms.Tag({ children: "X", color: "#f00", bg: "#0f0" });
  assert.equal(el.props.style.color, "#f00");
  assert.equal(el.props.style.background, "#0f0");
});

// ─── MetricCard ─────────────────────────────────────────────────────────────
console.log("\n[MetricCard]");
check("MetricCard: renders label and value", () => {
  const el = atoms.MetricCard({ label: "TOKENS", value: "1.2K" });
  assert.ok(findByText(el, "TOKENS"));
  assert.ok(findByText(el, "1.2K"));
});
check("MetricCard: custom color is applied to value", () => {
  const el = atoms.MetricCard({ label: "X", value: "42", color: "#abcdef" });
  // Find the big value div — it has fontSize 18
  const valueDiv = allNodes(el).find((n) => n.type === "div" && n.props.style && n.props.style.fontSize === 18);
  assert.equal(valueDiv.props.style.color, "#abcdef");
});

// ─── CodeBlock ──────────────────────────────────────────────────────────────
console.log("\n[CodeBlock]");
check("CodeBlock: without lineNumbers renders a single div", () => {
  const el = atoms.CodeBlock({ code: "let x = 1;" });
  assert.equal(el.type, "div");
  // No gutter, just the code as a child
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0], "let x = 1;");
});
check("CodeBlock: with lineNumbers renders a gutter + code area", () => {
  const el = atoms.CodeBlock({ code: "a\nb\nc", lineNumbers: true });
  // Outer flex div with exactly 2 children (gutter + code area)
  assert.equal(el.type, "div");
  assert.equal(el.props.style.display, "flex");
  assert.equal(el.children.length, 2);
});
check("CodeBlock: gutter has one entry per line", () => {
  const el = atoms.CodeBlock({ code: "1\n2\n3\n4", lineNumbers: true });
  const gutter = el.children[0];
  // gutter.children is the array of line-number divs
  assert.equal(gutter.children.length, 4);
});
check("CodeBlock: maxH is applied", () => {
  const el = atoms.CodeBlock({ code: "x", maxH: 999 });
  assert.equal(el.props.style.maxHeight, 999);
});

// ─── DataTable ──────────────────────────────────────────────────────────────
console.log("\n[DataTable]");
check("DataTable: renders a header row for each column", () => {
  const el = atoms.DataTable({
    columns: ["Name", "Value", "Status"],
    rows: [],
    gridCols: "1fr 1fr 1fr",
  });
  const headerDiv = el.children[0];
  // Header div's children are the column span elements
  const headerSpans = headerDiv.children.filter((c) => c && c.type === "span");
  assert.equal(headerSpans.length, 3);
});
check("DataTable: renders one div per data row", () => {
  const el = atoms.DataTable({
    columns: ["A"],
    rows: [["row1"], ["row2"], ["row3"]],
    gridCols: "1fr",
  });
  // children[0] is header, children[1..] are data rows
  const dataRows = el.children.slice(1);
  assert.equal(dataRows.length, 3);
});
check("DataTable: empty rows renders only the header", () => {
  const el = atoms.DataTable({ columns: ["A"], rows: [], gridCols: "1fr" });
  assert.equal(el.children.length, 1); // just the header
});

// ─── ErrorBox ───────────────────────────────────────────────────────────────
console.log("\n[ErrorBox]");
check("ErrorBox: renders 'Error:' prefix + msg", () => {
  const el = atoms.ErrorBox({ msg: "Something broke" });
  assert.ok(findByText(el, "Something broke"));
  // "Error: " is a strong element with that text
  const strong = allNodes(el).find((n) => n.type === "strong");
  assert.ok(strong);
});
check("ErrorBox: uses red styling", () => {
  const el = atoms.ErrorBox({ msg: "x" });
  // Background should be the redDim token (starts with "rgba(248")
  assert.ok(
    typeof el.props.style.background === "string"
    && el.props.style.background.includes("248"),
  );
});

// ─── Label ──────────────────────────────────────────────────────────────────
console.log("\n[Label]");
check("Label: renders children as a <label> element", () => {
  const el = atoms.Label({ children: "Field Name" });
  assert.equal(el.type, "label");
  assert.ok(findByText(el, "Field Name"));
});
check("Label: has uppercase text transform", () => {
  const el = atoms.Label({ children: "x" });
  assert.equal(el.props.style.textTransform, "uppercase");
});

// ─── EditableCodeView ───────────────────────────────────────────────────────
console.log("\n[EditableCodeView]");
check("EditableCodeView: renders non-editing mode by default", () => {
  const el = atoms.EditableCodeView({
    code: "let x = 1;",
    onChange: () => {},
    label: "rtl",
  });
  // Should be a div wrapping annotations + toolbar + code area
  assert.equal(el.type, "div");
});
check("EditableCodeView: manualImport banner renders when flag is set", () => {
  const el = atoms.EditableCodeView({
    code: "x",
    onChange: () => {},
    label: "rtl",
    manualImport: true,
    importedAt: "2025-01-01T00:00:00Z",
  });
  assert.ok(findByText(el, "Manually imported"));
});
check("EditableCodeView: fixSource banner renders when provided", () => {
  const el = atoms.EditableCodeView({
    code: "x",
    onChange: () => {},
    label: "rtl",
    fixSource: "lint fix iter 2",
  });
  assert.ok(findByText(el, "Code modified"));
  assert.ok(findByText(el, "lint fix iter 2"));
});
check("EditableCodeView: no banners by default", () => {
  const el = atoms.EditableCodeView({
    code: "x",
    onChange: () => {},
    label: "rtl",
  });
  assert.equal(findByText(el, "Manually imported"), null);
  assert.equal(findByText(el, "Code modified"), null);
});

// ─── RunHistoryPanel ────────────────────────────────────────────────────────
console.log("\n[RunHistoryPanel]");
check("RunHistoryPanel: empty runs shows 'No run data' message", () => {
  const el = atoms.RunHistoryPanel({ runs: [], activeRunId: null, setActiveRunId: () => {} });
  assert.ok(findByText(el, "No run data"));
});
check("RunHistoryPanel: null runs also shows 'No run data'", () => {
  const el = atoms.RunHistoryPanel({ runs: null, activeRunId: null, setActiveRunId: () => {} });
  assert.ok(findByText(el, "No run data"));
});
check("RunHistoryPanel: single run hides the run selector tabs", () => {
  const runs = [{ runId: 1, status: "complete", ts: Date.now(), text: "hello", metrics: {}, trigger: "manual" }];
  const el = atoms.RunHistoryPanel({ runs, activeRunId: 1, setActiveRunId: () => {} });
  // No Run N tab buttons since there's only one run
  assert.equal(findByText(el, "Run 1"), null);
});
check("RunHistoryPanel: multiple runs show one tab per run", () => {
  const runs = [
    { runId: 1, status: "complete", ts: 1000, text: "a", metrics: {}, trigger: "manual" },
    { runId: 2, status: "complete", ts: 2000, text: "b", metrics: {}, trigger: "auto" },
    { runId: 3, status: "running",  ts: 3000, text: "c", metrics: {}, trigger: "manual" },
  ];
  const el = atoms.RunHistoryPanel({ runs, activeRunId: 3, setActiveRunId: () => {} });
  assert.ok(findByText(el, "Run 1"));
  assert.ok(findByText(el, "Run 2"));
  assert.ok(findByText(el, "Run 3"));
});
check("RunHistoryPanel: running status with text is 'Streaming…'", () => {
  const runs = [{ runId: 1, status: "running", ts: 1000, text: "partial output", metrics: {}, trigger: "manual" }];
  const el = atoms.RunHistoryPanel({ runs, activeRunId: 1, setActiveRunId: () => {} });
  assert.ok(findByText(el, "Streaming"));
});
check("RunHistoryPanel: complete status shows 'Complete'", () => {
  const runs = [{ runId: 1, status: "complete", ts: 1000, text: "done", metrics: {}, trigger: "manual" }];
  const el = atoms.RunHistoryPanel({ runs, activeRunId: 1, setActiveRunId: () => {} });
  assert.ok(findByText(el, "Complete"));
});
check("RunHistoryPanel: displays metrics.ttft when > 0", () => {
  const runs = [{
    runId: 1, status: "complete", ts: 1000, text: "x",
    metrics: { ttft: 423, tokPerSec: 50, tokensOut: 1000 },
    trigger: "manual",
  }];
  const el = atoms.RunHistoryPanel({ runs, activeRunId: 1, setActiveRunId: () => {} });
  assert.ok(findByText(el, "423"));
  assert.ok(findByText(el, "50"));
  assert.ok(findByText(el, "1000"));
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
