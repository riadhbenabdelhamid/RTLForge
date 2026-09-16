// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { repairProposals } from "./syntaxRepair.js";
import { stripEmbeddedTbModules } from "./fixLoopHelpers.js";
import { runCli } from "../cli/index.js";
import { withSharedPackage, childRtlFiles, cmdWithFiles } from "./cliFiles.js";

const VERSION = 1;
export function repairSession(st) {
  if (!st._syntaxRepairSession) {
    const disabled = new Set();
    // Carry quarantine across stage boundaries and checkpoint resumes. A fresh
    // pipeline with no artifacts starts clean; no process-global blacklist.
    for (const value of Object.values(st)) {
      const rules = value?._syntaxRepairSafety?.disabled;
      if (Array.isArray(rules)) for (const rule of rules) if (typeof rule === "string") disabled.add(rule);
    }
    st._syntaxRepairSession = { version: VERSION, disabled: [...disabled], audit: [] };
  }
  return st._syntaxRepairSession;
}

export function guardSyntaxRepairs(name, node) {
  return async st => {
    const session = repairSession(st), start = session.audit.length;
    const delta = await node(st);
    if (delta?.[name] && (session.audit.length > start || session.disabled.length)) {
      delta[name] = { ...delta[name], _syntaxRepairSafety: {
        version: VERSION, disabled: [...session.disabled], audit: session.audit.slice(start),
      } };
    }
    return { ...delta, _syntaxRepairSession: session };
  };
}

function compileRequest(st, code, kind, rtl) {
  const cfg = st._config || {};
  const mod = st.elicit?.modName || st._modName || "module";
  const rtlFile = mod + ".sv", tbFile = mod + "_tb.sv";
  const files = { ...childRtlFiles(st._childInterfaces), [rtlFile]: kind === "rtl" ? code : (rtl ?? st.rtl_generate?.code ?? "") };
  const sources = withSharedPackage(files, st._sharedPackageCode);
  if (kind !== "rtl") sources.files[tbFile] = code;
  const template = kind === "rtl"
    ? (cfg.lintCmd || "verilator --lint-only --timing -Wall -Wno-fatal --top-module " + mod + " {RTL}")
    : (cfg.tbLintCmd || "verilator --lint-only --timing -Wall -Wno-fatal --top-module " + mod + "_tb {RTL} {TB}");
  return { command: cmdWithFiles(template, sources.order, rtlFile).replace(/\{TB\}/g, tbFile), files: sources.files };
}

// A replayable patch against the preceding rule's output. Keep the original
// source once, rather than duplicating entire testbenches for every edit.
function editPatch({ rule, count, before, after }) {
  let start = 0, endBefore = before.length, endAfter = after.length;
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--; endAfter--;
  }
  return { rule, count, offset: start, removed: before.slice(start, endBefore), inserted: after.slice(start, endAfter) };
}

// Compare the raw model output with the transform's output under identical
// compilation settings. Comparing only with the previous incumbent hides damage
// introduced between model generation and candidate adoption.
export async function repairCandidate(st, raw, { kind = "tb", log, rtl } = {}) {
  const cfg = st._config || {};
  const unchanged = () => ({ code: raw, fixes: null, total: 0 });
  if (!cfg.syntaxRepair || typeof raw !== "string") return unchanged();
  const session = repairSession(st);
  const proposed = repairProposals(raw, { syntaxOnly: true, disabled: session.disabled });
  if (!proposed.edits.length && !proposed.deferred.length) return unchanged();
  const record = { kind, rawCode: raw,
    edits: proposed.edits.map(editPatch), deferred: proposed.deferred, outcome: "deferred", disabled: [] };
  const finish = (outcome, code = raw) => {
    record.outcome = outcome;
    session.audit.push(record);
    if (log) log("Deterministic repair: " + outcome,
      [...proposed.edits.map(e => e.rule), ...proposed.deferred.map(e => e.rule + " (deferred)")].join(", "));
    const fixes = code === raw ? null : proposed.edits.map(({ rule, count }) => ({ rule, count }));
    return { code, fixes, total: (fixes || []).reduce((n, f) => n + f.count, 0) };
  };
  if (!proposed.edits.length) return finish("behavioral changes deferred");
  if (!cfg.backendUrl) return finish("compiler unavailable; raw preserved");
  const compile = async code => {
    const request = compileRequest(st, code, kind, rtl);
    try {
      const result = await runCli(cfg.backendUrl, request, st._signal, {
        retries: cfg.cliRetryCount ?? 1,
        timeoutMs: (cfg.backendTimeoutSec || 600) * 1000, logger: st._logger || null,
      });
      if (st._signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      const known = result && !result._error && !result.aborted && Number.isInteger(result.exitCode);
      return { command: request.command, passed: known ? result.exitCode === 0 : null,
        exitCode: result?.exitCode ?? null, diagnostics: String(result?.stderr || result?._msg || result?.stdout || "").slice(0, 12000) };
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return { command: request.command, passed: null, diagnostics: String(e.message || e) };
    }
  };
  record.rawCompile = await compile(raw);
  record.proposedCompile = await compile(proposed.code);
  if (record.rawCompile.passed === true) {
    if (record.proposedCompile.passed === false) {
      // Locate the first failing prefix, attributing the compiler regression
      // to a rule, not to the LLM. Discard the entire transform transaction.
      for (let i = 0; i < proposed.edits.length; i++) {
        const evidence = i === proposed.edits.length - 1 ? record.proposedCompile : await compile(proposed.edits[i].after);
        if (evidence.passed !== true) {
          const rule = proposed.edits[i].rule;
          if (!session.disabled.includes(rule)) session.disabled.push(rule);
          record.disabled.push(rule);
          record.failure = { rule, evidence };
          break;
        }
      }
      return finish("transform regression; raw preserved; rule quarantined");
    }
    // Even compiling rewrites can change behavior. Legal raw input needs no
    // syntax repair, regardless of whether a regex matches it.
    return finish("raw compiles; preserved");
  }
  if (record.rawCompile.passed === false && record.proposedCompile.passed === true) {
    return finish("compiler accepted syntax repair", proposed.code);
  }
  return finish("repair unqualified; raw preserved");
}

export async function repairRtl(st, code, log) {
  if (typeof code === "string") {
    const stripped = stripEmbeddedTbModules(code);
    if (stripped.stripped.length && log) log("Stripped embedded testbench module(s)", stripped.stripped.join(", "));
    code = stripped.code;
  }
  return repairCandidate(st, code, { kind: "rtl", log });
}
