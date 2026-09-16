// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { djb2 } from "../utils/hash.js";
import { nonNormativeContext } from "../utils/interfaceContract.js";
import { traceTimingAudit, traceTimingPrompt, sourceClockPorts } from "./traceTiming.js";
import { assessDesignContract } from "./designContract.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const VERSION = "source-examples-v4";
const units = { ps: 1, ns: 1000, us: 1000000 };
const cells = (line) => line.trim().replace(/^\|\s*|\s*\|$/g, "")
  .split(line.includes("|") ? /\s*\|\s*/ : /\s+/).map(s => s.replace(/^`|`$/g, ""));

// A literal quote in explicitly defective code cannot establish intended
// functionality. This is a conservative provenance check, not an NLP proof
// that a requirement follows from an otherwise normative sentence.
export function unsupportedBehaviorCitations(source, spec) {
  const text = String(source || "");
  return ((spec && spec.requirements) || []).flatMap(req => {
    if (!req || /^REQ-INTF-|^Interface$/i.test(req.id || "") || req.cat === "Interface") return [];
    const quote = String(req.src || "").trim();
    const behavioral = /FUNC|TIME|BEHAV|ERR/i.test(req.id || "") || /functional|timing|behavior|error/i.test(req.cat || "");
    const assumed = behavioral && /default|question skipped|assum/i.test(String(req.rat || ""));
    if (!quote) {
      return assumed
        ? [{ id: req.id, reason: "Behavioral default is an assumption, not a source-supported requirement", quote: "" }]
        : [];
    }
    const pattern = quote.split(/\s+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const matches = [...text.matchAll(new RegExp(pattern, "g"))];
    // A model-generated assumption cannot become source evidence by copying
    // its own wording into src. Genuine quotations still need semantic
    // review; containment alone does not prove that the source entails it.
    if (!matches.length && assumed) return [{ id: req.id,
      reason: "Behavioral default cites text absent from the original source", quote }];
    if (!matches.length || !matches.every(m => nonNormativeContext(text, m.index, { defectsOnly: true }))) return [];
    return [{ id: req.id, reason: "Behavior is supported only by a quotation from non-normative/defective code", quote }];
  });
}

function portWidth(port) {
  const s = String(port.width || "1").trim();
  const range = /^\[\s*(\d+)\s*:\s*(\d+)\s*\]$/.exec(s);
  const n = range ? Math.abs(+range[1] - +range[2]) + 1 : /^\d+$/.test(s) ? +s : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > 256) throw new Error("unresolved port width: " + port.name);
  return n;
}

function literal(raw, width, output, columnRadix) {
  const s = raw.replace(/_/g, "").toLowerCase();
  const full = (1n << BigInt(width)) - 1n;
  if (/^[x?]+$/.test(s) && output) return { value: 0n, mask: 0n };
  let digits, radix, declared;
  const sv = /^(\d+)'([bhd])([0-9a-fx?]+)$/.exec(s);
  if (sv) { declared = +sv[1]; radix = { b: 2, h: 16, d: 10 }[sv[2]]; digits = sv[3]; }
  else if (/^0x[0-9a-f]+$/.test(s)) { radix = 16; digits = s.slice(2); }
  else if (/^0b[01]+$/.test(s)) { radix = 2; digits = s.slice(2); }
  else if (columnRadix && /^[0-9a-fx?]+$/.test(s)) { radix = columnRadix; digits = s; }
  else if (/^[01]$/.test(s)) { radix = 2; digits = s; }
  else throw new Error("ambiguous or unsupported literal " + raw + "; use explicit sized binary/hex/decimal");
  if (declared != null && declared !== width) throw new Error("literal width differs from port width: " + raw);
  if (radix === 10) {
    if (!/^\d+$/.test(digits)) throw new Error("unsupported decimal literal " + raw);
    const value = BigInt(digits);
    if (value > full) throw new Error("literal overflows port: " + raw);
    return { value, mask: full };
  }
  const bits = radix === 16 ? 4 : 1;
  let value = 0n, mask = 0n;
  for (const digit of digits) {
    value <<= BigInt(bits); mask = (mask << BigInt(bits)) | BigInt(radix - 1);
    if (/[x?]/.test(digit)) {
      if (!output) throw new Error("unknown input cannot be replayed portably: " + raw);
      mask &= ~BigInt(radix - 1);
    } else {
      const n = parseInt(digit, radix);
      if (!Number.isFinite(n) || n >= radix) throw new Error("invalid digit in " + raw);
      value |= BigInt(n);
    }
  }
  if (value > full) {
    throw new Error("literal overflows port: " + raw);
  }
  // SV extends a leading x/? with don't-cares; otherwise zero-extend.
  if (!/[x?]/.test(digits[0])) mask |= full & ~((1n << BigInt(digits.length * bits)) - 1n);
  return { value, mask: mask & full };
}

