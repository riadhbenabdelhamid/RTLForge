// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// runCli — POST files+commands to local backend (Verilator/Yosys/etc)
//
// Returns null when no backend is configured (LLM fallback path).
// Returns { _error: true, _msg } on transient failures.
// Re-throws AbortError so callers can distinguish user-initiated cancels.
//
// Robustness against silent LLM fallback:
//   - Configurable per-request timeout (default 600s). An unbounded request
//     would inherit the browser's hidden ~5min timeout — the most common cause
//     of "verify silently fell back to LLM" reports.
//   - Configurable retry count for transient errors (network drops, HTTP 5xx,
//     timeouts). Each retry waits with exponential backoff.
//   - The returned `_error` payload carries `_attempts` so callers can tell
//     whether retries were exhausted.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Custom error class so callers can `instanceof` check and bubble up cleanly.
 */
export class CliBackendError extends Error {
  constructor(msg, attempts) {
    super(msg);
    this.name    = "CliBackendError";
    this.attempts = attempts || 1;
    this.isCliBackendError = true;
  }
}

// Sentinel backendUrl that selects in-process execution (#23): no HTTP server,
// runCli imports localExecutor.js and runs Verilator directly. Node-only.
export const LOCAL_BACKEND = "local";

// The localExecutor specifier is held in a variable on purpose: it keeps the
// dynamic import NON-analyzable so neither vite nor esbuild tries to bundle a
// node-only module into the browser build. The browser never executes these
// imports anyway — every call site is gated by isNode() first.
const LOCAL_EXECUTOR_MODULE = "./localExecutor.js";

function isNode() {
  return typeof process !== "undefined" && !!(process.versions && process.versions.node);
}

function importLocalExecutor() {
  return import(/* @vite-ignore */ LOCAL_EXECUTOR_MODULE);
}

// Task registry, client side (#18). Each runCli call carries a client-generated
// taskId in the request body so a specific RUNNING task can be aborted by id
// (the /api/execute response only returns once the command finishes, so a
// server-assigned id would arrive too late). `activeTasks` tracks in-flight ids.
const activeTasks = new Set();

/** Generate a unique task id (crypto.randomUUID when available, else a fallback). */
export function genTaskId() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch (_) { /* fall through */ }
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/**
 * Body for POST /api/abort. A taskId aborts exactly that task; omitting it
 * aborts ALL running+queued tasks (the global-cancel path the GUI uses, now
 * correct under concurrency).
 */
export function buildAbortBody(taskId) {
  return taskId ? { taskId: taskId } : { all: true };
}

/**
 * Sleep helper.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function _sleep(ms, signal) {
  return new Promise(function(resolve, reject) {
    if (signal && signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let onAbort = null;
    const t = setTimeout(function() {
      // Improvement A1: detach the abort listener on normal completion
      // (previously the listener stayed attached to the user's signal for its
      // entire lifetime — leaking one reference per sleep call).
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = function() {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Single-shot request to the backend. Returns the parsed JSON, or throws.
 */
