// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// routingPresets — one-click per-stage model routing (roadmap #3)
//
// config.modelRouting (constants/providers.js getStageConfig) has existed for a
// while but defaults empty and had no ergonomic surface — every measured run
// paid strong-model latency for prose stages a small model handles. A preset is
// a FUNCTION of a "fast" identity over stage keys, not hardcoded models; the
// strong identity stays the global provider/model.
//
// Stage split rationale: elicit/spec/architect produce structured PROSE
// (requirements, plans) that small models handle well; everything that writes
// or fixes SystemVerilog — and the judge verdict, which gates shipping — stays
// on the strong global identity.
// ═══════════════════════════════════════════════════════════════════════════

export const ROUTING_PRESETS = {
  "fast-strong": {
    label: "Fast/strong split",
    description: "elicit + spec + architect on the fast identity; all code generation, fixes, and the judge stay on the global (strong) identity.",
    fastStages: ["elicit", "spec", "architect"],
  },
};

/**
 * Expand a preset into a config.modelRouting map.
 * @param {string} presetId          key of ROUTING_PRESETS
 * @param {{provider: string, model: string, baseUrl?: string, apiKey?: string}} fastIdentity
 * @returns {object|null} modelRouting map, or null for an unknown preset
 */
export function applyRoutingPreset(presetId, fastIdentity) {
  const preset = ROUTING_PRESETS[presetId];
  if (!preset || !fastIdentity || !fastIdentity.provider || !fastIdentity.model) return null;
  const identity = {};
  identity.provider = fastIdentity.provider;
  identity.model = fastIdentity.model;
  if (fastIdentity.baseUrl) identity.baseUrl = fastIdentity.baseUrl;
  if (fastIdentity.apiKey) identity.apiKey = fastIdentity.apiKey;
  const routing = {};
  for (const stage of preset.fastStages) routing[stage] = Object.assign({}, identity);
  return routing;
}

/**
 * Parse a CLI identity string "provider/model" (model may itself contain
 * slashes, e.g. lmstudio/liquid/lfm2-24b-a2b → provider "lmstudio", model
 * "liquid/lfm2-24b-a2b").
 */
export function parseIdentity(s) {
  const str = String(s || "");
  const i = str.indexOf("/");
  if (i <= 0 || i === str.length - 1) return null;
  return { provider: str.slice(0, i), model: str.slice(i + 1) };
}
