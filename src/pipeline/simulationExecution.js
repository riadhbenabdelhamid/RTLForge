// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { injectVerilatorFlag } from "./svaBind.js";

// Every simulator consumer must apply the same configured warning policy.
// Optional instrumentation does not change whether warnings stop execution.
export function simulationCommands(config = {}, { commands, assertions = false, trace = false } = {}) {
  let result = commands || String(config.simCmds || "").split("\n").filter(c => c.trim());
  if (assertions) result = injectVerilatorFlag(result, "--assert");
  if (!config.verifyWarningsAsErrors) result = injectVerilatorFlag(result, "-Wno-fatal");
  if (trace) result = injectVerilatorFlag(result, "--trace");
  return result;
}

export function simulationIdentity(config = {}) {
  return JSON.stringify({ commands: simulationCommands(config), backend: config.backendUrl,
    path: config.simPath, timeoutSec: config.backendTimeoutSec, warningsAsErrors: !!config.verifyWarningsAsErrors });
}
