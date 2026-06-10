# Observer Agent

A parallel agent that watches stage runs and accumulates a knowledge base
of noteworthy patterns: recurring errors, fixes that worked, skill effects,
prompt drift, cost anomalies. Local-only, off by default, opt-in per
workflow.

## What it captures

After each stage completes (success or failure), the observer ships a
**small summary** of that stage's outcome to an LLM extractor and gets
back a structured observation:

```json
{
  "kind":       "error" | "fix" | "skill_effect" | "drift" | "cost" | "nothing",
  "summary":    "<one-line description, ≤200 chars>",
  "severity":   "info" | "warn" | "high",
  "tags":       ["short", "keywords"],
  "actionable": true | false
}
```

When `kind === "nothing"` (the typical case for clean passing stages),
nothing is written. Otherwise the observation lands in the knowledge base
with full context.

The LLM extractor is intentionally tight: low temperature (0.1), small
maxTokens (200), and a focused system prompt that asks for nothing but
the JSON schema. Failure modes (LLM timeout, malformed JSON, network
down) all degrade to `{kind: "nothing"}` rather than throwing — the
observer must NEVER affect the pipeline run.

## Where it lives

**SQLite at `config.observerPath`.** Default `~/.rtlforge/observer.db`.
Set a different path in Settings → Workflow → Observer Agent to switch
knowledge bases (e.g. a team-shared `team.db` vs a personal `me.db`).

**Why SQLite over a vector DB:** the data is fundamentally tabular —
errors by kind, fixes by stage, costs by timestamp. SQL queries like
"top 10 most common lint errors in the last 30 days" are not vector
queries. A vector column can be added later if free-text similarity
search becomes valuable; SQLite supports BLOB columns natively.

The GUI also has a **browser-side mirror** that writes to `localStorage`
(keys prefixed `rtlforge:obs:`). Cap is 1000 events with auto-prune of
the oldest. The two stores are independent by default; the CLI command
`rtlforge observe import-browser` merges browser events into the SQLite
DB on demand.

## Schema

```sql
CREATE TABLE observer_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  workflow       TEXT NOT NULL,           -- per-workflow scoping column
  project_id     TEXT,
  module_id      TEXT,
  stage_key      TEXT,
  event_kind     TEXT NOT NULL,
  raw_input      TEXT,                    -- JSON: what we shipped to the extractor
  extracted      TEXT,                    -- JSON: what the extractor returned
  severity       TEXT,
  flag_dismissed INTEGER DEFAULT 0,
  notes          TEXT,
  cluster_id     INTEGER,
  embedding      BLOB                     -- reserved for future similarity search
);

CREATE TABLE observer_clusters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  summary     TEXT,
  count       INTEGER DEFAULT 1,
  first_seen  INTEGER,
  last_seen   INTEGER
);

CREATE TABLE observer_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

**Per-workflow scoping** — every event carries a `workflow` column and
every query filters on it by default. Cross-project pattern detection
within a workflow is desirable (and the primary use case); cross-workflow
mixing would just be noise (an "FPGA timing closure" pattern means
nothing inside an RTL-only project).

## Enabling

Disabled by default. To turn on:

- **GUI:** Settings → Workflow → check "Observer Agent (optional)". The
  path field below lets you point at a specific KB file.
- **CLI:** edit `~/.rtlforge/config.json`:
  ```json
  {
    "observerEnabled": true,
    "observerPath": "~/.rtlforge/observer.db"
  }
  ```

Once enabled, every stage run produces one extra LLM call. At ~200 input
tokens + ~100 output tokens per call with a typical 12-stage pipeline
running a handful of times per day, the cost is well under $0.10/day on
Claude Sonnet.

## Surfacing model

**Passive by default.** No popups, no toasts, no interruption of normal
flow. Observations accumulate in the KB and the user views them when
they want:

- **GUI:** Settings → Observer tab. Per-workflow event list with kind /
  severity filters, dismiss / delete buttons, "show dismissed" toggle,
  and a wipe-all button (with confirm).
- **CLI:** `rtlforge observe show` for summary, `rtlforge observe list`
  for events, plus per-event management commands.

This default came out of the design conversation: the observer is a
librarian, not an alarm. Future versions may add an "active high-severity"
mode that interrupts on critical patterns.

## CLI

```bash
# Summary view (counts + by-kind table)
rtlforge observe show

# List events, with filters
rtlforge observe list                    # all (default 50, latest first)
rtlforge observe list --kind error
rtlforge observe list --severity high
rtlforge observe list --stage verify --limit 100
rtlforge observe list --include-dismissed

# Inspect / manage
rtlforge observe path                    # print resolved DB path
rtlforge observe dismiss 123             # hide from default list (recoverable)
rtlforge observe delete 123              # hard-delete one event
rtlforge observe delete-before 2026-01-01

# Wipe everything (asks for confirm; type "wipe")
rtlforge observe wipe

# Export / import
rtlforge observe export > kb-snapshot.json
rtlforge observe import-browser browser-dump.json
```

## Retention

**Keep forever by default.** Users delete individual events via
`dismiss` / `delete`, prune by time window with `delete-before`, or wipe
everything with `wipe` (confirm required). No silent expiry.

## Cost considerations

The extractor LLM call is the main cost. To keep it bounded:

- Tight prompt (~200-token system + small user payload)
- Low temperature (0.1) for determinism
- Hard maxTokens cap (200 for output)
- No code blocks shipped to the LLM — only stage outcomes (error counts,
  test pass/fail tallies, score numbers, fix-applied flags)

The raw stage code is NEVER sent to the extractor. What is sent looks
like:

```json
{
  "stage":           "verify",
  "succeeded":       false,
  "skills_applied":  ["prefer-always-ff"],
  "tokens_in":       1200,
  "tokens_out":      450,
  "latency_ms":      2300,
  "tests_total":     5,
  "tests_pass":      3,
  "tests_fail":      2,
  "first_failures":  ["t_overflow: width mismatch on line 17", "..."]
}
```

This is enough signal for the extractor to detect patterns without
exposing the user's design.

## Graceful degradation

When `better-sqlite3` isn't installed (it's a native module that requires
`node-gyp` to compile), the observer runs in **no-op mode**: the CLI
prints a one-line install hint and exits cleanly; the pipeline still
runs normally; the GUI's browser-side observer still works since it
uses `localStorage`.

To enable full functionality, run:

```bash
npm install better-sqlite3
```

## Internal API

```js
import { observeStage, openDb, queryEvents } from "src/observer/index.js";

// Pipeline integration (already wired in runStage.js):
observeStage(
  {
    workflow:      "rtl",
    projectId:     "sync_fifo",
    moduleId:      "sync_fifo",
    stageKey:      "verify",
    succeeded:     false,
    stageResult:   { /* the data the node returned */ },
    skillsApplied: ["prefer-always-ff"],
    llm:           { tokensIn, tokensOut, latencyMs },
  },
  { callLLM, extractJSON, config },
);
// Returns immediately; LLM extraction happens in the background.

// Querying:
const handle = await openDb(config);
const events = queryEvents(handle, { workflow: "rtl", kind: "error", limit: 50 });
```
