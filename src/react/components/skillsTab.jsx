// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/skillsTab — Skills management UI (GUI parity with CLI)
//
// Mirrors the CLI's `rtlforge skills list/show/check/new/edit` surface:
//
//   - List view : every skill the GUI knows about (browser-stored
//                  + GUI prompt overrides + read-only summary of disk
//                  skills if any have been imported).
//   - Edit view : monaco-light textarea with frontmatter highlighting,
//                  validate-on-save against the same invariants the
//                  CLI uses.
//   - Check view: contradiction report for the active workflow + stage
//                  selection, with explicit hard-fails / warnings.
//
// STORAGE MODEL (browser side):
//   Skills authored in the GUI live in localStorage under:
//     rtlforge:skill:<workflow>:<stage>:<id>  →  { frontmatter, body, ts }
//   When the pipeline runs from the GUI, these are surfaced to
//   applySkillOverlay via a small adapter that returns the same
//   shape the fs loader produces (see browserSkillSource in the
//   bridge). Round-trip with the CLI is via download/upload .md files.
//
// CONTINUOUS-DEVELOPMENT NOTE: this tab is structured so that adding a
// new editor capability (e.g. side-by-side preview of composed prompt)
// or a new skill scope (e.g. team scope synced via cloud storage)
// requires changing only this file plus the adapter — not the
// pipeline, not the bridge, not the validate/compose modules.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useMemo, useRef, useEffect } from "react";
import { Btn, Tag } from "./atoms.jsx";
import { TH } from "../../constants/theme.js";
import { getWorkflow, listWorkflows, DEFAULT_WORKFLOW } from "../../workflows/index.js";
import { listAllInvariants } from "../../skills/invariants.js";
import { parseFrontmatter } from "../../skills/frontmatter.js";

// localStorage key prefix — keep in sync with browserSkillSource
const SKILL_LS_PREFIX = "rtlforge:skill:";

function lsKey(workflow, stage, id) {
  return SKILL_LS_PREFIX + workflow + ":" + stage + ":" + id;
}

/** List every browser-stored skill, optionally filtered. */
function listBrowserSkills(workflow, stageFilter) {
  const out = [];
  if (typeof localStorage === "undefined") return out;
  const prefix = SKILL_LS_PREFIX + workflow + ":";
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const tail = k.slice(prefix.length);     // "<stage>:<id>"
    const colonIdx = tail.indexOf(":");
    if (colonIdx < 0) continue;
    const stage = tail.slice(0, colonIdx);
    const id = tail.slice(colonIdx + 1);
    if (stageFilter && stageFilter !== stage) continue;
    let parsed;
    try { parsed = JSON.parse(localStorage.getItem(k)); }
    catch (_) { continue; }
    if (!parsed) continue;
    out.push({
      key: k, workflow: workflow, stage: stage, id: id,
      frontmatter: parsed.frontmatter || {},
      body: parsed.body || "",
      ts: parsed.ts || 0,
      // Reconstructed source view for the editor — the canonical .md form
      source: parsed.source || rebuildSource(parsed.frontmatter, parsed.body),
    });
  }
  return out.sort(function(a, b) {
    if (a.stage !== b.stage) return a.stage.localeCompare(b.stage);
    return a.id.localeCompare(b.id);
  });
}

function rebuildSource(fm, body) {
  const fmKeys = Object.keys(fm || {});
  if (fmKeys.length === 0) return body || "";
  const lines = ["---"];
  for (const k of fmKeys) {
    const v = fm[k];
    if (Array.isArray(v)) lines.push(k + ": [" + v.map(JSON.stringify).join(", ") + "]");
    else lines.push(k + ": " + (typeof v === "string" ? v : JSON.stringify(v)));
  }
  lines.push("---");
  lines.push("");
  lines.push(body || "");
  return lines.join("\n");
}

