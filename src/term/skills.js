// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/skills — Bridge between the skill subsystem and the pipeline
//
// Single integration point. Pipeline nodes don't know skills exist; the
// orchestrator (runStage) calls applySkillOverlay(prompt, opts) before
// invoking callLLM, and the prompt comes back with skill overlays
// composed in.
//
// CONTINUOUS-DEVELOPMENT NOTE: this bridge is intentionally the ONLY
// place that knows about both skills and pipeline prompts. New stages,
// new prompt fields, new skill-application modes — they all hook in
// here and not into 12 individual pipeline nodes.
//
// SOURCES merged into the prompt overlay (in order of priority, low→high):
//   1. Loaded skill files from disk (~/.rtlforge/workflows/<wf>/skills/...)
//   2. config.promptOverrides[stageKey] from GUI prompt editor
//      (treated as one synthetic skill at user scope, priority=200,
//       mode=append by default — the GUI editor's "replace defaults"
//       path uses mode=replace under the hood)
//
// VALIDATION: invariants run against the COMPOSED userMessage (which is
// what the LLM sees). If validation fails per the user's policy:
//   - default policy "fail" → throw, halting the stage
//   - "warn" → console-warn and proceed
//   - "warn-semantic" → fail on structural, warn on semantic
//
// The thrown error has a structured `.contradictions` field so the GUI
// (or `rtlforge skills check`) can render a clear diff.
// ═══════════════════════════════════════════════════════════════════════════

// `loader.js` uses node:fs; we dynamic-import so this bridge can be
// pulled into a browser bundle without the fs import blowing up at
// build time. Browser callers pass `extraSkills` directly and skip
// the fs-loaded path by setting `useFsLoader: false`.
import { composeWithSkills } from "../skills/compose.js";
import { validateComposedPrompt, applyPolicy } from "../skills/validate.js";
import { getWorkflow, DEFAULT_WORKFLOW } from "../workflows/index.js";

let _loaderModule = null;
async function getFsLoader() {
  if (_loaderModule) return _loaderModule;
  try {
    _loaderModule = await import("../skills/loader.js");
    return _loaderModule;
  } catch (e) {
    // Browser without bundler shim — fs is not available; that's fine,
    // callers should set useFsLoader: false or pass extraSkills.
    return null;
  }
}

/**
 * Build a synthetic skill record for `config.promptOverrides[stageKey]`.
 * This is how GUI-edited prompt overrides flow through the same machinery
 * skills use. Returns null if no override exists.
 *
 * The GUI editor stores a list of section objects {title, content}; we
 * concatenate them with "## title\n content\n" headings to make the
 * skill body readable inside the LLM input.
 */
function syntheticSkillFromConfigOverrides(stageKey, config) {
  const all = (config && config.promptOverrides) || {};
  const sections = all[stageKey];
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const body = sections.map(function(sec) {
    const t = sec && sec.title ? "## " + sec.title : "## (untitled)";
    const c = sec && sec.content ? sec.content : "";
    return t + "\n" + c;
  }).join("\n\n");
  return {
    id: "config:promptOverrides:" + stageKey,
    stageKey: stageKey,
    scope: "config",
    path: "(GUI prompt overrides)",
    body: body,
    frontmatter: {},
    warnings: [],
    // Higher than skill-file defaults (50) but below explicit power-user
    // skill priorities (e.g. priority: 999). The GUI is "user intent
    // captured in a UI", which feels right above arbitrary file-defined
    // skills but below explicit overrides.
    priority: 200,
    // Prompt overrides APPEND by default, they do not REPLACE.
    //
    // Pre-fix the mode was "replace", which truncated the entire base
    // prompt (containing spec data, architecture, requirements,
    // synthesisability rules) and emitted only the user's edited
    // sections. The GUI editor's section stubs don't include the
    // structural context, so any user edit silently lobotomised the
    // LLM — "asked for a synchronous FIFO, got a register" because the
    // spec section vanished from the prompt.
    //
    // Append mode preserves the base prompt and adds the user's edits
    // as an overlay after it. Power users who really want to replace
    // the whole prompt can opt in via config.promptOverridesMode.
    mode: (config && config.promptOverridesMode === "replace") ? "replace" : "append",
    overrides: [],
    appliesTo: [stageKey],
  };
}

