// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/observerTab — GUI view of the browser observer KB
//
// Data path:
//   src/observer/browserObserver.js writes events to localStorage as
//   stage runs complete (opt-in via config.observerEnabled). This tab
//   reads them back via listBrowserEvents() and lets the user dismiss
//   or delete individual entries, or wipe everything.
//
// This is the GUI mirror of `rtlforge observe show / list / dismiss /
// delete / wipe`. The CLI talks to SQLite at config.observerPath; this
// tab talks to localStorage. The two stores are independent for now;
// `rtlforge observe import-browser` (this slice, next section) merges
// browser events into the SQLite DB on demand.
//
// SURFACING: passive only — the tab displays events, the user dismisses
// or deletes them. No popups, no toasts, no interruption of normal flow.
// This matches the design conversation's "default passive" answer.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useMemo, useEffect } from "react";
import { TH } from "../../constants/theme.js";
import { Btn, Tag } from "./atoms.jsx";
import {
  listBrowserEvents,
  dismissBrowserEvent,
  deleteBrowserEvent,
  wipeAllBrowserEvents,
} from "../../observer/browserObserver.js";

const KIND_LABELS = {
  error:        "Error",
  fix:          "Fix",
  skill_effect: "Skill effect",
  drift:        "Drift",
  cost:         "Cost",
};

const KIND_COLORS = {
  error:        () => TH.red,
  fix:          () => TH.accent,
  skill_effect: () => TH.blue,
  drift:        () => TH.orange,
  cost:         () => TH.yellow,
};

const SEVERITY_RANK = { high: 3, warn: 2, info: 1 };

export function ObserverTab({ config }) {
  const workflow = (config && config.workflow) || "rtl";
  const enabled  = !!(config && config.observerEnabled);

  // Filters
  const [kindFilter,     setKindFilter]     = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [showDismissed,  setShowDismissed]  = useState(false);
  // Force-re-render counter so dismiss/delete/wipe immediately update the list
  const [refreshTick, setRefreshTick] = useState(0);
  function refresh() { setRefreshTick(function(x) { return x + 1; }); }

  // Read events from localStorage. The list is filtered server-side
  // (by browserObserver.listBrowserEvents) for kind/severity/dismissed;
  // we further sort here by ts desc.
  const events = useMemo(function() {
    return listBrowserEvents(workflow, {
      kind:             kindFilter !== "all" ? kindFilter : null,
      severity:         severityFilter !== "all" ? severityFilter : null,
      includeDismissed: showDismissed,
      limit:            500,
    });
  }, [workflow, kindFilter, severityFilter, showDismissed, refreshTick]);

  // Summary counts (always show all kinds, not just filtered ones)
  const summary = useMemo(function() {
    const all = listBrowserEvents(workflow, { includeDismissed: true, limit: 5000 });
    const total = all.length;
    const open  = all.filter(function(e) { return !e.flag_dismissed; }).length;
    const high  = all.filter(function(e) { return e.severity === "high"; }).length;
    const byKind = {};
    for (const e of all) {
      const k = e.event_kind || "other";
      byKind[k] = (byKind[k] || 0) + 1;
    }
    return { total, open, high, byKind };
  }, [workflow, refreshTick]);

  function onDismiss(lsKey) {
    if (dismissBrowserEvent(lsKey)) refresh();
  }
  function onDelete(lsKey) {
    if (deleteBrowserEvent(lsKey)) refresh();
  }
  function onWipe() {
    const ok = typeof window !== "undefined" && window.confirm
      ? window.confirm("This permanently deletes ALL observer events stored in this browser. Continue?")
      : true;
    if (!ok) return;
    wipeAllBrowserEvents();
    refresh();
  }

  if (!enabled) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{
          padding: 14, background: TH.bg0, border: "1px solid " + TH.border,
          borderRadius: 6, color: TH.text1,
        }}>
          <div style={{ fontSize: 12, marginBottom: 6, color: TH.text0, fontWeight: 600 }}>
            Observer is disabled
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.5, color: TH.text2 }}>
            Enable the observer in <strong>Workflow Settings → Observer Agent</strong>.
            Once enabled, each stage run will produce one short LLM call to
            extract noteworthy patterns (errors, fixes, skill effects, drift,
            cost spikes). Events show up here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 12 }}>
      {/* Summary banner */}
      <ObserverSummary summary={summary} workflow={workflow} onWipe={onWipe} />

      {/* Filters */}
      <div style={{
        display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
        marginBottom: 12, padding: "8px 12px",
        background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
      }}>
        <label style={{ fontSize: 11, color: TH.text2 }}>Kind:</label>
        <select
          value={kindFilter}
          onChange={function(e) { setKindFilter(e.target.value); }}
          style={selectStyle()}
        >
          <option value="all">all</option>
          {Object.keys(KIND_LABELS).map(function(k) {
            return <option key={k} value={k}>{KIND_LABELS[k]}</option>;
          })}
        </select>

        <label style={{ fontSize: 11, color: TH.text2 }}>Severity:</label>
        <select
          value={severityFilter}
          onChange={function(e) { setSeverityFilter(e.target.value); }}
          style={selectStyle()}
        >
          <option value="all">all</option>
          <option value="high">high</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
        </select>

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: TH.text2, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={function(e) { setShowDismissed(e.target.checked); }}
            style={{ accentColor: TH.accent }}
          />
          Show dismissed
        </label>

        <span style={{ flex: 1 }} />

        <span style={{ fontSize: 11, color: TH.text2 }}>
          {events.length} shown of {summary.total}
        </span>
      </div>

      {/* Event list */}
      {events.length === 0 ? (
        <div style={{
          padding: 24, textAlign: "center",
          color: TH.text2, fontSize: 12, fontStyle: "italic",
          background: TH.bg0, border: "1px dashed " + TH.border, borderRadius: 6,
        }}>
          {summary.total === 0
            ? "No observations yet. Run a stage with the observer enabled to start building the knowledge base."
            : "No events match the current filters."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {events.map(function(ev) {
            return <ObserverEventRow key={ev._lsKey} event={ev} onDismiss={onDismiss} onDelete={onDelete} />;
          })}
        </div>
      )}
    </div>
  );
}

