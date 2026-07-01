# Deterministic syntax repair — mechanical fixes for generated SV (opt-in)

> **Status: spec → implementing.** Research topic T3
> ([research_investigation_topics.md](research_investigation_topics.md)): the
> highest-ROI lever for weak/flaky local models. Measured on
> `liquid/lfm2-24b-a2b`: its dominant lint errors are **mechanical** — fixable by
> deterministic text transforms at zero LLM cost — while prompt-hint injection
> measured a wash (37 vs 36 errors) and the LLM fix loop costs minutes per
> iteration.

## Problem

Weak local models produce RTL/TBs whose top failures are *not* judgment calls:

| measured class (occurrences, lfm2-24b session) | mechanical fix |
|---|---|
| packed vector missing lower bound — `logic [W-1] x` (17×) | `[W-1]` → `[W-1:0]` |
| sized-literal base mismatch — `32'b25` (9×) | `'b` with decimal digits → `'d` |
| bare compiler directive — `timescale 1ns/1ps` (nemotron) | prefix the backtick |
| VHDL-style port — `input rst_n : logic` (4×) | → `input logic rst_n` |
| mid-block declaration — `logic prev = clk;` after a statement (5×, also gpt-oss-120b's #1 TB failure) | hoist decl to block top, leave the assignment in place |

Today each costs an LLM fix-loop iteration (slow, flaky, may introduce new
errors). A deterministic pass fixes them instantly and reproducibly.

## Design

**Pure module `src/pipeline/syntaxRepair.js`** (browser-safe, no I/O):

- `repairSV(code)` → `{ code, fixes: [{rule, count}], total }` — runs the
  transform set; **idempotent** (repairing repaired code is a no-op).
- `maybeRepair(config, code)` — the gate: returns `{ code, fixes: null }`
  untouched unless `config.syntaxRepair` is true. Nodes call only this.

**Transforms are conservative by construction** — each fires only on a construct
that is *invalid where it stands* (so a transform can only help), and anchors on
context so legal code is untouched:

1. **Backtick directives** — a line starting with a bare `timescale <time>/<time>`,
   `include "…"`, `define IDENT`, `ifdef/ifndef IDENT`, `endif`, `undef IDENT`,
   `default_nettype <type>` gets its backtick. Anchored per-directive (e.g.
   `timescale` must be followed by a time literal) so identifiers that merely
   start with those words are untouched.
2. **Packed-range lower bound** — `[expr]` with no `:` in *packed position* (right
   after a type keyword `logic|reg|wire|bit|…` or a direction `input|output|inout`,
   *before* the identifier) → `[expr:0]`. Unpacked dims after the name
   (`mem [8]`, legal) and array indexing (`mem[addr]`) never match.
3. **Sized-literal base** — `N'b<value>` whose value contains a digit 2–9 and
   only `[0-9_]` → `N'd<value>` (the author wrote a decimal value; reading it as
   decimal preserves what they typed). Hex-looking values are left alone.
4. **VHDL-style colon ports/params** — `input name : type [range]` →
   `input type [range] name`; `parameter NAME : int = v` → `parameter int NAME = v`.
5. **Mid-block declaration hoisting** — inside blocks known to be *procedural*
   (a `begin` opened by `always*/initial/task/function`, or nested inside one),
   a single-variable declaration appearing **after the first statement** is
   hoisted to the top of its block; an initializer is split off and left in
   place as an assignment (`logic prev = clk;` → decl hoisted, `prev = clk;`
   stays — semantically identical in procedural context). Non-procedural
   (generate/module-scope) blocks are never touched, and declarations already
   at the top are never moved — so legal code cannot be rearranged.

**Wiring** — applied where generated code is finalized, gated by the flag:
`rtl_generate` (single-shot return + best-of-N winner) and `test_generate`
(same two points). When repairs fire, the stage output carries
`_syntaxRepairs: fixes` and a log line lists what was fixed (visibility — the
user sees the pass working, and the observer/evidence keeps the record).

The lint fix loop is untouched: anything the pass can't fix still goes through
the LLM loop as before. Repair runs *before* first lint, so the loop starts from
mechanically-clean code and spends its iterations on real problems.

**Opt-in surfaces** (default **off**; off → byte-identical pipeline):

- Config: `syntaxRepair: false` in `term/config.js` + `useProject.jsx`.
- CLI: `rtlforge config set syntaxRepair true`.
- GUI: a checkbox panel in **Settings → Workflow** (modeled on the Observer
  panel): "Deterministic syntax repair (optional)".

## Soundness / boundaries

- **Only-invalid-input transforms.** Every pattern targets code that cannot
  compile as written; the worst case of a wrong guess (e.g. `[W-1:0]` when the
  author meant something else) is code that still fails lint and enters the fix
  loop exactly as it would have anyway.
- **Idempotent + pure.** Unit-testable without a model or fs; running twice
  changes nothing.
- **No hidden rewriting.** Fires only behind the opt-in flag, logs every fix,
  and stamps `_syntaxRepairs` into the stage output.
- **Not a linter replacement.** It repairs the measured high-frequency
  mechanical classes only; semantic errors (WIDTH, LATCH, logic bugs) remain
  the fix loop's job.

## Tests

- Each transform: the real harvested sample → fixed form; a legal look-alike →
  untouched (e.g. unpacked `mem [8]`, hex `'hBEEF`, generate-block decls,
  decls already at block top).
- Idempotency: `repairSV(repairSV(x).code)` makes zero further fixes.
- Gate: `maybeRepair({}, code)` returns the input byte-identical;
  `{syntaxRepair:true}` repairs.
- Live validation: a file exercising all classes → `verilator --lint-only`
  before vs after → error count drops (documented in the commit).
