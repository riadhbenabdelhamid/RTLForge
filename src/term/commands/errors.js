// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/errors — manage the cross-run "errors to avoid" catalog (#28)
//
//   rtlforge errors show               — top recurring lint lessons
//   rtlforge errors export             — JSON dump (stdout) for sharing
//   rtlforge errors import <file.json> — merge a teammate's catalog (federation)
//   rtlforge errors wipe               — clear the catalog
//
// The catalog lives at ~/.rtlforge/errors-to-avoid.json. When
// config.errorsToAvoid is on, the lint/lint_test nodes harvest first-pass
// errors here and the cold RTL/TB generators inject the top ones.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { rtlforgeHome } from "../config.js";
import { c, table, heading } from "../format.js";
import { createFileErrorMemory, aggregateErrors } from "../../pipeline/index.js";

function catalogPath() { return path.join(rtlforgeHome(), "errors-to-avoid.json"); }

function openMem() {
  try { return createFileErrorMemory(catalogPath(), { fs: fs }); }
  catch (_e) { return null; }
}

async function cmdShow(args) {
  const mem = openMem();
  if (!mem) { process.stderr.write(c.red("error:") + " could not open catalog\n"); return 1; }
  let agg = aggregateErrors(mem.all());
  if (args.domain) agg = agg.filter(function(r) { return r.domain === args.domain; });
  if (agg.length === 0) {
    process.stdout.write(c.dim("(catalog empty — enable errorsToAvoid and run the pipeline to harvest)") + "\n");
    return 0;
  }
  process.stdout.write(heading("Errors to avoid — " + agg.length + " lesson(s)") + "\n");
  process.stdout.write(c.dim("catalog: ") + catalogPath() + "\n\n");
  const rows = agg.slice(0, parseInt(args.limit, 10) || 30).map(function(r) {
    return {
      count: String(r.count),
      domain: r.domain || "-",
      code: r.code || "-",
      sample: (r.sample || r.signature || "").slice(0, 70),
    };
  });
  process.stdout.write(table([
    { key: "count",  label: "Seen", align: "right" },
    { key: "domain", label: "Domain" },
    { key: "code",   label: "Code" },
    { key: "sample", label: "Sample" },
  ], rows) + "\n");
  return 0;
}

async function cmdExport(args) {
  const mem = openMem();
  if (!mem) { process.stderr.write(c.red("error:") + " could not open catalog\n"); return 1; }
  process.stdout.write(JSON.stringify(mem.all(), null, 2) + "\n");
  return 0;
}

async function cmdImport(args) {
  const src = args._[1];
  if (!src) {
    process.stderr.write(c.red("error:") + " usage: rtlforge errors import <file.json>\n");
    return 2;
  }
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(src, "utf8"));
  } catch (e) {
    process.stderr.write(c.red("error:") + " could not read/parse " + src + ": " + e.message + "\n");
    return 1;
  }
  if (!Array.isArray(rows)) {
    process.stderr.write(c.red("error:") + " expected a JSON array of error records\n");
    return 1;
  }
  const mem = openMem();
  if (!mem) { process.stderr.write(c.red("error:") + " could not open catalog\n"); return 1; }
  const res = mem.importCatalog(rows);
  process.stdout.write(c.green("✓") + " merged " + res.added + " new lesson(s), summed " + res.summed
    + " overlap(s) (catalog now " + res.total + ")\n");
  return 0;
}

async function cmdWipe(args) {
  const mem = openMem();
  if (!mem) { process.stderr.write(c.red("error:") + " could not open catalog\n"); return 1; }
  mem.wipe();
  process.stdout.write(c.green("✓") + " errors-to-avoid catalog wiped\n");
  return 0;
}

export async function cmdErrors(args) {
  const sub = args._[0] || "show";
  if (sub === "show")   return cmdShow(args);
  if (sub === "export") return cmdExport(args);
  if (sub === "import") return cmdImport(args);
  if (sub === "wipe")   return cmdWipe(args);
  process.stderr.write(c.red("error:") + " unknown errors subcommand: " + sub + "\n");
  process.stderr.write(c.dim("  try: show, export, import <file>, wipe") + "\n");
  return 2;
}