function timePs(raw) {
  const m = /^(\d+(?:\.\d+)?)(ps|ns|us)$/.exec(raw);
  const n = m ? Number(m[1]) * units[m[2]] : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000) throw new Error("time needs explicit ps/ns/us within 1 ms: " + raw);
  return n;
}

// Only rectangular, port-labelled tables are executable. Unsupported cells,
// omitted inputs, parameter expressions and simultaneous edge/data changes
// remain visible as unresolved evidence; never guess a radix or sampling phase.
export function buildSourceContract(source, spec, moduleName, elicit) {
  const text = String(source || "");
  const ports = (spec && spec.iface || []).filter(Boolean);
  const byName = new Map(ports.map(p => [p.name, p]));
  const lines = text.split(/\r?\n/);
  // Only explicit declarations in the original source may normalize labels or
  // bare numerals. Generated spec defaults cannot supply these conventions.
  const aliases = new Map(), radices = new Map(), conventions = [], conventionIssues = [];
  lines.forEach((line, index) => {
    const alias = /^\s*Signal alias:\s*([A-Za-z_][\w$]*)\s*=\s*([A-Za-z_][\w$]*)\.\s*$/.exec(line);
    const radix = /^\s*Column ([A-Za-z_][\w$]*) is (hexadecimal|decimal|binary)\.\s*$/i.exec(line);
    if (!alias && !radix || nonNormativeContext(text, lines.slice(0, index).join("\n").length, { defectsOnly: true })) return;
    conventions.push({ line: index + 1, quote: line });
    if (alias) {
      if (!byName.has(alias[2]) || byName.has(alias[1]) && alias[1] !== alias[2]
          || aliases.has(alias[1]) && aliases.get(alias[1]) !== alias[2])
        conventionIssues.push({ id: "SOURCE.CONVENTION", line: index + 1, reason: "conflicting or unknown signal alias" });
      else aliases.set(alias[1], alias[2]);
    }
    if (radix) {
      const base = { hexadecimal: 16, decimal: 10, binary: 2 }[radix[2].toLowerCase()];
      if (radices.has(radix[1]) && radices.get(radix[1]) !== base)
        conventionIssues.push({ id: "SOURCE.CONVENTION", line: index + 1, reason: "conflicting column radix" });
      else radices.set(radix[1], base);
    }
  });
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const rawHeader = cells(lines[i]);
    const header = rawHeader.map(h => aliases.get(h) || h);
    if (header.length < 2 || !header.some(h => byName.has(h))) continue;
    if (!header.every(h => IDENT.test(h)) || !header.some(h => byName.get(h)?.dir === "output")) continue;
    let j = i + 1;
    if (/^\s*\|?\s*:?-+:?\s*(?:\||\s)/.test(lines[j] || "")) j++;
    const rows = [];
    let malformedLine = null;
    for (; j < lines.length && rows.length < 257; j++) {
      if (!lines[j].trim() || /^\s*```/.test(lines[j])) break;
      const row = cells(lines[j]);
      if (row.length !== header.length) {
        if (/^\s*\|?\s*[0-9x?]/i.test(lines[j])) malformedLine = j + 1;
        break;
      }
      rows.push({ line: j + 1, cells: row });
    }
    if (!rows.length && !malformedLine) continue;
    tables.push({ id: "SOURCE.T" + (tables.length + 1), line: i + 1, header, rawHeader, rows, malformedLine,
      raw: lines.slice(i, j + (malformedLine ? 1 : 0)).join("\n") });
    i = j - 1;
  }
  const design = assessDesignContract(text, spec, elicit);
  const issues = (design ? design.issues : unsupportedBehaviorCitations(text, spec)).concat(conventionIssues);
  const timingAudit = traceTimingAudit(text, tables, ports);
  const suites = [];
  for (const table of tables) {
    try {
      if (table.malformedLine) throw new Error("row at line " + table.malformedLine + " does not match the labelled columns");
      if (table.rows.length > 256) throw new Error("table exceeds 256-row replay limit");
      if (!IDENT.test(moduleName || "")) throw new Error("module name is unresolved");
      if (ports.some(p => !IDENT.test(p.name || "") || !/^(input|output)$/.test(p.dir))) throw new Error("unsupported interface");
      if (new Set(table.header).size !== table.header.length) throw new Error("duplicate column labels");
      const timed = table.header.includes("time");
      if (table.header.some(h => !byName.has(h) && h !== "time")) throw new Error("unknown signal column");
      const inputs = ports.filter(p => p.dir === "input");
      if (inputs.some(p => !table.header.includes(p.name))) throw new Error("table omits an input; no stimulus default is assumed");
      const widths = new Map(ports.map(p => [p.name, portWidth(p)]));
      const clocks = sourceClockPorts(text, ports);
      if (!timed && clocks.length) throw new Error("clocked table requires an explicit time column");
      if (timed && !clocks.length) throw new Error("timed replay requires an identifiable clock");
      if (clocks.length > 1) throw new Error("multiple clocks require an explicit event schedule");
      const clock = clocks[0]?.name;
      const activeEdge = timingAudit.find(t => t.table === table.id)?.edge;
      // This explicit source convention applies uniformly to the whole trace.
      const before = /^\s*Inputs (?:are )?driven before (?:the )?clock edge\.\s*$/im.test(text);
      const after = /^\s*Inputs (?:are )?(?:driven|changed) after (?:the )?clock edge\.\s*$/im.test(text);
      if (before && after) throw new Error("conflicting source sampling conventions");
      const parsed = table.rows.map(row => ({ ...row, time: timed ? timePs(row.cells[table.header.indexOf("time")]) : null,
        values: Object.fromEntries(table.header.filter(h => h !== "time").map(h => [h,
          literal(row.cells[table.header.indexOf(h)], widths.get(h), byName.get(h).dir === "output", radices.get(table.rawHeader[table.header.indexOf(h)]) || radices.get(h))])),
      }));
      for (let i = 1; i < parsed.length; i++) {
        if (timed && parsed[i].time - parsed[i - 1].time < 4) throw new Error("trace times must increase by at least 4 ps");
        if (clock && parsed[i].values[clock].value !== parsed[i - 1].values[clock].value
            && (activeEdge !== "posedge" && activeEdge !== "negedge"
              || parsed[i].values[clock].value === (activeEdge === "posedge" ? 1n : 0n))
            && inputs.some(p => p.name !== clock && parsed[i].values[p.name].value !== parsed[i - 1].values[p.name].value)
            && !before && !after) throw new Error("simultaneous clock/data change has unresolved sampling phase");
      }
      const sv = ["`timescale 1ps/1ps", "module " + moduleName + "_tb;"];
      ports.forEach(p => sv.push("  logic [" + (widths.get(p.name) - 1) + ":0] " + p.name + ";"));
      sv.push("  " + moduleName + " dut(" + ports.map(p => "." + p.name + "(" + p.name + ")").join(", ") + ");", "  initial begin");
      const witness = sv.slice();
      const witnessModule = "module " + moduleName + "(" + ports.map(p =>
        p.dir + " logic [" + (widths.get(p.name) - 1) + ":0] " + p.name).join(", ") + ");\nlogic f_source_sample = 0;";
      const ids = [];
      const assign = (p, row) => "    " + p.name + " = " + widths.get(p.name) + "'h" + row.values[p.name].value.toString(16) + ";";
      parsed.forEach((row, i) => {
        const startLine = sv.length;
        const delay = timed ? i ? row.time - parsed[i - 1].time - 2 : row.time : i ? 8 : 0;
        if (delay) sv.push("    #" + delay + ";");
        const first = inputs.filter(p => after ? p.name === clock : p.name !== clock);
        const second = inputs.filter(p => !first.includes(p));
        first.forEach(p => sv.push(assign(p, row)));
        sv.push("    #1;");
        second.forEach(p => sv.push(assign(p, row)));
        sv.push("    #1;"); // post-NBA observation, no additional clock edge
        witness.push(...sv.slice(startLine));
        table.header.filter(h => byName.get(h)?.dir === "output").forEach(name => {
          const bits = Array.from({ length: widths.get(name) }, (_, bit) => {
            const shift = BigInt(widths.get(name) - bit - 1);
            return row.values[name].mask >> shift & 1n ? String(row.values[name].value >> shift & 1n) : "x";
          }).join("");
          witness.push("    dut." + name + " = " + widths.get(name) + "'b" + bits + ";");
          const { value, mask } = row.values[name];
          if (!mask) return; // source don't-care is not an X-value obligation
          const id = table.id + ".L" + row.line + "." + name;
          ids.push(id);
          const w = widths.get(name);
          sv.push("    if ((" + name + " & " + w + "'h" + mask.toString(16) + ") === " + w + "'h" + (value & mask).toString(16) + ")",
            '      $display("[PASS] ' + id + '");', '    else $display("[FAIL] ' + id + '");');
        });
        witness.push("    dut.f_source_sample = !dut.f_source_sample;");
      });
      if (!ids.length) throw new Error("table contains no defined output checks");
      sv.push("    $finish;", "  end", "endmodule");
      witness.push("    $finish;", "  end", "endmodule");
      suites.push({ id: table.id, code: sv.join("\n"), witnessModule, witnessTestbench: witness.join("\n"), ids, phase: after ? "clock-before-inputs" : before ? "inputs-before-clock" : "no-simultaneous-changes" });
    } catch (e) {
      issues.push({ id: table.id, line: table.line, reason: e.message });
    }
  }
  const sourceHash = djb2(text);
  const hash = djb2(JSON.stringify({ version: VERSION, sourceHash, ports, moduleName, suites, issues, timingAudit,
    ...(design ? { designHash: design.hash } : {}) }));
  return { version: VERSION, sourceHash, hash, tables, suites, conventions, issues, timingAudit,
    ...(design ? { designHash: design.hash, revision: design.revision, scope: design.scope,
      assumptions: design.assumptions, provenance: design.entries } : {}),
    status: issues.length ? "UNRESOLVED" : suites.length || design ? "READY" : "NONE" };
}

