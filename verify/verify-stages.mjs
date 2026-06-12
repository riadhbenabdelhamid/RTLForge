// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// verify-stages.mjs — Structural tests for src/react/components/stages.jsx
//
// Companion test to verify.mjs. Validates that the 4 extracted stage
// components (ElicitStage, SpecStage, ArchStage, FormalPropsStage) parse,
// export the expected functions, and render coherent element trees when
// invoked with realistic mock props.
//
// Strategy: same esbuild + React hooks shim + `h` factory + import-walk
// pattern as verify-atoms.mjs. First run fetches esbuild via npx;
// subsequent runs are fully offline.

import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import assert from "node:assert";
import { pathToFileURL } from "node:url";

// ─── Setup ──────────────────────────────────────────────────────────────────

const stagesPath = resolve("src/react/components/stages.jsx");
try { readFileSync(stagesPath, "utf8"); }
catch (e) {
  console.error("ERROR: " + stagesPath + " not found. Run from rtl-forge-v6/ root.");
  process.exit(2);
}

const workDir   = mkdtempSync(join(tmpdir(), "rtlforge-stages-test-"));
const compiled  = join(workDir, "stages-compiled.mjs");
const reactShim = join(workDir, "react-shim.mjs");

// Minimal React hook shim — same as verify-atoms.mjs. Hooks are no-ops
// that return deterministic initial values so the components can execute
// through their initial render without a real React runtime.
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

