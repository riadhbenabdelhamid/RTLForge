// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Auto-enable of the lint_test optional stage when a CLI backend verifies.
//
// lint_test defaults OFF (LLM-estimated TB lint is weak signal for its
// cost), but with a real backend it's one cheap verilator --lint-only run
// that catches TB syntax errors before the expensive verify stage. The
// useProject hook flips it on when backendVerified becomes true — unless
// the user has explicitly chosen a value (stamped in
// config.optionalStagesUserSet by the workflow panel's toggle).

import { describe, it, expect, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import React, { useEffect } from "react";

// The hook reaches testBackendConnection via a dynamic import of
// ../src/cli/index.js; vitest's module registry intercepts dynamic imports
// too, so this mock covers it. Everything else keeps its real behavior.
vi.mock("../src/cli/index.js", async function() {
  const actual = await vi.importActual("../src/cli/index.js");
  return Object.assign({}, actual, {
    testBackendConnection: vi.fn().mockResolvedValue({ ok: true }),
  });
});

import { useProject } from "../src/react/useProject.jsx";

/** Mount the hook and expose its surface to the test via a ref-ish object. */
function probe(opts, onMount) {
  const captured = {};
  function Probe() {
    const p = useProject(opts || {});
    Object.assign(captured, p);
    useEffect(function() {
      if (onMount) onMount(p);
      // Mount-only: onMount is a test fixture, not a reactive dependency.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }
  render(<Probe />);
  return captured;
}

describe("lint_test auto-enable on backend verification", function() {
  it("flips lint_test on when the backend verifies and the user never chose", async function() {
    const p = probe();
    // Default config has lint_test OFF and a backendUrl, so the auto-verify
    // effect runs on mount; the mocked connection test resolves ok:true.
    expect(p.config.optionalStages.lint_test).toBe(false);
    await waitFor(function() {
      expect(p.backendVerified).toBe(true);
    });
    await waitFor(function() {
      expect(p.config.optionalStages.lint_test).toBe(true);
    });
  });

  it("respects an explicit user OFF choice (optionalStagesUserSet stamp)", async function() {
    // The stamp is written synchronously in the probe's mount effect, which
    // runs before the async backend-connection promise resolves — so the
    // auto-enable effect sees the user's choice and leaves lint_test alone.
    const p = probe({}, function(hook) {
      act(function() {
        hook.setConfig(function(prev) {
          return Object.assign({}, prev, {
            optionalStagesUserSet: { lint_test: true },   // "user touched it"
            optionalStages: Object.assign({}, prev.optionalStages, { lint_test: false }),
          });
        });
      });
    });
    await waitFor(function() {
      expect(p.backendVerified).toBe(true);
    });
    // Give the auto-enable effect a tick to (not) fire.
    await act(async function() { await Promise.resolve(); });
    expect(p.config.optionalStages.lint_test).toBe(false);
  });
});
