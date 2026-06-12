// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// extractJSON — Robust JSON extraction from LLM output
//
// Recovery ladder: direct parse → fenced code → string-aware structural scan
// → common-issue repair → inner-quote repair → array fallback → diagnosis.
//
// DESIGN NOTES (read before "improving" with regexes):
//
// All structural reasoning here runs on ONE scanner (scanStructure) that
// tracks string state with escape handling. Naive regex/brace counting over
// LLM JSON misdiagnoses two extremely common defects:
//
//   1. Braces inside string values — {"code":"assign y = {a,b};"} — make
//      naive counts unbalanced on perfectly complete output.
//   2. UNESCAPED inner quotes — {"desc":"asserts "valid" when full"} —
//      desynchronize any quote-toggling scanner: from the bad quote onward,
//      real structural braces read as in-string and get skipped, so a
//      COMPLETE output scans as unbalanced and would be misreported as
//      "TRUNCATED OUTPUT (hit max_tokens)" — sending the user to tune a
//      token limit that was never the problem. escapeInnerQuotes repairs
//      this case before any truncation verdict is allowed.
//
// A TRUNCATED OUTPUT error is only thrown after repairs failed AND the
// scanner still reports open structures at EOF — and the error then carries
// real evidence: string-aware counts, whether EOF landed inside a string,
// whether the text parses once open structures are closed (a verified JSON
// prefix = genuine cut), the head AND the tail of the output, plus the
// callLLM provenance (stop reason, caps, auto-recovery attempts).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * String-aware structural scan from `start` (expected to be a '{' or '[').
 *
 * @returns {{
 *   end: number,              // index where the opening bracket balanced, or -1
 *   stack: string[],          // brackets still open at EOF (outermost first)
 *   inString: boolean,        // did EOF land inside a string literal?
 *   open: number, close: number, // STRUCTURAL brace counts (strings excluded)
 * }}
 */
function scanStructure(raw, start) {
  const stack = [];
  let inString = false;
  let esc = false;
  let open = 0;
  let close = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      if (ch === "{") open++;
    } else if (ch === "}" || ch === "]") {
      if (ch === "}") close++;
      const expected = ch === "}" ? "{" : "[";
      if (stack[stack.length - 1] === expected) stack.pop();
      if (stack.length === 0) {
        return { end: i, stack: [], inString: false, open: open, close: close };
      }
    }
  }
  return { end: -1, stack: stack, inString: inString, open: open, close: close };
}

/**
 * Repair unescaped quotes INSIDE string values — the desync defect from the
 * header. Heuristic: a legitimate string-CLOSING quote is always followed
 * (after whitespace) by a structural character (, : } ]) or EOF; a quote
 * followed by anything else is part of the text and gets escaped. This is
 * the standard salvage for LLM-emitted JSON and is wrong only for contrived
 * strings whose embedded quote happens to precede a comma — acceptable,
 * since the alternative is failing the whole stage.
 */
