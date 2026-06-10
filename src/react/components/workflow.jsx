// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/workflow — WorkflowTab
//
// WorkflowTab is the per-stage pipeline editor that lives inside the Settings
// panel: it shows an SVG flow graph of all active stages with loop-back arcs,
// and lets the user view/edit the system prompt sections for each stage.
//
// This file is its own module (separate from panels.jsx) because the
// `DEFAULT_PROMPT_SECTIONS` data structure is ~85 lines of inline prompt
// documentation — keeping it out of the shared panels module avoids shipping
// that payload to consumers who only need the dialogs.
//
// What WorkflowTab is allowed to read (props):
//   config            : project config object
//   setConfig         : config setter (updater function pattern)
//
// What WorkflowTab does NOT touch:
//   - useProject (it's nested inside SettingsPanel which has the config plumbing)
//   - the reducer (config is React useState-side state)
//
// Note on `confirm()` — the section-removal button uses `window.confirm`
// for a cheap user-confirmation prompt. This is browser-only behavior;
// in a non-browser test it would throw. The structural tests below don't
// trigger that path.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useMemo, useRef } from "react";
import { Tag, Btn, Label } from "./atoms.jsx";
import { TH } from "../../constants/theme.js";
import {
  ALL_STAGES,
  getActiveStages,
  OPTIONAL_STAGE_DEFS,
} from "../../constants/stages.js";
import { BASE_SYS } from "../../prompts/base.js";
import {
  serializeStageYaml,
  serializeAllStagesYaml,
  importPromptYaml,
} from "../../utils/promptYaml.js";

