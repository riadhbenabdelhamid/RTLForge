// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// specImport — read an existing specification and fill the spec stage
//
// The pipeline normally ASKS a model for the formal spec. When the user
// already has one, this reads it instead: the spec stage extracts the same
// { modName, domain, requirements, iface, params } it would have generated,
// and the rest of the flow continues unchanged.
//
// Three formats, chosen by extension:
//   .json  the stage's exact shape — round-trips with specExport
//   .yaml  the same fields, in a STRICT SUBSET of YAML (see parseYamlSpec)
//   .md    a documented template: a heading, then requirement / interface /
//          parameter tables
//
// A failure here must NOT be repaired by guessing. The user wrote the file,
// so every problem is reported against it with a line number and the field
// at fault, and the caller halts. The one exception is a mismatch the
// pipeline already repairs deterministically — a requirement id whose prefix
// disagrees with its cat — which is reported as a WARNING, because the spec
// node's own alignment step fixes it and halting on a mechanically-repairable
// inconsistency would be stricter than the flow that follows.
// ═══════════════════════════════════════════════════════════════════════════

/** Requirement id prefix → category, the same mapping the spec node aligns to. */
const PREFIX_TO_CAT = {
  INTF:  "Interface",
  FUNC:  "Functionality",
  TIME:  "Timing",
  ERR:   "Error",
  VERIF: "Verification",
};

const VALID_DIRS = new Set(["input", "output", "inout"]);
const VALID_PRI  = new Set(["must", "should", "may"]);

/** An import problem, always carrying enough to find it in the user's file. */
function issue(severity, line, field, message) {
  return { severity, line: line || null, field: field || "", message };
}

/** Format from the filename, or null when the extension is not one we read. */
export function detectSpecFormat(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ""));
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "json") return "json";
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "md" || ext === "markdown") return "md";
  return null;
}

/** 1-based line number of a character offset. */
function lineOf(text, offset) {
  if (offset == null || offset < 0) return null;
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** First line whose text contains `needle`, or null. Used to place a schema
 *  problem in a JSON/YAML file without threading positions through a parse. */
function findLine(text, needle, occurrence) {
  if (!needle) return null;
  const src = String(text);
  const want = String(needle);
  let idx = -1;
  for (let n = 0; n <= (occurrence || 0); n++) {
    const next = src.indexOf(want, idx + 1);
    if (next < 0) break;      // fewer occurrences than asked for — keep the last
    idx = next;
  }
  return idx < 0 ? null : lineOf(src, idx);
}

// ─── JSON ──────────────────────────────────────────────────────────────────

export function parseJsonSpec(text) {
  try {
    return { data: JSON.parse(text), issues: [] };
  } catch (e) {
    // Node reports a position two different ways and sometimes not at all:
    //   "… in JSON at position 8 (line 1 column 9)"   ← both
    //   "Unexpected token ',', \"{…}\" is not valid JSON"  ← neither
    // Take the line directly when offered, fall back to the position, and as
    // a last resort locate the snippet Node quoted back.
    const msg = e.message || "";
    let line = null;
    const lm = /line (\d+)/.exec(msg);
    const pm = /position (\d+)/.exec(msg);
    if (lm) line = parseInt(lm[1], 10);
    else if (pm) line = lineOf(text, parseInt(pm[1], 10));
    else {
      const snip = /"((?:[^"\\]|\\.){4,40})"\s+is not valid JSON/.exec(msg);
      if (snip) line = findLine(text, snip[1].replace(/^\.\.\./, ""));
    }
    return { data: null, issues: [issue("error", line, "",
      "this file is not valid JSON — " + (e.message || "parse failed"))] };
  }
}

// ─── YAML (strict subset) ──────────────────────────────────────────────────

/**
 * A deliberately small YAML reader: exactly the shape a spec needs, and an
 * explicit refusal for anything else.
 *
 * Supported: `key: value` scalars, `key:` followed by a block sequence of
 * mappings (`- name: x` with further `  key: value` lines), `key: []` for an
 * empty list, quoted or bare scalars, `#` comments and blank lines.
 *
 * Refused with a line number: anchors and aliases, flow mappings, and
 * multi-line scalar blocks. The project carries no YAML dependency, and a
 * reader that silently mis-parsed a construct it did not understand would be
 * far worse than one that says which line it cannot read.
 */
