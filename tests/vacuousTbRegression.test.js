// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// The guards, pinned against a REAL non-discriminating testbench.
//
// tests/fixtures/tb/run46_vacuous_sha256_tb.sv is what a local model actually
// produced for the SHA-256 spec in run 46 leg B, captured verbatim from the
// checkpoint. Its checks mention DUT signals and still measure almost
// nothing: a condition that is always false, inequalities that admit every
// value but one, and not one of the published digests the spec named as the
// correctness check.
//
// Synthetic fixtures drift toward what the guard already catches. This one
// cannot: it is the artifact that motivated the guard, so a future change
// that weakens the analysis shows up here immediately.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { analyzeCheckCoverage } from "../src/pipeline/tbCheckCoverage.js";

const TB = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "tb", "run46_vacuous_sha256_tb.sv"), "utf8");

describe("run 46's vacuous testbench stays rejected", () => {
  const cov = analyzeCheckCoverage(TB);

  it("is recognisably a testbench with checks, so the analysis really ran", () => {
    expect(TB).toMatch(/module\s+\w*_tb\b/);
    expect(cov.total).toBeGreaterThan(5);
  });

  it("catches the always-false condition", () => {
    const always = cov.constantChecks.map((c) => c.always);
    expect(always).toContain("false");
    expect(cov.constantChecks.some((c) => /isunknown/i.test(c.cond))).toBe(true);
  });

  it("reports the inequality-against-literal checks as weak", () => {
    expect(cov.weakChecks.length).toBeGreaterThan(0);
    expect(cov.weakChecks.map((w) => w.kind)).toContain("inequality-against-literal");
  });

  it("leaves at least one requirement with nothing that verifies it", () => {
    expect(cov.unverifiedReqs.length).toBeGreaterThan(0);
  });

  it("checks at most the top 32 bits of ONE published digest", () => {
    // Recorded precisely, because the shape matters more than the headline.
    // Its own fix loop did add a published value — the empty-string digest —
    // but only compares digest[255:224] against its first 32 bits. The other
    // vectors the spec named are absent, and no check ever compares a full
    // 256-bit digest. That is a partial oracle, not the absence of one, and
    // the distinction is what a future reader needs.
    const lower = TB.toLowerCase();
    expect(lower).toContain("e3b0c442");                 // empty-string, first word
    expect(lower).not.toContain("ba7816bf");             // "abc" — absent
    expect(lower).not.toContain("248d6a61");             // two-block — absent
    // Sharper still: the FULL digest is present, but only in a comment —
    // the model wrote the whole value down and then checked a quarter of it.
    expect(lower).toMatch(/\/\/[^\n]*e3b0c44298fc1c14/);
    // and no check ever compares a full-width digest constant
    expect(lower).not.toMatch(/256'h[0-9a-f_]{40,}/);
    const checkedWidths = [...TB.matchAll(/check_eq\s*\(\s*(\d+)'h/g)].map((m) => Number(m[1]));
    expect(checkedWidths.length).toBeGreaterThan(0);
    expect(Math.max(...checkedWidths)).toBeLessThanOrEqual(32);
  });
});

describe("a competent testbench is NOT flagged by the same analysis", () => {
  // The other half of the pin: the guards must stay quiet on the testbench
  // that scored 60/60 against those same published digests.
  const goodDir = path.join(process.cwd(), "tests", "fixtures", "runs", "run45", "answers");
  let good = null;
  if (fs.existsSync(goodDir)) {
    for (const f of fs.readdirSync(goodDir)) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(goodDir, f), "utf8"));
        if (j.code && /REQ-TIME-003\.4/.test(j.code)) good = j.code;
      } catch (e) { /* not a JSON answer */ }
    }
  }

  it.skipIf(!good)("has no constant conditions and no unverified requirements", () => {
    const cov = analyzeCheckCoverage(good);
    expect(cov.constantChecks).toEqual([]);
    expect(cov.unverifiedReqs).toEqual([]);
    expect(cov.total).toBeGreaterThan(50);
  });

  it.skipIf(!good)("does cite the published digests", () => {
    expect(good.toLowerCase()).toContain("ba7816bf");
    expect(good.toLowerCase()).toContain("248d6a61");
  });
});