function escapeInnerQuotes(s) {
  let out = "";
  let inString = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (esc) { esc = false; out += ch; continue; }
    if (ch === "\\") { esc = true; out += ch; continue; }
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
      const nxt = j < s.length ? s[j] : "";
      if (nxt === "," || nxt === ":" || nxt === "}" || nxt === "]" || nxt === "") {
        inString = false;         // real closing quote
        out += ch;
      } else {
        out += '\\"';             // inner quote — escape, stay in string
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Escape control characters INSIDE string values only. The previous global
 * replacement also rewrote STRUCTURAL newlines (pretty-printed JSON) into
 * literal \n tokens, corrupting otherwise-recoverable output. Outside
 * strings, whitespace is legal and everything is left untouched.
 */
function escapeCtrlInStrings(s) {
  let out = "";
  let inString = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (esc) { esc = false; out += ch; continue; }
    if (ch === "\\") { esc = true; out += ch; continue; }
    if (ch === '"') { inString = false; out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\t") out += "\\t";
      // \r and other control chars are dropped
      continue;
    }
    out += ch;
  }
  return out;
}

/** Non-structural token cleanups (trailing commas, NaN, HTML entities). */
function fixCommonIssues(s) {
  return s
    .replace(/,\s*([}\]])/g, "$1")          // trailing commas
    .replace(/:\s*NaN\b/g, ": null")        // NaN → null
    .replace(/:\s*Infinity\b/g, ": null")
    .replace(/:\s*-Infinity\b/g, ": null")
    // &quot; → \" (an escaped quote): substituting a bare `"` would
    // terminate the surrounding JSON string.
    .replace(/&quot;/g, '\\"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * Heuristic for callLLM's truncation-retry ladder: does this text look like
 * JSON that was cut off mid-output? Parse-checks first (parseable output is
 * never truncated), then consults the string-aware scanner — open structures
 * at EOF mean either a genuine cut or a quote-desync; both are worth one
 * cheap retry at the transport layer before any stage sees the text.
 */
export function looksTruncatedJSON(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return false;
  try { JSON.parse(raw.slice(start)); return false; } catch (_e) { /* keep checking */ }
  const scan = scanStructure(raw, start);
  return scan.end < 0 && (scan.stack.length > 0 || scan.inString);
}

/**
 * @param {string} raw    LLM output text
 * @param {object} [meta] optional provenance from the callLLM result —
 *        { stopReason, truncated, _truncationRetries, maxTokensRequested,
 *          truncationCause } — folded into the TRUNCATED error so failures
 *        are diagnosable (which limit cut the output, how many recovery
 *        retries already ran, and whether raising Max Tokens can even help).
 *        Nodes pass the whole callLLM result: extractJSON(r.text, r).
 */
export function extractJSON(raw, meta) {
  if (!raw || typeof raw !== "string") {
    throw new Error("JSON parse failed: empty or non-string input (got " + typeof raw + ")");
  }

  function tryParse(str, reason) {
    try { return { ok: true, val: JSON.parse(str) }; }
    catch (e) { return { ok: false, err: e.message, reason: reason }; }
  }

  // 1. Direct parse (ideal case)
  const r1 = tryParse(raw, "direct");
  if (r1.ok) return r1.val;

  // 2. Strip markdown code fences
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const r2 = tryParse(fenced[1].trim(), "fenced");
    if (r2.ok) return r2.val;
  }

  // 3. String-aware structural scan from the outermost '{'
  const start = raw.indexOf("{");
  let lastErr = r1;
  if (start >= 0) {
    let scan = scanStructure(raw, start);
    let working = raw;

    // 3a. Quote-desync rescue. An unbalanced scan does NOT yet mean
    // truncation: one unescaped inner quote produces the same signature on
    // COMPLETE output. Repair quotes and rescan — if the structure closes
    // now, this was a formatting defect, not a cut.
    if (scan.end < 0) {
      const requoted = escapeInnerQuotes(raw.slice(start));
      const rescue = scanStructure(requoted, 0);
      if (rescue.end >= 0) {
        working = raw.slice(0, start) + requoted;
        scan = { end: start + rescue.end, stack: [], inString: false, open: rescue.open, close: rescue.close };
      }
    }

    if (scan.end > start) {
      const candidate = working.slice(start, scan.end + 1);
      const r3 = tryParse(candidate, "brace-balanced");
      if (r3.ok) return r3.val;
      lastErr = r3;

      // 4. Repair ladder: token cleanups, then in-string control characters,
      // then inner quotes (in case the slice parses only after re-quoting).
      const fixed = escapeCtrlInStrings(fixCommonIssues(candidate));
      const r4 = tryParse(fixed, "fixed-common-issues");
      if (r4.ok) return r4.val;
      lastErr = r4;

      const requotedFix = escapeCtrlInStrings(fixCommonIssues(escapeInnerQuotes(candidate)));
      const r4b = tryParse(requotedFix, "inner-quote-repair");
      if (r4b.ok) return r4b.val;
      lastErr = r4b;
    } else {
      // The structure never closes, even after quote repair → genuinely
      // incomplete output. Build the evidence before throwing:
      //
      // Prefix verification: append the closers the scanner says are still
      // open (closing quote first if EOF landed inside a string). If the
      // result parses, the text is a valid JSON PREFIX — proof of a real
      // mid-generation cut rather than malformed syntax.
      const closers = (scan.inString ? '"' : "")
        + scan.stack.slice().reverse().map(function(b) { return b === "{" ? "}" : "]"; }).join("");
      const closed = escapeCtrlInStrings(fixCommonIssues(raw.slice(start) + closers));
      const isVerifiedPrefix = tryParse(closed, "close-and-parse").ok;

      // Cause-aware advice. callLLM's truncation-retry ladder runs BEFORE
      // this error can fire, so reaching here means recovery was exhausted —
      // the advice must point at whatever is actually binding:
      //   provider-limit — doubling max_tokens didn't lengthen the output,
      //     so the SERVER is clamping (model context window exhausted, or a
      //     server-side output cap, e.g. LM Studio's Context Length).
      //   otherwise — the per-stage cap genuinely ran out.
      const m = meta || {};
      const provenance =
        " [stop reason: " + (m.stopReason || "unreported")
        + (m.maxTokensRequested != null ? "; maxTokens requested: " + m.maxTokensRequested : "")
        + (m._truncationRetries ? "; auto-recovery retries already attempted: " + m._truncationRetries : "")
        + "]";
      const advice = m.truncationCause === "provider-limit"
        ? "Raising Max Tokens will NOT help: retrying with a larger cap did not " +
          "lengthen the output, so the model's context window or the server's own " +
          "output limit is the binding constraint. Increase the model's context " +
          "length (LM Studio: Context Length; Ollama: num_ctx) or shorten the " +
          "prompt (fewer requirements / smaller spec). "
        : "Try increasing Max Tokens for this stage in Settings → Per-Stage Settings. ";
      throw new Error(
        "JSON parse failed: TRUNCATED OUTPUT — " + scan.stack.length
        + " unclosed structure(s) at end of output ("
        + scan.open + " opening vs " + scan.close + " closing braces, strings excluded). "
        + (scan.inString
          ? "The output ends INSIDE a string value — a classic mid-generation cut. "
          : "The output ends between tokens. ")
        + (isVerifiedPrefix
          ? "Verified: the text parses once the open structures are closed, so this is a "
            + "genuine truncation, not a formatting problem. "
          : "")
        + "The LLM output was cut off." + provenance + " " + advice
        + "Raw length: " + raw.length + " chars. First 300 chars: " + raw.slice(0, 300)
        + " … Last 200 chars: " + raw.slice(-200)
      );
    }
  }

  // 5. Last resort: try to parse from [ for array responses
  const arrStart = raw.indexOf("[");
  if (arrStart >= 0) {
    const arrEnd = raw.lastIndexOf("]");
    if (arrEnd > arrStart) {
      const r5 = tryParse(raw.slice(arrStart, arrEnd + 1), "array-extract");
      if (r5.ok) return r5.val;
    }
  }

  // Build detailed diagnostic. Reaching here with balanced braces means the
  // output is NOT truncated — it's malformed in some other way, and saying
  // "truncated" would send the user to tune token limits for nothing.
  const snippet = raw.slice(0, 500);
  const diag = [];
  if (!raw.includes("{")) diag.push("No '{' found in output — LLM may have returned prose instead of JSON");
  else if (lastErr) diag.push("Best parse attempt (" + lastErr.reason + ") failed: " + lastErr.err);
  if (raw.length < 20) diag.push("Output suspiciously short (" + raw.length + " chars) — LLM may have returned an error or empty response");
  if (raw.length > 3000 && raw.lastIndexOf("}") < raw.length - 100) diag.push("Output appears truncated — last '}' is far from end, likely hit max_tokens");
  if (raw.includes("```")) diag.push("Output contains code fences — LLM returned markdown instead of raw JSON");
  if (/^[A-Z]/.test(raw.trim())) diag.push("Output starts with prose text — LLM ignored the JSON-only instruction");

  throw new Error(
    "JSON parse failed. " + (diag.length > 0 ? "DIAGNOSIS: " + diag.join("; ") + ". " : "") +
    "Raw (" + raw.length + " chars): " + snippet +
    (raw.length > 500 ? " … Last 200 chars: " + raw.slice(-200) : "")
  );
}

