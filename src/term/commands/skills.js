// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/skills — Skill file management subcommands
//
//   rtlforge skills list   [--workflow rtl] [--stage rtl_generate]
//   rtlforge skills show   <stage> [--workflow rtl]
//   rtlforge skills check  [<stage>] [--workflow rtl]
//   rtlforge skills new    <stage> [--workflow rtl] [--scope user|project]
//   rtlforge skills path   [--workflow rtl]
//   rtlforge skills invariants
//
// All subcommands work fully offline (no LLM calls). They read skill
// files, parse frontmatter, run rule-based validation, and print
// structured output. The `check` subcommand exits non-zero when the
// composed prompt would hard-fail — useful in CI to gate skill PRs.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { c, ICON, table, heading } from "../format.js";
import { loadSkillsForStage, _internal as loaderInternal } from "../../skills/loader.js";
import { listAllInvariants, invariantsForStage } from "../../skills/invariants.js";
import { checkSkillsForStage } from "../skills.js";
import { getWorkflow, listWorkflows, DEFAULT_WORKFLOW } from "../../workflows/index.js";

// ── list ────────────────────────────────────────────────────────────────────
async function cmdList(args, config) {
  const workflowName = args.workflow || config.workflow || DEFAULT_WORKFLOW;
  const wf = getWorkflow(workflowName);
  const onlyStage = args.stage || null;

  const stageKeys = onlyStage ? [onlyStage] : wf.skillStageIds.slice();
  const allRows = [];
  const warningsSeen = new Set();
  let totalSkills = 0;

  for (const stageKey of stageKeys) {
    const r = await loadSkillsForStage({
      workflow: workflowName,
      stageKey: stageKey,
      cwd: process.cwd(),
    });
    for (const s of r.skills) {
      // Each skill might appear under multiple stage queries via applies_to.
      // De-dup by file path so we don't print the same skill twice.
      if (allRows.some(function(row) { return row._path === s.path; })) continue;
      allRows.push({
        _path: s.path,
        scope: s.scope,
        id: s.id,
        appliesTo: s.appliesTo.join(","),
        mode: s.mode,
        priority: String(s.priority),
        path: prettyPath(s.path),
      });
      totalSkills++;
    }
    for (const w of (r.warnings || [])) {
      const dedupKey = w.path + "::" + w.message;
      if (warningsSeen.has(dedupKey)) continue;
      warningsSeen.add(dedupKey);
      process.stderr.write(c.yellow("⚠ ") + prettyPath(w.path) + ": " + w.message + "\n");
    }
  }

  process.stdout.write(heading("Skills for workflow '" + workflowName + "'"
    + (onlyStage ? " — stage " + onlyStage : "")) + "\n");
  if (allRows.length === 0) {
    process.stdout.write(c.dim("(none found)") + "\n");
    process.stdout.write(c.dim("create one with: ") + "rtlforge skills new <stage>\n");
    return 0;
  }
  process.stdout.write(table([
    { key: "scope",     label: "Scope" },
    { key: "id",        label: "ID" },
    { key: "appliesTo", label: "Applies to" },
    { key: "mode",      label: "Mode" },
    { key: "priority",  label: "Pri", align: "right" },
    { key: "path",      label: "Path" },
  ], allRows) + "\n");
  return 0;
}

// ── show ────────────────────────────────────────────────────────────────────
async function cmdShow(args, config) {
  const workflowName = args.workflow || config.workflow || DEFAULT_WORKFLOW;
  const stageKey = args._[1];
  if (!stageKey) {
    process.stderr.write(c.red("error:") + " usage: rtlforge skills show <stage>\n");
    return 2;
  }
  const r = await loadSkillsForStage({
    workflow: workflowName, stageKey: stageKey, cwd: process.cwd(),
  });
  if (r.skills.length === 0) {
    process.stdout.write(c.dim("(no skills target stage '" + stageKey + "' in workflow '" + workflowName + "')") + "\n");
    return 0;
  }
  process.stdout.write(heading("Skills applied to " + stageKey + " (workflow " + workflowName + ")") + "\n");
  for (const s of r.skills) {
    process.stdout.write("\n" + c.bold("● " + s.id) + c.dim(" (" + s.scope + ", priority=" + s.priority + ", mode=" + s.mode + ")") + "\n");
    process.stdout.write(c.dim("  path:        ") + s.path + "\n");
    process.stdout.write(c.dim("  applies to:  ") + s.appliesTo.join(", ") + "\n");
    if (s.overrides && s.overrides.length > 0) {
      process.stdout.write(c.dim("  overrides:   ") + s.overrides.join(", ") + "\n");
    }
    process.stdout.write(c.dim("  body:") + "\n");
    process.stdout.write(s.body.split("\n").map(function(l) { return "    " + l; }).join("\n") + "\n");
  }
  return 0;
}

