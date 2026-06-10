// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// skills/browserBridge — Browser-safe skill bridge for the React GUI
//
// The full bridge in src/term/skills.js calls into src/skills/loader.js
// which uses node:fs. That works in the CLI but blows up in a browser
// build. This bridge:
//
//   - Skips file-system skill loading (no fs available)
//   - Still applies config.promptOverrides via the same synthetic-skill
//     path, so the GUI's prompt-section editor flows through to the LLM
//   - Runs the same compose + validate + policy pipeline as the CLI bridge
//
// Future: a browser-friendly storage adapter (IndexedDB) could let skill
// markdown files be authored in-browser too. For now the GUI authors
// skills via the existing prompt editor, which writes to
// config.promptOverrides — already working end-to-end after this slice.
// ═══════════════════════════════════════════════════════════════════════════

import { composeWithSkills } from "./compose.js";
import { validateComposedPrompt, applyPolicy } from "./validate.js";

/**
 * Build the same synthetic skill as src/term/skills.js but in a module
 * that doesn't import `node:fs` (so it's browser-safe).
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
    priority: 200,
    // Prompt overrides APPEND rather than REPLACE.
    //
    // A "replace" mode would truncate the entire base prompt (architecture,
    // spec data, requirements, synthesisability
    // rules) and emitted ONLY the user's edited sections. The GUI
    // editor's "default" sections are short stubs that don't include
    // the spec/arch context, so users editing one section accidentally
    // lobotomised the LLM — e.g. "asked for a synchronous FIFO; got
    // a register" because the spec section was missing entirely.
    //
    // Append mode preserves the base prompt and adds the user's edits
    // as a clearly-marked overlay after it. The user's instructions
    // appear in the same context window AFTER all the structural
    // information, so they read as "additionally, follow these rules."
    //
    // For "I really want to replace the whole prompt" power-users,
    // they can set `config.promptOverridesMode = "replace"` explicitly.
    mode: (config && config.promptOverridesMode === "replace") ? "replace" : "append",
    overrides: [],
    appliesTo: [stageKey],
  };
}

/**
 * Build a skill bridge for use in the React app's services object.
 *
 * @param {object} opts
 * @param {object} opts.config              - effective config (carries promptOverrides + policy)
 * @param {function} [opts.onWarning]       - (msg) => void
 * @returns {{applyOverlay: function}} bridge object
 */
export function createBrowserSkillBridge(opts) {
  const o = opts || {};
  return {
    applyOverlay: async function(prompt, stageKey) {
      if (!prompt || typeof prompt.userMessage !== "string") return prompt;
      const config = o.config || {};
      const synthetic = syntheticSkillFromConfigOverrides(stageKey, config);
      if (!synthetic) return prompt;

      const composed = composeWithSkills(prompt.userMessage, [synthetic], {
        stageLabel: stageKey,
      });
      const report = validateComposedPrompt({
        stageKey: stageKey,
        composedText: composed.text,
        skills: [synthetic],
      });
      const policy = config.skillContradictionPolicy || "fail";
      const split = applyPolicy(report, policy);

      // Surface warnings. Hard fails throw with structured payload so the
      // GUI can render them just like the CLI bridge.
      for (const w of split.warnings) {
        const msg = "skill warning [" + (w.invariantId || "?") + "] " + w.label;
        if (typeof o.onWarning === "function") o.onWarning(msg);
        else if (typeof console !== "undefined") console.warn("[skill] " + msg);
      }
      if (split.hardFails.length > 0) {
        const lines = split.hardFails.map(function(f) {
          return "  • [" + f.invariantId + "] " + f.label;
        });
        const e = new Error(
          "Skill overlay would break " + split.hardFails.length +
          " structural invariant(s) for stage '" + stageKey + "':\n" + lines.join("\n")
        );
        e.code = "ESKILLFAIL";
        e.contradictions = split.hardFails;
        e.warnings = split.warnings;
        throw e;
      }

      return Object.assign({}, prompt, {
        userMessage: composed.text,
        _skillProvenance: composed.provenance,
        _skillReport: report,
        _skillsApplied: [synthetic.id],
        _skillsReplaced: composed.replaced,
      });
    },
  };
}