/**
 * If a previous run had a JSON parse error, append a format reminder to the prompt.
 * Returns the modified prompt object (mutates in place for backward compat).
 */
export function addRetryHint(promptObj, lastError) {
  if (!lastError || typeof lastError !== "string") return promptObj;
  if (lastError.toLowerCase().indexOf("json parse") < 0 && lastError.toLowerCase().indexOf("truncated") < 0) {
    return promptObj;
  }
  const hint = "\n\n⚠ RETRY CONTEXT — the previous attempt failed with this error:\n" +
    lastError.substring(0, 500) + "\n\n" +
    "CRITICAL FORMATTING RULES FOR THIS RETRY:\n" +
    "• You MUST respond with ONLY valid JSON — no prose, no markdown fences, no explanation.\n" +
    "• If the previous error mentions TRUNCATION, produce a shorter response. Summarise long descriptions.\n" +
    "• If the previous error mentions brace mismatch, double-check every { has a matching }.\n" +
    "• Use \\n for newlines inside JSON strings — never embed literal newlines.\n" +
    "• Escape every double quote inside string values as \\\" — unescaped inner quotes corrupt the JSON.\n" +
    "• Validate your JSON output mentally before emitting it.";
  promptObj.userMessage = (promptObj.userMessage || "") + hint;
  return promptObj;
}