function ObserverSummary({ summary, workflow, onWipe }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, marginBottom: 12,
      padding: "10px 12px",
      background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: TH.text0 }}>
          Observer knowledge — workflow <code style={{
            background: TH.bg1, padding: "1px 5px", borderRadius: 3, color: TH.accent,
          }}>{workflow}</code>
        </div>
        <div style={{ fontSize: 10, color: TH.text2, marginTop: 4 }}>
          <Tag>{summary.total} total</Tag>{" "}
          <Tag>{summary.open} open</Tag>{" "}
          {summary.high > 0 && <Tag color={TH.red} bg={TH.redDim}>{summary.high} high-severity</Tag>}
        </div>
      </div>
      {summary.total > 0 && (
        <Btn variant="danger" size="sm" onClick={onWipe} title="Permanently delete all observer events">
          Wipe all
        </Btn>
      )}
    </div>
  );
}

function ObserverEventRow({ event, onDismiss, onDelete }) {
  const ex = event.extracted || {};
  const kindColor = (KIND_COLORS[event.event_kind] || function() { return TH.text1; })();
  const sev = event.severity || "info";
  const sevColor = sev === "high" ? TH.red :
                   sev === "warn" ? TH.yellow : TH.text2;
  const when = new Date(event.ts).toISOString().replace("T", " ").slice(0, 19);

  return (
    <div style={{
      padding: 10,
      background: TH.bg0,
      border: "1px solid " + (event.flag_dismissed ? TH.border : kindColor),
      borderRadius: 4,
      opacity: event.flag_dismissed ? 0.55 : 1,
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <Tag color={kindColor} bg={TH.bg1}>{KIND_LABELS[event.event_kind] || event.event_kind}</Tag>
        <Tag color={sevColor} bg={TH.bg1}>{sev}</Tag>
        {event.stage_key && (
          <span style={{ fontSize: 10, color: TH.text2, fontFamily: TH.fontMono }}>
            stage: {event.stage_key}
          </span>
        )}
        <span style={{ fontSize: 10, color: TH.text3, fontFamily: TH.fontMono }}>{when}</span>
        {event.flag_dismissed && (
          <Tag color={TH.text2} bg={TH.bg1}>dismissed</Tag>
        )}
        <span style={{ flex: 1 }} />
        {!event.flag_dismissed && (
          <Btn variant="ghost" size="sm" onClick={function() { onDismiss(event._lsKey); }} title="Hide from list (recoverable)">
            Dismiss
          </Btn>
        )}
        <Btn variant="danger" size="sm" onClick={function() { onDelete(event._lsKey); }} title="Permanently delete this event">
          Delete
        </Btn>
      </div>

      <div style={{ fontSize: 12, color: TH.text0, marginBottom: 4 }}>
        {ex.summary || "(no summary)"}
      </div>

      {Array.isArray(ex.tags) && ex.tags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
          {ex.tags.map(function(t, i) {
            return (
              <span key={i} style={{
                fontSize: 9, padding: "1px 6px", borderRadius: 3,
                color: TH.text2, background: TH.bg1, fontFamily: TH.fontMono,
              }}>
                {t}
              </span>
            );
          })}
        </div>
      )}

      {ex.actionable && (
        <div style={{ fontSize: 10, color: TH.accent, marginTop: 6, fontStyle: "italic" }}>
          Actionable — this observation suggests something to change.
        </div>
      )}
    </div>
  );
}

function selectStyle() {
  return {
    background: TH.bg1, border: "1px solid " + TH.border, color: TH.text0,
    fontSize: 11, padding: "3px 8px", borderRadius: 3, fontFamily: TH.font,
  };
}
