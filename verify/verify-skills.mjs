// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// verify-skills — Standalone verifier for src/skills/* and src/workflows/*
//
// Mirrors the pattern of verify-term.mjs: zero deps, run with `node`,
// exit code reflects total. Each `check` block is one assertion or
// tightly-related cluster.
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

// ─── isolated workspace ────────────────────────────────────────────────────
const TMP = path.join(os.tmpdir(), "rtlforge-verify-skills-" + process.pid);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.RTLFORGE_HOME = TMP;
delete process.env.NO_COLOR;

function writeSkill(workflow, scope, stage, content) {
  const root = scope === "user"
    ? path.join(TMP, "workflows", workflow, "skills")
    : path.join(TMP, "fakeproject", ".rtlforge", "workflows", workflow, "skills");
  fs.mkdirSync(root, { recursive: true });
  const fp = path.join(root, stage + ".md");
  fs.writeFileSync(fp, content);
  return fp;
}

// ═══════════════════════════════════════════════════════════════════════════
// frontmatter
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[skills/frontmatter]");
const { parseFrontmatter } = await import("../src/skills/frontmatter.js");

await check("frontmatter: no fence → entire input is body, empty data", () => {
  const r = parseFrontmatter("just some markdown\nno fence");
  assert.deepEqual(r.data, {});
  assert.equal(r.body, "just some markdown\nno fence");
});
await check("frontmatter: empty fence → empty data, body after", () => {
  const r = parseFrontmatter("---\n---\nhello");
  assert.deepEqual(r.data, {});
  assert.equal(r.body, "hello");
});
await check("frontmatter: scalar types coerce correctly", () => {
  const r = parseFrontmatter('---\nname: my-skill\nfoo: 42\nbar: 3.14\nflag: true\nz: null\n---\nbody');
  assert.equal(r.data.name, "my-skill");
  assert.equal(r.data.foo, 42);
  assert.equal(r.data.bar, 3.14);
  assert.equal(r.data.flag, true);
  assert.equal(r.data.z, null);
});
await check("frontmatter: block list", () => {
  const r = parseFrontmatter("---\napplies_to:\n  - rtl_generate\n  - rtl_review\n---\nbody");
  assert.deepEqual(r.data.applies_to, ["rtl_generate", "rtl_review"]);
});
await check("frontmatter: inline list", () => {
  const r = parseFrontmatter("---\napplies_to: [rtl_generate, lint]\n---\nbody");
  assert.deepEqual(r.data.applies_to, ["rtl_generate", "lint"]);
});
await check("frontmatter: quoted string with colon", () => {
  const r = parseFrontmatter('---\nname: "foo: bar"\n---\nbody');
  assert.equal(r.data.name, "foo: bar");
});
await check("frontmatter: missing closing fence → warns, body = full input", () => {
  const r = parseFrontmatter("---\na: b\nno closer here\n");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /no closing/);
});
await check("frontmatter: inline # comment is rejected", () => {
  let threw = null;
  try { parseFrontmatter("---\na: b # bad\n---\n"); } catch (e) { threw = e; }
  assert.ok(threw, "expected throw");
  assert.match(threw.message, /inline '#' comments/);
});
await check("frontmatter: invalid key name is rejected", () => {
  let threw = null;
  try { parseFrontmatter("---\nbad-Key!: x\n---\n"); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.match(threw.message, /invalid key name/);
});
await check("frontmatter: duplicate key warns, last wins", () => {
  const r = parseFrontmatter("---\na: 1\na: 2\n---\nbody");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.data.a, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// workflows
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[workflows]");
const { getWorkflow, listWorkflows, DEFAULT_WORKFLOW } = await import("../src/workflows/index.js");

await check("workflows: rtl is registered as DEFAULT_WORKFLOW", () => {
  assert.equal(DEFAULT_WORKFLOW, "rtl");
  const wf = getWorkflow("rtl");
  assert.ok(Array.isArray(wf.stages));
  assert.ok(wf.stages.length >= 12, "rtl workflow stage count = " + wf.stages.length);
});
await check("workflows: skillStageIds includes 'agent' synthetic stage", () => {
  const wf = getWorkflow("rtl");
  assert.ok(wf.skillStageIds.includes("agent"));
});
await check("workflows: getWorkflow throws clearly on unknown name", () => {
  let threw = null;
  try { getWorkflow("fpga"); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.match(threw.message, /unknown workflow 'fpga'/);
});
await check("workflows: listWorkflows returns at least rtl", () => {
  const list = listWorkflows();
  assert.ok(list.find(function(w) { return w.name === "rtl"; }));
});

// ═══════════════════════════════════════════════════════════════════════════
// loader
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[skills/loader]");
const { loadSkillsForStage, loadSkillFile } = await import("../src/skills/loader.js");

await check("loader: returns empty list when no skills exist", async () => {
  const r = await loadSkillsForStage({ workflow: "rtl", stageKey: "verify", cwd: "/tmp/no-such" });
  assert.deepEqual(r.skills, []);
});

await check("loader: picks up a single user skill", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate",
    "---\npriority: 100\n---\nUse always_ff.\n");
  const r = await loadSkillsForStage({ workflow: "rtl", stageKey: "rtl_generate", cwd: "/tmp/no-project" });
  assert.equal(r.skills.length, 1);
  assert.equal(r.skills[0].priority, 100);
  assert.equal(r.skills[0].scope, "user");
  assert.equal(r.skills[0].body, "Use always_ff.");
});

await check("loader: cross-stage applies_to (skill at rtl_generate.md applies to rtl_review)", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate",
    "---\napplies_to: [rtl_generate, rtl_review]\n---\nshared guidance");
  const r1 = await loadSkillsForStage({ workflow: "rtl", stageKey: "rtl_generate", cwd: "/tmp/no-project" });
  const r2 = await loadSkillsForStage({ workflow: "rtl", stageKey: "rtl_review", cwd: "/tmp/no-project" });
  assert.equal(r1.skills.length, 1);
  assert.equal(r2.skills.length, 1);
  assert.equal(r1.skills[0].id, r2.skills[0].id);
});

