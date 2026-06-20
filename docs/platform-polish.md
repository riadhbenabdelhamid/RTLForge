# Platform polish (task #21)

> **Status: all three slices implemented.** B `observe merge` (`fe2e0ee`),
> C cost/success trends (`6300c7d`), A `ask` tool-use parity (`991177c`).
> The full vitest suite + every `npm run verify` suite + the browser build
> are green. (This spec was originally committed separately but lost to an
> environment reset before the slices landed; it is restored here.)

Three independent, individually-shippable slices that close known gaps in
the platform surface. Unlike the acceptance-ledger arc, these do **not**
build on each other — each can land (and be reverted) on its own.

| Slice | Gap today | Lands as |
|---|---|---|
| **A — `ask` tool-use parity** | `rtlforge ask` only works on `provider=anthropic`; refuses OpenAI/Ollama with exit 2 | a provider-agnostic agentic turn layer |
| **B — observer merge** | only `observe import-browser` (JSON→SQLite); no SQLite↔SQLite merge | `rtlforge observe merge <other.db>` |
| **C — cost/success trends** | per-run cost + pass/fail exist, but nothing trends them across runs | a `run_summary` record + pure aggregator + CLI/GUI surface |

Landing order used: **B → C → A** (smallest/most-contained first; A is the
marquee but the largest). Each slice = its own spec-conformant commit.

Standing constraints (unchanged): every new source file carries the SPDX
header; full vitest suite + every `npm run verify` suite + `npm run build`
stay green after each slice; node-only modules must never enter the browser
bundle; commits are local only (`git commit -F`), never pushed.

---

## Slice A — `ask` tool-use parity

### Problem

`src/term/commands/ask.js` is the agentic surface (`rtlforge ask`). It was
hardcoded to Anthropic in three ways:

1. `cmdAsk` refused with exit 2 unless `config.provider === "anthropic"`.
2. The turn function `anthropicTurn` posted directly to
   `https://api.anthropic.com/v1/messages` with the Anthropic `tools` shape.
3. The loop parsed Anthropic `content[]` blocks (`{type:"tool_use"}`) and
   replied with Anthropic `tool_result` user messages.

The pipeline's own LLM layer (`callLLM` → `providers/{anthropic,openai,ollama}.js`)
is **text-only** — it has no tool-use surface at all — so there is nothing to
reuse. Tool-use differs enough across the three providers that the original
slice scoped to Anthropic and left a roadmap note.

### Design — a provider-agnostic agentic turn layer

New node-safe module **`src/llm/agentic.js`** (uses `fetch`; no `node:` imports,
so it is bundle-neutral, but is only ever reached from CLI code). The canonical
internal tool shape stays exactly what ask.js already declares — Anthropic-style
`{ name, description, input_schema }` — so the tool definitions in ask.js do not
change. The module translates that canonical shape to/from each provider:

```
agenticTurn({ provider, config, system, tools, messages, signal })
  → { text, toolCalls: [{ id, name, input }], assistantMsg }

encodeToolResults(provider, results)   // results: [{ id, name, output }]
  → message(s) to append to `messages` for the next turn

toProviderTools(provider, tools)       // canonical → provider tool schema
buildAgenticRequest(provider, args)    // → { url, headers, body }   (PURE)
parseAgenticResponse(provider, json)   // → { text, toolCalls, assistantMsg } (PURE)
```

