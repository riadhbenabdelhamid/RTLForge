# Deterministic syntax repair

Production syntax repair is a compiler-validated transaction. A matching regex,
idempotence, or a clean compile alone does not establish behavioral correctness.

## Production acceptance

`src/pipeline/syntaxRepairGate.js` is used by generation, best-of-N ranking,
checker qualification, lint repairs, review repairs, and formal RTL repairs.
With `syntaxRepair` disabled it returns the input unchanged. When enabled:

1. Propose edits from a closed syntax-only allowlist. New rules default to
   deferred. Timing, initialization, width/base interpretation, declaration
   hoisting, inferred signals, and other behavioral changes remain for the
   normal model repair and behavioral acceptance process.
2. Compile the raw candidate and proposed candidate using the same compiler
   command, top selection, source files, shared package, children, configuration,
   timeout, and cancellation signal. Only the candidate file changes.
3. Preserve compiling raw code. If a rewrite breaks compilation, discard the
   transaction and quarantine the first rule whose prefix fails compilation.
4. Accept a syntax transaction only when raw compilation fails and the proposal
   compiles. If either result is unavailable or both fail, preserve the raw code.
5. Continue ordinary lint, simulation, and formal qualification. A successful
   syntax repair is not verification evidence for the design's behavior.

The configured RTL/TB lint command is used when present; otherwise the gate uses
Verilator with timing enabled and explicit top selection. Warnings made fatal by
user configuration remain fatal for this check. There are normally two compiler
calls per transaction, with additional prefix checks only after a regression.
Unchanged candidates and deferred-only proposals require no compiler calls.

The syntax-only allowlist covers fence leakage, stray quotes on fill literals,
colon-style port declarations, malformed task names and parameter headers,
Verilator metacomments, stray ticks before brackets, and proven duplicate module
variables. The other legacy transformations are available for proposal inspection
but are not automatically applied by the pipeline.

## Declaration scope

Duplicate deletion is limited to exact, uninitialized declarations directly in
a proven module body. Each module has its own declaration set. Interface, package,
class, task, function, procedural, and generate scopes cannot donate declarations
to another scope. Nested local declarations are left alone.

The scanner deliberately supports a subset of SystemVerilog. Preprocessor
syntax, escaped names, unbraced multiline controls, structures, prototypes,
assertion scopes, and malformed/unbalanced scope trees cause it to abstain.
Unsupported syntax goes to the ordinary compiler and repair path.

## Evidence and persistence

Each stage records `_syntaxRepairSafety` with raw code, replayable per-rule
diffs (offset, removed text, inserted text), deferred rules, compiler diagnostics, the acceptance outcome,
and quarantined rules. The runtime session is shared with nested reflows. Stage
artifacts carry quarantine across stage boundaries and checkpoint resumes; a
fresh pipeline with no artifacts starts with no quarantine. No global blacklist
or model call is involved.

`repairSV`, `maybeRepair`, and `repairRtlCandidate` retain their synchronous
proposal API for compatibility. They do **not** authorize adoption. Production
callers must use `repairCandidate` / `repairRtl` and the stage audit wrapper.

## Review budgets and rejection feedback

`maxTestReviewIters` and `maxRtlReviewIters` cap repairs across a review tree.
Nested reviews assess the candidate without starting a second repair loop.
Corrective re-asks and inline fallbacks after attempted chains share the same
allowance. A zero limit allows assessment without repair. Existing stage call,
transport retry, token, and runtime limits remain independently enforced.

Compiler-rejected proposals feed their candidate and actual diagnostics into the
next repair prompt. Two identical rejected proposals with the same reason and
diagnostics stop the loop. Infrastructure loss and review regressions are also
recorded. `_repairBudget` records the limit, use, rejections, and stop reason;
unresolved review findings remain unresolved when the budget ends.

For a normal Test Review chain with a limit of four, the maximum is one initial
review plus four generation/assessment pairs (nine model calls), excluding
transport/schema retries. The prior nested loops could multiply that allowance.

## Tests

Generic fixtures in `tests/syntaxRepairSafety.test.js` compile with Icarus and
exercise production generation, separate modules/interfaces, local scopes,
preprocessing, unsupported syntax, and preservation under addition of unrelated
modules. An injected defective transform proves raw-candidate rollback and
quarantine across subsequent calls and checkpoint resume. Tests also cover
unavailable compilers, cancellation, and deferred interpretations.

`tests/reviewRepairBudget.test.js` exercises production reflow and inline review
with bounded model replay, including compiler rejection feedback and repeated
failure termination. No benchmark identifiers, reference implementations, or
benchmark-specific repair rules are used.
