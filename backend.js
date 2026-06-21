#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// backend.js — RTL Forge Verilator/Yosys CLI Backend
//
// Express server that runs EDA tool commands on behalf of the browser UI.
// Required for real (non-LLM-estimated) lint and simulation results.
//
// Usage:
//   node backend.js                     # default port 3001
//   PORT=5174 node backend.js           # custom port
//
// The frontend connects to this via the backend URL configured in
// Settings → CLI (default: http://localhost:3001).
//
// Prerequisites:
//   Node 18+ (uses only node:http — no express/cors deps needed)
//   Verilator 5.x in PATH (for --lint-only and --binary)
//
// Endpoints:
//   GET  /api/health    — returns { ok: true, verilator: "Verilator X.XXX ..." }
//   POST /api/execute   — stages files, runs command, returns { stdout, stderr, exitCode }
//   POST /api/abort     — kills any running child process
// ═══════════════════════════════════════════════════════════════════════════

import { createServer } from "http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir, cpus } from "os";
import { randomUUID } from "crypto";
import { execSync, spawn } from "child_process";
import { sanitizeFilename, SanitizeError } from "./backend/sanitize.js";
import { createTaskRegistry } from "./backend/taskRegistry.js";
// Shared execution core — the HTTP backend and the embedded CLI path (#23)
// run the SAME implementation so they can't drift.
import { executeLocal } from "./src/cli/localExecutor.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
// Security:
//   - HOST defaults to 127.0.0.1 so a fresh `node backend.js` is NOT
//     reachable from other machines on the LAN. Set HOST=0.0.0.0 to opt
//     into wider exposure (e.g. for a remote dev box) — but understand
//     that `/api/execute` runs arbitrary shell with no auth.
//   - ALLOW_ORIGIN gates which browser origins receive CORS headers. By
//     default we allow only http(s)://localhost:* and http(s)://127.0.0.1:*
//     plus same-origin requests (no Origin header). Set ALLOW_ORIGIN=*
//     to revert to wildcard behaviour, or pass a comma-separated list of
//     origins to whitelist explicitly.
//   - MAX_BODY_BYTES bounds JSON-body size to defend against memory-pinning
//     by malicious clients. Default 10 MB; large enough for the biggest
//     file bundle the frontend ships, small enough to not become a DoS.
const HOST = process.env.HOST || "127.0.0.1";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || ""; // "" → localhost-only default
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || "10485760", 10); // 10 MB

// Task registry (#18): bounds concurrent builds and enables per-task abort.
// Default cap = CPU count — a safety ceiling that rarely throttles a real
// parallel wave; set RTLFORGE_MAX_CONCURRENT=1 to force strict single-flight.
const MAX_CONCURRENT = parseInt(process.env.RTLFORGE_MAX_CONCURRENT || "0", 10) || cpus().length;
const registry = createTaskRegistry({ maxConcurrent: MAX_CONCURRENT });