export function parseYamlSpec(text) {
  const issues = [];
  const out = {};
  const lines = String(text).split("\n");
  let currentKey = null;   // key whose block sequence we are inside
  let currentItem = null;  // mapping being accumulated from `- ` onwards

  const flush = function() {
    if (currentKey && currentItem) out[currentKey].push(currentItem);
    currentItem = null;
  };

  const scalar = function(raw) {
    let v = String(raw).trim();
    if (v === "") return "";
    // strip an inline comment that is not inside quotes
    if (v[0] !== '"' && v[0] !== "'") {
      const h = v.indexOf(" #");
      if (h >= 0) v = v.slice(0, h).trim();
    }
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1)
        || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
      return v.slice(1, -1);
    }
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null" || v === "~") return null;
    return v;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ln = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (/^[&*]/.test(trimmed)) {
      issues.push(issue("error", ln, "", "YAML anchors and aliases are not supported here — write the value out in full"));
      continue;
    }
    if (/:\s*[|>]\s*$/.test(trimmed)) {
      issues.push(issue("error", ln, "", "multi-line scalar blocks (| and >) are not supported here — put the text on one line, quoting it if it contains a colon"));
      continue;
    }
    if (/:\s*\{/.test(trimmed)) {
      issues.push(issue("error", ln, "", "inline flow mappings ({…}) are not supported here — use an indented block instead"));
      continue;
    }

    const indent = raw.length - raw.replace(/^\s*/, "").length;

    // `- key: value` starts a new item in the current sequence
    if (trimmed.startsWith("- ")) {
      if (!currentKey) {
        issues.push(issue("error", ln, "", "a list item appears before any key that could hold it"));
        continue;
      }
      flush();
      currentItem = {};
      const rest = trimmed.slice(2).trim();
      const kv = /^([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(rest);
      if (!kv) {
        issues.push(issue("error", ln, "", "a list item must start a mapping, as `- name: value`"));
        continue;
      }
      currentItem[kv[1]] = scalar(kv[2]);
      continue;
    }

    const kv = /^([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(trimmed);
    if (!kv) {
      issues.push(issue("error", ln, "", "expected `key: value` — this line is neither a key nor a list item"));
      continue;
    }
    const key = kv[1];
    const val = kv[2];

    // Indented under an item → another field of that item.
    if (currentItem && indent > 0) {
      currentItem[key] = scalar(val);
      continue;
    }

    flush();
    currentKey = null;
    if (val === "" ) {          // `key:` opening a block sequence
      out[key] = [];
      currentKey = key;
    } else if (val === "[]") {
      out[key] = [];
    } else {
      out[key] = scalar(val);
    }
  }
  flush();
  return { data: issues.some((x) => x.severity === "error") ? null : out, issues };
}

// ─── Markdown template ─────────────────────────────────────────────────────

/**
 * Split a markdown table row into trimmed cells, honouring `\|` as a literal
 * pipe. A requirement description may legitimately contain one — and
 * specToMarkdown escapes it that way — so a reader that split on every pipe
 * would tear the cell in half and silently move the tail into the next
 * column.
 */
function tableCells(line) {
  const body = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparatorRow(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

/** Header cell → canonical field name, per section. */
const MD_HEADERS = {
  requirements: { id: "id", cat: "cat", category: "cat", pri: "pri", priority: "pri",
                  desc: "desc", description: "desc", rat: "rat", rationale: "rat" },
  iface:        { name: "name", dir: "dir", direction: "dir", width: "width",
                  reset: "reset", desc: "desc", description: "desc" },
  params:       { name: "name", type: "type", def: "def", default: "def",
                  range: "range", desc: "desc", description: "desc" },
};

const SECTION_OF = {
  requirements: "requirements", requirement: "requirements",
  interface: "iface", iface: "iface", ports: "iface",
  parameters: "params", params: "params", parameter: "params",
};

export function parseMarkdownSpec(text) {
  const issues = [];
  const data = { modName: "", domain: "", requirements: [], iface: [], params: [] };
  const lines = String(text).split("\n");
  let section = null;
  let headerMap = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ln = i + 1;
    const t = raw.trim();
    if (t === "") continue;

    const h1 = /^#\s+(.+)$/.exec(t);
    if (h1) { data.modName = h1[1].trim(); section = null; headerMap = null; continue; }

    const h2 = /^##\s+(.+)$/.exec(t);
    if (h2) {
      const name = h2[1].trim().toLowerCase().replace(/[^a-z]/g, "");
      section = SECTION_OF[name] || null;
      headerMap = null;
      if (!section) {
        issues.push(issue("warning", ln, "",
          'section "' + h2[1].trim() + '" is not one this importer reads — expected Requirements, Interface or Parameters'));
      }
      continue;
    }

    const dm = /^domain\s*:\s*(.+)$/i.exec(t);
    if (dm && !section) { data.domain = dm[1].trim(); continue; }

    if (!section || !t.startsWith("|")) continue;
    if (isSeparatorRow(raw)) continue;

    const cells = tableCells(raw);
    if (!headerMap) {
      // first table row of a section is its header
      const map = MD_HEADERS[section];
      headerMap = cells.map(function(c) {
        const key = c.toLowerCase().replace(/[^a-z]/g, "");
        return map[key] || null;
      });
      const unknown = cells.filter((c, k) => headerMap[k] === null && c !== "");
      if (unknown.length > 0) {
        issues.push(issue("warning", ln, "",
          "column(s) " + unknown.map((u) => '"' + u + '"').join(", ")
          + " in the " + section + " table are not read by this importer"));
      }
      continue;
    }

    const row = {};
    for (let k = 0; k < cells.length && k < headerMap.length; k++) {
      if (headerMap[k]) row[headerMap[k]] = cells[k];
    }
    row._line = ln;
    if (Object.keys(row).length <= 1) continue;   // blank row
    data[section].push(row);
  }

  if (!data.modName) {
    issues.push(issue("error", null, "modName",
      "no module name found — the file must open with a level-1 heading, as `# my_module`"));
  }
  return { data: issues.some((x) => x.severity === "error") ? null : data, issues };
}

// ─── Shape validation, shared by every format ──────────────────────────────

/**
 * Check an extracted spec against the contract the rest of the pipeline
 * relies on. `text` is the original file, used only to place a problem on a
 * line when the parser could not.
 */
export function validateSpec(spec, text) {
  const issues = [];
  const src = String(text || "");
  // A markdown row knows its own line. For JSON and YAML we locate the item's
  // id or name in the source — counting occurrences, so two requirements that
  // share an id do not both point at the first one.
  const seenCount = {};
  const at = function(row, needle) {
    if (row && row._line) return row._line;
    if (!needle) return null;
    const n = seenCount[needle] || 0;
    seenCount[needle] = n + 1;
    return findLine(src, needle, n);
  };

  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return [issue("error", null, "", "the spec must be an object with modName, requirements, iface and params")];
  }

  const modName = String(spec.modName || "").trim();
  if (!modName) {
    issues.push(issue("error", null, "modName", "modName is required — it names the module every later stage builds"));
  } else if (!/^[A-Za-z_]\w*$/.test(modName)) {
    issues.push(issue("error", findLine(src, modName), "modName",
      'modName "' + modName + '" is not a valid SystemVerilog identifier'));
  }

  // ── requirements ──
  if (!Array.isArray(spec.requirements) || spec.requirements.length === 0) {
    issues.push(issue("error", null, "requirements",
      "at least one requirement is required — the verification stages measure against them"));
  } else {
    spec.requirements.forEach(function(r, i) {
      const where = "requirements[" + i + "]";
      if (!r || typeof r !== "object") {
        issues.push(issue("error", null, where, "requirement " + (i + 1) + " is not an object"));
        return;
      }
      const id = String(r.id || "").trim();
      const line = at(r, id);
      if (!id) {
        issues.push(issue("error", line, where + ".id", "requirement " + (i + 1) + " has no id — expected the form REQ-FUNC-001"));
      } else if (!/^REQ-[A-Z]+-\d+$/.test(id)) {
        issues.push(issue("error", line, where + ".id",
          'requirement id "' + id + '" is malformed — expected REQ-<CAT>-<NNN>, as REQ-FUNC-001'));
      } else {
        const pfx = /^REQ-([A-Z]+)-\d+$/.exec(id)[1];
        const expected = PREFIX_TO_CAT[pfx];
        if (!expected) {
          issues.push(issue("error", line, where + ".id",
            'requirement id "' + id + '" uses an unknown category prefix "' + pfx
            + '" — expected one of INTF, FUNC, TIME, ERR, VERIF'));
        } else if (r.cat && String(r.cat).trim() !== expected) {
          // repairable: the spec node aligns cat to the id prefix already
          issues.push(issue("warning", line, where + ".cat",
            'requirement ' + id + ' is categorised "' + r.cat + '" but its id says "'
            + expected + '" — the id wins, and the category will be corrected'));
        }
      }
      if (!String(r.desc || "").trim()) {
        issues.push(issue("error", line, where + ".desc",
          "requirement " + (id || i + 1) + " has no description — there is nothing for a test to verify"));
      }
      const pri = String(r.pri || "").trim().toLowerCase();
      if (!pri) {
        issues.push(issue("error", line, where + ".pri",
          "requirement " + (id || i + 1) + " has no priority — expected Must, Should or May"));
      } else if (!VALID_PRI.has(pri)) {
        issues.push(issue("error", line, where + ".pri",
          'requirement ' + (id || i + 1) + ' has priority "' + r.pri + '" — expected Must, Should or May'));
      }
    });
    const ids = spec.requirements.map((r) => String((r && r.id) || "")).filter(Boolean);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    for (const d of Array.from(new Set(dup))) {
      issues.push(issue("error", findLine(src, d), "requirements",
        'requirement id "' + d + '" appears more than once — ids must be unique'));
    }
  }

  // ── iface ──
  if (!Array.isArray(spec.iface) || spec.iface.length === 0) {
    issues.push(issue("error", null, "iface",
      "at least one port is required — the RTL and testbench are both built from this list"));
  } else {
    spec.iface.forEach(function(p, i) {
      const where = "iface[" + i + "]";
      if (!p || typeof p !== "object") {
        issues.push(issue("error", null, where, "port " + (i + 1) + " is not an object"));
        return;
      }
      const name = String(p.name || "").trim();
      const line = at(p, name);
      if (!name) {
        issues.push(issue("error", line, where + ".name", "port " + (i + 1) + " has no name"));
      } else if (!/^[A-Za-z_]\w*$/.test(name)) {
        issues.push(issue("error", line, where + ".name",
          'port name "' + name + '" is not a valid SystemVerilog identifier'));
      }
      const dir = String(p.dir || "").trim().toLowerCase();
      if (!dir) {
        issues.push(issue("error", line, where + ".dir",
          'port "' + (name || i + 1) + '" has no direction — expected input, output or inout'));
      } else if (!VALID_DIRS.has(dir)) {
        issues.push(issue("error", line, where + ".dir",
          'port "' + (name || i + 1) + '" has direction "' + p.dir + '" — expected input, output or inout'));
      }
      if (!String(p.width || "").trim()) {
        issues.push(issue("error", line, where + ".width",
          'port "' + (name || i + 1) + '" has no width — use "1" for a scalar, or a parameter name'));
      }
      // The reset contract: an output with no stated reset behaviour makes the
      // RTL and the testbench each guess (run 29).
      if (dir === "output" && !String(p.reset || "").trim()) {
        issues.push(issue("warning", line, where + ".reset",
          'output "' + (name || i + 1) + '" states no reset behaviour — the RTL and the testbench will each assume one, and any disagreement is an irreducible test failure'));
      }
    });
    const names = spec.iface.map((p) => String((p && p.name) || "")).filter(Boolean);
    const dupN = names.filter((x, i) => names.indexOf(x) !== i);
    for (const d of Array.from(new Set(dupN))) {
      issues.push(issue("error", findLine(src, d), "iface", 'port "' + d + '" is declared more than once'));
    }
  }

  // ── params (optional, but must be well formed when present) ──
  if (spec.params != null && !Array.isArray(spec.params)) {
    issues.push(issue("error", null, "params", "params must be a list, or omitted entirely"));
  } else if (Array.isArray(spec.params)) {
    spec.params.forEach(function(p, i) {
      const where = "params[" + i + "]";
      if (!p || typeof p !== "object") {
        issues.push(issue("error", null, where, "parameter " + (i + 1) + " is not an object"));
        return;
      }
      const name = String(p.name || "").trim();
      const line = at(p, name);
      if (!name) {
        issues.push(issue("error", line, where + ".name", "parameter " + (i + 1) + " has no name"));
      } else if (!/^[A-Za-z_]\w*$/.test(name)) {
        issues.push(issue("error", line, where + ".name",
          'parameter name "' + name + '" is not a valid SystemVerilog identifier'));
      }
      if (p.def === undefined || String(p.def).trim() === "") {
        issues.push(issue("warning", line, where + ".def",
          'parameter "' + (name || i + 1) + '" has no default value'));
      }
    });
  }

  return issues;
}

// ─── Normalisation ─────────────────────────────────────────────────────────

/** Drop importer bookkeeping and coerce to the exact stage shape. */
function normalise(spec) {
  const clean = function(o, keys) {
    const out = {};
    for (const k of keys) if (o[k] !== undefined && o[k] !== "") out[k] = o[k];
    return out;
  };
  return {
    modName: String(spec.modName || "").trim(),
    domain:  String(spec.domain || "").trim(),
    requirements: (spec.requirements || []).map(function(r) {
      const out = clean(r, ["id", "cat", "pri", "desc", "rat"]);
      if (!out.rat) out.rat = "[imported from an existing specification]";
      return out;
    }),
    iface: (spec.iface || []).map(function(p) {
      const out = clean(p, ["name", "dir", "width", "desc", "reset"]);
      if (out.dir) out.dir = String(out.dir).toLowerCase();
      if (out.width != null) out.width = String(out.width);
      return out;
    }),
    params: (spec.params || []).map(function(p) {
      const out = clean(p, ["name", "type", "def", "range", "desc"]);
      if (!out.type) out.type = "parameter";
      // A markdown cell is always text, so a default written as 4 arrives as
      // "4". The stage's schema says def is a number — coerce, so the same
      // spec in three formats yields the same object rather than three that
      // differ only in the type of a default.
      if (typeof out.def === "string" && /^-?\d+$/.test(out.def.trim())) {
        out.def = parseInt(out.def.trim(), 10);
      } else if (typeof out.def === "string" && /^-?\d*\.\d+$/.test(out.def.trim())) {
        out.def = parseFloat(out.def.trim());
      }
      return out;
    }),
  };
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Read a spec file into the shape the spec stage produces.
 *
 * @param {string} text      the file's contents
 * @param {string} filename  used to choose the reader, and to name the file in errors
 * @returns {{ok: boolean, spec: object|null, format: string|null, issues: Array}}
 *   `ok` is false when any issue is an error. Warnings never block: they name
 *   things the pipeline repairs or tolerates, and are worth showing anyway.
 */
export function importSpec(text, filename) {
  const format = detectSpecFormat(filename);
  if (!format) {
    return { ok: false, spec: null, format: null, issues: [issue("error", null, "",
      "unrecognised spec file type — expected .json, .yaml or .md")] };
  }
  if (!String(text || "").trim()) {
    return { ok: false, spec: null, format: format, issues: [issue("error", null, "",
      "the spec file is empty")] };
  }

  const parsed = format === "json" ? parseJsonSpec(text)
    : format === "yaml" ? parseYamlSpec(text)
    : parseMarkdownSpec(text);

  if (!parsed.data) {
    return { ok: false, spec: null, format: format, issues: parsed.issues };
  }

  const issues = parsed.issues.concat(validateSpec(parsed.data, text));
  const failed = issues.some((x) => x.severity === "error");
  return {
    ok: !failed,
    spec: failed ? null : normalise(parsed.data),
    format: format,
    issues: issues,
  };
}

/** Render issues for a terminal or a panel: one line each, file:line first. */
export function formatImportIssues(issues, filename) {
  const name = filename || "spec";
  return (issues || []).map(function(x) {
    const where = x.line ? name + ":" + x.line : name;
    const mark = x.severity === "error" ? "✗" : "⚠";
    const field = x.field ? " (" + x.field + ")" : "";
    return mark + " " + where + field + " — " + x.message;
  }).join("\n");
}
