// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// pipeline/coversParser — extract test→requirement attribution from TB source
//
// The verify node parses [PASS]/[FAIL] markers from simulation stdout and
// builds tests = [{ name, st, cyc, ms }]. Without a `req` field, the judge
// stage cannot grade traceability — every Must requirement appears in trace
// with `ok: false` even when its test passed.
//
// This module bridges the gap by reading the testbench source for the
// `// covers: <REQ-ID>` annotations the testGen prompt requires, and
// emitting a function that attributes a parsed test name to its REQ-ID.
//
// Layered strategy (returns null if no layer matches):
//   1. Test name matches REQ-XXX-NNN pattern directly → use as req.
//   2. Test name contains a task name as substring → look up that task
//      in the task→req map.
//   3. Test name appears verbatim inside a task's body (line range scan)
//      → use that task's req.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a SystemVerilog testbench source for task definitions and their
 * `// covers: REQ-XXX` annotations.
 *
 * Returns { tasks: [{ name, req, startLine, endLine }] }
 * where each entry maps a task to its declared requirement coverage.
 *
 * Heuristic: a task's covers comment is the first `// covers: <REQ-ID>` that
 * appears within the task body (between `task` and `endtask`).
 *
 * @param {string} tbSource  Full testbench source text.
 * @returns {{ tasks: Array<{name: string, req: string, startLine: number, endLine: number}> }}
 */
export function parseCoversAnnotations(tbSource) {
  if (typeof tbSource !== "string" || tbSource.length === 0) {
    return { tasks: [] };
  }
  const lines = tbSource.split(/\r?\n/);
  const tasks = [];
  let i = 0;
  while (i < lines.length) {
    // Match `task automatic foo();` or `task foo();` or `task foo(args);`.
    // We accept any whitespace at start (allowing indented tasks).
    const m = lines[i].match(/^\s*task\s+(?:automatic\s+)?([a-zA-Z_]\w*)\s*\(/);
    if (!m) { i++; continue; }
    const taskName = m[1];
    const startLine = i + 1; // 1-based for human readability
    // Scan forward for `// covers: REQ-XXX-NNN` and `endtask`.
    let req = null;
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (req == null) {
        const cm = line.match(/\/\/\s*covers\s*:\s*(REQ-[A-Z]+-\d+)/i);
        if (cm) req = cm[1].toUpperCase();
      }
      if (/^\s*endtask\b/.test(line)) {
        tasks.push({
          name: taskName,
          req: req,
          startLine: startLine,
          endLine: j + 1,
        });
        i = j + 1;
        break;
      }
      j++;
    }
    if (j >= lines.length) {
      // Unterminated task — record what we have and bail
      tasks.push({
        name: taskName,
        req: req,
        startLine: startLine,
        endLine: lines.length,
      });
      break;
    }
  }
  return { tasks };
}

/**
 * Attribute a parsed test name to a requirement ID using the task→req map
 * derived from `parseCoversAnnotations`.
 *
 * Matches in priority order:
 *   1. Test name matches REQ-XXX-NNN pattern directly (case-insensitive)
 *      → return that REQ-ID.
 *   2. Test name contains a task name as substring → return that task's req.
 *   3. Test name (treated as a CHECK label) appears verbatim in the body
 *      of a task → return that task's req. We can't run this scan from
 *      just the parsed map; the caller passes the full source for this.
 *
 * Returns null if no match.
 *
 * @param {string} testName  Name from the [PASS]/[FAIL] marker.
 * @param {{tasks: Array}} coversMap  Output of parseCoversAnnotations.
 * @param {string} [tbSource]  Optional full source for layer 3 fallback.
 * @returns {string|null}
 */
export function attributeTestToReq(testName, coversMap, tbSource) {
  if (!testName) return null;
  const tasks = (coversMap && coversMap.tasks) || [];

  // Layer 1: explicit REQ-ID in test name
  const direct = testName.match(/REQ-[A-Z]+-\d+/i);
  if (direct) return direct[0].toUpperCase();

  // Layer 2: task-name substring match (longest match wins to avoid
  // collisions like `test_a` matching when `test_a_long` is more specific)
  let bestTask = null;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.name || !t.req) continue;
    if (testName === t.name || testName.indexOf(t.name) >= 0) {
      if (!bestTask || t.name.length > bestTask.name.length) {
        bestTask = t;
      }
    }
  }
  if (bestTask) return bestTask.req;

  // Layer 3: lexical scope match — scan source for the test name as a
  // string literal (CHECK label) and find the enclosing task.
  if (typeof tbSource === "string" && tbSource.length > 0) {
    const lines = tbSource.split(/\r?\n/);
    // Escape regex special chars in the test name for literal matching
    const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labelRe = new RegExp('"' + escaped + '"');
    for (let i = 0; i < lines.length; i++) {
      if (labelRe.test(lines[i])) {
        // Find the task whose [startLine, endLine] contains this line
        const lineNo = i + 1;
        const enclosing = tasks.find(function(t) {
          return t.req && lineNo >= t.startLine && lineNo <= t.endLine;
        });
        if (enclosing) return enclosing.req;
      }
    }
  }

  return null;
}