/**
 * Resolve the user's contradiction policy from config + flag.
 *
 * Resolution order:
 *   1. opts.policyOverride        (one-off CLI flag, e.g. --warn-skills)
 *   2. config.skillContradictionPolicy   (persisted setting)
 *   3. "fail"                     (built-in default per user's spec)
 */
function resolvePolicy(config, opts) {
  if (opts && opts.policyOverride) return opts.policyOverride;
  if (config && config.skillContradictionPolicy) return config.skillContradictionPolicy;
  return "fail";
}

/**
 * Apply skill + GUI-override overlays to a pipeline prompt object.
 *
 * @param {object} prompt        - prompt object returned from src/prompts/<stage>.js
 *                                 ({ systemPrompt, userMessage, ... })
 * @param {object} opts
 * @param {string} opts.stageKey
 * @param {string} [opts.workflow]   - workflow id (default: DEFAULT_WORKFLOW)
 * @param {object} opts.config       - effective config (carries promptOverrides + policy)
 * @param {string} [opts.cwd]        - project root for project-local skills
 * @param {string} [opts.policyOverride]  - one-off contradiction policy override
 * @param {function} [opts.onWarning]     - (msg) => void; defaults to console.warn
 * @returns {object} new prompt object with overlay applied + provenance
 *
 * The returned prompt has these EXTRA fields for caller introspection:
 *   _skillProvenance : compose result's provenance trail
 *   _skillReport     : validate result (contradictions, unknownOverrides)
 *   _skillsApplied   : array of skill ids actually applied
 *
 * Throws when policy says "fail" and a hard-fail contradiction is
 * detected. The error object carries `.contradictions` and `.code = "ESKILLFAIL"`.
 */
