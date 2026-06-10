// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/evalsTab — Eval criteria editor (Q5: Workflow Settings)
//
// GUI parity with `rtlforge evals show / set / reset`. The CLI and GUI
// edit the same `config.evalCriteria` blob — a setting flipped in
// either surface shows up in the other.
//
// LAYOUT:
//   Per category (requirements, verify, coverage, formal, lint, review):
//     - Section heading + "X of Y enabled" tag
//     - Per-criterion row:
//         [enabled checkbox] label  ▸ threshold input "100%"
//   Header row with "Reset to defaults" button + summary (N enabled,
//   default+custom counts).
//
// CONTINUOUS-DEVELOPMENT NOTE: this UI reads its catalog from
// listCriteria() — adding a new criterion in src/eval/criteria.js
// makes it appear here automatically. No changes needed in this file.
// The same applies to new categories: extend src/eval/criteria.js's
// listCategories() and the panel renders the new section.
// ═══════════════════════════════════════════════════════════════════════════

import { useMemo } from "react";
import { TH } from "../../constants/theme.js";
import { Btn, Tag } from "./atoms.jsx";
import {
  listCriteria,
  listCategories,
  defaultEvalConfig,
  normalizeEvalConfig,
} from "../../eval/criteria.js";

const CATEGORY_LABELS = {
  requirements: "Requirements (Trace coverage)",
  verify:       "Verify (Test pass rate)",
  coverage:     "Coverage (Per-type thresholds)",
  formal:       "Formal (Assertions / covers)",
  lint:         "Lint (Errors must be 0)",
  review:       "Review (RTL/TB scores)",
};

/**
 * Read effective per-criterion settings from config.evalCriteria, falling
 * back to each criterion's documented defaults when no override is set.
 */
function effectiveFor(config) {
  const raw = (config && config.evalCriteria) || {};
  const norm = normalizeEvalConfig(raw);
  return norm.config;
}

/**
 * Mutate config.evalCriteria[id] with the given partial fields. We read-
 * modify-write the whole map so the setConfig caller gets a single
 * coherent update rather than racing with parallel edits.
 */
function patchCriterion(setConfig, id, patch) {
  setConfig(function(c) {
    const prev = (c && c.evalCriteria) || defaultEvalConfig();
    const next = Object.assign({}, prev);
    next[id] = Object.assign({}, prev[id] || {}, patch);
    return Object.assign({}, c, { evalCriteria: next });
  });
}

function resetAll(setConfig) {
  setConfig(function(c) {
    return Object.assign({}, c, { evalCriteria: defaultEvalConfig() });
  });
}

export function EvalsTab({ config, setConfig }) {
  const all       = useMemo(listCriteria, []);
  const cats      = useMemo(listCategories, []);
  const effective = useMemo(function() { return effectiveFor(config); }, [config]);

  // Group criteria by category for rendering
  const grouped = useMemo(function() {
    const by = {};
    for (const cat of cats) by[cat] = [];
    for (const m of all) by[m.category].push(m);
    return by;
  }, [all, cats]);

  // Summary numbers for the header
  const enabledCount  = all.filter(function(m) { return effective[m.id].enabled; }).length;
  const customCount   = all.filter(function(m) {
    const e = effective[m.id];
    return e.enabled !== m.defaultEnabled || e.threshold !== m.defaultThreshold;
  }).length;

  return (
    <div style={{ paddingBottom: 12 }}>
      {/* Header summary */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 14,
      }}>
        <div>
          <div style={{ fontSize: 12, color: TH.text2 }}>
            Judge PASS gate (deterministic). The judge stage uses this checklist
            rather than an LLM rubric. A run PASSes when every
            <em> enabled </em>criterion measures ≥ its threshold.
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: TH.text2 }}>
            <Tag>{enabledCount} enabled</Tag>{" "}
            <Tag>{all.length - enabledCount} disabled</Tag>{" "}
            {customCount > 0 ? <Tag>{customCount} customised</Tag> : <Tag muted>defaults</Tag>}
          </div>
        </div>
        <Btn variant="ghost" onClick={function() { resetAll(setConfig); }}>
          Reset to defaults
        </Btn>
      </div>

      {/* One section per category. Requirements get special treatment:
          per-category 'All priorities' parent checkbox that toggles must+
          should children together (A4: UI grouping model). Other
          categories render the same flat list as before. */}
      {cats.map(function(cat) {
        const metas = grouped[cat] || [];
        if (metas.length === 0) return null;
        const enabledHere = metas.filter(function(m) { return effective[m.id].enabled; }).length;
        if (cat === "requirements") {
          return (
            <RequirementsCategorySection
              key={cat}
              label={CATEGORY_LABELS[cat] || cat}
              metas={metas}
              effective={effective}
              enabledCount={enabledHere}
              setConfig={setConfig}
            />
          );
        }
        return (
          <CategorySection
            key={cat}
            label={CATEGORY_LABELS[cat] || cat}
            metas={metas}
            effective={effective}
            enabledCount={enabledHere}
            setConfig={setConfig}
          />
        );
      })}
    </div>
  );
}

