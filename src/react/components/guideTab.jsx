// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// GuideTab — an in-app guide to the RTL Forge GUI, shown as a tab inside
// Settings. It has its OWN sub-tabs, each explaining one area of the interface
// (the pipeline, the stage badges, the Convergence strip, the fix loops, the
// system/integration view, and how to read a stage's results). Pure/static —
// no config reads or writes; it only renders explanatory content.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { TH } from "../../constants/theme.js";
import { SubTab } from "./atoms.jsx";

const MONO = TH.fontMono || "monospace";

// ── small presentational helpers, shared by every sub-tab ──
function GH({ children }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: TH.accent, textTransform: "uppercase", letterSpacing: 1, margin: "18px 0 7px" }}>{children}</div>;
}
function GP({ children }) {
  return <p style={{ fontSize: 12.5, lineHeight: 1.6, color: TH.text1, margin: "0 0 9px" }}>{children}</p>;
}
function M({ children, c }) {
  return <span style={{ fontFamily: MONO, background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 3, padding: "0 4px", fontSize: 11.5, color: c || TH.text0, whiteSpace: "nowrap" }}>{children}</span>;
}
function Row({ g, gc, children }) {
  return (
    <div style={{ display: "flex", gap: 11, alignItems: "baseline", margin: "4px 0" }}>
      <span style={{ fontFamily: MONO, color: gc || TH.text2, fontWeight: 700, minWidth: 40, textAlign: "center", flexShrink: 0 }}>{g}</span>
      <span style={{ fontSize: 12.5, color: TH.text1, lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}
function Note({ children }) {
  return <div style={{ fontSize: 12, lineHeight: 1.55, color: TH.text2, background: TH.bg1, border: "1px solid " + TH.border, borderLeft: "3px solid " + TH.accent, borderRadius: 4, padding: "8px 11px", margin: "9px 0" }}>{children}</div>;
}
const GREEN = TH.green || TH.accent;

// ───────────────────────────── OVERVIEW ─────────────────────────────
function Overview() {
  return (
    <div>
      <GP>RTL Forge turns a natural-language hardware description into verified SystemVerilog by running it through a multi-stage pipeline of LLM agents and real tools (Verilator, SymbiYosys). Each stage's output feeds the next; failing stages loop back and fix their input rather than giving up.</GP>
      <GH>Two modes</GH>
      <Row g="Module" gc={TH.blue}>One design, one pipeline. You describe a single module and it walks every stage to a verified result.</Row>
      <Row g="System" gc={TH.orange}>A multi-module SoC. Your description is <M>decomposed</M> into a module tree; each module runs its own pipeline (leaves first), then an <b>integration</b> pass wires and verifies the whole system.</Row>
      <GH>The run lifecycle</GH>
      <GP>Idle → (System only) Decompose &amp; confirm the tree → per-module pipeline(s) → (System) Integration → Done. The left rail shows modules and their progress; the center shows the active stage; the top strip shows <b>Convergence</b> (are the fix loops winning?). Everything is checkpointed, so you can close and resume.</GP>
      <Note>Use the other sub-tabs here to learn each area: <b>Pipeline</b> (the stages), <b>Stage badges</b> (the ○ ✓ ! dots), <b>Convergence</b> (the top strip), <b>Fix loops</b> (how stages self-correct), <b>System</b> (integration), and <b>Reading results</b> (Duration/Tokens/Iterations tabs).</Note>
    </div>
  );
}

// ───────────────────────────── PIPELINE ─────────────────────────────
function Pipeline() {
  const stage = (n, d) => <Row g={n} gc={TH.text2}>{d}</Row>;
  return (
    <div>
      <GP>A module flows through these stages in order. Optional stages (marked ⚙) only run when enabled in the Workflow tab.</GP>
      <GH>Specification</GH>
      {stage("Elicit", "Turns your prompt into structured intent (module name, interface sketch, requirements).")}
      {stage("Spec", "Formal specification: ports, parameters, and Must/Should requirements.")}
      {stage("Architect", "A design plan (state machines, datapath, submodules) the RTL stage implements.")}
      <GH>Implementation &amp; static checks</GH>
      {stage("RTL Gen", "Generates the SystemVerilog module from the spec + architecture.")}
      {stage("RTL Review ⚙", "An LLM code review that fixes critical/major issues before linting.")}
      {stage("Lint", "Real Verilator lint with a fix loop — iterates until errors reach 0.")}
      {stage("Formal ⚙", "Bounded model check (SymbiYosys) of the bound properties.")}
      <GH>Verification</GH>
      {stage("Test Gen", "Generates a self-checking testbench from the requirements.")}
      {stage("Test Review ⚙", "Reviews the testbench for coverage and correctness.")}
      {stage("Lint Test", "Verilator lint of the testbench, with its own fix loop.")}
      {stage("Verify", "Compiles RTL + TB and RUNS the simulation; a fix loop repairs failures (triaged to RTL vs TB).")}
      {stage("Judge", "Scores the whole result and can trigger a deeper reflow (regenerate an upstream stage) if it isn't good enough.")}
      <Note>Any stage that finds a problem can <b>loop back</b> and regenerate an earlier stage instead of only patching in place — see the <b>Fix loops</b> sub-tab.</Note>
    </div>
  );
}

// ─────────────────────────── STAGES IN DEPTH ───────────────────────────
// One card per pipeline stage: what it does, what it consumes/produces,
// and how to read (or distrust) its result. Kept in sync with the nodes in
// src/pipeline/nodes/ — when a stage gains a guard or a new verdict, its
// card here is part of the change.
function StageCard({ name, tag, tagColor, children }) {
  return (
    <div style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 5, padding: "10px 13px", margin: "8px 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: TH.text0 }}>{name}</span>
        {tag && <span style={{ fontSize: 9.5, fontWeight: 700, color: tagColor || TH.text2, textTransform: "uppercase", letterSpacing: 0.7 }}>{tag}</span>}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: TH.text1 }}>{children}</div>
    </div>
  );
}
function SL({ label, children }) {
  return (
    <div style={{ margin: "3px 0" }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: TH.text2, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}: </span>
      <span>{children}</span>
    </div>
  );
}
function StagesInDepth() {
  return (
    <div>
      <GP>Every stage in order, with what it actually does under the hood. LLM stages call your configured model; tool stages run real binaries (Verilator, SymbiYosys, slang) — a <M>Real CLI</M> tag on a result means measured evidence, an <M>AI Estimated</M> tag means the backend was unreachable and the number is a guess.</GP>

      <StageCard name="Elicit" tag="LLM">
        <SL label="Does">Reads your natural-language description and turns it into structured intent: the module name, a domain guess, an interface sketch, clarifying questions, and explicit assumptions for everything you didn't say.</SL>
        <SL label="Produces">Questions + assumptions the Spec stage builds on. In a headless/CLI run the questions go unanswered and the documented defaults apply.</SL>
        <SL label="Read it as">The place to check that the tool understood <i>what you meant</i>. A wrong assumption here propagates everywhere — it's the cheapest stage to correct.</SL>
      </StageCard>

      <StageCard name="Spec" tag="LLM + guard" tagColor={TH.accent}>
        <SL label="Does">Converts intent into the formal contract every later stage is measured against: the port list (<M>iface</M>), parameters, and categorized Must/Should requirements (<M>REQ-FUNC-001</M> …).</SL>
        <SL label="Guarded by">A deterministic malformed-spec check: the requirements and iface arrays must be non-empty, signals you literally named (e.g. <M>wr_en</M>) must appear as ports, and at least one functional Must requirement should exist. Violations trigger one corrective re-ask; a still-broken schema halts the run honestly instead of building against an empty contract for hours.</SL>
        <SL label="Read it as">The ground truth. Reviews and the Judge score against THIS, not your original prompt — if the spec is wrong, everything downstream will be faithfully, verifiably wrong.</SL>
      </StageCard>

      <StageCard name="Architect" tag="LLM">
        <SL label="Does">Plans the implementation before any code: design strategy, block structure, state machines, and a mermaid diagram of the datapath.</SL>
        <SL label="Read it as">A sanity check that the approach is sound (pointer widths, buffering scheme, FSM states) — architecture mistakes are cheaper to catch here than in RTL review.</SL>
      </StageCard>

      <StageCard name="RTL Gen" tag="LLM + repair" tagColor={TH.accent}>
        <SL label="Does">Writes the synthesizable SystemVerilog module from spec + architecture, under strict synthesisability rules (always_ff/always_comb discipline, reset for every flop, capacity-representable occupancy state, …).</SL>
        <SL label="Guarded by">A deterministic syntax-repair library (~20 transforms for measured LLM error families: markdown fences, C idioms, parameters referenced as macros, duplicate declarations…) runs on every candidate, plus guards against placeholder output and leaked testbench modules.</SL>
        <SL label="Read it as">The artifact. The Duration/Tokens tabs show what it cost; <M>_syntaxRepairs</M> in the result names any mechanical fixes that were applied silently.</SL>
      </StageCard>

      <StageCard name="RTL Review" tag="LLM · optional" tagColor={TH.orange}>
        <SL label="Does">A structured code review against the spec (interface compliance, requirement traceability, synthesisability, timing/reset, capacity representability). Critical/major findings trigger a fix loop that regenerates the RTL.</SL>
        <SL label="Guarded by">Every fix candidate passes the same quality bar as generation: echo-stripping, deterministic repair, and a lint gate that rejects candidates with more compile errors than the code they replace — a review can no longer degrade clean RTL.</SL>
        <SL label="Read it as">NEEDS_FIX with a fix history is the loop working; a PASS score near 100 with zero findings on complex RTL deserves suspicion, not celebration.</SL>
      </StageCard>

      <StageCard name="Lint RTL" tag="Verilator" tagColor={TH.blue}>
        <SL label="Does">Real <M>verilator --lint-only</M> on the RTL with a fix loop: errors go back to the model with the exact diagnostics until they reach zero or the iteration cap.</SL>
        <SL label="Read it as">PASS/FAIL is decided by the error count (warnings are informational unless you raise the toggle). A FAIL here means the loop capped out — downstream stages still run, and the verify chain often rescues it with a fresh regeneration.</SL>
      </StageCard>

      <StageCard name="Test Gen" tag="LLM + repair" tagColor={TH.accent}>
        <SL label="Does">Writes a self-checking testbench: a behavioral reference model (<M>ref_</M> shadows), a canonical <M>step()</M> task, one directed test task per Must requirement, machine-readable <M>[PASS]/[FAIL]</M> markers, a watchdog, and capacity-boundary tests when the spec states a depth.</SL>
        <SL label="Guarded by">The same syntax-repair library, plus structural guards: checks must compare DUT ports directly against the reference (registered copies and self-referential checks are measured failure modes), and placeholder output halts honestly.</SL>
        <SL label="Read it as">The quality of this artifact bounds the honesty of Verify — a weak TB passing a broken design is the failure mode half this pipeline's defenses exist to prevent.</SL>
      </StageCard>

      <StageCard name="Test Review" tag="LLM + static analysis · optional" tagColor={TH.orange}>
        <SL label="Does">Reviews the testbench for requirement coverage, infrastructure, stimulus quality (does any test actually reach the capacity boundary?), and check correctness.</SL>
        <SL label="Guarded by">A deterministic check-coverage analyzer that parses the DUT instantiation and every <M>check()</M> condition: a requirement whose checks never observe a DUT signal is provably unverified and forces NEEDS_FIX regardless of the LLM's opinion — an LLM reviewer can be charmed by a green-looking TB; the static analysis cannot.</SL>
        <SL label="Read it as">The <M>_checkCoverage</M> field shows how many checks observe the DUT; forced NEEDS_FIX entries name the exact self-referential requirements.</SL>
      </StageCard>

      <StageCard name="Lint Test" tag="Verilator + slang" tagColor={TH.blue}>
        <SL label="Does">Lints the testbench like Lint RTL, optionally enriched by a slang sidecar that reports ALL errors where Verilator stops at the first — the fix loop sees the complete list (shown as "incl. N slang-only").</SL>
        <SL label="Read it as">Same semantics as Lint RTL: error count decides, warnings inform.</SL>
      </StageCard>

      <StageCard name="SVA Props" tag="LLM · optional" tagColor={TH.orange}>
        <SL label="Does">Generates formal SVA properties from the requirements, plus an optional <b>aux model</b> — <M>f_</M>-prefixed checker state driven only by ports (e.g. an <M>f_occ</M> occupancy counter) so invariants over hidden internal state become checkable — and a suggested BMC depth.</SL>
        <SL label="Guarded by">Deterministic identifier-closure validation: properties and aux may reference only ports, parameters, and declared <M>f_</M> names. Invalid aux gets one corrective re-ask naming the failing identifier; still-invalid pieces are dropped with reasons rather than breaking the build.</SL>
        <SL label="Read it as">Properties are consumed twice — bound into the Verilator simulation (checked along TB stimulus) and handed to the solver (checked exhaustively). The "Not bound" reasons matter: an unbound property is decorative.</SL>
      </StageCard>

      <StageCard name="Formal BMC" tag="SymbiYosys · optional" tagColor={TH.blue}>
        <SL label="Does">Bounded model checking: the solver explores EVERY input sequence up to the depth bound — stimulus-independent, unlike simulation. On a violation it returns a concrete counterexample trace (ground truth, not a flaky test) that grounds an RTL fix loop. After a PASS, one extra k-induction task runs opportunistically.</SL>
        <SL label="Verdicts">
          <M c={GREEN}>PROVEN</M> — induction closed; the properties hold for ALL time.{" "}
          <M>PASS (depth N)</M> — no violation within N cycles of reset; a bug needing more cycles would escape.{" "}
          <M c={TH.red}>FAIL</M> — a real counterexample exists.{" "}
          <M c={TH.orange}>SKIPPED</M> — nothing was checkable (reason shown).
          "Not proven" after a PASS says <i>nothing</i> about the design — correct designs routinely fail induction from unreachable states.
        </SL>
        <SL label="Read it as">The one oracle that catches bugs no testbench reaches (pointer-wrap corruption at unaligned phases was its measured win). Scope discipline: only the solver-checked properties are covered — the card lists what wasn't.</SL>
      </StageCard>

      <StageCard name="Verify" tag="Verilator sim" tagColor={TH.blue}>
        <SL label="Does">Compiles RTL + TB (+ the bound SVA checker) and RUNS the simulation. Failures enter a triaged fix loop: compile failures route deterministically by failing filename (no LLM call); functional failures are triaged to RTL vs TB, with waveform-grounded evidence when enabled.</SL>
        <SL label="Guarded by">Progress classification per iteration (ACCEPT_PROGRESS / REJECT_REGRESSION / REJECT_COMPILE_FAIL / near-repeat detection), best-known-state restore where a compiling measurement always outranks a compile failure, and TB-infrastructure-loss rejection on every adopted fix.</SL>
        <SL label="Read it as">The pass/fail table is per-requirement (<M>REQ-FUNC-001.2</M> …). The <M>verifyHistory</M> shows each iteration's decision — that is the honest record of whether the loop converged or was capped.</SL>
      </StageCard>

      <StageCard name="Judge" tag="Deterministic gate + LLM reflow" tagColor={TH.accent}>
        <SL label="Does">Runs the deterministic eval gate (requirements traced, verify pass rate, lint state — configurable criteria with thresholds) against the final state. On FAIL it triages a target stage and triggers full reflow chains (regenerate → review → lint → formal → verify) up to its iteration cap.</SL>
        <SL label="Guarded by">Vacuous passes are outlawed: zero functional Must requirements FAILS the requirements criterion (an empty contract cannot pass). <M>verified: true</M> requires real CLI simulation evidence — an LLM-estimated verify can score at most UNVERIFIED.</SL>
        <SL label="Read it as">The verdict of record. PASS 100 verified means every enabled criterion held on measured evidence; the recs list on FAIL names exactly which criterion fell short and by how much.</SL>
      </StageCard>
    </div>
  );
}

// ─────────────────────────── STAGE BADGES ───────────────────────────
function Badges() {
  return (
    <div>
      <GP>Each stage shows a status dot in the stage strip and the module rail:</GP>
      <Row g="○" gc={TH.text3}>Not started.</Row>
      <Row g="✓" gc={GREEN}>Complete and passing.</Row>
      <Row g="!" gc={TH.red}>Errored — the stage failed and halted (hover for the message).</Row>
      <GH>Motion means work in flight</GH>
      <GP>A stage badge that <b>pulses</b> is currently running. A brighter, faster yellow pulse means a <b>loopback</b> is targeting that stage — a later stage decided this earlier one needs regenerating (e.g. Verify sending RTL Gen back to fix a functional failure). When several stages pulse together, a multi-stage <M>K-to-X reflow</M> chain is walking through them.</GP>
      <Note>The number next to a running module (e.g. <M>stage 7/12</M>) is the current stage index over the count of active stages. Optional stages you turned off are not counted.</Note>
    </div>
  );
}

// ─────────────────────────── CONVERGENCE ────────────────────────────
function Convergence() {
  const chip = (txt, col) => <span style={{ fontFamily: MONO, color: col || TH.text1 }}>{txt}</span>;
  return (
    <div>
      <GP>The <b>Convergence</b> strip runs along the top of the run view and answers one question at a glance: <i>is this run converging or thrashing?</i> It shows one entry per looping stage, built from that stage's per-iteration history. It works live and on restored checkpoints.</GP>

      <GH>Anatomy of an entry</GH>
      <GP>Each entry reads left to right as: <b>label</b> · <b>chain</b> · <b>trend</b> · <b>final e/w</b>. For example:</GP>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: "5px 11px", margin: "2px 0 10px", fontSize: 12 }}>
        <span style={{ color: TH.text1, fontWeight: 600 }}>Lint Test</span>
        {chip("3→43→1")}
        <span style={{ color: GREEN, fontWeight: 700 }}>▼</span>
        <span style={{ color: TH.text3 }}>1e/1w</span>
      </div>
      <Row g="chain" gc={TH.text2}>The <b>error count after each fix iteration</b>, left to right. The arrow just separates iterations — it does <i>not</i> mean "increased to". <M>3→43→1</M> = 3 errors, then a round whose fix regressed to 43, then a round that recovered to 1.</Row>
      <Row g="trend" gc={TH.text2}>The direction of the <b>last</b> step (see legend below).</Row>
      <Row g="e/w" gc={TH.text2}>The final iteration's errors/warnings. <M>1e/1w</M> = 1 error, 1 warning still present.</Row>

      <GH>Trend glyphs</GH>
      <Row g="▼" gc={GREEN}>Improving — badness fell on the last iteration.</Row>
      <Row g="▲" gc={TH.red}>Regressing — badness rose (a fix made it worse).</Row>
      <Row g="▶" gc={TH.yellow}>Stuck — no change on the last iteration.</Row>
      <Row g="·" gc={TH.text3}>Single — only one data point so far, no trend yet.</Row>

      <GH>What each stage counts</GH>
      <Row g="Lint" gc={TH.text2}>chain = <b>errors</b> per iteration; detail = <M>Ne/Mw</M>. Errors are the target — warnings don't block convergence.</Row>
      <Row g="Verify" gc={TH.text2}>chain = <b>failing tests</b> per iteration; detail = <M>pass/total</M>.</Row>
      <Row g="Judge" gc={TH.text2}>chain = <b>unmet criteria</b> per iteration; detail = <M>unmet/total</M>.</Row>

      <GH>Reading it</GH>
      <GP>The chain turns <span style={{ color: GREEN, fontWeight: 600 }}>green</span> once it reaches <M c={GREEN}>0</M> — that stage <b>converged</b>. A chain that ends above 0 (like <M>…→1</M> with a <M>1e</M> detail) means the loop stopped <i>before</i> clearing everything — it hit its iteration cap, a stagnation/oscillation stop, or the run budget. A big spike in the middle (the <M>43</M> above) is exactly the <b>thrashing</b> this strip exists to surface: a fix round made things much worse before another recovered. Hover any entry for the full per-iteration <M>e/w</M> breakdown.</GP>

      <GH>Generation chips</GH>
      <GP>To the right you may see small chips like <M>RTL gen: 2 syntax repair(s)</M> or <M>RTL gen: best-of-4 picked #2</M> — one-line facts about how the code was produced (deterministic syntax repairs applied, or which best-of-N candidate won).</GP>

      <Note>Worked example — <M>Lint Test 3→43→1 ▼ 1e/1w</M>: the testbench lint ran three fix rounds; errors went 3 → 43 → 1. The middle spike means round 2's fix regressed hard; the <b>▼</b> says the last step improved, but the trailing <M>1e/1w</M> shows it did <i>not</i> fully converge — it stopped with 1 error and 1 warning left. That row is worth expanding (its Iterations tab shows each round's diff) to see the surviving error.</Note>
    </div>
  );
}

