// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// backend/taskRegistry — bounded FIFO task queue + per-task abort (task #18)
//
// WHY A SEPARATE PURE MODULE:
//
// backend.js used a single global `activeProcess`, so `/api/abort` could only
// kill the most-recently-spawned child — under `parallelModules` waves that
// leaves sibling Verilator sims running (caveat at runAllPipelines.js:369), and
// nothing bounded the concurrent builds. This module is the registry that fixes
// both: it admits up to `maxConcurrent` tasks at once, queues the rest FIFO, and
// can abort one task by id or all of them.
//
// It is PURE — no spawning, no I/O. The caller (handleExecute) supplies a
// `kill()` closure that SIGTERMs that task's current child; the registry only
// decides WHEN a task may run and WHICH task(s) to kill. That keeps the
// queue/abort logic unit-testable without standing up a server (mirrors the
// repo's pure-core + adapter split: observer/merge, observer/trends).
// ═══════════════════════════════════════════════════════════════════════════

/** Rejection used to unblock an admit() whose task was aborted while queued. */
export class TaskAbortedError extends Error {
  constructor(id) {
    super("task aborted while queued: " + id);
    this.name = "TaskAbortedError";
    this.taskId = id;
    this.isTaskAborted = true;
  }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxConcurrent=1]  slots that may run at once
 */
export function createTaskRegistry(opts) {
  const maxConcurrent = Math.max(1, (opts && opts.maxConcurrent) | 0 || 1);
  const running = new Map();   // id → { id, label, kill, startedAt }
  const queue = [];            // [{ id, label, kill, startedAt, resolve, reject }]

  // Admit queued tasks while slots are free (FIFO).
  function drain() {
    while (running.size < maxConcurrent && queue.length > 0) {
      const next = queue.shift();
      running.set(next.id, { id: next.id, label: next.label, kill: next.kill, startedAt: next.startedAt });
      next.resolve();
    }
  }

  return {
    /**
     * Reserve a slot for a task. Resolves immediately when a slot is free,
     * otherwise parks the task FIFO and resolves once `complete`/`abort` frees
     * one. Rejects with TaskAbortedError if the task is aborted while queued.
     * @param {{id:string, label?:string, kill?:Function}} task
     */
    admit(task) {
      return new Promise(function(resolve, reject) {
        const entry = {
          id:        task.id,
          label:     task.label || null,
          kill:      typeof task.kill === "function" ? task.kill : function() {},
          startedAt: Date.now(),
          resolve:   resolve,
          reject:    reject,
        };
        if (running.size < maxConcurrent) {
          running.set(entry.id, { id: entry.id, label: entry.label, kill: entry.kill, startedAt: entry.startedAt });
          resolve();
        } else {
          queue.push(entry);
        }
      });
    },

    /** Release a finished task's slot and admit the next queued one. */
    complete(id) {
      running.delete(id);
      drain();
    },

    /**
     * Abort one task. A RUNNING task is kill()ed and its slot freed; a QUEUED
     * task is dropped (never spawns) and its admit() promise rejected.
     * @returns {boolean} true if a task with that id existed.
     */
    abort(id) {
      const r = running.get(id);
      if (r) {
        try { r.kill(); } catch (_e) { /* already-exited child → no-op */ }
        running.delete(id);
        drain();
        return true;
      }
      const qi = queue.findIndex(function(e) { return e.id === id; });
      if (qi >= 0) {
        const e = queue.splice(qi, 1)[0];
        e.reject(new TaskAbortedError(id));
        return true;
      }
      return false;
    },

    /**
     * Abort every task: kill all running children, drop all queued tasks.
     * @returns {string[]} the ids that were aborted.
     */
    abortAll() {
      const ids = [];
      for (const r of running.values()) {
        ids.push(r.id);
        try { r.kill(); } catch (_e) { /* no-op */ }
      }
      running.clear();
      const parked = queue.splice(0);
      for (const e of parked) {
        ids.push(e.id);
        e.reject(new TaskAbortedError(e.id));
      }
      return ids;
    },

    /** Snapshot of running + queued tasks (for GET /api/tasks). */
    list() {
      const now = Date.now();
      const out = [];
      for (const r of running.values()) {
        out.push({ id: r.id, status: "running", label: r.label, startedAt: r.startedAt, ageMs: now - r.startedAt });
      }
      for (const e of queue) {
        out.push({ id: e.id, status: "queued", label: e.label, startedAt: e.startedAt, ageMs: now - e.startedAt });
      }
      return out;
    },
  };
}