await check("loader: skills filed under <stage>/ subdir are loaded", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  const subDir = path.join(TMP, "workflows", "rtl", "skills", "rtl_generate");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "01-style.md"),  "First skill body.");
  fs.writeFileSync(path.join(subDir, "02-naming.md"), "Second skill body.");
  const r = await loadSkillsForStage({ workflow: "rtl", stageKey: "rtl_generate", cwd: "/tmp/no-project" });
  assert.equal(r.skills.length, 2);
  // Alphabetic order within the dir → 01-style first
  assert.match(r.skills[0].path, /01-style\.md$/);
});

await check("loader: project skill overrides user skill (later in scope order)", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, "fakeproject"), { recursive: true, force: true });
  writeSkill("rtl", "user",    "rtl_generate", "user-side body");
  writeSkill("rtl", "project", "rtl_generate", "project-side body");
  const r = await loadSkillsForStage({
    workflow: "rtl", stageKey: "rtl_generate",
    cwd: path.join(TMP, "fakeproject"),
  });
  assert.equal(r.skills.length, 2);
  // Sort: scope user before project
  assert.equal(r.skills[0].scope, "user");
  assert.equal(r.skills[1].scope, "project");
});

await check("loader: mode:replace winnowing keeps highest-priority replace skill only", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, "fakeproject"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate",
    "---\npriority: 50\nmode: replace\n---\nLower priority replace");
  writeSkill("rtl", "project", "rtl_generate",
    "---\npriority: 100\nmode: replace\n---\nHigher priority replace");
  const r = await loadSkillsForStage({
    workflow: "rtl", stageKey: "rtl_generate",
    cwd: path.join(TMP, "fakeproject"),
  });
  assert.equal(r.skills.length, 1);
  assert.match(r.skills[0].body, /Higher priority replace/);
});

await check("loader: bad frontmatter on one skill produces warning, doesn't throw", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate",
    "---\nbad line no colon\n---\nbody");
  writeSkill("rtl", "user", "lint", "good skill body");
  const r = await loadSkillsForStage({ workflow: "rtl", stageKey: "rtl_generate", cwd: "/tmp/no-project" });
  assert.equal(r.skills.length, 0);
  assert.equal(r.warnings.length, 1);
  // The lint stage should still load fine
  const r2 = await loadSkillsForStage({ workflow: "rtl", stageKey: "lint", cwd: "/tmp/no-project" });
  assert.equal(r2.skills.length, 1);
});

await check("loader: invalid `mode` value throws on file load", () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  const fp = writeSkill("rtl", "user", "rtl_generate",
    "---\nmode: nonsense\n---\nbody");
  let threw = null;
  try { loadSkillFile(fp, "rtl_generate", "user"); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.match(threw.message, /must be one of/);
});

// ═══════════════════════════════════════════════════════════════════════════
// invariants
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[skills/invariants]");
const { invariantsForStage, findInvariant, listAllInvariants } = await import("../src/skills/invariants.js");

