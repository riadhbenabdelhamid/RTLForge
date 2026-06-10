// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// skills/loader — Discover and parse skill markdown files
//
// Resolution order (lowest priority first; later loads OVERRIDE earlier
// when frontmatter `mode: replace` is set, otherwise they ACCUMULATE):
//
//   1. user-global    : ~/.rtlforge/workflows/<workflow>/skills/<stage>.md
//   2. user-global    : ~/.rtlforge/workflows/<workflow>/skills/<stage>/*.md
//   3. project-local  : <cwd>/.rtlforge/workflows/<workflow>/skills/<stage>.md
//   4. project-local  : <cwd>/.rtlforge/workflows/<workflow>/skills/<stage>/*.md
//
// (1) and (3) are the simple "one skill per stage" case. (2) and (4) let
// power users break a stage's skill into multiple files, ordered by
// filename. Each file gets its own frontmatter + body and shows up as a
// distinct skill in the composed prompt's provenance trail.
//
// Each loaded skill is normalized into:
//
//   {
//     id            : stable id derived from path (relative to skills/)
//     stageKey      : the stage key this skill applies to
//     scope         : "user" | "project"
//     path          : absolute file path
//     frontmatter   : parsed frontmatter object
//     body          : markdown body (trimmed)
//     warnings      : non-fatal frontmatter issues
//     priority      : effective priority (frontmatter.priority || 50)
//     mode          : "append" (default) | "prepend" | "replace"
//     overrides     : array of invariant ids the skill explicitly overrides
//     appliesTo     : array of stage keys (frontmatter.applies_to || [stageKey])
//   }
//
// The ORDER of the returned array is "low priority first" — when composed,
// `mode: append` skills concatenate in this order, so a high-priority
// skill ends up later in the prompt (closer to the user's request,
// generally given more weight by LLMs).
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseFrontmatter } from "./frontmatter.js";

const VALID_MODES = new Set(["append", "prepend", "replace"]);

/**
 * Resolve the user-global home dir, honouring $RTLFORGE_HOME for tests.
 */
function rtlforgeHome() {
  return process.env.RTLFORGE_HOME || path.join(os.homedir(), ".rtlforge");
}

/**
 * Resolve project-local skill dir for `cwd`.
 */
function projectSkillDir(cwd, workflow) {
  return path.join(cwd || process.cwd(), ".rtlforge", "workflows", workflow, "skills");
}

function userSkillDir(workflow) {
  return path.join(rtlforgeHome(), "workflows", workflow, "skills");
}

/**
 * Validate a parsed frontmatter against the skill schema. Returns the
 * normalized skill metadata. Throws on hard violations (bad mode, bad
 * priority type) — those are configuration errors the user should fix.
 */
function normalizeFrontmatter(fm, defaultStageKey, filePath) {
  const md = fm.data || {};

  // priority: number, default 50
  let priority = 50;
  if (md.priority != null) {
    if (typeof md.priority !== "number" || !Number.isFinite(md.priority)) {
      throw skillError(filePath, "frontmatter `priority` must be a number");
    }
    priority = md.priority;
  }

  // mode: enum, default "append"
  let mode = "append";
  if (md.mode != null) {
    if (typeof md.mode !== "string" || !VALID_MODES.has(md.mode)) {
      throw skillError(filePath,
        "frontmatter `mode` must be one of " + Array.from(VALID_MODES).join(", ") +
        " (got '" + md.mode + "')");
    }
    mode = md.mode;
  }

  // applies_to: list of stage keys, default [defaultStageKey]
  let appliesTo;
  if (md.applies_to != null) {
    if (!Array.isArray(md.applies_to)) {
      throw skillError(filePath, "frontmatter `applies_to` must be a list");
    }
    if (md.applies_to.length === 0) {
      throw skillError(filePath, "frontmatter `applies_to` is empty — at least one stage key required");
    }
    for (const s of md.applies_to) {
      if (typeof s !== "string" || s === "") {
        throw skillError(filePath, "frontmatter `applies_to` items must be non-empty strings");
      }
    }
    appliesTo = md.applies_to.slice();
  } else {
    appliesTo = [defaultStageKey];
  }

  // overrides_invariants: list of invariant ids, default []
  let overrides = [];
  if (md.overrides_invariants != null) {
    if (!Array.isArray(md.overrides_invariants)) {
      throw skillError(filePath, "frontmatter `overrides_invariants` must be a list");
    }
    for (const s of md.overrides_invariants) {
      if (typeof s !== "string") {
        throw skillError(filePath, "frontmatter `overrides_invariants` items must be strings");
      }
    }
    overrides = md.overrides_invariants.slice();
  }

  return { priority, mode, appliesTo, overrides };
}

/**
 * Parse a single skill file at `filePath` for stage `stageKey`. Returns
 * the normalized skill record.
 */
export function loadSkillFile(filePath, stageKey, scope) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  const meta = normalizeFrontmatter(parsed, stageKey, filePath);
  const id = stableSkillId(filePath, scope);
  return {
    id: id,
    stageKey: stageKey,
    scope: scope,
    path: filePath,
    frontmatter: parsed.data,
    body: parsed.body.trim(),
    warnings: parsed.warnings,
    priority: meta.priority,
    mode: meta.mode,
    overrides: meta.overrides,
    appliesTo: meta.appliesTo,
  };
}

function stableSkillId(filePath, scope) {
  // Use scope:basename(no-ext) so two scopes with same filename don't collide
  // and the id stays human-readable in error messages.
  const base = path.basename(filePath).replace(/\.md$/i, "");
  return scope + ":" + base;
}

