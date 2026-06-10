// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/sharedPackage — Shared SV Package Generation (Step 9)
//
// Generates a shared SystemVerilog package with common types, constants,
// and interface definitions used across modules in a multi-module system.
//
// Used by runAllPipelines() before the per-module pipelines start, if the
// decomposition declares sharedTypes. The generated package is injected into
// each module's RTL generation via the sharedPackageCode argument to promptRTL.
// ═══════════════════════════════════════════════════════════════════════════

import { sys, j } from "./base.js";

export function promptSharedPackage(decomposition) {
  const schema = `{
  "packageName": "<snake_case>_pkg",
  "code": "<complete SV package source as a single JSON string>",
  "types": [
    { "name": "data_t", "kind": "typedef | struct | enum | interface", "desc": "..." }
  ],
  "constants": [
    { "name": "MAX_MASTERS", "value": 4, "desc": "..." }
  ]
}`;

  return {
    systemPrompt: sys(
      'PACKAGE RULES:\n' +
      '• The "code" value must be a complete, syntactically valid SystemVerilog package.\n' +
      '• Use `package ... endpackage` syntax.\n' +
      '• Define typedefs for any data structures shared across modules.\n' +
      '• Define localparams for system-wide constants.\n' +
      '• The package must be importable via `import {pkg_name}::*;`.\n' +
      '• Use \\n for newlines inside the "code" JSON string.'
    ),
    maxTokens: 4000,
    userMessage: `\
TASK: Generate a shared SystemVerilog package for the "${decomposition.systemName}" system.

SYSTEM DESCRIPTION:
${decomposition.description || ""}

MODULES IN THE SYSTEM:
${j((decomposition.modules || []).map(function(m) { return { modId: m.modId, description: m.description, params: m.params }; }))}

SHARED TYPES REQUESTED:
${j(decomposition.sharedTypes || [])}

INTERCONNECTS (signals/types shared between modules):
${j(decomposition.interconnects || [])}

THINKING STEPS (mental only):
1. Identify all data types that appear in more than one module's interface.
2. Identify system-wide constants (e.g. bus widths, address maps, number of ports).
3. Define clean typedefs and localparams for these.
4. If interconnects use a common protocol, define a struct or interface type for it.
5. Ensure naming follows SystemVerilog conventions (snake_case, _t suffix for types).
6. Then emit the JSON.

RULES:
• packageName must end with _pkg.
• code must include \`timescale 1ns/1ps at the top.
• Every type in the types array must appear in the code.
• Every constant in the constants array must appear in the code.
• If no meaningful shared types exist, return a minimal package with \
  just the system-wide constants.

OUTPUT SCHEMA (produce exactly this shape):
${schema}`,
  };
}
