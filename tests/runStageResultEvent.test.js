// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { describe, it, expect } from "vitest";
import { synthesizeResultEvent } from "../src/projectState/runStage.js";

describe("honest simulation result events", () => {
  it.each([
    { status: "UNVERIFIED" }, { cli: true, total: 0, pass: 0, fail: 0 },
    { cli: false, total: 4, pass: 4 }, { status: "RUNTIME_EXIT", total: 4, pass: 4 },
    { status: "UNVERIFIED", total: 4, pass: 3, fail: 1 },
    { total: 4, pass: 4, unsupported: 2 }, { total: 4, pass: 4, _checkerEvidenceInvalid: true },
  ])("never presents incomplete evidence as a PASS: %j", result => {
    expect(synthesizeResultEvent("verify", result)).toMatchObject({ status: "UNVERIFIED", summary: expect.stringContaining("Verification incomplete") });
  });
  it("retains actual measured pass and failure counts", () => {
    expect(synthesizeResultEvent("verify", { cli: true, status: "MEASURED", total: 4, pass: 3, fail: 1 }))
      .toMatchObject({ status: "FAIL", summary: "3/4 measured checks passed (1 failed)" });
    expect(synthesizeResultEvent("verify", { cli: true, status: "MEASURED", total: 4, pass: 4, fail: 0 }).status).toBe("PASS");
  });
});
