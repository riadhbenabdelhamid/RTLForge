// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// utils/promptYaml.js — YAML round-trip for prompt overrides
//
// Why a custom mini-parser instead of pulling js-yaml:
//   Our schema is tiny and fixed — maps of strings, lists of {title, content}
//   sections, block scalars for multi-line content. No anchors, no flow style,
//   no tagged types, no merge keys, nothing exotic. ~140 lines of focused
//   code gives us:
//     - Zero new dependencies (no supply-chain risk).
//     - Deterministic output (idempotent round-trip is a hard contract here).
//     - Exact control over formatting — block scalars use the literal `|`
//       form so multi-line prompts survive editing in any text editor.
//
// Schema:
//   Single-stage:
//     stage: <stageKey>
//     sections:
//       - title: <string>
//         content: |
//           <multi-line content>
//
//   Multi-stage bundle:
//     stages:
//       <stageKey>:
//         sections:
//           - title: <string>
//             content: |
//               <multi-line content>
//
// Both shapes are auto-detected by the importer.
// ═══════════════════════════════════════════════════════════════════════════

// ---- Serializer ------------------------------------------------------------

/**
 * Render a string as a YAML block scalar with `|` (literal style).
 * Picks `|` over `|-` to preserve a trailing newline by default, since
 * prompt sections often end in a sentence with no special trailing
 * semantics — preserving the newline keeps round-trips byte-identical.
 *
 * @param {string} s     The content to render.
 * @param {number} indent  Indentation spaces for each line of the block.
 */
function _yamlBlockScalar(s, indent) {
  const pad = " ".repeat(indent);
  if (s == null || s === "") return "|\n" + pad + "";
  // Split preserving final newline behaviour: if input ends in \n we use `|`,
  // otherwise we use `|-` (strip trailing newlines).
  const trailingNewline = s.endsWith("\n");
  const indicator = trailingNewline ? "|" : "|-";
  const lines = s.split("\n");
  // If the string ends in \n, split() leaves a trailing "" — drop it for output.
  if (trailingNewline) lines.pop();
  return indicator + "\n" + lines.map(function(ln) { return pad + ln; }).join("\n");
}

/**
 * Quote a YAML scalar (used for titles and stage keys).
 * Uses double quotes only when needed (whitespace, special chars, or
 * looks-like-a-keyword); otherwise emits bare.
 */
function _yamlScalar(s) {
  if (s == null) return '""';
  const str = String(s);
  // Reserved scalar-shaped values that must always be quoted to round-trip
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(str)) return JSON.stringify(str);
  // Numbers must be quoted to keep them as strings
  if (/^-?\d+(\.\d+)?$/.test(str)) return JSON.stringify(str);
  // Anything with special chars or leading/trailing whitespace
  if (/[:#&*!|>'"%@`{}[\],\n\r\t]/.test(str) || /^\s|\s$/.test(str)) {
    return JSON.stringify(str);
  }
  // Empty
  if (str.length === 0) return '""';
  return str;
}

/**
 * Serialize a single stage's sections to YAML.
 * @param {string} stageKey
 * @param {Array<{title: string, content: string}>} sections
 * @returns {string} YAML text
 */
export function serializeStageYaml(stageKey, sections) {
  const lines = [];
  lines.push("# RTL Forge — prompt sections for stage: " + stageKey);
  lines.push("# Edit and re-import to customise. Sections beyond the defaults are preserved.");
  lines.push("");
  lines.push("stage: " + _yamlScalar(stageKey));
  lines.push("sections:");
  (sections || []).forEach(function(sec) {
    lines.push("  - title: " + _yamlScalar(sec.title || ""));
    lines.push("    content: " + _yamlBlockScalar(sec.content || "", 6));
  });
  return lines.join("\n") + "\n";
}

/**
 * Serialize multiple stages' sections to a single YAML bundle.
 * @param {object} stagesObj  { stageKey: sections[] }
 * @returns {string} YAML text
 */
export function serializeAllStagesYaml(stagesObj) {
  const keys = Object.keys(stagesObj || {}).sort();   // deterministic order
  const lines = [];
  lines.push("# RTL Forge — prompt sections bundle");
  lines.push("# Contains overrides for " + keys.length + " stage(s).");
  lines.push("");
  lines.push("stages:");
  keys.forEach(function(k) {
    lines.push("  " + _yamlScalar(k) + ":");
    lines.push("    sections:");
    (stagesObj[k] || []).forEach(function(sec) {
      lines.push("      - title: " + _yamlScalar(sec.title || ""));
      lines.push("        content: " + _yamlBlockScalar(sec.content || "", 10));
    });
  });
  return lines.join("\n") + "\n";
}

