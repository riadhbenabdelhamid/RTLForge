// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/decompose — System Decomposition (multi-module hierarchy analysis)
//
// Analyses a system description and decomposes it into a module hierarchy.
// Returns either a single-module result or a full multi-module tree with
// instances and paramOverrides for generics.
//
// Key design decision: a "module" is a design *type* (unique logic).
// An "instance" is a parameterised placement of that type inside a parent.
// The same module type can appear N times with different generic parameters.
//
// The forceMulti flag switches to a stricter variant that forbids returning
// "single" — used when the user has explicitly confirmed multi-module mode.
// ═══════════════════════════════════════════════════════════════════════════

import { sys } from "./base.js";

export function promptDecompose(desc, availableModules, forceMulti) {
  const schema = forceMulti ? `{
  "type":        "multi",
  "systemName":  "<snake_case>",
  "description": "<one paragraph system summary>",
  "topModule":   "<modId of the root module>",

  "modules": [
    {
      "modId":       "<snake_case unique identifier, valid SV identifier>",
      "name":        "<human-readable name>",
      "description": "<detailed description — enough to drive requirements elicitation>",
      "level":       0,
      "params": [
        { "name": "DATA_W", "type": "parameter", "default": 8,
          "description": "Data width in bits" }
      ]
    }
  ],

  "instances": [
    {
      "instId":         "u_fifo_0",
      "moduleId":       "sync_fifo",
      "parentModuleId": "top_ctrl",
      "instanceName":   "u_fifo_0",
      "paramOverrides": { "DEPTH": 16, "DATA_W": 32 },
      "description":    "Command FIFO from host to arbiter"
    }
  ],

  "sharedTypes": [
    "<name of any shared SV package or typedef needed across modules>"
  ],

  "interconnects": [
    {
      "from":        "<modId>",
      "to":          "<modId>",
      "protocol":    "valid/ready | AXI4-Lite | custom | direct",
      "signals":     ["data", "valid", "ready"],
      "width":       "DATA_W",
      "description": "<what flows over this link>"
    }
  ]
}` : `{
  "type":        "single | multi",
  "systemName":  "<snake_case>",
  "description": "<one paragraph system summary>",
  "topModule":   "<modId of the root module>",

  "modules": [
    {
      "modId":       "<snake_case unique identifier, valid SV identifier>",
      "name":        "<human-readable name>",
      "description": "<detailed description — enough to drive requirements elicitation>",
      "level":       0,
      "params": [
        { "name": "DATA_W", "type": "parameter", "default": 8,
          "description": "Data width in bits" }
      ]
    }
  ],

  "instances": [
    {
      "instId":         "u_fifo_0",
      "moduleId":       "sync_fifo",
      "parentModuleId": "top_ctrl",
      "instanceName":   "u_fifo_0",
      "paramOverrides": { "DEPTH": 16, "DATA_W": 32 },
      "description":    "Command FIFO from host to arbiter"
    }
  ],

  "sharedTypes": [
    "<name of any shared SV package or typedef needed across modules>"
  ],

  "interconnects": [
    {
      "from":        "<modId>",
      "to":          "<modId>",
      "protocol":    "valid/ready | AXI4-Lite | custom | direct",
      "signals":     ["data", "valid", "ready"],
      "width":       "DATA_W",
      "description": "<what flows over this link>"
    }
  ]
}`;

  const sysRules = forceMulti
    ? 'DECOMPOSITION RULES:\n' +
      '• type MUST be "multi". The user has confirmed this is a multi-module system.\n' +
      '• Decompose into reusable module types with at least 2 modules.\n' +
      '• A module type is a piece of unique logic. An instance is a parameterised ' +
      'placement of that type inside a parent module.\n' +
      '• If two structurally identical modules differ ONLY by parameter values, ' +
      'define ONE module type and create MULTIPLE instances with different paramOverrides.\n' +
      '• Leaf modules (deepest level) must be self-contained with no children.\n' +
      '• The topModule must instantiate (directly or transitively) every other module.\n' +
      '• modId must be a valid SystemVerilog identifier: snake_case, no leading digits.\n' +
      '• instances must cover every parent→child relationship. A module instantiated ' +
      'twice gets two instance entries with distinct instIds.\n' +
      '• Instance names should follow SV convention: u_{purpose} or u_{type}_{n}.\n' +
      '• Each module description must be detailed enough to independently drive ' +
      'a full requirements elicitation stage — include interface expectations, ' +
      'protocol details, and functional behaviour.\n' +
      '• Even if the design could be implemented as a single monolithic module, ' +
      'you MUST decompose it into a top-level controller and functional sub-modules.'
    : 'DECOMPOSITION RULES:\n' +
      '• If the description is a single, self-contained module with no sub-modules, ' +
      'set type to "single". Return exactly one module, zero instances, and zero interconnects.\n' +
      '• If the description implies a system with multiple distinct functional blocks, ' +
      'set type to "multi" and decompose into reusable module types.\n' +
      '• A module type is a piece of unique logic. An instance is a parameterised ' +
      'placement of that type inside a parent module.\n' +
      '• If two structurally identical modules differ ONLY by parameter values, ' +
      'define ONE module type and create MULTIPLE instances with different paramOverrides.\n' +
      '• Leaf modules (deepest level) must be self-contained with no children.\n' +
      '• The topModule must instantiate (directly or transitively) every other module.\n' +
      '• modId must be a valid SystemVerilog identifier: snake_case, no leading digits.\n' +
      '• instances must cover every parent→child relationship. A module instantiated ' +
      'twice gets two instance entries with distinct instIds.\n' +
      '• Instance names should follow SV convention: u_{purpose} or u_{type}_{n}.\n' +
      '• Each module description must be detailed enough to independently drive ' +
      'a full requirements elicitation stage — include interface expectations, ' +
      'protocol details, and functional behaviour.';

  const taskLine = forceMulti
    ? 'TASK: This is a MULTI-MODULE SYSTEM. Decompose it into a hierarchy of \
reusable SystemVerilog modules with instances and interconnects. \
type MUST be "multi" — do NOT return "single".'
    : 'TASK: Analyse the hardware system description below and determine whether it \
describes a single module or a multi-module system. Then produce the \
decomposition.';

  const thinkingSteps = forceMulti
    ? `\
THINKING STEPS (do these mentally before writing JSON):
1. Identify the top-level function and all distinct sub-functions.
2. For each sub-function, decide: is it complex enough to be its own module, \
   or should it be inline logic within a parent? Err on the side of splitting.
3. Group structurally identical sub-functions into a single module type — \
   create separate instances with different parameters for each use.
4. Determine the hierarchy: which modules are leaves (no children) and which \
   are parents (instantiate others)?
5. For each parent→child relationship, define the instance with its \
   paramOverrides and a descriptive instanceName.
6. Identify any shared types, constants, or interfaces used across modules.
7. Map interconnects between modules: what data/control flows between them \
   and via which protocol.
8. Then emit the JSON.`
    : `\
THINKING STEPS (do these mentally before writing JSON):
1. Identify the top-level function and all distinct sub-functions.
2. For each sub-function, decide: is it complex enough to be its own module, \
   or should it be inline logic within a parent?
3. Group structurally identical sub-functions into a single module type — \
   create separate instances with different parameters for each use.
4. Determine the hierarchy: which modules are leaves (no children) and which \
   are parents (instantiate others)?
5. For each parent→child relationship, define the instance with its \
   paramOverrides and a descriptive instanceName.
6. Identify any shared types, constants, or interfaces used across modules.
7. Map interconnects between modules: what data/control flows between them \
   and via which protocol.
8. If the description is just one module, output type "single" with a flat \
   one-entry modules list.
9. Then emit the JSON.`;

  const rules = forceMulti
    ? `\
RULES:
• type MUST be "multi". Never return "single".
• modules array must have at least 2 entries.
• instances array must have at least 1 entry.
• Every module referenced by an instance must exist in the modules array.
• Every non-top module must be referenced by at least one instance.
• params in modules are the PARAMETERISABLE dimensions of that module type \
  (the generic ports). paramOverrides in instances set specific values.
• level 0 = top module, level 1 = directly instantiated by top, etc.
• topModule must point to the level-0 module's modId.
• Do not create gratuitously deep hierarchies — 2–3 levels is typical.`
    : `\
RULES:
• modules array must have at least 1 entry.
• For type "single": exactly 1 module, 0 instances, 0 interconnects.
• For type "multi": at least 2 modules, at least 1 instance.
• Every module referenced by an instance must exist in the modules array.
• Every non-top module must be referenced by at least one instance.
• params in modules are the PARAMETERISABLE dimensions of that module type \
  (the generic ports). paramOverrides in instances set specific values.
• level 0 = top module, level 1 = directly instantiated by top, etc.
• topModule must point to the level-0 module's modId.
• Do not create gratuitously deep hierarchies — 2–3 levels is typical.`;

  return {
    systemPrompt: sys(sysRules),
    maxTokens: 6000,
    userMessage: `\
${taskLine}

DESCRIPTION:
"""
${desc}
"""

${thinkingSteps}

${rules}

OUTPUT SCHEMA (produce exactly this shape):
${schema}` + (availableModules && availableModules.length > 0 ? `

PRE-VALIDATED MODULES IN LIBRARY:
${JSON.stringify(availableModules)}

If your decomposition needs a module matching one of these, reuse the SAME modId for automatic library wiring. For system packages, use the topModule modId to instantiate the system as a black box.

Do NOT force matches if functionality doesn't align.` : ''),
  };
}