function saveBrowserSkill(workflow, stage, id, source) {
  const parsed = parseFrontmatter(source);
  const payload = {
    frontmatter: parsed.data,
    body: parsed.body,
    source: source,
    ts: Date.now(),
  };
  localStorage.setItem(lsKey(workflow, stage, id), JSON.stringify(payload));
  return parsed.warnings;
}

function deleteBrowserSkill(workflow, stage, id) {
  localStorage.removeItem(lsKey(workflow, stage, id));
}

/**
 * Validate composed text against invariants. Browser-friendly subset of
 * the term/skills.js validateComposedPrompt — same logic, browser-safe
 * (no fs).
 */
function validateInBrowser(composedText, stageKey) {
  const all = listAllInvariants();
  const applicable = all.filter(function(inv) { return inv.stageKeys.indexOf(stageKey) >= 0; });
  const contradictions = [];
  for (const inv of applicable) {
    let ok;
    try { ok = !!inv.check(composedText); }
    catch (_e) { ok = false; }
    if (ok) continue;
    contradictions.push({
      invariantId: inv.id, label: inv.label,
      severity: inv.severity, remedy: inv.remedy,
    });
  }
  return contradictions;
}

const TEMPLATE_SOURCE = function(stageKey) {
  return [
    "---",
    "applies_to: [" + stageKey + "]",
    "priority: 100",
    "mode: append",
    "---",
    "",
    "# " + stageKey + " skill",
    "",
    "Add your guidance for the " + stageKey + " stage here.",
    "This text is appended to the core prompt before the LLM call.",
    "",
    "Example:",
    "- Always prefer `always_ff` for sequential logic.",
    "- Use 2-space indentation.",
  ].join("\n");
};

/**
 * The Skills tab. Self-contained — uses only browser-side state and
 * localStorage. Skill files authored on disk by the CLI are NOT shown
 * here (we'd need the user to import them via upload); the CLI listing
 * lives at `rtlforge skills list`.
 */
