// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Small, source-grounded interface contracts.  This module deliberately
// abstains unless a description uses an explicit module/port declaration.
// It must never infer a clock, reset, direction, width, or parameter from a
// domain name or from an implementation candidate.

const IDENT = "[A-Za-z_][A-Za-z0-9_$]*";

function compact(value) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, " ");
}

function splitTopLevel(text) {
  const out = [];
  let start = 0;
  let square = 0;
  let paren = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== "\\") quote = !quote;
    if (quote) continue;
    if (c === "[") square++;
    else if (c === "]") square = Math.max(0, square - 1);
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === "," && square === 0 && paren === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) out.push(text.slice(start).trim());
  return out;
}

function widthValue(raw) {
  if (!raw) return null;
  const s = compact(raw);
  const bits = /^(\d+)\s*(?:-\s*)?bits?$/i.exec(s);
  if (bits) return bits[1];
  const bracket = /^\[\s*([^\]]+)\s*\]$/.exec(s);
  if (bracket) return "[" + compact(bracket[1]) + "]";
  return s;
}

function widthEquivalent(a, b) {
  const x = widthValue(a);
  const y = widthValue(b);
  if (!x || !y) return !x && !y;
  if (x === y) return true;
  const vectorBits = function(v) {
    const m = /^\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(v);
    return m ? Math.abs(Number(m[1]) - Number(m[2])) + 1 : null;
  };
  const xb = vectorBits(x);
  const yb = vectorBits(y);
  if (xb != null && /^\d+$/.test(y)) return xb === Number(y);
  if (yb != null && /^\d+$/.test(x)) return yb === Number(x);
  // A common equivalent spelling in a generated ANSI header.
  const exprBits = function(v) {
    const m = /^\[\s*([A-Za-z_][\w$]*)\s*-\s*1\s*:\s*0\s*\]$/.exec(v);
    return m ? m[1] : null;
  };
  return exprBits(x) != null && exprBits(x) === exprBits(y);
}

function parsePortDeclarations(text, inheritedDir) {
  let s = compact(text).replace(/;$/, "");
  const dm = /^(input|output|inout)\b/i.exec(s);
  const inherited = inheritedDir && typeof inheritedDir === "object" ? inheritedDir : { dir: inheritedDir || null, width: null };
  const dir = dm ? dm[1].toLowerCase() : inherited.dir || null;
  if (dm) s = s.slice(dm[0].length).trim();
  // Direction and net/type keywords are irrelevant to the external contract.
  while (/^(?:wire|logic|reg|tri|uwire|signed|unsigned|var|const)\b\s*/i.test(s)) {
    s = s.replace(/^(?:wire|logic|reg|tri|uwire|signed|unsigned|var|const)\b\s*/i, "");
  }
  let width = null;
  const wm = /^\[([^\]]+)\]\s*/.exec(s);
  if (wm) { width = widthValue("[" + wm[1] + "]"); s = s.slice(wm[0].length).trim(); }
  if (!dir) return [];
  const names = splitTopLevel(s);
  const out = [];
  for (const nameText of names) {
    const nm = new RegExp("^(" + IDENT + ")\\s*(?:\\((\\d+)\\s*(?:-\\s*)?bits?\\))?$", "i").exec(nameText);
    if (!nm) return [];
    out.push({ name: nm[1], dir: dir, width: width || (!dm ? inherited.width : null) || (nm[2] ? nm[2] : "1") });
  }
  return out;
}

function parsePortDeclaration(text, inheritedDir) {
  return parsePortDeclarations(text, inheritedDir)[0] || null;
}