await check("invariants: rtl_generate has json + code field", () => {
  const ids = invariantsForStage("rtl_generate").map(function(i) { return i.id; });
  assert.ok(ids.includes("json_output_required"));
  assert.ok(ids.includes("code_field_required"));
});
await check("invariants: verify has tests + fixes", () => {
  const ids = invariantsForStage("verify").map(function(i) { return i.id; });
  assert.ok(ids.includes("tests_field_required"));
  assert.ok(ids.includes("fixes_field_required"));
});
await check("invariants: findInvariant returns null for unknown id", () => {
  assert.equal(findInvariant("does_not_exist"), null);
});
await check("invariants: json check distinguishes 'no JSON' phrase from 'JSON output'", () => {
  const inv = findInvariant("json_output_required");
  // Negative: skill says "no JSON, just code"
  assert.equal(inv.check("Just write me the SystemVerilog. No JSON, no schema."), false);
  // Positive: schema fragment alone
  assert.equal(inv.check('{ "code": "..." }'), true);
  // Positive: prose + word
  assert.equal(inv.check("Return JSON of this exact shape."), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// compose
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[skills/compose]");
const { composeWithSkills } = await import("../src/skills/compose.js");

function fakeSkill(opts) {
  return Object.assign({
    id: "test:skill",
    stageKey: "rtl_generate",
    scope: "user",
    path: "/test/skill.md",
    body: "skill body",
    frontmatter: {},
    warnings: [],
    priority: 50,
    mode: "append",
    overrides: [],
    appliesTo: ["rtl_generate"],
  }, opts || {});
}

await check("compose: append puts skill body after core", () => {
  const r = composeWithSkills("CORE", [fakeSkill({ body: "appended" })]);
  assert.match(r.text, /^CORE/);
  assert.match(r.text, /appended/);
  assert.equal(r.replaced, false);
  // Provenance: core then skill
  const kinds = r.provenance.map(function(p) { return p.kind; });
  assert.deepEqual(kinds, ["core", "skill"]);
});
await check("compose: prepend puts skill body before core", () => {
  const r = composeWithSkills("CORE", [fakeSkill({ mode: "prepend", body: "prepended" })]);
  const prepIdx = r.text.indexOf("prepended");
  const coreIdx = r.text.indexOf("CORE");
  assert.ok(prepIdx >= 0 && coreIdx >= 0 && prepIdx < coreIdx,
    "prepend skill should come before core");
});
await check("compose: replace drops core entirely, sets replaced=true", () => {
  const r = composeWithSkills("CORE", [fakeSkill({ mode: "replace", body: "REPLACEMENT" })]);
  assert.match(r.text, /REPLACEMENT/);
  assert.doesNotMatch(r.text, /CORE/);
  assert.equal(r.replaced, true);
});
await check("compose: empty skill list returns core only", () => {
  const r = composeWithSkills("CORE", []);
  assert.equal(r.text, "CORE");
});
await check("compose: provenance ranges sum to total length", () => {
  const r = composeWithSkills("CORE", [fakeSkill({ body: "appended" })]);
  const last = r.provenance[r.provenance.length - 1];
  assert.equal(last.range[1], r.text.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// validate + policy
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[skills/validate]");
const { validateComposedPrompt, applyPolicy } = await import("../src/skills/validate.js");

await check("validate: clean prompt has zero contradictions", () => {
  const r = validateComposedPrompt({
    stageKey: "rtl_generate",
    composedText: 'Return JSON of shape { "code": "..." }',
    skills: [],
  });
  assert.equal(r.contradictions.length, 0);
});
await check("validate: missing JSON fires structural invariant", () => {
  const r = validateComposedPrompt({
    stageKey: "rtl_generate",
    composedText: "Just generate the SystemVerilog. No JSON, no schema.",
    skills: [],
  });
  const ids = r.contradictions.map(function(c) { return c.invariantId; });
  assert.ok(ids.includes("json_output_required"));
  assert.ok(ids.includes("code_field_required"));
});
await check("policy: default 'fail' splits all contradictions into hardFails", () => {
  const r = {
    contradictions: [
      { invariantId: "x", label: "x", severity: "structural", remedy: "x", overriddenBy: null },
      { invariantId: "y", label: "y", severity: "semantic",   remedy: "y", overriddenBy: null },
    ],
    unknownOverrides: [],
  };
  const p = applyPolicy(r, "fail");
  assert.equal(p.hardFails.length, 2);
  assert.equal(p.warnings.length, 0);
});
await check("policy: 'warn' demotes everything to warnings", () => {
  const r = {
    contradictions: [
      { invariantId: "x", label: "x", severity: "structural", remedy: "x", overriddenBy: null },
    ],
    unknownOverrides: [],
  };
  const p = applyPolicy(r, "warn");
  assert.equal(p.hardFails.length, 0);
  assert.equal(p.warnings.length, 1);
});
await check("policy: 'warn-semantic' fails on structural, warns on semantic", () => {
  const r = {
    contradictions: [
      { invariantId: "x", label: "x", severity: "structural", remedy: "x", overriddenBy: null },
      { invariantId: "y", label: "y", severity: "semantic",   remedy: "y", overriddenBy: null },
    ],
    unknownOverrides: [],
  };
  const p = applyPolicy(r, "warn-semantic");
  assert.equal(p.hardFails.length, 1);
  assert.equal(p.hardFails[0].invariantId, "x");
  assert.equal(p.warnings.length, 1);
  assert.equal(p.warnings[0].invariantId, "y");
});
await check("policy: per-skill overrides_invariants downgrades to warning even under 'fail'", () => {
  const r = {
    contradictions: [
      { invariantId: "x", label: "x", severity: "structural", remedy: "x", overriddenBy: "user:skill1" },
    ],
    unknownOverrides: [],
  };
  const p = applyPolicy(r, "fail");
  assert.equal(p.hardFails.length, 0);
  assert.equal(p.warnings.length, 1);
});
await check("policy: unknown overrides_invariants id surfaces as warning", () => {
  const r = {
    contradictions: [],
    unknownOverrides: [{ skillId: "user:s", invariantId: "no_such_invariant" }],
  };
  const p = applyPolicy(r, "fail");
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0].label, /no_such_invariant/);
});

// ═══════════════════════════════════════════════════════════════════════════
// term/skills bridge
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[term/skills bridge]");
const { applySkillOverlay, checkSkillsForStage, _internal: bridgeInternal } = await import("../src/term/skills.js");

await check("bridge: no skills + no GUI overrides returns prompt unchanged", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  const prompt = { systemPrompt: "sys", userMessage: "core text", maxTokens: 4096 };
  const out = await applySkillOverlay(prompt, {
    stageKey: "rtl_generate",
    workflow: "rtl",
    config: {},
    cwd: "/tmp/no-project",
  });
  assert.strictEqual(out, prompt);
});

await check("bridge: with a skill, userMessage gets overlay appended", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate", "Use always_ff for sequential.");
  const prompt = {
    systemPrompt: "sys",
    userMessage: 'Return JSON of shape { "code": "..." }',
    maxTokens: 4096,
  };
  const out = await applySkillOverlay(prompt, {
    stageKey: "rtl_generate",
    workflow: "rtl",
    config: {},
    cwd: "/tmp/no-project",
  });
  assert.match(out.userMessage, /Use always_ff/);
  assert.ok(out._skillsApplied.length === 1);
  assert.equal(out._skillsReplaced, false);
});

await check("bridge: hard-fail throws ESKILLFAIL with structured contradictions", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate",
    "---\nmode: replace\n---\nJust write the SystemVerilog. No JSON, no schema.");
  const prompt = {
    systemPrompt: "sys",
    userMessage: 'Return JSON of shape { "code": "..." }',
    maxTokens: 4096,
  };
  let threw = null;
  try {
    await applySkillOverlay(prompt, {
      stageKey: "rtl_generate",
      workflow: "rtl",
      config: { skillContradictionPolicy: "fail" },
      cwd: "/tmp/no-project",
    });
  } catch (e) { threw = e; }
  assert.ok(threw, "expected ESKILLFAIL");
  assert.equal(threw.code, "ESKILLFAIL");
  assert.ok(Array.isArray(threw.contradictions));
  assert.ok(threw.contradictions.length >= 1);
});

