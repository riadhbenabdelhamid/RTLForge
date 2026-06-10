// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// pipeline/applySkillsToPrompt — Per-node helper to apply skill overlays
//
// Pipeline nodes call this right before callLLM:
//
//   const p = promptRTL(...);
//   const finalP = await applySkillsToPrompt(p, st, "rtl_generate");
//   const r = await callLLM(finalP);
//
// The helper looks at `st._skillBridge` (set by runStage when skills are
// configured for this run) and, if present, calls into the bridge to get
// a composed prompt back. If `_skillBridge` is absent (e.g. tests that
// stub out the orchestrator), the prompt is returned unchanged.
//
// Nodes opt IN by calling this helper; nodes that don't call it simply don't
// get skill overlay support (a safe, additive policy). Tests that exercise nodes
// directly without running through runStage continue to work unchanged.
//
// Failure handling: if the bridge throws ESKILLFAIL (a hard contradiction),
// the throw propagates out of the node naturally and lands in runStage's
// try/catch, which dispatches MODULE_STAGE_ERROR_SET with the error
// message — same path as any other stage error.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply skill overlay to a prompt object using the bridge available on
 * accState. Returns the (possibly-modified) prompt.
 *
 * @param {object} prompt    - prompt object from src/prompts/<stage>.js
 *                             ({ systemPrompt, userMessage, ... })
 * @param {object} st        - the accState passed to the pipeline node
 * @param {string} stageKey  - canonical stage key ("rtl_generate", etc.)
 * @returns {object} prompt with overlay applied (or unchanged if no bridge)
 */
export async function applySkillsToPrompt(prompt, st, stageKey) {
  const bridge = st && st._skillBridge;
  if (!bridge || typeof bridge.applyOverlay !== "function") {
    // No bridge wired — happens in unit tests that exercise nodes
    // directly. Return prompt unchanged so tests don't need to
    // know skills exist.
    return prompt;
  }
  // Emit a skill event when an overlay is applied. The bridge may modify the
  // prompt in place or return a new object, so we compare lengths to detect
  // whether anything changed; if the bridge exposes a list-skills method we
  // record which skills fired.
  const before = (prompt && prompt.systemPrompt ? prompt.systemPrompt.length : 0)
              + (prompt && prompt.userMessage  ? prompt.userMessage.length  : 0);
  const result = await bridge.applyOverlay(prompt, stageKey);
  const after = (result && result.systemPrompt ? result.systemPrompt.length : 0)
             + (result && result.userMessage  ? result.userMessage.length  : 0);
  if (st && st._logger && after !== before) {
    // Try to extract which skills fired from the bridge for richer logging
    let skillIds = [];
    try {
      if (typeof bridge.listAppliedSkills === "function") {
        skillIds = bridge.listAppliedSkills(stageKey) || [];
      }
    } catch (_) { /* best-effort */ }
    st._logger.skill({
      stageKey: stageKey,
      skillIds: skillIds,
      skillId:  skillIds[0] || "(unknown)",
      mode:     "append",
      deltaLen: after - before,
    });
  }
  return result;
}