/**
 * Walk a skills directory and return every .md file found, with the
 * stage key inferred from path (filename or parent dir). The
 * inferred-from-path stage key is the *default* for `applies_to` when
 * the skill's frontmatter doesn't declare one explicitly. Skills that
 * declare `applies_to` override this default.
 *
 * Returns: [{ path, defaultStageKey }, ...]
 */
function walkAllSkillFiles(skillsDir) {
  const out = [];
  if (!fs.existsSync(skillsDir)) return out;
  const top = fs.readdirSync(skillsDir).sort();
  for (const e of top) {
    if (e.startsWith(".")) continue;
    const full = path.join(skillsDir, e);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isFile() && e.endsWith(".md")) {
      out.push({ path: full, defaultStageKey: e.replace(/\.md$/i, "") });
    } else if (st.isDirectory()) {
      const stageKey = e;
      const sub = fs.readdirSync(full).sort();
      for (const s of sub) {
        if (s.startsWith(".") || !s.endsWith(".md")) continue;
        const fp = path.join(full, s);
        if (fs.statSync(fp).isFile()) {
          out.push({ path: fp, defaultStageKey: stageKey });
        }
      }
    }
  }
  return out;
}

/**
 * Load all skills targeting `stageKey` for `workflow`, walking both user
 * and project scopes.
 *
 * @param {object} opts
 * @param {string} opts.workflow   - workflow id (e.g. "rtl")
 * @param {string} opts.stageKey   - stage key (e.g. "rtl_generate", "agent")
 * @param {string} [opts.cwd]      - project root (default process.cwd())
 * @param {boolean} [opts.includeUser]    - default true
 * @param {boolean} [opts.includeProject] - default true
 * @returns {{skills: Array, warnings: Array}}
 *
 * Skills are returned ordered by:
 *   1. scope (user before project — project takes precedence)
 *   2. priority ascending (low priority first; high last)
 *   3. filename alphabetical (deterministic tiebreak)
 *
 * After all loads, if any skill has `mode: replace`, only the highest-
 * priority replace skill is returned (others are dropped with a warning).
 *
 * The caller is responsible for filtering by `appliesTo` — this loader
 * returns every skill that DECLARES it applies to `stageKey` (via
 * frontmatter or by being filed under that stage's directory).
 */
export function loadSkillsForStage(opts) {
  const o = opts || {};
  if (!o.workflow) throw new Error("loadSkillsForStage: workflow required");
  if (!o.stageKey) throw new Error("loadSkillsForStage: stageKey required");

  const includeUser    = o.includeUser    !== false;
  const includeProject = o.includeProject !== false;

  const all = [];
  const warnings = [];

  function loadFromDir(dir, scope) {
    const entries = walkAllSkillFiles(dir);
    for (const { path: fp, defaultStageKey } of entries) {
      try {
        // The default appliesTo is whatever the path infers (filename or
        // parent dir). Frontmatter `applies_to` overrides this default.
        all.push(loadSkillFile(fp, defaultStageKey, scope));
      } catch (e) {
        warnings.push({ path: fp, message: e.message });
      }
    }
  }

  if (includeUser)    loadFromDir(userSkillDir(o.workflow),               "user");
  if (includeProject) loadFromDir(projectSkillDir(o.cwd, o.workflow),     "project");

  // Filter to skills that actually apply to this stage. A skill from the
  // <stage>.md path has `appliesTo: [stageKey]` by default, but a skill
  // can declare `applies_to: [rtl_generate, rtl_review]` to overlay onto
  // multiple stages.
  const applicable = all.filter(function(s) {
    return s.appliesTo.indexOf(o.stageKey) >= 0;
  });

  // Sort by (scope: user before project) → (priority asc) → (filename asc)
  applicable.sort(function(a, b) {
    if (a.scope !== b.scope) return a.scope === "user" ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.path.localeCompare(b.path);
  });

  // Handle mode:replace — keep only the highest-priority replace skill if
  // any are present. Replace beats append/prepend, period.
  const replaces = applicable.filter(function(s) { return s.mode === "replace"; });
  let kept = applicable;
  if (replaces.length > 0) {
    // Highest priority wins; ties broken by scope (project) then filename.
    replaces.sort(function(a, b) {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    const winner = replaces[0];
    for (const r of replaces) {
      if (r !== winner) {
        warnings.push({
          path: r.path,
          message: "skill ignored: another `mode: replace` skill (" + winner.id + ") has higher priority",
        });
      }
    }
    // The winning replace skill stands alone; append/prepend skills are
    // dropped in replace mode.
    kept = [winner];
    for (const s of applicable) {
      if (s.mode !== "replace" && !replaces.includes(s)) {
        warnings.push({
          path: s.path,
          message: "skill ignored: a `mode: replace` skill (" + winner.id + ") is active for this stage",
        });
      }
    }
  }

  // Surface frontmatter warnings collected during parsing
  for (const s of kept) {
    for (const w of (s.warnings || [])) {
      warnings.push({ path: s.path, message: "frontmatter line " + w.line + ": " + w.message });
    }
  }

  return { skills: kept, warnings: warnings };
}

function skillError(filePath, message) {
  const e = new Error("skill at " + filePath + ": " + message);
  e.code = "ESKILL";
  e.path = filePath;
  return e;
}

export const _internal = { rtlforgeHome, userSkillDir, projectSkillDir, normalizeFrontmatter };
