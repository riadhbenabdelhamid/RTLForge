// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Task #18: the pure backend task registry (bounded FIFO queue + per-task abort).
// Tested without spawning a server — the kill() closure is a plain mock.

import { describe, it, expect, vi } from "vitest";
import { createTaskRegistry, TaskAbortedError } from "../backend/taskRegistry.js";

const tick = () => Promise.resolve();

describe("createTaskRegistry", () => {
  it("admits up to maxConcurrent immediately, queues the rest", async () => {
    const reg = createTaskRegistry({ maxConcurrent: 2 });
    await reg.admit({ id: "a" });
    await reg.admit({ id: "b" });
    let cAdmitted = false;
    reg.admit({ id: "c" }).then(() => { cAdmitted = true; });
    await tick();
    expect(cAdmitted).toBe(false);                 // no free slot
    expect(reg.list().filter((t) => t.status === "running").map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(reg.list().filter((t) => t.status === "queued").map((t) => t.id)).toEqual(["c"]);
  });

  it("complete() frees a slot and admits the next queued task (FIFO)", async () => {
    const reg = createTaskRegistry({ maxConcurrent: 1 });
    const order = [];
    await reg.admit({ id: "a" }); order.push("a");
    reg.admit({ id: "b" }).then(() => order.push("b"));
    reg.admit({ id: "c" }).then(() => order.push("c"));
    await tick();
    expect(order).toEqual(["a"]);                   // b, c still queued
    reg.complete("a");
    await tick();
    expect(order).toEqual(["a", "b"]);              // b admitted before c
    reg.complete("b");
    await tick();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("abort(running) kills the child, frees the slot, admits the next", async () => {
    const reg = createTaskRegistry({ maxConcurrent: 1 });
    const killA = vi.fn();
    await reg.admit({ id: "a", kill: killA });
    let bAdmitted = false;
    reg.admit({ id: "b" }).then(() => { bAdmitted = true; });
    await tick();
    expect(bAdmitted).toBe(false);
    expect(reg.abort("a")).toBe(true);
    expect(killA).toHaveBeenCalledTimes(1);
    await tick();
    expect(bAdmitted).toBe(true);                   // freed slot admitted b
  });

  it("abort(queued) drops the task without spawning and rejects its admit()", async () => {
    const reg = createTaskRegistry({ maxConcurrent: 1 });
    const killB = vi.fn();
    await reg.admit({ id: "a" });
    let err = null;
    reg.admit({ id: "b", kill: killB }).catch((e) => { err = e; });
    await tick();
    expect(reg.abort("b")).toBe(true);
    await tick();
    expect(err).toBeInstanceOf(TaskAbortedError);
    expect(killB).not.toHaveBeenCalled();           // never ran → nothing to kill
  });

  it("abortAll() kills running, drops queued, returns every id", async () => {
    const reg = createTaskRegistry({ maxConcurrent: 1 });
    const killA = vi.fn();
    const killB = vi.fn();
    await reg.admit({ id: "a", kill: killA });
    reg.admit({ id: "b", kill: killB }).catch(() => {});
    await tick();
    const ids = reg.abortAll();
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(killA).toHaveBeenCalledTimes(1);         // running → killed
    expect(killB).not.toHaveBeenCalled();           // queued → just dropped
    expect(reg.list()).toEqual([]);
  });

  it("abort() of an unknown id returns false", () => {
    const reg = createTaskRegistry({ maxConcurrent: 1 });
    expect(reg.abort("nope")).toBe(false);
  });

  it("list() reports running before queued with statuses + ages", async () => {
    const reg = createTaskRegistry({ maxConcurrent: 1 });
    await reg.admit({ id: "a", label: "verilator" });
    reg.admit({ id: "b", label: "yosys" }).catch(() => {});
    await tick();
    const list = reg.list();
    expect(list.map((t) => [t.id, t.status])).toEqual([["a", "running"], ["b", "queued"]]);
    expect(typeof list[0].ageMs).toBe("number");
  });
});
