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
 *
 * Refinement (third observed defect class): models emitting code-in-JSON
 * sometimes leave a SHORT punctuation run between the closing quote and the
 * structural char — e.g. `"code":"…sum));")},` where a stray `)` sits after
 * the close. Naively that quote looks "inner" (next char isn't structural),
 * and escaping it swallows the rest of the object into the string —
 * amplifying a 1-character defect into a whole-stage parse failure. So:
 * when the run between the quote and the next structural char is short pure
 * punctuation (no letters/digits/quotes/braces), treat the quote as CLOSING
 * and DROP the junk. Real inner quotes always have words after them.
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
        continue;
      }
      // Junk-after-close check: collect the run up to the next structural
      // char; a short punctuation-only run means the quote DID close the
      // string and the run is model garbage to drop.
      let k = i + 1;
      while (k < s.length && s[k] !== "," && s[k] !== ":" && s[k] !== "}"
             && s[k] !== "]" && s[k] !== '"') k++;
      const run = s.slice(i + 1, k);
      if (k < s.length && s[k] !== '"' && run.length <= 4 && /^[)(;.\s]*$/.test(run)) {
        inString = false;
        out += ch;                // keep the closing quote…
        i = k - 1;                // …skip the junk; loop resumes at structural char
        continue;
      }
      out += '\\"';               // inner quote — escape, stay in string
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Context-aware string-value re-encoder — the strongest salvage tier.
 *
 * Unlike escapeInnerQuotes (which decides a quote is "closing" purely from the
 * NEXT char), this walks the JSON as a tokenizer that knows whether each string
 * is an object KEY or a VALUE, and disambiguates the two cases that defeat the
 * simpler heuristic on code-in-JSON:
 *
 *   {"code":"… $display(\"x = %d\", x); … sel ? \"a\" : \"b\" …"}
 *
 * Here an inner SystemVerilog string's closing quote is followed by `,` (the
 * `"x", x` pattern) or `:` (a `"a" : "b"` ternary) — exactly the chars the local
 * heuristic reads as "this string ended". Knowing position (value vs key) plus a
 * lookahead past `,` (a real value-comma is followed by a new KEY in objects / a
 * VALUE in arrays) recovers these. Inner quotes and control chars inside values
 * are escaped; structure is preserved. Flaky local models (gpt-oss et al.) emit
 * this constantly; without this tier their RTL/TB-fix replies fail the stage.
 */
function salvageStringValues(s) {
  let out = "";
  let i = 0;
  const n = s.length;
  const ctx = [];            // stack of "{" / "[" — current structural container
  let expectKey = false;     // true when the next string is an object key
  let expectValue = false;   // true when the next token is a value (after ':' / '[' / array ',')
  const isWs = function (c) { return c === " " || c === "\t" || c === "\n" || c === "\r"; };

  // s[q] === '"'. Decide whether it truly terminates a string opened as a KEY
  // or a VALUE, using the structural lookahead described above.
  function closesHere(q, isKey) {
    let k = q + 1;
    while (k < n && isWs(s[k])) k++;
    const nxt = k < n ? s[k] : "";
    if (isKey) return nxt === ":";                      // a key closes only before ':'
    if (nxt === "" || nxt === "}" || nxt === "]") return true;
    if (nxt === ":") return false;                      // a VALUE is never followed by ':' → inner (ternary)
    if (nxt !== ",") return false;                      // followed by text → inner quote
    // `",` is ambiguous. Peek past the comma at the next token.
    let p = k + 1;
    while (p < n && isWs(s[p])) p++;
    const after = p < n ? s[p] : "";
    if (ctx[ctx.length - 1] === "[") {
      // array: a real next value starts with a string/object/array/number/literal
      return after === '"' || after === "{" || after === "[" || after === "-"
        || (after >= "0" && after <= "9") || after === "t" || after === "f" || after === "n";
    }
    // object: the next token must be a key — a string immediately before ':'
    if (after !== '"') return false;
    let r = p + 1;
    while (r < n) { if (s[r] === "\\") { r += 2; continue; } if (s[r] === '"') break; r++; }
    let t = r + 1;
    while (t < n && isWs(s[t])) t++;
    return s[t] === ":";
  }

  while (i < n) {
    const ch = s[i];
    if (isWs(ch)) { out += ch; i++; continue; }
    if (ch === "{") { out += ch; ctx.push("{"); expectKey = true; expectValue = false; i++; continue; }
    if (ch === "[") { out += ch; ctx.push("["); expectKey = false; expectValue = true; i++; continue; }
    if (ch === "}" || ch === "]") { out += ch; ctx.pop(); expectKey = false; expectValue = false; i++; continue; }
    if (ch === ":") { out += ch; expectKey = false; expectValue = true; i++; continue; }
    if (ch === ",") {
      out += ch;
      const inObj = ctx[ctx.length - 1] === "{";
      expectKey = inObj; expectValue = !inObj;
      i++; continue;
    }
    // Bareword in VALUE position — flaky models emit Python literals or plain
    // words where JSON needs a quoted string / number ({"line": sixty},
    // {"ok": True}, {"x": NaN}). Coerce so the rest of the object still parses.
    // Gated on expectValue so unquoted KEYS are left to fail (a deliberate
    // diagnostic, pinned by an existing test).
    if (expectValue && /[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j);
      const lw = word.toLowerCase();
      if (word === "true" || word === "false" || word === "null") out += word;
      else if (lw === "true") out += "true";
      else if (lw === "false") out += "false";
      else if (lw === "none" || lw === "null" || lw === "nil") out += "null";
      else if (lw === "nan" || lw === "infinity") out += "null";
      else out += JSON.stringify(word);   // unknown bareword → quote it
      i = j;
      expectValue = false;
      continue;
    }
    if (ch === '"') {
      const isKey = expectKey;
      let content = "";
      let j = i + 1;
      while (j < n) {
        const cj = s[j];
        if (cj === "\\") {
          // Preserve a valid JSON escape; an invalid/lone backslash (e.g. a
          // SystemVerilog line-continuation `\<newline>`) is itself escaped so
          // the result stays valid JSON.
          const next = j + 1 < n ? s[j + 1] : "";
          if (next && "\"\\/bfnrtu".indexOf(next) >= 0) { content += "\\" + next; j += 2; }
          else { content += "\\\\"; j++; }
          continue;
        }
        if (cj === '"') {
          if (closesHere(j, isKey)) break;
          content += '\\"';                              // inner quote → escape, keep reading
          j++;
          continue;
        }
        const code = cj.charCodeAt(0);
        if (code < 0x20) {
          if (cj === "\n") content += "\\n";
          else if (cj === "\t") content += "\\t";
          else if (cj === "\r") content += "\\r";
          // other control chars dropped
          j++;
          continue;
        }
        content += cj;
        j++;
      }
      out += '"' + content + '"';
      i = j + 1;                                         // skip the closing quote (or EOF)
      if (!isKey) expectKey = false;
      expectValue = false;                               // a value (or key) was consumed
      continue;
    }
    // Numbers / already-valid literals / stray punctuation — pass through. A
    // number/literal here consumes the pending value slot.
    out += ch;
    expectValue = false;
    i++;
  }
  return out;
}

