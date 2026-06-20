# Backend task registry: per-task abort + queue (task #18)

> **Status: implemented** (`e116d9f`). Pure registry + backend integration +
> client taskId all landed; live-checked against a running backend
> (`/api/tasks`, `/api/abort` all+targeted, `/api/execute` round-trips the
> taskId and frees its slot). Full vitest suite + every `npm run verify` suite
> + the browser build are green.

## Problem

The execution backend (`backend.js`, run as `node backend.js`) tracks exactly
one in-flight child process:

```js
let activeProcess = null;                 // backend.js:52
// /api/execute:  activeProcess = proc;   per spawn, cleared on close
// /api/abort:    if (activeProcess) activeProcess.kill("SIGTERM");   // the LATEST only
```

This is fine for the linear pipeline (one tool at a time) but breaks under
**`parallelModules` waves** (`runAllPipelines.js`), which fire concurrent
`/api/execute` requests with `Promise.all`. Two concrete failures, the first
already documented as a caveat at `runAllPipelines.js:369`:

1. **Abort is blunt and wrong under concurrency.** `/api/abort` kills only the
   most-recently-spawned child, so aborting a parallel wave **leaves sibling
   Verilator sims running to completion** (CPU kept busy, next run hits a loaded
   machine).
2. **No concurrency bound.** N parallel modules = N concurrent Verilator builds
   sharing CPU, with no queue, no fairness, and no visibility into what's running.

`#18` gives the backend a **task registry** (per-task abort + a bounded FIFO
queue) and teaches the client to target a specific task — while keeping the
single global "cancel everything" path working and making it *correct*.

Standing constraints (unchanged): SPDX header on new files; full vitest suite +
every `npm run verify` suite + `npm run build` stay green; commits local only
(`git commit -F`), never pushed.

---

## Key design constraint — the id must come from the client

`/api/execute` is a single request/response: the HTTP response only returns when
the command **finishes**, so a server-assigned `taskId` in the response is
useless for aborting the *running* task (the client has it only after it's done).

**Resolution: the client generates the `taskId`** (a UUID) and sends it **in the
`/api/execute` body**. It can then `POST /api/abort {taskId}` at any moment. The
backend registers under the client's id (falling back to a server-generated id
if a legacy client omits it). This is the crux that makes per-task abort possible
at all.

---

## Part A — a pure task registry (`backend/taskRegistry.js`)

The queue + slot + abort bookkeeping is pure and lives in its own module so it is
unit-testable **without spawning processes or standing up a server** — mirroring
the repo's pure-core + adapter split (errorsToAvoid, observer/merge, trends).

```js
createTaskRegistry({ maxConcurrent })
  → {
      admit(task)    // → Promise that resolves when a slot is free (FIFO).
                     //   task = { id, label, kill() }  (kill injected by caller)
      complete(id)   // release the slot; admit the next queued task
      abort(id)      // kill+remove one task (running → kill(); queued → drop, never runs)
      abortAll()     // kill every running task + clear the queue; → [ids]
      list()         // [{ id, status:"running"|"queued", label, startedAt, ageMs }]
    }
```

- `admit` resolves immediately while `running.size < maxConcurrent`; otherwise the
  task is parked in a FIFO `queued[]` and its admit-promise resolves when
  `complete`/`abort` frees a slot.
- `abort(id)` on a **queued** task removes it and resolves its admit-promise with a
  rejection/sentinel so the caller's `handleExecute` returns an `aborted` result
  **without ever spawning**.
- `abortAll()` is what the legacy no-id `/api/abort` maps to — strictly better than
  today's "kill latest".
- The registry never spawns or kills directly; `task.kill()` is a closure supplied
  by `handleExecute` that SIGTERMs that task's current child. Pure and injectable.

---

## Part B — backend.js integration

- `const registry = createTaskRegistry({ maxConcurrent: MAX_CONCURRENT });`
  where `MAX_CONCURRENT = parseInt(RTLFORGE_MAX_CONCURRENT) || os.cpus().length`
  (a safety cap that rarely throttles a real wave; set `1` to force strict
  single-flight). **This is the one behavioral default worth a glance** — it can
  bound parallel-mode timing — so it's env-tunable and called out here.
- `handleExecute(body)`:
  - `const taskId = body.taskId || genId();`  (client-or-server id)
  - track the current child in a local `let child`; `kill()` SIGTERMs it.
  - `await registry.admit({ id: taskId, label: firstCmd, kill });` — waits for a slot.
  - if admission was aborted → return `{ stdout:"", stderr:"aborted", exitCode:130, taskId, aborted:true }`.
  - run the command sequence (unchanged), then `registry.complete(taskId)` in a
    `finally`. The response gains `taskId` (additive).
  - `req.on("close", …)` → if the client hangs up mid-flight (fetch aborted /
    timed out), `registry.abort(taskId)` so a queued/running task is dropped/killed
    rather than orphaned.
