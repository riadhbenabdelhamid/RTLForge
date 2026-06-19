// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/observe — Manage the observer knowledge base
//
//   rtlforge observe show                  — summary (counts + by-kind table)
//   rtlforge observe list [--kind X] [--severity Y] [--limit N]
//   rtlforge observe path                  — print resolved DB path
//   rtlforge observe dismiss <id>          — soft-delete (hide from list)
//   rtlforge observe delete <id>           — hard delete
//   rtlforge observe delete-before <date>  — delete events older than ISO timestamp
//   rtlforge observe wipe                  — delete everything (asks for confirm)
//   rtlforge observe export                — JSON dump of all events
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import readline from "node:readline";
import { loadConfig } from "../config.js";
import { c, ICON, table, heading } from "../format.js";
import path from "node:path";
import {
  openDb, openDbAt, resolveDbPath, queryEvents, allEvents, insertEvent, summary,
  dismissEvent, deleteEvent, deleteEventsBefore, wipeAll, planMerge,
} from "../../observer/index.js";

async function cmdShow(args, config) {
  const handle = await openDb(config);
  if (!handle.available) {
    process.stderr.write(c.yellow("⚠") + " observer DB unavailable (better-sqlite3 not installed)\n");
    return 1;
  }
  const workflow = args.workflow || (config && config.workflow) || "rtl";
  const s = summary(handle, { workflow: workflow });
  process.stdout.write(heading("Observer knowledge — workflow '" + workflow + "'") + "\n");
  process.stdout.write(c.dim("DB path: ") + handle.path + "\n\n");
  process.stdout.write(
    "Total events:   " + (s.totals.n || 0) + "\n" +
    "Open (active):  " + (s.totals.open || 0) + "\n" +
    "High-severity:  " + (s.totals.high || 0) + "\n\n"
  );
  if (s.byKind.length === 0) {
    process.stdout.write(c.dim("(no events yet — observer runs after each stage when enabled)") + "\n");
    return 0;
  }
  process.stdout.write(table(
    [{ key: "kind", label: "Kind" }, { key: "n", label: "Count", align: "right" }],
    s.byKind
  ) + "\n");
  return 0;
}

async function cmdList(args, config) {
  const handle = await openDb(config);
  if (!handle.available) {
    process.stderr.write(c.yellow("⚠") + " observer DB unavailable\n");
    return 1;
  }
  const workflow = args.workflow || (config && config.workflow) || "rtl";
  const opts = {
    workflow: workflow,
    kind:     args.kind || null,
    severity: args.severity || null,
    stageKey: args.stage || null,
    limit:    parseInt(args.limit, 10) || 50,
    includeDismissed: !!args["include-dismissed"],
  };
  const rows = queryEvents(handle, opts);
  if (rows.length === 0) {
    process.stdout.write(c.dim("(no events matching filters)") + "\n");
    return 0;
  }
  process.stdout.write(heading("Observer events (" + rows.length + ")") + "\n");
  for (const r of rows) {
    const sev = r.severity === "high" ? c.red("⚑ high") :
                r.severity === "warn" ? c.yellow("⚠ warn") : c.dim("• info");
    const summary = (r.extracted && r.extracted.summary) || "(no summary)";
    const when = new Date(r.ts).toISOString().replace("T", " ").slice(0, 19);
    process.stdout.write(
      c.dim("#" + r.id) + "  " + when + "  " + sev + "  " +
      c.bold(r.event_kind) + "  " + c.dim(r.stage_key || "-") + "\n" +
      "    " + summary + "\n"
    );
    const tags = r.extracted && Array.isArray(r.extracted.tags) ? r.extracted.tags : [];
    if (tags.length > 0) {
      process.stdout.write("    " + c.dim("tags: ") + tags.join(", ") + "\n");
    }
  }
  return 0;
}

async function cmdPath(args, config) {
  const p = resolveDbPath(config);
  process.stdout.write(p + "\n");
  process.stdout.write(c.dim(fs.existsSync(p) ? "(exists)" : "(not yet created — first observation will create it)") + "\n");
  return 0;
}