/**
 * Strongest recovery: re-encode string values with full key/value awareness,
 * then find the balanced end on the CLEANED text (inner quotes now escaped, so
 * the structural scanner no longer desyncs) and parse. Returns {ok, val|err}.
 */
function trySalvage(raw, start) {
  const salv = salvageStringValues(raw.slice(start));
  const sc = scanStructure(salv, 0);
  const sliced = sc.end >= 0 ? salv.slice(0, sc.end + 1) : salv;
  try { return { ok: true, val: JSON.parse(fixCommonIssues(sliced)) }; }
  catch (e) { return { ok: false, err: e.message }; }
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

// ═══════════════════════════════════════════════════════════════════════════
// Tool-call markup salvage (measured: run 39, laguna-s-2.1)
//
// laguna returned a COMPLETE module whose JSON terminated like this:
//
//   {"code":"`timescale ... endmodule // restoring_divider</arg_value>}
//
// The model wrapped its answer in tool-call markup and emitted `</arg_value>`
// where the closing quote belonged. Every downstream check then read an
// unterminated string and reported TRUNCATED OUTPUT — with a "verified prefix"
// note, because closing the structures does make it parse. The diagnosis was
// wrong and a finished 4220-char module was thrown away, costing the stage 33
// minutes. (Related to the thinking-channel leakage behind ab7de04/b40d225;
// this is the same model emitting a different channel's framing.)
//
// The tag's INTENT is ambiguous — it may stand in for the terminator the model
// failed to emit, or be pure markup around a value that is otherwise intact —
// so rather than guess, both readings are offered to the parser and the first
// that parses wins. Applied only after a direct parse has already failed, so
// output that is legitimately valid is never touched.
// ═══════════════════════════════════════════════════════════════════════════
const TOOL_MARKUP_TAG =
  /<\/?(?:arg_value|arg_key|parameter|parameters|tool_call|function_call|invoke|antml:parameter|antml:invoke)(?:\s[^>]*)?>/g;

export function toolMarkupVariants(text) {
  if (!text || typeof text !== "string" || text.indexOf("<") < 0) return [];
  const out = [];
  const asQuote = text.replace(TOOL_MARKUP_TAG, '"');   // tag stood in for the terminator
  const removed = text.replace(TOOL_MARKUP_TAG, "");    // tag was pure framing
  if (asQuote !== text) out.push(asQuote);
  if (removed !== text && removed !== asQuote) out.push(removed);
  return out;
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

  // 2b. Tool-call markup salvage (run 39). Try each reading of the wrapper
  // tags, both whole and brace-sliced, before any structural conclusion — a
  // stray `</arg_value>` must not be diagnosed as a mid-generation cut.
  for (const variant of toolMarkupVariants(raw)) {
    const rv = tryParse(variant.trim(), "tool-markup");
    if (rv.ok) return rv.val;
    const vStart = variant.indexOf("{");
    if (vStart >= 0) {
      const vScan = scanStructure(variant, vStart);
      if (vScan.end > vStart) {
        const rvs = tryParse(variant.slice(vStart, vScan.end + 1), "tool-markup-slice");
        if (rvs.ok) return rvs.val;
      }
    }
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

      // 4c. Context-aware string-value salvage — recovers code-in-JSON whose
      // inner quotes the simpler repairs mis-segment (`$display("x", y)`,
      // ternary string literals). Re-scans from `start` on the CLEANED text so
      // a quote-desynced earlier scan.end can't truncate the candidate.
      const r4c = trySalvage(raw, start);
      if (r4c.ok) return r4c.val;
      lastErr = { ok: false, err: r4c.err, reason: "string-value-salvage" };
    } else {
      // Before declaring truncation, try the strongest salvage: an unbalanced
      // scan can also come from inner quotes that escapeInnerQuotes mis-handled
      // (the `",`/`":` code patterns), which leave the structure looking open.
      // Context-aware re-encoding closes it if the output was actually complete.
      const svRescue = trySalvage(raw, start);
      if (svRescue.ok) return svRescue.val;

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
