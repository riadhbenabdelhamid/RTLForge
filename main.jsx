// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// main.jsx — Vite entry point for RTL Forge v6
//
// Usage:
//   npm install
//   npm run dev      → opens http://localhost:5173
//   npm run build    → static output in dist/
//
// This file wires the LLM transport layer (callLLM, extractJSON, etc.)
// into the useProject hook via React context, then mounts RTLForge as
// the root component.
//
// By default it uses the built-in callLLM which supports:
//   - Anthropic (Claude) via API key
//   - OpenAI (GPT-4) via API key
//   - LM Studio (local) via localhost
//
// To swap in a custom LLM transport (e.g. your own proxy), replace the
// imports below with your own callLLM implementation that matches the
// same signature: ({ systemPrompt, userMessage, maxTokens, config }) →
// Promise<{ text, provider, model, tokensIn, tokensOut, latencyMs }>
// ═══════════════════════════════════════════════════════════════════════════

import { StrictMode, Component } from "react";
import { createRoot } from "react-dom/client";
import RTLForge from "./src/react/components/RTLForge.jsx";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    console.error("[RTL Forge] Render crash:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 40, fontFamily: "monospace", color: "#f87171",
          background: "#06090f", minHeight: "100vh",
        }}>
          <h1 style={{ color: "#00ffb4", fontFamily: "Outfit, sans-serif" }}>RTL Forge — Render Error</h1>
          <pre style={{
            background: "#111827", padding: 20, borderRadius: 8,
            border: "1px solid #1e2a3a", overflow: "auto", fontSize: 13,
            lineHeight: 1.6, whiteSpace: "pre-wrap",
          }}>
            {this.state.error.toString()}
            {"\n\n"}
            {this.state.info && this.state.info.componentStack}
          </pre>
          <p style={{ color: "#9ca3af", fontSize: 13, marginTop: 16 }}>
            Check the browser console (F12) for the full stack trace.
          </p>
          <button
            onClick={() => { this.setState({ error: null, info: null }); }}
            style={{
              marginTop: 12, padding: "8px 20px", background: "#00ffb4",
              color: "#06090f", border: "none", borderRadius: 6,
              fontWeight: 700, cursor: "pointer", fontSize: 13,
            }}
          >
            ↻ Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <RTLForge />
    </ErrorBoundary>
  </StrictMode>
);
