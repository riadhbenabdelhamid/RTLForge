// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// sse — Server-Sent Events stream reader for LLM streaming responses
// Used by Anthropic and OpenAI/Groq adapters.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read an SSE response stream, calling onEvent for each parsed JSON payload.
 * Honors AbortSignal — throws AbortError if signal becomes aborted.
 */
export async function readSSE(response, onEvent, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // cancel() returns a PROMISE. When the underlying socket dies later
  // (read ETIMEDOUT → undici "TypeError: terminated"), that promise rejects
  // asynchronously — a sync try/catch around the call cannot see it, and the
  // unhandled rejection kills the whole Node process (measured: crashed a
  // live CLI system run). Always attach a no-op catch.
  const cancelQuietly = () => { try { reader.cancel().catch(() => {}); } catch (_) {} };
  try {
    while (true) {
      if (signal && signal.aborted) {
        cancelQuietly();
        throw new DOMException("Aborted", "AbortError");
      }
      const result = await reader.read();
      if (result.done) break;
      if (signal && signal.aborted) {
        cancelQuietly();
        throw new DOMException("Aborted", "AbortError");
      }
      buf += decoder.decode(result.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try { onEvent(JSON.parse(payload)); } catch (e) { /* skip bad JSON */ }
        }
      }
    }
  } catch (e) {
    cancelQuietly();
    throw e;
  }
}
