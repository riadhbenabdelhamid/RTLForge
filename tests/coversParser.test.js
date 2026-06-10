// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Tests for pipeline/coversParser
//
// Pins the test→requirement attribution behavior. These tests matter because
// without correct attribution, the judge stage reports "requirements not met"
// even when every test passes (Issue #10).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import {
  parseCoversAnnotations,
  attributeTestToReq,
} from "../src/pipeline/coversParser.js";

describe("parseCoversAnnotations", function() {
  it("returns empty list for empty input", function() {
    expect(parseCoversAnnotations("").tasks).toEqual([]);
    expect(parseCoversAnnotations(null).tasks).toEqual([]);
    expect(parseCoversAnnotations(undefined).tasks).toEqual([]);
  });

  it("extracts a single task with covers annotation", function() {
    const tb = `
module fifo_tb;
  task automatic test_reset();
    // covers: REQ-FUNC-001
    rst_n = 0;
    #10;
  endtask
endmodule
`;
    const result = parseCoversAnnotations(tb);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("test_reset");
    expect(result.tasks[0].req).toBe("REQ-FUNC-001");
  });

  it("extracts multiple tasks with their respective requirements", function() {
    const tb = `
module fifo_tb;
  task automatic test_intf_001();
    // covers: REQ-INTF-001
    \`CHECK(ready, "ready high after reset");
  endtask

  task automatic test_func_002();
    // covers: REQ-FUNC-002
    \`CHECK(empty, "empty after reset");
  endtask
endmodule
`;
    const result = parseCoversAnnotations(tb);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].name).toBe("test_intf_001");
    expect(result.tasks[0].req).toBe("REQ-INTF-001");
    expect(result.tasks[1].name).toBe("test_func_002");
    expect(result.tasks[1].req).toBe("REQ-FUNC-002");
  });

  it("handles tasks without covers annotation (req=null)", function() {
    const tb = `
task automatic helper_task();
  // utility, no requirement
endtask
`;
    const result = parseCoversAnnotations(tb);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("helper_task");
    expect(result.tasks[0].req).toBeNull();
  });

  it("uses the FIRST covers annotation in a task body", function() {
    const tb = `
task automatic test_multi();
  // covers: REQ-INTF-001
  do_something();
  // covers: REQ-FUNC-005
  do_something_else();
endtask
`;
    const result = parseCoversAnnotations(tb);
    expect(result.tasks[0].req).toBe("REQ-INTF-001");
  });

  it("normalises req IDs to upper case", function() {
    const tb = `
task automatic test_lower();
  // covers: req-intf-099
endtask
`;
    const result = parseCoversAnnotations(tb);
    expect(result.tasks[0].req).toBe("REQ-INTF-099");
  });

  it("records start/end line for each task", function() {
    const tb = `
module fifo_tb;
  task automatic test_one();
    // covers: REQ-A-001
  endtask

  task automatic test_two();
    // covers: REQ-B-002
  endtask
endmodule
`;
    const result = parseCoversAnnotations(tb);
    // test_one starts at line 3, ends at line 5
    expect(result.tasks[0].startLine).toBe(3);
    expect(result.tasks[0].endLine).toBe(5);
    expect(result.tasks[1].startLine).toBe(7);
    expect(result.tasks[1].endLine).toBe(9);
  });

  it("ignores task-like text in comments and strings", function() {
    // The parser is intentionally regex-based and conservative — but our
    // pattern requires `task <name>(` at line start (allowing whitespace).
    // Comments embedding the keyword would still NOT match because of the
    // // prefix.
    const tb = `
// task automatic fake_task(); — this is in a comment
$display("task automatic also_fake();");
task automatic real_task();
  // covers: REQ-X-001
endtask
`;
    const result = parseCoversAnnotations(tb);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("real_task");
  });

  it("handles non-automatic tasks", function() {
    const tb = `
task test_simple();
  // covers: REQ-Z-001
endtask
`;
    const result = parseCoversAnnotations(tb);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("test_simple");
    expect(result.tasks[0].req).toBe("REQ-Z-001");
  });
});

describe("attributeTestToReq", function() {
  const tb = `
task automatic test_intf_001();
  // covers: REQ-INTF-001
  \`CHECK(ready, "ready_high");
  \`CHECK(valid_handshake, "valid_handshake_completes");
endtask

task automatic test_reset();
  // covers: REQ-FUNC-005
  \`CHECK(rst_clears_state, "reset clears state");
endtask

task automatic test_full();
  // covers: REQ-FUNC-002
  \`CHECK(full_at_capacity, "full_signal_asserts");
endtask
`;
  const coversMap = parseCoversAnnotations(tb);

  it("layer 1: matches REQ-XXX-NNN pattern in test name directly", function() {
    expect(attributeTestToReq("REQ-INTF-099", coversMap, tb)).toBe("REQ-INTF-099");
    expect(attributeTestToReq("test for REQ-FUNC-042", coversMap, tb)).toBe("REQ-FUNC-042");
  });

  it("layer 2: matches task name as substring", function() {
    expect(attributeTestToReq("test_intf_001", coversMap, tb)).toBe("REQ-INTF-001");
    expect(attributeTestToReq("test_reset", coversMap, tb)).toBe("REQ-FUNC-005");
  });

  it("layer 2: longest task name wins on overlap", function() {
    const tbOverlap = `
task automatic test_a();
  // covers: REQ-A-001
endtask
task automatic test_a_long();
  // covers: REQ-B-001
endtask
`;
    const map = parseCoversAnnotations(tbOverlap);
    expect(attributeTestToReq("test_a_long_run", map, tbOverlap)).toBe("REQ-B-001");
  });

  it("layer 3: matches CHECK label string within task lexical scope", function() {
    expect(attributeTestToReq("ready_high", coversMap, tb)).toBe("REQ-INTF-001");
    expect(attributeTestToReq("reset clears state", coversMap, tb)).toBe("REQ-FUNC-005");
    expect(attributeTestToReq("full_signal_asserts", coversMap, tb)).toBe("REQ-FUNC-002");
  });

  it("returns null when no layer matches", function() {
    expect(attributeTestToReq("totally unrelated", coversMap, tb)).toBeNull();
  });

  it("handles empty/null input safely", function() {
    expect(attributeTestToReq("", coversMap, tb)).toBeNull();
    expect(attributeTestToReq(null, coversMap, tb)).toBeNull();
    expect(attributeTestToReq("test", { tasks: [] }, "")).toBeNull();
  });

  it("escapes regex special chars in test names (layer 3 robustness)", function() {
    const tbEscape = `
task automatic test_special();
  // covers: REQ-X-001
  \`CHECK(cond, "[escaped] (paren) .dot*star");
endtask
`;
    const map = parseCoversAnnotations(tbEscape);
    expect(attributeTestToReq("[escaped] (paren) .dot*star", map, tbEscape)).toBe("REQ-X-001");
  });

  it("real-world example: layered fallback finds attribution where direct match fails", function() {
    // Realistic: TB has CHECK("reset deasserts") in test_reset which covers REQ-FUNC-001.
    // [PASS] reset deasserts → no direct REQ-ID, no task name substring match,
    // falls through to layer 3.
    const realTb = `
task automatic test_reset();
  // covers: REQ-FUNC-001
  rst_n = 0; #10; rst_n = 1;
  \`CHECK(state == IDLE, "reset deasserts");
endtask
`;
    const map = parseCoversAnnotations(realTb);
    expect(attributeTestToReq("reset deasserts", map, realTb)).toBe("REQ-FUNC-001");
  });
});