/**
 * Specialized section for the requirements category. Each requirement
 * category (Functional / Verification / Timing / Interface) is rendered
 * as a sub-group with an "All priorities" PARENT CHECKBOX that toggles
 * its must+should children together (A4: UI grouping model — "All
 * priorities" is NOT its own criterion; it's a UI convenience).
 *
 * Tri-state behavior on the parent:
 *   - both children off → parent unchecked
 *   - both children on  → parent checked
 *   - mixed             → parent shows indeterminate
 *
 * Clicking the parent:
 *   - unchecked or indeterminate → enables both children
 *   - checked                    → disables both children
 */
function RequirementsCategorySection({ label, metas, effective, enabledCount, setConfig }) {
  // Group metas by requirement-category prefix (req_func_*, req_verif_*, ...).
  const byCat = {};
  for (const m of metas) {
    // id is shaped "req_<cat>_<pri>" — extract <cat>
    const parts = m.id.split("_");
    const reqCat = parts[1] || "other";
    if (!byCat[reqCat]) byCat[reqCat] = [];
    byCat[reqCat].push(m);
  }
  const REQ_CAT_LABELS = {
    func:   "Functional",
    verif:  "Verification",
    timing: "Timing",
    intf:   "Interface",
  };
  const ordered = ["func", "verif", "timing", "intf"];

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
        paddingBottom: 4, borderBottom: "1px solid " + TH.border,
      }}>
        <span style={{ fontFamily: TH.fontD, fontSize: 13, fontWeight: 600, color: TH.text0 }}>
          {label}
        </span>
        <span style={{ fontSize: 10, color: TH.text2 }}>
          {enabledCount} of {metas.length} enabled
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {ordered.map(function(reqCat) {
          const group = byCat[reqCat];
          if (!group || group.length === 0) return null;
          return (
            <RequirementCategoryGroup
              key={reqCat}
              groupLabel={REQ_CAT_LABELS[reqCat] || reqCat}
              metas={group}
              effective={effective}
              setConfig={setConfig}
            />
          );
        })}
      </div>
    </div>
  );
}

