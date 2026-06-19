// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Slice B (platform polish #21): `observe merge <other.db>` merge-planning.
// The DB wiring needs better-sqlite3 (a native dep not always installed), so
// the testable contract is the PURE `planMerge`. We use a local sigFn with the
// same shape as the CLI's `sigOf` — importing the real one would pull
// observe.js → observer/sqlite.js → `import("better-sqlite3")`, which vite
// can't resolve when the native dep is absent. The real `sigOf` is covered
// (under Node, not vite) in verify/verify-observer.mjs.

import { describe, it, expect } from "vitest";
import { planMerge } from "../src/observer/merge.js";

// Mirror of src/term/commands/observe.js `sigOf` — kept local on purpose.
function sigOf(e) {
  const ex = e.extracted || {};
  return [e.ts, e.workflow || "", e.stage_key || "", e.event_kind || "",
    (ex.summary || "").slice(0, 100)].join("|");
}

function ev(over) {
  return Object.assign(
    { ts: 1, workflow: "rtl", stage_key: "verify", event_kind: "error",
      extracted: { summary: "s" }, flag_dismissed: 0 },
    over,
  );
}

describe("planMerge", () => {
  it("inserts every disjoint incoming row", () => {
    const existing = [ev({ ts: 1, extracted: { summary: "a" } })];
    const incoming = [
      ev({ ts: 2, extracted: { summary: "b" } }),
      ev({ ts: 3, extracted: { summary: "c" } }),
    ];
    const p = planMerge(existing, incoming, sigOf);
    expect(p.inserted).toBe(2);
    expect(p.dupSkipped).toBe(0);
    expect(p.scanned).toBe(2);
    expect(p.toInsert.map((r) => r.ts)).toEqual([2, 3]);
  });

  it("skips rows already present in the destination", () => {
    const shared = ev({ ts: 5, extracted: { summary: "dup" } });
    const existing = [shared];
    const incoming = [shared, ev({ ts: 6, extracted: { summary: "new" } })];
    const p = planMerge(existing, incoming, sigOf);
    expect(p.inserted).toBe(1);
    expect(p.dupSkipped).toBe(1);
  });

  it("is idempotent — a second merge inserts nothing", () => {
    const incoming = [
      ev({ ts: 1, extracted: { summary: "a" } }),
      ev({ ts: 2, extracted: { summary: "b" } }),
    ];
    const first = planMerge([], incoming, sigOf);
    expect(first.inserted).toBe(2);
    // Destination now holds the just-inserted rows; merging the same source again:
    const second = planMerge(first.toInsert, incoming, sigOf);
    expect(second.inserted).toBe(0);
    expect(second.dupSkipped).toBe(2);
  });

  it("collapses duplicate rows WITHIN one source to a single insert", () => {
    const r = ev({ ts: 9, extracted: { summary: "twice" } });
    const p = planMerge([], [r, r, r], sigOf);
    expect(p.inserted).toBe(1);
    expect(p.dupSkipped).toBe(2);
  });

  it("skips dismissed source rows by default, carries them with includeDismissed", () => {
    const incoming = [
      ev({ ts: 1, extracted: { summary: "open" }, flag_dismissed: 0 }),
      ev({ ts: 2, extracted: { summary: "hidden" }, flag_dismissed: 1 }),
    ];
    const def = planMerge([], incoming, sigOf);
    expect(def.inserted).toBe(1);
    expect(def.dismissedSkipped).toBe(1);

    const incl = planMerge([], incoming, sigOf, { includeDismissed: true });
    expect(incl.inserted).toBe(2);
    expect(incl.dismissedSkipped).toBe(0);
  });

  it("tolerates null/empty inputs", () => {
    expect(planMerge(null, null, sigOf)).toMatchObject({ inserted: 0, scanned: 0 });
    expect(planMerge([], [null, undefined], sigOf).inserted).toBe(0);
  });
});
