// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/trainingTab — Settings → Training (docs/training-mode.md)
//
// Configures training mode: which generator to train (RTL/TB), the Q1 loop mode
// (single/refine), the Q2 rule expansion (table/model), cross-model injection,
// and the automated-loop source + budget. Selecting a mode also turns on
// errorsToAvoid (harvest) for the session.
//
// Training is a batch activity (it stops the pipeline at lint to harvest a
// per-model rule corpus). This tab persists the settings and synthesizes the
// exact `rtlforge train …` command to launch the unattended loop in a terminal;
// the heavy loop runs in the CLI, not inside the interactive GUI.
// ═══════════════════════════════════════════════════════════════════════════

import { TH } from "../../constants/theme.js";
import { trainCommand } from "../../pipeline/index.js";

function Seg({ value, options, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {options.map(function(o) {
        const on = value === o.value;
        return (
          <button
            key={String(o.value)}
            onClick={function() { onChange(o.value); }}
            title={o.title || ""}
            style={{
              padding: "5px 12px", borderRadius: 4,
              border: "1px solid " + (on ? TH.accent : TH.border),
              background: on ? TH.accentDim : TH.bg0,
              color: on ? TH.accent : TH.text2,
              fontWeight: 600, fontSize: 11, fontFamily: TH.font, cursor: "pointer",
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

function Row({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <label style={{ fontSize: 12, color: TH.text1, minWidth: 130, fontWeight: 600 }}>{label}</label>
        {children}
      </div>
      {hint && <div style={{ fontSize: 10, color: TH.text3, marginLeft: 140, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

function NumIn({ value, onChange, min, width }) {
  return (
    <input
      type="number"
      value={value == null ? "" : value}
      min={min == null ? 0 : min}
      onChange={function(e) {
        const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
        onChange(Number.isNaN(v) ? null : v);
      }}
      style={{
        background: TH.bg0, border: "1px solid " + TH.border, color: TH.text0,
        fontSize: 12, padding: "4px 8px", borderRadius: 4, fontFamily: TH.font,
        width: width || 70,
      }}
    />
  );
}

export function TrainingTab({ config, setConfig }) {
  const cfg = config || {};
  const mode = cfg.trainingMode || "";
  function set(patch) { setConfig(function(c) { return Object.assign({}, c, patch); }); }
  function chooseMode(m) {
    // Selecting a training mode implies harvesting must be on.
    set(m ? { trainingMode: m, errorsToAvoid: true } : { trainingMode: "" });
  }
  const cmd = trainCommand(Object.assign({}, cfg, { trainingMode: mode || "rtl" }));

  return (
    <div style={{ paddingBottom: 12 }}>
      <div style={{ fontSize: 12, color: TH.text2, marginBottom: 16, lineHeight: 1.6 }}>
        Training mode stops the pipeline at <strong>lint</strong> (RTL) or
        {" "}<strong>lint&nbsp;test</strong> (TB) to harvest recurring mistakes and
        distil them into rules that steer future generation. Lessons are attributed
        to the current model and grow a per-model rule corpus.
      </div>

      <Row label="Train" hint="Which generator's mistakes to harvest. Off leaves the normal pipeline unchanged.">
        <Seg
          value={mode}
          onChange={chooseMode}
          options={[
            { value: "",    label: "Off" },
            { value: "rtl", label: "RTL Gen", title: "Stop at lint" },
            { value: "tb",  label: "TB Gen",  title: "Stop at lint_test" },
          ]}
        />
      </Row>

      {mode && (
        <div style={{ padding: 14, borderRadius: 6, border: "1px solid " + TH.border, background: TH.bg1, marginBottom: 18 }}>
          <Row label="Loop (Q1)" hint="Single: one gen→lint pass per spec. Refine: re-inject the grown rules and regenerate on the same spec until no new mistake appears.">
            <Seg
              value={cfg.trainingLoop || "single"}
              onChange={function(v) { set({ trainingLoop: v }); }}
              options={[{ value: "single", label: "Single" }, { value: "refine", label: "Refine" }]}
            />
          </Row>

          <Row label="Rule expansion (Q2)" hint="Table: deterministic distillation only. Model: also call the model to rewrite raw symptoms into sharper rules (extra LLM calls).">
            <Seg
              value={cfg.trainingRuleExpansion || "table"}
              onChange={function(v) { set({ trainingRuleExpansion: v }); }}
              options={[{ value: "table", label: "Table" }, { value: "model", label: "Model" }]}
            />
          </Row>

          <Row label="Automated loop" hint="Source specs automatically and stop on saturation or budget — no manual prompt. Otherwise train one spec at a time.">
            <Seg
              value={cfg.trainingAuto ? "on" : "off"}
              onChange={function(v) { set({ trainingAuto: v === "on" }); }}
              options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]}
            />
          </Row>

          {cfg.trainingAuto && (
            <div style={{ borderLeft: "2px solid " + TH.border, paddingLeft: 12, marginLeft: 4 }}>
              <Row label="Source" hint="Adaptive drives synthesized specs toward the thinnest rule class; corpus walks the built-in bench designs.">
                <Seg
                  value={cfg.trainingAutoSource || "adaptive"}
                  onChange={function(v) { set({ trainingAutoSource: v }); }}
                  options={[
                    { value: "adaptive", label: "Adaptive" },
                    { value: "synth", label: "Synth" },
                    { value: "corpus", label: "Corpus" },
                    { value: "corpus+mutation", label: "Corpus+Mut" },
                  ]}
                />
              </Row>
              <Row label="Seeds / spec" hint="Generations per sourced spec (seed variation broadens the error distribution).">
                <NumIn value={cfg.trainingSeedsPerSpec == null ? 1 : cfg.trainingSeedsPerSpec} min={1} onChange={function(v) { set({ trainingSeedsPerSpec: v == null ? 1 : v }); }} />
              </Row>
              <Row label="Budget" hint="Hard backstop — the loop stops at the first limit (runs, minutes) or when no new lessons appear for the saturation window.">
                <span style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: TH.text2, flexWrap: "wrap" }}>
                  <NumIn value={cfg.trainingAutoMaxRuns} min={1} onChange={function(v) { set({ trainingAutoMaxRuns: v }); }} /> runs
                  <NumIn value={cfg.trainingAutoMaxMinutes} min={1} onChange={function(v) { set({ trainingAutoMaxMinutes: v }); }} /> min
                  <NumIn value={cfg.trainingSaturationWindow} min={1} onChange={function(v) { set({ trainingSaturationWindow: v == null ? 3 : v }); }} /> sat. window
                </span>
              </Row>
            </div>
          )}
        </div>
      )}

      {/* Cross-model gating — relevant to errors-to-avoid generally. */}
      <Row label="Cross-model inject" hint="Off (default): a model is only fed lessons it earned (plus unattributed ones). On: one model's mistakes can steer another model's generation.">
        <Seg
          value={cfg.errorsToAvoidCrossModel ? "on" : "off"}
          onChange={function(v) { set({ errorsToAvoidCrossModel: v === "on" }); }}
          options={[{ value: "off", label: "Same model only" }, { value: "on", label: "Cross-model" }]}
        />
      </Row>

      {/* Synthesized CLI command — the unattended loop runs in a terminal. */}
      {mode && (
        <div style={{ marginTop: 8, padding: 12, borderRadius: 6, border: "1px solid " + TH.border, background: TH.bg0 }}>
          <div style={{ fontSize: 9, color: TH.text3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
            Run the training loop
          </div>
          <code style={{ fontSize: 12, color: TH.accent, fontFamily: TH.fontMono || "monospace", wordBreak: "break-all" }}>
            $ {cmd}
          </code>
          <div style={{ fontSize: 10, color: TH.text3, marginTop: 8, lineHeight: 1.5 }}>
            Training is a batch activity; it harvests into{" "}
            <code style={{ color: TH.text2 }}>~/.rtlforge/errors-to-avoid.json</code>, scoped to the current model.
            Inspect results with <code style={{ color: TH.text2 }}>rtlforge errors show --model &lt;id&gt;</code>.
          </div>
        </div>
      )}
    </div>
  );
}
