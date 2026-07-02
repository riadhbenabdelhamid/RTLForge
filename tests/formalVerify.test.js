// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Formal BMC stage (docs/improvement-roadmap.md #8) — pure parts + skip paths.
// The live proof (buggy counter FAILs with a counterexample window, fixed
// design PASSes via real sby) runs outside CI; see the commit message.

import { describe, it, expect } from "vitest";
import { buildSbyFile, parseSbyOutput } from "../src/cli/formalRunner.js";
import { formalVerifyNode } from "../src/pipeline/nodes/formal_verify.js";
import { getActiveStages } from "../src/constants/stages.js";

describe("buildSbyFile / parseSbyOutput", () => {
  it("renders a bmc job with depth and top", () => {
    const sby = buildSbyFile({ top: "cnt", depth: 12 });
    expect(sby).toMatch(/mode bmc/);
    expect(sby).toMatch(/depth 12/);
    expect(sby).toMatch(/prep -top cnt/);
    expect(sby).toMatch(/read -formal -sv dut\.sv/);
  });
  it("classifies sby outcomes", () => {
    expect(parseSbyOutput("... DONE (PASS, rc=0)", 0)).toBe("PASS");
    expect(parseSbyOutput("... DONE (FAIL, rc=2)", 2)).toBe("FAIL");
    expect(parseSbyOutput("... DONE (TIMEOUT, rc=8)", 8)).toBe("TIMEOUT");
    expect(parseSbyOutput("garbage", 1)).toBe("TOOL_ERROR");
  });
});

describe("formalVerifyNode skip paths (never fails a run)", () => {
  it("skips without RTL", async () => {
    const st = await formalVerifyNode({ _config: {} });
    expect(st.formal_verify.status).toBe("SKIPPED");
    expect(st.formal_verify.reason).toMatch(/no RTL/);
  });
  it("skips without bindable properties", async () => {
    const st = await formalVerifyNode({
      _config: {},
      rtl_generate: { code: "module m; endmodule" },
      formal_props: { properties: [] },
      elicit: { modName: "m" },
    });
    expect(st.formal_verify.status).toBe("SKIPPED");
    expect(st.formal_verify.reason).toMatch(/no bindable/);
  });
});

describe("stage registry", () => {
  it("formal_verify is optional, default off, ordered between SVA props and test gen", () => {
    const off = getActiveStages({ optionalStages: { formal_props: true, lint: true } });
    expect(off.some((s) => s.key === "formal_verify")).toBe(false);
    const on = getActiveStages({ optionalStages: { formal_props: true, formal_verify: true, lint: true } });
    const keys = on.map((s) => s.key);
    const i = keys.indexOf("formal_verify");
    expect(i).toBeGreaterThan(keys.indexOf("formal_props"));
    expect(i).toBeLessThan(keys.indexOf("test_generate"));
  });
});
