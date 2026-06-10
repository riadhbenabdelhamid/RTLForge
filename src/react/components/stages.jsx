// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/stages — Stage renderers (8 stages)
//
// The 8 stage components:
//     - ElicitStage       spec discovery Q&A + assumptions
//     - SpecStage         requirements + iface + params CRUD
//     - ArchStage         strategy + mermaid block diagram
//     - FormalPropsStage  SVA properties + auto constraints
//     - LintStage         lint results + iteration history
//     - VerifyStage       test results + coverage + retries
//     - JudgeStage        verdict + traceability + recommendations
//     - ReviewStage       rtl_review/test_review issue browser
//
// These stages are pure React components that consume their data as props —
// they do NOT import useProject. The root RTLForge component plumbs
// `p.activeMod.stageData[N]` into each stage's `data` prop, wires `setData` via
// the reducer, and passes the stage-navigation context (`isActive`,
// `propagating`, etc).
//
// MANUAL_EDIT_MARKER and MANUAL_EDIT_COLOR are rendering-only constants
// for SpecStage's manual-edit annotation badges. They live in this file
// rather than a separate module because nothing outside SpecStage uses
// them.
//
// ArchStage note: `window.mermaid` is loaded dynamically from a CDN on
// first tab access. This is browser-only behavior — calling ArchStage
// in a non-browser environment will fail at the useEffect that touches
// `document.createElement`. The structural tests below mock this by
// running only in non-mermaid mode.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef } from "react";
import {
  Spinner, SubTab, Chip, Btn, Tag, MetricCard, CodeBlock, DataTable, Label,
} from "./atoms.jsx";
import { TH, PRI_C } from "../../constants/theme.js";
import { Q_CATS, MAX_LINT_ITERS, MAX_VERIFY_ITERS, MAX_JUDGE_ITERS } from "../../constants/stages.js";
import { StructuredFixViewer, DiffBlock } from "./structuredViewer.jsx";
import { DurationTab, TokensTab, TraceTab } from "./metricsTabs.jsx";
import { LogTab } from "./logTab.jsx";

// SpecStage rendering-only constants
const MANUAL_EDIT_MARKER = "✏️";
const MANUAL_EDIT_COLOR  = "#c084fc"; // light purple