// ---- Parser ----------------------------------------------------------------
//
// Tiny line-oriented parser. Tracks indentation. Recognises:
//   - "key: value"        scalar mapping
//   - "key:" (empty)      mapping start (children at deeper indent)
//   - "- ..."             list item
//   - "key: |" or "|-"    block scalar (consumes lines at deeper indent)
//   - lines starting with # — comments, ignored
//
// Anything else throws YamlParseError with the offending line number.

export class YamlParseError extends Error {
  constructor(msg, line) {
    super("YAML parse error at line " + line + ": " + msg);
    this.name = "YamlParseError";
    this.line = line;
    this.isYamlParseError = true;
  }
}

/**
 * Strip a trailing inline comment that begins with " #". We only honour
 * the `space-#` form so that values like "1#abc" or "https://..." don't
 * get truncated. (Full YAML comments require pre-#-whitespace.)
 */
function _stripInlineComment(s) {
  const idx = s.search(/\s#/);
  return idx >= 0 ? s.slice(0, idx) : s;
}

function _unquoteScalar(s) {
  if (s == null) return null;
  const trimmed = s.trim();
  if (trimmed === "") return "";
  // Double quoted
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch (_) { /* fallthrough */ }
  }
  // Single quoted (YAML uses '' as escape; handle simple case)
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Read a block scalar starting at `startIdx`. Returns { value, nextIdx }.
 * The literal indicator (`|` or `|-`) has already been consumed; we now
 * read indented lines at indentation greater than the parent key's indent.
 */
function _readBlockScalar(lines, startIdx, parentIndent, indicator) {
  const out = [];
  let i = startIdx;
  let blockIndent = -1;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw === "") { out.push(""); i++; continue; }
    const ind = raw.match(/^( *)/)[1].length;
    if (ind <= parentIndent) break;
    if (blockIndent < 0) blockIndent = ind;
    out.push(raw.slice(blockIndent));
    i++;
  }
  // Trailing newline preservation: `|` keeps it, `|-` strips it.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  let value = out.join("\n");
  if (indicator === "|") value += "\n";
  return { value: value, nextIdx: i };
}

/**
 * Top-level parser. Returns a generic JS object/array tree.
 * This is NOT general-purpose YAML — it handles exactly the shapes our
 * schema produces. Anything outside that throws YamlParseError.
 */
