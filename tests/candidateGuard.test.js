import { describe, expect, it } from "vitest";
import {
  sameChecker, passedCheckIds, retainsPassedChecks,
  selectCommonCheckerCandidate,
} from "../src/pipeline/candidateGuard.js";

const checker = { version: "v1", seed: "C0FFEE", hash: "abc" };
const measurement = (pass, tests, extra) => Object.assign({
  cli: true, pass, total: tests.length, fail: tests.length - pass, tests,
}, extra || {});
const test = (name, st = "PASS") => ({ name, st });
const record = (m, extra) => Object.assign({ rtl: "r", tb: "t", verify: m, checker }, extra || {});

describe("common checker candidate guard", () => {
  it("requires version, seed, and checker source identity", () => {
    expect(sameChecker({ checker }, { checker })).toBe(true);
    expect(sameChecker({ checker }, { checker: { ...checker, seed: "other" } })).toBe(false);
    expect(sameChecker({ checker }, { checker: { version: "v1", seed: "C0FFEE" } })).toBe(false);
  });

  it("treats duplicate IDs conservatively", () => {
    const ambiguous = measurement(2, [test("a"), test("a", "FAIL"), test("b", "PASS")]);
    expect(passedCheckIds(ambiguous)).toEqual(["b"]);
    expect(retainsPassedChecks(measurement(2, [test("a"), test("a", "FAIL"), test("b", "PASS")]), ambiguous)).toBe(true);
    expect(retainsPassedChecks(measurement(2, [test("a"), test("a", "FAIL"), test("b", "FAIL")]), ambiguous)).toBe(false);
    const clean = record(measurement(1, [test("b"), test("c", "FAIL")]));
    const duplicate = record(measurement(2, [test("b"), test("b"), test("c", "FAIL")]));
    expect(selectCommonCheckerCandidate(duplicate, clean).reason).toBe("CHECK_UNIVERSE_MISMATCH");
  });

  it("accepts only strict improvement that retains every incumbent pass", () => {
    const incumbent = record(measurement(2, [test("a"), test("b"), test("c", "FAIL")]));
    const better = record(measurement(3, [test("a"), test("b"), test("c")]));
    expect(selectCommonCheckerCandidate(better, incumbent).decision).toBe("ACCEPT_IMPROVEMENT");
    const tie = record(measurement(2, [test("a"), test("b"), test("c", "FAIL")]));
    expect(selectCommonCheckerCandidate(tie, incumbent).reason).toBe("TIE");
    const regression = record(measurement(3, [test("a"), test("b", "FAIL"), test("c")]));
    expect(selectCommonCheckerCandidate(regression, incumbent).reason).toBe("PASSED_CHECK_REGRESSION");
  });

  it("keeps the incumbent for checker mismatch, errors, and timeouts", () => {
    const incumbent = record(measurement(2, [test("a"), test("b"), test("c", "FAIL")]));
    const mismatch = record(measurement(4, [test("a"), test("b"), test("c"), test("d"), test("e", "FAIL")]), {
      checker: { ...checker, hash: "different" },
    });
    expect(selectCommonCheckerCandidate(mismatch, incumbent).reason).toBe("CHECKER_MISMATCH");
    expect(selectCommonCheckerCandidate(record(measurement(0, [], { _error: true })), incumbent).reason).toBe("ERROR");
    expect(selectCommonCheckerCandidate(record(measurement(0, [], { _timeout: true })), incumbent).reason).toBe("TIMEOUT");
  });
});