// ─────────────────────────── FIX LOOPS ──────────────────────────────
function FixLoops() {
  return (
    <div>
      <GP>Lint, Verify, and Judge don't fail on the first problem — they iterate. Each round measures the result with a real tool, asks the model for a fix, re-measures, and keeps going until it converges or hits a stop.</GP>
      <GH>Two ways a stage fixes</GH>
      <Row g="Patch" gc={TH.text2}>An inline, targeted fix call: the stage hands the model the current code plus the findings and gets a corrected version back.</Row>
      <Row g="Reflow" gc={TH.text2}>A deeper <M>K-to-X</M> chain: instead of patching, it re-runs a slice of the pipeline (e.g. RTL Gen → RTL Review → Lint) so the code is regenerated through the real stages.</Row>
      <GH>How a loop protects you</GH>
      <Row g="best-known" gc={TH.text2}>Every iteration is scored; if a later round is worse, the stage restores the best round rather than shipping the last one.</Row>
      <Row g="regression" gc={TH.text2}>A fix is compared to the original baseline — one that introduces new problems elsewhere is <b>rejected, not adopted</b>: the next attempt works on the current (good) code and is told exactly what the rejected patch broke. (The measurement still shows as a spike in the Convergence chain.)</Row>
      <Row g="stagnation" gc={TH.text2}>Identical or oscillating candidates (A→B→A) are detected and the loop stops instead of burning iterations.</Row>
      <Row g="no-delete" gc={TH.text2}>A "fix" that deletes the module body (an empty module lints clean but is not a fix) is rejected; the loop re-asks for a complete, working replacement and only keeps the current code as a last resort.</Row>
      <Row g="time brake" gc={TH.text2}>No stage's loops run past <M>maxStageMinutes</M> (default 20) of wall-clock — nested reflow chains share the stage's clock, so the whole tree is bounded. Tripping is graceful: best-known result kept, honest status.</Row>
      <Row g="errors first" gc={TH.text2}>While errors exist, the fixer is asked to resolve <b>only errors</b> — warnings join the ask only when they're the convergence target. Smaller asks mean smaller diffs and fewer regressions.</Row>
      <GH>Informed loopback</GH>
      <GP>When a stage sends an earlier one back, it forwards <i>why</i> — the lint findings, failing tests, or review issues — so the regeneration is a targeted repair, not a blind re-roll. Lint findings are also turned into concrete <b>fix rules</b> (e.g. "use non-blocking <M>&lt;=</M> in clocked blocks") drawn from the same rule set the <b>Training</b> tab builds.</GP>
      <Note>Every knob (max iterations per stage, reflow mode, budget caps) lives in the <b>Workflow</b> and <b>LLM</b> tabs. Lower caps converge faster but leave more findings; higher caps chase perfection at the cost of time and tokens.</Note>
    </div>
  );
}