export function parsePromptYaml(text) {
  if (typeof text !== "string") throw new YamlParseError("input is not a string", 0);
  const lines = text.split(/\r?\n/);

  // _parseBlock parses a mapping or list at a fixed indent. Returns
  // { value, nextIdx }. Trims trailing comment-only lines.
  function _parseBlock(startIdx, indent) {
    // Decide list vs map by looking at first non-empty, non-comment line.
    let i = startIdx;
    while (i < lines.length) {
      const raw = lines[i];
      if (raw === "" || raw.replace(/^\s+/, "").startsWith("#")) { i++; continue; }
      const ind = raw.match(/^( *)/)[1].length;
      if (ind < indent) return { value: null, nextIdx: i };
      if (ind > indent) throw new YamlParseError("unexpected indentation (expected " + indent + ", got " + ind + ")", i + 1);
      const stripped = raw.slice(ind);
      if (stripped.startsWith("- ") || stripped === "-") {
        return _parseList(startIdx, indent);
      }
      return _parseMap(startIdx, indent);
    }
    return { value: null, nextIdx: i };
  }

  function _parseMap(startIdx, indent) {
    const obj = {};
    let i = startIdx;
    while (i < lines.length) {
      const raw = lines[i];
      if (raw === "" || raw.replace(/^\s+/, "").startsWith("#")) { i++; continue; }
      const ind = raw.match(/^( *)/)[1].length;
      if (ind < indent) break;
      if (ind > indent) throw new YamlParseError("unexpected indentation in map", i + 1);
      const stripped = raw.slice(ind);
      if (stripped.startsWith("- ") || stripped === "-") break;     // stop — caller handles
      const colonIdx = stripped.indexOf(":");
      if (colonIdx < 0) throw new YamlParseError("expected 'key: value' in map", i + 1);
      const key = _unquoteScalar(stripped.slice(0, colonIdx));
      const rest = stripped.slice(colonIdx + 1).replace(/^\s+/, "");
      const restNoComment = _stripInlineComment(rest).replace(/\s+$/, "");
      if (restNoComment === "" || restNoComment === "|" || restNoComment === "|-") {
        if (restNoComment === "|" || restNoComment === "|-") {
          // Block scalar
          const block = _readBlockScalar(lines, i + 1, ind, restNoComment);
          obj[key] = block.value;
          i = block.nextIdx;
        } else {
          // Nested mapping or list
          const child = _parseBlock(i + 1, ind + 2);
          obj[key] = child.value;
          i = child.nextIdx;
        }
      } else {
        // Recognise inline-empty `[]` and `{}` for empty list / empty map
        if (restNoComment === "[]") { obj[key] = []; i++; continue; }
        if (restNoComment === "{}") { obj[key] = {}; i++; continue; }
        obj[key] = _unquoteScalar(restNoComment);
        i++;
      }
    }
    return { value: obj, nextIdx: i };
  }

  function _parseList(startIdx, indent) {
    const arr = [];
    let i = startIdx;
    while (i < lines.length) {
      const raw = lines[i];
      if (raw === "" || raw.replace(/^\s+/, "").startsWith("#")) { i++; continue; }
      const ind = raw.match(/^( *)/)[1].length;
      if (ind < indent) break;
      if (ind > indent) throw new YamlParseError("unexpected indentation in list", i + 1);
      const stripped = raw.slice(ind);
      if (!stripped.startsWith("- ") && stripped !== "-") break;
      const itemRest = stripped === "-" ? "" : stripped.slice(2);
      // Two cases:
      //   "- key: value"       inline-start of map item (rest of map at indent+2)
      //   "-" alone            map starts on next line
      if (itemRest === "") {
        const child = _parseBlock(i + 1, indent + 2);
        arr.push(child.value);
        i = child.nextIdx;
      } else {
        // Treat the rest of this line as the first key of an inline-item map.
        // We synthesise a virtual line and re-parse from indent+2.
        const colonIdx = itemRest.indexOf(":");
        if (colonIdx < 0) {
          // Plain scalar list element
          arr.push(_unquoteScalar(_stripInlineComment(itemRest).replace(/\s+$/, "")));
          i++;
          continue;
        }
        // Build a synthetic block: replace this line with one at indent+2 carrying
        // the key, then parse from there. Mutating `lines` is acceptable here
        // because we still control iteration.
        const virtIndent = " ".repeat(indent + 2);
        lines[i] = virtIndent + itemRest;
        const child = _parseBlock(i, indent + 2);
        arr.push(child.value);
        i = child.nextIdx;
      }
    }
    return { value: arr, nextIdx: i };
  }

  const result = _parseBlock(0, 0);
  return result.value;
}

// ---- High-level helpers ----------------------------------------------------

/**
 * Parse a YAML import and normalise it to the format the workflow expects.
 * Auto-detects single-stage vs multi-stage bundle.
 *
 * @param {string} text  YAML text from a user-uploaded file.
 * @returns {{ kind: "single"|"bundle", stageKey?: string, sections?: Array, stages?: object }}
 *
 * Throws YamlParseError on syntactic problems.
 * Throws Error with explanatory message on schema problems.
 */
export function importPromptYaml(text) {
  const parsed = parsePromptYaml(text);
  if (parsed == null || typeof parsed !== "object") {
    throw new Error("YAML root must be a mapping");
  }
  if (parsed.stage != null) {
    // Single-stage shape
    if (typeof parsed.stage !== "string" || parsed.stage.length === 0) {
      throw new Error("'stage' must be a non-empty string");
    }
    if (!Array.isArray(parsed.sections)) {
      throw new Error("'sections' must be a list");
    }
    return {
      kind: "single",
      stageKey: parsed.stage,
      sections: _normaliseSections(parsed.sections),
    };
  }
  if (parsed.stages != null && typeof parsed.stages === "object") {
    // Bundle shape
    const out = {};
    Object.keys(parsed.stages).forEach(function(k) {
      const entry = parsed.stages[k];
      if (!entry || !Array.isArray(entry.sections)) {
        throw new Error("stages." + k + ".sections must be a list");
      }
      out[k] = _normaliseSections(entry.sections);
    });
    return { kind: "bundle", stages: out };
  }
  throw new Error("YAML must contain either a 'stage' field (single-stage) or a 'stages' field (bundle)");
}

function _normaliseSections(arr) {
  return arr.map(function(s, i) {
    if (!s || typeof s !== "object") {
      throw new Error("section " + (i + 1) + " is not a mapping");
    }
    if (typeof s.title !== "string" || s.title.length === 0) {
      throw new Error("section " + (i + 1) + " is missing a 'title' string");
    }
    return {
      title: s.title,
      content: typeof s.content === "string" ? s.content : "",
    };
  });
}