// ─── CORS middleware (manual — no express dependency needed) ────────────────

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / no Origin header
  if (ALLOW_ORIGIN === "*") return true;
  if (ALLOW_ORIGIN) {
    const list = ALLOW_ORIGIN.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    return list.indexOf(origin) >= 0;
  }
  // Default allow-list: localhost / 127.0.0.1 on any port, http or https.
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(req, res) {
  const origin = req.headers.origin || "";
  if (!isAllowedOrigin(origin)) return false;
  // Echo the specific origin back rather than `*` so credentials-mode
  // requests work and we don't grant access to disallowed origins.
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      total += c.length;
      // Bound body size to defend against memory-pinning.
      // The malicious client cannot read the response body cross-origin,
      // but they can still cause us to allocate unbounded memory.
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        const err = new Error("Request body exceeds " + MAX_BODY_BYTES + " bytes");
        err.statusCode = 413;
        reject(err);
        try { req.destroy(); } catch (_) { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on("error", (e) => { if (!aborted) reject(e); });
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Filename sanitization is imported from ./backend/sanitize.js
// — see that file for charset rules and rationale.

// ─── Verilator version detection ───────────────────────────────────────────

let verilatorVersion = "not found";
try {
  verilatorVersion = execSync("verilator --version", { encoding: "utf8" }).trim();
} catch (_) {
  console.warn("⚠ Verilator not found in PATH — lint/sim will fail. Install Verilator 5.x first.");
}

// ─── Execute handler ───────────────────────────────────────────────────────

async function handleExecute(body) {
  // Per-task identity + lifecycle (#18). The client generates the taskId and
  // sends it in the body so it can abort THIS task by id while it runs (the
  // HTTP response only returns once the command finishes). Legacy clients omit
  // it → we mint one. `currentChild` is the live child the kill() closure
  // targets; the registry decides when this task may run and which to kill.
  const taskId = (body && body.taskId) || randomUUID();
  let currentChild = null;
  const task = {
    id: taskId,
    label: (body && (body.command || (body.commands && body.commands[0]))) || null,
    kill: function() { if (currentChild) { try { currentChild.kill("SIGTERM"); } catch (_) {} } },
  };
  try {
    await registry.admit(task);            // waits for a free slot (FIFO)
  } catch (_aborted) {
    // Aborted while queued — never spawned.
    return { stdout: "", stderr: "aborted", exitCode: 130, taskId: taskId, aborted: true };
  }

  try {
    const result = await executeLocal(body, { onSpawn: function(proc) { currentChild = proc; } });
    return Object.assign({ taskId: taskId }, result);
  } finally {
    // Release the registry slot on every exit path so a crash/throw can't
    // strand a slot; admits the next queued task.
    registry.complete(taskId);
  }
}

// ─── HTTP server ───────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // corsHeaders consults the origin allow-list and returns
  // false if the origin is rejected. We still serve the request (so the
  // backend operator sees the hit in logs and can debug misconfigured
  // origins) but without CORS headers, which causes the browser to drop
  // the response. For preflights we reject with 403.
  const corsOk = corsHeaders(req, res);

  // Handle preflight
  if (req.method === "OPTIONS") {
    if (!corsOk) {
      res.writeHead(403);
      return res.end();
    }
    res.writeHead(204);
    return res.end();
  }

  const url = req.url.split("?")[0];

  // Health check
  if (url === "/api/health" && req.method === "GET") {
    return sendJSON(res, 200, { ok: true, verilator: verilatorVersion });
  }

  // Abort — by taskId (targeted) or, with no/empty body, ALL running+queued
  // tasks. The legacy no-body call now kills everything instead of just the
  // latest child, which fixes aborting a parallel wave (#18).
  if (url === "/api/abort" && req.method === "POST") {
    let abortBody = {};
    try { abortBody = await readBody(req); } catch (_) { abortBody = {}; }
    const aborted = (abortBody && abortBody.taskId)
      ? (registry.abort(abortBody.taskId) ? [abortBody.taskId] : [])
      : registry.abortAll();
    return sendJSON(res, 200, { ok: true, aborted: aborted });
  }

  // Task list — running + queued tasks, for visibility/debugging.
  if (url === "/api/tasks" && req.method === "GET") {
    return sendJSON(res, 200, { tasks: registry.list(), maxConcurrent: MAX_CONCURRENT });
  }

  // Execute
  if (url === "/api/execute" && req.method === "POST") {
    try {
      const body = await readBody(req);
      // Pin the task id at the handler level so a client disconnect (fetch
      // aborted / timed out) can drop the queued/running task instead of
      // stranding a registry slot (#18).
      if (body && !body.taskId) body.taskId = randomUUID();
      const tid = body && body.taskId;
      if (tid) {
        req.on("close", function() {
          if (!res.writableEnded) registry.abort(tid);
        });
      }
      const result = await handleExecute(body);
      return sendJSON(res, 200, result);
    } catch (e) {
      // Surface oversized-body 413 explicitly.
      if (e && e.statusCode === 413) {
        return sendJSON(res, 413, { error: e.message });
      }
      // Surface unsafe-filename rejections as 400 so the frontend
      // can show a helpful error rather than letting them bleed through as
      // generic 500s.
      if (e && e.name === "SanitizeError") {
        return sendJSON(res, 400, {
          error: e.message,
          unsafeName: e.unsafeName,
          reason: e.reason,
        });
      }
      return sendJSON(res, 500, { error: e.message });
    }
  }

  sendJSON(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ⚡ RTL Forge Backend");
  console.log("  ────────────────────────────────────");
  console.log("  Bind:       " + HOST + ":" + PORT);
  console.log("  Verilator:  " + verilatorVersion);
  console.log("  Health:     http://localhost:" + PORT + "/api/health");
  console.log("  CORS:       " + (ALLOW_ORIGIN === "*" ? "wildcard (any origin)"
                                : ALLOW_ORIGIN ? "list: " + ALLOW_ORIGIN
                                : "localhost-only (default)"));
  console.log("  Body cap:   " + MAX_BODY_BYTES + " bytes");
  console.log("  Max tasks:  " + MAX_CONCURRENT + " concurrent (RTLFORGE_MAX_CONCURRENT)");
  console.log("  ────────────────────────────────────");
  console.log("  Ready. Configure in RTL Forge → Settings → CLI");
  console.log("");
});
