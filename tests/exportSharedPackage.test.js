// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// The export has to be a design somebody can compile.
//
// In a system run every module opens with `import <pkg>::*;`, so a directory
// of modules without the shared package is not a design that needs assembling
// — it is a design that cannot be read at all.
//
// Measured (run 51): a seven-module RV32I core passed integration lint, passed
// a 42-check system simulation and passed judge at 95/100, and the 42 exported
// files stopped Verilator on the first line of the first file:
//
//   %Error: rv_core.sv:12:12: Import package not found: 'rv_pkg'
//
// Every stage that could have caught it was working from the project's own
// file set, where the package is inserted on their behalf. The export was the
// only place that assembled a file set of its own, and the only place the
// package was missing.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdExport } from "../src/term/commands/export.js";
import { CHECKPOINT_VERSION } from "../src/projectState/checkpoint.js";

const PKG_CODE = [
  "`timescale 1ns/1ps",
  "package rv_pkg;",
  "    localparam int unsigned XLEN = 32;",
  "endpackage",
].join("\n");

const CHECKPOINT = {
  projectId: "sysproj",
  mode: "system",
  sharedPackage: { packageName: "rv_pkg", code: PKG_CODE, constants: [], types: [] },
  modules: {
    rv_alu: {
      stageData: {
        1: { modName: "rv_alu" },
        4: { code: "module rv_alu\n  import rv_pkg::*;\n();\nendmodule\n" },
      },
    },
  },
};

// Storage keys are URI-encoded on disk, as createFsStorage writes them, and
// deserializeCheckpoint refuses anything whose version it does not know.
function writeCheckpoint(home, projectId, obj) {
  const dir = path.join(home, "projects");
  fs.mkdirSync(dir, { recursive: true });
  const key = encodeURIComponent("rtlforge:checkpoint:" + projectId).replace(/%20/g, "_");
  fs.writeFileSync(path.join(dir, key + ".json"),
    JSON.stringify(Object.assign({ version: CHECKPOINT_VERSION, timestamp: 0 }, obj)));
}

let homeDir;
let outDir;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-exp-"));
  outDir = path.join(homeDir, "components");
  process.env.RTLFORGE_HOME = homeDir;
  writeCheckpoint(homeDir, "sysproj", CHECKPOINT);
});

afterEach(() => {
  delete process.env.RTLFORGE_HOME;
  try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
});

describe("export writes the shared package", () => {
  it("emits the package a system export's modules all import", async () => {
    const rc = await cmdExport({ _: ["sysproj"], out: outDir });
    expect(rc).toBe(0);
    const written = fs.readdirSync(outDir);
    // named after the PACKAGE, since Verilator's DECLFILENAME warns when a
    // package's file disagrees with its declared name
    expect(written).toContain("rv_pkg.sv");
    expect(fs.readFileSync(path.join(outDir, "rv_pkg.sv"), "utf8")).toBe(PKG_CODE);
  });

  it("leaves no module importing a package the export did not write", async () => {
    await cmdExport({ _: ["sysproj"], out: outDir });
    const written = fs.readdirSync(outDir);
    const imported = new Set();
    for (const f of written.filter((n) => n.endsWith(".sv"))) {
      const src = fs.readFileSync(path.join(outDir, f), "utf8");
      const m = /^\s*import\s+([A-Za-z_]\w*)\s*::/m.exec(src);
      if (m) imported.add(m[1]);
    }
    expect(imported.size).toBeGreaterThan(0);   // the fixture really does import
    for (const pkg of imported) {
      expect(written).toContain(pkg + ".sv");
    }
  });

  it("does not emit a package for a single-module project that has none", async () => {
    writeCheckpoint(homeDir, "solo", {
      projectId: "solo",
      modules: { m0: { stageData: { 1: { modName: "cnt" }, 4: { code: "module cnt();\nendmodule\n" } } } },
    });
    const solo = path.join(homeDir, "solo-out");
    expect(await cmdExport({ _: ["solo"], out: solo })).toBe(0);
    expect(fs.readdirSync(solo).filter((n) => /pkg/i.test(n))).toEqual([]);
  });
});