// ── check ───────────────────────────────────────────────────────────────────
async function cmdCheck(args, config) {
  const workflowName = args.workflow || config.workflow || DEFAULT_WORKFLOW;
  const wf = getWorkflow(workflowName);
  const onlyStage = args._[1] || null;

  // We don't call the actual LLM prompts here — building them for every
  // stage requires assembled spec/elicit/etc. data which we don't have
  // outside a real run. Instead, we synthesize a minimal "JSON-aware"
  // core prompt for each stage so structural invariants get a fair test
  // (the user's skill is what we're evaluating, not the core).
  // Stages that already use this synthetic prompt produce the same
  // contradictions as a real run when the user's skill drops the JSON
  // requirement. For richer per-stage scaffolds, add to STUB_CORE below.
  const STUB_CORE = function(stageKey) {
    // The simplest viable core for invariant testing: declares JSON
    // output, a code field, and (for fix-loop stages) a fixes array.
    const wantsCode = ["rtl_generate", "test_generate"].indexOf(stageKey) >= 0;
    const wantsFixes = ["lint", "lint_test", "verify", "rtl_review", "test_review"].indexOf(stageKey) >= 0;
    const wantsTests = stageKey === "verify";
    const wantsVerdict = stageKey === "judge";
    const fields = [];
    if (wantsCode) fields.push('"code": "..."');
    if (wantsFixes) fields.push('"fixes": []');
    if (wantsTests) fields.push('"tests": []');
    if (wantsVerdict) fields.push('"verdict": "PASS"');
    const schema = fields.length > 0 ? "{ " + fields.join(", ") + " }" : "{}";
    return "Return JSON of this exact shape: " + schema;
  };

  const stageKeys = onlyStage ? [onlyStage] : wf.skillStageIds.slice();
  let anyHardFail = false;

  process.stdout.write(heading("Skill check (workflow " + workflowName
    + (onlyStage ? ", stage " + onlyStage : ", all stages") + ")") + "\n");

  for (const stageKey of stageKeys) {
    const result = await checkSkillsForStage({
      workflow: workflowName,
      stageKey: stageKey,
      cwd: process.cwd(),
      config: config,
      corePrompt: STUB_CORE(stageKey),
      policyOverride: args["warn-skills"] ? "warn" : null,
    });

    const hasSkills = result.skills.length > 0;
    if (!hasSkills && !onlyStage) continue;     // skip silent stages in "all" mode
    process.stdout.write("\n" + c.bold(stageKey) + c.dim("  " + result.skills.length + " skill(s)") + "\n");

    if (!hasSkills) {
      process.stdout.write(c.dim("  (no skills)") + "\n");
      continue;
    }
    for (const s of result.skills) {
      process.stdout.write("  " + ICON.info() + "  " + s.id
        + c.dim(" (" + s.scope + ", priority=" + s.priority + ", mode=" + s.mode + ")") + "\n");
    }
    for (const lw of (result.loaderWarnings || [])) {
      process.stdout.write("  " + ICON.warn() + "  loader: " + prettyPath(lw.path) + " — " + lw.message + "\n");
    }
    for (const w of result.warnings) {
      process.stdout.write("  " + ICON.warn() + "  [" + (w.invariantId || "config") + "] " + w.label + "\n");
      if (w.remedy) process.stdout.write("       " + c.dim("→ " + w.remedy) + "\n");
    }
    for (const f of result.hardFails) {
      anyHardFail = true;
      process.stdout.write("  " + ICON.fail() + "  [" + f.invariantId + "] " + c.red(f.label) + "\n");
      if (f.remedy) process.stdout.write("       " + c.dim("→ " + f.remedy) + "\n");
    }
    if (result.hardFails.length === 0 && result.warnings.length === 0) {
      process.stdout.write("  " + ICON.ok() + c.green("  no contradictions") + "\n");
    }
  }
  process.stdout.write("\n");
  if (anyHardFail) {
    process.stdout.write(c.red("✗") + " hard-fail contradictions present — runs would halt at affected stages\n");
    process.stdout.write(c.dim("  loosen with: ") + "rtlforge config set skillContradictionPolicy warn\n");
    process.stdout.write(c.dim("  or per-skill: add `overrides_invariants: [<id>]` to frontmatter\n"));
    return 1;
  }
  process.stdout.write(c.green("✓") + " all skills compatible with current invariants\n");
  return 0;
}