async function cmdDismiss(args, config) {
  const id = parseInt(args._[1], 10);
  if (!id) {
    process.stderr.write(c.red("error:") + " usage: rtlforge observe dismiss <id>\n");
    return 2;
  }
  const handle = await openDb(config);
  if (!handle.available) return 1;
  const ok = dismissEvent(handle, id);
  if (!ok) {
    process.stderr.write(c.red("error:") + " no event with id " + id + "\n");
    return 1;
  }
  process.stdout.write(c.green("✓") + " event #" + id + " dismissed\n");
  return 0;
}

async function cmdDelete(args, config) {
  const id = parseInt(args._[1], 10);
  if (!id) {
    process.stderr.write(c.red("error:") + " usage: rtlforge observe delete <id>\n");
    return 2;
  }
  const handle = await openDb(config);
  if (!handle.available) return 1;
  const ok = deleteEvent(handle, id);
  if (!ok) {
    process.stderr.write(c.red("error:") + " no event with id " + id + "\n");
    return 1;
  }
  process.stdout.write(c.green("✓") + " event #" + id + " deleted\n");
  return 0;
}

async function cmdDeleteBefore(args, config) {
  const dateArg = args._[1] || args.before;
  if (!dateArg) {
    process.stderr.write(c.red("error:") + " usage: rtlforge observe delete-before <YYYY-MM-DD or ISO timestamp>\n");
    return 2;
  }
  const ts = Date.parse(dateArg);
  if (isNaN(ts)) {
    process.stderr.write(c.red("error:") + " could not parse '" + dateArg + "' as a date\n");
    return 2;
  }
  const handle = await openDb(config);
  if (!handle.available) return 1;
  const n = deleteEventsBefore(handle, ts);
  process.stdout.write(c.green("✓") + " deleted " + n + " events before " + new Date(ts).toISOString() + "\n");
  return 0;
}

async function cmdWipe(args, config) {
  const handle = await openDb(config);
  if (!handle.available) return 1;
  if (!args.yes) {
    process.stdout.write(c.yellow("⚠ This will permanently delete ALL observer events at:") + "\n");
    process.stdout.write("  " + handle.path + "\n\n");
    process.stdout.write("Type 'wipe' to confirm (or anything else to abort): ");
    const answer = await new Promise(function(resolve) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("", function(a) { rl.close(); resolve(a.trim()); });
    });
    if (answer !== "wipe") {
      process.stdout.write(c.dim("aborted") + "\n");
      return 1;
    }
  }
  wipeAll(handle);
  process.stdout.write(c.green("✓") + " observer DB wiped\n");
  return 0;
}

