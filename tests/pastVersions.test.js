// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Tests for src/utils/pastVersions.js
//
// Pin the snapshot collection: each source produces an entry with the right
// (stepId, iter, code) metadata, ordering is consistent, and missing data
// is handled cleanly.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { collectRTLSnapshots, collectTBSnapshots } from "../src/utils/pastVersions.js";

describe("collectRTLSnapshots", function() {
  it("returns empty for empty/null stageData", function() {
    expect(collectRTLSnapshots(null)).toEqual([]);
    expect(collectRTLSnapshots({})).toEqual([]);
    expect(collectRTLSnapshots(undefined)).toEqual([]);
  });

  it("captures the original RTL Gen code when no fixes have been applied", function() {
    const stageData = {
      4: { code: "module foo;\nendmodule" },
    };
    const snaps = collectRTLSnapshots(stageData);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].stepId).toBe(4);
    expect(snaps[0].iter).toBe(0);
    expect(snaps[0].code).toBe("module foo;\nendmodule");
    expect(snaps[0].kind).toBe("rtl");
    expect(snaps[0].label).toMatch(/RTL Gen — original/);
  });

  it("prefers _originalCode over .code when fixes have been applied", function() {
    const stageData = {
      4: {
        code: "module foo;\n  // fixed\nendmodule",
        _originalCode: "module foo;\nendmodule",
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    expect(snaps).toHaveLength(1);
    // Original is what was BEFORE any fix
    expect(snaps[0].code).toBe("module foo;\nendmodule");
  });

  it("includes lint (id 6) per-iteration afterCode", function() {
    const stageData = {
      4: { code: "module foo;\n// post lint\nendmodule" },
      6: {
        iterations: [
          { iter: 1, _structured: { afterCode: "module foo;\n// after iter 1\nendmodule" } },
          { iter: 2, _structured: { afterCode: "module foo;\n// after iter 2\nendmodule" } },
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    // 1 from rtl_generate + 2 from lint = 3 total
    expect(snaps).toHaveLength(3);
    expect(snaps[1].stepId).toBe(6);
    expect(snaps[1].iter).toBe(1);
    expect(snaps[1].code).toBe("module foo;\n// after iter 1\nendmodule");
    expect(snaps[2].iter).toBe(2);
  });

  it("ignores lint iterations without _structured.afterCode", function() {
    const stageData = {
      4: { code: "x" },
      6: {
        iterations: [
          { iter: 1 },                                                // no _structured
          { iter: 2, _structured: { parsed: null } },                 // no afterCode
          { iter: 3, _structured: { afterCode: "module x; endmodule" } },
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    // 1 from rtl_generate + 1 valid lint = 2
    expect(snaps).toHaveLength(2);
    expect(snaps[1].iter).toBe(3);
  });

  it("includes rtl_review (id 10) iterations", function() {
    const stageData = {
      4: { code: "x" },
      10: {
        _iterations: [
          { iter: 2, _structured: { afterCode: "module x;\n// review fix\nendmodule" } },
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    expect(snaps).toHaveLength(2);
    expect(snaps[1].stepId).toBe(10);
    expect(snaps[1].label).toMatch(/RTL Review — iter 2/);
  });

  it("includes verify (id 8) RTL fixes (rtlFix subfield), NOT tbFix", function() {
    const stageData = {
      4: { code: "x" },
      8: {
        verifyHistory: [
          {
            iter: 1,
            _structured: {
              rtlFix: { afterCode: "module x;\n// verify rtl fix\nendmodule" },
              tbFix:  { afterCode: "module x_tb;\n// verify tb fix\nendmodule" },
            },
          },
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    expect(snaps).toHaveLength(2);
    // The verify entry should be the rtlFix afterCode, not the tbFix
    expect(snaps[1].code).toContain("verify rtl fix");
    expect(snaps[1].code).not.toContain("verify tb fix");
    expect(snaps[1].label).toMatch(/Verify — iter 1 \(RTL fix\)/);
  });

  it("orders snapshots: rtl_generate → lint → rtl_review → verify (chronological)", function() {
    const stageData = {
      4:  { code: "v0" },
      6:  { iterations: [{ iter: 1, _structured: { afterCode: "v1-lint" } }] },
      10: { _iterations: [{ iter: 1, _structured: { afterCode: "v2-review" } }] },
      8:  { verifyHistory: [{ iter: 1, _structured: { rtlFix: { afterCode: "v3-verify" } } }] },
    };
    const snaps = collectRTLSnapshots(stageData);
    expect(snaps.map(function(s) { return s.code; })).toEqual([
      "v0", "v1-lint", "v2-review", "v3-verify",
    ]);
  });
});

describe("collectTBSnapshots", function() {
  it("captures Test Gen original + lint_test + test_review + verify tbFix", function() {
    const stageData = {
      7:  { code: "tb-original" },
      12: { iterations: [{ iter: 1, _structured: { afterCode: "tb-lint-fix" } }] },
      11: { _iterations: [{ iter: 1, _structured: { afterCode: "tb-review-fix" } }] },
      8:  {
        verifyHistory: [
          {
            iter: 1,
            _structured: {
              rtlFix: { afterCode: "rtl-fix-not-this" },
              tbFix:  { afterCode: "tb-verify-fix" },
            },
          },
        ],
      },
    };
    const snaps = collectTBSnapshots(stageData);
    expect(snaps.map(function(s) { return s.code; })).toEqual([
      "tb-original", "tb-lint-fix", "tb-review-fix", "tb-verify-fix",
    ]);
    // Each snap should have kind "tb", not "rtl"
    snaps.forEach(function(s) { expect(s.kind).toBe("tb"); });
  });

  it("does NOT pick up RTL fixes from verify (rtlFix), only tbFix", function() {
    const stageData = {
      7: { code: "tb" },
      8: {
        verifyHistory: [
          { iter: 1, _structured: { rtlFix: { afterCode: "should not appear" } } },
        ],
      },
    };
    const snaps = collectTBSnapshots(stageData);
    // Only the rtl_generate original, no verify entry (no tbFix)
    expect(snaps).toHaveLength(1);
    expect(snaps[0].code).toBe("tb");
  });

  it("each snapshot has lineCount populated", function() {
    const stageData = {
      7: { code: "line1\nline2\nline3" },
    };
    const snaps = collectTBSnapshots(stageData);
    expect(snaps[0].lineCount).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group D1 (v20): judge per-iteration regen snapshots in the compare list.
// ═══════════════════════════════════════════════════════════════════════════
describe("collectRTLSnapshots — judge regen entries (Group D1)", function() {
  it("includes judge.judgeHistory[]._structured.rtlRegen.afterCode entries", function() {
    const stageData = {
      4: { code: "module post_judge; endmodule" },
      9: {
        judgeHistory: [
          {
            iter: 1,
            _structured: {
              rtlRegen: { afterCode: "module rtl_regen_v1; endmodule" },
              tbRegen:  { afterCode: "module tb_regen_v1; endmodule" },
            },
          },
          {
            iter: 2,
            _structured: {
              rtlRegen: { afterCode: "module rtl_regen_v2; endmodule" },
            },
          },
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    // 1 (rtl_generate original) + 2 (judge iter 1 + iter 2 RTL regen) = 3
    expect(snaps).toHaveLength(3);
    expect(snaps[1].stepId).toBe(9);
    expect(snaps[1].iter).toBe(1);
    expect(snaps[1].label).toMatch(/Judge — iter 1 \(RTL regen\)/);
    expect(snaps[1].code).toBe("module rtl_regen_v1; endmodule");
    expect(snaps[2].iter).toBe(2);
  });

  it("does NOT pick up tbRegen for RTL collector (kind filtering)", function() {
    const stageData = {
      4: { code: "x" },
      9: {
        judgeHistory: [
          {
            iter: 1,
            _structured: {
              tbRegen: { afterCode: "should not appear in RTL" },
            },
          },
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].stepId).toBe(4);
  });

  it("collectTBSnapshots picks up tbRegen entries from judge", function() {
    const stageData = {
      7: { code: "tb-original" },
      9: {
        judgeHistory: [
          {
            iter: 1,
            _structured: {
              rtlRegen: { afterCode: "rtl-regen-not-this" },
              tbRegen:  { afterCode: "tb-regen-v1" },
            },
          },
        ],
      },
    };
    const snaps = collectTBSnapshots(stageData);
    expect(snaps).toHaveLength(2);
    expect(snaps[1].stepId).toBe(9);
    expect(snaps[1].code).toBe("tb-regen-v1");
    expect(snaps[1].label).toMatch(/Judge — iter 1 \(TB regen\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group D2 (v20): manual-edit history entries in the compare list.
// ═══════════════════════════════════════════════════════════════════════════
describe("collectRTLSnapshots — manual edit history (Group D2)", function() {
  it("surfaces _manualEditHistory[] from rtl_generate as 'Manual edit #N' entries", function() {
    const stageData = {
      4: {
        code: "current",
        _manualEditHistory: [
          { ts: "2024-05-15T10:00:00Z", code: "manual edit 1" },
          { ts: "2024-05-15T10:05:00Z", code: "manual edit 2" },
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    expect(snaps).toHaveLength(3);
    expect(snaps[1].label).toMatch(/Manual edit #1/);
    expect(snaps[1].code).toBe("manual edit 1");
    expect(snaps[1].manual).toBe(true);
    expect(snaps[1].ts).toBe("2024-05-15T10:00:00Z");
    expect(snaps[2].label).toMatch(/Manual edit #2/);
    expect(snaps[2].iter).toBe(2);
  });

  it("manual edit entries have iter populated by 1-based index", function() {
    const stageData = {
      4: {
        code: "x",
        _manualEditHistory: [
          { ts: "2024-05-15T10:00:00Z", code: "first" },
          { ts: "2024-05-15T10:05:00Z", code: "second" },
          { ts: "2024-05-15T10:10:00Z", code: "third" },
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    expect(snaps[1].iter).toBe(1);
    expect(snaps[2].iter).toBe(2);
    expect(snaps[3].iter).toBe(3);
  });

  it("ignores _manualEditHistory entries without code", function() {
    const stageData = {
      4: {
        code: "x",
        _manualEditHistory: [
          { ts: "ts1" },                                  // no code
          { ts: "ts2", code: "" },                        // empty
          { ts: "ts3", code: "valid" },                   // valid
        ],
      },
    };
    const snaps = collectRTLSnapshots(stageData);
    // 1 (rtl_generate) + 1 (only the valid one) = 2
    expect(snaps).toHaveLength(2);
    expect(snaps[1].code).toBe("valid");
  });

  it("manual edit history mirror works for TB (test_generate, kind=tb)", function() {
    const stageData = {
      7: {
        code: "tb-current",
        _manualEditHistory: [
          { ts: "2024-05-15T10:00:00Z", code: "tb-manual-1" },
        ],
      },
    };
    const snaps = collectTBSnapshots(stageData);
    expect(snaps).toHaveLength(2);
    expect(snaps[1].kind).toBe("tb");
    expect(snaps[1].code).toBe("tb-manual-1");
  });
});