// ──────────────────────── SYSTEM / INTEGRATION ──────────────────────
function System() {
  return (
    <div>
      <GP>In <b>System</b> mode your description is decomposed into a module tree, shown for confirmation before any code is written. Modules build in dependency order (leaves first); parents see their children's <i>interfaces</i> so they instantiate against real port lists.</GP>
      <GH>The Integration view</GH>
      <Row g="int_lint" gc={TH.text2}>A deterministic wiring check (bad port names, unconnected inputs, missing instances) plus real Verilator lint over the whole assembled file set.</Row>
      <Row g="int_test" gc={TH.text2}>A system testbench that drives the top module and runs the real simulation end-to-end.</Row>
      <Row g="int_judge" gc={TH.text2}>A system-level verdict and score across all modules.</Row>
      <GH>When integration blames a module</GH>
      <GP>If a system lint/sim failure is attributed to one child module, the integration panel shows a one-click <M>🔁 Re-run &lt;module&gt; &amp; re-integrate</M> banner. It re-runs that module's pipeline <i>with the system-level evidence</i>, then re-enters integration — unchanged modules are skipped, so re-entry is cheap. A broken shared package is repaired (or dropped) automatically so it can't poison every file.</GP>
      <Note>The whole system build is available headlessly too: <M>rtlforge run --system "…"</M> runs decompose → per-module → integration from one command and consumes the same reflow contract automatically.</Note>
    </div>
  );
}