export function sourceContractPrompt(contract) {
  if (!contract || !contract.tables.length && !contract.issues.length) return "";
  return "\n\nIMMUTABLE SOURCE EXAMPLES AND PROVENANCE (" + contract.hash + ")\n"
    + contract.tables.map(t => t.id + " at source line " + t.line + ":\n" + t.raw).join("\n\n")
    + "\nSource conventions: " + JSON.stringify(contract.conventions || [])
    + "\nUnresolved: " + JSON.stringify(contract.issues)
    + traceTimingPrompt(contract.timingAudit)
    + "\nThese are original source rows, independent of generated prose and RTL. Preserve labels, don't-care masks and sampling phase. "
    + "Trace every defined row in RTL, checker and auxiliary formal models; do not insert idle cycles or output holds without source support. "
    + "Explicitly resolve ambiguities from source evidence; do not choose a meaning to match a candidate. Runtime acceptance checks cannot be changed by rewriting a generated testbench.";
}

export function mergeSourceEvidence(base, contract, runs, rtl) {
  if (contract.status === "NONE") return base;
  const evidence = { version: contract.version, hash: contract.hash, sourceHash: contract.sourceHash,
    issues: contract.issues, checkedIds: [], status: contract.status, rtlHash: djb2(String(rtl || "")),
    ...(contract.designHash ? { designHash: contract.designHash, revision: contract.revision,
      scope: contract.scope, assumptions: contract.assumptions } : {}) };
  let invalid = contract.status === "UNRESOLVED" || base.cli !== true;
  const tests = (base.tests || []).slice();
  if (tests.some(t => String(t.name || "").startsWith("SOURCE."))) invalid = true;
  for (let i = 0; i < contract.suites.length; i++) {
    const suite = contract.suites[i], run = runs[i];
    const checks = run?.tests || [];
    const ids = checks.map(t => t.name);
    if (!run || run.cli !== true || !/^(PASS|FAIL|MEASURED)$/.test(run.status)
        || ids.length !== suite.ids.length || new Set(ids).size !== ids.length
        || suite.ids.some(id => !ids.includes(id)) || checks.some(t => !/^(PASS|FAIL)$/.test(t.st))) invalid = true;
    else { tests.push(...checks); evidence.checkedIds.push(...ids); }
  }
  const fail = tests.filter(t => t.st !== "PASS").length;
  evidence.status = invalid ? "UNVERIFIED" : tests.some(t => t.name.startsWith("SOURCE.") && t.st === "FAIL") ? "FAIL" : "PASS";
  return { ...base, tests, total: tests.length, pass: tests.length - fail, fail,
    status: invalid ? "UNVERIFIED" : evidence.status === "FAIL" ? "FAIL" : base.status,
    _checkerEvidenceInvalid: base._checkerEvidenceInvalid || invalid,
    _sourceEvidence: evidence,
    log: (base.log || "") + "\nSource acceptance: " + JSON.stringify(evidence) + "\n" + runs.map(r => r?.log || "").join("\n"),
  };
}
