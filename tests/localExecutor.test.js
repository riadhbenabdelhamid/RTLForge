// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Task #23: embedded executor. The pure placeholder expansion is unit-tested
// here; executeLocal (which spawns real processes) is live-smoked separately.

import { describe, it, expect } from "vitest";
import { expandPlaceholders } from "../src/cli/localExecutor.js";

describe("expandPlaceholders", () => {
  const files = { "ctr.sv": "...", "ctr_tb.sv": "...", "ctr_sva.sv": "...", "notes.txt": "x" };

  it("maps _tb→{TB}, _sva→{SVA}, else→{RTL}, globally", () => {
    const out = expandPlaceholders("verilator --binary {RTL} {TB} {SVA} -o {RTL}.bin", files);
    expect(out).toBe("verilator --binary ctr.sv ctr_tb.sv ctr_sva.sv -o ctr.sv.bin");
  });

  it("ignores non-.sv/.v files and leaves unknown placeholders intact", () => {
    expect(expandPlaceholders("cat {RTL}", { "a.sv": "x", "b.txt": "y" })).toBe("cat a.sv");
    expect(expandPlaceholders("echo hi", {})).toBe("echo hi");
  });
});
