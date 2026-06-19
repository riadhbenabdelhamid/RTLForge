// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// observer/sqlite — Thin wrapper over better-sqlite3 for the observer KB
//
// Single point of contact with the database. Other observer modules
// (ingest, extractor, CLI commands) go through `openDb()` and use the
// query helpers exposed here.
//
// SCHEMA: see schemaSql below. The migration is one-shot; future versions add
// migration steps inside `migrate()`.
//
// PATH RESOLUTION:
//   config.observerPath       — explicit path (preferred, set by user)
//   ~/.rtlforge/observer.db   — default location otherwise
//
// `better-sqlite3` is a synchronous native module. It's a hard dep of
// the observer subsystem. If it isn't installed (e.g. CI before npm
// install completes), the wrapper falls back to a no-op stub so the
// CLI doesn't crash — the observer simply records nothing. We log a
// warning the first time.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SCHEMA_VERSION = 1;
let _dbCache = null;
let _warnedMissingDep = false;

/**
 * Resolve the observer DB path. `config.observerPath` wins; otherwise
 * we fall back to ~/.rtlforge/observer.db.
 */
export function resolveDbPath(config) {
  if (config && config.observerPath) {
    // Expand ~ at the start for user-friendliness
    let p = config.observerPath;
    if (p.startsWith("~/") || p === "~") p = path.join(os.homedir(), p.slice(1));
    return p;
  }
  return path.join(process.env.RTLFORGE_HOME || path.join(os.homedir(), ".rtlforge"),
    "observer.db");
}

/**
 * Try to load better-sqlite3. Returns the constructor or null when
 * the native module isn't available.
 */
async function loadDriver() {
  try {
    const mod = await import("better-sqlite3");
    return mod.default || mod;
  } catch (_e) {
    if (!_warnedMissingDep) {
      _warnedMissingDep = true;
      // eslint-disable-next-line no-console
      console.warn("[observer] better-sqlite3 not installed; observer will run in no-op mode. Install with `npm i better-sqlite3` to enable.");
    }
    return null;
  }
}

/**
 * Returns the current Db instance, opening it (and running migrations)
 * on first use. Pass `config` so we can resolve the path.
 *
 * @returns {Promise<{db: any|null, path: string, available: boolean}>}
 */
export async function openDb(config) {
  const dbPath = resolveDbPath(config);
  if (_dbCache && _dbCache.path === dbPath) return _dbCache;
  // Path changed (user updated config.observerPath) → re-open
  if (_dbCache && _dbCache.db && _dbCache.path !== dbPath) {
    try { _dbCache.db.close(); } catch (_e) { /* ignore */ }
    _dbCache = null;
  }

  const Driver = await loadDriver();
  if (!Driver) {
    _dbCache = { db: null, path: dbPath, available: false };
    return _dbCache;
  }
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o755 });
  } catch (_e) { /* dir may already exist */ }
  const db = new Driver(dbPath);
  // Pragmas for safety + speed
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  _dbCache = { db: db, path: dbPath, available: true };
  return _dbCache;
}

/**
 * Open a SPECIFIC db path WITHOUT touching the module cache. Used when a
 * command needs a second database open alongside the cached active one —
 * e.g. `observe merge` reads a source DB while writing the active DB, and
 * the single-slot cache in openDb() would otherwise close one to open the
 * other. The CALLER owns the returned handle and must close it
 * (handle.db.close()).
 *
 *   opts.readonly  — open read-only: the file must already exist and no
 *                    migration runs (a read-only DB can't be written to).
 *
 * @returns {Promise<{db: any|null, path: string, available: boolean}>}
 */
export async function openDbAt(dbPath, opts) {
  const o = opts || {};
  const Driver = await loadDriver();
  if (!Driver) return { db: null, path: dbPath, available: false };
  const db = new Driver(dbPath, {
    readonly:      !!o.readonly,
    fileMustExist: !!o.readonly || !!o.fileMustExist,
  });
  if (!o.readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    migrate(db);
  }
  return { db: db, path: dbPath, available: true };
}

