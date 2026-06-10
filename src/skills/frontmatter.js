// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// skills/frontmatter — Parse YAML frontmatter from a markdown file
//
// Supported subset (deliberately small — every feature here costs us a test
// and a rule. We expand only when a real skill needs it):
//
//   ---
//   key: value                      scalar string
//   key: 42                         scalar number
//   key: true                       scalar boolean
//   key:                            list (one per indented line)
//     - item-a
//     - item-b
//   key: [a, b, c]                  inline list of scalars
//   ---
//
// Anything else (nested maps, multi-line strings, anchors, tags) is
// rejected with a clear error rather than silently misinterpreted.
//
// Rationale for not pulling in `js-yaml`: rtlforge ships zero-dep when
// possible, and a 200-line custom parser with focused tests is more
// auditable than a 200KB dep for a 4-field config surface. If the
// frontmatter language ever grows (e.g. nested maps for per-stage
// overrides), reconsider.
// ═══════════════════════════════════════════════════════════════════════════

const FENCE = /^---\s*$/;

/**
 * @typedef {Object} ParsedFrontmatter
 * @property {Object} data   - Parsed frontmatter fields (empty {} if none)
 * @property {string} body   - Markdown content following the frontmatter
 * @property {Array<{line: number, message: string}>} warnings - Soft issues
 */

/**
 * Split a markdown file into frontmatter + body. If no frontmatter block
 * is found, the entire input is the body.
 *
 * @param {string} source
 * @returns {ParsedFrontmatter}
 */
export function parseFrontmatter(source) {
  if (typeof source !== "string") {
    throw new TypeError("parseFrontmatter: source must be a string");
  }
  const lines = source.split("\n");
  if (lines.length < 2 || !FENCE.test(lines[0])) {
    return { data: {}, body: source, warnings: [] };
  }
  // Find the closing fence
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { endIdx = i; break; }
  }
  if (endIdx < 0) {
    // Opening fence but no closer — treat the whole thing as body and
    // warn. Better than silently dropping the file.
    return {
      data: {},
      body: source,
      warnings: [{ line: 1, message: "frontmatter opening '---' has no closing '---' — treating entire file as body" }],
    };
  }
  const fmLines = lines.slice(1, endIdx);
  const bodyLines = lines.slice(endIdx + 1);
  // Strip a single leading blank line from the body if present (cosmetic
  // — the standard convention is `---\n---\n\nbody...`).
  if (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
  const { data, warnings } = parseYamlSubset(fmLines, 1);
  return { data: data, body: bodyLines.join("\n"), warnings: warnings };
}

/**
 * Parse the small YAML subset described above. Returns {data, warnings}.
 * Uses 1-based line numbers (offset is the line of the OPENING fence + 1).
 */
function parseYamlSubset(fmLines, lineOffset) {
  const data = {};
  const warnings = [];
  let i = 0;

  while (i < fmLines.length) {
    const raw = fmLines[i];
    const lineNo = lineOffset + i + 1;
    // Skip blank lines and full-line comments
    if (raw.trim() === "" || raw.trim().startsWith("#")) { i++; continue; }

    // Reject mid-line comments to avoid ambiguity with `key: # value`
    // (we'd have to decide whether the value is "" or a comment). Skill
    // authors can use full-line comments instead.
    const hashIdx = indexOfUnquotedHash(raw);
    if (hashIdx >= 0) {
      throw skillError("inline '#' comments not supported (only full-line comments)", lineNo);
    }

    // Top-level scalar lines must not be indented (lists are indented
    // under their key; we handle them inline below).
    if (raw.startsWith(" ") || raw.startsWith("\t")) {
      throw skillError("unexpected indentation at top level", lineNo);
    }

    const colonIdx = raw.indexOf(":");
    if (colonIdx < 0) {
      throw skillError("expected 'key: value' line", lineNo);
    }
    const key = raw.slice(0, colonIdx).trim();
    const rest = raw.slice(colonIdx + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw skillError("invalid key name '" + key + "' (allowed: letters, digits, _, -)", lineNo);
    }
    if (key in data) {
      warnings.push({ line: lineNo, message: "duplicate key '" + key + "' — last value wins" });
    }

    if (rest === "") {
      // List that follows on indented lines
      const items = [];
      let j = i + 1;
      while (j < fmLines.length) {
        const l = fmLines[j];
        if (l.trim() === "" || l.trim().startsWith("#")) { j++; continue; }
        if (!/^\s+-\s/.test(l)) break;       // not a list item — done
        const itemStr = l.replace(/^\s+-\s+/, "");
        items.push(parseScalar(itemStr, lineOffset + j + 1));
        j++;
      }
      data[key] = items;
      i = j;
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      // Inline list
      data[key] = parseInlineList(rest, lineNo);
      i++;
      continue;
    }
    if (rest.startsWith("{")) {
      throw skillError("inline maps are not supported in skill frontmatter", lineNo);
    }
    data[key] = parseScalar(rest, lineNo);
    i++;
  }

  return { data: data, warnings: warnings };
}

function parseScalar(raw, lineNo) {
  const v = raw.trim();
  if (v === "")                         return "";
  if (v === "null" || v === "~")        return null;
  if (v === "true")                     return true;
  if (v === "false")                    return false;
  // Numbers (no exponents — keep it simple; if a skill author needs that
  // for some reason they can quote the value).
  if (/^-?\d+$/.test(v))                return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v))           return parseFloat(v);
  // Quoted strings — strip the quotes, no escape processing beyond \\ and \"
  if ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))) {
    if (v.length < 2) throw skillError("malformed quoted string", lineNo);
    const inner = v.slice(1, -1);
    if (v[0] === '"') {
      return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return inner;  // single-quoted — no escapes per YAML spec
  }
  // Bare string
  return v;
}

function parseInlineList(raw, lineNo) {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  // Split on commas not inside quotes
  const items = [];
  let cur = "";
  let inSingle = false, inDouble = false;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "," && !inSingle && !inDouble) { items.push(cur); cur = ""; }
    else cur += ch;
  }
  items.push(cur);
  return items.map(function(s) { return parseScalar(s, lineNo); });
}

/**
 * Find the index of an unquoted '#'. Returns -1 if none.
 */
function indexOfUnquotedHash(line) {
  let inSingle = false, inDouble = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble) {
      // The colon that separates key from value is fine; only flag '#'
      // that appears after the start of the value. Rather than try to
      // detect that boundary, treat any unquoted # as a problem and let
      // the user use full-line comments. Simpler, and the test pins it.
      return k;
    }
  }
  return -1;
}

function skillError(message, line) {
  const e = new Error("skill frontmatter (line " + line + "): " + message);
  e.code = "EFRONTMATTER";
  e.line = line;
  return e;
}
