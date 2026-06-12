// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// extractJSON — Robust JSON extraction from LLM output
// Tries direct parse → fenced code → brace-balanced → fix common issues → array
// Provides detailed diagnostics on failure for retry hints.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Heuristic: does this text look like JSON that was cut off mid-output?
 * (More '{' than '}' from the first '{' onward — the same signal the
 * TRUNCATED OUTPUT error below reports.)
 *
 * Exported so callLLM's truncation-retry ladder can use it as a BACKSTOP
 * when a provider/proxy fails to report a stop reason: catching the cut at
 * the transport layer lets the call be retried with a raised token cap
 * BEFORE any stage sees broken JSON. Naive counting (braces inside strings
 * count too) is intentional — it matches the detector below, and as a
 * trigger for "retry with more tokens" a rare false positive only costs one
 * extra call.
 */
export function looksTruncatedJSON(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return false;
  // Parseable output is never "truncated", whatever the brace count says —
  // braces inside string values (e.g. SV concatenations in {"code": …})
  // would otherwise false-positive.
  try { JSON.parse(raw.slice(start)); return false; } catch (_e) { /* keep checking */ }
  let open = 0;
  let close = 0;
  for (let j = start; j < raw.length; j++) {
    if (raw[j] === "{") open++;
    if (raw[j] === "}") close++;
  }
  return open > close;
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

  // 3. Find the outermost { ... } with brace balancing
  const start = raw.indexOf("{");
  let lastErr = r1;
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }

    if (end > start) {
      const candidate = raw.slice(start, end + 1);
      const r3 = tryParse(candidate, "brace-balanced");
      if (r3.ok) return r3.val;
      lastErr = r3;

      // 4. Try fixing common LLM issues. Note &quot; → \" (an escaped quote):
      //    substituting a bare `"` would terminate the surrounding JSON string.
      const fixed = candidate
        .replace(/,\s*([}\]])/g, "$1")          // trailing commas
        .replace(/:\s*NaN\b/g, ": null")        // NaN → null
        .replace(/:\s*Infinity\b/g, ": null")
        .replace(/:\s*-Infinity\b/g, ": null")
        .replace(/&quot;/g, '\\"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/[\x00-\x1f]/g, (c) => {
          if (c === "\n") return "\\n";
          if (c === "\r") return "";
          if (c === "\t") return "\\t";
          return "";
        });
      const r4 = tryParse(fixed, "fixed-common-issues");
      if (r4.ok) return r4.val;
      lastErr = r4;
    } else {
      // Braces never balanced — likely truncated
      let openCount = 0, closeCount = 0;
      for (let j = start; j < raw.length; j++) {
        if (raw[j] === "{") openCount++;
        if (raw[j] === "}") closeCount++;
      }
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
        "JSON parse failed: TRUNCATED OUTPUT — found " + openCount + " opening braces but only " +
        closeCount + " closing braces. The LLM output was cut off." + provenance + " " +
        advice +
        "Raw length: " + raw.length + " chars. First 300 chars: " + raw.slice(0, 300)
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

  // Build detailed diagnostic
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
    "Raw (" + raw.length + " chars): " + snippet
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
    "• Validate your JSON output mentally before emitting it.";
  promptObj.userMessage = (promptObj.userMessage || "") + hint;
  return promptObj;
}