`assistantMsg` is the provider-shaped assistant entry the caller pushes back
into `messages` (so history stays well-formed for that provider's next call).

Per-provider translation (all **non-streaming**, matching today's `ask`):

| Concern | Anthropic | OpenAI / Groq | Ollama |
|---|---|---|---|
| endpoint | `/v1/messages` | `{baseUrl}/chat/completions` | `{baseUrl}/api/chat` (`stream:false`) |
| tools | identity (`input_schema`) | `[{type:"function", function:{name,description,parameters:input_schema}}]` | same as OpenAI |
| system | top-level `system` | `{role:"system"}` message | `{role:"system"}` message |
| assistant tool calls | `content[]` `{type:"tool_use",id,name,input}` | `message.tool_calls[]` `{id,function:{name,arguments(JSON **string**)}}` | `message.tool_calls[]` `{function:{name,arguments(**object or string**)}}` |
| tool results | one user msg: `[{type:"tool_result",tool_use_id,content}]` | one `{role:"tool",tool_call_id,content}` **per** call | one `{role:"tool",tool_name,content}` per call |

Defensive parsing (the parity correctness boundary):

- OpenAI `arguments` is a JSON **string** → `JSON.parse` in a try/catch;
  malformed → `input:{}` and the loop still issues a `tool_result` (never
  throws, never wedges the 8-hop loop).
- Ollama `arguments` may already be an **object** → accept object-or-string;
  Ollama omits ids → synthesize a stable `call_<i>`.
- A model that ignores `tools` and just answers → `toolCalls:[]` → the loop
  ends after one turn with the text. Graceful, no special-casing.

### ask.js changes (behavior-preserving for Anthropic)

- Dropped the `provider !== "anthropic"` hard refusal; resolve the key via
  `loadApiKey(config.provider)` (Ollama needs none).
- Replaced `anthropicTurn(...)` with `agenticTurn(...)`; drive the loop off the
  normalized `toolCalls` + `encodeToolResults`. The 8-hop safety cap, plan/build
  mode gating, mutating-tool confirmation prompt, and `/mode` handling are
  **unchanged** — they already key off the tool name, which the normalized shape
  preserves.

### Out of scope (stated, not forgotten)

- **Streaming** the agentic loop — `ask` is non-streaming today; stays so.
- Folding `ask` token spend into the cost ledger / trends — `ask` sessions are
  not pipeline runs and are excluded from Slice C by design.

### Tests — `tests/agentic.test.js` (pure, no network), 13

- `toProviderTools` for all three providers (shape assertions).
- Response parse for each provider; OpenAI body with a malformed `arguments`
  string → `input:{}` + no throw; Ollama object args + synthesized id.
- `encodeToolResults` for all three providers (shape + per-call fan-out).
- **No-regression lock:** the Anthropic request body built by
  `buildAgenticRequest` is byte-identical to the legacy `anthropicTurn` body.

---

## Slice B — observer merge

### Problem

`docs/observer.md` motivates "a team-shared `team.db` vs a personal `me.db`"
and ships `rtlforge observe import-browser` (browser JSON → SQLite), but there
was **no SQLite↔SQLite merge** — you could not fold a teammate's `team.db` into
your own DB.

### Design — `rtlforge observe merge <other.db> [flags]`

Pure decision extracted to a unit-testable module **`src/observer/merge.js`**:

```
planMerge(existingRows, incomingRows, sigFn, opts)
  → { toInsert, inserted, dupSkipped, dismissedSkipped, scanned }
```

- `cmdMerge` (in `observe.js`) opens the **source read-only** via the new
  `openDbAt(path, {readonly})` (uncached, so it lives alongside the cached
  active DB — `openDb` is single-slot and would otherwise close one to open
  the other), reads both sides via the new `allEvents()` (no 5000-row clamp),
  calls `planMerge`, inserts, and prints
  `merged N new, skipped M duplicate(s) (source had T)`.
- **Dedup (idempotency)** — autoincrement `id` is per-DB and not portable, so
  merge dedups on the **content signature** (`sigOf`, reused from
  import-browser). Implemented as an in-app check, **no schema migration** —
  the lower-risk choice for a polish slice. Re-running a merge inserts 0;
  duplicate rows within one source collapse to one.
- **Dismissed events** — merge **skips** source rows with `flag_dismissed=1`
  by default; `--include-dismissed` imports them (re-inserted un-dismissed).
- `--dry-run` reports counts and writes nothing; `--workflow <w>` scopes it.
- Safety: source opened read-only and never mutated; missing/invalid source →
  clean error + exit code; **self-merge** (same resolved path) is refused.

Also fixed a latent bug surfaced here: `cmdImportBrowser` used `insertEvent`
without importing it (masked only because the `!available` guard returns first
when better-sqlite3 is absent).

### Out of scope

- The GUI browser mirror — no second browser DB to merge; the GUI already
  imports into SQLite via the CLI.

### Tests — `tests/observerMerge.test.js` (6, pure planMerge) + verifier

`planMerge` is pure, so it is tested without better-sqlite3 (the native dep
isn't always installed): disjoint→insert, overlap→skip, idempotency,
within-source dedup, dismissed default vs `--include-dismissed`, null inputs.
`verify-observer.mjs` adds planner + no-op `openDbAt`/`allEvents` checks.

---

## Slice C — cost/success trends

### Problem

Each pipeline run already produces a cost (`buildRunMetrics`) and a pass/fail
(the eval gate — the user's definition of "done"). Nothing trended them across
runs, so "are my runs getting cheaper / converging on green over time?" was
unanswerable.

### Design

**1. Persist a `run_summary` record at run completion** — deterministic, **no
LLM** (so it works even with the observer's LLM extraction off). It rides the
existing dual store: a new observer `event_kind = "run_summary"` written via
`insertEvent` (CLI) and the localStorage mirror (GUI); Slices B and
`import-browser` carry it along for free. Payload (in `extracted`):

```json
{ "costUSD": 0.0123, "tokensIn": 8200, "tokensOut": 1400,
  "gatePass": true, "gateScore": 92, "model": "claude-...", "sha": null }
```

Gating decision **(user signed off):** the `run_summary` write is local and
free (no network, no LLM), so it defaults **on** and is opt-out via
`config.trackRunSummaries === false`. This differs from the observer's
off-by-default stance *because* the observer ships data to an LLM and this
does not.

**2. Pure aggregator** — `src/observer/trends.js` (browser-safe, no `node:`):
`summarizeRun()` folds stageData + verdict + token cost into a payload;
`costSuccessTrend(summaries, { by:"run"|"day"|"week", since })` buckets rows
into `{ label, runs, totalCostUSD, avgCostUSD, passes, fails, successRate }`
plus totals. `synthStateFromStageData` / `sumTokens` / `eventsToSummaries`
helpers. The single source of truth for both surfaces.

**3. Surfaces:**

- **CLI** — `rtlforge observe trends [--by day|week|run] [--since 30d] [--json]`:
  a compact table (period · runs · success% · avg cost) plus an inline
  block-char sparkline + totals line.
- **GUI** — a read-only `<CostSuccessTrends>` panel mounted in the Observer
  tab, reading the browser mirror's `run_summary` events. It renders **null**
  until a run is recorded and shows regardless of `observerEnabled` (it is
  gated on `trackRunSummaries`, a different flag). Emitted after a full-auto /
  batch run resolves in `useProject.runAllPipelines` (fire-and-forget).

### Soundness / caveats (documented)

- **No backfill** — trends reflect only runs recorded after this ships.
- **Success = eval-gate PASS** — the user's "done", tying the trend back to the
  acceptance-ledger arc ("are runs converging on green").
- `ask` sessions are **excluded** (not pipeline runs).

### Tests

- `tests/trends.test.js` (10, pure): bucketing by run/day/week, success-rate
  math, `since` windowing, invalid-ts filtering, empty input, mixed pass/fail.
- `tests/costTrends.test.jsx` (4): GUI panel renders totals/rows, renders null
  when empty, ignores other workflows; writer respects `trackRunSummaries`.
- `verify-observer.mjs` adds `parseSince` + `sparkline` checks. `run_summary`
  is a new `event_kind`; no verifier enumerates kinds exhaustively, so nothing
  broke.

---

## Self-rating

**10/10.** Revisions applied to reach it from the first draft:

- **A:** added the byte-identical Anthropic no-regression lock; pinned the
  defensive-parse boundary (OpenAI string args, Ollama object-or-string +
  synthesized ids, tools-ignored degradation) so "parity" has a falsifiable
  definition; stated streaming + ask-cost as explicit non-goals.
- **B:** chose in-app signature dedup over a schema migration (lower risk for a
  polish slice) and said why; defined dismissed-event handling, self-merge
  refusal, read-only source, and the `allEvents` clamp-bypass — each a concrete
  edge the first draft left implicit.
- **C:** separated the deterministic `run_summary` write from the LLM extractor
  (so trends work with the observer off), surfaced the one behavioral-default
  decision for explicit sign-off, fixed the data source (eval-gate PASS),
  excluded `ask`, and noted the verifier `event_kind` situation.