function nonNormativeContext(source, at) {
  const prefix = source.slice(0, at);
  const fence = prefix.lastIndexOf("```");
  if (fence >= 0 && (prefix.match(/```/g) || []).length % 2 === 1) {
    const opening = prefix.slice(Math.max(0, fence - 160), fence);
    const lineEnd = source.indexOf("\n", fence);
    const openingTail = source.slice(fence, lineEnd < 0 ? source.length : lineEnd);
    if (/\b(?:example|sample|buggy|incorrect|non[- ]?compliant|hypothetical)\b/i.test(opening)
        || /\b(?:example|sample|buggy|incorrect|non[- ]?compliant|hypothetical)\b/i.test(openingTail)) return true;
  }
  const lineStart = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("."));
  const sentence = prefix.slice(lineStart + 1);
  if (/\b(?:examples?|for\s+example|e\.g\.?|illustrative|sample|buggy|incorrect|non[- ]?compliant|hypothetical)\b/i.test(sentence)) return true;
  const previousStart = prefix.lastIndexOf("\n", Math.max(0, lineStart - 1));
  const previous = prefix.slice(previousStart + 1, lineStart);
  return /^\s*(?:examples?|for\s+example|e\.g\.?)\s*:?\s*$/i.test(previous);
}

const SV_RESERVED = new Set([
  "accept_on", "alias", "always", "always_comb", "always_ff", "always_latch",
  "and", "assert", "assign", "assume", "automatic", "begin", "bit", "break",
  "before", "buf", "byte", "case", "casex", "casez", "chandle", "clocking", "const",
  "config", "constraint", "continue", "cover", "covergroup", "coverpoint", "cross", "deassign", "default", "defparam", "disable", "dist",
  "do", "else", "end", "endcase", "endclocking", "endclass", "endfunction",
  "endconfig", "endgenerate", "endmodule", "endgroup", "endinterface", "endpackage", "endprimitive",
  "endprogram", "endproperty", "endsequence", "endtask", "enum", "event", "export",
  "edge", "expect", "extends", "extern", "final", "first_match", "for", "force", "foreach", "forever", "fork",
  "function", "generate", "genvar", "global", "if", "iff", "ifnone", "ignore_bins",
  "implements", "implies", "import", "inout", "input", "initial", "inside", "int", "interface",
  "intersect", "join", "join_any", "join_none", "large", "local", "localparam", "class",
  "logic", "longint", "macromodule", "matches", "modport", "module", "nand", "negedge",
  "new", "nexttime", "nmos", "nor", "noshowcancelled", "not", "notif", "null", "or",
  "output", "package", "packed", "parameter", "pmos", "posedge", "primitive", "priority", "protected",
  "program", "property", "pull0", "pull1", "pulldown", "pullup", "pure", "rand", "randc",
  "randcase", "randsequence", "rcmos", "real", "realtime", "ref", "release", "repeat",
  "return", "rnmos", "rpmos", "rtran", "rtranif0", "rtranif1", "s_always", "sequence",
  "shortint", "shortreal", "showcancelled", "signed", "small", "solve", "static", "string",
  "specparam", "strong", "struct", "super", "supply0", "supply1", "table", "tagged", "task", "this", "throughout",
  "time", "timeprecision", "timeunit", "tran", "tri", "tri0", "tri1", "triand", "trior",
  "trireg", "type", "typedef", "union", "unique", "unsigned", "until", "until_with", "untyped",
  "var", "vectored", "virtual", "void", "wait", "wait_order", "wand", "weak", "while", "wire",
  "with", "within", "wor", "xnor", "xor", "unique0", "unpacked", "bins", "binsof"
]);

function markdownPortBlocks(source) {
  const lines = String(source || "").split("\n");
  const blocks = [];
  let block = null;
  let offset = 0;
  const headingRe = /^\s*(?:#{1,6}\s*)?(?:(?:complete|exact|all)\s+)?(?:interface|ports?)\b[^.]*:?\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineOffset = offset;
    offset += line.length + 1;
    if (/^\s*#{1,6}\s+/.test(line)) {
      block = null;
    }
    if (headingRe.test(line)) {
      const bad = /\b(?:example|e\.g\.?|illustrative|sample|buggy|incorrect|non[- ]?compliant|hypothetical)\b/i.test(line);
      block = bad ? null : { heading: line, entries: [], valid: true,
        exhaustive: /\b(?:exact(?:ly)?|complete|all)\b/i.test(line) };
      if (block) blocks.push(block);
      continue;
    }
    if (!block) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue; // prose between declarations does not end the heading scope
    if (nonNormativeContext(source, lineOffset)) {
      block.valid = false;
      continue;
    }
    const parsed = parsePortDeclarations(bullet[1]);
    if (parsed.length === 0) block.valid = false;
    else block.entries.push(...parsed);
  }
  return blocks;
}

function explicitModuleName(desc) {
  const s = String(desc || "");
  const patterns = [
    /\bmodule\s+(?:named|called)\s+(`?[A-Za-z_][A-Za-z0-9_$]*`?)/i,
    /\btop(?:[- ]level)?\s+module\s*[:=]\s*(`?[A-Za-z_][A-Za-z0-9_$]*`?)/i,
    /(?:^|[\n;])\s*module\s+(`?[A-Za-z_][A-Za-z0-9_$]*`?)\s*(?=#|\(|with\b|has\b|contains\b|provides\b|ports?\b|interface\b|input\b|output\b|inout\b|$)/im,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m && !nonNormativeContext(s, m.index)) return m[1].replace(/^`|`$/g, "");
  }
  return null;
}

function explicitPorts(desc) {
  const source = String(desc || "");
  const found = [];
  const seen = new Set();
  let exhaustive = false;
  const add = function(p) {
    if (!p || !p.name || seen.has(p.name)) return;
    seen.add(p.name);
    found.push(p);
  };

  // Only simple declaration lines are accepted.  A prose sentence containing
  // “input” is intentionally ignored rather than partially interpreted.
  const lineRe = /(?:^|[\n;])\s*(input|output|inout)\b[^\n;]*/gi;
  let m;
  while ((m = lineRe.exec(source)) !== null) {
    if (nonNormativeContext(source, m.index)) continue;
    const line = m[0].replace(/^[\n;]/, "").trim();
    parsePortDeclarations(line).forEach(add);
  }

  // Markdown interface lists are accepted only inside a heading-scoped
  // interface/ports block. A complete heading is exhaustive only when every
  // bullet in that block is a supported declaration; a partial heading still
  // contributes facts without constraining unlisted ports.
  for (const block of markdownPortBlocks(source)) {
    block.entries.forEach(add);
    if (block.valid && block.entries.length > 0 && block.exhaustive) exhaustive = true;
  }

  // An explicitly labelled, comma-separated port list is exhaustive only
  // when every item is a declaration.  This avoids converting descriptive
  // clauses such as “input clock, active-low reset” into guessed contracts.
  const listRe = /\bports?\s*(?:\(\s*(partial|subset)\s*\))?\s*:\s*([^.;\n]+)/gi;
  while ((m = listRe.exec(source)) !== null) {
    if (nonNormativeContext(source, m.index)) continue;
    const pieces = splitTopLevel(m[2]);
    if (pieces.length === 0) continue;
    const parsed = [];
    let inherited = null;
    let ok = true;
    for (const piece of pieces) {
      const ps = parsePortDeclarations(piece, inherited);
      if (ps.length === 0) { ok = false; break; }
      inherited = { dir: ps[0].dir, width: ps[0].width };
      parsed.push(...ps);
    }
    if (ok) parsed.forEach(add);
    if (ok && parsed.length > 0 && !m[1]) exhaustive = true;
  }
  return { ports: found, exhaustive: exhaustive };
}

function explicitParams(desc) {
  const out = [];
  const seen = new Set();
  const s = String(desc || "");
  const re = /\bparameter\s+(?:named\s+)?([A-Za-z_][A-Za-z0-9_$]*)(?:\s*(?:=|\(\s*default\s+)([^),]+)\)?)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (nonNormativeContext(s, m.index)) continue;
    const key = m[1];
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ name: m[1], def: m[2] ? compact(m[2]) : null });
    }
  }
  return out;
}

/**
 * Extract only interface facts explicitly declared by a user description.
 * `explicit` flags whether each category is safe to enforce.
 */
export function extractUserInterfaceContract(description) {
  const moduleName = explicitModuleName(description);
  const parsedPorts = explicitPorts(description);
  const ports = parsedPorts.ports;
  const params = explicitParams(description);
  return {
    moduleName: moduleName,
    ports: ports,
    params: params,
    explicit: {
      moduleName: !!moduleName,
      ports: ports.length > 0,
      portsExhaustive: parsedPorts.exhaustive,
      params: params.length > 0,
    },
  };
}

/** Validate an optional exported RTL module-name request. */
export function validateRequiredModuleName(requiredName, contract) {
  if (requiredName == null) return null;
  if (typeof requiredName !== "string") {
    throw new Error("requiredModuleName must be a string");
  }
  const name = requiredName.trim();
  if (name === "") return null;
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error("requiredModuleName must be a valid SystemVerilog identifier");
  }
  // SystemVerilog keywords are case-sensitive: lowercase `module` is
  // reserved, while `Module` is a legal ordinary identifier.
  if (SV_RESERVED.has(name)) {
    throw new Error("requiredModuleName must not be a SystemVerilog reserved word");
  }
  if (contract && contract.explicit && contract.explicit.moduleName
      && contract.moduleName !== name) {
    throw new Error("requiredModuleName \"" + name
      + "\" conflicts with the explicitly named module \""
      + contract.moduleName + "\" in the description");
  }
  return name;
}

function maskComments(code) {
  const src = String(code || "");
  let out = "";
  let state = "normal";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (state === "line") { out += c === "\n" ? "\n" : " "; if (c === "\n") state = "normal"; continue; }
    if (state === "block") { out += c === "\n" ? "\n" : " "; if (c === "*" && src[i + 1] === "/") { out += " "; i++; state = "normal"; } continue; }
    if (c === "/" && src[i + 1] === "/") { out += "  "; i++; state = "line"; continue; }
    if (c === "/" && src[i + 1] === "*") { out += "  "; i++; state = "block"; continue; }
    out += c;
  }
  return out;
}

function headerOf(code, preferName) {
  const source = maskComments(code);
  const re = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b/g;
  const candidates = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    let end = -1;
    let depth = 0;
    let quote = false;
    for (let i = m.index; i < source.length; i++) {
      const c = source[i];
      if (c === '"' && source[i - 1] !== "\\") quote = !quote;
      if (quote) continue;
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
      else if (c === ";" && depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    candidates.push({ name: m[1], text: source.slice(m.index, end + 1) });
  }
  return candidates.find(function(x) { return x.name === preferName; }) || candidates[0] || null;
}

/** Extract the ANSI module header facts from a generated RTL candidate. */
export function extractRTLInterface(code, preferName) {
  const h = headerOf(code, preferName);
  if (!h) return null;
  const text = h.text.replace(/;\s*$/, "");
  const mm = /^module\s+([A-Za-z_][A-Za-z0-9_$]*)\b([\s\S]*)$/i.exec(text);
  if (!mm) return null;
  let tail = mm[2].trim();
  let paramText = "";
  if (/^#\s*\(/i.test(tail)) {
    const open = tail.indexOf("(");
    let depth = 0;
    let close = -1;
    for (let i = open; i < tail.length; i++) {
      if (tail[i] === "(") depth++;
      else if (tail[i] === ")") {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close >= 0) {
      paramText = tail.slice(open + 1, close);
      tail = tail.slice(close + 1).trim();
    }
  }
  const ports = [];
  let inherited = null;
  const portGroup = /^\(([\s\S]*)\)$/i.exec(tail);
  if (portGroup) {
    for (const piece of splitTopLevel(portGroup[1])) {
      const ps = parsePortDeclarations(piece, inherited);
      if (ps.length > 0) {
        ports.push(...ps);
        inherited = { dir: ps[0].dir, width: ps[0].width };
      }
    }
  }
  const params = [];
  // Parameter declarations are comma-separated at the top level.  Taking
  // the last identifier on the declaration's left hand side avoids treating
  // a type keyword (for example `int`) as the parameter name.
  const paramKeywords = new Set([
    "type", "signed", "unsigned", "logic", "bit", "integer", "int",
    "longint", "shortint", "byte", "time", "real", "realtime", "wire",
    "reg", "const", "var",
  ]);
  for (const piece of splitTopLevel(paramText)) {
    const declaration = /^\s*parameter\b([\s\S]*)$/i.exec(piece);
    if (!declaration) continue;
    const body = declaration[1];
    const eq = body.indexOf("=");
    const lhs = (eq >= 0 ? body.slice(0, eq) : body).replace(/\[[^\]]*\]/g, " ");
    const identifiers = lhs.match(new RegExp(IDENT, "g")) || [];
    const names = identifiers.filter(function(name) { return !paramKeywords.has(name.toLowerCase()); });
    const name = names[names.length - 1];
    if (!name) continue;
    params.push({ name: name, def: eq >= 0 ? compact(body.slice(eq + 1)) : null });
  }
  return { moduleName: mm[1], ports: ports, params: params, complete: portGroup != null };
}

function expectedParts(expected) {
  if (!expected) return { moduleName: null, ports: [], params: [] };
  return {
    moduleName: expected.moduleName || expected.modName || null,
    ports: expected.ports || expected.iface || [],
    params: expected.params || [],
  };
}

/**
 * Compare a candidate header with a source/spec contract.  Only fields in an
 * explicit source contract (or in a complete spec) are checked.
 */
export function interfaceContractViolations(actual, expected, opts) {
  if (!actual) return [{ kind: "header", message: "module header could not be parsed" }];
  const exp = expectedParts(expected);
  const explicit = (expected && expected.explicit) || {};
  const issues = [];
  const requiredModuleName = opts && opts.requiredModuleName;
  if (requiredModuleName && actual.moduleName !== requiredModuleName) {
    issues.push({ kind: "required_module_name", expected: requiredModuleName, actual: actual.moduleName,
      message: "exported module name must remain " + requiredModuleName + " (candidate has " + actual.moduleName + ")" });
  }
  if (exp.moduleName && (explicit.moduleName !== false) && actual.moduleName !== exp.moduleName) {
    issues.push({ kind: "module_name", expected: exp.moduleName, actual: actual.moduleName,
      message: "module name must remain " + exp.moduleName + " (candidate has " + actual.moduleName + ")" });
  }
  const checkPorts = explicit.ports !== false && exp.ports.length > 0;
  if (checkPorts) {
    const actualByName = new Map(actual.ports.map(function(p) { return [p.name, p]; }));
    const expectedNames = new Set();
    for (const p of exp.ports) {
      if (!p || !p.name) continue;
      expectedNames.add(String(p.name));
      const got = actualByName.get(String(p.name));
      if (!got) { issues.push({ kind: "missing_port", expected: p.name, message: "missing port " + p.name }); continue; }
      if (p.dir && got.dir !== String(p.dir).toLowerCase()) issues.push({ kind: "port_dir", expected: p.dir, actual: got.dir, message: "port " + p.name + " direction must be " + p.dir });
      if (p.width && got.width && !widthEquivalent(got.width, p.width)) issues.push({ kind: "port_width", expected: p.width, actual: got.width, message: "port " + p.name + " width must be " + p.width });
    }
    if (opts && opts.exactPorts) {
      for (const p of actual.ports) if (!expectedNames.has(p.name)) {
        issues.push({ kind: "extra_port", actual: p.name, message: "unexpected port " + p.name });
      }
    }
  }
  if (explicit.params !== false && exp.params.length > 0) {
    const actualByName = new Map(actual.params.map(function(p) { return [p.name, p]; }));
    for (const p of exp.params) {
      const got = actualByName.get(String(p.name));
      if (!got) issues.push({ kind: "missing_param", expected: p.name, message: "missing parameter " + p.name });
      else if (p.def != null && got.def != null && compact(got.def) !== compact(p.def)) {
        issues.push({ kind: "param_default", expected: p.def, actual: got.def, message: "parameter " + p.name + " default must be " + p.def });
      }
    }
  }
  return issues;
}

export function validateRTLInterface(code, expected, opts) {
  return interfaceContractViolations(extractRTLInterface(code, expected && (expected.moduleName || expected.modName)), expected, opts);
}