export function WorkflowTab({ config, setConfig }) {
  const [selectedNode, setSelectedNode] = useState(null);
  const [editingNode, setEditingNode] = useState(null);
  const [expandedSections, setExpandedSections] = useState({});
  const enabled = config.optionalStages || {};
  const stages = getActiveStages(config);

  // ── Default prompt section data (title + content) per stage key ──
  // Documentation-as-data: each entry mirrors a section that the
  // actual prompt builder functions would emit. Editing here updates
  // config.promptOverrides[stageKey] which the prompt builders honor.
  const DEFAULT_PROMPT_SECTIONS = useMemo(function() {
    return {
      elicit: [
        { title: "System Identity", content: BASE_SYS },
        { title: "Task", content: "Analyse the hardware module description and produce structured requirements-elicitation data." },
        { title: "Thinking Steps", content: "1. Identify the module domain and likely protocol/standard family.\n2. List every interface signal implied but not specified.\n3. Consider corner cases: reset behaviour, overflow/underflow, back-pressure, clock-domain crossings, parameterisation range limits.\n4. Derive assumptions that are reasonable defaults for the domain.\n5. Emit the JSON." },
        { title: "Question Requirements", content: "• MINIMALISM RULE: Do NOT over-engineer. Ask only questions the description leaves genuinely ambiguous.\n• Generate 10–20 questions total (fewer is fine if description is clear).\n• Distribute across ALL seven categories — at least 2 per category: INTF, PARAM, FUNC, ERR, TIME, VERIF, INTG.\n• Provide 3–5 options per question. LAST option MUST be \"Other (specify)\".\n• Questions must be specific and mutually exclusive." },
        { title: "Assumption Requirements", content: "• Generate 5–8 assumptions.\n• confirmed must be a JSON boolean (true or false), never a string.\n• revised must be null initially." },
        { title: "Output Schema", content: '{\n  "domain": "<e.g. FIFO buffer>",\n  "modName": "<snake_case>",\n  "questions": [{ "id": "INTF-01", "cat": "...", "text": "...", "opts": [...] }],\n  "assumptions": [{ "id": "A-01", "text": "...", "confirmed": true, "revised": null }]\n}' },
      ],
      spec: [
        { title: "System Identity", content: BASE_SYS },
        { title: "Task", content: "Convert elicited requirements into a formal, unambiguous hardware specification." },
        { title: "Thinking Steps", content: "1. Group answers by category and identify all interface signals.\n2. Derive must-have requirements first; then should/may.\n3. Ensure every port mentioned in requirements appears in iface.\n4. Ensure every parameterised dimension appears in params.\n5. Validate rationale traces back to a question answer or assumption.\n6. For skipped questions, use simplest sensible default.\n7. Emit JSON." },
        { title: "Requirement Rules", content: "• Generate 8–15 requirements covering all answered questions.\n• Each desc starts with \"The module shall\" (Must) or \"The module should\" (Should).\n• No duplicate ids.\n• rat must cite source or state \"[assumed]\"." },
        { title: "Interface Rules", content: "• Include every port: clk, rst_n (always present), plus all functional ports.\n• dir must be exactly \"input\", \"output\", or \"inout\".\n• width may use parameter names, e.g. \"DATA_W\"." },
        { title: "Parameter Rules", content: "• def must be a JSON number (not a string).\n• range uses Verilog bracket notation: \"[1:65535]\".\n• Include a param for every dimension in iface widths." },
        { title: "Output Schema", content: '{\n  "requirements": [{ "id": "REQ-INTF-001", "cat": "...", "pri": "Must", "desc": "...", "rat": "..." }],\n  "iface": [{ "name": "clk", "dir": "input", "width": "1", "desc": "..." }],\n  "params": [{ "name": "DATA_W", "type": "parameter", "def": 8, "range": "[1:1024]", "desc": "..." }]\n}' },
      ],
      architect: [
        { title: "System Identity + Mermaid Rule", content: BASE_SYS + '\n\nMERMAID RULE: The "mermaid" value must be a single JSON string. Use \\n for newlines and \\" for quotes inside node labels. Use graph TD.' },
        { title: "Task", content: "Design the micro-architecture for the module." },
        { title: "Thinking Steps", content: "1. Choose an implementation strategy (pipelined, registered, FSM-based, or combinational).\n2. Decompose into named logic blocks — as few as genuinely required.\n3. Sketch the Mermaid graph.\n4. Emit JSON." },
        { title: "Simplicity Rule", content: "Choose the simplest architecture that meets the spec. Do NOT add pipeline stages, FSMs, arbitration logic, or extra blocks unless the requirements explicitly demand them." },
        { title: "Output Schema", content: '{\n  "strategy": "<e.g. Synchronous FIFO with Gray-code pointers>",\n  "description": "<2-3 sentences>",\n  "blocks": [{ "name": "<BlockName>", "desc": "<one-line function>" }],\n  "mermaid": "graph TD\\n  A[\\"ClockDomain\\"] --> B[\\"WriteCtrl\\"]"\n}' },
      ],
      rtl_generate: [
        { title: "System Identity (Code-only)", content: "You are RTL Forge, a SystemVerilog expert. Respond with ONLY a JSON object: {\"code\":\"<complete SystemVerilog source>\"}. No markdown. No preamble." },
        { title: "Task", content: "Generate a complete, synthesisable IEEE 1800-2017 SystemVerilog module." },
        { title: "Coding Standard Checklist", content: "1. Module header: timescale 1ns/1ps, then module with all parameters before ports.\n2. All sequential logic uses always_ff @(posedge clk).\n3. All combinational logic uses always_comb or assign; never always @(*).\n4. Every always_comb/always_ff has full case/default coverage — no latches.\n5. All synchronous process registers initialised in reset branch.\n6. No implicit net declarations.\n7. Signal widths derived from parameters; no magic numbers.\n8. SVA assertions inside `ifdef FORMAL … `endif guards.\n9. Comment above every always block and major assign.\n10. Module ends with endmodule // <modName>." },
        { title: "Reset Polarity", content: "Derive from spec iface; if rst_n present → active-low async reset; if rst → active-high sync reset." },
        { title: "Strict Output Rules", content: "• The \"code\" string must contain ONLY the module definition (from `timescale to endmodule).\n• Do NOT include testbench code, standalone SVA modules, bind statements, or package definitions." },
        { title: "Output Schema", content: '{"code":"<full module source>"}' },
      ],
      rtl_review: [
        { title: "System Identity (Senior Reviewer)", content: BASE_SYS + "\n\nYou are a senior RTL design reviewer with 15+ years of ASIC/FPGA experience. Your review must be thorough, precise, and actionable. Do NOT invent issues." },
        { title: "Task", content: "Perform a thorough code review of the SystemVerilog module." },
        { title: "Review Checklist", content: "1. CORRECTNESS — All Must requirements implemented? Off-by-one errors? FSM completeness?\n2. SYNTHESISABILITY — Combinational loops? Latches? Blocking vs non-blocking?\n3. CODING STANDARD — always_ff/always_comb? Full case/default? Explicit declarations?\n4. TIMING & RESET — Polarity consistency? CDC handling? Output registration?\n5. NAMING & DOCUMENTATION — Meaningful signal names? Comments on major blocks?" },
        { title: "Scoring Rubric", content: "90-100: Production-ready, no issues\n70-89: Minor issues only, can proceed\n50-69: Major issues, should fix\n0-49: Critical issues, significant rewrite needed" },
        { title: "Verdict Rule", content: "\"PASS\" if score ≥ 70 (minor issues noted but don't block).\n\"NEEDS_FIX\" if score < 70 (critical/major issues require fixes)." },
        { title: "Output Schema", content: '{\n  "verdict": "PASS | NEEDS_FIX",\n  "score": 0-100,\n  "issues": [{ "id": "RR-001", "severity": "critical|major|minor|suggestion", "category": "...", "description": "...", "fix": "..." }],\n  "strengths": ["..."],\n  "summary": "..."\n}' },
      ],
      formal_props: [
        { title: "System Identity", content: BASE_SYS },
        { title: "Task", content: "Generate formal SVA properties and cover statements for the module." },
        { title: "Clock/Reset Analysis", content: "Automatically detects: purely combinatorial (no clock), single-clock synchronous, or multi-clock modules. Adjusts assertion forms accordingly." },
        { title: "Auto-Constraint Dedup", content: "Auto-derived constraints from spec parameter ranges are listed. LLM must NOT duplicate these assume properties." },
        { title: "Thinking Steps", content: "1. Map each Must requirement to at least one safety/liveness property.\n2. Identify corner-case scenarios worth covering.\n3. Verify every signal referenced exists in the RTL.\n4. Ensure disable iff uses correct reset polarity.\n5. Write the bind statement.\n6. Emit JSON." },
        { title: "Rules", content: "• One assert property per Must-priority requirement (minimum).\n• 3–5 cover statements for key functional scenarios.\n• type must be exactly \"assert\", \"assume\", or \"restrict\".\n• bind_module must be syntactically complete SV bind statement.\n• Do NOT reference signals not in the RTL." },
        { title: "Output Schema", content: '{\n  "properties": [{ "id": "SVA-001", "req": "REQ-FUNC-001", "type": "assert", "name": "...", "desc": "...", "code": "..." }],\n  "covers": [{ "id": "COV-001", ... }],\n  "bind_module": "bind <mod> <mod>_props u_props (.*);"  \n}' },
      ],
      lint: [
        { title: "System Identity", content: BASE_SYS },
        { title: "Task", content: "Analyse the generated RTL as Verilator --lint-only -Wall would." },
        { title: "Vocabulary", content: "Codes: UNUSED, UNDRIVEN, WIDTH, WIDTHCONCAT, WIDTHTRUNC, CASEINCOMPLETE, CASEOVERLAP, LATCH, IMPLICIT, MULTIDRIVEN, INITVAR, BLKSEQ, COMBDLY, REALCVT, TIMESCALE, PORTSHORT, PINMISSING, PINNOCONNECT, GENCLK, SYMRSVDWORD." },
        { title: "Evidence Rules", content: "Every finding MUST cite a real line and a real signal name. If you cannot localise a finding, do not emit it." },
        { title: "False-Positive Guards", content: "• Do not flag UNUSED on ports.\n• Do not flag WIDTH when an explicit cast is present.\n• Do not flag LATCH for always_ff blocks.\n• Do not flag CASEINCOMPLETE for unique case with full enum coverage." },
        { title: "Status Rule", content: "status is \"PASS\" iff errors.length === 0. Warnings alone never trigger FAIL." },
        { title: "Output Schema", content: '{\n  "tool": "Verilator 5.x (AI analysis)",\n  "status": "PASS | FAIL",\n  "warnings": [{ "id":"W-001","code":"UNUSED","sev":"warning","line":42,"signal":"tmp_q","msg":"…" }],\n  "errors": [...],\n  "summary": "…",\n  "log": "<CLI-style output>"\n}' },
      ],
      test_generate: [
        { title: "System Identity (Code-only)", content: "You are RTL Forge. Respond ONLY with JSON: {\"code\":\"<testbench source>\"}" },
        { title: "Task", content: "Generate a complete, self-checking testbench for the module that runs under Verilator without modification." },
        { title: "Mandatory Infrastructure", content: "• `timescale 1ns/1ps at top.\n• Clock period and timeout localparams.\n• apply_reset() task.\n• Watchdog initial block calling $finish(1) on timeout.\n• `CHECK(cond, label) macro that prints [PASS] or [FAIL].\n• Final [SUMMARY] passes=N fails=M line.\n• $finish(fails == 0 ? 0 : 1) — exit code reflects fails." },
        { title: "Test Requirements", content: "• One task_<id>() per Must requirement.\n• First line of each task: // covers: <REQ-ID>.\n• Use CHECK; never $error / $fatal / $random.\n• Edge cases per requirement where applicable: zero, max, reset-during-op, back-pressure." },
        { title: "Output Schema", content: '{"code":"<complete testbench source>"}' },
      ],
      test_review: [
        { title: "System Identity (Senior Verifier)", content: BASE_SYS + "\n\nYou are a senior verification engineer reviewing a SystemVerilog testbench. Be precise. Cite line numbers and task names." },
        { title: "Task", content: "Review the testbench for coverage, infrastructure, stimulus quality, and assertions." },
        { title: "Review Passes", content: "PASS A — Requirement coverage (must_reqs_covered / total).\nPASS B — Infrastructure (markers, watchdog, summary, no $error/$fatal).\nPASS C — Stimulus quality (reset duration, clock, edge cases).\nPASS D — Assertions & checking (right cycle, no magic numbers)." },
        { title: "Scoring", content: "Start 100. − 12 per missing Must req. − 8 per critical/major. − 2 per minor. − 5 if no watchdog. − 5 if disallowed calls present. Clamp [0,100]." },
        { title: "Verdict Rule", content: "PASS iff score ≥ 75 AND must_reqs_covered == must_reqs_total AND markers/watchdog/summary all present." },
        { title: "Output Schema", content: '{\n  "verdict": "PASS | NEEDS_FIX", "score": 0-100,\n  "coverage_assessment": { "must_reqs_total": N, "must_reqs_covered": N, "missing_reqs": [...], "covers_annotations_ok": true|false, "edge_cases_tested": [...], "edge_cases_missing": [...] },\n  "infrastructure": { "uses_pass_fail_markers": true|false, "watchdog_present": true|false, "summary_line_present": true|false, "uses_disallowed_calls": [...] },\n  "issues": [...], "strengths": [...], "summary": "…"\n}' },
      ],
      lint_test: [
        { title: "System Identity", content: "You are RTL Forge, a SystemVerilog verification expert. Respond with ONLY a JSON object matching the schema. Do NOT flag legitimate testbench constructs (initial, $display, $urandom, #delay in initial blocks, blocking assignments inside tasks). Flag ONLY real testbench problems." },
        { title: "Task", content: "Lint-analyse the generated testbench. Apply testbench-aware rules — many constructs that would be invalid in RTL are perfectly legal in a TB." },
        { title: "Vocabulary", content: "Codes: USES_DOLLAR_ERROR, USES_DOLLAR_RANDOM, MISSING_WATCHDOG, MISSING_FINISH, MISSING_SUMMARY, MISSING_PASS_FAIL, MISSING_COVERS, COVERS_MISMATCH, REQ_NOT_TESTED, HARDCODED_LITERAL, RACE_RISK, STIMULUS_DURING_RESET, WIDTH, IMPLICIT, PORT_MISSING, PORT_TYPO." },
        { title: "False-Positive Guards", content: "Do NOT flag: initial blocks, task automatic, $display/$write/$strobe/$monitor/$urandom, blocking = inside tasks, #delay in initial scope, @(posedge clk) waits in tasks, local int/logic in tasks, widths on the DUT itself (those belong to RTL lint)." },
        { title: "Evidence Rules", content: "Every finding MUST cite a real line + enclosing task name. If you cannot localise it, do not emit it." },
        { title: "Status Rule", content: "status is \"PASS\" iff errors.length === 0. Warnings alone never trigger FAIL." },
        { title: "Fix Rules (TB Fix sub-stage)", content: "• Address every listed finding by id; never invent fixes.\n• NEVER REDUCE COVERAGE: every Must REQ-ID still has a test_<id>() task with // covers: annotation.\n• PRESERVE INFRASTRUCTURE: clock, reset task, watchdog, [SUMMARY], $finish exit-code.\n• Replace any $error/$fatal with CHECK macro; replace $random with $urandom.\n• KEEP DUT INSTANCE PORTS UNCHANGED.\n• Minimal-diff: only touch lines required by findings." },
        { title: "Output Schema", content: '{\n  "tool": "Verilator-TB (AI analysis)",\n  "status": "PASS | FAIL",\n  "warnings": [{ "id":"TBW-001","code":"MISSING_COVERS","sev":"warning","line":42,"task":"test_reset","msg":"…" }],\n  "errors": [{ "id":"TBE-001","code":"USES_DOLLAR_ERROR","sev":"error","line":17,"task":"test_full","msg":"…" }],\n  "summary": "…",\n  "log": "<one finding line per row>"\n}' },
      ],
      verify: [
        { title: "System Identity", content: BASE_SYS },
        { title: "Task", content: "Analyse testbench vs RTL. If CLI backend available, run real simulation; otherwise estimate." },
        { title: "Triage (on failure)", content: "On failure, a triage step classifies root cause:\n• \"test_generate\" — testbench stimulus/assertion is wrong\n• \"rtl_generate\" — RTL logic is functionally incorrect\n• \"spec\" — requirements are ambiguous/contradictory" },
        { title: "Output Schema", content: '{\n  "sim": "Verilator (AI-estimated)",\n  "total": N, "pass": N, "fail": N,\n  "cov": { "line": 0-100, "branch": 0-100, "toggle": 0-100 },\n  "tests": [{ "name": "...", "st": "PASS", "cyc": N, "ms": N }],\n  "log": "..."\n}' },
      ],
      judge: [
        { title: "System Identity", content: BASE_SYS },
        { title: "Evidence Summary", content: "Gathers: requirements list, lint status + iteration count, formal property count, verify pass rate, coverage percentages." },
        { title: "Scoring Rubric", content: "Lint PASS + no warnings: +25\nLint PASS + warnings: +15\nAll Must requirements traced + ok: +35\nVerify pass rate 100%: +25\nCoverage ≥ 80% avg: +10\nFormal props exist: +5" },
        { title: "Verdict Rule", content: "overall is \"PASS\" if score ≥ 70 AND lint.status is \"PASS\" AND all Must requirements in trace with ok: true." },
        { title: "Trace Rule", content: "trace must contain one entry for EVERY requirement id — no omissions." },
        { title: "Recommendation Rules", content: "• 2–5 recommendations, each specific and actionable.\n• Do not give generic advice like \"improve code quality\"." },
        { title: "Output Schema", content: '{\n  "overall": "PASS | FAIL",\n  "score": 0-100,\n  "trace": [{ "req": "REQ-ID", "ok": true, "note": "..." }],\n  "recs": ["..."]\n}' },
      ],
      // Observer agent (optional). Two prompts:
      //   1. EXTRACTION  — what to capture from a finished stage
      //   2. SURFACING   — how to phrase flags to the user
      // The extractor.js module reads `config.promptOverrides._observer`
      // (sections 0+1) at LLM-call time; pre-override it uses the
      // defaults below.
      _observer: [
        { title: "Extraction — System Identity", content:
          "You are an observer agent extracting insights from a hardware-design pipeline run. " +
          "Your job is to spot noteworthy patterns: recurring errors, fixes that worked, " +
          "skills that helped or hurt, prompt drift, unusual costs. " +
          "Respond with ONLY a JSON object matching the schema. No prose, no markdown."
        },
        { title: "Extraction — Schema", content:
          '{\n' +
          '  "kind":       "error" | "fix" | "skill_effect" | "drift" | "cost" | "nothing",\n' +
          '  "summary":    "<one line, ≤120 chars, plain text>",\n' +
          '  "severity":   "info" | "warn" | "high",\n' +
          '  "tags":       ["<short keyword>", ...],\n' +
          '  "actionable": true | false\n' +
          '}'
        },
        { title: "Extraction — Rules", content:
          "Rules:\n" +
          "- Return {\"kind\":\"nothing\"} if the stage was uneventful (e.g. clean pass with no fixes, no warnings, normal cost).\n" +
          "- Use kind=\"error\" for unrecovered failures or recurring lint/verify errors.\n" +
          "- Use kind=\"fix\" when a fix was successfully applied that was noteworthy.\n" +
          "- Use kind=\"skill_effect\" when a skill overlay helped or hurt this stage.\n" +
          "- Use kind=\"drift\" when output quality seems off from typical (regression).\n" +
          "- Use kind=\"cost\" when token usage or latency is unusually high.\n" +
          "- severity=high if user should be alerted; warn if useful to know; info otherwise.\n" +
          "- Tags are 1-4 short keywords for clustering (e.g. \"width-mismatch\", \"reset-polarity\").\n" +
          "- actionable=true if the user could change something based on this observation."
        },
        { title: "Surfacing — Template",     content:
          "When presenting an observation to the user, use this phrasing template:\n\n" +
          "  [<severity icon>] <kind>: <summary>\n" +
          "  Stage: <stage_key>  ·  Tags: <tags>\n" +
          "  <actionable hint when actionable=true>\n\n" +
          "Tone is informative, never alarming. The user reads observations in their own time; " +
          "this is not an interruption."
        },
      ],
    };
  }, []);

  // ── Editable prompt overrides stored in config ──
  function getPromptSections(stageKey) {
    const overrides = (config.promptOverrides || {})[stageKey];
    if (overrides && overrides.length > 0) return overrides;
    return DEFAULT_PROMPT_SECTIONS[stageKey] || [];
  }
  function setPromptSections(stageKey, sections) {
    setConfig(function(c) {
      const po = Object.assign({}, c.promptOverrides || {});
      po[stageKey] = sections;
      return Object.assign({}, c, { promptOverrides: po });
    });
  }
  function restoreDefaults(stageKey) {
    setConfig(function(c) {
      const po = Object.assign({}, c.promptOverrides || {});
      delete po[stageKey];
      return Object.assign({}, c, { promptOverrides: po });
    });
  }
  const hasOverride = function(stageKey) {
    return !!((config.promptOverrides || {})[stageKey]);
  };

  // ── YAML import/export plumbing (per-stage and bundle) ──
  // We expose a recommendation in the UI showing config.settingsDir if set;
  // browsers can't write directly to that path (sandboxing) but desktop
  // wrappers (Electron/Tauri) can use it. The "download" path uses a Blob
  // URL which the browser puts in Downloads — same UX as the existing
  // module export.
  const stageFileRef = useRef(null);     // hidden <input> for single-stage import
  const bundleFileRef = useRef(null);    // hidden <input> for bundle import
  const [yamlNotice, setYamlNotice] = useState(null);   // {kind: ok|err, text}
  const [pendingImport, setPendingImport] = useState(null); // confirmation dialog state

  function _showNotice(kind, text) {
    setYamlNotice({ kind: kind, text: text });
    if (typeof window !== "undefined") {
      window.setTimeout(function() { setYamlNotice(null); }, 5000);
    }
  }

  function _downloadText(filename, text) {
    if (typeof window === "undefined") return;
    try {
      const blob = new Blob([text], { type: "text/yaml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(function() { URL.revokeObjectURL(url); }, 100);
      _showNotice("ok", "Saved " + filename + (config.settingsDir ? " (recommended location: " + config.settingsDir + ")" : ""));
    } catch (e) {
      _showNotice("err", "Download failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function exportStageYaml(stageKey) {
    const sections = getPromptSections(stageKey);
    const yaml = serializeStageYaml(stageKey, sections);
    _downloadText("rtlforge-prompt-" + stageKey + ".yaml", yaml);
  }

  function exportAllStagesYaml() {
    // Bundle ALL stages whose sections are EITHER overridden or have defaults.
    // We export the full effective set (defaults + overrides) so users can
    // hand the bundle to a colleague and they get a complete starting point.
    const bundle = {};
    ALL_STAGES.forEach(function(s) {
      const sections = getPromptSections(s.key);
      if (sections && sections.length > 0) bundle[s.key] = sections;
    });
    if (Object.keys(bundle).length === 0) {
      _showNotice("err", "No prompt sections to export");
      return;
    }
    const yaml = serializeAllStagesYaml(bundle);
    _downloadText("rtlforge-prompts-bundle.yaml", yaml);
  }

  // Import handlers — read text via FileReader, then parse + show confirmation.
  function _handleFileSelected(file, expectedKind, expectedStageKey) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const text = String(e.target && e.target.result || "");
        const parsed = importPromptYaml(text);
        // Validate against expectation, if any
        if (expectedKind === "single" && parsed.kind !== "single") {
          throw new Error("expected a single-stage YAML (with top-level 'stage:'), got a bundle");
        }
        if (expectedKind === "single" && expectedStageKey && parsed.stageKey !== expectedStageKey) {
          throw new Error("YAML is for stage '" + parsed.stageKey + "' but you opened it from the '" + expectedStageKey + "' editor. Confirm to apply anyway, or cancel and re-import from the correct stage.");
        }
        setPendingImport({ parsed: parsed, sourceFile: file.name });
      } catch (err) {
        _showNotice("err", "Import failed: " + (err && err.message ? err.message : String(err)));
      }
    };
    reader.onerror = function() {
      _showNotice("err", "Could not read file: " + file.name);
    };
    reader.readAsText(file);
  }

  function applyPendingImport() {
    if (!pendingImport) return;
    const p = pendingImport.parsed;
    setConfig(function(c) {
      const po = Object.assign({}, c.promptOverrides || {});
      if (p.kind === "single") {
        po[p.stageKey] = p.sections;
      } else {
        // Bundle: merge — overwrite per stage, keep existing for stages not in bundle
        Object.keys(p.stages).forEach(function(k) {
          po[k] = p.stages[k];
        });
      }
      return Object.assign({}, c, { promptOverrides: po });
    });
    const summary = p.kind === "single"
      ? "Imported " + p.sections.length + " section(s) for stage '" + p.stageKey + "'"
      : "Imported bundle: " + Object.keys(p.stages).length + " stage(s) updated";
    _showNotice("ok", summary);
    setPendingImport(null);
  }
  function cancelPendingImport() { setPendingImport(null); }

  // ── Stage name map for display ──
  const STAGE_NAMES = {};
  ALL_STAGES.forEach(function(s) { STAGE_NAMES[s.key] = s.label; });
  // Synthetic observer node — not a pipeline stage but uses the
  // same node-detail editor pattern.
  STAGE_NAMES._observer = "Observer Agent";

  // ── Loopback / fix connections ──
  // These represent conditional edges that loop backward in the pipeline.
  const LOOPBACK_EDGES = [
    { from: "lint",        to: "rtl_generate",  label: "RTL Fix",     color: TH.orange, condition: "lint errors found" },
    { from: "rtl_review",  to: "rtl_generate",  label: "Review Fix",  color: TH.orange, condition: "review verdict NEEDS_FIX" },
    { from: "test_review", to: "test_generate", label: "Review Fix",  color: TH.orange, condition: "review verdict NEEDS_FIX" },
    { from: "lint_test",   to: "test_generate", label: "TB Fix",      color: TH.orange, condition: "TB lint errors found" },
    { from: "verify",      to: "rtl_generate",  label: "RTL Fix",     color: TH.red,    condition: "triage → RTL is wrong" },
    { from: "verify",      to: "test_generate", label: "TB Fix",      color: TH.yellow, condition: "triage → TB is wrong" },
    { from: "judge",       to: "spec",          label: "Spec Refine", color: TH.red,    condition: "triage → spec ambiguous" },
    { from: "judge",       to: "rtl_generate",  label: "RTL Regen",   color: TH.red,    condition: "triage → RTL wrong" },
    { from: "judge",       to: "test_generate", label: "TB Regen",    color: TH.yellow, condition: "triage → TB wrong" },
  ];

  // ── Connections data ──
  const IO = {
    elicit:        { inp: ["User description"],                       out: ["domain", "modName", "questions[]", "assumptions[]"],   del: [] },
    spec:          { inp: ["Elicit answers", "Assumptions"],          out: ["requirements[]", "iface[]", "params[]"],               del: [] },
    architect:     { inp: ["Spec"],                                   out: ["strategy", "blocks[]", "mermaid"],                     del: [] },
    rtl_generate:  { inp: ["Architecture", "Spec"],                   out: ["code (SystemVerilog)"],                                del: ["RTL source (.sv)"] },
    rtl_review:    { inp: ["RTL code", "Spec", "Architecture"],       out: ["verdict", "score", "issues[]", "fixed code"],          del: [] },
    formal_props:  { inp: ["RTL code", "Spec", "Auto-constraints"],   out: ["properties[]", "covers[]", "bind_module"],             del: ["SVA source (.sv)"] },
    lint:          { inp: ["RTL code"],                               out: ["status", "errors[]", "warnings[]", "fixed code"],      del: [] },
    test_generate: { inp: ["RTL code", "Spec"],                       out: ["code (Testbench)"],                                    del: ["TB source (.sv)"] },
    test_review:   { inp: ["TB code", "RTL code", "Spec"],            out: ["verdict", "score", "issues[]", "fixed TB"],            del: [] },
    lint_test:     { inp: ["TB code", "RTL code (for cross-check)"],  out: ["status", "errors[]", "warnings[]", "fixed TB"],        del: [] },
    verify:        { inp: ["RTL code", "TB code", "Spec"],            out: ["pass/fail", "coverage", "tests[]", "sim log"],         del: [] },
    judge:         { inp: ["All stage results"],                      out: ["overall", "score", "trace[]", "recs[]"],               del: ["Regression suite (.zip)", "Module package (.json)"] },
  };

  function toggleOptional(optKey) {
    setConfig(function(c) {
      const os = Object.assign({}, c.optionalStages || {});
      os[optKey] = !os[optKey];
      if (!os[optKey]) {
        const ss = Object.assign({}, c.stageSettings || {});
        delete ss[optKey];
        delete ss[optKey + "_fix"];
        return Object.assign({}, c, { optionalStages: os, stageSettings: ss });
      }
      return Object.assign({}, c, { optionalStages: os });
    });
    setSelectedNode(null);
    setEditingNode(null);
  }

  function toggleSection(key) {
    setExpandedSections(function(p) {
      const n = Object.assign({}, p);
      n[key] = !n[key];
      return n;
    });
  }

  // ── SVG Flow Graph with loopback arcs ──
  const nodeW = 100, nodeH = 42, gapX = 18;
  const padX = 28;

  // Observer renders as a standalone block above the stage row,
  // connected to every stage with a dotted line. When enabled we reserve
  // extra top padding for the observer block + its dotted connectors.
  // The observer block itself is just a rounded rect with its label and
  // is clickable like any other workflow node — clicking it opens the
  // prompt editor (extraction + surfacing prompts).
  const observerEnabled = !!(config && config.observerEnabled);
  const observerH = 36;
  const observerStubGap = 28;           // vertical space between observer box and stage row
  const observerExtra = observerEnabled ? (observerH + observerStubGap + 12) : 0;
  const padY = 50 + observerExtra;
  const mainY = padY;
  const totalW = stages.length * (nodeW + gapX) - gapX + padX * 2;
  const loopbackSpace = 90;
  const totalH = mainY + nodeH + loopbackSpace + 10;

  // Observer block geometry — centered horizontally above the stage row.
  // Width is wider than a single stage so it visually reads as a
  // top-level coordinator rather than another inline step.
  const observerW = 160;
  const observerX = (totalW - observerW) / 2;
  const observerY = 12;

  // Build node position lookup
  const nodePos = {};
  stages.forEach(function(s, i) {
    nodePos[s.key] = { x: padX + i * (nodeW + gapX), y: mainY, idx: i };
  });

  // Filter loopbacks to only show those where both ends are in active stages
  const activeLoopbacks = LOOPBACK_EDGES.filter(function(e) {
    return nodePos[e.from] && nodePos[e.to];
  });

  return (
    <div>
      {/* Optional stage checkboxes — collapsible to save vertical space.
          Default-collapsed so the workflow editor below sits closer to
          the top. Summary shows N of M enabled at a glance. */}
      <OptionalStagesPanel enabled={enabled} toggleOptional={toggleOptional} />

      {/* Observer agent — optional agent that watches stage runs
          and builds an LLM-extracted knowledge base. Off by default;
          toggle here. Path is configurable so users can point at
          different KB files (team-shared vs personal). */}
      <ObserverConfigPanel config={config} setConfig={setConfig} />

      {/* Prompt-bundle Import/Export + recommended directory hint */}
      <div style={{
        marginBottom: 16, padding: "10px 12px",
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>
            Prompt Bundle (all stages)
          </div>
          <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.4 }}>
            Save or load a YAML file containing prompt sections for every stage. Per-stage Import/Export buttons live in each stage editor below.
            {config.settingsDir
              ? <span> Recommended location: <code style={{ background: TH.bg1, padding: "1px 5px", borderRadius: 2, color: TH.accent }}>{config.settingsDir}</code> (browser may save to its Downloads folder).</span>
              : <span> Set a working directory in <strong>Settings → Paths</strong> for a recommended save location.</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={exportAllStagesYaml}
            title="Download YAML containing every stage's prompt sections"
            style={{ padding: "5px 12px", borderRadius: 4, border: "1px solid " + TH.blue, background: TH.blueDim, color: TH.blue, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}
          >
            📤 Export All Stages
          </button>
          <button
            onClick={function() { if (bundleFileRef.current) bundleFileRef.current.click(); }}
            title="Import a multi-stage YAML bundle (overwrites stages present in the file; keeps others)"
            style={{ padding: "5px 12px", borderRadius: 4, border: "1px solid " + TH.blue, background: TH.blueDim, color: TH.blue, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}
          >
            📥 Import Bundle
          </button>
          <input
            ref={bundleFileRef}
            type="file"
            accept=".yaml,.yml,text/yaml,application/x-yaml"
            style={{ display: "none" }}
            onChange={function(e) {
              const f = e.target.files && e.target.files[0];
              _handleFileSelected(f, "bundle", null);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* Notice banner */}
      {yamlNotice && (
        <div style={{
          marginBottom: 12, padding: "8px 12px",
          background: yamlNotice.kind === "ok" ? TH.accentDim : TH.redDim,
          border: "1px solid " + (yamlNotice.kind === "ok" ? "rgba(0,255,180,.3)" : "rgba(248,113,113,.3)"),
          borderRadius: 4, fontSize: 11, color: yamlNotice.kind === "ok" ? TH.accent : TH.red,
        }}>
          {yamlNotice.kind === "ok" ? "✓ " : "⚠ "}{yamlNotice.text}
        </div>
      )}

      {/* Pending-import confirmation dialog */}
      {pendingImport && (
        <div style={{
          marginBottom: 12, padding: 12,
          background: TH.bg0, border: "1px solid " + TH.accent, borderRadius: 6,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: TH.accent, marginBottom: 6 }}>
            Confirm import: {pendingImport.sourceFile}
          </div>
          <div style={{ fontSize: 10, color: TH.text1, lineHeight: 1.5, marginBottom: 8 }}>
            {pendingImport.parsed.kind === "single" ? (
              <span>
                Replace <strong>{pendingImport.parsed.stageKey}</strong>'s prompt sections with{" "}
                {pendingImport.parsed.sections.length} section(s) from this file. Existing overrides for this stage will be lost.
              </span>
            ) : (
              <span>
                Apply bundle: {Object.keys(pendingImport.parsed.stages).length} stage(s) — {Object.keys(pendingImport.parsed.stages).join(", ")}.
                Existing overrides for these stages will be replaced; other stages keep their current overrides.
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={applyPendingImport} style={{ padding: "4px 12px", borderRadius: 3, border: "1px solid " + TH.accent, background: TH.accent, color: TH.bg0, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}>
              Apply
            </button>
            <button onClick={cancelPendingImport} style={{ padding: "4px 12px", borderRadius: 3, border: "1px solid " + TH.border, background: TH.bg1, color: TH.text1, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Flow graph */}
      <div style={{ marginBottom: 16, overflowX: "auto", padding: "4px 0" }}>
        <svg width={totalW} height={totalH} viewBox={"0 0 " + totalW + " " + totalH} style={{ display: "block" }}>
          <defs>
            <marker id="wf-arrow"        markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0, 7 2.5, 0 5" fill={TH.text3} /></marker>
            <marker id="wf-arrow-red"    markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0, 7 2.5, 0 5" fill={TH.red} /></marker>
            <marker id="wf-arrow-orange" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0, 7 2.5, 0 5" fill={TH.orange} /></marker>
            <marker id="wf-arrow-yellow" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0, 7 2.5, 0 5" fill={TH.yellow} /></marker>
          </defs>

          {/* Observer agent — standalone block at the top, dotted
              lines to every stage. Only rendered when observer is
              enabled in workflow settings. The block itself is
              clickable, opening the prompt editor for extraction +
              surfacing prompts. */}
          {observerEnabled && (function() {
            const observerCx = observerX + observerW / 2;
            const observerBottomY = observerY + observerH;
            const isObserverSelected = selectedNode === "_observer";
            const isObserverEditing  = editingNode === "_observer";
            return (
              <g>
                {/* Dotted connectors from observer to each stage's top */}
                {stages.map(function(s, i) {
                  const stageCx = padX + i * (nodeW + gapX) + nodeW / 2;
                  const stageTopY = mainY;
                  return (
                    <line
                      key={"obs-conn-" + s.key}
                      x1={observerCx} y1={observerBottomY}
                      x2={stageCx}    y2={stageTopY}
                      stroke={TH.blue}
                      strokeWidth={1}
                      strokeDasharray="3,3"
                      opacity={0.45}
                    />
                  );
                })}
                {/* Observer block itself */}
                <rect
                  x={observerX} y={observerY}
                  width={observerW} height={observerH}
                  rx={6} ry={6}
                  fill={isObserverSelected || isObserverEditing ? TH.blueDim : TH.bg1}
                  stroke={TH.blue}
                  strokeWidth={isObserverEditing ? 2 : 1.5}
                  strokeDasharray={isObserverEditing ? "0" : "4,3"}
                  style={{ cursor: "pointer" }}
                  onClick={function(e) { e.stopPropagation(); setSelectedNode("_observer"); }}
                  onDoubleClick={function(e) { e.stopPropagation(); setEditingNode("_observer"); }}
                />
                <text
                  x={observerCx} y={observerY + 15}
                  textAnchor="middle"
                  fill={TH.blue}
                  fontSize={10}
                  fontWeight={700}
                  fontFamily={TH.font}
                  style={{ pointerEvents: "none" }}
                >
                  Observer Agent
                </text>
                <text
                  x={observerCx} y={observerY + 27}
                  textAnchor="middle"
                  fill={TH.text3}
                  fontSize={7.5}
                  fontFamily={TH.font}
                  style={{ pointerEvents: "none" }}
                >
                  knowledge / drift / cost
                </text>
              </g>
            );
          })()}

          {/* Forward edges */}
          {stages.map(function(s, i) {
            if (i === 0) return null;
            const x1 = padX + (i - 1) * (nodeW + gapX) + nodeW;
            const x2 = padX + i * (nodeW + gapX);
            const cy = mainY + nodeH / 2;
            return (
              <line
                key={"fwd" + i}
                x1={x1} y1={cy} x2={x2} y2={cy}
                stroke={TH.border} strokeWidth={1.5}
                markerEnd="url(#wf-arrow)"
              />
            );
          })}

          {/* Loopback arcs (curved paths below the nodes) */}
          {activeLoopbacks.map(function(lb, li) {
            const fromPos = nodePos[lb.from];
            const toPos = nodePos[lb.to];
            if (!fromPos || !toPos) return null;
            // Arc goes from bottom of source node to bottom of target node
            const fromX = fromPos.x + nodeW / 2;
            const toX = toPos.x + nodeW / 2;
            const fromY = mainY + nodeH;
            const toY = mainY + nodeH;
            // Stagger arcs vertically so they don't overlap
            const span = Math.abs(fromPos.idx - toPos.idx);
            const tier = li % 3; // up to 3 tiers
            const arcDrop = 20 + tier * 22 + span * 4;
            const midX = (fromX + toX) / 2;
            const midY = fromY + arcDrop;
            // Quadratic bezier path
            const path = "M " + fromX + " " + fromY + " Q " + fromX + " " + midY + " " + midX + " " + midY + " Q " + toX + " " + midY + " " + toX + " " + toY;
            const markerColor = lb.color === TH.red    ? "url(#wf-arrow-red)"
                              : lb.color === TH.yellow ? "url(#wf-arrow-yellow)"
                              :                          "url(#wf-arrow-orange)";
            return (
              <g key={"lb" + li}>
                <path d={path} fill="none" stroke={lb.color} strokeWidth={1.2} strokeDasharray="5 3" markerEnd={markerColor} opacity={0.7} />
                <text x={midX} y={midY + 11} textAnchor="middle" fill={lb.color} fontSize={7} fontFamily={TH.font} opacity={0.85}>
                  {lb.label}
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {stages.map(function(s, i) {
            const x = padX + i * (nodeW + gapX);
            const y = mainY;
            const isSelected = selectedNode === s.key || editingNode === s.key;
            const isOptional = !!s.optional;
            const borderColor = isSelected ? TH.accent : (isOptional ? "rgba(0,255,180,.4)" : TH.border);
            const fillColor = isSelected ? "rgba(0,255,180,.08)" : TH.bg1;
            // Check if any loopback touches this node
            const hasLoopback = activeLoopbacks.some(function(lb) {
              return lb.from === s.key || lb.to === s.key;
            });
            return (
              <g
                key={s.id}
                onClick={function(e) { e.stopPropagation(); setSelectedNode(s.key); setEditingNode(null); setExpandedSections({}); }}
                onDoubleClick={function(e) { e.stopPropagation(); setEditingNode(s.key); setSelectedNode(null); setExpandedSections({}); }}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={x} y={y} width={nodeW} height={nodeH} rx={6} ry={6}
                  fill={fillColor} stroke={borderColor}
                  strokeWidth={isSelected ? 2.5 : 1.2}
                  strokeDasharray={isOptional ? "4 2" : "none"}
                />
                {hasLoopback && <circle cx={x + nodeW - 6} cy={y + 6} r={3} fill={TH.orange} opacity={0.6} />}
                <text x={x + nodeW / 2} y={y + 16} textAnchor="middle" fill={isSelected ? TH.accent : TH.text0} fontSize={9.5} fontWeight={700} fontFamily={TH.font}>
                  {s.label}
                </text>
                <text x={x + nodeW / 2} y={y + 28} textAnchor="middle" fill={TH.text3} fontSize={7.5} fontFamily={TH.font}>
                  {isOptional ? "optional" : "stage " + s.id}
                </text>
                {hasOverride(s.key) && (
                  <text x={x + nodeW / 2} y={y + 37} textAnchor="middle" fill={TH.orange} fontSize={7} fontFamily={TH.font}>
                    customised
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: TH.text3 }}>─── forward flow</span>
          <span style={{ fontSize: 9, color: TH.orange }}>╌╌╌ fix loop-back</span>
          <span style={{ fontSize: 9, color: TH.red }}>╌╌╌ triage loop-back</span>
          {observerEnabled && (
            <span style={{ fontSize: 9, color: TH.blue }}>┄┄┄ observer signal</span>
          )}
          <span style={{ fontSize: 9, color: TH.text3 }}>● has loop-back</span>
          <span style={{ fontSize: 9, color: TH.text3 }}>Click = view · Double-click = edit</span>
        </div>
      </div>

      {/* ── Node detail panel ── */}
      {(selectedNode || editingNode) && (function() {
        const nodeKey = editingNode || selectedNode;
        const isEditing = !!editingNode;
        const stageName = STAGE_NAMES[nodeKey] || nodeKey;
        const sections = getPromptSections(nodeKey);
        const io = IO[nodeKey] || { inp: [], out: [], del: [] };

        // Find connected stages
        const stgMeta = ALL_STAGES.find(function(s) { return s.key === nodeKey; });
        const stgIdx = stages.findIndex(function(s) { return s.key === nodeKey; });
        const prevStg = stgIdx > 0 ? stages[stgIdx - 1] : null;
        const nextStg = stgIdx >= 0 && stgIdx < stages.length - 1 ? stages[stgIdx + 1] : null;
        const loopbacksFrom = activeLoopbacks.filter(function(lb) { return lb.from === nodeKey; });
        const loopbacksTo = activeLoopbacks.filter(function(lb) { return lb.to === nodeKey; });

        // Section editing handlers
        function updateSectionTitle(idx, newTitle) {
          const s = sections.slice();
          s[idx] = Object.assign({}, s[idx], { title: newTitle });
          setPromptSections(nodeKey, s);
        }
        function updateSectionContent(idx, newContent) {
          const s = sections.slice();
          s[idx] = Object.assign({}, s[idx], { content: newContent });
          setPromptSections(nodeKey, s);
        }
        function removeSection(idx) {
          const s = sections.slice();
          s.splice(idx, 1);
          setPromptSections(nodeKey, s);
        }
        function addSection() {
          const s = sections.slice();
          s.push({ title: "New Section", content: "" });
          setPromptSections(nodeKey, s);
        }
        function moveSection(idx, dir) {
          const s = sections.slice();
          const target = idx + dir;
          if (target < 0 || target >= s.length) return;
          const tmp = s[idx];
          s[idx] = s[target];
          s[target] = tmp;
          setPromptSections(nodeKey, s);
        }

        return (
          <div style={{ background: TH.bg0, border: "1px solid " + (isEditing ? TH.accent : TH.border), borderRadius: 6, padding: 18, animation: "fadeIn .2s" }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: TH.fontD, fontSize: 16, fontWeight: 800, color: TH.text0 }}>{stageName}</span>
                <Tag color={isEditing ? TH.accent : TH.blue} bg={isEditing ? TH.accentDim : TH.blueDim}>
                  {isEditing ? "✏ Edit Mode" : "👁 View"}
                </Tag>
                {stgMeta && stgMeta.optional && <Tag color={TH.orange} bg={TH.orangeDim}>optional</Tag>}
                {hasOverride(nodeKey) && <Tag color={TH.orange} bg={TH.orangeDim}>customised</Tag>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {!isEditing && (
                  <button
                    onClick={function() { setEditingNode(nodeKey); setSelectedNode(null); }}
                    style={{ padding: "3px 10px", borderRadius: 3, border: "1px solid " + TH.border, background: TH.bg1, color: TH.text1, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: TH.font }}
                  >
                    ✏ Edit
                  </button>
                )}
                <button
                  onClick={function() { setSelectedNode(null); setEditingNode(null); setExpandedSections({}); }}
                  style={{ background: "none", border: "none", color: TH.text3, cursor: "pointer", fontSize: 16, padding: "0 4px" }}
                >
                  ×
                </button>
              </div>
            </div>

            {/* Prompt sections */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                <div style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Prompt Sections ({sections.length})
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    onClick={function() { exportStageYaml(nodeKey); }}
                    title={"Download this stage's prompt sections as a YAML file" + (config.settingsDir ? " (recommended location: " + config.settingsDir + ")" : "")}
                    style={{ padding: "2px 8px", borderRadius: 3, border: "1px solid " + TH.blue, background: TH.blueDim, color: TH.blue, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}
                  >
                    📤 Export YAML
                  </button>
                  {isEditing && (
                    <>
                      <button
                        onClick={function() { if (stageFileRef.current) stageFileRef.current.click(); }}
                        title="Import a YAML file to replace this stage's prompt sections"
                        style={{ padding: "2px 8px", borderRadius: 3, border: "1px solid " + TH.blue, background: TH.blueDim, color: TH.blue, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}
                      >
                        📥 Import YAML
                      </button>
                      <button onClick={addSection} style={{ padding: "2px 8px", borderRadius: 3, border: "1px solid " + TH.accent, background: TH.accentDim, color: TH.accent, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}>
                        + Add Section
                      </button>
                      <button onClick={function() { restoreDefaults(nodeKey); setExpandedSections({}); }} style={{ padding: "2px 8px", borderRadius: 3, border: "1px solid " + TH.orange, background: TH.orangeDim, color: TH.orange, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}>
                        ↺ Restore Defaults
                      </button>
                    </>
                  )}
                </div>
              </div>
              {/* Hidden file input — opened by the Import YAML button. */}
              <input
                ref={stageFileRef}
                type="file"
                accept=".yaml,.yml,text/yaml,application/x-yaml"
                style={{ display: "none" }}
                onChange={function(e) {
                  const f = e.target.files && e.target.files[0];
                  _handleFileSelected(f, "single", nodeKey);
                  e.target.value = "";   // allow re-import of same file
                }}
              />

              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {sections.map(function(sec, i) {
                  const secKey = nodeKey + "-" + i;
                  const isExp = !!expandedSections[secKey];
                  return (
                    <div key={secKey} style={{
                      background: TH.bg1, borderRadius: 4,
                      border: "1px solid " + (isExp ? (isEditing ? TH.accent : TH.border) : TH.border),
                      overflow: "hidden", transition: "border-color .15s",
                    }}>
                      {/* Section header — clickable to expand */}
                      <div
                        onClick={function() { toggleSection(secKey); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "pointer", userSelect: "none" }}
                      >
                        <span style={{
                          color: TH.text3, fontSize: 8, width: 14, textAlign: "center", flexShrink: 0,
                          transition: "transform .15s",
                          transform: isExp ? "rotate(90deg)" : "none",
                        }}>▶</span>
                        <span style={{ color: TH.text3, fontSize: 9, flexShrink: 0, width: 18 }}>{i + 1}.</span>
                        {isEditing && isExp ? (
                          <input
                            value={sec.title}
                            onChange={function(e) { updateSectionTitle(i, e.target.value); }}
                            onClick={function(e) { e.stopPropagation(); }}
                            style={{ flex: 1, background: TH.bg0, border: "1px solid " + TH.accent, borderRadius: 2, padding: "2px 6px", color: TH.text0, fontSize: 11, fontWeight: 600, fontFamily: TH.font, outline: "none" }}
                          />
                        ) : (
                          <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: isExp ? TH.text0 : TH.text1 }}>
                            {sec.title}
                          </span>
                        )}
                        {isEditing && (
                          <div style={{ display: "flex", gap: 2, flexShrink: 0 }} onClick={function(e) { e.stopPropagation(); }}>
                            {i > 0 && (
                              <button onClick={function() { moveSection(i, -1); }} style={{ background: "none", border: "none", color: TH.text3, cursor: "pointer", fontSize: 10, padding: "0 2px" }}>↑</button>
                            )}
                            {i < sections.length - 1 && (
                              <button onClick={function() { moveSection(i, 1); }} style={{ background: "none", border: "none", color: TH.text3, cursor: "pointer", fontSize: 10, padding: "0 2px" }}>↓</button>
                            )}
                            <button
                              onClick={function() {
                                if (typeof window !== "undefined" && window.confirm
                                    ? window.confirm("Remove section \"" + sec.title + "\"?")
                                    : true) {
                                  removeSection(i);
                                }
                              }}
                              style={{ background: "none", border: "none", color: TH.red, cursor: "pointer", fontSize: 10, padding: "0 2px" }}
                            >×</button>
                          </div>
                        )}
                      </div>
                      {/* Section content — shown when expanded */}
                      {isExp && (
                        <div style={{ borderTop: "1px solid " + TH.border, padding: "8px 10px 10px 10px" }}>
                          {isEditing ? (
                            <textarea
                              value={sec.content || ""}
                              onChange={function(e) { updateSectionContent(i, e.target.value); }}
                              style={{ width: "100%", minHeight: 100, background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 3, padding: 8, color: TH.text0, fontSize: 10.5, fontFamily: TH.font, resize: "vertical", outline: "none", lineHeight: 1.55 }}
                            />
                          ) : (
                            <pre style={{ margin: 0, fontSize: 10.5, color: TH.text1, fontFamily: TH.font, whiteSpace: "pre-wrap", lineHeight: 1.55, maxHeight: 300, overflow: "auto" }}>
                              {sec.content || "(empty)"}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {isEditing && (
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Btn variant="secondary" onClick={function() { setEditingNode(null); setSelectedNode(nodeKey); }} style={{ fontSize: 10 }}>
                    Done Editing
                  </Btn>
                </div>
              )}
            </div>

            {/* ── Connections panel ── */}
            <div style={{ borderTop: "1px solid " + TH.border, paddingTop: 14 }}>
              <div style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
                Connections
              </div>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12,
                marginBottom: loopbacksFrom.length + loopbacksTo.length > 0 ? 14 : 0,
              }}>
                <div>
                  <div style={{ fontSize: 9, color: TH.blue, fontWeight: 700, marginBottom: 4 }}>← Inputs</div>
                  {io.inp.map(function(inp, i) {
                    return <div key={i} style={{ fontSize: 10, color: TH.text1, marginBottom: 2 }}>• {inp}</div>;
                  })}
                  {prevStg && (
                    <div style={{ fontSize: 9, color: TH.text3, marginTop: 4 }}>
                      from: <span style={{ color: TH.text1 }}>{prevStg.label}</span>
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 9, color: TH.accent, fontWeight: 700, marginBottom: 4 }}>→ Outputs</div>
                  {io.out.map(function(out, i) {
                    return <div key={i} style={{ fontSize: 10, color: TH.text1, marginBottom: 2 }}>• {out}</div>;
                  })}
                  {nextStg && (
                    <div style={{ fontSize: 9, color: TH.text3, marginTop: 4 }}>
                      to: <span style={{ color: TH.text1 }}>{nextStg.label}</span>
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 9, color: TH.orange, fontWeight: 700, marginBottom: 4 }}>📦 Deliverables</div>
                  {io.del.length > 0
                    ? io.del.map(function(d, i) {
                        return <div key={i} style={{ fontSize: 10, color: TH.text1, marginBottom: 2 }}>• {d}</div>;
                      })
                    : <div style={{ fontSize: 10, color: TH.text3 }}>—</div>}
                </div>
              </div>

              {/* Loopback connections */}
              {(loopbacksFrom.length > 0 || loopbacksTo.length > 0) && (
                <div>
                  <div style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                    Loop-back Connections
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {loopbacksFrom.map(function(lb, i) {
                      return (
                        <div key={"from" + i} style={{
                          display: "flex", gap: 8, alignItems: "center",
                          padding: "5px 10px", background: TH.bg1, borderRadius: 3,
                          borderLeft: "3px solid " + lb.color,
                        }}>
                          <span style={{ fontSize: 10, color: lb.color, fontWeight: 700, flexShrink: 0 }}>
                            → {STAGE_NAMES[lb.to] || lb.to}
                          </span>
                          <span style={{ fontSize: 10, color: TH.text2 }}>{lb.label}</span>
                          <span style={{ fontSize: 9, color: TH.text3, marginLeft: "auto" }}>when: {lb.condition}</span>
                        </div>
                      );
                    })}
                    {loopbacksTo.map(function(lb, i) {
                      return (
                        <div key={"to" + i} style={{
                          display: "flex", gap: 8, alignItems: "center",
                          padding: "5px 10px", background: TH.bg1, borderRadius: 3,
                          borderLeft: "3px solid " + lb.color,
                        }}>
                          <span style={{ fontSize: 10, color: lb.color, fontWeight: 700, flexShrink: 0 }}>
                            ← {STAGE_NAMES[lb.from] || lb.from}
                          </span>
                          <span style={{ fontSize: 10, color: TH.text2 }}>{lb.label}</span>
                          <span style={{ fontSize: 9, color: TH.text3, marginLeft: "auto" }}>when: {lb.condition}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* Reflow & Loopbacks */}
      {/* group all workflow-shaping controls in one place.                  */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <div style={{
        marginTop: 18, padding: "12px 14px",
        background: TH.bg1, border: "1px solid " + TH.accent, borderRadius: 6,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: TH.accent, marginBottom: 10,
                       textTransform: "uppercase", letterSpacing: 1 }}>
          Reflow & Loopbacks
        </div>
        <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.5, marginBottom: 14 }}>
          When a stage detects a failure, it can re-run upstream stages as a K-to-X reflow chain
          (rather than a targeted inline fix). These controls shape that behavior: mode picks how
          aggressively the chain skips passing stages, and nested-iter limits cap recursion depth.
        </div>
            {/* Judge K-to-X reflow mode */}
            <div style={{
              marginBottom: 14, padding: "10px 14px",
              background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: TH.accent, marginBottom: 4 }}>
                Judge Reflow Mode
              </div>
              <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.4, marginBottom: 10 }}>
                When judge fails and picks a triage target, it re-runs the entire pipeline tail from that
                target through judge. "Smart" mode re-runs only stages affected by the triage decision;
                "Strict" mode re-runs every stage in the tail regardless of whether they previously passed.
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, cursor: "pointer" }}>
                <input
                  type="radio" name="judgeReflowMode"
                  checked={config.judgeReflowMode !== "strict"}
                  onChange={function() {
                    setConfig(function(c) { return Object.assign({}, c, { judgeReflowMode: "smart" }); });
                  }}
                  style={{ accentColor: TH.accent }}
                />
                <span style={{ fontSize: 11, color: TH.text1 }}>
                  <strong>Smart</strong> — re-run only stages affected by triage (faster)
                </span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="radio" name="judgeReflowMode"
                  checked={config.judgeReflowMode === "strict"}
                  onChange={function() {
                    setConfig(function(c) { return Object.assign({}, c, { judgeReflowMode: "strict" }); });
                  }}
                  style={{ accentColor: TH.accent }}
                />
                <span style={{ fontSize: 11, color: TH.text1 }}>
                  <strong>Strict</strong> — re-run every downstream stage (most conservative)
                </span>
              </label>
            </div>

            {/* Per-stage reflow modes (lint/lint_test/rtl_review/test_review/verify) */}
            <div style={{
              marginBottom: 14, padding: "10px 14px",
              background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: TH.accent, marginBottom: 4 }}>
                Per-Stage Reflow Modes
              </div>
              <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.4, marginBottom: 10 }}>
                Each loopback-capable stage runs its OWN K-to-X reflow when its internal loop needs a
                regenerated artifact. "Smart" skips stages that previously passed; "Strict" re-runs every
                stage in the tail. Recursion is bounded by per-stage iter limits — there's no hard cap.
              </div>
              {[
                { key: "lintReflowMode",       label: "Lint",        tail: "rtl_generate → rtl_review → lint" },
                { key: "lintTestReflowMode",   label: "Lint Test",   tail: "test_generate → test_review → lint_test" },
                { key: "rtlReviewReflowMode",  label: "RTL Review",  tail: "rtl_generate → rtl_review" },
                { key: "testReviewReflowMode", label: "Test Review", tail: "test_generate → test_review" },
                { key: "verifyReflowMode",     label: "Verify",      tail: "rtl_generate → … → verify (broad)" },
              ].map(function(row) {
                return (
                  <div key={row.key} style={{
                    display: "grid", gridTemplateColumns: "100px 200px 1fr",
                    gap: 8, alignItems: "center", padding: "4px 0",
                    borderTop: "1px solid " + TH.border,
                  }}>
                    <span style={{ fontSize: 11, color: TH.text1, fontWeight: 600 }}>{row.label}</span>
                    <div style={{ display: "flex", gap: 12 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                          type="radio" name={row.key}
                          checked={config[row.key] !== "strict"}
                          onChange={function() {
                            setConfig(function(c) {
                              return Object.assign({}, c, { [row.key]: "smart" });
                            });
                          }}
                          style={{ accentColor: TH.accent }}
                        />
                        <span style={{ fontSize: 10, color: TH.text2 }}>Smart</span>
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                          type="radio" name={row.key}
                          checked={config[row.key] === "strict"}
                          onChange={function() {
                            setConfig(function(c) {
                              return Object.assign({}, c, { [row.key]: "strict" });
                            });
                          }}
                          style={{ accentColor: TH.accent }}
                        />
                        <span style={{ fontSize: 10, color: TH.text2 }}>Strict</span>
                      </label>
                    </div>
                    <span style={{ fontSize: 9, color: TH.text3, fontFamily: TH.fontMono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.tail}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Nested loop iteration limits */}
            <div style={{
              marginBottom: 14, padding: "10px 14px",
              background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: TH.accent, marginBottom: 4 }}>
                Nested Iteration Limits (Override)
              </div>
              <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.4, marginBottom: 10 }}>
                When a higher-level reflow re-enters lint or verify, those stages reset their iteration
                counters at every nesting depth. Leave blank to use the base limits (Nested Lint Iters falls
                through to <code style={{ fontFamily: TH.fontMono }}>maxLintIters</code>; Nested Verify Iters
                falls through to <code style={{ fontFamily: TH.fontMono }}>maxVerifyIters</code>). Set a smaller
                value here to cap nested re-entries (e.g. avoid runaway lint loops inside judge).
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <Label>Nested Lint Iters</Label>
                  <input
                    type="number" min="0" max="20"
                    value={config.nestedLintIters == null ? "" : config.nestedLintIters}
                    placeholder="(use base limit)"
                    onChange={function(e) {
                      const v = e.target.value;
                      setConfig(function(c) {
                        return Object.assign({}, c, {
                          nestedLintIters: v === "" ? null : Math.max(0, parseInt(v, 10) || 0),
                        });
                      });
                    }}
                    style={{
                      width: "100%", padding: "4px 8px", fontSize: 11,
                      background: TH.bg1, border: "1px solid " + TH.border,
                      color: TH.text0, borderRadius: 3, fontFamily: TH.fontMono,
                    }}
                  />
                </div>
                <div>
                  <Label>Nested Verify Iters</Label>
                  <input
                    type="number" min="0" max="20"
                    value={config.nestedVerifyIters == null ? "" : config.nestedVerifyIters}
                    placeholder="(use base limit)"
                    onChange={function(e) {
                      const v = e.target.value;
                      setConfig(function(c) {
                        return Object.assign({}, c, {
                          nestedVerifyIters: v === "" ? null : Math.max(0, parseInt(v, 10) || 0),
                        });
                      });
                    }}
                    style={{
                      width: "100%", padding: "4px 8px", fontSize: 11,
                      background: TH.bg1, border: "1px solid " + TH.border,
                      color: TH.text0, borderRadius: 3, fontFamily: TH.fontMono,
                    }}
                  />
                </div>
              </div>
            </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OptionalStagesPanel — collapsible list of optional pipeline stages
//
// Pre-fix: optional stages were rendered as a wide flex row of pill cards
// (~10 entries × ~180px each), pushing the workflow editor below the fold
// on most viewports. The cards themselves were fine; the unconditional
// always-expanded layout was the problem.
//
// Now: collapsed by default, summary header shows "N of M enabled". Click
// to expand. Once expanded the original card grid layout is preserved
// (no change to the per-card design). Each card is still a click-target
// for toggle; the panel header is a separate click-target for collapse.
//
// Keeps the same DOM order so the workflow diagram stays in its place
// when the panel collapses — only the optional-stage section grows or
// shrinks.
// ═══════════════════════════════════════════════════════════════════════════
function OptionalStagesPanel({ enabled, toggleOptional }) {
  const [expanded, setExpanded] = useState(false);
  const allKeys = Object.keys(OPTIONAL_STAGE_DEFS);
  const onCount = allKeys.filter(function(k) { return !!enabled[k]; }).length;
  const enabledLabels = allKeys
    .filter(function(k) { return !!enabled[k]; })
    .map(function(k) { return OPTIONAL_STAGE_DEFS[k].label; });

  return (
    <div style={{
      marginBottom: 16,
      background: TH.bg0,
      border: "1px solid " + TH.border,
      borderRadius: 6,
    }}>
      <button
        onClick={function() { setExpanded(function(v) { return !v; }); }}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          padding: "10px 12px", display: "flex", alignItems: "center", gap: 10,
          textAlign: "left", color: TH.text0, fontFamily: TH.font,
        }}
      >
        <span style={{ color: TH.text2, fontSize: 11, width: 12 }}>
          {expanded ? "▼" : "▶"}
        </span>
        <span style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
          Optional Pipeline Stages
        </span>
        <span style={{ flex: 1, fontSize: 11, color: TH.text2 }}>
          {onCount} of {allKeys.length} enabled
          {onCount > 0 && !expanded && (
            <span style={{ marginLeft: 8, color: TH.accent }}>
              · {enabledLabels.slice(0, 3).join(", ")}{enabledLabels.length > 3 ? " +" + (enabledLabels.length - 3) : ""}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 12px 12px", display: "flex", gap: 10, flexWrap: "wrap" }}>
          {allKeys.map(function(optKey) {
            const def = OPTIONAL_STAGE_DEFS[optKey];
            const isOn = !!enabled[optKey];
            return (
              <label key={optKey} style={{
                display: "flex", gap: 8, alignItems: "center",
                padding: "6px 10px",
                background: isOn ? TH.accentDim : "transparent",
                border: "1px solid " + (isOn ? "rgba(0,255,180,.35)" : TH.border),
                borderRadius: 5, cursor: "pointer", transition: "all .15s",
                flexBasis: "calc(50% - 5px)",   // 2 per row on most viewports
                minWidth: 220,
              }}>
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={function() { toggleOptional(optKey); }}
                  style={{ accentColor: TH.accent, flexShrink: 0 }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: isOn ? TH.accent : TH.text1 }}>
                    {def.label}
                  </div>
                  <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.35 }}>
                    {def.desc}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ObserverConfigPanel — toggle + path picker for the observer agent
//
// User-facing surface for the observer subsystem. Two settings:
//   config.observerEnabled  (bool, default false) — whether the agent runs
//   config.observerPath     (string)              — DB path; default
//                                                    ~/.rtlforge/observer.db
//
// Switching paths effectively "switches knowledge bases" — the observer
// will write to the new file on next observation. This is the
// team-shared-DB scenario the user requested.
//
// CONTINUOUS-DEVELOPMENT NOTE: the panel itself is dumb — it just
// edits two config fields. All behavior lives in src/observer/*.
// ═══════════════════════════════════════════════════════════════════════════
function ObserverConfigPanel({ config, setConfig }) {
  const enabled = !!(config && config.observerEnabled);
  const path    = (config && config.observerPath) || "~/.rtlforge/observer.db";
  function toggle() {
    setConfig(function(c) {
      return Object.assign({}, c, { observerEnabled: !enabled });
    });
  }
  function updatePath(p) {
    setConfig(function(c) {
      return Object.assign({}, c, { observerPath: p });
    });
  }
  return (
    <div style={{
      marginBottom: 16,
      background: TH.bg0,
      border: "1px solid " + TH.border,
      borderRadius: 6,
      padding: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: enabled ? 10 : 0 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", flex: 1 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={toggle}
            style={{ accentColor: TH.accent }}
          />
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: enabled ? TH.accent : TH.text1 }}>
              Observer Agent (optional)
            </div>
            <div style={{ fontSize: 10, color: TH.text2, lineHeight: 1.4 }}>
              Builds a knowledge base of recurring errors, helpful fixes, and skill effectiveness — one LLM call per stage. Local-only, never leaves your machine.
            </div>
          </div>
        </label>
      </div>
      {enabled && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 26 }}>
          <label style={{ fontSize: 11, color: TH.text2, minWidth: 70 }}>KB path:</label>
          <input
            type="text"
            value={path}
            onChange={function(e) { updatePath(e.target.value); }}
            placeholder="~/.rtlforge/observer.db"
            style={{
              flex: 1, minWidth: 240,
              background: TH.bg1, border: "1px solid " + TH.border, color: TH.text0,
              fontSize: 11, padding: "4px 8px", borderRadius: 4,
              fontFamily: TH.fontMono || TH.font,
            }}
          />
          <span style={{ fontSize: 10, color: TH.text2 }}>
            Change to switch knowledge bases (team vs personal).
          </span>
        </div>
      )}
    </div>
  );
}