/**
 * Run pending migrations. Idempotent — safe to call on every open.
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observer_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS observer_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             INTEGER NOT NULL,
      workflow       TEXT NOT NULL,
      project_id     TEXT,
      module_id      TEXT,
      stage_key      TEXT,
      event_kind     TEXT NOT NULL,
      raw_input      TEXT,
      extracted      TEXT,
      severity       TEXT,
      flag_dismissed INTEGER DEFAULT 0,
      notes          TEXT,
      cluster_id     INTEGER,
      embedding      BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_events_workflow ON observer_events (workflow);
    CREATE INDEX IF NOT EXISTS idx_events_ts       ON observer_events (ts);
    CREATE INDEX IF NOT EXISTS idx_events_kind     ON observer_events (event_kind);
    CREATE INDEX IF NOT EXISTS idx_events_dismiss  ON observer_events (flag_dismissed);

    CREATE TABLE IF NOT EXISTS observer_clusters (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      summary     TEXT,
      count       INTEGER DEFAULT 1,
      first_seen  INTEGER,
      last_seen   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_clusters_workflow_kind ON observer_clusters (workflow, kind);
  `);
  // Stamp the schema version (helps if we add migrations later)
  const row = db.prepare("SELECT value FROM observer_meta WHERE key = ?").get("schema_version");
  if (!row) {
    db.prepare("INSERT INTO observer_meta (key, value) VALUES (?, ?)")
      .run("schema_version", String(SCHEMA_VERSION));
  }
}

// ── Query helpers ──────────────────────────────────────────────────────────

/**
 * Insert one event. Returns the inserted row id (or null if the
 * observer is in no-op mode).
 */
export function insertEvent(handle, row) {
  if (!handle || !handle.db) return null;
  const stmt = handle.db.prepare(`
    INSERT INTO observer_events
      (ts, workflow, project_id, module_id, stage_key, event_kind,
       raw_input, extracted, severity, notes, cluster_id, embedding)
    VALUES (@ts, @workflow, @project_id, @module_id, @stage_key, @event_kind,
            @raw_input, @extracted, @severity, @notes, @cluster_id, @embedding)
  `);
  const r = stmt.run({
    ts:          row.ts || Date.now(),
    workflow:    row.workflow || "rtl",
    project_id:  row.project_id || null,
    module_id:   row.module_id || null,
    stage_key:   row.stage_key || null,
    event_kind:  row.event_kind || "error",
    raw_input:   row.raw_input != null ? JSON.stringify(row.raw_input) : null,
    extracted:   row.extracted != null ? JSON.stringify(row.extracted) : null,
    severity:    row.severity || "info",
    notes:       row.notes || null,
    cluster_id:  row.cluster_id || null,
    embedding:   row.embedding || null,
  });
  return r.lastInsertRowid;
}

/**
 * Query events with optional filters. Returns at most `limit` rows.
 */
export function queryEvents(handle, opts) {
  if (!handle || !handle.db) return [];
  const o = opts || {};
  const where = [];
  const params = {};
  if (o.workflow)        { where.push("workflow = @workflow");           params.workflow = o.workflow; }
  if (o.kind)            { where.push("event_kind = @kind");              params.kind = o.kind; }
  if (o.severity)        { where.push("severity = @severity");            params.severity = o.severity; }
  if (o.includeDismissed !== true) where.push("flag_dismissed = 0");
  if (o.since)           { where.push("ts >= @since");                    params.since = o.since; }
  if (o.until)           { where.push("ts <  @until");                    params.until = o.until; }
  if (o.stageKey)        { where.push("stage_key = @stage_key");          params.stage_key = o.stageKey; }
  if (o.projectId)       { where.push("project_id = @project_id");        params.project_id = o.projectId; }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.min(o.limit || 200, 5000);
  const stmt = handle.db.prepare(`
    SELECT * FROM observer_events ${whereSql}
    ORDER BY ts DESC
    LIMIT ${limit}
  `);
  const rows = stmt.all(params);
  // Re-hydrate JSON columns for caller convenience
  for (const r of rows) {
    if (r.raw_input)  { try { r.raw_input  = JSON.parse(r.raw_input);  } catch (_e) { /* keep string */ } }
    if (r.extracted)  { try { r.extracted  = JSON.parse(r.extracted);  } catch (_e) { /* keep string */ } }
  }
  return rows;
}