function RequirementCategoryGroup({ groupLabel, metas, effective, setConfig }) {
  const enabledIds = metas.filter(function(m) { return effective[m.id].enabled; }).map(function(m) { return m.id; });
  const allOn  = enabledIds.length === metas.length;
  const allOff = enabledIds.length === 0;
  const indeterminate = !allOn && !allOff;

  function toggleAll() {
    // If mixed or off → turn all on; if all on → turn all off.
    const targetEnabled = !allOn;
    setConfig(function(c) {
      const prev = (c && c.evalCriteria) || defaultEvalConfig();
      const next = Object.assign({}, prev);
      for (const m of metas) {
        next[m.id] = Object.assign({}, prev[m.id] || {}, { enabled: targetEnabled });
      }
      return Object.assign({}, c, { evalCriteria: next });
    });
  }

  // Use a callback ref to set the indeterminate property (HTML attribute
  // doesn't accept it; only the DOM property does).
  const checkboxRef = function(node) {
    if (node) node.indeterminate = indeterminate;
  };

  return (
    <div style={{
      background: TH.bg0,
      border: "1px solid " + TH.border,
      borderRadius: 4,
      padding: 8,
    }}>
      {/* Parent "All priorities" row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "4px 4px 6px",
        borderBottom: "1px dashed " + TH.border,
        marginBottom: 6,
      }}>
        <input
          type="checkbox"
          ref={checkboxRef}
          checked={allOn}
          onChange={toggleAll}
          aria-label={"Toggle all priorities for " + groupLabel}
          style={{ cursor: "pointer", margin: 0 }}
        />
        <span style={{
          fontSize: 12, fontWeight: 600,
          color: allOn ? TH.text0 : TH.text1,
          flex: 1,
        }}>
          {groupLabel} <span style={{ color: TH.text2, fontWeight: 400 }}>· All priorities</span>
        </span>
        <span style={{ fontSize: 10, color: TH.text2 }}>
          {enabledIds.length}/{metas.length}
        </span>
      </div>
      {/* Children: per-priority rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 22 }}>
        {metas.map(function(m) {
          return (
            <CriterionRow
              key={m.id}
              meta={m}
              effective={effective[m.id]}
              setConfig={setConfig}
            />
          );
        })}
      </div>
    </div>
  );
}

function CategorySection({ label, metas, effective, enabledCount, setConfig }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
        paddingBottom: 4, borderBottom: "1px solid " + TH.border,
      }}>
        <span style={{ fontFamily: TH.fontD, fontSize: 13, fontWeight: 600, color: TH.text0 }}>
          {label}
        </span>
        <span style={{ fontSize: 10, color: TH.text2 }}>
          {enabledCount} of {metas.length} enabled
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {metas.map(function(m) {
          const eff = effective[m.id];
          return (
            <CriterionRow
              key={m.id}
              meta={m}
              effective={eff}
              setConfig={setConfig}
            />
          );
        })}
      </div>
    </div>
  );
}

function CriterionRow({ meta, effective, setConfig }) {
  const isCustom =
    effective.enabled !== meta.defaultEnabled ||
    effective.threshold !== meta.defaultThreshold;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "5px 8px",
      background: effective.enabled ? TH.bg0 : "transparent",
      border: "1px solid " + (effective.enabled ? TH.border : "transparent"),
      borderRadius: 4,
    }}>
      {/* Enable checkbox */}
      <input
        type="checkbox"
        checked={!!effective.enabled}
        onChange={function(e) {
          patchCriterion(setConfig, meta.id, { enabled: e.target.checked });
        }}
        style={{ cursor: "pointer", margin: 0 }}
      />

      {/* Label + id (id muted for power users + parity with CLI) */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12,
          color: effective.enabled ? TH.text0 : TH.text2,
          fontFamily: TH.font,
        }}>
          {meta.label}
          {isCustom && (
            <span style={{ marginLeft: 6, fontSize: 10, color: TH.accent }}>customised</span>
          )}
        </div>
        <div style={{
          fontSize: 9, color: TH.text2, fontFamily: TH.fontMono,
        }}>
          {meta.id}
        </div>
      </div>

      {/* Threshold input — disabled (visually muted) when criterion is off */}
      <ThresholdInput
        value={effective.threshold}
        disabled={!effective.enabled}
        onChange={function(v) {
          patchCriterion(setConfig, meta.id, { threshold: v });
        }}
      />
    </div>
  );
}

function ThresholdInput({ value, disabled, onChange }) {
  // We store the raw text in local state so the user can type "" and
  // backspace through the existing value without it snapping. We commit
  // (and clamp) on blur, and on Enter for keyboard users.
  const display = String(value);
  function commit(raw) {
    let n = parseInt(raw, 10);
    if (isNaN(n)) n = 100;       // empty / non-numeric → revert to a safe default
    if (n < 0)   n = 0;
    if (n > 100) n = 100;        // capped per spec: "100 or less only"
    onChange(n);
  }
  return (
    <span style={{
      display: "inline-flex", alignItems: "baseline", gap: 2,
      opacity: disabled ? 0.4 : 1,
    }}>
      <input
        type="number"
        min={0}
        max={100}
        step={1}
        value={display}
        disabled={disabled}
        onChange={function(e) { commit(e.target.value); }}
        onKeyDown={function(e) { if (e.key === "Enter") e.target.blur(); }}
        style={{
          width: 52, padding: "2px 6px", textAlign: "right",
          background: TH.bg0, border: "1px solid " + TH.border,
          color: TH.text0, fontFamily: TH.fontMono, fontSize: 11,
          borderRadius: 3,
        }}
      />
      <span style={{ fontSize: 11, color: TH.text2 }}>%</span>
    </span>
  );
}