async function _executeOnce(backendUrl, payload, signal, timeoutMs) {
  // Compose a timeout signal if asked. We need to merge with the user-provided
  // abort signal so user cancels still work, AND so the timeout still fires.
  //
  // Improvement A1: previously the abort listener attached to `signal` was
  // never removed, and the timeout setTimeout was never cleared on success.
  // Both leaked references for the duration of timeoutMs (or forever, if
  // the user signal lived longer). Across hundreds of pipeline calls this
  // accumulated. We now track both and clean them up in a finally block.
  let timeoutCtl = null;
  let timeoutId = null;
  let onUserAbort = null;
  let combinedSignal = signal || null;
  if (timeoutMs && typeof AbortController !== "undefined") {
    timeoutCtl = new AbortController();
    if (signal) {
      if (signal.aborted) timeoutCtl.abort();
      else {
        onUserAbort = function() { try { timeoutCtl.abort(); } catch (_) {} };
        signal.addEventListener("abort", onUserAbort, { once: true });
      }
    }
    combinedSignal = timeoutCtl.signal;
    timeoutId = setTimeout(function() {
      try { timeoutCtl.abort(new Error("backend request timed out after " + Math.round(timeoutMs / 1000) + "s")); }
      catch (_) { try { timeoutCtl.abort(); } catch (__) {} }
    }, timeoutMs);
  }

  function _cleanup() {
    if (timeoutId != null) { clearTimeout(timeoutId); timeoutId = null; }
    if (signal && onUserAbort) {
      signal.removeEventListener("abort", onUserAbort);
      onUserAbort = null;
    }
  }

  // Improvement A1: include timeoutMs in the request body so the backend can
  // tune its per-spawn timeout to match the browser's expectation. Backend
  // clamps to a safe range (5s..1h). Subtract a small buffer so the backend
  // returns a clean error before the browser side aborts and we lose any
  // partial output.
  const backendTimeoutMs = timeoutMs ? Math.max(5_000, timeoutMs - 5_000) : null;
  const enrichedPayload = backendTimeoutMs
    ? Object.assign({}, payload, { timeoutMs: backendTimeoutMs })
    : payload;

  const fetchOpts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(enrichedPayload),
  };
  if (combinedSignal) fetchOpts.signal = combinedSignal;

  try {
    let resp;
    try {
      resp = await fetch(backendUrl + "/api/execute", fetchOpts);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (timeoutCtl && timeoutCtl.signal && timeoutCtl.signal.aborted) {
        throw new Error("Backend request timed out after " + Math.round(timeoutMs / 1000) + "s");
      }
      throw e;
    }
    if (!resp.ok) {
      // Try to extract structured error info on 400s so the user
      // gets a useful message instead of "Backend returned HTTP 400".
      try {
        const errData = await resp.json();
        if (errData && errData.error) throw new Error("Backend rejected request: " + errData.error);
      } catch (_) { /* fall through */ }
      throw new Error("Backend returned HTTP " + resp.status);
    }
    return await resp.json();
  } finally {
    _cleanup();
  }
}

/**
 * In-process execution (#23): dynamically import the node-only localExecutor
 * and run the command bundle directly. The import is guarded by isNode() and a
 * vite-ignore hint so the browser bundle never resolves a node-only module.
 */
