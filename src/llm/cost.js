// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// cost — Per-provider token cost estimation
// Rates in USD per million tokens. Update as providers change pricing.
// ═══════════════════════════════════════════════════════════════════════════

const RATES = {
  anthropic: { i: 3,    o: 15   },
  openai:    { i: 2.5,  o: 10   },
  groq:      { i: 0.59, o: 0.79 },
  ollama:    { i: 0,    o: 0    },
  lmstudio:  { i: 0,    o: 0    },
};

export function estimateCost(tokensIn, tokensOut, provider) {
  const r = RATES[provider] || RATES.anthropic;
  return (tokensIn * r.i + tokensOut * r.o) / 1e6;
}

export function getRates() {
  return Object.assign({}, RATES);
}