// ═══════════════════════════════════════════════════════════════════════════
// ElicitStage — spec discovery questionnaire with per-category sub-tabs
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   data      : { questions, assumptions, answers, customAnswers, domain }
//   setData   : updater fn that takes (prevData) => newData
//   isActive  : boolean — false disables all interactions
//
// Renders two top-level tabs: "Questions" and "Assumptions". The Questions
// tab filters down to one category at a time (from Q_CATS) and shows each
// question with its multiple-choice options as Chip toggles. The
// Assumptions tab is a scrollable list of editable propositions with
// confirm/reject checkboxes.
export function ElicitStage({ data, setData, isActive }) {
  const questions     = data.questions || [];
  const assumptions   = data.assumptions || [];
  const answers       = data.answers || {};
  const customAnswers = data.customAnswers || {};
  const cats = Q_CATS.filter(function(c) {
    return questions.some(function(q) { return q.cat === c.id; });
  });
  const [catTab, setCatTab] = useState("interface");
  const [topTab, setTopTab] = useState("questions");
  const [editAsm, setEditAsm] = useState(null);

  // Fall back to the first available category when questions change and the
  // current catTab no longer matches any question.
  useEffect(function() {
    if (cats.length > 0 && !cats.find(function(c) { return c.id === catTab; })) {
      setCatTab(cats[0].id);
    }
  }, [questions.length]);

  const catQs = questions.filter(function(q) { return q.cat === catTab; });
  const answeredTotal = Object.keys(answers).length;

  function set(k, v) {
    setData(function(prev) { return Object.assign({}, prev, { [k]: v }); });
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <Tag color={TH.blue} bg={TH.blueDim}>Domain: {data.domain}</Tag>
        <Tag
          color={answeredTotal === questions.length ? TH.accent : TH.yellow}
          bg={answeredTotal === questions.length ? TH.accentDim : TH.yellowDim}
        >
          {answeredTotal}/{questions.length} answered
        </Tag>
      </div>
      <SubTab
        tabs={[
          { id: "questions",   label: "Questions",   count: questions.length },
          { id: "assumptions", label: "Assumptions", count: assumptions.length },
          // Per-step Log panel (last tab)
          { id: "runlog",      label: "Log" },
        ]}
        active={topTab}
        onChange={setTopTab}
      />
      {topTab === "questions" && (
        <div>
          <SubTab
            tabs={cats.map(function(c) {
              return {
                id: c.id,
                label: c.label,
                count: questions.filter(function(q) { return q.cat === c.id; }).length,
              };
            })}
            active={catTab}
            onChange={setCatTab}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {catQs.map(function(q) {
              const ans = answers[q.id];
              return (
                <div key={q.id} style={{
                  background: TH.bg0,
                  border: "1px solid " + TH.border,
                  borderRadius: 4,
                  padding: 14,
                  borderLeft: "3px solid " + (ans ? TH.accent : TH.yellow),
                }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <Tag color={TH.blue} bg={TH.blueDim}>{q.id}</Tag>
                    <span style={{ fontSize: 12, color: TH.text0 }}>{q.text}</span>
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {(q.opts || []).map(function(o) {
                      return (
                        <Chip
                          key={o}
                          label={o}
                          active={ans === o}
                          disabled={!isActive}
                          onClick={function() {
                            set("answers", Object.assign({}, answers, { [q.id]: o }));
                            if (o !== "Other (specify)") {
                              const c2 = Object.assign({}, customAnswers);
                              delete c2[q.id];
                              set("customAnswers", c2);
                            }
                          }}
                        />
                      );
                    })}
                  </div>
                  {ans === "Other (specify)" && (
                    <input
                      placeholder="Specify…"
                      value={customAnswers[q.id] || ""}
                      disabled={!isActive}
                      onChange={function(e) {
                        set("customAnswers", Object.assign({}, customAnswers, { [q.id]: e.target.value }));
                      }}
                      style={{
                        marginTop: 8, maxWidth: 360, width: "100%",
                        background: TH.bg0, border: "1px solid " + TH.border,
                        borderRadius: 4, padding: "7px 11px", color: TH.text0,
                        fontSize: 12, outline: "none", fontFamily: TH.font,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {topTab === "assumptions" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {assumptions.map(function(a, i) {
            return (
              <div key={a.id} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 12px", background: TH.bg0,
                border: "1px solid " + TH.border, borderRadius: 4,
              }}>
                <input
                  type="checkbox"
                  checked={a.confirmed}
                  disabled={!isActive}
                  onChange={function() {
                    const n = assumptions.slice();
                    n[i] = Object.assign({}, a, { confirmed: !a.confirmed });
                    set("assumptions", n);
                  }}
                  style={{ accentColor: TH.accent }}
                />
                <Tag>{a.id}</Tag>
                {editAsm === i && isActive ? (
                  <input
                    value={a.revised || a.text}
                    onChange={function(e) {
                      const n = assumptions.slice();
                      n[i] = Object.assign({}, a, { revised: e.target.value });
                      set("assumptions", n);
                    }}
                    onBlur={function() { setEditAsm(null); }}
                    onKeyDown={function(e) { if (e.key === "Enter") setEditAsm(null); }}
                    autoFocus
                    style={{
                      flex: 1, background: TH.bg0, border: "1px solid " + TH.border,
                      borderRadius: 4, padding: "7px 11px", color: TH.text0,
                      fontSize: 12, outline: "none", fontFamily: TH.font,
                    }}
                  />
                ) : (
                  <span
                    style={{
                      flex: 1, fontSize: 12,
                      color: a.revised ? TH.yellow : (a.confirmed ? TH.text0 : TH.text2),
                      textDecoration: a.confirmed ? "none" : "line-through",
                      cursor: isActive ? "pointer" : "default",
                    }}
                    onClick={function() { if (isActive) setEditAsm(i); }}
                  >
                    {a.revised || a.text}
                  </span>
                )}
                {isActive && (
                  <button
                    onClick={function() {
                      set("assumptions", assumptions.filter(function(_, j) { return j !== i; }));
                    }}
                    style={{ background: "none", border: "none", color: TH.red, cursor: "pointer", fontSize: 14 }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {isActive && (
            <Btn
              variant="secondary"
              onClick={function() {
                set("assumptions", assumptions.concat([{
                  id: "A-" + String(assumptions.length + 1).padStart(2, "0"),
                  text: "New assumption…",
                  confirmed: true,
                  revised: null,
                }]));
              }}
              style={{ alignSelf: "flex-start", marginTop: 4 }}
            >
              + Add Assumption
            </Btn>
          )}
        </div>
      )}
      {topTab === "runlog" && <LogTab data={data} stageKey="elicit" stageLabel="Elicit" />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SpecStage — full-fat CRUD editor for requirements, interface, parameters
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the largest stage component (~160 LOC). It has 3 sub-tabs
// (reqs / iface / params), each with add/edit/remove operations, and a
// "manual edit" tracking system that annotates which fields have been
// hand-modified by the user. The manual-edit markers are stored in the
// `_manualEdits` field of the data object and preserved across checkpoints.
//
// Props:
//   data        : { requirements, iface, params, _manualEdits? }
//   setData     : (prev => next) updater
//   isActive    : gates all edit UI (when false, renders read-only views)
//   onPropagate : optional fn(source: "reqs" | "iface" | "params") that
//                 triggers the LLM-powered cross-section propagation
//   propagating : boolean spinner state for the propagate buttons
export function SpecStage({ data, setData, isActive, onPropagate, propagating }) {
  const reqs   = data.requirements || [];
  const iface  = data.iface || [];
  const params = data.params || [];
  const manualEdits = data._manualEdits || {};
  const [sub, setSub] = useState("reqs");
  // editIdx/editField/editText are legacy state from earlier edit modes.
  // They're still declared to match the initial state shape but only
  // used by the paths we retain.
  const [, setEditIdx]   = useState(null);
  const [, setEditField] = useState(null);
  const [, setEditText]  = useState("");
  const [showAdd, setShowAdd]           = useState(false);
  const [newReq, setNewReq]             = useState({ cat: "Functionality", pri: "Should", desc: "" });
  const [showAddPort, setShowAddPort]   = useState(false);
  const [newPort, setNewPort]           = useState({ name: "", dir: "input", width: "1", desc: "" });
  const [showAddParam, setShowAddParam] = useState(false);
  const [newParam, setNewParam]         = useState({ name: "", type: "parameter", def: "", range: "", desc: "" });

  function set(k, v) { setData(function(p) { return Object.assign({}, p, { [k]: v }); }); }
  function markEdited(section, index, field) {
    setData(function(p) {
      const me = Object.assign({}, p._manualEdits || {});
      const key = section + "." + index + "." + field;
      me[key] = true;
      return Object.assign({}, p, { _manualEdits: me });
    });
  }
  function isEdited(section, index, field) {
    const key = section + "." + index + "." + field;
    return !!(manualEdits[key]);
  }
  function editBadge(section, index, field) {
    if (!isEdited(section, index, field)) return null;
    return (
      <span
        title="Manually edited"
        style={{ color: MANUAL_EDIT_COLOR, fontSize: 10, marginLeft: 3, cursor: "help" }}
      >
        {MANUAL_EDIT_MARKER}
      </span>
    );
  }

  // Requirement category vocabulary. CANONICAL_CATS is the single source of
  // truth for the cat <select> options, matching the names the spec LLM prompt
  // declares ("Interface | Functionality | Timing | Error | Verification") and
  // the spec node's id-prefix post-processor. We also map legacy values (e.g.
  // "Functional") to the canonical form before display, so a requirement with
  // cat="Functionality" doesn't fall through to the first <option>.
  const CANONICAL_CATS = ["Interface", "Functionality", "Timing", "Error", "Verification"];
  function normalizeCat(c) {
    if (!c) return "Functionality";
    // Old GUI vocabulary → canonical
    if (c === "Functional") return "Functionality";
    if (c === "Parameter")  return "Interface";   // Parameter requirements were actually about port/iface declarations
    return c;
  }

  // Requirements
  function addReq() {
    if (!newReq.desc.trim()) return;
    const tm = { Interface: "INTF", Functionality: "FUNC", Error: "ERR", Timing: "TIME", Verification: "VERIF" };
    const ct = tm[normalizeCat(newReq.cat)] || "FUNC";
    // Find highest existing number for this category
    let maxNum = 0;
    reqs.forEach(function(r) {
      const m = r.id.match(new RegExp("REQ-" + ct + "-(\\d+)"));
      if (m) { const n = parseInt(m[1], 10); if (n > maxNum) maxNum = n; }
    });
    const nextId = "REQ-" + ct + "-" + String(maxNum + 1).padStart(3, "0");
    set("requirements", reqs.concat([{
      id: nextId, cat: normalizeCat(newReq.cat), pri: newReq.pri, desc: newReq.desc, rat: "User-added",
    }]));
    markEdited("reqs", reqs.length, "added");
    setNewReq({ cat: "Functionality", pri: "Should", desc: "" });
    setShowAdd(false);
  }
  function removeReq(i) { const n = reqs.slice(); n.splice(i, 1); set("requirements", n); }
  function updateReq(i, field, val) {
    const n = reqs.slice();
    n[i] = Object.assign({}, n[i], { [field]: val });
    set("requirements", n);
    markEdited("reqs", i, field);
  }

  // Interface
  function addPort() {
    if (!newPort.name.trim()) return;
    set("iface", iface.concat([Object.assign({}, newPort)]));
    markEdited("iface", iface.length, "added");
    setNewPort({ name: "", dir: "input", width: "1", desc: "" });
    setShowAddPort(false);
  }
  function removePort(i) { const n = iface.slice(); n.splice(i, 1); set("iface", n); }
  function updatePort(i, field, val) {
    const n = iface.slice();
    n[i] = Object.assign({}, n[i], { [field]: val });
    set("iface", n);
    markEdited("iface", i, field);
  }

  // Parameters
  function addParam() {
    if (!newParam.name.trim()) return;
    const entry = Object.assign({}, newParam, {
      def: newParam.def !== ""
        ? (isNaN(Number(newParam.def)) ? newParam.def : Number(newParam.def))
        : 0,
    });
    set("params", params.concat([entry]));
    markEdited("params", params.length, "added");
    setNewParam({ name: "", type: "parameter", def: "", range: "", desc: "" });
    setShowAddParam(false);
  }
  function removeParam(i) { const n = params.slice(); n.splice(i, 1); set("params", n); }
  function updateParam(i, field, val) {
    const n = params.slice();
    n[i] = Object.assign({}, n[i], {
      [field]: field === "def" && val !== "" && !isNaN(Number(val)) ? Number(val) : val,
    });
    set("params", n);
    markEdited("params", i, field);
  }

  const inpSt = {
    background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
    padding: "6px 10px", color: TH.text0, fontSize: 12, fontFamily: TH.font,
    outline: "none",
  };
  const cellEdit = function(val, onChange, style) {
    return (
      <input
        value={val}
        onChange={function(e) { onChange(e.target.value); }}
        style={Object.assign({}, inpSt, { fontSize: 11, width: "100%", padding: "4px 6px" }, style || {})}
      />
    );
  };
  const anyManualEdits = Object.keys(manualEdits).length > 0;

  return (
    <div>
      <SubTab
        tabs={[
          { id: "reqs",   label: "Requirements",     count: reqs.length },
          { id: "iface",  label: "Module Interface", count: iface.length },
          { id: "params", label: "Parameters",       count: params.length },
          // Per-step Log panel (last tab)
          { id: "runlog", label: "Log" },
        ]}
        active={sub}
        onChange={setSub}
      />
      {anyManualEdits && (
        <div style={{
          padding: "5px 10px", borderRadius: 4,
          background: "rgba(192,132,252,.1)",
          border: "1px solid rgba(192,132,252,.25)",
          fontSize: 10, color: MANUAL_EDIT_COLOR, marginBottom: 8,
          display: "flex", alignItems: "center", gap: 5,
        }}>
          <span>{MANUAL_EDIT_MARKER}</span> Some fields were manually edited — marked with purple indicators. These annotations are preserved in checkpoints and exports.
        </div>
      )}

      {sub === "reqs" && (
        <div>
          <DataTable
            columns={["ID", "Category", "Priority", "Description", ""]}
            gridCols={isActive ? "90px 105px 100px 1fr 28px" : "90px 100px 90px 1fr"}
            rows={reqs.map(function(r, i) {
              return [
                <span key="id" style={{ color: TH.blue, fontWeight: 600, fontSize: 11 }}>{r.id}{editBadge("reqs", i, "added")}</span>,
                isActive
                  ? <select key="c" value={normalizeCat(r.cat)} onChange={function(e) { updateReq(i, "cat", e.target.value); }} style={Object.assign({}, inpSt, { padding: "3px 4px", fontSize: 10, width: "100%" })}>
                      {CANONICAL_CATS.map(function(c) { return <option key={c}>{c}</option>; })}
                    </select>
                  : <span key="c" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Tag>{normalizeCat(r.cat)}</Tag>{editBadge("reqs", i, "cat")}</span>,
                isActive
                  ? <select key="p" value={r.pri} onChange={function(e) { updateReq(i, "pri", e.target.value); }} style={Object.assign({}, inpSt, { padding: "3px 4px", fontSize: 10, width: "100%" })}><option>Must</option><option>Should</option><option>Nice-to-Have</option></select>
                  : <span key="p" style={{ color: PRI_C[r.pri], fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.pri}{editBadge("reqs", i, "pri")}</span>,
                isActive
                  ? <input key="d" value={r.desc} onChange={function(e) { updateReq(i, "desc", e.target.value); }} style={Object.assign({}, inpSt, { fontSize: 11, width: "100%" })} />
                  : <span key="d" style={{ color: TH.text0, fontSize: 12 }}>{r.desc}{editBadge("reqs", i, "desc")}</span>,
              ].concat(isActive ? [
                <button key="x" onClick={function() { removeReq(i); }} style={{ background: "none", border: "none", color: TH.red, cursor: "pointer", fontSize: 13, padding: 0 }} title="Remove requirement">×</button>,
              ] : []);
            })}
          />
          {isActive && (
            <div style={{ marginTop: 14 }}>
              {!showAdd ? (
                <Btn variant="secondary" onClick={function() { setShowAdd(true); }}>+ Add Requirement</Btn>
              ) : (
                <div style={{ background: TH.bg0, border: "1px solid " + TH.accent, borderRadius: 4, padding: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div>
                    <Label>Category</Label>
                    <select value={newReq.cat} onChange={function(e) { setNewReq(function(p2) { return Object.assign({}, p2, { cat: e.target.value }); }); }} style={inpSt}>
                      {CANONICAL_CATS.map(function(c) { return <option key={c}>{c}</option>; })}
                    </select>
                  </div>
                  <div>
                    <Label>Priority</Label>
                    <select value={newReq.pri} onChange={function(e) { setNewReq(function(p2) { return Object.assign({}, p2, { pri: e.target.value }); }); }} style={inpSt}>
                      <option>Must</option><option>Should</option><option>Nice-to-Have</option>
                    </select>
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <Label>Description</Label>
                    <input
                      value={newReq.desc}
                      onChange={function(e) { setNewReq(function(p2) { return Object.assign({}, p2, { desc: e.target.value }); }); }}
                      onKeyDown={function(e) { if (e.key === "Enter") addReq(); }}
                      placeholder="The module shall…"
                      style={Object.assign({}, inpSt, { width: "100%" })}
                    />
                  </div>
                  <Btn onClick={addReq}>Add</Btn>
                  <Btn variant="secondary" onClick={function() { setShowAdd(false); }}>Cancel</Btn>
                </div>
              )}
            </div>
          )}
          {isActive && onPropagate && (
            <div style={{ marginTop: 10 }}>
              <Btn variant="secondary" onClick={function() { onPropagate("reqs"); }} disabled={propagating} style={{ fontSize: 10 }}>
                {propagating ? "⏳ Propagating…" : "🔄 Propagate to Interface & Parameters"}
              </Btn>
            </div>
          )}
        </div>
      )}

      {sub === "iface" && (
        <div>
          <DataTable
            columns={isActive ? ["Port", "Dir", "Width", "Description", ""] : ["Port", "Dir", "Width", "Description"]}
            gridCols={isActive ? "120px 80px 130px 1fr 30px" : "120px 70px 140px 1fr"}
            rows={iface.map(function(p, i) {
              if (isActive) {
                return [
                  cellEdit(p.name, function(v) { updatePort(i, "name", v); }),
                  <select key="d" value={p.dir} onChange={function(e) { updatePort(i, "dir", e.target.value); }} style={Object.assign({}, inpSt, { padding: "4px 6px", fontSize: 11, width: "100%" })}>
                    <option value="input">input</option><option value="output">output</option><option value="inout">inout</option>
                  </select>,
                  cellEdit(p.width, function(v) { updatePort(i, "width", v); }),
                  cellEdit(p.desc, function(v) { updatePort(i, "desc", v); }),
                  <button key="x" onClick={function() { removePort(i); }} style={{ background: "none", border: "none", color: TH.red, cursor: "pointer", fontSize: 13, padding: 0 }} title="Remove port">×</button>,
                ];
              }
              return [
                <span key="n" style={{ color: TH.accent, fontWeight: 600 }}>{p.name}{editBadge("iface", i, "name")}</span>,
                <span key="d" style={{ color: p.dir === "input" ? TH.blue : TH.orange }}>{p.dir}{editBadge("iface", i, "dir")}</span>,
                <span key="w" style={{ color: TH.text0 }}>{p.width}{editBadge("iface", i, "width")}</span>,
                <span key="desc" style={{ color: TH.text1 }}>{p.desc}{editBadge("iface", i, "desc")}</span>,
              ];
            })}
          />
          {isActive && (
            <div style={{ marginTop: 14 }}>
              {!showAddPort ? (
                <Btn variant="secondary" onClick={function() { setShowAddPort(true); }}>+ Add Port</Btn>
              ) : (
                <div style={{ background: TH.bg0, border: "1px solid " + TH.accent, borderRadius: 4, padding: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div>
                    <Label>Name</Label>
                    <input value={newPort.name} onChange={function(e) { setNewPort(function(p2) { return Object.assign({}, p2, { name: e.target.value }); }); }} placeholder="signal_name" style={inpSt} />
                  </div>
                  <div>
                    <Label>Dir</Label>
                    <select value={newPort.dir} onChange={function(e) { setNewPort(function(p2) { return Object.assign({}, p2, { dir: e.target.value }); }); }} style={inpSt}>
                      <option>input</option><option>output</option><option>inout</option>
                    </select>
                  </div>
                  <div>
                    <Label>Width</Label>
                    <input value={newPort.width} onChange={function(e) { setNewPort(function(p2) { return Object.assign({}, p2, { width: e.target.value }); }); }} placeholder="1" style={Object.assign({}, inpSt, { width: 80 })} />
                  </div>
                  <div style={{ flex: 1, minWidth: 150 }}>
                    <Label>Description</Label>
                    <input
                      value={newPort.desc}
                      onChange={function(e) { setNewPort(function(p2) { return Object.assign({}, p2, { desc: e.target.value }); }); }}
                      onKeyDown={function(e) { if (e.key === "Enter") addPort(); }}
                      placeholder="Port description"
                      style={Object.assign({}, inpSt, { width: "100%" })}
                    />
                  </div>
                  <Btn onClick={addPort}>Add</Btn>
                  <Btn variant="secondary" onClick={function() { setShowAddPort(false); }}>Cancel</Btn>
                </div>
              )}
            </div>
          )}
          {isActive && onPropagate && (
            <div style={{ marginTop: 10 }}>
              <Btn variant="secondary" onClick={function() { onPropagate("iface"); }} disabled={propagating} style={{ fontSize: 10 }}>
                {propagating ? "⏳ Propagating…" : "🔄 Propagate to Requirements & Parameters"}
              </Btn>
            </div>
          )}
        </div>
      )}

      {sub === "params" && (
        <div>
          <DataTable
            columns={isActive ? ["Name", "Type", "Default", "Range", "Description", ""] : ["Name", "Type", "Default", "Range", "Description"]}
            gridCols={isActive ? "100px 80px 70px 140px 1fr 30px" : "100px 80px 70px 160px 1fr"}
            rows={params.map(function(p, i) {
              if (isActive) {
                return [
                  cellEdit(p.name, function(v) { updateParam(i, "name", v); }),
                  <select key="t" value={p.type || "parameter"} onChange={function(e) { updateParam(i, "type", e.target.value); }} style={Object.assign({}, inpSt, { padding: "4px 6px", fontSize: 11, width: "100%" })}>
                    <option>parameter</option><option>localparam</option>
                  </select>,
                  cellEdit(String(p.def != null ? p.def : ""), function(v) { updateParam(i, "def", v); }),
                  cellEdit(p.range || "", function(v) { updateParam(i, "range", v); }),
                  cellEdit(p.desc || "", function(v) { updateParam(i, "desc", v); }),
                  <button key="x" onClick={function() { removeParam(i); }} style={{ background: "none", border: "none", color: TH.red, cursor: "pointer", fontSize: 13, padding: 0 }} title="Remove parameter">×</button>,
                ];
              }
              return [
                <span key="n" style={{ color: TH.yellow, fontWeight: 600 }}>{p.name}{editBadge("params", i, "name")}</span>,
                <span key="t">{p.type}{editBadge("params", i, "type")}</span>,
                <span key="d" style={{ color: TH.accent }}>{p.def}{editBadge("params", i, "def")}</span>,
                <span key="r" style={{ color: TH.text1 }}>{p.range}{editBadge("params", i, "range")}</span>,
                <span key="desc" style={{ color: TH.text1 }}>{p.desc}{editBadge("params", i, "desc")}</span>,
              ];
            })}
          />
          {isActive && (
            <div style={{ marginTop: 14 }}>
              {!showAddParam ? (
                <Btn variant="secondary" onClick={function() { setShowAddParam(true); }}>+ Add Parameter</Btn>
              ) : (
                <div style={{ background: TH.bg0, border: "1px solid " + TH.accent, borderRadius: 4, padding: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div>
                    <Label>Name</Label>
                    <input value={newParam.name} onChange={function(e) { setNewParam(function(p2) { return Object.assign({}, p2, { name: e.target.value }); }); }} placeholder="PARAM_NAME" style={inpSt} />
                  </div>
                  <div>
                    <Label>Type</Label>
                    <select value={newParam.type} onChange={function(e) { setNewParam(function(p2) { return Object.assign({}, p2, { type: e.target.value }); }); }} style={inpSt}>
                      <option>parameter</option><option>localparam</option>
                    </select>
                  </div>
                  <div>
                    <Label>Default</Label>
                    <input value={newParam.def} onChange={function(e) { setNewParam(function(p2) { return Object.assign({}, p2, { def: e.target.value }); }); }} placeholder="8" style={Object.assign({}, inpSt, { width: 70 })} />
                  </div>
                  <div>
                    <Label>Range</Label>
                    <input value={newParam.range} onChange={function(e) { setNewParam(function(p2) { return Object.assign({}, p2, { range: e.target.value }); }); }} placeholder="[1:1024]" style={Object.assign({}, inpSt, { width: 100 })} />
                  </div>
                  <div style={{ flex: 1, minWidth: 150 }}>
                    <Label>Description</Label>
                    <input
                      value={newParam.desc}
                      onChange={function(e) { setNewParam(function(p2) { return Object.assign({}, p2, { desc: e.target.value }); }); }}
                      onKeyDown={function(e) { if (e.key === "Enter") addParam(); }}
                      placeholder="Parameter description"
                      style={Object.assign({}, inpSt, { width: "100%" })}
                    />
                  </div>
                  <Btn onClick={addParam}>Add</Btn>
                  <Btn variant="secondary" onClick={function() { setShowAddParam(false); }}>Cancel</Btn>
                </div>
              )}
            </div>
          )}
          {isActive && onPropagate && (
            <div style={{ marginTop: 10 }}>
              <Btn variant="secondary" onClick={function() { onPropagate("params"); }} disabled={propagating} style={{ fontSize: 10 }}>
                {propagating ? "⏳ Propagating…" : "🔄 Propagate to Requirements & Interface"}
              </Btn>
            </div>
          )}
        </div>
      )}
      {sub === "runlog" && <LogTab data={data} stageKey="spec" stageLabel="Spec" />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ArchStage — micro-architecture strategy + mermaid block diagram
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   data : { strategy, description, blocks, mermaid }
//
// ⚠ Browser-only: the Mermaid tab dynamically injects a CDN script into
// document.head and calls window.mermaid.render(). This will throw in
// non-DOM environments. The `arch` tab (default) is pure and SSR-safe.
export function ArchStage({ data, spec }) {
  const blocks = data.blocks || [];
  const mc = data.mermaid || "";
  // "Module View" tab — shows the module's interface as an SVG box with inputs
  // on the left, outputs on the right, and the parameters
  // list below. Only rendered when `spec` is available (caller passes
  // stageData[2]); when absent we hide the tab to avoid a confusing
  // blank panel.
  const hasModuleView = spec && (
    (Array.isArray(spec.iface) && spec.iface.length > 0) ||
    (Array.isArray(spec.params) && spec.params.length > 0)
  );
  const [sub, setSub] = useState("arch");
  const mRef = useRef(null);
  const [mReady, setMReady] = useState(false);

  useEffect(function() {
    if (sub !== "mermaid" || mReady) return;
    if (typeof window !== "undefined" && window.mermaid) {
      setMReady(true);
      return;
    }
    if (typeof document === "undefined") return;
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js";
    s.onload = function() {
      window.mermaid.initialize({ startOnLoad: false, theme: "dark" });
      setMReady(true);
    };
    document.head.appendChild(s);
  }, [sub, mReady]);

  useEffect(function() {
    if (sub !== "mermaid" || !mReady || !mRef.current || !mc) return;
    if (typeof window === "undefined" || !window.mermaid) return;
    mRef.current.innerHTML = "";
    const code = mc.replace(/\\n/g, "\n");
    window.mermaid.render("mg-" + Date.now(), code)
      .then(function(r) {
        if (mRef.current) mRef.current.innerHTML = r.svg;
      })
      .catch(function(err) {
        if (mRef.current) {
          mRef.current.innerHTML = '<pre style="color:' + TH.red + ';font-size:11px;white-space:pre-wrap">Mermaid error: ' + err.message + '</pre>';
        }
      });
  }, [sub, mReady, mc]);

  return (
    <div>
      <SubTab
        tabs={(function() {
          const tabs = [
            { id: "arch",    label: "Micro-Architecture" },
            { id: "mermaid", label: "Block Diagram" },
          ];
          if (hasModuleView) tabs.push({ id: "module", label: "Module View" });
          // Per-step Log panel (last tab)
          tabs.push({ id: "runlog", label: "Log" });
          return tabs;
        })()}
        active={sub}
        onChange={setSub}
      />
      {sub === "module" && hasModuleView && (
        <ModuleInterfaceView spec={spec} modName={(spec && (spec.modName || spec.moduleName)) || "module"} />
      )}
      {sub === "runlog" && <LogTab data={data} stageKey="architect" stageLabel="Architect" />}
      {sub === "arch" && (
        <div>
          <div style={{ fontSize: 15, color: TH.text0, fontWeight: 700, fontFamily: TH.fontD, marginBottom: 6 }}>
            {data.strategy}
          </div>
          <p style={{ color: TH.text1, fontSize: 12, lineHeight: 1.6, margin: "0 0 16px" }}>
            {data.description}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {blocks.map(function(b, i) {
              return (
                <div key={i} style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: 12 }}>
                  <div style={{ fontSize: 12, color: TH.accent, fontWeight: 600, marginBottom: 3 }}>{b.name}</div>
                  <div style={{ fontSize: 11, color: TH.text1 }}>{b.desc}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {sub === "mermaid" && (
        <div
          ref={mRef}
          style={{
            background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6,
            padding: 24, minHeight: 220, display: "flex", alignItems: "center",
            justifyContent: "center", overflow: "auto",
          }}
        >
          {!mReady && <Spinner text="Loading Mermaid.js…" />}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ModuleInterfaceView — single-module port + parameter visualization
//
// Renders the module as a labeled SVG box:
//   - Inputs on the LEFT side as horizontal lines with the signal name
//     above each line and its width annotation (e.g. "[DATA_W-1:0]")
//     below.
//   - Outputs on the RIGHT side, mirror-symmetric layout.
//   - "clk" and "rst*" ports get visually distinguished (smaller, dim)
//     so they stay in the corner and don't dominate the diagram.
//   - Parameters listed beneath the box, one per line: NAME = default
//     (range)  description.
//
// Data source: spec.iface (ports) + spec.params. Both come from the
// spec stage output that the parent (RTLForge.jsx) now passes through.
//
// The view is fully derived — no separate stage data. It re-renders
// automatically when spec changes.
//
// Design notes:
//   - The box is centered horizontally. Width auto-fits to the longest
//     port name (with a sane min/max).
//   - Vertical spacing is based on max(inputs, outputs) so both columns
//     align visually.
//   - When there are MANY ports (>14 per side), we shrink the row
//     spacing and font slightly rather than overflow.
// ═══════════════════════════════════════════════════════════════════════════
function ModuleInterfaceView({ spec, modName }) {
  // Defensive — caller (ArchStage) only renders this when hasModuleView,
  // but we still tolerate a missing/empty iface/params blob.
  const iface  = (spec && Array.isArray(spec.iface))  ? spec.iface  : [];
  const params = (spec && Array.isArray(spec.params)) ? spec.params : [];

  // Split ports into inputs vs outputs by direction. We treat anything
  // not explicitly "output" or "inout" as input — the spec stage should
  // produce a `dir` field but some legacy specs use synonyms.
  const inputs  = iface.filter(function(p) {
    const d = (p.dir || "").toLowerCase();
    return d === "input" || d === "in" || d === "";
  });
  const outputs = iface.filter(function(p) {
    const d = (p.dir || "").toLowerCase();
    return d === "output" || d === "out" || d === "inout";
  });

  // Sort clock/reset-style ports to the top of inputs so they read
  // naturally (matches conventional schematic placement).
  function clkRstPriority(p) {
    const n = (p.name || "").toLowerCase();
    if (n === "clk" || n === "clock" || /(^|_)clk$/.test(n)) return 0;
    if (n === "rst" || n === "rst_n" || /(^|_)rst(_n)?$/.test(n)) return 1;
    return 2;
  }
  inputs.sort(function(a, b) {
    const pa = clkRstPriority(a), pb = clkRstPriority(b);
    if (pa !== pb) return pa - pb;
    return 0;
  });

  // Auto-fit sizing
  const portRows  = Math.max(inputs.length, outputs.length, 1);
  const dense     = portRows > 12;
  const rowH      = dense ? 24 : 32;
  const portFs    = dense ? 11 : 12;
  const widthFs   = dense ? 9  : 10;

  // Longest port name informs box width. We measure approximately:
  // average char width ~ portFs * 0.6.
  const longestName = Math.max(
    8,
    ...inputs.map(function(p) { return (p.name || "").length; }),
    ...outputs.map(function(p) { return (p.name || "").length; }),
  );
  const sideTextW = Math.min(220, Math.max(80, longestName * portFs * 0.62));
  const boxW = 220;
  const lineLen = 50;                              // horizontal stub from box to label
  const svgW = sideTextW + lineLen + boxW + lineLen + sideTextW + 30;  // padding
  const headerH = 48;
  const boxH = headerH + portRows * rowH + 16;
  const svgH = boxH + 40;
  const boxX = sideTextW + lineLen + 15;
  const boxY = 20;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, paddingTop: 4 }}>
      {/* ── SVG diagram ── */}
      <div style={{
        background: TH.bg0,
        border: "1px solid " + TH.border,
        borderRadius: 6,
        padding: 12,
        overflowX: "auto",
      }}>
        <svg
          width={svgW}
          height={svgH}
          viewBox={"0 0 " + svgW + " " + svgH}
          style={{ display: "block", margin: "0 auto", fontFamily: TH.fontMono || TH.font }}
          aria-label={"Module interface diagram for " + modName}
        >
          {/* Module box */}
          <rect
            x={boxX} y={boxY} width={boxW} height={boxH}
            rx={6} ry={6}
            fill={TH.bg1}
            stroke={TH.accent}
            strokeWidth={2}
          />
          {/* Module name header */}
          <text
            x={boxX + boxW / 2}
            y={boxY + 22}
            textAnchor="middle"
            fill={TH.text0}
            fontSize={14}
            fontWeight={700}
            fontFamily={TH.fontD}
          >
            {modName}
          </text>
          <line
            x1={boxX + 12} y1={boxY + 32}
            x2={boxX + boxW - 12} y2={boxY + 32}
            stroke={TH.border}
            strokeWidth={1}
          />

          {/* Input ports — left side */}
          {inputs.map(function(p, i) {
            const isClkRst = clkRstPriority(p) < 2;
            const portY = boxY + headerH + i * rowH;
            const labelColor = isClkRst ? TH.text2 : TH.text0;
            return (
              <g key={"in-" + i}>
                {/* Stub line from label to box */}
                <line
                  x1={boxX - lineLen} y1={portY}
                  x2={boxX} y2={portY}
                  stroke={TH.text2}
                  strokeWidth={1}
                />
                {/* Tiny direction arrow on the stub */}
                <polygon
                  points={
                    (boxX - 6) + "," + (portY - 3) + " " +
                    (boxX)     + "," + (portY)     + " " +
                    (boxX - 6) + "," + (portY + 3)
                  }
                  fill={TH.text2}
                />
                {/* Port name (above the line) */}
                <text
                  x={boxX - lineLen - 6} y={portY - 4}
                  textAnchor="end"
                  fill={labelColor}
                  fontSize={portFs}
                  fontWeight={isClkRst ? 400 : 600}
                >
                  {p.name}
                </text>
                {/* Width annotation (below the line) */}
                {p.width && p.width !== "1" && (
                  <text
                    x={boxX - lineLen - 6} y={portY + 11}
                    textAnchor="end"
                    fill={TH.text3}
                    fontSize={widthFs}
                    fontFamily={TH.fontMono}
                  >
                    [{String(p.width)}]
                  </text>
                )}
              </g>
            );
          })}

          {/* Output ports — right side */}
          {outputs.map(function(p, i) {
            const portY = boxY + headerH + i * rowH;
            const isInout = (p.dir || "").toLowerCase() === "inout";
            return (
              <g key={"out-" + i}>
                <line
                  x1={boxX + boxW} y1={portY}
                  x2={boxX + boxW + lineLen} y2={portY}
                  stroke={TH.text2}
                  strokeWidth={1}
                />
                <polygon
                  points={
                    (boxX + boxW + lineLen - 6) + "," + (portY - 3) + " " +
                    (boxX + boxW + lineLen)     + "," + (portY)     + " " +
                    (boxX + boxW + lineLen - 6) + "," + (portY + 3)
                  }
                  fill={TH.text2}
                />
                <text
                  x={boxX + boxW + lineLen + 6} y={portY - 4}
                  textAnchor="start"
                  fill={TH.text0}
                  fontSize={portFs}
                  fontWeight={600}
                >
                  {p.name}{isInout && (
                    <tspan dx={4} fill={TH.orange} fontSize={widthFs}>inout</tspan>
                  )}
                </text>
                {p.width && p.width !== "1" && (
                  <text
                    x={boxX + boxW + lineLen + 6} y={portY + 11}
                    textAnchor="start"
                    fill={TH.text3}
                    fontSize={widthFs}
                    fontFamily={TH.fontMono}
                  >
                    [{String(p.width)}]
                  </text>
                )}
              </g>
            );
          })}

          {/* Empty-state message inside the box if no ports */}
          {iface.length === 0 && (
            <text
              x={boxX + boxW / 2} y={boxY + boxH / 2 + 4}
              textAnchor="middle"
              fill={TH.text2}
              fontSize={11}
              fontStyle="italic"
            >
              (no interface ports declared)
            </text>
          )}
        </svg>
      </div>

      {/* ── Parameters list ── */}
      <div>
        <div style={{
          fontSize: 9, color: TH.text3, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: 1, marginBottom: 8,
        }}>
          Parameters ({params.length})
        </div>
        {params.length === 0 ? (
          <div style={{
            fontSize: 11, color: TH.text2, fontStyle: "italic",
            padding: "8px 12px", background: TH.bg0,
            border: "1px dashed " + TH.border, borderRadius: 4,
          }}>
            (no parameters declared)
          </div>
        ) : (
          <div style={{
            background: TH.bg0,
            border: "1px solid " + TH.border,
            borderRadius: 4,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}>
            {params.map(function(p, i) {
              return (
                <div key={i} style={{
                  display: "flex", gap: 10, alignItems: "baseline",
                  fontSize: 12, lineHeight: 1.4,
                }}>
                  <code style={{
                    color: TH.accent, fontWeight: 600,
                    fontFamily: TH.fontMono, minWidth: 110,
                  }}>
                    {p.name}
                  </code>
                  <span style={{ color: TH.text1, fontFamily: TH.fontMono, fontSize: 11 }}>
                    = {String(p.def != null ? p.def : "?")}
                    {p.range && (
                      <span style={{ color: TH.text3, marginLeft: 4 }}>
                        {p.range}
                      </span>
                    )}
                  </span>
                  <span style={{ color: TH.text1, flex: 1, fontFamily: TH.font }}>
                    {p.desc || <em style={{ color: TH.text3 }}>(no description)</em>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FormalPropsStage — SVA assertions + auto constraints + cover + bind module
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   data : { properties, autoAssumptions, covers, bind_module }
//
// Adds an "auto" tab only when there are auto-derived constraints; the
// base tabs are props / covers / bind. Note: the tab ordering matches
// `auto` is inserted at index 1 (between props and covers).
export function FormalPropsStage({ data }) {
  const props           = data.properties || [];
  const covers          = data.covers || [];
  const autoAssumptions = data.autoAssumptions || [];
  const [sub, setSub] = useState("props");

  const tabs = [
    { id: "props",  label: "SVA Assertions",   count: props.length },
    { id: "covers", label: "Cover Statements", count: covers.length },
    { id: "bind",   label: "Bind Module" },
  ];
  if (autoAssumptions.length > 0) {
    tabs.splice(1, 0, { id: "auto", label: "Auto Constraints", count: autoAssumptions.length });
  }
  // Per-step Log panel (last tab)
  tabs.push({ id: "runlog", label: "Log" });

  return (
    <div>
      <SubTab tabs={tabs} active={sub} onChange={setSub} />
      {sub === "props" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.map(function(p) {
            return (
              <div key={p.id} style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: 14 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <Tag color={TH.accent} bg={TH.accentDim}>{p.id}</Tag>
                  <Tag color={TH.blue} bg={TH.blueDim}>{p.req}</Tag>
                  <Tag color={TH.orange} bg={TH.orangeDim}>{p.type || "assert"}</Tag>
                  <span style={{ fontSize: 12, color: TH.text0, fontWeight: 600 }}>{p.name}</span>
                </div>
                <div style={{ fontSize: 11, color: TH.text1, marginBottom: 8 }}>{p.desc}</div>
                <CodeBlock code={p.code} maxH={100} />
              </div>
            );
          })}
          {props.length === 0 && (
            <div style={{ color: TH.text2, fontSize: 12, padding: 20, textAlign: "center" }}>
              No properties generated.
            </div>
          )}
        </div>
      )}
      {sub === "auto" && (
        <div>
          <div style={{
            padding: "10px 14px", borderRadius: 5, background: TH.blueDim,
            border: "1px solid rgba(56,189,248,.25)", fontSize: 11, color: TH.blue,
            lineHeight: 1.6, marginBottom: 12,
          }}>
            These constraints were auto-derived from spec parameter ranges and interface widths — no LLM call needed. They are included in the SVA export automatically.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {autoAssumptions.map(function(a) {
              return (
                <div key={a.id} style={{
                  background: TH.bg0,
                  border: "1px solid rgba(56,189,248,.3)",
                  borderLeft: "3px solid " + TH.blue,
                  borderRadius: 4, padding: 14,
                }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <Tag color={TH.blue} bg={TH.blueDim}>{a.id}</Tag>
                    <Tag color={TH.blue} bg={TH.blueDim}>assume</Tag>
                    <span style={{ fontSize: 11, color: TH.text1 }}>{a.source}</span>
                  </div>
                  <CodeBlock code={a.code} maxH={80} />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {sub === "covers" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {covers.map(function(c) {
            return (
              <div key={c.id} style={{ background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: 14 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <Tag color={TH.green} bg="rgba(52,211,153,.12)">{c.id}</Tag>
                  {c.req && <Tag color={TH.blue} bg={TH.blueDim}>{c.req}</Tag>}
                  <span style={{ fontSize: 12, color: TH.text0, fontWeight: 600 }}>{c.name}</span>
                </div>
                <div style={{ fontSize: 11, color: TH.text1, marginBottom: 8 }}>{c.desc}</div>
                <CodeBlock code={c.code} maxH={80} />
              </div>
            );
          })}
        </div>
      )}
      {sub === "bind" && (
        <CodeBlock code={data.bind_module || "// No bind statement generated"} maxH={200} />
      )}
      {sub === "runlog" && <LogTab data={data} stageKey="formal_props" stageLabel="SVA Props" />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LintStage — lint results, fix-loop iteration history, raw CLI log
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   data                : { status, tool, iteration, cli, summary, errors,
//                           warnings, iterations, log, _fullLog, _cliError }
//   warningsAsErrors    : boolean — when true, warnings trigger fix loops
//   setWarningsAsErrors : setter for the toggle
//
// Three sub-tabs: "Results" (current state + errors/warnings list),
// "Fix Loop" (iteration history with classification badges), "CLI Output"
// (raw lint log). The header shows status, tool, iteration count, and a
// "Real CLI" vs "AI Estimated" indicator depending on whether the data
// came from a real backend or LLM estimation.
export function LintStage({ data, warningsAsErrors, setWarningsAsErrors, maxIters, label }) {
  const _maxLintIters = maxIters || MAX_LINT_ITERS;
  const _stageLabel = label || "Lint";
  const [sub, setSub] = useState("result");
  const [expandedIter, setExpandedIter] = useState(null);
  const iterations = data.iterations || [];
  return (
    <div>
      <SubTab
        tabs={[
          { id: "result",     label: "Results" },
          { id: "iterations", label: "Fix Loop (" + iterations.length + " iter)" },
          { id: "log",        label: "CLI Output" },
          // Per-step Log panel (LLM exchanges, prompts, tokens)
          { id: "runlog",     label: "Log" },
        ]}
        active={sub}
        onChange={setSub}
      />
      {sub === "result" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <Tag
              color={data.status === "PASS" ? TH.accent : TH.red}
              bg={data.status === "PASS" ? TH.accentDim : TH.redDim}
            >
              {data.status}
            </Tag>
            <Tag>{data.tool}</Tag>
            <Tag color={TH.blue} bg={TH.blueDim}>
              Iteration {data.iteration || 1}/{_maxLintIters}
            </Tag>
            {data.cli && <Tag color={TH.green} bg="rgba(52,211,153,.12)">Real CLI</Tag>}
            {!data.cli && <Tag color={TH.orange} bg={TH.orangeDim}>⚠ AI Estimated</Tag>}
            <button
              onClick={function() { setWarningsAsErrors(!warningsAsErrors); }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                fontFamily: TH.font, cursor: "pointer",
                background: warningsAsErrors ? TH.redDim : TH.bg0,
                border: "1px solid " + (warningsAsErrors ? TH.red : TH.border),
                color: warningsAsErrors ? TH.red : TH.text2,
              }}
              title={warningsAsErrors ? "Warnings trigger loop-back (click to lower)" : "Warnings are informational (click to raise)"}
            >
              {warningsAsErrors ? "⚠ Warnings = Errors" : "⚠ Warnings = Info"}
            </button>
          </div>
          {!data.cli && data._cliError && (
            <div style={{
              padding: "8px 12px", borderRadius: 4, background: TH.redDim,
              border: "1px solid rgba(248,113,113,.25)", fontSize: 11, color: TH.red,
              lineHeight: 1.6, marginBottom: 14,
            }}>
              {"⚠ Backend configured but unreachable: " + data._cliError + " — Falling back to LLM estimation. Ensure backend is running (node backend.js) with CORS enabled."}
            </div>
          )}
          {!data.cli && !data._cliError && (
            <div style={{
              padding: "8px 12px", borderRadius: 4, background: TH.orangeDim,
              border: "1px solid rgba(251,146,60,.2)", fontSize: 11, color: TH.orange,
              lineHeight: 1.6, marginBottom: 14,
            }}>
              {"No CLI backend connected — lint results are LLM-estimated, not real Verilator output. Configure a backend URL in ⚙ Settings → CLI for real analysis."}
            </div>
          )}
          <div style={{ fontSize: 12, color: TH.text1, marginBottom: 14 }}>{data.summary}</div>
          {(data.errors || []).map(function(w, i) {
            return (
              <div key={"e" + i} style={{
                display: "flex", gap: 8, alignItems: "center", padding: 10,
                background: TH.redDim, borderRadius: 4, border: "1px solid " + TH.red,
                marginBottom: 4,
              }}>
                <Tag color={TH.red} bg={TH.redDim}>error</Tag>
                <span style={{ color: TH.text2, fontSize: 11 }}>L{w.line}</span>
                <Tag color={TH.blue} bg={TH.blueDim}>{w.code}</Tag>
                <span style={{ color: TH.red, fontSize: 11, flex: 1 }}>{w.msg}</span>
              </div>
            );
          })}
          {(data.warnings || []).map(function(w, i) {
            return (
              <div key={"w" + i} style={{
                display: "flex", gap: 8, alignItems: "center", padding: 10,
                background: TH.bg0, borderRadius: 4, border: "1px solid " + TH.border,
                marginBottom: 4,
              }}>
                <Tag color={TH.yellow} bg={TH.yellowDim}>{w.sev}</Tag>
                <span style={{ color: TH.text2, fontSize: 11 }}>L{w.line}</span>
                <Tag color={TH.blue} bg={TH.blueDim}>{w.code}</Tag>
                <span style={{ color: TH.text0, fontSize: 11, flex: 1 }}>{w.msg}</span>
              </div>
            );
          })}
        </div>
      )}
      {sub === "iterations" && (
        <div>
          <div style={{ fontSize: 12, color: TH.text1, marginBottom: 12 }}>
            The {_stageLabel.toLowerCase()} stage runs up to {_maxLintIters} iterations. When errors are found, the {_stageLabel === "Lint Test" ? "testbench" : "RTL"} is automatically fixed and re-linted.
          </div>
          {iterations.map(function(it) {
            const isExp = expandedIter === it.iter;
            return (
              <div key={it.iter} style={{
                background: TH.bg0,
                border: "1px solid " + (isExp ? TH.accent : TH.border), borderRadius: 4, marginBottom: 6,
                overflow: "hidden",
              }}>
                <div
                  onClick={function() { setExpandedIter(isExp ? null : it.iter); }}
                  style={{
                    display: "flex", gap: 12, alignItems: "center",
                    padding: "10px 14px", cursor: "pointer",
                  }}
                >
                  <span style={{ color: TH.text3, fontSize: 8, width: 12, flexShrink: 0, transform: isExp ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
                  <Tag color={TH.blue} bg={TH.blueDim}>Iter {it.iter}</Tag>
                  <Tag
                    color={it.status === "PASS" ? TH.accent : TH.red}
                    bg={it.status === "PASS" ? TH.accentDim : TH.redDim}
                  >
                    {it.status}
                  </Tag>
                  <span style={{ fontSize: 11, color: TH.text1 }}>
                    {it.errors} errors, {it.warnings} warnings
                  </span>
                  {it.regression && (
                    <Tag color={TH.red} bg={TH.redDim}>
                      ⚠ {(it.classification && it.classification.patchDecision) || "REJECT_REGRESSION"}
                    </Tag>
                  )}
                  {it.classification && !it.regression && (
                    <span style={{ fontSize: 10, color: TH.text2, display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                      {it.classification.patchDecision && (
                        <Tag
                          color={
                            it.classification.patchDecision === "ACCEPT_PROGRESS"     ? TH.accent
                            : it.classification.patchDecision === "ACCEPT_EQUIVALENT"   ? TH.blue
                            : it.classification.patchDecision === "REJECT_NO_IMPROVEMENT" ? TH.text2
                            : TH.red
                          }
                          bg={
                            it.classification.patchDecision === "ACCEPT_PROGRESS"     ? TH.accentDim
                            : it.classification.patchDecision === "ACCEPT_EQUIVALENT"   ? TH.blueDim
                            : it.classification.patchDecision === "REJECT_NO_IMPROVEMENT" ? TH.bg3
                            : TH.redDim
                          }
                        >
                          {it.classification.patchDecision === "ACCEPT_PROGRESS"     ? "✓"
                           : it.classification.patchDecision === "ACCEPT_EQUIVALENT"   ? "≈"
                           : it.classification.patchDecision === "REJECT_NO_IMPROVEMENT" ? "○"
                           : "⚠"}{" "}
                          {it.classification.patchDecision.replace("REJECT_", "").replace("ACCEPT_", "")}
                        </Tag>
                      )}
                      {it.classification.resolved > 0 && <Tag color={TH.accent} bg={TH.accentDim}>{it.classification.resolved} resolved</Tag>}
                      {it.classification.revealed > 0 && <Tag color={TH.yellow} bg={TH.yellowDim}>{it.classification.revealed} revealed</Tag>}
                      {it.classification.introduced > 0 && <Tag color={TH.red} bg={TH.redDim}>{it.classification.introduced} introduced</Tag>}
                    </span>
                  )}
                  {it.iter < iterations.length && !it.regression && !it.classification && (
                    <Tag color={TH.yellow} bg={TH.yellowDim}>→ auto-fix applied</Tag>
                  )}
                </div>
                {/* Expanded detail: errors + warnings */}
                {isExp && (
                  <div style={{ borderTop: "1px solid " + TH.border, padding: "10px 14px" }}>
                    {(it.errorList || []).length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 9, color: TH.red, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Errors</div>
                        {it.errorList.map(function(e, ei) {
                          return (
                            <div key={"e" + ei} style={{
                              display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 10px",
                              background: TH.redDim, borderRadius: 3, marginBottom: 3, flexWrap: "wrap",
                            }}>
                              <Tag color={TH.blue} bg={TH.blueDim}>{e.code || "ERR"}</Tag>
                              <span style={{ color: TH.text3, fontSize: 10, flexShrink: 0 }}>L{e.line || "?"}</span>
                              <span style={{ color: TH.red, fontSize: 11, flex: 1 }}>{e.msg || e.message || JSON.stringify(e)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {(it.warningList || []).length > 0 && (
                      <div>
                        <div style={{ fontSize: 9, color: TH.yellow, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Warnings</div>
                        {it.warningList.map(function(w, wi) {
                          return (
                            <div key={"w" + wi} style={{
                              display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 10px",
                              background: TH.bg1, borderRadius: 3, marginBottom: 3, flexWrap: "wrap",
                            }}>
                              <Tag color={TH.blue} bg={TH.blueDim}>{w.code || "WARN"}</Tag>
                              <span style={{ color: TH.text3, fontSize: 10, flexShrink: 0 }}>L{w.line || "?"}</span>
                              <span style={{ color: TH.text0, fontSize: 11, flex: 1 }}>{w.msg || w.message || JSON.stringify(w)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {(it.errorList || []).length === 0 && (it.warningList || []).length === 0 && (
                      <div style={{ color: TH.text3, fontSize: 11, textAlign: "center", padding: 10 }}>No detailed diagnostics stored for this iteration.</div>
                    )}
                    {/* Structured viewer: parsed JSON, fixes list, before/after
                        side-by-side with SV syntax highlight, vdiff toggle. */}
                    {it._structured && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid " + TH.border }}>
                        <StructuredFixViewer
                          structured={it._structured}
                          title={"Fix details for iteration " + it.iter}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {iterations.length === 0 && (
            <div style={{ color: TH.text2, fontSize: 12, padding: 20, textAlign: "center" }}>
              No iteration data yet.
            </div>
          )}
        </div>
      )}
      {sub === "log" && (function() {
        const fullLog = data._fullLog || data.log || "No log available.";
        // When the user has selected an iteration in the Fix Loop tab, the CLI
        // Output tab should show that iteration's log. When
        // nothing is selected, fall back to the last iteration's log.
        //
        // We support both "Lint" and "Lint Test" markers since the same
        // LintStage component renders both stages (id 6 and id 12).
        const marker = _stageLabel === "Lint Test"
          ? "━━━ Lint Test — iteration "
          : "━━━ Lint — iteration ";
        const parts = fullLog.split(marker);
        // parts[0] is the preamble before the first iteration marker;
        // parts[1..] each begin with "<iter>/<max>\n…"
        if (parts.length <= 1) return <CodeBlock code={fullLog} />;

        let chosenIdx;
        if (expandedIter != null) {
          // expandedIter is 1-based; parts[1] is iter 1, parts[2] is iter 2, etc.
          chosenIdx = Math.max(1, Math.min(expandedIter, parts.length - 1));
        } else {
          chosenIdx = parts.length - 1;   // last iteration
        }
        const chunk = marker + parts[chosenIdx];
        const header = expandedIter != null
          ? "━━━ Showing log for iteration " + expandedIter + " (selected in Fix Loop tab) ━━━\n\n"
          : "";
        return <CodeBlock code={header + chunk} />;
      })()}
      {sub === "runlog" && <LogTab data={data} stageKey={_stageLabel.toLowerCase().replace(/\s+/g, "_")} stageLabel={_stageLabel} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// VerifyStage — test results, coverage metrics, retry-loop history
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   data                : { pass, fail, total, cov, tests, log, cli,
//                           verifyHistory, _cliError, _covWarning }
//   warningsAsErrors    : boolean — true means low coverage triggers retry
//   setWarningsAsErrors : setter for the toggle
//
// Tabs: "Results" (metric cards + per-test table), "Simulation Log" (raw),
// "Retry Loop" (only shown when verifyHistory.length > 1, lists each retry
// iteration with triage outcome).
// ═══════════════════════════════════════════════════════════════════════════
// VerifyTestsByCategory
//
// Groups verify.tests[] entries by the category prefix of their `req`
// field (REQ-FUNC-* → Functionality, REQ-INTF-* → Interface, etc.) and
// renders one collapsible row per category.
//
// Each category row (collapsed) shows:
//   • category label, in the category's distinctive text color
//   • combined status: PASS iff every test in the group passed, else FAIL
//     followed by "<passing>/<total>" count
//   • summed cycle count across all tests in the group
//   • summed simulation time (ms)
//
// Clicking a category row expands it to show the original per-test view
// (name, status pill, cycles, time) — the same layout we had before.
//
// Categories use a fixed color map so the same prefix always renders in
// the same hue, making it easy to scan across runs. Tests without a
// req attribution fall into an "(Uncategorized)" bucket at the bottom.
// ═══════════════════════════════════════════════════════════════════════════
const VERIFY_CAT_COLORS = {
  Interface:     "#bfdcf2",  // light blue
  Functionality: "#ffd9a8",  // light orange
  Timing:        "#d4d4f7",  // light violet
  Error:         "#ffb8b8",  // light red
  Verification:  "#bfeebf",  // light green
};
const VERIFY_CAT_PREFIX_TO_LABEL = {
  INTF:  "Interface",
  FUNC:  "Functionality",
  TIME:  "Timing",
  ERR:   "Error",
  VERIF: "Verification",
};

function categorizeTest(test) {
  if (!test || !test.req || typeof test.req !== "string") return "Uncategorized";
  const m = /^REQ-([A-Z]+)-\d+/.exec(test.req);
  if (!m) return "Uncategorized";
  return VERIFY_CAT_PREFIX_TO_LABEL[m[1]] || "Uncategorized";
}

function VerifyTestsByCategory({ tests }) {
  // Group ascending: known categories first (in canonical order),
  // then Uncategorized last.
  const buckets = {};
  for (const t of tests) {
    const cat = categorizeTest(t);
    if (!buckets[cat]) buckets[cat] = [];
    buckets[cat].push(t);
  }
  const orderedCats = ["Interface", "Functionality", "Timing", "Error", "Verification"]
    .filter(function(c) { return buckets[c] && buckets[c].length > 0; });
  if (buckets["Uncategorized"]) orderedCats.push("Uncategorized");

  if (orderedCats.length === 0) {
    return (
      <div style={{
        padding: 24, textAlign: "center", color: TH.text2, fontSize: 12,
        fontStyle: "italic",
        background: TH.bg0, border: "1px dashed " + TH.border, borderRadius: 6,
      }}>
        No tests recorded for this run.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {orderedCats.map(function(cat) {
        return <VerifyCategoryRow key={cat} cat={cat} tests={buckets[cat]} />;
      })}
    </div>
  );
}

function VerifyCategoryRow({ cat, tests }) {
  const [open, setOpen] = useState(false);
  const passing = tests.filter(function(t) { return t.st === "PASS"; }).length;
  const total = tests.length;
  const allPass = passing === total;
  const cyc = tests.reduce(function(a, t) { return a + (t.cyc || 0); }, 0);
  const ms  = tests.reduce(function(a, t) { return a + (t.ms  || 0); }, 0);
  const catColor = VERIFY_CAT_COLORS[cat] || TH.text1;

  // Show the distinct requirement count in the cluster title:
  // "Interface (4 tests covering 2 requirements)". A test may
  // target multiple REQs (comma- or space-separated in t.req); a test
  // with no req attribution contributes to neither the numerator nor
  // the requirement set. The Uncategorized bucket simply shows test
  // count since by definition those tests have no REQ.
  const reqSet = new Set();
  for (const t of tests) {
    if (!t || !t.req) continue;
    // Split on common delimiters to support multi-target annotations
    // like "REQ-FUNC-001, REQ-FUNC-002" or "REQ-FUNC-001 REQ-FUNC-002"
    const ids = String(t.req).split(/[,\s]+/).filter(function(x) {
      return /^REQ-[A-Z]+-\d+$/.test(x);
    });
    for (const id of ids) reqSet.add(id);
  }
  const reqCount = reqSet.size;
  const titleSuffix = (cat === "Uncategorized" || reqCount === 0)
    ? (total + " test" + (total === 1 ? "" : "s"))
    : (total + " test" + (total === 1 ? "" : "s") +
       " covering " + reqCount + " requirement" + (reqCount === 1 ? "" : "s"));

  return (
    <div style={{
      background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
      overflow: "hidden",
    }}>
      {/* Collapsed header row */}
      <div
        onClick={function() { setOpen(function(o) { return !o; }); }}
        style={{
          display: "grid", gridTemplateColumns: "20px 1fr 80px 90px 80px",
          alignItems: "center", gap: 10, padding: "8px 12px",
          cursor: "pointer", background: TH.bg1,
          fontSize: 12,
        }}
      >
        <span style={{ fontSize: 10, color: TH.text3 }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: catColor, fontWeight: 700, fontFamily: TH.fontD }}>
          {cat}
          <span style={{ color: TH.text3, marginLeft: 8, fontWeight: 400, fontSize: 10 }}>
            ({titleSuffix})
          </span>
        </span>
        <span>
          <Tag
            color={allPass ? TH.accent : TH.red}
            bg={allPass ? TH.accentDim : TH.redDim}
          >
            {allPass ? "PASS" : ("FAIL " + passing + "/" + total)}
          </Tag>
        </span>
        <span style={{ color: TH.text1, fontFamily: TH.fontMono, fontSize: 11, textAlign: "right" }}>
          {cyc} cycles
        </span>
        <span style={{ color: TH.text1, fontFamily: TH.fontMono, fontSize: 11, textAlign: "right" }}>
          {ms}ms
        </span>
      </div>
      {/* Expanded per-test detail — sub-cluster by target REQ ID. */}
      {open && (
        <div style={{ padding: "8px 12px", background: TH.bg0 }}>
          <VerifyReqSubclusters tests={tests} catColor={catColor} />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// VerifyReqSubclusters
//
// Inside each category cluster, tests are sub-grouped by their PRIMARY
// target REQ ID. A test with `req: "REQ-FUNC-001, REQ-FUNC-002"` is
// attributed to its FIRST target (REQ-FUNC-001) per the user's spec
// answer (Q1: "By target REQ ID only — simplest"). Tests with no
// req attribution surface under a "(No REQ attribution)" sub-bucket.
//
// Each sub-cluster row shows the REQ ID + per-test rows (name, status,
// cycles, time) using the same table shape as before. Sub-clusters
// stack vertically inside the parent category's expanded panel.
// ═══════════════════════════════════════════════════════════════════════════
function VerifyReqSubclusters({ tests, catColor }) {
  // Group by primary REQ ID. Keep ordering deterministic: REQ IDs
  // sorted ascending by their numeric suffix; "(No REQ)" at the end.
  const buckets = new Map();
  for (const t of tests) {
    let primaryReq = null;
    if (t && t.req && typeof t.req === "string") {
      const ids = t.req.split(/[,\s]+/).filter(function(x) {
        return /^REQ-[A-Z]+-\d+$/.test(x);
      });
      if (ids.length > 0) primaryReq = ids[0];
    }
    const key = primaryReq || "(No REQ attribution)";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }

  // Sort: real REQ IDs first (by category prefix, then numeric suffix),
  // No-REQ bucket last.
  const keys = Array.from(buckets.keys()).sort(function(a, b) {
    const aHas = a !== "(No REQ attribution)";
    const bHas = b !== "(No REQ attribution)";
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (!aHas) return 0;
    return a.localeCompare(b, undefined, { numeric: true });
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {keys.map(function(reqId) {
        const reqTests = buckets.get(reqId);
        const allPass  = reqTests.every(function(t) { return t.st === "PASS"; });
        const passCount = reqTests.filter(function(t) { return t.st === "PASS"; }).length;
        return (
          <div key={reqId} style={{
            border: "1px solid " + TH.border, borderRadius: 3,
            background: TH.bg1, overflow: "hidden",
          }}>
            <div style={{
              padding: "5px 10px",
              borderBottom: "1px solid " + TH.border,
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 11,
            }}>
              <span style={{
                color: catColor, fontWeight: 700, fontFamily: TH.fontMono,
              }}>
                {reqId}
              </span>
              <Tag
                color={allPass ? TH.accent : TH.red}
                bg={allPass ? TH.accentDim : TH.redDim}
              >
                {allPass ? "PASS" : ("FAIL " + passCount + "/" + reqTests.length)}
              </Tag>
              <span style={{ color: TH.text3, fontSize: 10 }}>
                {reqTests.length} test{reqTests.length === 1 ? "" : "s"}
              </span>
            </div>
            <DataTable
              columns={["Test", "Status", "Cycles", "Time"]}
              gridCols="1fr 80px 80px 70px"
              rows={reqTests.map(function(t) {
                return [
                  <span key="n" style={{ color: catColor }}>{t.name}</span>,
                  <Tag key="s" color={t.st === "PASS" ? TH.accent : TH.red} bg={t.st === "PASS" ? TH.accentDim : TH.redDim}>{t.st}</Tag>,
                  <span key="c" style={{ color: TH.text1 }}>{t.cyc}</span>,
                  <span key="m" style={{ color: TH.text1 }}>{t.ms}ms</span>,
                ];
              })}
            />
          </div>
        );
      })}
    </div>
  );
}

export function VerifyStage({ data, warningsAsErrors, setWarningsAsErrors, maxIters }) {
  const _maxVerifyIters = maxIters || MAX_VERIFY_ITERS;
  const [sub, setSub] = useState("result");
  const [expandedIter, setExpandedIter] = useState(null);
  const cov     = data.cov || {};
  const history = data.verifyHistory || [];
  // Tabs mirror LintStage — Results / Fix Loop (N iter) / Sim Log
  const tabs = [
    { id: "result", label: "Results" },
    { id: "iterations", label: "Fix Loop (" + Math.max(history.length, 1) + " iter)" },
    { id: "log",    label: "Simulation Log" },
    // Per-step Log panel (LLM exchanges, prompts, tokens)
    { id: "runlog", label: "Log" },
  ];

  return (
    <div>
      <SubTab tabs={tabs} active={sub} onChange={setSub} />
      {sub === "result" && (
        <div>
          <div style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
            <MetricCard
              label="Tests"
              value={(data.pass || 0) + "/" + (data.total || 0)}
              color={data.fail === 0 ? TH.accent : TH.red}
            />
            <MetricCard
              label="Line"
              value={(cov.line || 0) + "%"}
              color={(cov.line || 0) >= 90 ? TH.accent : TH.yellow}
            />
            <MetricCard
              label="Branch"
              value={(cov.branch || 0) + "%"}
              color={(cov.branch || 0) >= 85 ? TH.accent : TH.yellow}
            />
            <MetricCard
              label="Toggle"
              value={(cov.toggle || 0) + "%"}
              color={(cov.toggle || 0) >= 75 ? TH.accent : TH.yellow}
            />
            {data.cli && <MetricCard label="Source" value="Real CLI" color={TH.green} />}
            {!data.cli && <MetricCard label="Source" value="⚠ AI Est." color={TH.orange} />}
            {history.length > 1 && (
              <MetricCard
                label="Retries"
                value={(history.length - 1) + "/" + (_maxVerifyIters - 1)}
                color={TH.orange}
              />
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <button
              onClick={function() { setWarningsAsErrors(!warningsAsErrors); }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                fontFamily: TH.font, cursor: "pointer",
                background: warningsAsErrors ? TH.redDim : TH.bg0,
                border: "1px solid " + (warningsAsErrors ? TH.red : TH.border),
                color: warningsAsErrors ? TH.red : TH.text2,
              }}
              title={warningsAsErrors ? "Low coverage triggers loop-back (click to lower)" : "Coverage warnings are informational (click to raise)"}
            >
              {warningsAsErrors ? "⚠ Low Coverage = Error (line<80% / branch<70%)" : "⚠ Coverage = Info only"}
            </button>
            {data._covWarning && (
              <Tag color={TH.yellow} bg={TH.yellowDim}>⚠ Coverage below threshold triggered retry</Tag>
            )}
          </div>
          {data.cli && data._noMarkers && (
            <div style={{
              padding: "8px 12px", borderRadius: 4, background: TH.yellowDim,
              border: "1px solid rgba(251,191,36,.3)", fontSize: 11, color: TH.yellow,
              lineHeight: 1.6, marginBottom: 14,
            }}>
              {"⚠ Backend exited cleanly but printed no [PASS]/[FAIL] markers. " +
               "The testbench needs explicit $display(\"[PASS] <check>\") / $display(\"[FAIL] <check>\") lines, " +
               "or your simCmds need to invoke a self-checking flow."}
            </div>
          )}
          {!data.cli && data._cliError && (
            <div style={{
              padding: "8px 12px", borderRadius: 4, background: TH.orangeDim,
              border: "1px solid rgba(251,146,60,.2)", fontSize: 11, color: TH.orange,
              lineHeight: 1.6, marginBottom: 14,
            }}>
              {"No CLI backend connected — simulation results are LLM-estimated. Pass/fail verdicts, coverage numbers, and cycle counts are approximations, not real Verilator traces. Configure a backend URL in ⚙ Settings → CLI."}
            </div>
          )}
          {/* Group tests by REQ category for skim-ability.
              Each category collapses to a single row showing combined
              status, summed cycles, and summed ms time. Categories with
              all-PASS show green PASS; otherwise FAIL with count.
              Each category has its own text color so the user can scan
              across categories at a glance. Tests without a req field
              fall into an "(Uncategorized)" bucket. */}
          <VerifyTestsByCategory tests={data.tests || []} />
        </div>
      )}
      {sub === "log" && (function() {
        // Same per-iter log slicing pattern as LintStage. When the
        // user has selected an iteration in the Fix Loop tab, show that
        // iteration's log slice; otherwise show the last iteration.
        const fullLog = data._fullLog || data.log || "No log available.";
        const marker = "━━━ Verify — iteration ";
        const parts = fullLog.split(marker);
        if (parts.length <= 1) return <CodeBlock code={fullLog} />;
        let chosenIdx;
        if (expandedIter != null) {
          chosenIdx = Math.max(1, Math.min(expandedIter, parts.length - 1));
        } else {
          chosenIdx = parts.length - 1;
        }
        const chunk = marker + parts[chosenIdx];
        const header = expandedIter != null
          ? "━━━ Showing log for iteration " + expandedIter + " (selected in Fix Loop tab) ━━━\n\n"
          : "";
        return <CodeBlock code={header + chunk} />;
      })()}
      {sub === "iterations" && (
        <div>
          <div style={{ fontSize: 12, color: TH.text1, marginBottom: 12 }}>
            Verify ran {history.length} iteration{history.length === 1 ? "" : "s"} (configured max: {_maxVerifyIters}). Failures trigger triage → RTL or TB fix → re-simulation.
          </div>
          {history.length === 0 && (
            <div style={{ color: TH.text2, fontSize: 12, padding: 20, textAlign: "center" }}>No iteration data yet.</div>
          )}
          {history.map(function(h) {
            const isExp = expandedIter === h.iter;
            const cls = h.classification;
            return (
              <div key={h.iter} style={{
                background: TH.bg0,
                border: "1px solid " + (isExp ? TH.accent : TH.border),
                borderRadius: 4, marginBottom: 6, overflow: "hidden",
              }}>
                <div
                  onClick={function() { setExpandedIter(isExp ? null : h.iter); }}
                  style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 14px", cursor: "pointer" }}
                >
                  <span style={{
                    color: TH.text3, fontSize: 8, width: 12, flexShrink: 0,
                    transform: isExp ? "rotate(90deg)" : "none",
                    transition: "transform .15s",
                  }}>▶</span>
                  <Tag color={TH.blue} bg={TH.blueDim}>Iter {h.iter}</Tag>
                  <Tag
                    color={h.status === "PASS" ? TH.accent : TH.red}
                    bg={h.status === "PASS" ? TH.accentDim : TH.redDim}
                  >
                    {h.status}
                  </Tag>
                  <span style={{ fontSize: 11, color: TH.text1 }}>{h.pass}/{h.total} tests passed</span>
                  {h.triageTarget && <Tag color={TH.orange} bg={TH.orangeDim}>→ {h.triageTarget}</Tag>}
                  {cls && cls.patchDecision && (
                    <Tag
                      color={cls.patchDecision === "ACCEPT_PROGRESS" ? TH.accent
                          : cls.patchDecision === "ACCEPT_EQUIVALENT" ? TH.blue
                          : cls.patchDecision === "REJECT_NO_IMPROVEMENT" ? TH.text2
                          : TH.red}
                      bg={cls.patchDecision === "ACCEPT_PROGRESS" ? TH.accentDim
                        : cls.patchDecision === "ACCEPT_EQUIVALENT" ? TH.blueDim
                        : cls.patchDecision === "REJECT_NO_IMPROVEMENT" ? TH.bg3
                        : TH.redDim}
                    >
                      {cls.patchDecision === "ACCEPT_PROGRESS" ? "✓"
                       : cls.patchDecision === "ACCEPT_EQUIVALENT" ? "≈"
                       : cls.patchDecision === "REJECT_NO_IMPROVEMENT" ? "○"
                       : "⚠"}
                      {" " + cls.patchDecision.replace("REJECT_", "").replace("ACCEPT_", "")}
                    </Tag>
                  )}
                </div>
                {isExp && (
                  <div style={{ borderTop: "1px solid " + TH.border, padding: "10px 14px" }}>
                    {h.triageReason && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 9, color: TH.orange, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Triage Decision</div>
                        <div style={{ fontSize: 11, color: TH.text1, lineHeight: 1.5 }}>{h.triageReason}</div>
                      </div>
                    )}
                    {cls && (
                      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                        {cls.resolved > 0 && <Tag color={TH.accent} bg={TH.accentDim}>{cls.resolved} resolved</Tag>}
                        {cls.revealed > 0 && <Tag color={TH.yellow} bg={TH.yellowDim}>{cls.revealed} revealed</Tag>}
                        {cls.introduced > 0 && <Tag color={TH.red} bg={TH.redDim}>{cls.introduced} introduced</Tag>}
                        {cls.taskStatus && <Tag color={TH.text2} bg={TH.bg3}>{cls.taskStatus}</Tag>}
                      </div>
                    )}
                    {/* Structured viewer for the RTL-fix sub-call (verify can
                        do BOTH rtl-fix and tb-fix in one iter, so we render
                        them as separate viewers below the classification.) */}
                    {h._structured && h._structured.rtlFix && (
                      <div style={{ marginTop: 12 }}>
                        <StructuredFixViewer
                          structured={h._structured.rtlFix}
                          title={"RTL fix for iteration " + h.iter}
                        />
                      </div>
                    )}
                    {h._structured && h._structured.tbFix && (
                      <div style={{ marginTop: 12 }}>
                        <StructuredFixViewer
                          structured={h._structured.tbFix}
                          title={"TB fix for iteration " + h.iter}
                        />
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: TH.text3, lineHeight: 1.5, marginTop: 8 }}>
                      Click <strong style={{ color: TH.accent }}>Simulation Log</strong> tab to view this iteration's full log slice.
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {sub === "runlog" && <LogTab data={data} stageKey="verify" stageLabel="Verify" />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// JudgeStage — final verdict, traceability matrix, recommendations
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   data            : { overall, score, trace, recs, judgeHistory }
//   onExport        : callback for "Export Regression Suite" button
//   onExportPackage : callback for "Export as Package" button (v2 packages)
//
// Verdict tab shows a circular score ring with the overall PASS/FAIL.
// Trace tab is a table of requirements vs validation status.
// Recs tab is a bullet list of LLM recommendations.
// Iterations tab (only when judgeHistory > 1) shows how the judge loop
// converged, with each iteration's score and triage target.
export function JudgeStage({ data, stageData, onExport, onExportPackage, maxIters, onSelectRun }) {
  const _maxJudgeIters = maxIters || MAX_JUDGE_ITERS;
  const [sub, setSub] = useState("verdict");
  const trace   = data.trace || [];
  const recs    = data.recs || [];
  const history = data.judgeHistory || [];
  const tabs = [
    { id: "verdict", label: "Verdict" },
    { id: "trace",   label: "Traceability" },
    { id: "recs",    label: "Recommendations" },
  ];
  if (history.length >= 1) {
    // Even a single iteration is worth showing — it carries the per-criterion
    // eval breakdown telling the user which criteria fired and why.
    tabs.push({ id: "iterations", label: "Judge Loop (" + history.length + ")" });
  }
  // Duration + Tokens tabs. Only shown when we have a stageData blob to
  // aggregate from (Edit-mode renderings without pipeline runs don't have it).
  if (stageData) {
    tabs.push({ id: "duration",   label: "Duration"   });
    tabs.push({ id: "tokens",     label: "Tokens"     });
    // Execution trace tab. Distinct from the "Traceability" tab (which is
    // requirement→test trace); this one walks the pipeline execution: every
    // stage, every internal iteration, every loop-back, with the reason that
    // triggered each judge iteration.
    tabs.push({ id: "executrace", label: "Trace"      });
    // Per-step Log panel (last tab in every stage).
    tabs.push({ id: "log",        label: "Log"        });
  }
  const canExportPkg = data.overall === "PASS";

  return (
    <div>
      <SubTab tabs={tabs} active={sub} onChange={setSub} />
      {sub === "verdict" && (
        <div style={{ display: "flex", alignItems: "center", gap: 24, padding: 20 }}>
          <div style={{
            width: 86, height: 86, borderRadius: "50%",
            background: "conic-gradient(" + (data.overall === "PASS" ? TH.accent : TH.red) + " " + (data.score || 0) + "%, " + TH.bg3 + " " + (data.score || 0) + "%)",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <div style={{
              width: 66, height: 66, borderRadius: "50%", background: TH.bg2,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: TH.fontD, fontSize: 24, fontWeight: 800,
              color: data.overall === "PASS" ? TH.accent : TH.red,
            }}>
              {data.score || 0}
            </div>
          </div>
          <div>
            <div style={{
              fontSize: 26, fontWeight: 800,
              color: data.overall === "PASS" ? TH.accent : TH.red,
              fontFamily: TH.fontD,
            }}>
              {data.overall}
            </div>
            <div style={{ fontSize: 12, color: TH.text2, marginBottom: 6 }}>
              {trace.filter(function(t) { return t.ok; }).length}/{trace.length} requirements covered
            </div>
            {history.length > 1 && (
              <div style={{ fontSize: 11, color: TH.orange, marginBottom: 12 }}>
                Converged in {history.length} judge iteration{history.length > 1 ? "s" : ""}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn onClick={onExport}>📦 Export Regression Suite</Btn>
              <Btn
                variant="secondary"
                onClick={onExportPackage}
                disabled={!canExportPkg}
                style={{
                  opacity: canExportPkg ? 1 : 0.45,
                  cursor: canExportPkg ? "pointer" : "not-allowed",
                }}
                title={canExportPkg ? "Export as reusable v2 package" : "Module must pass validation to export as package"}
              >
                📤 Export as Package
              </Btn>
            </div>
          </div>
        </div>
      )}
      {sub === "trace" && (
        <DataTable
          columns={["Requirement", "Status", "Note"]}
          gridCols="130px 60px 1fr"
          rows={trace.map(function(t) {
            // Tri-state icon driven by `t.status`
            //   "ok"        → ✓ green   (positive evidence)
            //   "violated"  → ✗ red     (verify ran and failed for this category)
            //   "untested"  → ?  muted  (no verify yet, or criterion disabled)
            // The legacy `t.ok` boolean is still set for back-compat
            // consumers; the renderer prefers `t.status` when present.
            const status = t.status
              || (t.ok ? "ok" : "violated");   // legacy fallback
            let icon, color;
            if (status === "ok")            { icon = "\u2713"; color = TH.accent; }
            else if (status === "violated") { icon = "\u2717"; color = TH.red;    }
            else                            { icon = "?";       color = TH.text2;  }
            return [
              <span key="r" style={{ color: TH.blue, fontWeight: 600 }}>{t.req}</span>,
              <span key="s" style={{ color: color, fontWeight: 700 }}>{icon}</span>,
              <span key="n" style={{ color: TH.text1 }}>{t.note}</span>,
            ];
          })}
        />
      )}
      {sub === "recs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {recs.map(function(r, i) {
            return (
              <div key={i} style={{ display: "flex", gap: 8 }}>
                <span style={{ color: TH.yellow }}>→</span>
                <span style={{ color: TH.text0, fontSize: 12, lineHeight: 1.55 }}>{r}</span>
              </div>
            );
          })}
        </div>
      )}
      {sub === "iterations" && (
        <JudgeIterationsList history={history} maxIters={_maxJudgeIters} />
      )}
      {sub === "duration"   && <DurationTab stageData={stageData} />}
      {sub === "tokens"     && <TokensTab   stageData={stageData} />}
      {sub === "executrace" && <TraceTab    data={data} stageData={stageData} onSelectRun={onSelectRun} />}
      {sub === "log"        && <LogTab      stageData={stageData} stageId={9} stageKey="judge" stageLabel="Judge" />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// JudgeIterationsList — expandable iteration drill-down
//
// Each iteration row is clickable. Expanded view shows:
//   - per-criterion breakdown from h.eval.results (PASS/FAIL/SKIP per row)
//   - DiffBlock for spec / RTL / TB regen captures from h._structured.*
//
// The data shape comes from src/pipeline/nodes/judge.js:
//   h.iter, h.overall, h.score, h.unmet, h.total, h.triageTarget,
//   h.eval = { overall, score, results: [{...}], failingIds, categories },
//   h._structured = { specFix?, rtlRegen?, tbRegen? } where each has
//     { beforeCode, afterCode, parseOk, kind, rawText }
//
// This panel does NOT hide the back-compat summary (status tag, score
// chip) — those remain visible at the iteration level so users can scan.
// Clicking a row reveals the rich detail below.
// ═══════════════════════════════════════════════════════════════════════════
function JudgeIterationsList({ history, maxIters }) {
  const [expanded, setExpanded] = useState(new Set());
  function toggle(iter) {
    setExpanded(function(prev) {
      const next = new Set(prev);
      if (next.has(iter)) next.delete(iter);
      else next.add(iter);
      return next;
    });
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: TH.text1, marginBottom: 12 }}>
        Judge ran {history.length} iteration{history.length === 1 ? "" : "s"} (configured max: {maxIters}). Click an iteration to see the per-criterion eval breakdown and the regen diffs.
      </div>
      {history.map(function(h) {
        const isOpen = expanded.has(h.iter);
        const ev = h.eval;
        return (
          <div key={h.iter} style={{
            background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
            marginBottom: 8,
          }}>
            {/* ── Summary row (clickable) ─────────────────────────────── */}
            <button
              onClick={function() { toggle(h.iter); }}
              style={{
                width: "100%",
                background: "none", border: "none", cursor: "pointer",
                padding: "10px 14px",
                display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                textAlign: "left",
              }}
            >
              <span style={{ color: TH.text2, fontSize: 12, width: 14 }}>
                {isOpen ? "▼" : "▶"}
              </span>
              <Tag color={TH.blue} bg={TH.blueDim}>Iter {h.iter}</Tag>
              <Tag
                color={h.overall === "PASS" ? TH.accent : TH.red}
                bg={h.overall === "PASS" ? TH.accentDim : TH.redDim}
              >
                {h.overall}
              </Tag>
              <span style={{ fontSize: 11, color: TH.text0, fontWeight: 700 }}>{h.score}/100</span>
              <span style={{ fontSize: 11, color: TH.text1 }}>
                {h.unmet} of {h.total} enabled criteria failing
              </span>
              {h.triageTarget && <Tag color={TH.orange} bg={TH.orangeDim}>→ {h.triageTarget}</Tag>}
            </button>

            {/* ── Expanded detail ─────────────────────────────────────── */}
            {isOpen && (
              <div style={{ borderTop: "1px solid " + TH.border, padding: "12px 14px" }}>
                <IterationDetail eval={ev} structured={h._structured} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function IterationDetail({ eval: ev, structured }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Per-criterion eval breakdown ─────────────────────────────── */}
      {ev && Array.isArray(ev.results) && ev.results.length > 0 && (
        <CriteriaBreakdown results={ev.results} />
      )}

      {/* ── Regen diffs (_structured captures) ───────────────────── */}
      {structured && structured.specFix && (
        <RegenDiff
          title="Spec fix"
          before={structured.specFix.beforeCode}
          after={structured.specFix.afterCode}
          parseOk={structured.specFix.parseOk}
        />
      )}
      {structured && structured.rtlRegen && (
        <RegenDiff
          title="RTL regen"
          before={structured.rtlRegen.beforeCode}
          after={structured.rtlRegen.afterCode}
          parseOk={structured.rtlRegen.parseOk}
        />
      )}
      {structured && structured.tbRegen && (
        <RegenDiff
          title="Testbench regen"
          before={structured.tbRegen.beforeCode}
          after={structured.tbRegen.afterCode}
          parseOk={structured.tbRegen.parseOk}
        />
      )}
      {!structured && (
        <div style={{ fontSize: 11, color: TH.text2, fontStyle: "italic" }}>
          No regen captures for this iteration (PASS on first eval, or no fix attempted).
        </div>
      )}
    </div>
  );
}

function CriteriaBreakdown({ results }) {
  // Show only enabled criteria (skipped ones aren't part of the verdict);
  // group by status PASS/FAIL for quick scanning.
  const enabled = results.filter(function(r) { return r.enabled; });
  if (enabled.length === 0) {
    return (
      <div style={{ fontSize: 11, color: TH.text2 }}>
        No criteria enabled — gate vacuously PASSed.
      </div>
    );
  }
  return (
    <div>
      <div style={{
        fontFamily: TH.fontD, fontSize: 12, fontWeight: 600,
        color: TH.text0, marginBottom: 6,
      }}>
        Per-criterion verdict ({enabled.length} enabled)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {enabled.map(function(r) {
          const isPass = r.status === "PASS";
          return (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "5px 8px",
              background: isPass ? "transparent" : TH.redDim,
              border: "1px solid " + (isPass ? TH.border : TH.red),
              borderRadius: 3,
              fontSize: 11,
            }}>
              <Tag
                color={isPass ? TH.accent : TH.red}
                bg={isPass ? TH.accentDim : TH.redDim}
              >
                {r.status}
              </Tag>
              <span style={{
                color: isPass ? TH.text0 : TH.red,
                fontWeight: 600, flex: 1, minWidth: 0,
              }}>
                {r.label}
              </span>
              <span style={{ fontFamily: TH.fontMono, color: TH.text1 }}>
                {r.measured}% / {r.threshold}%
              </span>
              {r.detail && (
                <span style={{ color: TH.text2, fontSize: 10, fontStyle: "italic" }}>
                  {r.detail}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RegenDiff({ title, before, after, parseOk }) {
  const same = (before || "") === (after || "");
  return (
    <div>
      <div style={{
        display: "flex", gap: 8, alignItems: "center", marginBottom: 6,
        fontFamily: TH.fontD, fontSize: 12, fontWeight: 600, color: TH.text0,
      }}>
        <span>{title}</span>
        {!parseOk && <Tag color={TH.red} bg={TH.redDim}>parse failed</Tag>}
        {parseOk && same && <Tag color={TH.text2} bg={TH.bg0}>no change</Tag>}
      </div>
      {same ? (
        <div style={{
          fontSize: 11, color: TH.text2, fontStyle: "italic",
          padding: "6px 12px", background: TH.bg0, border: "1px dashed " + TH.border,
          borderRadius: 3,
        }}>
          The {title.toLowerCase()} produced identical output (no diff to show).
        </div>
      ) : (
        <DiffBlock before={before || ""} after={after || ""} maxH={300} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ReviewStage — rtl_review / test_review issue browser with iteration history
// ═══════════════════════════════════════════════════════════════════════════
//
// Props:
//   data  : { verdict, score, summary, issues, strengths,
//             coverage_assessment, _iterations, _fixes }
//   label : human label like "RTL Review" or "Test Review"
//
// Issues are categorized by severity (critical / major / minor / suggestion)
// and rendered as cards with a colored left border. The header shows a
// score ring like JudgeStage but smaller. Optional tabs appear when:
//   - fixes.length > 0       → "Fixes" tab
//   - iterations.length > 1  → "Iterations" tab
//   - covAssess present      → "Coverage" tab
export function ReviewStage({ data, label }) {
  const [sub, setSub] = useState("overview");
  const [expandedIter, setExpandedIter] = useState(null);
  const issues     = data.issues || [];
  const iterations = data._iterations || [];
  const fixes      = data._fixes || [];
  const critCount = issues.filter(function(i) { return i.severity === "critical"; }).length;
  const majCount  = issues.filter(function(i) { return i.severity === "major"; }).length;
  const minCount  = issues.filter(function(i) { return i.severity === "minor"; }).length;
  const sugCount  = issues.filter(function(i) { return i.severity === "suggestion"; }).length;
  const covAssess = data.coverage_assessment || null;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "issues",   label: "Issues (" + issues.length + ")" },
  ];
  if (fixes.length > 0)        tabs.push({ id: "fixes",      label: "Fixes ("      + fixes.length      + ")" });
  if (iterations.length > 1)   tabs.push({ id: "iterations", label: "Iterations (" + iterations.length + ")" });
  if (covAssess)               tabs.push({ id: "coverage",   label: "Coverage" });
  // Per-step Log panel (last tab)
  tabs.push({ id: "runlog", label: "Log" });

  const sevColors = { critical: TH.red,    major: TH.orange,    minor: TH.yellow,    suggestion: TH.blue };
  const sevBg     = { critical: TH.redDim, major: TH.orangeDim, minor: TH.yellowDim, suggestion: TH.blueDim };

  return (
    <div>
      <SubTab tabs={tabs} active={sub} onChange={setSub} />
      {sub === "overview" && (
        <div>
          <div style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{
              width: 76, height: 76, borderRadius: "50%",
              background: "conic-gradient(" + (data.verdict === "PASS" ? TH.accent : TH.red) + " " + (data.score || 0) + "%, " + TH.bg3 + " " + (data.score || 0) + "%)",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
              <div style={{
                width: 58, height: 58, borderRadius: "50%", background: TH.bg2,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: TH.fontD, fontSize: 20, fontWeight: 800,
                color: data.verdict === "PASS" ? TH.accent : TH.red,
              }}>
                {data.score || 0}
              </div>
            </div>
            <div>
              <div style={{
                fontSize: 22, fontWeight: 800,
                color: data.verdict === "PASS" ? TH.accent : TH.red,
                fontFamily: TH.fontD,
              }}>
                {data.verdict || "—"}
              </div>
              <div style={{ fontSize: 12, color: TH.text2, marginBottom: 4 }}>{label || "Review"}</div>
              {fixes.length > 0 && <Tag color={TH.orange} bg={TH.orangeDim}>{fixes.length} fixes applied</Tag>}
            </div>
            <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
              {critCount > 0 && <MetricCard label="Critical" value={critCount} color={TH.red} />}
              {majCount > 0  && <MetricCard label="Major"    value={majCount}  color={TH.orange} />}
              <MetricCard label="Minor"       value={minCount} color={TH.yellow} />
              <MetricCard label="Suggestions" value={sugCount} color={TH.blue} />
            </div>
          </div>
          <div style={{ fontSize: 12, color: TH.text1, lineHeight: 1.6, marginBottom: 12 }}>
            {data.summary}
          </div>
          {(data.strengths || []).length > 0 && (
            <div style={{
              padding: "10px 14px", background: TH.accentDim,
              border: "1px solid rgba(0,255,180,.2)", borderRadius: 5, marginBottom: 12,
            }}>
              <div style={{
                fontSize: 10, color: TH.accent, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6,
              }}>
                Strengths
              </div>
              {data.strengths.map(function(s, i) {
                return (
                  <div key={i} style={{ fontSize: 11, color: TH.text0, lineHeight: 1.5, marginBottom: 2 }}>
                    ✓ {s}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {sub === "issues" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {issues.length === 0 && (
            <div style={{ padding: 30, textAlign: "center", color: TH.text2, fontSize: 12 }}>
              No issues found.
            </div>
          )}
          {issues.map(function(issue, i) {
            const sev = issue.severity || "minor";
            return (
              <div key={issue.id || i} style={{
                background: TH.bg0,
                border: "1px solid " + TH.border,
                borderLeft: "3px solid " + (sevColors[sev] || TH.text2),
                borderRadius: 4, padding: 14,
              }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <Tag color={sevColors[sev]} bg={sevBg[sev]}>{sev}</Tag>
                  <Tag color={TH.blue} bg={TH.blueDim}>{issue.category || "general"}</Tag>
                  {issue.id && <span style={{ fontSize: 10, color: TH.text3 }}>{issue.id}</span>}
                  {issue.signal && <span style={{ fontSize: 10, color: TH.accent, fontFamily: TH.font }}>{issue.signal}</span>}
                  {issue.line != null && <span style={{ fontSize: 10, color: TH.text3 }}>L{issue.line}</span>}
                </div>
                <div style={{ fontSize: 11, color: TH.text0, lineHeight: 1.5, marginBottom: issue.fix ? 8 : 0 }}>
                  {issue.description}
                </div>
                {issue.fix && (
                  <div style={{
                    padding: "6px 10px", background: TH.bg1, borderRadius: 3,
                    fontSize: 10, color: TH.text1, fontFamily: TH.font, lineHeight: 1.5,
                  }}>
                    💡 {issue.fix}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {sub === "fixes" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {fixes.map(function(f, i) {
            // _fixes from rtl_review/test_review are {text, iter} objects.
            // Legacy fixtures and verifier tests still pass plain strings, so
            // accept both shapes. Hardened against unexpected non-string non-
            // object inputs (renders JSON.stringify fallback instead of
            // crashing with "Objects are not valid as a React child").
            let text;
            let iter = null;
            if (typeof f === "string") {
              text = f;
            } else if (f && typeof f === "object") {
              text = (typeof f.text === "string") ? f.text
                   : (typeof f.description === "string") ? f.description
                   : (typeof f.desc === "string") ? f.desc
                   : (typeof f._text === "string") ? f._text
                   : JSON.stringify(f);
              if (typeof f.iter === "number") iter = f.iter;
            } else {
              text = String(f);
            }
            return (
              <div key={i} style={{
                display: "flex", gap: 8, padding: "8px 12px",
                background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
              }}>
                <span style={{ color: TH.accent, flexShrink: 0 }}>✓</span>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 11, color: TH.text0, lineHeight: 1.5 }}>{text}</span>
                  {iter != null && (
                    <span style={{ fontSize: 9, color: TH.text3, marginLeft: 8 }}>
                      iter {iter}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {sub === "iterations" && (
        <div>
          {iterations.map(function(it) {
            const isExp = expandedIter === it.iter;
            const hasStructured = !!it._structured;
            return (
              <div key={it.iter} style={{
                background: TH.bg0, border: "1px solid " + (isExp ? TH.accent : TH.border),
                borderRadius: 4, marginBottom: 6, overflow: "hidden",
              }}>
                <div
                  onClick={hasStructured ? function() { setExpandedIter(isExp ? null : it.iter); } : undefined}
                  style={{
                    display: "flex", gap: 10, alignItems: "center",
                    padding: "8px 12px",
                    cursor: hasStructured ? "pointer" : "default",
                  }}
                >
                  {hasStructured && (
                    <span style={{
                      color: TH.text3, fontSize: 8, width: 12, flexShrink: 0,
                      transform: isExp ? "rotate(90deg)" : "none",
                      transition: "transform .15s",
                    }}>▶</span>
                  )}
                  <Tag color={TH.blue} bg={TH.blueDim}>Iter {it.iter}</Tag>
                  <Tag
                    color={it.verdict === "PASS" ? TH.accent : TH.red}
                    bg={it.verdict === "PASS" ? TH.accentDim : TH.redDim}
                  >
                    {it.verdict}
                  </Tag>
                  <span style={{ fontSize: 11, color: TH.text0, fontWeight: 700 }}>{it.score}/100</span>
                  <span style={{ fontSize: 11, color: TH.text1 }}>{it.issueCount} issues</span>
                </div>
                {isExp && hasStructured && (
                  <div style={{ borderTop: "1px solid " + TH.border, padding: "10px 14px" }}>
                    <StructuredFixViewer
                      structured={it._structured}
                      title={"Fix details for iteration " + it.iter}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {sub === "coverage" && covAssess && (
        <div>
          <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
            <MetricCard
              label="Must Reqs Covered"
              value={covAssess.must_reqs_covered + "/" + covAssess.must_reqs_total}
              color={covAssess.must_reqs_covered === covAssess.must_reqs_total ? TH.accent : TH.red}
            />
          </div>
          {(covAssess.missing_reqs || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 10, color: TH.red, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6,
              }}>
                Missing Requirement Coverage
              </div>
              {covAssess.missing_reqs.map(function(r, i) {
                return <Tag key={i} color={TH.red} bg={TH.redDim}>{r}</Tag>;
              })}
            </div>
          )}
          {(covAssess.edge_cases_missing || []).length > 0 && (
            <div>
              <div style={{
                fontSize: 10, color: TH.yellow, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6,
              }}>
                Missing Edge Cases
              </div>
              {covAssess.edge_cases_missing.map(function(e, i) {
                return <div key={i} style={{ fontSize: 11, color: TH.text1, marginBottom: 2 }}>• {e}</div>;
              })}
            </div>
          )}
        </div>
      )}
      {sub === "runlog" && <LogTab data={data} stageKey={(label || "review").toLowerCase().replace(/\s+/g, "_")} stageLabel={label || "Review"} />}
    </div>
  );
}
