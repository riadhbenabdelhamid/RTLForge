// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { executeLocal } from "../src/cli/localExecutor.js";

describe("local executor cancellation", function() {
  it("terminates a shell and its waiting grandchild on abort", async function() {
    const controller = new AbortController();
    const started = Date.now();
    const pending = executeLocal(
      { command: "sleep 30 & wait" },
      { signal: controller.signal, timeoutMs: 5000 },
    );
    setTimeout(function() { controller.abort(); }, 40);
    const result = await pending;
    expect(result.aborted).toBe(true);
    // A leaked grandchild would retain the stdio pipe and make this take the
    // full command timeout; process-group cleanup should return promptly.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.skipIf(process.platform !== "linux")("kills a TERM-resistant descendant even after it closes its pipes", async function() {
    const controller = new AbortController();
    let pid = null;
    const pending = executeLocal({
      command: "node child.cjs & wait",
      files: { "child.cjs": [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "fs.writeSync(1, String(process.pid) + '\\n');",
        "fs.closeSync(1); fs.closeSync(2);",
        "setInterval(() => {}, 1000);",
      ].join("\n") },
    }, {
      signal: controller.signal,
      onSpawn(proc) {
        proc.stdout.once("data", function(data) {
          pid = Number(String(data).trim());
          controller.abort();
        });
      },
      timeoutMs: 5000,
    });
    try {
      const result = await pending;
      expect(pid).toBeGreaterThan(0);
      expect(result.aborted).toBe(true);
      // SIGKILL delivery is asynchronous. A zombie is already terminated;
      // its parent/init owns reaping it, not the executor.
      await new Promise(function(resolve) { setTimeout(resolve, 30); });
      let state = "gone";
      try { state = readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1].split(" ")[0]; }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      expect(["gone", "Z"]).toContain(state);
    } finally {
      controller.abort();
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch (_) { /* already gone */ } }
    }
  }, 10000);

  it("reports command timeout and does not run subsequent commands", async function() {
    const result = await executeLocal({ commands: ["sleep 30 & wait", "echo should-not-run"] }, { timeoutMs: 5000 });
    expect(result.exitCode).toBe(124);
    expect(result.aborted).toBe(false);
    expect(result.stderr).toContain("local command timeout");
    expect(result.stdout).not.toContain("should-not-run");
  }, 10000);

  it("does not spawn commands when already aborted", async function() {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const result = await executeLocal({ command: "echo should-not-run" }, {
      signal: controller.signal, onSpawn() { spawned = true; },
    });
    expect(spawned).toBe(false);
    expect(result.aborted).toBe(true);
  });
});