async function cmdExport(args, config) {
  const handle = await openDb(config);
  if (!handle.available) return 1;
  const workflow = args.workflow || (config && config.workflow) || "rtl";
  const rows = queryEvents(handle, { workflow: workflow, limit: 5000, includeDismissed: true });
  const out = {
    exported_at: new Date().toISOString(),
    workflow:    workflow,
    db_path:     handle.path,
    events:      rows,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}

// ── import-browser ─────────────────────────────────────────────────────────
// Accepts a JSON export from the GUI's browser-side observer (the same
// shape browserObserver writes to localStorage) and inserts the events
// into SQLite. Useful for merging GUI-captured knowledge into the
// canonical KB.
//
// USAGE:
//   rtlforge observe import-browser <path.json>
//   rtlforge observe import-browser -          # read from stdin
//
// INPUT SHAPE (one of):
//   - { events: [...] }                  (matches `observe export` output)
//   - { rtlforge:obs:<key>: <row>, ... } (raw localStorage dump)
//   - [<row>, <row>, ...]                (bare array)
//
// Each row carries at minimum {workflow, event_kind, extracted}. We
// dedupe on (ts, workflow, stage_key, event_kind, extracted.summary)
// so re-importing the same export doesn't double-insert.
async function cmdImportBrowser(args, config) {
  const src = args._[1];
  if (!src) {
    process.stderr.write(c.red("error:") + " usage: rtlforge observe import-browser <path.json | ->\n");
    return 2;
  }
  // Read input
  let rawText;
  try {
    if (src === "-") {
      // Stdin
      rawText = await new Promise(function(resolve, reject) {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", function(d) { buf += d; });
        process.stdin.on("end", function() { resolve(buf); });
        process.stdin.on("error", reject);
      });
    } else {
      rawText = fs.readFileSync(src, "utf8");
    }
  } catch (e) {
    process.stderr.write(c.red("error:") + " could not read input: " + e.message + "\n");
    return 1;
  }

  // Parse into a normalized array of rows via the shared parser
  let rows;
  try {
    rows = parseImportPayload(rawText);
  } catch (e) {
    process.stderr.write(c.red("error:") + " could not parse input JSON: " + e.message + "\n");
    return 1;
  }

  if (rows.length === 0) {
    process.stdout.write(c.yellow("⚠") + " no observer-shaped events found in input\n");
    return 1;
  }

  // Open DB and dedupe-insert
  const handle = await openDb(config);
  if (!handle.available) {
    process.stderr.write(c.red("error:") + " observer DB unavailable (better-sqlite3 not installed)\n");
    return 1;
  }

  // Build a signature set of existing events to skip dupes. The
  // workflow scope honors the per-workflow scoping decision: we
  // compare within the same workflow.
  const existingSigs = new Set();
  const existing = queryEvents(handle, { limit: 5000, includeDismissed: true });
  for (const e of existing) {
    existingSigs.add(sigOf(e));
  }

  let inserted = 0, skipped = 0;
  for (const r of rows) {
    if (existingSigs.has(sigOf(r))) { skipped++; continue; }
    insertEvent(handle, {
      ts:          r.ts,
      workflow:    r.workflow || "rtl",
      project_id:  r.project_id || null,
      module_id:   r.module_id || null,
      stage_key:   r.stage_key || null,
      event_kind:  r.event_kind,
      raw_input:   r.raw_input || null,
      extracted:   r.extracted || null,
      severity:    r.severity || "info",
    });
    inserted++;
  }

  process.stdout.write(c.green("✓") + " imported " + inserted + " events" +
    (skipped > 0 ? " (skipped " + skipped + " duplicates)" : "") + "\n");
  process.stdout.write(c.dim("DB path: " + handle.path) + "\n");
  return 0;
}

// ── merge (SQLite ← SQLite) ──────────────────────────────────────────────────
// Merge another observer DB (e.g. a teammate's shared team.db) into the
// active one. Idempotent via content-signature dedup; the source is opened
// READ-ONLY and never mutated.
//
// USAGE:
//   rtlforge observe merge <other.db> [--workflow W] [--include-dismissed] [--dry-run]
async function cmdMerge(args, config) {
  const src = args._[1];
  if (!src) {
    process.stderr.write(c.red("error:") + " usage: rtlforge observe merge <other.db> [--workflow W] [--include-dismissed] [--dry-run]\n");
    return 2;
  }
  // Reuse resolveDbPath purely for its leading-~ expansion; a non-~ path
  // passes through unchanged.
  const srcPath = resolveDbPath({ observerPath: src });

  const dest = await openDb(config);
  if (!dest.available) {
    process.stderr.write(c.red("error:") + " observer DB unavailable (better-sqlite3 not installed)\n");
    return 1;
  }
  if (samePath(srcPath, dest.path)) {
    process.stderr.write(c.red("error:") + " source and destination are the same database (" + dest.path + ")\n");
    return 2;
  }
  if (!fs.existsSync(srcPath)) {
    process.stderr.write(c.red("error:") + " source DB not found: " + srcPath + "\n");
    return 1;
  }

  // Source DB: read-only and UNCACHED so the active DB stays open beside it.
  let srcHandle;
  try {
    srcHandle = await openDbAt(srcPath, { readonly: true });
  } catch (e) {
    process.stderr.write(c.red("error:") + " could not open source DB: " + e.message + "\n");
    return 1;
  }
  if (!srcHandle.available) {
    process.stderr.write(c.red("error:") + " observer DB unavailable (better-sqlite3 not installed)\n");
    return 1;
  }

  try {
    const workflow = args.workflow || null;   // null = all workflows
    const readOpts = { workflow: workflow, includeDismissed: true };
    let incoming;
    try {
      incoming = allEvents(srcHandle, readOpts);
    } catch (e) {
      process.stderr.write(c.red("error:") + " source is not an observer database (" + e.message + ")\n");
      return 1;
    }
    const existing = allEvents(dest, readOpts);

    const plan = planMerge(existing, incoming, sigOf, {
      includeDismissed: !!args["include-dismissed"],
    });

    const tail = ", skipped " + plan.dupSkipped + " duplicate(s)" +
      (plan.dismissedSkipped > 0 ? ", skipped " + plan.dismissedSkipped + " dismissed" : "") +
      " (source had " + plan.scanned + ")";

    if (args["dry-run"]) {
      process.stdout.write(c.cyan("dry-run:") + " would merge " + plan.inserted + " new event(s)" + tail + "\n");
      return 0;
    }

    for (const r of plan.toInsert) {
      insertEvent(dest, {
        ts:          r.ts,
        workflow:    r.workflow || "rtl",
        project_id:  r.project_id || null,
        module_id:   r.module_id || null,
        stage_key:   r.stage_key || null,
        event_kind:  r.event_kind,
        raw_input:   r.raw_input || null,
        extracted:   r.extracted || null,
        severity:    r.severity || "info",
      });
    }

    process.stdout.write(c.green("✓") + " merged " + plan.inserted + " new event(s)" + tail + "\n");
    process.stdout.write(c.dim("source: " + srcPath) + "\n");
    process.stdout.write(c.dim("dest:   " + dest.path) + "\n");
    return 0;
  } finally {
    try { srcHandle.db.close(); } catch (_e) { /* ignore */ }
  }
}

/** True when two paths resolve to the same file (realpath, with a resolve fallback). */
function samePath(a, b) {
  function norm(p) {
    try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); }
  }
  return norm(a) === norm(b);
}