// ── new ─────────────────────────────────────────────────────────────────────
async function cmdNew(args, config) {
  const workflowName = args.workflow || config.workflow || DEFAULT_WORKFLOW;
  const stageKey = args._[1];
  if (!stageKey) {
    process.stderr.write(c.red("error:") + " usage: rtlforge skills new <stage> [--scope user|project]\n");
    return 2;
  }
  const wf = getWorkflow(workflowName);
  if (wf.skillStageIds.indexOf(stageKey) < 0) {
    process.stderr.write(c.red("error:") + " stage '" + stageKey + "' is not skill-eligible in workflow '" + workflowName + "'\n");
    process.stderr.write(c.dim("  known stages: ") + wf.skillStageIds.join(", ") + "\n");
    return 2;
  }
  const scope = (args.scope || "user").toLowerCase();
  if (scope !== "user" && scope !== "project") {
    process.stderr.write(c.red("error:") + " --scope must be 'user' or 'project' (got '" + scope + "')\n");
    return 2;
  }
  const dir = scope === "user"
    ? loaderInternal.userSkillDir(workflowName)
    : loaderInternal.projectSkillDir(process.cwd(), workflowName);
  const filename = stageKey + ".md";
  const filePath = path.join(dir, filename);

  if (fs.existsSync(filePath) && !args.force) {
    process.stderr.write(c.red("error:") + " " + filePath + " already exists. use --force to overwrite\n");
    return 1;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const stub = stubSkillFor(stageKey, workflowName, scope);
  fs.writeFileSync(filePath, stub, { mode: 0o644 });
  process.stdout.write(c.green("✓") + " created " + filePath + "\n");
  process.stdout.write(c.dim("  edit with: ") + "$EDITOR " + filePath + "\n");
  process.stdout.write(c.dim("  validate:  ") + "rtlforge skills check " + stageKey + "\n");
  return 0;
}

function stubSkillFor(stageKey, workflowName, scope) {
  // Provide a starter that won't trip invariants — appends guidance only.
  // NB: keep all `#` lines at column 0 — the frontmatter parser rejects
  // inline `#` comments to avoid `key: # comment` ambiguity.
  return [
    "---",
    "applies_to: [" + stageKey + "]",
    "priority: 50",
    "mode: append",
    "# Optional: declare which invariants this skill intentionally overrides.",
    "# Example: overrides_invariants: [json_output_required]",
    "---",
    "# " + stageKey + " skill (" + scope + " scope, workflow " + workflowName + ")",
    "",
    "Add your additional guidance for the " + stageKey + " stage below.",
    "This text is appended to the core prompt the LLM sees.",
    "",
    "Examples:",
    "- \"Always prefer always_ff for sequential logic.\"",
    "- \"Use 4-space indentation for SystemVerilog code.\"",
    "- \"Include an `// AUTHOR:` comment at the top of every module.\"",
    "",
    "Run `rtlforge skills check " + stageKey + "` after editing to validate.",
    "",
  ].join("\n");
}

// ── path ────────────────────────────────────────────────────────────────────
async function cmdPath(args, config) {
  const workflowName = args.workflow || config.workflow || DEFAULT_WORKFLOW;
  const userDir    = loaderInternal.userSkillDir(workflowName);
  const projectDir = loaderInternal.projectSkillDir(process.cwd(), workflowName);
  process.stdout.write(c.bold("user-global: ") + userDir + (fs.existsSync(userDir) ? "" : c.dim("  (not yet created)")) + "\n");
  process.stdout.write(c.bold("project:     ") + projectDir + (fs.existsSync(projectDir) ? "" : c.dim("  (not yet created)")) + "\n");
  return 0;
}

// ── invariants ──────────────────────────────────────────────────────────────
async function cmdInvariants(args /*, config */) {
  const onlyStage = args.stage || null;
  const all = onlyStage ? invariantsForStage(onlyStage) : listAllInvariants();
  process.stdout.write(heading("Skill invariants"
    + (onlyStage ? " for stage " + onlyStage : " (" + all.length + " total)")) + "\n");
  for (const inv of all) {
    const sev = inv.severity === "structural" ? c.red("structural") : c.yellow("semantic");
    process.stdout.write("\n" + c.bold(inv.id) + "  " + sev + "\n");
    process.stdout.write("  " + inv.label + "\n");
    process.stdout.write(c.dim("  applies to: ") + inv.stageKeys.join(", ") + "\n");
    if (inv.remedy) process.stdout.write(c.dim("  remedy:     ") + inv.remedy + "\n");
  }
  return 0;
}

// ── workflows ───────────────────────────────────────────────────────────────
async function cmdWorkflows() {
  const list = listWorkflows();
  process.stdout.write(heading("Registered workflows") + "\n");
  process.stdout.write(table([
    { key: "name",  label: "Name" },
    { key: "label", label: "Description" },
  ], list) + "\n");
  return 0;
}

function prettyPath(p) {
  const home = process.env.RTLFORGE_HOME || process.env.HOME || "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith("..") ? p : rel;
}

// ── dispatcher ──────────────────────────────────────────────────────────────
export async function cmdSkills(args) {
  const sub = args._[0] || "list";
  const config = loadConfig({ flags: args });

  if (sub === "list")        return cmdList(args, config);
  if (sub === "show")        return cmdShow(args, config);
  if (sub === "check")       return cmdCheck(args, config);
  if (sub === "new")         return cmdNew(args, config);
  if (sub === "path")        return cmdPath(args, config);
  if (sub === "invariants")  return cmdInvariants(args, config);
  if (sub === "workflows")   return cmdWorkflows(args, config);

  process.stderr.write(c.red("error:") + " unknown skills subcommand: " + sub + "\n");
  process.stderr.write(c.dim("  try: list, show, check, new, path, invariants, workflows") + "\n");
  return 2;
}