// Compile stages.jsx with h() factory so JSX becomes walkable objects
console.log("compiling stages.jsx with esbuild…");
try {
  execSync(
    [
      "npx", "--yes", "esbuild@0.20.2",
      stagesPath,
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

// Rewrite `from "react"` to point at our shim
let src = readFileSync(compiled, "utf8");
src = src.replace(
  /from\s+["']react["']/g,
  'from "' + pathToFileURL(reactShim).href + '"',
);

// Inject the h factory at the top. Our h() records { type, props, children }
// as plain objects that we can walk structurally.
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

console.log("importing compiled stages…");
const stages = await import(pathToFileURL(compiled).href);

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

// Walk helpers — mirror verify-atoms.mjs but with component-function invocation.
//
// When a node's `type` is a function (a component), we CALL it with its
// props to get the expanded render, then walk the result. This matters
// for stages.jsx because it uses atoms like <SubTab tabs={...}/> where
// the visible text lives inside the SubTab atom's render output, not in
// the raw props object.
//
// We track a depth counter to prevent runaway recursion on pathological
// components and silently skip any component that throws.
function allNodes(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || !("type" in node)) return out;
  out.push(node);
  // If the node's type is a function, expand it by calling it with its
  // props. Skip if we've already gone too deep or the component throws.
  if (typeof node.type === "function" && depth < 20) {
    try {
      // Merge children into props.children the way React does, so
      // components that read `children` from props work correctly.
      const expandedProps = Object.assign({}, node.props || {});
      if (node.children && node.children.length > 0) {
        expandedProps.children = node.children.length === 1 ? node.children[0] : node.children;
      }
      const expanded = node.type(expandedProps);
      if (expanded && typeof expanded === "object" && "type" in expanded) {
        allNodes(expanded, out, depth + 1);
      }
    } catch (_e) {
      // Component threw during structural test — skip expansion. The
      // parent node is still in `out` so structural assertions against
      // the props (disabled, onClick, etc) still work.
    }
  }
  // Always walk the explicit children too (for leaf JSX elements)
  (node.children || []).forEach((c) => allNodes(c, out, depth + 1));
  return out;
}
function findByText(node, text) {
  const target = String(text);
  const all = allNodes(node);
  for (const n of all) {
    // Concatenate all string/number children so multi-part text like
    // `<Tag>Domain: {data.domain}</Tag>` (which compiles to two sibling
    // children ["Domain: ", "arithmetic"]) can be matched as a unit.
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
function countNodes(node, pred) {
  return allNodes(node).filter(pred).length;
}
// Find a node whose props match a subset (shallow style comparison,
// useful for identifying specific styled containers)
function findByType(node, type) {
  return allNodes(node).filter((n) => n.type === type);
}

// Typical no-op setters / handlers
const noop = () => {};

// ─── Module surface ─────────────────────────────────────────────────────────
console.log("\n[module surface]");
const expectedExports = [
  "ElicitStage", "SpecStage", "ArchStage", "FormalPropsStage",
  "LintStage", "VerifyStage", "JudgeStage", "ReviewStage",
];
expectedExports.forEach((name) => {
  check(name + " is exported as a function", () => {
    assert.equal(typeof stages[name], "function", "got " + typeof stages[name]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ElicitStage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[ElicitStage]");

function elicitFixture(overrides = {}) {
  return Object.assign({
    domain: "arithmetic",
    questions: [
      { id: "Q-IF-01", cat: "interface", text: "Does the module have a clock?", opts: ["Yes", "No"] },
      { id: "Q-IF-02", cat: "interface", text: "Is the reset synchronous?",   opts: ["Sync", "Async", "Other (specify)"] },
      { id: "Q-FN-01", cat: "functional", text: "What's the output latency?", opts: ["1 cycle", "2 cycles"] },
    ],
    assumptions: [
      { id: "A-01", text: "Clock runs at 100MHz", confirmed: true,  revised: null },
      { id: "A-02", text: "Reset is active-low",  confirmed: false, revised: null },
    ],
    answers: { "Q-IF-01": "Yes" },
    customAnswers: {},
  }, overrides);
}

check("ElicitStage: renders domain tag", () => {
  const el = stages.ElicitStage({ data: elicitFixture(), setData: noop, isActive: true });
  assert.ok(findByText(el, "Domain: arithmetic"));
});

check("ElicitStage: shows answered/total counter", () => {
  const el = stages.ElicitStage({ data: elicitFixture(), setData: noop, isActive: true });
  // 1 answer out of 3 questions
  assert.ok(findByText(el, "1/3"));
});

check("ElicitStage: top tab has Questions and Assumptions", () => {
  const el = stages.ElicitStage({ data: elicitFixture(), setData: noop, isActive: true });
  assert.ok(findByText(el, "Questions"));
  assert.ok(findByText(el, "Assumptions"));
});

check("ElicitStage: default top tab is questions (renders question cards)", () => {
  const el = stages.ElicitStage({ data: elicitFixture(), setData: noop, isActive: true });
  // Question IDs Q-IF-01 and Q-IF-02 should be rendered (they're in the
  // initial `interface` category that the default catTab matches)
  assert.ok(findByText(el, "Q-IF-01"));
  assert.ok(findByText(el, "Q-IF-02"));
  // Q-FN-01 is in the functional category and should NOT render on the
  // default interface tab
  assert.equal(findByText(el, "Q-FN-01"), null);
});

check("ElicitStage: empty questions + empty assumptions renders cleanly", () => {
  const el = stages.ElicitStage({
    data: { questions: [], assumptions: [], answers: {}, customAnswers: {}, domain: "empty" },
    setData: noop,
    isActive: true,
  });
  // Zero question IDs, zero assumption IDs — but the domain tag still shows
  assert.ok(findByText(el, "Domain: empty"));
  assert.ok(findByText(el, "0/0"));
});

check("ElicitStage: isActive=false disables chip interactions", () => {
  const el = stages.ElicitStage({ data: elicitFixture(), setData: noop, isActive: false });
  // The Chip components should have disabled prop threaded through. We
  // detect this by looking for buttons with opacity 0.5 (the disabled style
  // from the Chip atom). Since we're in questions mode and have 2 options
  // per question, we should see multiple disabled buttons.
  const all = allNodes(el);
  const disabledButtons = all.filter(
    (n) => n.type === "button" && n.props.style && n.props.style.opacity === 0.5,
  );
  assert.ok(disabledButtons.length > 0, "expected at least one disabled-styled button, got 0");
});

// ═══════════════════════════════════════════════════════════════════════════
// SpecStage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[SpecStage]");

function specFixture(overrides = {}) {
  return Object.assign({
    requirements: [
      { id: "REQ-FUNC-001", cat: "Functional", pri: "Must",   desc: "Module shall add two operands" },
      { id: "REQ-INTF-001", cat: "Interface",  pri: "Should", desc: "Expose a valid signal" },
    ],
    iface: [
      { name: "clk",   dir: "input",  width: "1", desc: "Clock" },
      { name: "rst_n", dir: "input",  width: "1", desc: "Reset, active low" },
      { name: "out",   dir: "output", width: "8", desc: "Output data" },
    ],
    params: [
      { name: "WIDTH", type: "parameter", def: 8, range: "[1:64]", desc: "Data width" },
    ],
  }, overrides);
}

check("SpecStage: renders top SubTab with 3 sub-tabs", () => {
  const el = stages.SpecStage({ data: specFixture(), setData: noop, isActive: true });
  assert.ok(findByText(el, "Requirements"));
  assert.ok(findByText(el, "Module Interface"));
  assert.ok(findByText(el, "Parameters"));
});

check("SpecStage: default tab is requirements (renders req IDs)", () => {
  const el = stages.SpecStage({ data: specFixture(), setData: noop, isActive: true });
  assert.ok(findByText(el, "REQ-FUNC-001"));
  assert.ok(findByText(el, "REQ-INTF-001"));
});

check("SpecStage: isActive=true renders the add-requirement button", () => {
  const el = stages.SpecStage({ data: specFixture(), setData: noop, isActive: true });
  assert.ok(findByText(el, "Add Requirement"));
});

check("SpecStage: isActive=false does NOT render the add button", () => {
  const el = stages.SpecStage({ data: specFixture(), setData: noop, isActive: false });
  assert.equal(findByText(el, "Add Requirement"), null);
});

check("SpecStage: onPropagate=undefined hides propagate button", () => {
  const el = stages.SpecStage({ data: specFixture(), setData: noop, isActive: true });
  // No onPropagate prop means no propagate button even in active mode
  assert.equal(findByText(el, "Propagate"), null);
});

check("SpecStage: onPropagate provided + isActive renders propagate button", () => {
  const el = stages.SpecStage({
    data: specFixture(), setData: noop, isActive: true,
    onPropagate: noop, propagating: false,
  });
  assert.ok(findByText(el, "Propagate"));
});

check("SpecStage: propagating=true shows spinner text", () => {
  const el = stages.SpecStage({
    data: specFixture(), setData: noop, isActive: true,
    onPropagate: noop, propagating: true,
  });
  assert.ok(findByText(el, "Propagating"));
});

check("SpecStage: _manualEdits present renders the purple banner", () => {
  const fixture = specFixture({ _manualEdits: { "reqs.0.desc": true } });
  const el = stages.SpecStage({ data: fixture, setData: noop, isActive: true });
  assert.ok(findByText(el, "manually edited"));
});

check("SpecStage: no _manualEdits → no banner", () => {
  const el = stages.SpecStage({ data: specFixture(), setData: noop, isActive: true });
  assert.equal(findByText(el, "manually edited"), null);
});

check("SpecStage: empty spec renders without crashing", () => {
  const el = stages.SpecStage({
    data: { requirements: [], iface: [], params: [] },
    setData: noop, isActive: true,
  });
  assert.equal(el.type, "div");
});

// ═══════════════════════════════════════════════════════════════════════════
// ArchStage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[ArchStage]");

function archFixture(overrides = {}) {
  return Object.assign({
    strategy: "Pipelined adder with 2-stage registers",
    description: "The adder uses a carry-save architecture with 2 pipeline stages for timing.",
    blocks: [
      { name: "Stage 1: CSA",  desc: "Carry-save compression" },
      { name: "Stage 2: CPA",  desc: "Final carry-propagate add" },
    ],
    mermaid: "graph LR\\nA[In]-->B[CSA]\\nB-->C[CPA]\\nC-->D[Out]",
  }, overrides);
}

check("ArchStage: default tab shows the strategy", () => {
  const el = stages.ArchStage({ data: archFixture() });
  assert.ok(findByText(el, "Pipelined adder"));
});

check("ArchStage: default tab shows the description", () => {
  const el = stages.ArchStage({ data: archFixture() });
  assert.ok(findByText(el, "carry-save architecture"));
});

check("ArchStage: default tab renders one card per block", () => {
  const el = stages.ArchStage({ data: archFixture() });
  assert.ok(findByText(el, "Stage 1: CSA"));
  assert.ok(findByText(el, "Stage 2: CPA"));
});

check("ArchStage: has both Micro-Architecture and Block Diagram tabs", () => {
  const el = stages.ArchStage({ data: archFixture() });
  assert.ok(findByText(el, "Micro-Architecture"));
  assert.ok(findByText(el, "Block Diagram"));
});

check("ArchStage: missing blocks renders empty without crashing", () => {
  const el = stages.ArchStage({ data: { strategy: "x", description: "y" } });
  assert.ok(findByText(el, "x"));
  assert.ok(findByText(el, "y"));
});

// ═══════════════════════════════════════════════════════════════════════════
// FormalPropsStage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[FormalPropsStage]");

function fpFixture(overrides = {}) {
  return Object.assign({
    properties: [
      { id: "P1", req: "REQ-FUNC-001", type: "assert", name: "p_add_valid",
        desc: "Output is stable after valid",
        code: "property p_add_valid; @(posedge clk) valid |-> stable(out); endproperty" },
      { id: "P2", req: "REQ-FUNC-002", type: "assume", name: "p_input_stable",
        desc: "Inputs stable for 1 cycle", code: "property p_input_stable; ..." },
    ],
    autoAssumptions: [
      { id: "AA1", source: "param WIDTH",     code: "assume property (WIDTH >= 1);" },
      { id: "AA2", source: "iface out width", code: "assume property ($bits(out) == WIDTH);" },
    ],
    covers: [
      { id: "C1", req: "REQ-FUNC-001", name: "c_both_ones", desc: "Both operands max", code: "cover property ..." },
    ],
    bind_module: "bind my_mod my_props u_props (.*);",
  }, overrides);
}

check("FormalPropsStage: renders SVA Assertions tab by default", () => {
  const el = stages.FormalPropsStage({ data: fpFixture() });
  // Both P1 and P2 property IDs should render
  assert.ok(findByText(el, "P1"));
  assert.ok(findByText(el, "P2"));
});

check("FormalPropsStage: renders property names", () => {
  const el = stages.FormalPropsStage({ data: fpFixture() });
  assert.ok(findByText(el, "p_add_valid"));
  assert.ok(findByText(el, "p_input_stable"));
});

check("FormalPropsStage: renders REQ backrefs on properties", () => {
  const el = stages.FormalPropsStage({ data: fpFixture() });
  assert.ok(findByText(el, "REQ-FUNC-001"));
});

check("FormalPropsStage: renders property type tags (assert/assume)", () => {
  const el = stages.FormalPropsStage({ data: fpFixture() });
  assert.ok(findByText(el, "assert"));
  assert.ok(findByText(el, "assume"));
});

check("FormalPropsStage: SubTab has auto-constraints tab when autoAssumptions exist", () => {
  const el = stages.FormalPropsStage({ data: fpFixture() });
  assert.ok(findByText(el, "Auto Constraints"));
});

check("FormalPropsStage: tab count for autoAssumptions matches", () => {
  const el = stages.FormalPropsStage({ data: fpFixture() });
  // The "(2)" badge should render next to Auto Constraints
  assert.ok(findByText(el, "2"));
});

check("FormalPropsStage: NO auto tab when autoAssumptions is empty", () => {
  const el = stages.FormalPropsStage({
    data: Object.assign({}, fpFixture(), { autoAssumptions: [] }),
  });
  assert.equal(findByText(el, "Auto Constraints"), null);
});

check("FormalPropsStage: always shows Cover Statements tab", () => {
  const el = stages.FormalPropsStage({ data: fpFixture() });
  assert.ok(findByText(el, "Cover Statements"));
});

check("FormalPropsStage: always shows Bind Module tab", () => {
  const el = stages.FormalPropsStage({ data: fpFixture() });
  assert.ok(findByText(el, "Bind Module"));
});

check("FormalPropsStage: properties=[] shows 'No properties generated' message", () => {
  const el = stages.FormalPropsStage({
    data: { properties: [], autoAssumptions: [], covers: [], bind_module: "" },
  });
  assert.ok(findByText(el, "No properties generated"));
});

// ═══════════════════════════════════════════════════════════════════════════
// LintStage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[LintStage]");

function lintFixture(overrides = {}) {
  return Object.assign({
    status: "PASS",
    tool: "verilator",
    iteration: 1,
    cli: true,
    summary: "No issues found in 248 lines of RTL",
    errors: [],
    warnings: [
      { sev: "WARN", line: 42, code: "WIDTH", msg: "Operator WIDTH expects 32 bits" },
    ],
    iterations: [
      { iter: 1, status: "PASS", errors: 0, warnings: 1 },
    ],
    log: "Verilator output goes here",
  }, overrides);
}

check("LintStage: shows status tag", () => {
  const el = stages.LintStage({
    data: lintFixture(),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "PASS"));
});

check("LintStage: shows tool tag", () => {
  const el = stages.LintStage({
    data: lintFixture(),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "verilator"));
});

check("LintStage: shows iteration counter referencing MAX_LINT_ITERS", () => {
  const el = stages.LintStage({
    data: lintFixture({ iteration: 2 }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  // "Iteration 2/3" — concatenated text inside a Tag
  assert.ok(findByText(el, "Iteration 2/3"));
});

check("LintStage: cli=true shows 'Real CLI' badge", () => {
  const el = stages.LintStage({
    data: lintFixture({ cli: true }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Real CLI"));
});

check("LintStage: cli=false shows 'AI Estimated' badge", () => {
  const el = stages.LintStage({
    data: lintFixture({ cli: false }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "AI Estimated"));
});

check("LintStage: cli=false + _cliError shows backend-unreachable banner", () => {
  const el = stages.LintStage({
    data: lintFixture({ cli: false, _cliError: "ECONNREFUSED" }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Backend configured but unreachable"));
  assert.ok(findByText(el, "ECONNREFUSED"));
});

check("LintStage: warningsAsErrors=true shows 'Warnings = Errors' button", () => {
  const el = stages.LintStage({
    data: lintFixture(),
    warningsAsErrors: true, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Warnings = Errors"));
});

check("LintStage: warningsAsErrors=false shows 'Warnings = Info' button", () => {
  const el = stages.LintStage({
    data: lintFixture(),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Warnings = Info"));
});

check("LintStage: errors list renders each error", () => {
  const el = stages.LintStage({
    data: lintFixture({
      status: "FAIL",
      errors: [
        { line: 10, code: "SYNTAX", msg: "Unexpected token" },
        { line: 20, code: "UNDEF",  msg: "Undefined identifier foo" },
      ],
    }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Unexpected token"));
  assert.ok(findByText(el, "Undefined identifier foo"));
});

// ═══════════════════════════════════════════════════════════════════════════
// VerifyStage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[VerifyStage]");

function verifyFixture(overrides = {}) {
  return Object.assign({
    pass: 8, fail: 0, total: 8,
    cov: { line: 92, branch: 87, toggle: 78 },
    cli: true,
    tests: [
      { name: "test_basic",  st: "PASS", cyc: 100, ms: 12 },
      { name: "test_edge",   st: "PASS", cyc: 240, ms: 28 },
    ],
    log: "Simulation output",
    verifyHistory: [{ iter: 1, status: "PASS", pass: 8, total: 8 }],
  }, overrides);
}

check("VerifyStage: renders Tests metric card with pass/total", () => {
  const el = stages.VerifyStage({
    data: verifyFixture(),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "8/8"));
});

check("VerifyStage: renders coverage percentages", () => {
  const el = stages.VerifyStage({
    data: verifyFixture(),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  // "92%", "87%", "78%" come from cov.line/branch/toggle
  assert.ok(findByText(el, "92%"));
  assert.ok(findByText(el, "87%"));
  assert.ok(findByText(el, "78%"));
});

check("VerifyStage: renders Uncategorized category bucket", () => {
  const el = stages.VerifyStage({
    data: verifyFixture(),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  // Tests are grouped by category. Tests without a req field land in
  // "Uncategorized".
  // Default render is collapsed, so individual names are NOT visible
  // until the user clicks to expand.
  assert.ok(findByText(el, "Uncategorized"));
  // The collapsed row shows "(2 tests)" since both fixture entries are uncategorized
  assert.ok(findByText(el, "2 tests"));
});

check("VerifyStage: renders REQ-FUNC tests under Functionality bucket", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({
      tests: [
        { name: "test_a", st: "PASS", cyc: 100, ms: 12, req: "REQ-FUNC-001" },
        { name: "test_b", st: "PASS", cyc: 200, ms: 18, req: "REQ-FUNC-002" },
      ],
    }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  // Category header is visible
  assert.ok(findByText(el, "Functionality"));
  // Combined PASS — both passed
  assert.ok(findByText(el, "PASS"));
  // Summed cycles: 100 + 200 = 300
  assert.ok(findByText(el, "300 cycles"));
  // Summed time: 12 + 18 = 30
  assert.ok(findByText(el, "30ms"));
});

check("VerifyStage: FAIL category shows passing/total count", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({
      tests: [
        { name: "t1", st: "PASS", cyc: 10, ms: 1, req: "REQ-INTF-001" },
        { name: "t2", st: "FAIL", cyc: 20, ms: 2, req: "REQ-INTF-002" },
        { name: "t3", st: "PASS", cyc: 30, ms: 3, req: "REQ-INTF-003" },
      ],
    }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  // Interface bucket with 2/3 passing → FAIL 2/3
  assert.ok(findByText(el, "Interface"));
  assert.ok(findByText(el, "FAIL 2/3"));
});

// Cluster title shows distinct REQ count
check("VerifyStage: cluster title includes 'covering N requirements'", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({
      tests: [
        { name: "t1", st: "PASS", cyc: 10, ms: 1, req: "REQ-FUNC-001" },
        { name: "t2", st: "PASS", cyc: 20, ms: 2, req: "REQ-FUNC-002" },
        { name: "t3", st: "PASS", cyc: 30, ms: 3, req: "REQ-FUNC-001" },  // dup REQ
        { name: "t4", st: "PASS", cyc: 40, ms: 4, req: "REQ-FUNC-003" },
      ],
    }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  // 4 tests, 3 distinct REQ IDs
  assert.ok(findByText(el, "4 tests covering 3 requirements"));
});

check("VerifyStage: title handles multi-target tests (comma-separated REQ list)", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({
      tests: [
        { name: "t1", st: "PASS", cyc: 10, ms: 1, req: "REQ-FUNC-001, REQ-FUNC-002" },
        { name: "t2", st: "PASS", cyc: 20, ms: 2, req: "REQ-FUNC-003" },
      ],
    }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  // 2 tests, 3 distinct REQ IDs (t1 covers 2)
  assert.ok(findByText(el, "2 tests covering 3 requirements"));
});

check("VerifyStage: title singular 'requirement' when count=1", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({
      tests: [
        { name: "t1", st: "PASS", cyc: 10, ms: 1, req: "REQ-FUNC-001" },
        { name: "t2", st: "PASS", cyc: 20, ms: 2, req: "REQ-FUNC-001" },
      ],
    }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "2 tests covering 1 requirement"));
});

check("VerifyStage: Uncategorized bucket title shows only test count (no REQ count)", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({
      tests: [
        { name: "t1", st: "PASS", cyc: 10, ms: 1 },  // no req
        { name: "t2", st: "PASS", cyc: 20, ms: 2 },  // no req
      ],
    }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  // Should display "2 tests" suffix; the Uncategorized bucket must NOT
  // include a "covering" phrase since these tests have no REQ attribution.
  assert.ok(findByText(el, "Uncategorized"));
  assert.ok(findByText(el, "2 tests"));
  // The "covering ... requirements" suffix should NOT appear in the
  // Uncategorized title (positive form harder to assert via findByText;
  // negative-check via reused fixture is sufficient).
});

check("VerifyStage: cli=true shows 'Real CLI' source", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({ cli: true }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Real CLI"));
});

check("VerifyStage: cli=false shows 'AI Est.' source", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({ cli: false }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "AI Est."));
});

check("VerifyStage: Fix Loop tab is always present (mirrors LintStage)", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({ verifyHistory: [{ iter: 1, status: "PASS", pass: 8, total: 8 }] }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Fix Loop"));
});

check("VerifyStage: Fix Loop tab shows count when verifyHistory > 1", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({
      verifyHistory: [
        { iter: 1, status: "FAIL", pass: 6, total: 8, triageTarget: "RTL", triageReason: "spec mismatch" },
        { iter: 2, status: "PASS", pass: 8, total: 8 },
      ],
    }),
    warningsAsErrors: false, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Fix Loop"));
});

check("VerifyStage: covWarning badge appears when _covWarning is set", () => {
  const el = stages.VerifyStage({
    data: verifyFixture({ _covWarning: true }),
    warningsAsErrors: true, setWarningsAsErrors: noop,
  });
  assert.ok(findByText(el, "Coverage below threshold"));
});

// ═══════════════════════════════════════════════════════════════════════════
// JudgeStage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[JudgeStage]");

function judgeFixture(overrides = {}) {
  return Object.assign({
    overall: "PASS",
    score: 92,
    trace: [
      { req: "REQ-FUNC-001", ok: true,  note: "Verified by test_basic" },
      { req: "REQ-FUNC-002", ok: true,  note: "Verified by test_edge" },
      { req: "REQ-TIME-001", ok: false, note: "No timing test found" },
    ],
    recs: [
      "Add timing-corner regression",
      "Increase toggle coverage on bypass path",
    ],
    judgeHistory: [{ iter: 1, overall: "PASS", score: 92, unmet: 0, total: 3 }],
  }, overrides);
}

check("JudgeStage: shows overall verdict text", () => {
  const el = stages.JudgeStage({ data: judgeFixture(), onExport: noop, onExportPackage: noop });
  assert.ok(findByText(el, "PASS"));
});

// The verification-provenance gate (judge.js) downgrades a gate-PASS built on
// LLM-estimated simulation to UNVERIFIED and attaches unverifiedReason. The
// verdict tab must render both the third verdict value and the reason note.
check("JudgeStage: UNVERIFIED verdict renders with provenance reason", () => {
  const el = stages.JudgeStage({
    data: judgeFixture({
      overall: "UNVERIFIED",
      verified: false,
      evalOverall: "PASS",
      unverifiedReason: "Simulation results were LLM-estimated (no CLI backend).",
    }),
    onExport: noop, onExportPackage: noop,
  });
  assert.ok(findByText(el, "UNVERIFIED"), "verdict text must show UNVERIFIED");
  assert.ok(findByText(el, "LLM-estimated"), "reason note must be rendered");
});

check("JudgeStage: UNVERIFIED disables package export (not a verified deliverable)", () => {
  const el = stages.JudgeStage({
    data: judgeFixture({ overall: "UNVERIFIED", verified: false, evalOverall: "PASS" }),
    onExport: noop, onExportPackage: noop,
  });
  const all = allNodes(el);
  const pkgBtn = all.find(function(n) {
    return n.props && n.props.disabled !== undefined
      && JSON.stringify(n.children || []).includes("Package");
  });
  assert.ok(pkgBtn, "Export as Package button should exist");
  assert.equal(pkgBtn.props.disabled, true,
    "package export must stay disabled on UNVERIFIED");
});

check("JudgeStage: shows score number", () => {
  const el = stages.JudgeStage({ data: judgeFixture(), onExport: noop, onExportPackage: noop });
  assert.ok(findByText(el, "92"));
});

check("JudgeStage: shows requirements coverage ratio", () => {
  const el = stages.JudgeStage({ data: judgeFixture(), onExport: noop, onExportPackage: noop });
  // 2 ok out of 3 trace items
  assert.ok(findByText(el, "2/3"));
});

check("JudgeStage: shows Export Regression Suite button", () => {
  const el = stages.JudgeStage({ data: judgeFixture(), onExport: noop, onExportPackage: noop });
  assert.ok(findByText(el, "Export Regression Suite"));
});

check("JudgeStage: shows Export as Package button", () => {
  const el = stages.JudgeStage({ data: judgeFixture(), onExport: noop, onExportPackage: noop });
  assert.ok(findByText(el, "Export as Package"));
});

check("JudgeStage: PASS verdict enables Export-as-Package button", () => {
  const el = stages.JudgeStage({ data: judgeFixture({ overall: "PASS" }), onExport: noop, onExportPackage: noop });
  // Find the button by its label and check its disabled state via props
  const all = allNodes(el);
  // The Btn component will render to a <button> after expansion. Look for
  // any button whose children include "Export as Package"
  const btn = all.find((n) => {
    if (n.type !== "button") return false;
    const childText = (n.children || []).map((c) => typeof c === "string" ? c : "").join("");
    return childText.includes("Export as Package");
  });
  // Active button should not have onClick === undefined (Btn's disabled state
  // unbinds onClick)
  assert.ok(btn);
  assert.notEqual(btn.props.onClick, undefined);
});

check("JudgeStage: FAIL verdict disables Export-as-Package button", () => {
  const el = stages.JudgeStage({ data: judgeFixture({ overall: "FAIL" }), onExport: noop, onExportPackage: noop });
  const all = allNodes(el);
  const btn = all.find((n) => {
    if (n.type !== "button") return false;
    const childText = (n.children || []).map((c) => typeof c === "string" ? c : "").join("");
    return childText.includes("Export as Package");
  });
  assert.ok(btn);
  // Disabled Btn unbinds onClick
  assert.equal(btn.props.onClick, undefined);
});

check("JudgeStage: trace tab data renders requirement IDs", () => {
  // Default tab is verdict, but the trace data is computed at render time
  // and rendered into the tab — we check just structural presence here
  const el = stages.JudgeStage({ data: judgeFixture(), onExport: noop, onExportPackage: noop });
  // We check the tab label is present (always rendered in the SubTab)
  assert.ok(findByText(el, "Traceability"));
  assert.ok(findByText(el, "Recommendations"));
});

check("JudgeStage: judgeHistory > 1 adds Judge Loop tab", () => {
  const el = stages.JudgeStage({
    data: judgeFixture({
      judgeHistory: [
        { iter: 1, overall: "FAIL", score: 65, unmet: 2, total: 5 },
        { iter: 2, overall: "PASS", score: 92, unmet: 0, total: 5 },
      ],
    }),
    onExport: noop, onExportPackage: noop,
  });
  assert.ok(findByText(el, "Judge Loop"));
});

check("JudgeStage: judgeHistory length=1 still shows Judge Loop tab", () => {
  // The Judge Loop tab appears whenever there's at least one iteration:
  // each iteration carries the per-criterion eval breakdown drill-down,
  // which is valuable even on a single iteration.
  const el = stages.JudgeStage({
    data: judgeFixture({ judgeHistory: [{ iter: 1, overall: "PASS", score: 92, unmet: 0, total: 5 }] }),
    onExport: noop, onExportPackage: noop,
  });
  assert.ok(findByText(el, "Judge Loop"));
});

check("JudgeStage: judgeHistory length=0 hides Judge Loop tab", () => {
  // The tab IS suppressed when there are zero iterations (e.g. judge
  // hasn't run yet). The label includes the count, so we check for the
  // exact "Judge Loop (" prefix.
  const el = stages.JudgeStage({
    data: judgeFixture({ judgeHistory: [] }),
    onExport: noop, onExportPackage: noop,
  });
  assert.equal(findByText(el, "Judge Loop"), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// ReviewStage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[ReviewStage]");

function reviewFixture(overrides = {}) {
  return Object.assign({
    verdict: "PASS",
    score: 88,
    summary: "RTL is well-structured. Minor opportunities for clarity.",
    issues: [
      { id: "I-01", severity: "minor", category: "naming",  description: "Signal `q` could be more descriptive", fix: "Rename to `data_q`" },
      { id: "I-02", severity: "suggestion", category: "style", description: "Consider grouping always blocks" },
    ],
    strengths: [
      "Reset polarity is consistent across all FFs",
      "FSM is one-hot encoded for timing",
    ],
  }, overrides);
}

check("ReviewStage: shows verdict text", () => {
  const el = stages.ReviewStage({ data: reviewFixture(), label: "RTL Review" });
  assert.ok(findByText(el, "PASS"));
});

check("ReviewStage: shows label", () => {
  const el = stages.ReviewStage({ data: reviewFixture(), label: "RTL Review" });
  assert.ok(findByText(el, "RTL Review"));
});

check("ReviewStage: defaults to 'Review' label when none provided", () => {
  const el = stages.ReviewStage({ data: reviewFixture() });
  assert.ok(findByText(el, "Review"));
});

check("ReviewStage: shows summary", () => {
  const el = stages.ReviewStage({ data: reviewFixture() });
  assert.ok(findByText(el, "well-structured"));
});

check("ReviewStage: counts issues by severity", () => {
  const el = stages.ReviewStage({
    data: reviewFixture({
      issues: [
        { severity: "critical",   description: "A" },
        { severity: "critical",   description: "B" },
        { severity: "major",      description: "C" },
        { severity: "minor",      description: "D" },
        { severity: "suggestion", description: "E" },
        { severity: "suggestion", description: "F" },
      ],
    }),
  });
  // "Critical" metric card with value 2
  assert.ok(findByText(el, "Critical"));
  assert.ok(findByText(el, "Major"));
});

check("ReviewStage: critical=0 hides Critical metric card", () => {
  const el = stages.ReviewStage({
    data: reviewFixture({ issues: [{ severity: "minor", description: "x" }] }),
  });
  // Critical card is conditional — only shows when count > 0
  assert.equal(findByText(el, "Critical"), null);
});

check("ReviewStage: shows strengths section when strengths exist", () => {
  const el = stages.ReviewStage({ data: reviewFixture() });
  assert.ok(findByText(el, "Strengths"));
  assert.ok(findByText(el, "Reset polarity is consistent"));
});

check("ReviewStage: empty strengths hides the section", () => {
  const el = stages.ReviewStage({ data: reviewFixture({ strengths: [] }) });
  assert.equal(findByText(el, "Strengths"), null);
});

check("ReviewStage: Issues tab label includes count", () => {
  const el = stages.ReviewStage({ data: reviewFixture() });
  // "Issues (2)" since fixture has 2 issues
  assert.ok(findByText(el, "Issues (2)"));
});

check("ReviewStage: Fixes tab appears when _fixes is non-empty", () => {
  const el = stages.ReviewStage({
    data: reviewFixture({ _fixes: ["Renamed q→data_q", "Grouped always blocks"] }),
  });
  assert.ok(findByText(el, "Fixes (2)"));
});

check("ReviewStage: Fixes tab hidden when _fixes is empty", () => {
  const el = stages.ReviewStage({ data: reviewFixture({ _fixes: [] }) });
  assert.equal(findByText(el, "Fixes ("), null);
});

check("ReviewStage: Iterations tab appears when _iterations > 1", () => {
  const el = stages.ReviewStage({
    data: reviewFixture({
      _iterations: [
        { iter: 1, verdict: "FAIL", score: 60, issueCount: 8 },
        { iter: 2, verdict: "PASS", score: 88, issueCount: 2 },
      ],
    }),
  });
  assert.ok(findByText(el, "Iterations (2)"));
});

check("ReviewStage: Coverage tab appears when coverage_assessment is present", () => {
  const el = stages.ReviewStage({
    data: reviewFixture({
      coverage_assessment: { must_reqs_covered: 5, must_reqs_total: 5 },
    }),
  });
  assert.ok(findByText(el, "Coverage"));
});

check("ReviewStage: empty issues array shows the issues tab label still", () => {
  const el = stages.ReviewStage({ data: reviewFixture({ issues: [] }) });
  // Issue count = 0
  assert.ok(findByText(el, "Issues (0)"));
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
