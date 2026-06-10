// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// extractJSON — Robust JSON extraction from LLM output
// Tries direct parse → fenced code → brace-balanced → fix common issues → array
// Provides detailed diagnostics on failure for retry hints.
// ═══════════════════════════════════════════════════════════════════════════

export function extractJSON(raw) {
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
      throw new Error(
        "JSON parse failed: TRUNCATED OUTPUT — found " + openCount + " opening braces but only " +
        closeCount + " closing braces. The LLM output was cut off (likely hit max_tokens limit). " +
        "Try increasing Max Tokens for this stage in Settings → Per-Stage Settings. " +
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
