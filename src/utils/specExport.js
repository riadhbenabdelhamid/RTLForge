// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// specExport — write a module's specification back out
//
// The export bundle carried RTL, testbenches and a manifest but never the
// SPEC, so the contract every one of those artifacts was built against could
// not leave the tool. Now it does, in the same three formats specImport
// reads, so an exported spec can be edited and fed straight back in.
//
// Round-trip is the contract: importSpec(specToJson(s)) must equal s, and the
// same for YAML and Markdown. The tests pin all three.
// ═══════════════════════════════════════════════════════════════════════════

/** Fields that belong to the specification itself, not to stage bookkeeping. */
function pick(spec) {
  const s = spec || {};
  return {
    modName: String(s.modName || ""),
    domain:  String(s.domain || ""),
    requirements: Array.isArray(s.requirements) ? s.requirements : [],
    iface:        Array.isArray(s.iface) ? s.iface : [],
    params:       Array.isArray(s.params) ? s.params : [],
  };
}

/** Strip the underscore-prefixed meta the stage attaches (_llms, _log, …). */
function clean(o, keys) {
  const out = {};
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== "") out[k] = o[k];
  }
  return out;
}

const REQ_KEYS   = ["id", "cat", "pri", "desc", "rat"];
const IFACE_KEYS = ["name", "dir", "width", "desc", "reset"];
const PARAM_KEYS = ["name", "type", "def", "range", "desc"];

/** The exact shape specImport reads back. */
export function specToJson(spec) {
  const s = pick(spec);
  return JSON.stringify({
    modName: s.modName,
    domain: s.domain,
    requirements: s.requirements.map((r) => clean(r, REQ_KEYS)),
    iface:        s.iface.map((p) => clean(p, IFACE_KEYS)),
    params:       s.params.map((p) => clean(p, PARAM_KEYS)),
  }, null, 2) + "\n";
}

/** Quote only when a bare scalar would be ambiguous to the subset reader. */
function yamlScalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const str = String(v == null ? "" : v);
  if (str === "") return '""';
  // Anything that could read as a number, a boolean, or that carries a
  // structural character, is quoted so it survives the round trip as text.
  if (/^-?\d+(\.\d+)?$/.test(str) || /^(true|false|null|~)$/.test(str)
      || /[:#\[\]{}&*|>'"]/.test(str) || /^\s|\s$/.test(str)) {
    return '"' + str.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
  return str;
}

export function specToYaml(spec) {
  const s = pick(spec);
  const lines = [];
  lines.push("# " + (s.modName || "specification") + " — exported by RTL Forge");
  lines.push("modName: " + yamlScalar(s.modName));
  lines.push("domain: " + yamlScalar(s.domain));

  const block = function(key, rows, keys) {
    if (rows.length === 0) { lines.push(key + ": []"); return; }
    lines.push(key + ":");
    for (const row of rows) {
      const kept = keys.filter((k) => row && row[k] !== undefined && row[k] !== "");
      kept.forEach(function(k, i) {
        lines.push((i === 0 ? "  - " : "    ") + k + ": " + yamlScalar(row[k]));
      });
    }
  };
  block("requirements", s.requirements, REQ_KEYS);
  block("iface", s.iface, IFACE_KEYS);
  block("params", s.params, PARAM_KEYS);
  return lines.join("\n") + "\n";
}

/** A table cell must not break the row, so pipes and newlines are escaped. */
function mdCell(v) {
  return String(v == null ? "" : v).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function mdTable(headers, rows) {
  const out = ["| " + headers.join(" | ") + " |",
               "|" + headers.map(() => "---").join("|") + "|"];
  for (const r of rows) out.push("| " + r.map(mdCell).join(" | ") + " |");
  return out.join("\n");
}

export function specToMarkdown(spec) {
  const s = pick(spec);
  const out = ["# " + (s.modName || "specification")];
  if (s.domain) out.push("Domain: " + s.domain);
  out.push("");

  out.push("## Requirements");
  out.push(mdTable(["ID", "Cat", "Pri", "Description", "Rationale"],
    s.requirements.map((r) => [r.id, r.cat, r.pri, r.desc, r.rat])));
  out.push("");

  out.push("## Interface");
  out.push(mdTable(["Name", "Dir", "Width", "Reset", "Description"],
    s.iface.map((p) => [p.name, p.dir, p.width, p.reset, p.desc])));
  out.push("");

  out.push("## Parameters");
  out.push(mdTable(["Name", "Type", "Default", "Range", "Description"],
    s.params.map((p) => [p.name, p.type, p.def, p.range, p.desc])));
  out.push("");
  return out.join("\n");
}

/**
 * Every serialisation of one module's spec, keyed by the filename to write.
 *
 * @param {object} spec   the stage-2 data
 * @param {string} modId  used to name the files
 * @returns {object} { "<modId>.json": "…", "<modId>.yaml": "…", "<modId>.md": "…" }
 */
export function specFiles(spec, modId) {
  const base = String(modId || (spec && spec.modName) || "spec");
  return {
    [base + ".json"]: specToJson(spec),
    [base + ".yaml"]: specToYaml(spec),
    [base + ".md"]:   specToMarkdown(spec),
  };
}