async function runLocal(payload, signal, o) {
  if (!isNode()) {
    return { _error: true, _msg: "local backend requires Node (not available in this runtime)", _attempts: 1 };
  }
  const timeoutMs = (o.timeoutMs == null) ? 600000 : Math.max(1000, o.timeoutMs | 0);
  const logger = o.logger || null;
  const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const mod = await importLocalExecutor();
    // Wire the user's abort signal to kill the in-flight child.
    let onAbort = null;
    if (signal) { onAbort = function() { try { mod.abortLocal(); } catch (_) { /* ignore */ } }; signal.addEventListener("abort", onAbort, { once: true }); }
    let result;
    try { result = await mod.executeLocal(payload, { timeoutMs: timeoutMs }); }
    finally { if (signal && onAbort) signal.removeEventListener("abort", onAbort); }
    if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (logger && typeof logger.cli === "function") {
      const latencyMs = Math.round(((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0);
      const cmds = payload.commands || (payload.command ? [payload.command] : []);
      logger.cli({
        command: cmds.join(" && "),
        stdout: (result && result.stdout) || "",
        stderr: (result && result.stderr) || "",
        exitCode: (result && result.exitCode != null) ? result.exitCode : null,
        latencyMs: latencyMs,
        attempt: 1,
      });
    }
    return result;
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return { _error: true, _msg: "local execution failed: " + ((e && e.message) || String(e)), _attempts: 1 };
  }
}

/**
 * Execute a command on the backend with the given files staged.
 *
 * @param {string} backendUrl   e.g. "http://localhost:5174" or "local"
 * @param {object} payload      { command|commands, files: { name: contents } }
 * @param {AbortSignal} signal  Optional abort signal (user-initiated)
 * @param {object} [opts]
 * @param {number} [opts.retries=1]      transient-error retry budget (default 1)
 * @param {number} [opts.timeoutMs=600000] per-attempt timeout (default 10 min)
 * @returns {Promise<object|null>}  null if no backend configured.
 *                                  On success: backend payload.
 *                                  On exhausted-retry failure: { _error, _msg, _attempts }.
 */
export async function runCli(backendUrl, payload, signal, opts) {
  if (!backendUrl) return null;
  const o = opts || {};
  // Embedded path (#23): run the tools in-process, no HTTP, no retry ladder
  // (there's no network to flake). Same return shape as the HTTP path.
  if (backendUrl === LOCAL_BACKEND) return runLocal(payload, signal, o);
  const retries   = (o.retries == null) ? 1 : Math.max(0, o.retries | 0);
  const timeoutMs = (o.timeoutMs == null) ? 600000 : Math.max(1000, o.timeoutMs | 0);
  // Optional logger captures each CLI invocation (command sent, stdout/stderr
  // snippet, exitCode, latencyMs) so the per-step Log panel shows CLI events.
  // Logging at the runCli layer means every caller (verify.js, lint.js,
  // lint_test.js) gets CLI logging for free without duplicating instrumentation.
  const logger = o.logger || null;

  // Stamp a task id into the body so the backend can register this task and
  // abort it by id (#18). Tracked in activeTasks until the call settles.
  const taskId = genTaskId();
  const taskPayload = Object.assign({}, payload, { taskId: taskId });
  if (typeof o.onTaskId === "function") { try { o.onTaskId(taskId); } catch (_) { /* best-effort */ } }
  activeTasks.add(taskId);

  try {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const result = await _executeOnce(backendUrl, taskPayload, signal, timeoutMs);
      const latencyMs = Math.round(((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0);
      if (logger && typeof logger.cli === "function") {
        // Join commands (payload may have `command` or `commands`)
        const cmds = payload.commands || (payload.command ? [payload.command] : []);
        logger.cli({
          command: cmds.join(" && "),
          files:   payload.files ? Object.keys(payload.files).reduce(function(acc, k) {
            // Record file sizes only, not contents (logs can stay readable).
            const v = payload.files[k];
            acc[k] = typeof v === "string" ? v.length : 0;
            return acc;
          }, {}) : {},
          stdout:   (result && result.stdout)   || "",
          stderr:   (result && result.stderr)   || "",
          exitCode: (result && result.exitCode != null) ? result.exitCode : null,
          latencyMs: latencyMs,
          attempt:   attempt,
        });
      }
      return result;
    } catch (e) {
      if (e && e.name === "AbortError") {
        // If user aborted, bubble up. If it was our internal timeout abort,
        // surface as a normal Error (already converted in _executeOnce).
        if (signal && signal.aborted) throw e;
      }
      lastErr = e;
      // Don't retry on the last attempt
      if (attempt > retries) break;
      // Backoff: 250ms * 2^(attempt-1)
      try { await _sleep(250 * Math.pow(2, attempt - 1), signal); }
      catch (_) { throw _; }
    }
  }
  // Also log the failure case so the Log panel makes it clear that a CLI call
  // was attempted even when it never reached the backend.
  const errResult = {
    _error: true,
    _msg: "Cannot reach backend at " + backendUrl + " (" + ((lastErr && lastErr.message) || "network error") + ")",
    _attempts: retries + 1,
  };
  if (logger && typeof logger.cli === "function") {
    const cmds = payload.commands || (payload.command ? [payload.command] : []);
    logger.cli({
      command: cmds.join(" && "),
      stdout: "",
      stderr: errResult._msg,
      exitCode: null,
      latencyMs: null,
      attempt: retries + 1,
      _error: true,
    });
  }
  return errResult;
  } finally {
    activeTasks.delete(taskId);
  }
}

/**
 * Abort backend tasks. With `taskId`, kills exactly that task; without one,
 * kills ALL running+queued tasks (the global-cancel path). Best-effort.
 */
export async function abortBackendTask(backendUrl, taskId) {
  if (!backendUrl) return;
  if (backendUrl === LOCAL_BACKEND) {
    // In-process: kill the single in-flight child directly (#23).
    if (!isNode()) return;
    try { const mod = await importLocalExecutor(); mod.abortLocal(); }
    catch (_) { /* best-effort */ }
    return;
  }
  try {
    await fetch(backendUrl + "/api/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildAbortBody(taskId)),
    });
  } catch (_) { /* best-effort */ }
}