/**
 * Return ALL events with no row cap (queryEvents clamps at 5000) for bulk
 * operations like `observe merge`. Optional workflow filter; dismissed rows
 * are INCLUDED by default so a merge can decide per-row whether to carry
 * them. Rows are returned oldest-first and JSON columns are re-hydrated.
 */
export function allEvents(handle, opts) {
  if (!handle || !handle.db) return [];
  const o = opts || {};
  const where = [];
  const params = {};
  if (o.workflow)                  { where.push("workflow = @workflow"); params.workflow = o.workflow; }
  if (o.includeDismissed === false) where.push("flag_dismissed = 0");
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = handle.db.prepare(`
    SELECT * FROM observer_events ${whereSql}
    ORDER BY ts ASC
  `).all(params);
  for (const r of rows) {
    if (r.raw_input)  { try { r.raw_input  = JSON.parse(r.raw_input);  } catch (_e) { /* keep string */ } }
    if (r.extracted)  { try { r.extracted  = JSON.parse(r.extracted);  } catch (_e) { /* keep string */ } }
  }
  return rows;
}

/**
 * Dismiss (soft-delete) an event by id.
 */
export function dismissEvent(handle, id) {
  if (!handle || !handle.db) return false;
  const r = handle.db.prepare("UPDATE observer_events SET flag_dismissed = 1 WHERE id = ?").run(id);
  return r.changes > 0;
}

/**
 * Hard delete an event by id.
 */
export function deleteEvent(handle, id) {
  if (!handle || !handle.db) return false;
  const r = handle.db.prepare("DELETE FROM observer_events WHERE id = ?").run(id);
  return r.changes > 0;
}

/**
 * Delete events before a given timestamp. Returns deleted count.
 */
export function deleteEventsBefore(handle, ts) {
  if (!handle || !handle.db) return 0;
  const r = handle.db.prepare("DELETE FROM observer_events WHERE ts < ?").run(ts);
  return r.changes;
}

/**
 * Wipe the whole DB (all events + clusters). Caller is responsible for
 * confirming with the user — this is unrecoverable.
 */
export function wipeAll(handle) {
  if (!handle || !handle.db) return false;
  handle.db.exec("DELETE FROM observer_events; DELETE FROM observer_clusters;");
  return true;
}

/**
 * Aggregated summary: count of events per kind, per workflow.
 */
export function summary(handle, opts) {
  if (!handle || !handle.db) return { totals: [], byKind: [] };
  const o = opts || {};
  const whereSql = o.workflow ? "WHERE workflow = @workflow" : "";
  const params = o.workflow ? { workflow: o.workflow } : {};
  const totals = handle.db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN flag_dismissed = 0 THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) AS high
    FROM observer_events ${whereSql}
  `).get(params);
  const byKind = handle.db.prepare(`
    SELECT event_kind AS kind, COUNT(*) AS n
    FROM observer_events ${whereSql}
    GROUP BY event_kind
    ORDER BY n DESC
  `).all(params);
  return { totals: totals, byKind: byKind };
}

export function closeAll() {
  if (_dbCache && _dbCache.db) {
    try { _dbCache.db.close(); } catch (_e) { /* ignore */ }
  }
  _dbCache = null;
}