await check("bridge: warn policy bypasses hard fail (returns composed prompt)", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate",
    "---\nmode: replace\n---\nJust write the SystemVerilog. No JSON, no schema.");
  const warnings = [];
  const prompt = {
    systemPrompt: "sys",
    userMessage: 'Return JSON of shape { "code": "..." }',
    maxTokens: 4096,
  };
  const out = await applySkillOverlay(prompt, {
    stageKey: "rtl_generate",
    workflow: "rtl",
    config: { skillContradictionPolicy: "warn" },
    cwd: "/tmp/no-project",
    onWarning: function(m) { warnings.push(m); },
  });
  assert.ok(out.userMessage);
  assert.ok(warnings.length > 0, "should have surfaced contradiction warnings");
});

await check("bridge: per-skill overrides_invariants downgrades hard fail to warning", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate",
    "---\nmode: replace\noverrides_invariants: [json_output_required, code_field_required]\n---\nJust write the SystemVerilog.");
  const warnings = [];
  const prompt = {
    systemPrompt: "sys",
    userMessage: 'Return JSON of shape { "code": "..." }',
    maxTokens: 4096,
  };
  const out = await applySkillOverlay(prompt, {
    stageKey: "rtl_generate",
    workflow: "rtl",
    config: { skillContradictionPolicy: "fail" },
    cwd: "/tmp/no-project",
    onWarning: function(m) { warnings.push(m); },
  });
  assert.ok(out.userMessage);
  // Each invariant fired but was overridden — warning, not fail
  assert.ok(warnings.length >= 2);
});