export async function applySkillOverlay(prompt, opts) {
  const o = opts || {};
  if (!o.stageKey) throw new Error("applySkillOverlay: stageKey required");
  if (!prompt || typeof prompt.userMessage !== "string") {
    // No userMessage → skill overlay is a no-op (some pipeline calls
    // pass raw strings; we only overlay structured prompts).
    return prompt;
  }

  const workflow = o.workflow || (o.config && o.config.workflow) || DEFAULT_WORKFLOW;
  const wf = getWorkflow(workflow);

  // Defense in depth: only stages the workflow declares as skill-eligible.
  // (Skill files for unknown stages would be silently ignored otherwise.)
  if (wf.skillStageIds.indexOf(o.stageKey) < 0) {
    return prompt;
  }

  // Load skills (fs path only when useFsLoader != false and the loader
  // module is reachable) + extraSkills (browser-passed) + synthetic GUI
  // override skill, then sort.
  let loaded = { skills: [], warnings: [] };
  if (o.useFsLoader !== false) {
    const loaderMod = await getFsLoader();
    if (loaderMod && loaderMod.loadSkillsForStage) {
      loaded = await loaderMod.loadSkillsForStage({
        workflow: workflow,
        stageKey: o.stageKey,
        cwd: o.cwd,
      });
    }
  }
  let skills = loaded.skills.slice();
  if (Array.isArray(o.extraSkills)) {
    // Filter extra skills the same way the loader does (by appliesTo)
    for (const s of o.extraSkills) {
      if (Array.isArray(s.appliesTo) && s.appliesTo.indexOf(o.stageKey) >= 0) {
        skills.push(s);
      }
    }
  }
  const syntheticGui = syntheticSkillFromConfigOverrides(o.stageKey, o.config);
  if (syntheticGui) skills.push(syntheticGui);

  // Re-sort: scope (user → config → project), priority asc, then path.
  // Note: "config" is its own scope so it ranks between user-disk skills
  // and project-local skills. Project skills still beat config (they're
  // checked into the project repo and represent intentional team policy).
  const SCOPE_ORDER = { user: 0, config: 1, project: 2 };
  skills.sort(function(a, b) {
    const sa = SCOPE_ORDER[a.scope] != null ? SCOPE_ORDER[a.scope] : 9;
    const sb = SCOPE_ORDER[b.scope] != null ? SCOPE_ORDER[b.scope] : 9;
    if (sa !== sb) return sa - sb;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.path.localeCompare(b.path);
  });

  // mode:replace winnowing — same logic as loader.js but applied across
  // user+config+project union. Highest priority replace wins.
  const replaces = skills.filter(function(s) { return s.mode === "replace"; });
  if (replaces.length > 0) {
    const winner = replaces.slice().sort(function(a, b) {
      if (a.priority !== b.priority) return b.priority - a.priority;
      // Project beats config beats user on tie
      const sa = SCOPE_ORDER[a.scope] != null ? SCOPE_ORDER[a.scope] : 9;
      const sb = SCOPE_ORDER[b.scope] != null ? SCOPE_ORDER[b.scope] : 9;
      return sb - sa;
    })[0];
    const ignored = skills.filter(function(s) {
      return s !== winner && (s.mode === "replace" || (s.mode !== "replace"));
    });
    skills = [winner];
    for (const s of ignored) {
      // Surface as warning so the user knows
      const msg = "skill " + s.id + " ignored: " + winner.id + " is in mode=replace";
      if (typeof o.onWarning === "function") o.onWarning(msg);
    }
  }

  // No overlays at all → return prompt untouched (avoid header noise)
  if (skills.length === 0) {
    // Still emit any loader warnings the user should see
    for (const w of (loaded.warnings || [])) {
      const msg = "skill loader warning at " + w.path + ": " + w.message;
      if (typeof o.onWarning === "function") o.onWarning(msg);
    }
    return prompt;
  }

  // Compose
  const composed = composeWithSkills(prompt.userMessage, skills, {
    stageLabel: o.stageKey,
  });

  // Validate
  const report = validateComposedPrompt({
    stageKey: o.stageKey,
    composedText: composed.text,
    skills: skills,
  });
  const policy = resolvePolicy(o.config, o);
  const split = applyPolicy(report, policy);

  // Surface warnings
  for (const w of split.warnings) {
    const msg = "skill warning [" + (w.invariantId || "?") + "] " + w.label
      + (w.overriddenBy ? " (overridden by " + w.overriddenBy + ")" : "")
      + (w.remedy ? " — " + w.remedy : "");
    if (typeof o.onWarning === "function") o.onWarning(msg);
    else console.warn(msg);
  }
  for (const w of (loaded.warnings || [])) {
    const msg = "skill loader warning at " + w.path + ": " + w.message;
    if (typeof o.onWarning === "function") o.onWarning(msg);
  }

  // Hard fail policy
  if (split.hardFails.length > 0) {
    const lines = split.hardFails.map(function(f) {
      return "  • [" + f.invariantId + "] " + f.label + (f.remedy ? "\n      remedy: " + f.remedy : "");
    });
    const e = new Error(
      "Skill overlay would break " + split.hardFails.length +
      " structural invariant(s) for stage '" + o.stageKey + "':\n" +
      lines.join("\n") +
      "\n\nResolutions:\n" +
      "  • fix the skill so it preserves the invariant, OR\n" +
      "  • add `overrides_invariants: [<id>]` to the skill's frontmatter, OR\n" +
      "  • set config.skillContradictionPolicy = 'warn' (loosens globally), OR\n" +
      "  • use --warn-skills for a one-off run"
    );
    e.code = "ESKILLFAIL";
    e.contradictions = split.hardFails;
    e.warnings = split.warnings;
    e.skillsApplied = skills.map(function(s) { return s.id; });
    throw e;
  }

  // Apply the composed text as the new userMessage. Provenance + report
  // ride along on the prompt so callers (UI, log) can show them.
  const out = Object.assign({}, prompt, {
    userMessage: composed.text,
    _skillProvenance: composed.provenance,
    _skillReport: report,
    _skillsApplied: skills.map(function(s) { return s.id; }),
    _skillsReplaced: composed.replaced,
  });
  return out;
}

/**
 * Read-only summary for `rtlforge skills check` — same skill loading
 * and validation pipeline, but produces a structured report instead of
 * mutating a prompt.
 */