/** Quick health check for the backend. */
export async function testBackendConnection(backendUrl) {
  if (!backendUrl) return { ok: false, msg: "No backend URL configured" };
  if (backendUrl === LOCAL_BACKEND) {
    // In-process: probe Verilator availability directly (#23).
    if (!isNode()) return { ok: false, msg: "local backend requires Node" };
    try {
      const mod = await importLocalExecutor();
      const p = mod.probeLocal();
      return p.ok ? { ok: true, msg: "Embedded (in-process) — " + p.version }
                  : { ok: false, msg: p.error || "verilator not found in PATH" };
    } catch (e) { return { ok: false, msg: (e && e.message) || "local probe failed" }; }
  }
  try {
    const resp = await fetch(backendUrl + "/api/health", { method: "GET" });
    if (!resp.ok) return { ok: false, msg: "HTTP " + resp.status + " — backend responded but rejected the request" };
    const data = await resp.json();
    return { ok: true, msg: "Connected — " + (data.verilator || "backend OK") };
  } catch (e) {
    // Fallback: try /api/execute (older backends without /health)
    try {
      const resp2 = await fetch(backendUrl + "/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "verilator --version", files: {} }),
      });
      if (resp2.ok) {
        const data2 = await resp2.json();
        return { ok: true, msg: "Connected — " + ((data2.stdout || "").trim() || "backend responded OK") };
      }
    } catch (_) { /* fall through */ }
    return {
      ok: false,
      msg: "Cannot reach " + backendUrl + " — " + (e.message || "network error") +
           ". Ensure the backend is running (node backend.js) and has CORS enabled.",
    };
  }
}

/**
 * Parse Verilator-style stderr output into structured warnings + errors.
 * Used by lint and verify nodes.
 */
export function parseCLIOutput(stderr) {
  const warnings = [];
  const errors = [];
  const lines = (stderr || "").split("\n");
  let currentIssue = null;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const wm  = line.match(/%Warning-(\w+):\s*(\S+):(\d+):(\d+):\s*(.*)/);
    const wm2 = line.match(/%Warning-(\w+):\s*(\S+):(\d+):\s*(.*)/);
    const em  = line.match(/%Error-?(\w*):\s*(\S+):(\d+):(\d+):\s*(.*)/);
    const em2 = line.match(/%Error-?(\w*):\s*(\S+):(\d+):\s*(.*)/);

    if (em) {
      currentIssue = { code: em[1] || "SYNTAX", sev: "error", line: parseInt(em[3], 10), col: parseInt(em[4], 10), msg: em[5] };
      errors.push(currentIssue);
    } else if (em2) {
      currentIssue = { code: em2[1] || "SYNTAX", sev: "error", line: parseInt(em2[3], 10), msg: em2[4] };
      errors.push(currentIssue);
    } else if (wm) {
      currentIssue = { code: wm[1], sev: "warning", line: parseInt(wm[3], 10), col: parseInt(wm[4], 10), msg: wm[5] };
      warnings.push(currentIssue);
    } else if (wm2) {
      currentIssue = { code: wm2[1], sev: "warning", line: parseInt(wm2[3], 10), msg: wm2[4] };
      warnings.push(currentIssue);
    } else if (currentIssue && /^\s{2,}/.test(line) && line.trim()) {
      // Continuation line — append to current issue msg
      currentIssue.msg += " " + line.trim();
    } else {
      currentIssue = null;
    }
  }

  return { warnings, errors };
}