await check("bridge: GUI promptOverrides flow through as a synthetic 'config'-scope append skill", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  const prompt = {
    systemPrompt: "sys",
    userMessage: 'Return JSON of shape { "code": "..." }',
    maxTokens: 4096,
  };
  const config = {
    promptOverrides: {
      rtl_generate: [
        { title: "Custom Section", content: 'Generate SV. Return JSON. Schema: { "code": "..." }' },
      ],
    },
  };
  const out = await applySkillOverlay(prompt, {
    stageKey: "rtl_generate",
    workflow: "rtl",
    config: config,
    cwd: "/tmp/no-project",
  });
  assert.ok(out._skillsApplied.includes("config:promptOverrides:rtl_generate"));
  // Append mode is the default — base prompt must SURVIVE
  assert.equal(out._skillsReplaced, false,
    "default mode must be append, NOT replace");
  // The core prompt must still be present in the composed user message
  assert.ok(out.userMessage.indexOf('Return JSON of shape { "code": "..." }') >= 0,
    "base prompt content must survive override (append mode appends, doesn't truncate)");
  // The user's edit must also be present
  assert.ok(out.userMessage.indexOf("Custom Section") >= 0,
    "user override content must be in composed userMessage");
});

await check("bridge: opt-in replace mode (config.promptOverridesMode=replace) still works", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  const prompt = {
    systemPrompt: "sys",
    userMessage: 'BASE PROMPT — distinctive sentinel\nSchema: {"code":"<sv source>"}',
    maxTokens: 4096,
  };
  const config = {
    promptOverridesMode: "replace",  // explicit opt-in
    promptOverrides: {
      rtl_generate: [
        { title: "Total Replacement", content: 'ENTIRELY NEW PROMPT\nSchema: {"code":"<sv>"}' },
      ],
    },
  };
  const out = await applySkillOverlay(prompt, {
    stageKey: "rtl_generate",
    workflow: "rtl",
    config: config,
    cwd: "/tmp/no-project",
  });
  assert.equal(out._skillsReplaced, true);
  // Base prompt must NOT survive in replace mode
  assert.equal(out.userMessage.indexOf("BASE PROMPT — distinctive sentinel"), -1,
    "in replace mode the base prompt should be gone");
  assert.ok(out.userMessage.indexOf("ENTIRELY NEW PROMPT") >= 0);
});

await check("bridge: spec context survives a single-section edit", async () => {
  // Pins the symptom: "asked for a synchronous FIFO, got a register" —
  // caused by replace-mode wiping the spec content from the base prompt.
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  const basePrompt = {
    systemPrompt: "sys",
    userMessage: [
      "TASK: Produce one synthesisable SystemVerilog module named \"sync_fifo\".",
      "",
      "SPECIFICATION (interface, parameters, requirements):",
      '{"iface":[{"name":"clk","dir":"input"},{"name":"rd_en"},{"name":"wr_en"}],',
      ' "params":[{"name":"DATA_W","def":8}],',
      ' "requirements":[{"id":"REQ-FUNC-001","desc":"FIFO must support concurrent read/write"}]}',
      "",
      "Generate the FIFO.",
      "",
      'Output Schema: {"code":"<full SystemVerilog source>"}',
    ].join("\n"),
    maxTokens: 4096,
  };
  const config = {
    promptOverrides: {
      // User edits just ONE section in the GUI — the "System Identity" one.
      rtl_generate: [
        { title: "Style Hint", content: "Prefer always_ff @(posedge clk or negedge rst_n)." },
      ],
    },
  };
  const out = await applySkillOverlay(basePrompt, {
    stageKey: "rtl_generate",
    workflow: "rtl",
    config: config,
    cwd: "/tmp/no-project",
  });
  // Critical: spec content MUST still be present in the composed prompt.
  // Under replace mode it would be missing.
  assert.ok(out.userMessage.indexOf("sync_fifo") >= 0,
    "module name from base prompt MUST survive");
  assert.ok(out.userMessage.indexOf("REQ-FUNC-001") >= 0,
    "requirement ID from base prompt MUST survive");
  assert.ok(out.userMessage.indexOf("DATA_W") >= 0,
    "parameter name from base prompt MUST survive");
  assert.ok(out.userMessage.indexOf("concurrent read/write") >= 0,
    "requirement description from base prompt MUST survive");
  // And the user's overlay must also be there
  assert.ok(out.userMessage.indexOf("Style Hint") >= 0);
  assert.ok(out.userMessage.indexOf("always_ff") >= 0);
});