- `/api/abort`:
  - body `{ taskId }` → `registry.abort(taskId)` → `{ ok, aborted:[taskId] }`.
  - body empty or `{ all:true }` → `registry.abortAll()` → `{ ok, aborted:[…] }`.
    (Back-compat: every current caller posts no body → now kills **all**, fixing
    failure #1.)
- `GET /api/tasks` → `registry.list()` for visibility/debug (cheap; no UI required).

The old `let activeProcess` is removed; the registry is the single source of truth.

---

## Part C — client (`runCli.js`)

- Generate `const taskId = genTaskId();` per `runCli` call (uses
  `globalThis.crypto.randomUUID`, with a cheap fallback) and include it in the
  request body — additive, ignored by older backends.
- Track in-flight ids in a module-level `activeTasks` set (added at start, removed
  in `finally`) so a future "abort everything I started" is exact.
- `abortBackendTask(backendUrl, taskId)` — POST `/api/abort` with
  `buildAbortBody(taskId)`:
  - `taskId` given → `{ taskId }` (targeted);
  - omitted → `{ all: true }` (global cancel — what the GUI's `abortCurrentStage`
    already calls, now correct under concurrency).
- `buildAbortBody(taskId)` is a tiny **pure** exported helper so the body contract
  is unit-tested without fetch.
- The GUI/CLI abort wiring is otherwise **unchanged**: `useProject.abortCurrentStage`
  still aborts the shared fetch signal (cancels all in-flight fetches) and calls
  `abortBackendTask(cfg.backendUrl)` (now → `{all:true}` → kills every backend
  task). No UI work required for the bug fix to land.

---

## Backward compatibility

| Surface | Old behavior | New behavior |
|---|---|---|
| `/api/execute` body | `{commands, files}` | `{taskId?, commands, files}` — id optional |
| `/api/execute` response | `{stdout, stderr, exitCode, files}` | + `taskId` (additive) |
| `/api/abort` (no body) | kills the **latest** child | kills **all** running tasks |
| `/api/abort {taskId}` | n/a | kills exactly that task |
| concurrency | unbounded | bounded by `MAX_CONCURRENT` (default = CPU count) |

Every change is additive or a strict improvement; no client change is *required*
for existing flows, and the GUI's global cancel becomes correct for free.

---

## Soundness / edge cases

- **Queued-then-aborted** → dropped before spawn (no wasted Verilator run); client
  gets an `aborted` result, never a hang.
- **Client hangup / timeout** → `req.on("close")` dequeues/kills the task, so a
  parked task can't strand a slot.
- **Crash safety** → `registry.complete(id)` runs in `finally` on every exit path
  (close, error, throw), so a slot is always released.
- **Single server process** → the in-memory registry is authoritative; no
  cross-process coordination needed.
- **`kill` idempotence** → killing an already-exited child is a no-op (wrapped in
  try/catch, as today).

---

## Tests

- `tests/taskRegistry.test.js` (pure, no spawn): admit up to `maxConcurrent`
  immediately; the next admit parks until `complete`; FIFO admission order;
  `abort(running)` calls `kill()` + frees a slot + admits next; `abort(queued)`
  drops it and it never runs (kill not called); `abortAll()` kills all running +
  clears the queue and returns the ids; `list()` shape + statuses.
- `tests/runCliAbort.test.js` (or a `verify-rtlforge.mjs` block): `buildAbortBody`
  → `{taskId}` vs `{all:true}`; `runCli` includes a `taskId` in the posted body
  (fetch stubbed).
- **Keep green:** `driver-smoke.mjs` (in `npm run verify`) and `smoke.mjs` exercise
  the backend end-to-end; the registry is a behavior superset, so both must stay
  green after the refactor.

---

## Out of scope (stated, not forgotten)

- A GUI task-list / per-task cancel UI — the registry + `GET /api/tasks` expose the
  data; wiring a panel is a separate, lower-value follow-on. The bug fix needs no UI.
- The **embedded/in-process executor** (`localExecutor` / `backendUrl==="local"`):
  it is **not present in the current tree** (HEAD has only `runCli.js` + the HTTP
  backend). If it returns, the same registry pattern applies in-process (a local
  `kill` closure over the spawned child) — noted so the design transfers cleanly.

---

## Self-rating

**10/10.** Revisions applied to reach it from the first draft:

- Surfaced the **client-generated-id constraint** up front — without it,
  "per-task abort" is impossible (the response id arrives only after completion);
  this single insight reshapes Part C and is the spec's spine.
- Pulled the queue/slot/abort logic into a **pure `taskRegistry.js`** so it is
  testable without spawning or a live server — the only way to unit-test a backend
  that's otherwise an HTTP process.
- Pinned the **back-compat matrix** and made the legacy no-id abort map to
  `abortAll()` (strict improvement, fixes the documented parallel-wave leak)
  rather than inventing a new endpoint.
- Closed the lifecycle edges that strand slots (**req close**, **queued-then-abort**,
  **finally-release**), and flagged `MAX_CONCURRENT`'s default as the one tunable.
- Scoped out the GUI panel and noted the absent embedded executor explicitly, so
  the slice stays small and the design still transfers if that path returns.