/**
 * Extract per-test cycles + wall-time annotations from the verify backend
 * stdout. Accepts several common testbench-emit patterns:
 *
 *   [PASS] t_overflow                       — bare (no metrics)
 *   [PASS] t_overflow @1245 cycles          — cycles only, ' @' delimiter
 *   [PASS] t_overflow @1245c                — short form
 *   [PASS] t_overflow (1245 cycles)         — parens form
 *   [PASS] t_overflow 12.3us                — wall time
 *   [PASS] t_overflow 1245 cy 12.3us        — both
 *   [PASS] t_overflow cycles=1245 time=12.3us
 *
 * Returns { name, status, cyc, ms } where cyc and ms are 0 if not found.
 *
 * Exported so verify.js can swap in real numbers per test instead of zeros.
 */
export function parseTestLine(line) {
  // Match [PASS]/[FAIL] prefix; everything after is the trailer
  const m = line.match(/\[(PASS|FAIL)\]\s+(.*?)\s*$/);
  if (!m) return null;
  const status = m[1];
  const trailer = m[2].trim();

  // Strip metrics off the trailer to recover the bare test name.
  // We try regex patterns in priority order. First match wins.
  let cyc = 0;
  let ms = 0;
  let bare = trailer;

  // Pattern A: keyword form — cycles=N time=N.Nus|ms|s
  const kw = trailer.match(/^(.*?)(?:\s+cycles\s*=\s*(\d+))?(?:\s+time\s*=\s*([\d.]+)\s*(us|ms|s))?\s*$/i);
  if (kw && (kw[2] || kw[3])) {
    bare = kw[1].trim();
    if (kw[2]) cyc = parseInt(kw[2], 10);
    if (kw[3]) ms = unitToMs(parseFloat(kw[3]), kw[4]);
  } else {
    // Pattern B: parenthesised — (N cycles) and/or (N.Nus|ms|s)
    const parens = trailer.match(/^(.*?)(?:\s*\((\d+)\s*cycles?\))?(?:\s*\(([\d.]+)\s*(us|ms|s)\))?\s*$/i);
    if (parens && (parens[2] || parens[3])) {
      bare = parens[1].trim();
      if (parens[2]) cyc = parseInt(parens[2], 10);
      if (parens[3]) ms = unitToMs(parseFloat(parens[3]), parens[4]);
    } else {
      // Pattern C: '@N cycles' / '@Nc' / inline 'N cy' + 'N.Nus|ms|s'
      const at = trailer.match(/^(.*?)(?:\s+@(\d+)(?:c|\s+cycles?)?)?(?:\s+(\d+)\s*cy)?(?:\s+([\d.]+)\s*(us|ms|s))?\s*$/i);
      if (at && (at[2] || at[3] || at[4])) {
        bare = at[1].trim();
        if (at[2]) cyc = parseInt(at[2], 10);
        if (at[3]) cyc = cyc || parseInt(at[3], 10);
        if (at[4]) ms = unitToMs(parseFloat(at[4]), at[5]);
      }
    }
  }

  // If nothing matched, the bare name is the whole trailer
  if (!bare) bare = trailer;
  return { name: bare, status: status, cyc: cyc, ms: ms };
}

function unitToMs(n, unit) {
  if (!unit) return n;
  const u = unit.toLowerCase();
  if (u === "us") return n / 1000;
  if (u === "ms") return n;
  if (u === "s")  return n * 1000;
  return n;
}

/**
 * Parse Verilator's coverage.dat report into per-type percentages.
 *
 * Verilator with `--coverage` writes a text file at logs/coverage.dat
 * containing lines like:
 *   C '<bucket>' <count>
 * where <bucket> encodes file:line:col + kind metadata. Per-kind summary
 * lines also appear in newer Verilator versions:
 *   # COVERAGE: line 87%
 *   # COVERAGE: branch 64%
 *   # COVERAGE: toggle 42%
 *   # COVERAGE: fsm  N/A
 *   # COVERAGE: expr 78%
 *
 * Our parser handles both: when the summary lines exist we use them
 * directly; otherwise we aggregate the C-records by kind (kind is in
 * the bucket comment between single quotes) and compute hit-rate as
 * (#buckets with count>0) / (#buckets total) per kind.
 *
 * Returns an object { line, branch, toggle, fsm, expr } with each value
 * a percentage 0–100, or null when no data is available for that kind.
 */