// ────────────────────────── READING RESULTS ─────────────────────────
function Results() {
  return (
    <div>
      <GP>Click any stage to open its result. Most stages share the same set of view tabs:</GP>
      <Row g="Output" gc={TH.text2}>The stage's product — generated code, the spec object, the lint report, the verify results.</Row>
      <Row g="Iterations" gc={TH.text2}>One expandable row per fix round, with the before/after <b>diff</b> and the parsed fix list. This is where a Convergence spike becomes a concrete "here's what round 2 changed".</Row>
      <Row g="Duration" gc={TH.text2}>Per-call latency across the stage, including every fix iteration and any nested reflow.</Row>
      <Row g="Tokens" gc={TH.text2}>Real input/output token counts per call (from the provider's usage, not an estimate).</Row>
      <Row g="Log" gc={TH.text2}>The full event trace: CLI runs, LLM calls, loop decisions (ACCEPT/REJECT, stagnation, re-ask), and reflow chains.</Row>
      <GH>The fixes list</GH>
      <GP>Lint/Verify/Review results carry a <b>fixes</b> list — each item references the finding it resolved (e.g. <M>[BLKSEQ#4]</M>) and what changed, tagged with the iteration that produced it.</GP>
      <GH>Verification provenance</GH>
      <GP>A Verify or Judge PASS tells you <i>how</i> it was verified: <span style={{ color: GREEN }}>real simulation (CLI backend)</span> vs <span style={{ color: TH.yellow }}>LLM-estimated</span>. Only a real-simulation PASS is trustworthy — connect a Verilator backend (CLI tab) for measured results.</GP>
      <Note>Everything here also exports: the Judge view's <b>Export Regression Suite</b> / <b>Export System Package</b> buttons write the RTL, testbench, and a one-page report to disk.</Note>
    </div>
  );
}

const SUBTABS = [
  { id: "overview",    label: "Overview",       body: Overview },
  { id: "pipeline",    label: "Pipeline",       body: Pipeline },
  { id: "stages",      label: "Stages in depth", body: StagesInDepth },
  { id: "badges",      label: "Stage badges",   body: Badges },
  { id: "convergence", label: "Convergence",    body: Convergence },
  { id: "fixloops",    label: "Fix loops",      body: FixLoops },
  { id: "system",      label: "System",         body: System },
  { id: "results",     label: "Reading results", body: Results },
];

export function GuideTab() {
  const [sub, setSub] = useState("overview");
  const Active = (SUBTABS.find(function(t) { return t.id === sub; }) || SUBTABS[0]).body;
  return (
    <div>
      <div style={{ fontSize: 11.5, color: TH.text2, marginBottom: 12, lineHeight: 1.5 }}>
        A field guide to the interface. Pick an area below.
      </div>
      <SubTab tabs={SUBTABS.map(function(t) { return { id: t.id, label: t.label }; })} active={sub} onChange={setSub} />
      <div style={{ maxHeight: "56vh", overflow: "auto", paddingRight: 8 }}>
        <Active />
      </div>
    </div>
  );
}