/**
 * Signature for dedupe: ts + workflow + stage + kind + summary.
 * Exported for unit testing.
 */
export function sigOf(e) {
  const ex = e.extracted || {};
  return [e.ts, e.workflow || "", e.stage_key || "", e.event_kind || "",
    (ex.summary || "").slice(0, 100)].join("|");
}

/**
 * Parse a JSON blob (string) into a normalized array of observer-event
 * rows. Accepts three input shapes:
 *   - {events: [...]}    — from `observe export`
 *   - {<key>: <row>, ...} — raw localStorage dump (values are events or JSON strings)
 *   - [<row>, ...]        — bare array
 *
 * Filters out anything that isn't an observer-shaped event (missing
 * event_kind or ts). Exported for unit testing.
 */
export function parseImportPayload(rawText) {
  const parsed = JSON.parse(rawText);
  let rows;
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && Array.isArray(parsed.events)) {
    rows = parsed.events;
  } else if (parsed && typeof parsed === "object") {
    rows = [];
    for (const v of Object.values(parsed)) {
      if (v == null) continue;
      if (typeof v === "string") {
        try { rows.push(JSON.parse(v)); } catch (_e) { /* skip non-JSON */ }
      } else if (typeof v === "object") {
        rows.push(v);
      }
    }
  } else {
    throw new Error("input is not an object or array");
  }
  return rows.filter(function(r) {
    return r && typeof r === "object" && r.event_kind && r.ts;
  });
}

export async function cmdObserve(args) {
  const sub = args._[0] || "show";
  const config = loadConfig({ flags: args });

  if (sub === "show")            return cmdShow(args, config);
  if (sub === "list")            return cmdList(args, config);
  if (sub === "path")            return cmdPath(args, config);
  if (sub === "dismiss")         return cmdDismiss(args, config);
  if (sub === "delete")          return cmdDelete(args, config);
  if (sub === "delete-before")   return cmdDeleteBefore(args, config);
  if (sub === "wipe")            return cmdWipe(args, config);
  if (sub === "export")          return cmdExport(args, config);
  if (sub === "import-browser")  return cmdImportBrowser(args, config);
  if (sub === "merge")           return cmdMerge(args, config);

  process.stderr.write(c.red("error:") + " unknown observe subcommand: " + sub + "\n");
  process.stderr.write(c.dim("  try: show, list, path, dismiss, delete, delete-before, wipe, export, import-browser, merge") + "\n");
  return 2;
}