await check("bridge: stage not in workflow.skillStageIds is a no-op", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  const prompt = { systemPrompt: "s", userMessage: "u", maxTokens: 100 };
  const out = await applySkillOverlay(prompt, {
    stageKey: "made_up_stage",
    workflow: "rtl",
    config: {},
    cwd: "/tmp/no-project",
  });
  assert.strictEqual(out, prompt);
});

await check("bridge: prompt with no userMessage returned unchanged", async () => {
  const prompt = { systemPrompt: "s" };
  const out = await applySkillOverlay(prompt, {
    stageKey: "rtl_generate",
    workflow: "rtl",
    config: {},
    cwd: "/tmp/no-project",
  });
  assert.strictEqual(out, prompt);
});

await check("bridge: checkSkillsForStage returns structured report without throwing", async () => {
  fs.rmSync(path.join(TMP, "workflows"), { recursive: true, force: true });
  writeSkill("rtl", "user", "rtl_generate", "harmless guidance");
  const r = await checkSkillsForStage({
    workflow: "rtl", stageKey: "rtl_generate",
    cwd: "/tmp/no-project",
    config: {},
    corePrompt: 'Return JSON of shape { "code": "..." }',
  });
  assert.equal(r.skills.length, 1);
  assert.equal(r.hardFails.length, 0);
});

await check("bridge: resolvePolicy precedence (override > config > default)", () => {
  const r = bridgeInternal.resolvePolicy({}, {});
  assert.equal(r, "fail");
  const r2 = bridgeInternal.resolvePolicy({ skillContradictionPolicy: "warn" }, {});
  assert.equal(r2, "warn");
  const r3 = bridgeInternal.resolvePolicy({ skillContradictionPolicy: "warn" }, { policyOverride: "warn-semantic" });
  assert.equal(r3, "warn-semantic");
});

// ═══════════════════════════════════════════════════════════════════════════
// pipeline integration: applySkillsToPrompt helper
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[pipeline/applySkillsToPrompt]");
const { applySkillsToPrompt } = await import("../src/pipeline/applySkillsToPrompt.js");

await check("applySkillsToPrompt: no bridge → prompt returned unchanged", async () => {
  const p = { systemPrompt: "s", userMessage: "u" };
  const out = await applySkillsToPrompt(p, {}, "rtl_generate");
  assert.strictEqual(out, p);
});

await check("applySkillsToPrompt: bridge present → applyOverlay called", async () => {
  let capturedStageKey = null;
  let capturedPrompt = null;
  const fakeBridge = {
    applyOverlay: async function(prompt, stageKey) {
      capturedStageKey = stageKey;
      capturedPrompt = prompt;
      return Object.assign({}, prompt, { _modified: true });
    },
  };
  const p = { systemPrompt: "s", userMessage: "u" };
  const out = await applySkillsToPrompt(p, { _skillBridge: fakeBridge }, "rtl_generate");
  assert.equal(capturedStageKey, "rtl_generate");
  assert.strictEqual(capturedPrompt, p);
  assert.equal(out._modified, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════
fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n═══════════════════════════════════════");
console.log("  Passed: " + passed);
console.log("  Failed: " + failures.length);
console.log("  Status: " + (failures.length === 0 ? "ALL PASS ✓" : "FAILURES"));
console.log("═══════════════════════════════════════");
if (failures.length > 0) {
  for (const f of failures) console.log("  • " + f.name + ": " + f.message);
  process.exit(1);
}