export function parseCoverageDat(text) {
  const out = { line: null, branch: null, toggle: null, fsm: null, expr: null };
  if (!text || typeof text !== "string") return out;

  const lines = text.split("\n");

  // First pass — explicit summary lines (preferred)
  for (const ln of lines) {
    const m = ln.match(/#\s*COVERAGE\s*:\s*(\w+)\s+(\d+(?:\.\d+)?|N\/A)%?/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const val = m[2].toUpperCase() === "N/A" ? null : parseFloat(m[2]);
      if (kind in out) out[kind] = val;
    }
  }

  // If summary lines covered everything, return early
  if (Object.values(out).every(function(v) { return v != null; })) return out;

  // Second pass — aggregate C-records by kind
  // Format: C '<bucket>' <count>
  // Bucket comment looks like:  v_user/...:line:col\<kind\>...
  // Verilator uses backslash-escaped tags for kind:  \line\  \branch\  \toggle\  \fsm\  \expr\
  const bucketsByKind = {};
  function bumpKind(k, hit) {
    if (!bucketsByKind[k]) bucketsByKind[k] = { hit: 0, total: 0 };
    bucketsByKind[k].total++;
    if (hit) bucketsByKind[k].hit++;
  }
  for (const ln of lines) {
    const m = ln.match(/^C\s+'([^']*)'\s+(\d+)/);
    if (!m) continue;
    const bucket = m[1];
    const count = parseInt(m[2], 10);
    // Kind tag: \line\  \branch\  \toggle\  \fsm\  \expr\
    const kindMatch = bucket.match(/\\([a-z]+)\\/i);
    const kind = kindMatch ? kindMatch[1].toLowerCase() : "line";
    if (!(kind in out)) continue;
    bumpKind(kind, count > 0);
  }
  for (const k of Object.keys(bucketsByKind)) {
    if (out[k] != null) continue;  // summary line already set it
    const b = bucketsByKind[k];
    if (b.total > 0) out[k] = Math.round((b.hit / b.total) * 100);
  }

  return out;
}

/**
 * Extract the UNCOVERED coverage points (count == 0 C-records) from a
 * Verilator coverage.dat — the fine-grained companion to parseCoverageDat's
 * per-kind percentages. Used by the coverage-strengthening loop (#19) to tell
 * the TB generator exactly which lines/branches/toggles to exercise.
 *
 * @param {string} text   raw coverage.dat
 * @param {object} [opts] { cap?: number = 40 }  max uncovered points returned
 * @returns {{ uncovered: Array<{file,line,kind}>, byKind: {kind:{hit,total}} }}
 */
export function parseCoverageBuckets(text, opts) {
  const cap = (opts && opts.cap) || 40;
  const out = { uncovered: [], byKind: {} };
  if (!text || typeof text !== "string") return out;
  for (const ln of text.split("\n")) {
    const m = ln.match(/^C\s+'([^']*)'\s+(\d+)/);
    if (!m) continue;
    const bucket = m[1];
    const count = parseInt(m[2], 10);
    const kindMatch = bucket.match(/\\([a-z]+)\\/i);
    const kind = kindMatch ? kindMatch[1].toLowerCase() : "line";
    if (!out.byKind[kind]) out.byKind[kind] = { hit: 0, total: 0 };
    out.byKind[kind].total++;
    if (count > 0) {
      out.byKind[kind].hit++;
    } else if (out.uncovered.length < cap) {
      // Bucket encodes file:line:col before the \kind\ tag; grab file + line.
      // File class excludes ':' so a path like top.sv:12:3 splits correctly.
      const loc = bucket.match(/([^\s'\\:]+):(\d+)(?::(\d+))?/);
      out.uncovered.push({
        file: loc ? loc[1] : null,
        line: loc ? parseInt(loc[2], 10) : null,
        kind: kind,
      });
    }
  }
  return out;
}
