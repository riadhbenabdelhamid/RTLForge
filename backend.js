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
//   npm install express cors
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
import { tmpdir } from "os";
import { execSync, spawn } from "child_process";
import { sanitizeFilename, SanitizeError } from "./backend/sanitize.js";

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
let activeProcess = null;

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
  const workDir = mkdtempSync(join(tmpdir(), "rtlforge-backend-"));
  try {
    // Timeout is configurable from the frontend.
    // The hardcoded 120_000ms (2 min) was insufficient for real Verilator
    // builds of larger designs. We accept `body.timeoutMs` (per-command,
    // not aggregate) and clamp to a reasonable range so a buggy/malicious
    // client cannot pin a worker indefinitely.
    const requestedTimeout = parseInt(body.timeoutMs, 10);
    const cmdTimeoutMs = (Number.isFinite(requestedTimeout) && requestedTimeout > 0)
      ? Math.min(Math.max(requestedTimeout, 5_000), 3_600_000)  // 5s..1h
      : 600_000;                                                // default 10 min

    // Stage files
    const files = body.files || {};
    for (const [name, content] of Object.entries(files)) {
      const safe = sanitizeFilename(name);
      writeFileSync(join(workDir, safe), content);
    }

    // Determine command(s) to run
    const commands = body.commands
      ? body.commands
      : body.command
        ? [body.command]
        : [];

    let allStdout = "";
    let allStderr = "";
    let lastExitCode = 0;

    for (const cmd of commands) {
      // Replace {RTL}, {TB}, {SVA} placeholders with staged filenames.
      // Use global regex replace so commands like
      //   `verilator --binary {RTL} -o {RTL}.bin`
      // get every occurrence substituted, not just the first.
      let expanded = cmd;
      for (const name of Object.keys(files)) {
        const safe = sanitizeFilename(name);
        if (name.endsWith(".sv") || name.endsWith(".v")) {
          if (name.includes("_tb")) expanded = expanded.replace(/\{TB\}/g, safe);
          else if (name.includes("_sva")) expanded = expanded.replace(/\{SVA\}/g, safe);
          else expanded = expanded.replace(/\{RTL\}/g, safe);
        }
      }

      const result = await new Promise((resolve) => {
        const proc = spawn("sh", ["-c", expanded], {
          cwd: workDir,
          timeout: cmdTimeoutMs,
          env: Object.assign({}, process.env, { TERM: "dumb" }),
        });
        activeProcess = proc;

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("close", (code) => {
          activeProcess = null;
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
        proc.on("error", (e) => {
          activeProcess = null;
          resolve({ stdout, stderr: stderr + "\n" + e.message, exitCode: 127 });
        });
      });

      allStdout += result.stdout;
      allStderr += result.stderr;
      lastExitCode = result.exitCode;

      // Stop on failure for sequential commands
      if (lastExitCode !== 0 && commands.length > 1) break;
    }

    // Harvest known output files from the working
    // directory before cleanup so the client can read them. Verilator
    // writes coverage data to logs/coverage.dat by default; we surface
    // it under a `files` map keyed by relative path so the client's
    // verify.js can parse it.
    //
    // We capture a fixed allow-list of paths (no recursive scan) to
    // keep the response payload bounded and predictable. The list
    // covers Verilator's standard output locations + a few common
    // conventions (covgroup XML, FST traces). Each captured file is
    // size-capped at 1 MB to avoid huge payloads.
    const HARVEST_PATHS = [
      "logs/coverage.dat",     // Verilator --coverage default
      "coverage.dat",          // alt location
      "logs/coverage.info",    // some configs use this name
      "coverage.xml",          // covgroup XML
    ];
    const MAX_HARVEST_BYTES = 1_000_000;  // 1 MB per file
    const harvestedFiles = {};
    for (const relPath of HARVEST_PATHS) {
      try {
        const abs = join(workDir, relPath);
        if (existsSync(abs)) {
          const st = statSync(abs);
          if (st.isFile() && st.size <= MAX_HARVEST_BYTES) {
            harvestedFiles[relPath] = readFileSync(abs, "utf8");
          }
        }
      } catch (_e) { /* best-effort; ignore */ }
    }

    return {
      stdout: allStdout,
      stderr: allStderr,
      exitCode: lastExitCode,
      workDir,
      // Output files harvested from workDir
      files: harvestedFiles,
    };
  } finally {
    // Clean up
    try { rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
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

  // Abort
  if (url === "/api/abort" && req.method === "POST") {
    if (activeProcess) {
      try { activeProcess.kill("SIGTERM"); } catch (_) {}
      activeProcess = null;
    }
    return sendJSON(res, 200, { ok: true });
  }

  // Execute
  if (url === "/api/execute" && req.method === "POST") {
    try {
      const body = await readBody(req);
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
  console.log("  ────────────────────────────────────");
  console.log("  Ready. Configure in RTL Forge → Settings → CLI");
  console.log("");
});