export async function checkSkillsForStage(opts) {
  const o = opts || {};
  const workflow = o.workflow || DEFAULT_WORKFLOW;
  const stageKey = o.stageKey;
  const corePrompt = typeof o.corePrompt === "string" ? o.corePrompt : "";

  let loaded = { skills: [], warnings: [] };
  if (o.useFsLoader !== false) {
    const loaderMod = await getFsLoader();
    if (loaderMod && loaderMod.loadSkillsForStage) {
      loaded = await loaderMod.loadSkillsForStage({
        workflow: workflow, stageKey: stageKey, cwd: o.cwd,
      });
    }
  }
  let skills = loaded.skills.slice();
  if (Array.isArray(o.extraSkills)) {
    for (const s of o.extraSkills) {
      if (Array.isArray(s.appliesTo) && s.appliesTo.indexOf(stageKey) >= 0) {
        skills.push(s);
      }
    }
  }
  const syntheticGui = syntheticSkillFromConfigOverrides(stageKey, o.config);
  if (syntheticGui) skills.push(syntheticGui);

  const composed = composeWithSkills(corePrompt, skills, { stageLabel: stageKey });
  const report = validateComposedPrompt({
    stageKey: stageKey, composedText: composed.text, skills: skills,
  });
  const split = applyPolicy(report, resolvePolicy(o.config, o));

  return {
    workflow: workflow,
    stageKey: stageKey,
    skills: skills,                              // ordered, with all metadata
    composedText: composed.text,
    provenance: composed.provenance,
    contradictions: report.contradictions,
    unknownOverrides: report.unknownOverrides,
    hardFails: split.hardFails,
    warnings: split.warnings,
    loaderWarnings: loaded.warnings,
    replaced: composed.replaced,
  };
}

// Test seam — exposes internals without forcing them into the public API
export const _internal = {
  syntheticSkillFromConfigOverrides,
  resolvePolicy,
};

/**
 * Build a `skillBridge` object suitable for passing as `services.skillBridge`
 * to runStage. The bridge captures workflow + config + cwd + policy once
 * and exposes a single `apply(prompt, stageKey)` method that pipeline
 * nodes call via the `applySkillsToPrompt` helper.
 *
 * Pass this from store.runStage so every pipeline node automatically gets
 * skill overlays without each node having to know about workflows or fs paths.
 *
 * @param {object} opts
 * @param {object} opts.config         - effective config object
 * @param {string} [opts.workflow]     - workflow id (default: from config)
 * @param {string} [opts.cwd]          - project root (for project-local skills)
 * @param {string} [opts.policyOverride] - one-off policy override
 * @param {function} [opts.onWarning]  - (msg) => void
 * @returns {{ apply: (prompt, stageKey) => Promise<object> }}
 */
/**
 * Build a `skillBridge` object suitable for passing as `services.skillBridge`
 * to runStage. The bridge captures workflow + config + cwd + policy once
 * and exposes a single `applyOverlay(prompt, stageKey)` method that
 * pipeline nodes call via the `applySkillsToPrompt` helper.
 *
 * Pass this from store.runStage so every pipeline node automatically gets
 * skill overlays without each node having to know about workflows or fs paths.
 *
 * @param {object} opts
 * @param {object} opts.config         - effective config object
 * @param {string} [opts.workflow]     - workflow id (default: from config)
 * @param {string} [opts.cwd]          - project root (for project-local skills)
 * @param {string} [opts.policyOverride] - one-off policy override
 * @param {function} [opts.onWarning]  - (msg) => void
 * @param {boolean} [opts.useFsLoader] - default true; set false in browser
 * @param {function} [opts.skillsSource] - (workflow, stageKey) => Array<skill>
 *                                          callable that returns extra skills
 *                                          from a non-fs source (e.g. localStorage).
 *                                          Each returned skill must have the same
 *                                          shape the fs loader produces.
 * @returns {{ applyOverlay: (prompt, stageKey) => Promise<object> }}
 */
export function createSkillBridge(opts) {
  const o = opts || {};
  return {
    // Pipeline nodes call this via applySkillsToPrompt(p, st, stageKey).
    // The name matches what nodes already expect; keep it stable.
    applyOverlay: async function(prompt, stageKey) {
      let extraSkills = [];
      if (typeof o.skillsSource === "function") {
        try {
          const source = o.skillsSource((o.workflow || DEFAULT_WORKFLOW), stageKey);
          if (Array.isArray(source)) extraSkills = source;
          else if (source && typeof source.then === "function") {
            const resolved = await source;
            if (Array.isArray(resolved)) extraSkills = resolved;
          }
        } catch (_e) { /* surface via onWarning if needed */ }
      }
      return applySkillOverlay(prompt, {
        stageKey: stageKey,
        workflow: o.workflow,
        config:   o.config,
        cwd:      o.cwd,
        policyOverride: o.policyOverride,
        onWarning: o.onWarning,
        useFsLoader: o.useFsLoader !== false,
        extraSkills: extraSkills,
      });
    },
  };
}
