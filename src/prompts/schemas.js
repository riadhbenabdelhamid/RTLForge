// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/schemas — JSON schemas for structured outputs (roadmap #1)
//
// Passed as `jsonSchema` on the prompt args; callLLM threads them to the
// provider builders (OpenAI-compat response_format json_schema, Ollama format;
// Anthropic no-op). Grammar-constrained decoding makes malformed/truncated
// JSON impossible at the decoder — the measured top time sink (escalation
// ladders + extractJSON re-asks) on local models.
//
// Design choices:
// - `strict: false` for maximum server compatibility — llama.cpp constrains
//   from the schema regardless; OpenAI strict-mode has extra requirements
//   (all-required + additionalProperties:false) that would 400 on optional
//   fields, and the callLLM 400-fallback would then waste a round-trip.
// - `additionalProperties: true` explicitly — some grammar implementations
//   treat absence as `false`, which would forbid harmless extra keys the
//   prompts invite (explanations, notes). Balanced-JSON + required `code`
//   is the guarantee we need; extra keys are noise extractJSON already skips.
// ═══════════════════════════════════════════════════════════════════════════

/** Cold RTL/TB generation: { code } (+ free extras). */
export const CODE_SCHEMA = {
  name: "sv_code",
  strict: false,
  schema: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
    additionalProperties: true,
  },
};

/** Fix-loop responses: { code, fixes: [{id, desc}] } (+ free extras). */
export const FIX_SCHEMA = {
  name: "sv_fix",
  strict: false,
  schema: {
    type: "object",
    properties: {
      code:  { type: "string" },
      fixes: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, desc: { type: "string" } },
          additionalProperties: true,
        },
      },
    },
    required: ["code"],
    additionalProperties: true,
  },
};

/** System decomposition (SoC S7): modules + instances + topModule. Field
 *  types are constrained where a malformed value would poison the run
 *  (ids, the instance wiring keys); everything else stays open. */
export const DECOMP_SCHEMA = {
  name: "system_decomposition",
  strict: false,
  schema: {
    type: "object",
    properties: {
      type:        { type: "string" },
      systemName:  { type: "string" },
      description: { type: "string" },
      topModule:   { type: "string" },
      modules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            modId:       { type: "string" },
            name:        { type: "string" },
            description: { type: "string" },
            level:       { type: "number" },
          },
          required: ["modId"],
          additionalProperties: true,
        },
      },
      instances: {
        type: "array",
        items: {
          type: "object",
          properties: {
            instId:         { type: "string" },
            moduleId:       { type: "string" },
            parentModuleId: { type: "string" },
            instanceName:   { type: "string" },
          },
          required: ["instId", "moduleId", "parentModuleId", "instanceName"],
          additionalProperties: true,
        },
      },
    },
    // topModule + instances are required: the CLI decompose forces multi-
    // module, and a weak model omits exactly these when left optional
    // (measured on lfm2-24b — "top: undefined", zero placements).
    required: ["type", "modules", "instances", "topModule"],
    additionalProperties: true,
  },
};

/** Patch-mode fix responses (roadmap #2): { edits: [{find, replace}], fixes[] }. */
export const PATCH_SCHEMA = {
  name: "sv_patch",
  strict: false,
  schema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: { find: { type: "string" }, replace: { type: "string" } },
          required: ["find", "replace"],
          additionalProperties: true,
        },
      },
      fixes: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, desc: { type: "string" } },
          additionalProperties: true,
        },
      },
    },
    required: ["edits"],
    additionalProperties: true,
  },
};
