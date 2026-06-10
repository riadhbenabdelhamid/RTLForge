// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// utils/export — Browser-side export utilities for regression suite output
//
// Pure functions except downloadZip, which uses browser Blob/URL APIs.
//
//   MiniZip           — in-memory ZIP builder (stored, no compression)
//   crc32             — CRC-32 checksum for zip entries
//   downloadZip       — trigger browser download of a MiniZip
//   buildSVASource    — assemble SVA properties + auto-constraints into a .sv string
//   generateMakefile  — emit a Makefile for the regression suite
//   generateRunScript — emit a bash test runner script
//   generateReadme    — emit a README.md for the regression suite
// ═══════════════════════════════════════════════════════════════════════════

import { buildAutoAssumptionsSVA } from "./constraints.js";

// ─── CRC-32 ──────────────────────────────────────────────────────────────────

const crc32Table = (function() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── MiniZip ─────────────────────────────────────────────────────────────────

export function MiniZip() { this.files = []; }

MiniZip.prototype.addFile = function(path, content) {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  this.files.push({ path, data });
};

MiniZip.prototype.generate = function() {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  for (let i = 0; i < this.files.length; i++) {
    const f = this.files[i];
    const pathBytes = new TextEncoder().encode(f.path);
    const fileCrc = crc32(f.data);
    // Local file header
    const lh = new Uint8Array(30 + pathBytes.length + f.data.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, fileCrc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, pathBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(pathBytes, 30);
    lh.set(f.data, 30 + pathBytes.length);
    localHeaders.push(lh);
    // Central directory header
    const ch = new Uint8Array(46 + pathBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, fileCrc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, pathBytes.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    ch.set(pathBytes, 46);
    centralHeaders.push(ch);
    offset += lh.length;
  }
  const cdOffset = offset;
  const cdSize = centralHeaders.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, this.files.length, true);
  ev.setUint16(10, this.files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);
  const total = offset + cdSize + 22;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const lh of localHeaders) { result.set(lh, pos); pos += lh.length; }
  for (const ch of centralHeaders) { result.set(ch, pos); pos += ch.length; }
  result.set(eocd, pos);
  return result;
};

// ─── downloadZip (browser-only) ──────────────────────────────────────────────

export function downloadZip(zip, filename) {
  const data = zip.generate();
  if (typeof Blob === "undefined" || typeof document === "undefined") {
    // Non-browser fallback — log instead of crash
    console.warn("[export] downloadZip called in non-browser environment; " + filename + " not downloaded");
    return data;
  }
  const blob = new Blob([data], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return data;
}

// ─── downloadJSON (browser-only helper) ──────────────────────────────────────

export function downloadJSON(obj, filename) {
  if (typeof Blob === "undefined" || typeof document === "undefined") {
    console.warn("[export] downloadJSON called in non-browser environment; " + filename + " not downloaded");
    return;
  }
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── buildSVASource ──────────────────────────────────────────────────────────

export function buildSVASource(svaData) {
  if (!svaData) return "";
  const autoPrefix = buildAutoAssumptionsSVA(svaData.autoAssumptions);
  const svaCode = (svaData.properties || []).map(function(p) {
    return "// " + p.id + " covers " + p.req + "\n" + p.code;
  }).join("\n\n");
  if (!svaCode && !autoPrefix) return "";
  return autoPrefix + svaCode + "\n\n" + (svaData.bind_module || "");
}

// ─── generateMakefile ────────────────────────────────────────────────────────

export function generateMakefile(modList, isMulti, topModId, projectName) {
  const ts = new Date().toISOString();
  let mk = "# ═══════════════════════════════════════════════════════════════\n";
  mk += "# RTL Forge — Regression Suite Makefile\n";
  mk += "# Project: " + projectName + "\n";
  mk += "# Generated: " + ts + "\n";
  mk += "# ═══════════════════════════════════════════════════════════════\n\n";
  mk += "VERILATOR ?= verilator\nVFLAGS    ?= -Wall --binary\nLFLAGS    ?= --lint-only -Wall\n\n";
  const rtlFiles = modList.map((m) => "rtl/" + m.modId + ".sv");
  const svaFiles = modList.filter((m) => m.hasSVA).map((m) => "sva/" + m.modId + "_sva.sv");
  mk += "RTL_FILES = " + rtlFiles.join(" \\\n            ") + "\n";
  if (svaFiles.length > 0) mk += "SVA_FILES = " + svaFiles.join(" \\\n            ") + "\n";
  mk += "\n.PHONY: all lint test clean\n\nall: lint test\n\n";
  mk += "lint:\n\t@echo \"══ Lint ══\"\n\t$(VERILATOR) $(LFLAGS) $(RTL_FILES)" + (svaFiles.length > 0 ? " $(SVA_FILES)" : "") + "\n\t@echo \"Lint: PASS\"\n\n";
  mk += "test:";
  modList.forEach((m) => { mk += " test_" + m.modId; });
  if (isMulti && topModId) mk += " test_integration";
  mk += "\n\t@echo \"\"\n\t@echo \"══ All Tests Complete ══\"\n\n";
  modList.forEach((m) => {
    mk += "test_" + m.modId + ":\n";
    mk += "\t@echo \"── Testing " + m.modId + " ──\"\n";
    mk += "\t$(VERILATOR) $(VFLAGS) rtl/" + m.modId + ".sv tb/" + m.modId + "_tb.sv -o obj_dir/sim_" + m.modId + "\n";
    mk += "\t./obj_dir/sim_" + m.modId + "\n\n";
  });
  if (isMulti && topModId) {
    mk += "test_integration:\n";
    mk += "\t@echo \"── Integration Test ──\"\n";
    mk += "\t$(VERILATOR) $(VFLAGS) $(RTL_FILES) tb/" + projectName + "_top_tb.sv -o obj_dir/sim_integration\n";
    mk += "\t./obj_dir/sim_integration\n\n";
  }
  mk += "clean:\n\trm -rf obj_dir *.vcd\n";
  return mk;
}

// ─── generateRunScript ───────────────────────────────────────────────────────

export function generateRunScript(modList, isMulti, topModId, projectName) {
  let sh = "#!/usr/bin/env bash\n";
  sh += "# ═══════════════════════════════════════════════════════════════\n";
  sh += "# RTL Forge — Regression Test Runner\n";
  sh += "# Project: " + projectName + "\n";
  sh += "# Generated: " + new Date().toISOString() + "\n";
  sh += "# ═══════════════════════════════════════════════════════════════\n\n";
  sh += "set -euo pipefail\ncd \"$(dirname \"$0\")/..\"\n\n";
  sh += "PASS=0\nFAIL=0\nTOTAL=0\nFAILED_MODULES=\"\"\n\n";
  sh += "run_test() {\n  local name=\"$1\" rtl=\"$2\" tb=\"$3\"\n  TOTAL=$((TOTAL + 1))\n";
  sh += "  echo \"── Testing $name ──\"\n";
  sh += "  if verilator --binary -Wall -j 0 \"$rtl\" \"$tb\" -o \"obj_dir/sim_${name}\" 2>&1 && ./\"obj_dir/sim_${name}\" 2>&1; then\n";
  sh += "    echo \"  → $name: PASS\"\n    PASS=$((PASS + 1))\n  else\n";
  sh += "    echo \"  → $name: FAIL\"\n    FAIL=$((FAIL + 1))\n    FAILED_MODULES=\"$FAILED_MODULES $name\"\n  fi\n}\n\n";
  sh += "echo \"═══ RTL Forge Regression Suite: " + projectName + " ═══\"\necho \"\"\n\n";
  sh += "# ── Lint ──\necho \"── Lint Check ──\"\n";
  const allRTL = modList.map((m) => "rtl/" + m.modId + ".sv").join(" ");
  sh += "if verilator --lint-only -Wall " + allRTL + " 2>&1; then\n  echo \"  → Lint: PASS\"\nelse\n  echo \"  → Lint: WARNINGS (non-fatal)\"\nfi\necho \"\"\n\n";
  sh += "# ── Unit Tests ──\n";
  modList.forEach((m) => { sh += "run_test \"" + m.modId + "\" \"rtl/" + m.modId + ".sv\" \"tb/" + m.modId + "_tb.sv\"\n"; });
  if (isMulti && topModId) {
    sh += "\n# ── Integration Test ──\nTOTAL=$((TOTAL + 1))\necho \"── Integration Test ──\"\n";
    sh += "if verilator --binary -Wall -j 0 " + allRTL + " tb/" + projectName + "_top_tb.sv -o obj_dir/sim_integration 2>&1 && ./obj_dir/sim_integration 2>&1; then\n";
    sh += "  echo \"  → Integration: PASS\"\n  PASS=$((PASS + 1))\nelse\n  echo \"  → Integration: FAIL\"\n  FAIL=$((FAIL + 1))\n  FAILED_MODULES=\"$FAILED_MODULES integration\"\nfi\n";
  }
  sh += "\n# ── Summary ──\necho \"\"\necho \"═══════════════════════════════════════\"\n";
  sh += "echo \"  Tests: $TOTAL  Pass: $PASS  Fail: $FAIL\"\n";
  sh += "if [ $FAIL -gt 0 ]; then\n  echo \"  Failed:$FAILED_MODULES\"\n  echo \"═══════════════════════════════════════\"\n  exit 1\nfi\n";
  sh += "echo \"  Status: ALL PASS\"\necho \"═══════════════════════════════════════\"\nexit 0\n";
  return sh;
}

// ─── generateReadme ──────────────────────────────────────────────────────────

export function generateReadme(projectName, modList, isMulti, decomposition, sharedPkg, judgeResults, integrationResult, ledgerTotals) {
  let md = "# " + projectName + " — Regression Suite\n\n";
  md += "> Generated by [RTL Forge](https://github.com) on " + new Date().toISOString().substring(0, 10) + "\n\n";
  md += "## Quick Start\n\n```bash\n# Prerequisites: Verilator 5.x, GNU Make, Bash\n\n";
  md += "# Run all tests\nmake test\n\n# Lint only\nmake lint\n\n";
  md += "# Or use the test runner script\nchmod +x scripts/run_tests.sh\n./scripts/run_tests.sh\n```\n\n";
  md += "## Modules\n\n| Module | Score | Status | Notes |\n|--------|-------|--------|-------|\n";
  modList.forEach((m) => {
    const notes = [];
    if (m.isManualRTL) notes.push("RTL manually imported");
    if (m.isManualTB) notes.push("TB manually imported");
    md += "| `" + m.modId + "` | " + (m.score != null ? m.score : "—") + " | " + (m.overall || "—") + " | " + (notes.join(", ") || "LLM-generated") + " |\n";
  });
  if (isMulti && integrationResult) {
    md += "| **Integration** | " + (integrationResult.score || "—") + " | " + (integrationResult.overall || "—") + " | System-level |\n";
  }
  md += "\n";
  if (isMulti && decomposition) {
    md += "## Architecture\n\n" + (decomposition.description || "Multi-module system") + "\n\n";
    if (decomposition.topModule) md += "- **Top module:** `" + decomposition.topModule + "`\n";
    md += "- **Module count:** " + modList.length + "\n";
    if (sharedPkg) md += "- **Shared package:** `" + (sharedPkg.packageName || "shared_pkg") + ".sv`\n";
    md += "\n";
  }
  md += "## Directory Structure\n\n```\n" + projectName + "_regression/\n";
  md += "├── rtl/            # SystemVerilog RTL source\n├── tb/             # Testbenches\n";
  md += "├── sva/            # SVA formal properties\n├── scripts/        # run_tests.sh\n";
  md += "├── Makefile\n├── manifest.json\n├── token_ledger.yaml\n└── README.md\n```\n\n";
  md += "## Prerequisites\n\n- **Verilator** 5.x\n- **GNU Make** 4.x\n- **Bash** 4+\n\n";
  if (ledgerTotals) {
    md += "## Generation Costs\n\n";
    md += "- Tokens in: " + (ledgerTotals.tIn || 0).toLocaleString() + "\n";
    md += "- Tokens out: " + (ledgerTotals.tOut || 0).toLocaleString() + "\n";
    md += "- Estimated cost: $" + (ledgerTotals.cost || 0).toFixed(4) + "\n\n";
  }
  const manualMods = modList.filter((m) => m.isManualRTL || m.isManualTB);
  if (manualMods.length > 0) {
    md += "## Manual Import Flags\n\n";
    manualMods.forEach((m) => {
      if (m.isManualRTL) md += "- ⚠ `" + m.modId + "` RTL was manually imported\n";
      if (m.isManualTB) md += "- ⚠ `" + m.modId + "` testbench was manually imported\n";
    });
    md += "\n";
  }
  md += "---\n*Generated by RTL Forge v6 — Modular Core*\n";
  return md;
}
