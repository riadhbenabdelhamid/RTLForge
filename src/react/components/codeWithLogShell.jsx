// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// CodeWithLogShell — Code view with an attached per-stage Log tab
//
// Cases 4 (RTL Gen) and 7 (Test Gen) in RTLForge.jsx render a bare
// <SplitCodeView> without any tab structure of their own. To give those
// stages a Log tab (per the user spec — "a log in each step"), we wrap
// their existing content in this tiny shell:
//
//   ┌────────┬────────┐
//   │ Code   │ Log    │  ← SubTab
//   └────────┴────────┘
//   <SplitCodeView .../>   ← when Code is active
//   <LogTab data={data}/>  ← when Log is active
//
// The children render in the Code tab, which keeps backward
// compatibility with the existing render shape. Stages with their own
// SubTab structures (Lint, Verify, Judge, etc.) already have Log
// wired in directly and don't use this shell.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { SubTab } from "./atoms.jsx";
import { LogTab } from "./logTab.jsx";

export function CodeWithLogShell({ data, stageKey, stageLabel, codeLabel, children }) {
  const [sub, setSub] = useState("code");
  // Only show the Log tab when the stage has actually captured events.
  // Newly-created modules without any pipeline runs
  // would otherwise see an empty Log tab that gives the impression
  // something went wrong. The empty-state inside LogTab already shows
  // "No log events captured" — but hiding the tab entirely until there
  // are events keeps the UI quieter for clean-slate cases.
  const hasLog = data && Array.isArray(data._log) && data._log.length > 0;
  return (
    <div>
      <SubTab
        tabs={hasLog
          ? [{ id: "code", label: codeLabel || "Code" }, { id: "runlog", label: "Log" }]
          : [{ id: "code", label: codeLabel || "Code" }]
        }
        active={sub}
        onChange={setSub}
      />
      {sub === "code" && children}
      {sub === "runlog" && (
        <LogTab
          data={data}
          stageKey={stageKey}
          stageLabel={stageLabel}
        />
      )}
    </div>
  );
}