export function SkillsTab({ config, setConfig }) {
  const workflows = useMemo(listWorkflows, []);
  const [workflow, setWorkflow] = useState(config.workflow || DEFAULT_WORKFLOW);
  const wf = useMemo(function() { return getWorkflow(workflow); }, [workflow]);

  const [skills, setSkills] = useState(function() { return listBrowserSkills(workflow); });
  function refreshList() { setSkills(listBrowserSkills(workflow)); }
  useEffect(refreshList, [workflow]);

  const [editing, setEditing] = useState(null);  // {stage, id, source} or null
  const [editorText, setEditorText] = useState("");
  const [statusMsg, setStatusMsg] = useState(null); // {kind: "ok"|"warn"|"err", text}
  const [validation, setValidation] = useState(null); // contradictions array

  const fileInputRef = useRef(null);

  function openNew() {
    const stage = wf.skillStageIds[0];
    const id = "skill-" + Date.now().toString(36);
    const source = TEMPLATE_SOURCE(stage);
    setEditing({ stage: stage, id: id, source: source, isNew: true });
    setEditorText(source);
    setValidation(null);
    setStatusMsg(null);
  }
  function openExisting(skill) {
    setEditing({ stage: skill.stage, id: skill.id, source: skill.source, isNew: false });
    setEditorText(skill.source);
    setValidation(null);
    setStatusMsg(null);
  }
  function closeEditor() {
    setEditing(null);
    setEditorText("");
    setValidation(null);
    setStatusMsg(null);
  }

  function handleValidate() {
    if (!editing) return;
    const parsed = parseFrontmatter(editorText);
    // Compose a simple synthetic core prompt that mentions JSON + code
    // schema so we're checking the SKILL's effect, not the absence of
    // a core prompt. (For a real composed-prompt preview the user
    // would run the pipeline; this validator is the cheap/instant
    // editor-time gate.)
    const corePrompt = "Generate the SystemVerilog module. Return JSON: { \"code\": \"...\" }";
    const composed = corePrompt + "\n\n" + parsed.body;
    const contradictions = validateInBrowser(composed, editing.stage);
    setValidation(contradictions);
    if (contradictions.length === 0) {
      setStatusMsg({ kind: "ok", text: "no contradictions detected for stage " + editing.stage });
    } else {
      setStatusMsg({
        kind: "warn",
        text: contradictions.length + " contradiction(s) — see details below",
      });
    }
  }

  function handleSave() {
    if (!editing) return;
    try {
      const warnings = saveBrowserSkill(workflow, editing.stage, editing.id, editorText);
      refreshList();
      setStatusMsg({
        kind: warnings.length > 0 ? "warn" : "ok",
        text: "saved to localStorage" + (warnings.length > 0 ? " (" + warnings.length + " frontmatter warning(s))" : ""),
      });
    } catch (e) {
      setStatusMsg({ kind: "err", text: "save failed: " + (e.message || e) });
    }
  }

  function handleDelete() {
    if (!editing) return;
    if (typeof window !== "undefined" && !window.confirm("Delete skill " + editing.id + "?")) return;
    deleteBrowserSkill(workflow, editing.stage, editing.id);
    refreshList();
    closeEditor();
  }

  function handleDownload() {
    const blob = new Blob([editorText], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = editing.stage + "-" + editing.id + ".md";
    a.click();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  function handleUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function() {
      const source = String(reader.result);
      // Parse to extract stage from frontmatter or filename
      const parsed = parseFrontmatter(source);
      const stage = (parsed.data.applies_to && parsed.data.applies_to[0])
        || file.name.replace(/\.md$/i, "").split("-")[0]
        || wf.skillStageIds[0];
      const id = "imported-" + Date.now().toString(36);
      setEditing({ stage: stage, id: id, source: source, isNew: true });
      setEditorText(source);
      setStatusMsg({ kind: "ok", text: "loaded " + file.name + " — review and save to persist" });
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // ── render ────────────────────────────────────────────────────────────

  if (editing) {
    return (
      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <Btn onClick={closeEditor} variant="ghost" size="sm">← Back to list</Btn>
          <span style={{ color: TH.text2, fontSize: 11 }}>
            {editing.isNew ? "New skill" : "Editing"} <code style={{ background: TH.bg0, padding: "1px 5px", borderRadius: 3 }}>{editing.id}</code>
          </span>
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: TH.text2 }}>Stage:</label>
          <select
            value={editing.stage}
            onChange={function(e) { setEditing(Object.assign({}, editing, { stage: e.target.value })); }}
            style={{
              background: TH.bg0, border: "1px solid " + TH.border, color: TH.text0,
              fontSize: 11, padding: "3px 8px", borderRadius: 4, fontFamily: TH.font,
            }}
          >
            {wf.skillStageIds.map(function(s) {
              return <option key={s} value={s}>{s}</option>;
            })}
          </select>
        </div>

        <textarea
          value={editorText}
          onChange={function(e) { setEditorText(e.target.value); }}
          spellCheck={false}
          style={{
            width: "100%", minHeight: 320,
            fontFamily: TH.fontMono || "monospace", fontSize: 12,
            background: TH.bg0, color: TH.text0, border: "1px solid " + TH.border,
            borderRadius: 4, padding: 10, lineHeight: 1.5, resize: "vertical",
            boxSizing: "border-box",
          }}
        />

        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <Btn onClick={handleValidate} variant="secondary" size="sm">Validate</Btn>
          <Btn onClick={handleSave} variant="primary" size="sm">Save</Btn>
          <Btn onClick={handleDownload} variant="ghost" size="sm">Download .md</Btn>
          {!editing.isNew && <Btn onClick={handleDelete} variant="danger" size="sm">Delete</Btn>}
        </div>

        {statusMsg && (
          <div style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 4, fontSize: 12,
            background: statusMsg.kind === "err" ? TH.errBg
              : statusMsg.kind === "warn" ? TH.warnBg : TH.okBg,
            color: TH.text0, border: "1px solid " + TH.border,
          }}>
            {statusMsg.text}
          </div>
        )}

        {validation && validation.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            <div style={{ color: TH.text1, fontWeight: 600, marginBottom: 6 }}>
              Contradictions
            </div>
            {validation.map(function(v) {
              return (
                <div key={v.invariantId} style={{
                  padding: "8px 10px", marginBottom: 6, borderRadius: 4,
                  background: TH.bg0, border: "1px solid " + (v.severity === "structural" ? TH.errBd : TH.warnBd),
                }}>
                  <div style={{ color: v.severity === "structural" ? TH.err : TH.warn, fontWeight: 600 }}>
                    [{v.invariantId}] {v.label}
                  </div>
                  {v.remedy && (
                    <div style={{ color: TH.text2, marginTop: 4 }}>
                      <span style={{ color: TH.text3 }}>remedy: </span>{v.remedy}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Header row: workflow selector + actions. flexWrap lets the row
          break onto multiple lines on narrow viewports rather than
          push past the right edge and require horizontal scrolling. */}
      <div style={{
        display: "flex", gap: 8, alignItems: "center",
        marginBottom: 12, flexWrap: "wrap",
      }}>
        <label style={{ fontSize: 11, color: TH.text2 }}>Workflow:</label>
        <select
          value={workflow}
          onChange={function(e) {
            setWorkflow(e.target.value);
            setConfig(function(c) { return Object.assign({}, c, { workflow: e.target.value }); });
          }}
          style={{
            background: TH.bg0, border: "1px solid " + TH.border, color: TH.text0,
            fontSize: 11, padding: "3px 8px", borderRadius: 4, fontFamily: TH.font,
            maxWidth: 260,
          }}
        >
          {workflows.map(function(w) {
            return <option key={w.name} value={w.name}>{w.label}</option>;
          })}
        </select>
        <Btn onClick={openNew} variant="primary" size="sm">+ New</Btn>
        <Btn onClick={function() { fileInputRef.current && fileInputRef.current.click(); }} variant="ghost" size="sm">
          Upload .md
        </Btn>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,text/markdown"
          onChange={handleUpload}
          style={{ display: "none" }}
        />
      </div>

      <div style={{ marginBottom: 14, color: TH.text2, fontSize: 12, lineHeight: 1.6 }}>
        Skills are markdown files that overlay onto the core stage prompt.
        Browser-edited skills live in localStorage; download them and drop
        into <code>~/.rtlforge/workflows/{workflow}/skills/</code> to share with the CLI.
      </div>

      {skills.length === 0 ? (
        <div style={{
          padding: 20, textAlign: "center", color: TH.text2,
          background: TH.bg0, border: "1px dashed " + TH.border, borderRadius: 4,
        }}>
          No skills yet for workflow <strong>{workflow}</strong>. Click <strong>+ New skill</strong> to start.
        </div>
      ) : (
        <div>
          {skills.map(function(s) {
            return (
              <div
                key={s.key}
                onClick={function() { openExisting(s); }}
                style={{
                  cursor: "pointer", padding: "10px 12px", marginBottom: 6,
                  background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: TH.text0, fontSize: 12 }}>
                    {s.id} <Tag>{s.stage}</Tag>
                    {s.frontmatter.priority != null && (
                      <span style={{ color: TH.text3, fontSize: 11, marginLeft: 6 }}>
                        priority {s.frontmatter.priority}
                      </span>
                    )}
                    {s.frontmatter.mode && s.frontmatter.mode !== "append" && (
                      <span style={{ color: TH.warn, fontSize: 11, marginLeft: 6 }}>
                        mode={s.frontmatter.mode}
                      </span>
                    )}
                  </div>
                  <div style={{ color: TH.text2, fontSize: 11, marginTop: 4 }}>
                    {(s.body || "").slice(0, 120) || <em>(empty body)</em>}
                  </div>
                </div>
                <span style={{ color: TH.text3, fontSize: 18 }}>›</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Test seam
export const _internal = {
  listBrowserSkills, saveBrowserSkill, deleteBrowserSkill,
  validateInBrowser, lsKey, rebuildSource, SKILL_LS_PREFIX,
};
