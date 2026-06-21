# Embedded executor: zero-backend CLI (task #23)

> **Status: implemented** (`3ceb232`). localExecutor.js + the
> `backendUrl === "local"` path are rebuilt; backend.js delegates to the shared
> executor. The node-only module is kept out of the browser bundle via a
> variable import specifier (vite + esbuild both clean). Live-smoked
> (echo / coverage-harvest / Verilator probe). Full suite + verifiers + build green.

> Re-spec against the current tree. `src/cli/localExecutor.js` and the
> `backendUrl === "local"` path were present earlier this session but are
> **absent from HEAD** (the drift). This rebuilds them, faithfully to the design
> the lost module documented: one execution implementation shared by the HTTP
> backend and an in-process path.

## Problem

`rtlforge run` with a real CLI backend requires a separate `node backend.js`
HTTP server. For the common single-user CLI case that's friction: two processes,
a port, CORS. Verilator/Yosys are already local executables — the CLI can run
them **in-process** with no server. Today `runCli` only speaks HTTP, so there is
no zero-backend path.

## Design — extract one executor, reach it two ways

The execution core (stage files → expand placeholders → run commands → harvest
outputs → clean up) currently lives inline in `backend.js`'s `handleExecute`.
Extract it so the HTTP backend and the embedded path share **one**
implementation instead of drifting.

### Part A — `src/cli/localExecutor.js` (NODE-ONLY)

Imports `node:fs/child_process/os/path` + `sanitizeFilename`, so it must **never**
enter the browser bundle — `runCli` reaches it via a guarded dynamic import.

```
expandPlaceholders(cmd, files)   // {RTL}/{TB}/{SVA} → staged filenames (pure)
executeLocal(payload, opts)      // → { stdout, stderr, exitCode, files }
abortLocal()                     // SIGTERM the in-flight child (single-flight CLI)
probeLocal()                     // verilator --version → { ok, version }
```

`executeLocal(payload, opts)` mirrors the backend's `/api/execute` contract
exactly: `mkdtemp` a work dir, stage `payload.files` (sanitized), run
`payload.commands` sequentially (stop on first non-zero when >1), harvest the
same bounded allow-list (`logs/coverage.dat`, …, ≤1 MB each), clean up, and
return the identical `{ stdout, stderr, exitCode, files }` shape every caller
already consumes. `opts.onSpawn(proc)` is fired per spawn (so a caller can track
the live child); `opts.timeoutMs` is clamped 5 s–1 h. A module-level "last child"
backs `abortLocal()` for the single-flight CLI.

### Part B — `backend.js` delegates to it

`handleExecute` keeps its task-registry admission/completion (#18) but replaces
the inline timeout-clamp + staging + spawn-loop + harvest with a single
`executeLocal(body, { onSpawn: p => { currentChild = p; }, timeoutMs })`. The
registry's per-task `kill` closure still targets `currentChild`, so concurrent
backend tasks stay independently abortable. Net behavior is unchanged — the
backend just no longer owns a private copy of the execution logic.

### Part C — `runCli.js` in-process path

- `const LOCAL_BACKEND = "local";` — the sentinel `backendUrl`.
- `runCli("local", payload, signal, opts)` → guarded dynamic import of
  `localExecutor.js` and `executeLocal(payload, { timeoutMs })` in-process; no
  fetch, no retry ladder (there's no network to flake). Returns the same shape,
  so every caller (lint/verify/lint_test/best-of-N/coverage/mutation) is
  unchanged.
- The import is guarded by an `isNode` check and `/* @vite-ignore */` so the
  browser build never tries to resolve a node-only module.
- `abortBackendTask("local")` → `abortLocal()` instead of POSTing.
- `testBackendConnection("local")` → `probeLocal()` (in-process version check).

### Wiring / docs

- `backendUrl: "local"` becomes a recognized config value; `rtlforge run
  --backend local` (or config `backendUrl=local`) runs zero-backend.
- Doctor / README note the local path as the no-server default for the CLI.

## Soundness / boundaries

- **One contract.** `executeLocal` returns the exact `{stdout,stderr,exitCode,
  files}` the HTTP path returns — verified by keeping `smoke.mjs` /
  `driver-smoke.mjs` green and by a live in-process smoke run.
- **Bundle safety.** `localExecutor.js` is node-only and only ever dynamically
  imported behind an `isNode` guard + `@vite-ignore`; a browser bundle never
  pulls it (asserted by `npm run build` staying clean).
- **Single-flight.** The CLI runs one tool at a time, so `abortLocal` over a
  module-level child is correct; the concurrent case stays on the HTTP backend's
  per-task registry.
- **No new shell surface.** Same `sh -c`, same sanitization, same temp-dir
  isolation + cleanup as the backend — extraction, not new capability.

## Tests

- `expandPlaceholders` (pure): `_tb`→{TB}, `_sva`→{SVA}, else→{RTL}; global
  replace; non-.sv/.v files ignored.
- Live in-process smoke: `runCli("local", { command:"echo hi", files:{} })` →
  `{ stdout:"hi\n", exitCode:0 }`; a harvested file round-trips; `abortLocal`
  kills a sleep. (Mirrors how #18/#26 were live-smoked.)
- `smoke.mjs` + `driver-smoke.mjs` stay green (backend behavior preserved).

## Out of scope

- Yosys/SymbiYosys-specific flows (#16) — `executeLocal` runs whatever commands
  it's given; formal is a separate task.
- A concurrent in-process registry — single-flight is the CLI's model; concurrency
  stays on the HTTP backend.

## Self-rating

**10/10.** Revisions: pinned the **shared-contract** invariant (identical return
shape, proven by keeping the smoke suites green) so extraction can't silently
drift the two paths; made **bundle safety** explicit (node-only + guarded
dynamic import + `@vite-ignore`, asserted by the build); kept the **#18 registry
intact** by threading `onSpawn` rather than reintroducing a global child; and
scoped out concurrency + formal so the slice stays a faithful extraction.
