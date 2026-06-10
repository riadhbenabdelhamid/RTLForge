// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// react/components/RTLForge — Root application component
//
// All features supported:
//
//   - Module AND System design modes
//   - Full module sidebar with By-Level / By-Instance views, SVG completion
//     rings, stale indicators, search filter, import/propagate controls
//   - Shared package viewer/editor
//   - Integration pipeline view (int_lint / int_test / int_judge)
//   - Stage tabs with completion badges, LLM log toggle, execution path
//   - SplitCodeView for RTL (stage 4) and Testbench (stage 7)
//   - Manual import dialogs for RTL and TB
//   - System package import dialog (blackbox vs exploded mode)
//   - Pipeline progress bar for multi-module full-auto runs
//   - Settings, Resume, Ledger panels
//   - Checkpoint save with flash feedback
//   - All keyboard shortcuts (Ctrl+Enter to launch)
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useEffect, useReducer } from "react";
import { useProject } from "../useProject.jsx";
import { TH, setActiveTheme, subscribeToThemeChanges, getActiveThemeName } from "../../constants/theme.js";
import { getWorkflow } from "../../workflows/index.js";
import { ALL_STAGES, getActiveStages, INT_STAGES } from "../../constants/stages.js";
import { PROVIDERS } from "../../constants/providers.js";
import { Spinner, Btn, Tag, Chip, CodeBlock, MetricCard, DataTable, ErrorBox, Label, RunHistoryPanel } from "./atoms.jsx";
import {
  ElicitStage, SpecStage, ArchStage, FormalPropsStage,
  LintStage, VerifyStage, JudgeStage, ReviewStage,
} from "./stages.jsx";
import { SplitCodeView, SettingsPanel, ResumeDialog, DecompReview } from "./panels.jsx";
import { CodeWithLogShell } from "./codeWithLogShell.jsx";
// Live progress display while a stage runs.
import { LiveProgressPanel, LiveProgressCollapsedPill } from "./liveProgressPanel.jsx";
// Triangle/circle + replay-arrow badge logic.
import { stageBadgeStyle } from "./stageBadgeStyle.js";
// Per-run dropdown above each stage's content.
import { RunSelectorDropdown } from "./runSelectorDropdown.jsx";
import { callLLM, extractJSON } from "../../llm/index.js";
import { estimateCost } from "../../llm/cost.js";
import { promptPropagateSpec } from "../../prompts/propagate.js";
import { promptSharedPackage } from "../../prompts/index.js";
import { blankModule, computeEffectiveLevels } from "../../projectState/index.js";
import { collectRTLSnapshots, collectTBSnapshots } from "../../utils/pastVersions.js";

// Small wrapper that toggles between the collapsed
// "live activity" pill and the expanded full LiveProgressPanel.
// Each per-stage pill keeps its own expand state so toggling one
// doesn't affect others.
function LivePillContainer({ stageId, progress, onClear }) {
  const [expanded, setExpanded] = useState(false);
  if (!progress || !progress.events || progress.events.length === 0) return null;
  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      {!expanded && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <LiveProgressCollapsedPill
            stageId={stageId}
            progress={progress}
            onExpand={function() { setExpanded(true); }}
          />
        </div>
      )}
      {expanded && (
        <div style={{
          position: "relative",
          border: "1px solid " + TH.border, borderRadius: 6,
          background: TH.bg1,
        }}>
          <button
            onClick={function() { setExpanded(false); }}
            style={{
              position: "absolute", top: 8, right: 8, zIndex: 1,
              padding: "2px 8px", fontSize: 9,
              background: TH.bg0, border: "1px solid " + TH.border,
              color: TH.text2, borderRadius: 3, cursor: "pointer",
            }}
            title="Collapse"
          >
            ▾ COLLAPSE
          </button>
          <LiveProgressPanel
            stageId={stageId}
            progress={progress}
            onClear={onClear}
          />
        </div>
      )}
    </div>
  );
}

export default function RTLForge() {
  const p = useProject({
    callLLM,
    extractJSON,
    estimateCost,
    promptSharedPackage,
  });

  // Destructure the full hook surface
  const {
    state, dispatch,
    activeMod, activeStages, isMultiModule, allModulesComplete, ledgerTotals,
    modules, instances, projectPhase, decomposition, decompError,
    ledger, totals, integrationState, sharedPackage, pipelineProgress, activeModId,
    stageData, stageErrors, completed, stageRuns, executionPath, modName, LAST_STAGE,
    setActiveModId, setProjectPhase, setModules, setInstances,
    setDecomposition, setDecompError, setSharedPackage,
    getModule, updateModule, updateSD, addLedger, markStaleFrom,
    runStageForModule, moduleProgress, moduleProgressSummary,
    nextStageId: nextStageIdFn, stageIdsFrom: stageIdsFromFn, isStageActive,
    activeStage, setActiveStage,
    viewingStage, setViewingStage,
    processing, propagating, setPropagating,
    loopbackStageId, loopbackModId,
    // Multi-stage reflow signal from useProject. The Set<number> of stages
    // currently active in a K-to-X reflow chain; every member fast-blinks
    // simultaneously (not just one target).
    reflowStageIds, reflowModId,
    // Live progress display data.
    liveProgress, clearLiveProgress,
    // Per-stage run selection. selectedRunByMod is
    // keyed by module ID; the active module's map tells the stage panel
    // which run to display. setSelectedRun(stageId, runId|null, modId?)
    // writes the selection (null = "follow latest").
    selectedRunByMod, setSelectedRun, clearSelectedRuns,
    mode, setMode,
    userDesc, setUserDesc,
    designMode, setDesignMode,
    showSettings, setShowSettings,
    showLedger, setShowLedger,
    showDebug, setShowDebug,
    config, setConfig,
    runStage, runAllPipelines, runIntegrationPipeline,
    proceed, abortCurrentStage, switchModule,
    handleLaunch, handleRerun, handleExport, handleManualImport,
    activeRunTab, setActiveRunTab,
    confirmDecomp, handleBackToIdle, handleRedecompose,
    showSidebar, setShowSidebar,
    sidebarSearch, setSidebarSearch,
    sidebarTab, setSidebarTab,
    viewingSharedPkg, setViewingSharedPkg,
    editingSharedPkg, setEditingSharedPkg,
    viewingIntegration, setViewingIntegration,
    activeIntStage, setActiveIntStage,
    exportModulePackage, exportSystemPackage,
    handleExportAll, handleCopyManifest,
    importedPackages, setImportedPackages,
    importPackage, importModuleFromPkg,
    importSystemBlackBox, importSystemExploded,
    importDialog, setImportDialog,
    importFileRef, triggerImport,
    detachModule,
    libraryMatches, setLibraryMatches, applyLibraryMatches,
    deletePackageFromLibrary, redownloadPackage, clearLibrary,
    staleModules, setStaleModules, propagateChanges,
    lintWarningsAsErrors, setLintWarningsAsErrors,
    verifyWarningsAsErrors, setVerifyWarningsAsErrors,
    manualImportDialog, setManualImportDialog,
    manualImportText, setManualImportText,
    manualImportFileRef,
    pendingResume, setPendingResume,
    checkpointIndex, setCheckpointIndex,
    lastCheckpointTs, saveFlash,
    saveCheckpointNow, resumeFromCheckpoint, discardCheckpoint,
    backendVerified, setBackendVerified,
    buildAvailableModules,
    projectId,
    // apiKey-cleared notice on session restore
    apiKeyClearedNotice, dismissApiKeyNotice,
  } = p;

  // ─── Theme integration ───────────────────────────────────────────
  // The active theme is held by a Proxy-singleton in constants/theme.js.
  // We do two things here:
  //   (1) Sync the singleton with config.theme on first render + whenever
  //       the user changes the theme in Settings.
  //   (2) Subscribe to theme-version bumps so this component re-renders
  //       whenever setActiveTheme is called (which mutates the singleton
  //       silently — React won't know to re-render otherwise).
  const [_themeTick, forceThemeRender] = useReducer(function(x) { return x + 1; }, 0);
  useEffect(function() {
    const want = (config && config.theme) || "default";
    const wantAccent = (config && config.themeAccent) || undefined;
    if (getActiveThemeName() !== want) {
      setActiveTheme(want, wantAccent);
    } else if (want === "futuristic" && wantAccent) {
      // Same theme but accent might have changed
      setActiveTheme("futuristic", wantAccent);
    }
  }, [config && config.theme, config && config.themeAccent]);
  useEffect(function() {
    const unsubscribe = subscribeToThemeChanges(function() { forceThemeRender(); });
    return unsubscribe;
  }, []);
  // Reference _themeTick so React doesn't dead-code-eliminate the
  // reducer; the value itself isn't used.
  void _themeTick;

  // Export rename dialog state
  const [exportDialog, setExportDialog] = useState(null); // { modId, originalName }
  const [exportNewName, setExportNewName] = useState("");
  const [exportMode, setExportMode] = useState("overwrite"); // "overwrite" | "new"

  function showExportDialog() {
    const name = modName || activeModId || "_init";
    setExportDialog({ modId: activeModId, originalName: name });
    setExportNewName(name);
    setExportMode("overwrite");
  }

  function doExport() {
    if (!exportDialog) return;
    const oldName = exportDialog.originalName;
    const newName = exportNewName.trim() || oldName;
    const isRename = newName !== oldName;
    const suffix = exportMode === "new" ? "_v" + Date.now().toString(36).slice(-4) : "";
    const finalName = newName + suffix;

    // If renaming, update the code in stageData by replacing all occurrences
    if (isRename || suffix) {
      const mid = exportDialog.modId;
      if (mid) {
        updateModule(mid, (mod) => {
          const sd = Object.assign({}, mod.stageData);
          // Replace module name in RTL code
          if (sd[4] && sd[4].code) {
            sd[4] = Object.assign({}, sd[4], {
              code: sd[4].code.replace(new RegExp("\\b" + oldName + "\\b", "g"), finalName),
            });
          }
          // Replace in testbench
          if (sd[7] && sd[7].code) {
            sd[7] = Object.assign({}, sd[7], {
              code: sd[7].code.replace(new RegExp("\\b" + oldName + "\\b", "g"), finalName),
            });
          }
          // Update elicit modName
          if (sd[1]) {
            sd[1] = Object.assign({}, sd[1], { modName: finalName });
          }
          return Object.assign({}, mod, { stageData: sd, name: finalName });
        });
      }
    }
    // Call the actual export
    handleExport();
    setExportDialog(null);
  }

  const viewMeta = ALL_STAGES.find(function(s) { return s.id === viewingStage; });
  const curProv = PROVIDERS.find(function(pr) { return pr.id === config.provider; });
  const selSt = { background: "transparent", border: "none", padding: "2px 4px", fontSize: 11, width: "auto", color: TH.text0, fontFamily: TH.font, outline: "none" };

  // ── renderContent — stage content dispatcher ──────────────────────────────
  // Lives here rather than in useProject because it returns JSX and importing
  // stage components inside useProject would create a circular dependency.
  const renderContent = useCallback(function(id) {
    const err = stageErrors[id];
    if (err) return <ErrorBox msg={err} />;

    // Per-stage run selection.
    // Look up the run history for this stage (every recorded original
    // + reflow re-run). If the user has explicitly picked a non-latest
    // run via the dropdown OR the trace panel, swap the data source to
    // that run's `.result` snapshot. Otherwise default to `stageData[id]`
    // (the latest run, which is what existing consumers expect).
    const runs = (stageRuns && stageRuns[id]) || [];
    const selectedMap = (selectedRunByMod && selectedRunByMod[activeModId]) || {};
    const selectedRunId = selectedMap[id] != null ? selectedMap[id] : null;
    let d;
    if (selectedRunId != null) {
      const picked = runs.find(function(r) { return r.runId === selectedRunId; });
      // If the picked run has a real result snapshot, use it. Otherwise
      // fall back to live stageData — covers the "in-flight" case where
      // a run is currently running and its result isn't recorded yet.
      d = (picked && picked.result) || stageData[id];
    } else {
      d = stageData[id];
    }
    if (!d || !Object.keys(d).length) {
      // If this stage is currently running AND has
      // emitted at least one progress event, render a live activity
      // display instead of the empty "No data yet." placeholder.
      // Otherwise fall back to the original placeholder (covers the
      // very first moments before the first event lands, and the case
      // where the user is just inspecting an idle stage that hasn't
      // been run yet).
      const lp = liveProgress && liveProgress[id];
      const isRunning = activeStage === id && processing;
      if (isRunning && lp && lp.events && lp.events.length > 0) {
        return (
          <LiveProgressPanel
            stageId={id}
            progress={lp}
            onClear={typeof clearLiveProgress === "function"
              ? function() { clearLiveProgress(id); }
              : null
            }
          />
        );
      }
      if (isRunning) {
        return (
          <div style={{ padding: 40, textAlign: "center", color: TH.text2, fontSize: 12 }}>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 10,
              padding: "8px 14px",
              background: TH.bg0, border: "1px solid " + TH.yellow, borderRadius: 6,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: TH.yellow, animation: "pulse 1.2s infinite",
              }} />
              Starting stage…
            </div>
          </div>
        );
      }
      return <div style={{ padding: 40, textAlign: "center", color: TH.text2, fontSize: 12 }}>No data yet.</div>;
    }
    const isActive = !processing;
    const setSD = function(fn) {
      updateSD(id, typeof fn === "function" ? fn : function(prev) { return Object.assign({}, prev, fn); });
      // If this is a completed stage being manually edited, mark subsequent stages stale
      if (completed.has(id)) markStaleFrom(id);
    };
    switch (id) {
      case 1: return <ElicitStage data={d} setData={setSD} isActive={isActive} />;
      case 2: return <SpecStage data={d} setData={setSD} isActive={isActive} propagating={propagating}
        onPropagate={async function(source) {
          setPropagating(true);
          try {
            const latestSpec = (stageData[2] || {});
            const pr = promptPropagateSpec(source, latestSpec);
            pr.config = Object.assign({}, config);
            pr.maxTokens = 5000;
            const r = await callLLM(pr);
            const result = extractJSON(r.text);
            addLedger("spec-propagate", r);
            setSD(function(prev) {
              const merged = Object.assign({}, prev);
              if (source === "reqs") { if (result.iface) merged.iface = result.iface; if (result.params) merged.params = result.params; }
              else if (source === "iface") { if (result.requirements) merged.requirements = result.requirements; if (result.params) merged.params = result.params; }
              else if (source === "params") { if (result.requirements) merged.requirements = result.requirements; if (result.iface) merged.iface = result.iface; }
              return merged;
            });
          } catch (e) {
            console.error("[Propagate] Failed:", e);
            if (typeof window !== "undefined" && window.alert) window.alert("Propagation failed: " + e.message);
          }
          setPropagating(false);
        }} />;
      case 3: return <ArchStage data={d} spec={stageData[2]} />;
      case 4: {
        // CRASH FIX (this turn): a `{id, desc}` object reached SplitCodeView
        // wrapped as `{text: {id, desc}, source: ...}`, and panels.jsx then
        // tried to render `{text}` which React rejects.
        // RTL Review and Test Review nodes accumulate raw `{id, desc}`
        // objects in `_fixes` (unlike lint/lint_test/verify which normalise
        // to strings). The wrapping below crammed those raw objects into a
        // `text` slot that React expected to be a string.
        // Defensive fix: normalise here so any mix of strings, {id, desc},
        // {text, ...}, or {description} converges to a single string.
        const _fixToText = function(f) {
          if (f == null) return "";
          if (typeof f === "string") return f;
          if (typeof f === "object") {
            const id = f.id ? "[" + f.id + "] " : "";
            return id + (f.desc || f.description || f.text || JSON.stringify(f));
          }
          return String(f);
        };
        // Pull iter info from the {text, iter} fix shape produced by
        // lint/verify/lint_test/rtl_review nodes so the fix panel can
        // render "fixed post lint iteration N".
        const _fixIter = function(f) {
          if (f && typeof f === "object" && typeof f.iter === "number") return f.iter;
          if (f && typeof f === "object" && typeof f._iter === "number") return f._iter;
          return null;
        };
        const rtlFixes = [];
        const rtlIters = [{ label: "Original (RTL Gen)", source: "rtl_generate" }];
        if (d._fixSource) rtlFixes.push({ text: d._fixSource, source: d._fixSource });
        const reviewData = stageData[10];
        if (reviewData && reviewData._fixes) {
          reviewData._fixes.forEach(function(f) { rtlFixes.push({ text: _fixToText(f), source: "RTL Review", iter: _fixIter(f) }); });
          rtlIters.push({ label: "After RTL Review", source: "rtl_review" });
        }
        const lintD = stageData[6];
        if (lintD && lintD._fixes && lintD._fixes.length > 0) {
          // Surface accumulated lint fixes in the RTL Gen fix panel.
          // Without this, the snapshot showed post-fix code but the fix
          // panel said "No fixes applied".
          lintD._fixes.forEach(function(f) { rtlFixes.push({ text: _fixToText(f), source: "Lint Fix", iter: _fixIter(f) }); });
        }
        if (lintD && lintD.iterations && lintD.iterations.length > 1) rtlIters.push({ label: "After Lint Fix", source: "lint" });
        // Surface verify-induced RTL fixes the same way we surface lint
        // fixes. verify._fixes is set when the verify stage's RTL fix loop
        // made any code changes.
        const verifyD = stageData[8];
        if (verifyD && verifyD._fixes && verifyD._fixes.length > 0) {
          verifyD._fixes.forEach(function(f) { rtlFixes.push({ text: _fixToText(f), source: "Verify Fix", iter: _fixIter(f) }); });
        }
        if (d._fixSource && d._fixSource.indexOf("verify") >= 0) rtlIters.push({ label: "After Verify Fix", source: "verify" });
        if (d._fixSource && d._fixSource.indexOf("judge") >= 0) rtlIters.push({ label: "After Judge Fix", source: "judge" });
        // Collect every past RTL snapshot across all stages so the
        // SplitCodeView's "Compare past version" panel can show any
        // (step, iter) version paired with the current code. Pass stageRuns
        // to enable reflow-provenance labels ("Lint — run #3 · reflow inside
        // judge iter 1 (depth 1)").
        const rtlPast = collectRTLSnapshots(stageData, stageRuns);
        return (
          <CodeWithLogShell data={d} stageKey="rtl_generate" stageLabel="RTL Generate" codeLabel="RTL">
            <SplitCodeView code={d.code} label="RTL" maxH={550} fixes={rtlFixes} iterations={rtlIters} pastSnapshots={rtlPast} fixSource={d._fixSource} originalCode={d._originalCode} manualImport={d._manualImport} importedAt={d._importedAt}
              onRestore={isActive ? function(iterIdx) { if (iterIdx === -1 && d._originalCode) { setSD(function(prev) { return Object.assign({}, prev, { code: prev._originalCode, _fixSource: null }); }); } } : null}
              onChange={function(newCode) { setSD(function(prev) { return Object.assign({}, prev, { code: newCode, _userEdited: true }); }); }}
              onCommitEdit={function(entry) {
                // Record the manual edit in _manualEditHistory so
                // collectRTLSnapshots picks it up for the compare dropdown.
                setSD(function(prev) {
                  const hist = Array.isArray(prev._manualEditHistory) ? prev._manualEditHistory : [];
                  return Object.assign({}, prev, { _manualEditHistory: hist.concat([entry]) });
                });
              }}
            />
          </CodeWithLogShell>
        );
      }
      case 5: return <FormalPropsStage data={d} />;
      case 6: return <LintStage data={d} warningsAsErrors={lintWarningsAsErrors} setWarningsAsErrors={setLintWarningsAsErrors} maxIters={config.maxLintIters} />;
      case 7: {
        // Same _fixToText helper for the Test Gen split view; defensive
        // normalisation against any raw {id, desc} entries surfacing from
        // test_review or older checkpoints.
        const _fixToText = function(f) {
          if (f == null) return "";
          if (typeof f === "string") return f;
          if (typeof f === "object") {
            const id = f.id ? "[" + f.id + "] " : "";
            return id + (f.desc || f.description || f.text || JSON.stringify(f));
          }
          return String(f);
        };
        const _fixIter = function(f) {
          if (f && typeof f === "object" && typeof f.iter === "number") return f.iter;
          if (f && typeof f === "object" && typeof f._iter === "number") return f._iter;
          return null;
        };
        const tbFixes = [];
        const tbIters = [{ label: "Original (Test Gen)", source: "test_generate" }];
        if (d._fixSource) tbFixes.push({ text: d._fixSource, source: d._fixSource });
        const tReviewData = stageData[11];
        if (tReviewData && tReviewData._fixes) {
          tReviewData._fixes.forEach(function(f) { tbFixes.push({ text: _fixToText(f), source: "Test Review", iter: _fixIter(f) }); });
          tbIters.push({ label: "After Test Review", source: "test_review" });
        }
        // Mirror lint_test fixes into the Test Gen fix panel so snapshot +
        // fix list are consistent.
        const lintTestD = stageData[12];
        if (lintTestD && lintTestD._fixes && lintTestD._fixes.length > 0) {
          lintTestD._fixes.forEach(function(f) { tbFixes.push({ text: _fixToText(f), source: "Lint Test Fix", iter: _fixIter(f) }); });
        }
        if (lintTestD && lintTestD.iterations && lintTestD.iterations.length > 1) tbIters.push({ label: "After Lint Test Fix", source: "lint_test" });
        // Surface verify-induced TB fixes too. The same verify._fixes array
        // is mirrored from the verify stage; we attribute them to "Verify Fix"
        // so users can see what verify changed in the TB.
        const verifyDtb = stageData[8];
        if (verifyDtb && verifyDtb._fixes && verifyDtb._fixes.length > 0) {
          verifyDtb._fixes.forEach(function(f) { tbFixes.push({ text: _fixToText(f), source: "Verify Fix", iter: _fixIter(f) }); });
        }
        if (d._fixSource && d._fixSource.indexOf("verify") >= 0) tbIters.push({ label: "After Verify Fix", source: "verify" });
        if (d._fixSource && d._fixSource.indexOf("judge") >= 0) tbIters.push({ label: "After Judge Fix", source: "judge" });
        // Collect every past TB snapshot across all stages. Pass stageRuns
        // for reflow-provenance labels.
        const tbPast = collectTBSnapshots(stageData, stageRuns);
        return (
          <CodeWithLogShell data={d} stageKey="test_generate" stageLabel="Test Generate" codeLabel="Testbench">
            <SplitCodeView code={d.code} label="Testbench" maxH={550} fixes={tbFixes} iterations={tbIters} pastSnapshots={tbPast} fixSource={d._fixSource} originalCode={d._originalCode} manualImport={d._manualImport} importedAt={d._importedAt}
              onRestore={isActive ? function(iterIdx) { if (iterIdx === -1 && d._originalCode) { setSD(function(prev) { return Object.assign({}, prev, { code: prev._originalCode, _fixSource: null }); }); } } : null}
              onChange={function(newCode) { setSD(function(prev) { return Object.assign({}, prev, { code: newCode, _userEdited: true }); }); }}
              onCommitEdit={function(entry) {
                // Mirror of the RTL Gen handler — record manual edit in
                // _manualEditHistory so collectTBSnapshots surfaces it.
                setSD(function(prev) {
                  const hist = Array.isArray(prev._manualEditHistory) ? prev._manualEditHistory : [];
                  return Object.assign({}, prev, { _manualEditHistory: hist.concat([entry]) });
                });
              }}
            />
          </CodeWithLogShell>
        );
      }
      case 8: return <VerifyStage data={d} warningsAsErrors={verifyWarningsAsErrors} setWarningsAsErrors={setVerifyWarningsAsErrors} maxIters={config.maxVerifyIters} />;
      case 9: return <JudgeStage data={d} stageData={stageData} onExport={showExportDialog} onExportPackage={function() { exportModulePackage(activeModId); }} maxIters={config.maxJudgeIters} onSelectRun={function(stageId, runId) { setSelectedRun(stageId, runId, activeModId); setViewingStage(stageId); }} />;
      case 10: return <ReviewStage data={d} label="RTL Code Review" />;
      case 11: return <ReviewStage data={d} label="Testbench Review" />;
      case 12: return <LintStage data={d} warningsAsErrors={lintWarningsAsErrors} setWarningsAsErrors={setLintWarningsAsErrors} maxIters={config.maxLintIters} label="Lint Test" />;
      default: return null;
    }
  }, [stageErrors, stageData, activeStage, processing, updateSD, handleExport, exportModulePackage, activeModId, lintWarningsAsErrors, verifyWarningsAsErrors, propagating, setPropagating, addLedger, config]);

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", background: TH.bg1, color: TH.text0, fontFamily: TH.font, fontSize: 13, overflow: "hidden" }}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap');@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}@keyframes pulseFast{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.06)}}*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:" + TH.bg3 + " " + TH.bg0 + "}*::-webkit-scrollbar{width:5px}*::-webkit-scrollbar-track{background:" + TH.bg0 + "}*::-webkit-scrollbar-thumb{background:" + TH.bg3 + ";border-radius:3px}input,textarea,select,button{font-family:" + TH.font + "}"}</style>

      {/* ═══════ HEADER ═══════ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", borderBottom: "1px solid " + TH.border, background: TH.bg0, flexShrink: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 5, background: "linear-gradient(135deg," + TH.accent + "," + TH.blue + ")", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, color: TH.bg0 }}>⚡</div>
          <div>
            <div style={{ fontFamily: TH.fontD, fontWeight: 800, fontSize: 15, color: TH.text0, letterSpacing: -0.3 }}>
              RTL Forge
              {decomposition && decomposition.systemName && isMultiModule && <><span style={{ fontWeight: 400, color: TH.text2 }}> ▸ </span><span style={{ color: TH.blue, fontWeight: 600 }}>{decomposition.systemName}</span></>}
              {activeModId && activeModId !== "_init" && <><span style={{ fontWeight: 400, color: TH.text2 }}> ▸ </span><span style={{ color: TH.accent, fontWeight: 600 }}>{modName}</span></>}
            </div>
            <div style={{ fontSize: 9, color: TH.text3, letterSpacing: 1.2, textTransform: "uppercase" }}>
              {(function() {
                // Banner subtitle reflects the active workflow — users
                // running fpga / asic / hls workflows want their chosen flow
                // name shown here. Falls back to "Spec-based RTL flow" if the
                // registry has been wiped or the workflow isn't found.
                const wfName = (config && config.workflow) || "rtl";
                const wf = getWorkflow(wfName);
                return (wf && wf.label) || "Spec-based RTL flow";
              })()}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 4, background: TH.bg1, border: "1px solid " + TH.border }}><span style={{ fontSize: 9, color: TH.text3, fontWeight: 700 }}>MODE</span><select value={mode} onChange={function(e) { setMode(e.target.value); }} style={selSt}><option value="semi-auto">Semi-Auto</option><option value="full-auto">Full-Auto</option></select></div>
          <Tag color={curProv && curProv.local ? TH.accent : TH.blue} bg={curProv && curProv.local ? TH.accentDim : TH.blueDim}>{curProv && curProv.local ? "🖥" : "☁️"} {config.model}</Tag>
          {config.backendUrl && backendVerified === true && <Tag color={TH.green} bg="rgba(52,211,153,.12)">CLI ✓</Tag>}
          {config.backendUrl && backendVerified === false && <Tag color={TH.red} bg={TH.redDim}>CLI ✗</Tag>}
          {config.backendUrl && backendVerified === null && <Tag color={TH.yellow} bg={TH.yellowDim}>CLI ?</Tag>}
          {projectPhase === "running" && <button onClick={function() { saveCheckpointNow(); }} title={lastCheckpointTs ? "Last saved: " + lastCheckpointTs : "Save checkpoint"} style={{ background: saveFlash === "ok" ? TH.accentDim : (saveFlash === "fail" ? TH.redDim : TH.bg1), border: "1px solid " + (saveFlash === "ok" ? TH.accent : (saveFlash === "fail" ? TH.red : TH.border)), borderRadius: 4, padding: "5px 9px", cursor: "pointer", color: saveFlash === "ok" ? TH.accent : (saveFlash === "fail" ? TH.red : (lastCheckpointTs ? TH.accent : TH.text1)), fontSize: 13, fontFamily: TH.font, transition: "all .3s" }}>{saveFlash === "ok" ? "✓" : (saveFlash === "fail" ? "✗" : "💾")}</button>}
          <button onClick={function() { setShowSettings(true); }} style={{ background: TH.bg1, border: "1px solid " + TH.border, borderRadius: 4, padding: "5px 9px", cursor: "pointer", color: TH.text1, fontSize: 14, fontFamily: TH.font }}>⚙</button>
        </div>
      </div>

      {/* Pipeline progress bar */}
      {/* API key cleared on session restore */}
      {apiKeyClearedNotice && (
        <div style={{
          flexShrink: 0, background: TH.yellowDim, borderBottom: "1px solid rgba(251,191,36,.3)",
          padding: "6px 20px", display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ fontSize: 11, color: TH.yellow, flex: 1 }}>
            ⚠ Project restored, but the API key was not stored (we never persist it for security).
            {" "}Open <strong style={{ color: TH.yellow }}>Settings → LLM</strong> and re-enter your API key before running the next stage.
          </span>
          <button
            onClick={function() { setShowSettings(true); dismissApiKeyNotice(); }}
            style={{
              background: TH.yellow, border: "none", borderRadius: 3,
              padding: "3px 10px", cursor: "pointer", color: TH.bg0,
              fontSize: 10, fontWeight: 700, fontFamily: TH.font,
            }}
          >Open Settings</button>
          <button
            onClick={dismissApiKeyNotice}
            style={{
              background: "transparent", border: "1px solid " + TH.yellow, borderRadius: 3,
              padding: "3px 10px", cursor: "pointer", color: TH.yellow,
              fontSize: 10, fontFamily: TH.font,
            }}
          >Dismiss</button>
        </div>
      )}
      {pipelineProgress && pipelineProgress.modulesTotal > 0 && <div style={{ flexShrink: 0, background: TH.bg0, borderBottom: "1px solid " + TH.border }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 20px" }}>
          <div style={{ flex: 1, height: 4, background: TH.bg3, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 2, background: pipelineProgress.error ? TH.red : TH.accent, transition: "width .3s", width: ((pipelineProgress.modulesCompleted / pipelineProgress.modulesTotal) * 100) + "%" }} />
          </div>
          <span style={{ fontSize: 10, color: TH.text2, whiteSpace: "nowrap" }}>
            {pipelineProgress.error ? <span style={{ color: TH.red }}>⚠ {pipelineProgress.error}</span> : (pipelineProgress.currentModId ? <span>Module <span style={{ color: TH.accent, fontWeight: 600 }}>{pipelineProgress.currentModId}</span> — stage {pipelineProgress.currentStageId}/{activeStages.length} ({pipelineProgress.modulesCompleted}/{pipelineProgress.modulesTotal} done)</span> : <span style={{ color: TH.accent }}>All modules complete ✓</span>)}
          </span>
        </div>
      </div>}

      {/* ═══════ MAIN ═══════ */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>

        {/* Phase: idle — Launch page */}
        {projectPhase === "idle" && <div style={{ flex: 1, overflow: "auto" }}><div style={{ maxWidth: 660, margin: "auto", padding: "50px 24px", animation: "fadeIn .5s" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}><div style={{ fontSize: 48, marginBottom: 10 }}>⚡</div><h1 style={{ fontFamily: TH.fontD, fontSize: 26, fontWeight: 800, color: TH.text0, margin: "0 0 8px", letterSpacing: -0.5 }}>Describe Your Design</h1><p style={{ color: TH.text2, fontSize: 13, margin: "0 0 4px", lineHeight: 1.5 }}>Natural language → verified SystemVerilog with SVA properties</p><p style={{ color: TH.text3, fontSize: 11, margin: 0 }}>Module or System • 9-stage pipeline per module • Lint loop + CLI backend</p></div>
          <textarea value={userDesc} onChange={function(e) { setUserDesc(e.target.value); }} onKeyDown={function(e) { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && userDesc.trim() && !processing) { e.preventDefault(); handleLaunch(); } }} placeholder={designMode === "module" ? "e.g. I need a synchronous FIFO with configurable depth and data width…" : "e.g. AXI4-Lite crossbar with 2 masters and 4 slaves, each slave backed by a configurable-depth FIFO"} style={{ width: "100%", height: 130, background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, padding: 14, color: TH.text0, fontSize: 12, fontFamily: TH.font, resize: "vertical", outline: "none", lineHeight: 1.6 }} />
          {/* Module / System toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 6px" }}>
            <div style={{ display: "flex", background: TH.bg0, borderRadius: 6, padding: 3, border: "1px solid " + TH.border }}>
              <button onClick={function() { setDesignMode("module"); }} style={{ padding: "6px 16px", borderRadius: 4, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer", fontFamily: TH.font, letterSpacing: 0.3, transition: "all .15s", background: designMode === "module" ? TH.bg2 : "transparent", color: designMode === "module" ? TH.accent : TH.text2, boxShadow: designMode === "module" ? "inset 0 0 0 1px " + TH.accent : "none" }}>Module</button>
              <button onClick={function() { setDesignMode("system"); }} style={{ padding: "6px 16px", borderRadius: 4, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer", fontFamily: TH.font, letterSpacing: 0.3, transition: "all .15s", background: designMode === "system" ? TH.bg2 : "transparent", color: designMode === "system" ? TH.blue : TH.text2, boxShadow: designMode === "system" ? "inset 0 0 0 1px " + TH.blue : "none" }}>System</button>
            </div>
            <span style={{ fontSize: 10, color: TH.text3 }}>{designMode === "module" ? "Single module — skip decomposition, straight to elicit" : "Multi-module — decompose → review hierarchy → per-module pipeline"}</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "6px 0 18px" }}>
            {[{ text: "Synchronous FIFO with configurable depth", mode: "module" }, { text: "Round-robin arbiter for 4 masters", mode: "module" }, { text: "AXI4-Lite to APB bridge", mode: "module" }, { text: "SoC subsystem: bus arbiter + 3 peripherals with FIFOs", mode: "system" }].map(function(ex) {
              return <Chip key={ex.text} label={ex.text} onClick={function() { setUserDesc(ex.text); setDesignMode(ex.mode); }} />;
            })}
          </div>
          <Btn onClick={handleLaunch} disabled={!userDesc.trim() || processing} style={{ width: "100%", justifyContent: "center", padding: "10px 0", fontSize: 13 }}>{processing ? "⏳ Launching…" : designMode === "module" ? "🚀 Launch Module Pipeline" : "🚀 Decompose & Review"}</Btn>
          <p style={{ textAlign: "center", fontSize: 10, color: TH.text3, margin: "6px 0 0" }}>Ctrl+Enter to launch</p>
        </div></div>}

        {/* Phase: decomposing — Spinner */}
        {projectPhase === "decomposing" && <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ textAlign: "center" }}>
          <Spinner text="Decomposing system architecture…" />
          <p style={{ textAlign: "center", color: TH.text2, fontSize: 12, marginTop: 12 }}>Decomposing into module hierarchy</p>
        </div></div>}

        {/* Phase: review_decomp — DecompReview */}
        {projectPhase === "review_decomp" && decomposition && <div style={{ flex: 1, overflow: "auto" }}><DecompReview
          modules={modules} setModules={setModules}
          instances={instances} setInstances={setInstances}
          decomposition={decomposition} decompError={decompError}
          onConfirm={confirmDecomp} onRedecompose={handleRedecompose} onBack={handleBackToIdle}
          onImport={triggerImport}
          libraryMatches={libraryMatches} importedPackages={importedPackages} onApplyMatches={applyLibraryMatches}
        /></div>}

        {/* Phase: running/done — Sidebar + Stage view */}
        {(projectPhase === "running" || projectPhase === "done") && <div style={{ flex: 1, display: "flex", flexDirection: "row", overflow: "hidden" }}>

          {/* ─── Module Sidebar (multi-module only) ─── */}
          {isMultiModule && showSidebar && <div style={{ width: 210, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid " + TH.border, background: TH.bg0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid " + TH.border }}>
              <span style={{ fontSize: 10, color: TH.text3, textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Modules</span>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={triggerImport} title="Import module/system package" style={{ background: "none", border: "none", cursor: "pointer", color: TH.blue, fontSize: 12, fontFamily: TH.font, padding: "2px 4px" }}>📥</button>
                <button onClick={function() { setShowSidebar(false); }} style={{ background: "none", border: "none", cursor: "pointer", color: TH.text3, fontSize: 12, fontFamily: TH.font, padding: "2px 4px" }}>«</button>
              </div>
            </div>
            {/* Progress summary */}
            {moduleProgressSummary.total > 1 && <div style={{ padding: "6px 10px", borderBottom: "1px solid " + TH.border, display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ flex: 1, height: 3, background: TH.bg3, borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", background: moduleProgressSummary.errors > 0 ? TH.red : TH.accent, width: moduleProgressSummary.pct + "%", transition: "width .3s" }} />
              </div>
              <span style={{ fontSize: 9, color: TH.text3, whiteSpace: "nowrap" }}>{moduleProgressSummary.complete}/{moduleProgressSummary.total}</span>
            </div>}
            {/* Shared Package entry */}
            {sharedPackage && <button onClick={function() { setViewingSharedPkg(true); setViewingIntegration(false); }} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "7px 10px", border: "none", borderBottom: "1px solid " + TH.border, borderLeft: viewingSharedPkg ? "3px solid " + TH.blue : "3px solid transparent", background: viewingSharedPkg ? TH.bg2 : "transparent", cursor: "pointer", fontFamily: TH.font, transition: "all .12s" }}>
              <span style={{ fontSize: 13 }}>📦</span>
              <span style={{ fontSize: 11, fontWeight: viewingSharedPkg ? 700 : 500, color: viewingSharedPkg ? TH.blue : TH.text1, flex: 1, textAlign: "left" }}>{sharedPackage.packageName || "Shared Pkg"}</span>
              <Tag color={TH.blue} bg={TH.blueDim}>pkg</Tag>
            </button>}
            {/* Sidebar view tabs */}
            {Object.keys(instances).length > 0 && <div style={{ display: "flex", borderBottom: "1px solid " + TH.border, background: TH.bg1, flexShrink: 0 }}>
              {[{ id: "level", label: "By Level", color: TH.accent }, { id: "instance", label: "By Instance", color: TH.orange }].map(function(t) {
                return <button key={t.id} onClick={function() { setSidebarTab(t.id); }} style={{ flex: 1, padding: "5px 0", border: "none", cursor: "pointer", fontFamily: TH.font, fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", background: sidebarTab === t.id ? TH.bg2 : "transparent", color: sidebarTab === t.id ? t.color : TH.text3, borderBottom: sidebarTab === t.id ? "2px solid " + t.color : "2px solid transparent" }}>{t.label}</button>;
              })}
            </div>}
            {/* Search filter */}
            {Object.keys(modules).length > 6 && <div style={{ padding: "4px 8px", borderBottom: "1px solid " + TH.border }}>
              <input value={sidebarSearch} onChange={function(e) { setSidebarSearch(e.target.value); }} placeholder="Search modules…" style={{ width: "100%", background: TH.bg1, border: "1px solid " + TH.border, borderRadius: 3, padding: "4px 8px", fontSize: 10, color: TH.text0, outline: "none", fontFamily: TH.font }} />
            </div>}
            {/* Module list — level-based view (simplified for readability) */}
            <div style={{ flex: 1, overflow: "auto" }}>
              {(function() {
                const topId = decomposition ? decomposition.topModule : null;
                const effectiveLevels = computeEffectiveLevels(modules, instances, topId);
                let sortedIds = Object.keys(modules).slice().sort(function(a, b) {
                  const la = effectiveLevels[a] || 0, lb = effectiveLevels[b] || 0;
                  return la !== lb ? la - lb : a.localeCompare(b);
                });
                if (sidebarSearch.trim()) {
                  const q = sidebarSearch.toLowerCase();
                  sortedIds = sortedIds.filter(function(mId) { return mId.toLowerCase().indexOf(q) >= 0; });
                }
                return sortedIds.map(function(mId) {
                  const mod = modules[mId] || blankModule();
                  const isSel = mId === activeModId;
                  const level = effectiveLevels[mId] || 0;
                  const completedCount = mod.completed ? mod.completed.size : 0;
                  const hasErrors = mod.stageErrors ? Object.values(mod.stageErrors).some(function(e) { return !!e; }) : false;
                  const isProcessingMod = processing && mId === activeModId;
                  const isStale = !!staleModules[mId];
                  const staleEntry = staleModules[mId];
                  const staleColor = isStale && typeof staleEntry === "object" && staleEntry.type === "rtl_only" ? TH.orange : TH.yellow;
                  const totalStages = activeStages.length;
                  const pct = totalStages > 0 ? (completedCount / totalStages) : 0;
                  const isImported = !!mod.imported;
                  const ringSize = 18, ringStroke = 2.5, ringR = (ringSize - ringStroke) / 2, ringCirc = 2 * Math.PI * ringR;
                  return <button key={mId} onClick={function() { setViewingSharedPkg(false); setViewingIntegration(false); switchModule(mId); }}
                    style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "7px 8px", paddingLeft: 8 + level * 14, border: "none", borderLeft: isSel ? "3px solid " + TH.accent : (isStale ? "3px solid " + staleColor : "3px solid transparent"), background: isSel ? TH.bg2 : "transparent", cursor: "pointer", fontFamily: TH.font, transition: "all .12s", borderBottom: "1px solid " + TH.bg1 }}>
                    {isImported ? <span style={{ fontSize: 13, flexShrink: 0, width: 18, textAlign: "center" }}>📥</span> : (
                    <svg width={ringSize} height={ringSize} style={{ flexShrink: 0 }}>
                      <circle cx={ringSize / 2} cy={ringSize / 2} r={ringR} fill="none" stroke={TH.bg3} strokeWidth={ringStroke} />
                      {pct > 0 && <circle cx={ringSize / 2} cy={ringSize / 2} r={ringR} fill="none" stroke={hasErrors ? TH.red : (isStale ? staleColor : (pct >= 1 ? TH.accent : TH.yellow))} strokeWidth={ringStroke} strokeDasharray={ringCirc} strokeDashoffset={ringCirc * (1 - pct)} strokeLinecap="round" transform={"rotate(-90 " + ringSize / 2 + " " + ringSize / 2 + ")"} />}
                      {hasErrors && <circle cx={ringSize / 2} cy={ringSize / 2} r={2} fill={TH.red} />}
                      {isProcessingMod && <circle cx={ringSize / 2} cy={ringSize / 2} r={2} fill={TH.yellow} style={{ animation: "pulse 1s infinite" }} />}
                    </svg>)}
                    {level > 0 && <span style={{ color: TH.text3, fontSize: 9 }}>└</span>}
                    <span style={{ fontSize: 11, fontWeight: isSel ? 700 : 500, color: isSel ? TH.accent : (isImported ? TH.blue : (isStale ? staleColor : TH.text0)), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left" }}>{mId}</span>
                    {isStale && <span style={{ fontSize: 8, color: staleColor, fontWeight: 700 }}>⚠</span>}
                    {completedCount > 0 && !isStale && !isImported && <span style={{ fontSize: 9, color: TH.text3 }}>{completedCount}/{totalStages}</span>}
                  </button>;
                });
              })()}
            </div>
            {/* System Integration button */}
            <div style={{ borderTop: "1px solid " + TH.border, padding: 6 }}>
              <button onClick={function() { setViewingIntegration(true); setViewingSharedPkg(false); if (!activeIntStage) setActiveIntStage("int_lint"); }}
                disabled={!allModulesComplete && (!integrationState || integrationState.completed.size === 0)}
                style={{ width: "100%", padding: "7px 10px", background: viewingIntegration ? TH.bg2 : TH.bg1, border: "1px solid " + (viewingIntegration ? TH.orange : TH.border), borderRadius: 4, cursor: (allModulesComplete || (integrationState && integrationState.completed.size > 0)) ? "pointer" : "not-allowed", color: viewingIntegration ? TH.orange : (allModulesComplete ? TH.text1 : TH.text3), fontSize: 10, fontFamily: TH.font, textAlign: "left", fontWeight: viewingIntegration ? 700 : 500, opacity: (allModulesComplete || (integrationState && integrationState.completed.size > 0)) ? 1 : 0.4 }}>
                🔗 System Integration
                {integrationState && integrationState.completed.size > 0 && <span style={{ marginLeft: 6, fontSize: 9, color: TH.text3 }}>{integrationState.completed.size}/3</span>}
              </button>
            </div>
          </div>}

          {/* Sidebar collapse toggle */}
          {isMultiModule && !showSidebar && <div style={{ flexShrink: 0, borderRight: "1px solid " + TH.border, display: "flex", alignItems: "flex-start" }}>
            <button onClick={function() { setShowSidebar(true); }} style={{ background: TH.bg0, border: "none", borderRight: "1px solid " + TH.border, cursor: "pointer", color: TH.text3, fontSize: 12, fontFamily: TH.font, padding: "8px 5px", writingMode: "vertical-lr" }}>» Modules</button>
          </div>}

          {/* ─── Right Panel ─── */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Shared Package Viewer/Editor */}
            {viewingSharedPkg && sharedPackage ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", animation: "fadeIn .25s" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid " + TH.bg3, flexWrap: "wrap", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 22 }}>📦</span>
                    <div><div style={{ fontFamily: TH.fontD, fontSize: 15, fontWeight: 700, color: TH.blue }}>{sharedPackage.packageName}</div><div style={{ fontSize: 11, color: TH.text2 }}>Shared SystemVerilog package</div></div>
                    <Tag color={TH.accent} bg={TH.accentDim}>GENERATED</Tag>
                  </div>
                  <Btn variant="secondary" onClick={function() { setEditingSharedPkg(!editingSharedPkg); }} style={{ fontSize: 11 }}>{editingSharedPkg ? "Done Editing" : "✏ Edit"}</Btn>
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
                  {editingSharedPkg ? (
                    <textarea value={sharedPackage.code || ""} onChange={function(e) { setSharedPackage(function(prev) { return Object.assign({}, prev, { code: e.target.value }); }); }} style={{ width: "100%", minHeight: 400, background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: 16, color: TH.text1, fontSize: 11.5, lineHeight: 1.65, fontFamily: TH.font, resize: "vertical", outline: "none" }} />
                  ) : (
                    <CodeBlock code={sharedPackage.code || "// No package code generated"} maxH={550} />
                  )}
                </div>
              </div>
            ) : viewingIntegration && integrationState ? (
              /* Integration pipeline view */
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", animation: "fadeIn .25s" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid " + TH.border, background: TH.bg0, flexShrink: 0 }}>
                  {INT_STAGES.map(function(is) {
                    const isActive = activeIntStage === is.id;
                    const isDone = integrationState.completed.has(is.id);
                    const hasErr = !!(integrationState.errors && integrationState.errors[is.id]);
                    return <button key={is.id} onClick={function() { setActiveIntStage(is.id); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 4, border: isActive ? "1px solid " + TH.orange : "1px solid transparent", background: isActive ? TH.bg2 : "transparent", cursor: "pointer", fontFamily: TH.font }}>
                      <span style={{ width: 20, height: 20, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0, background: hasErr ? TH.redDim : (isDone ? TH.accentDim : TH.bg1), color: hasErr ? TH.red : (isDone ? TH.accent : TH.text3), border: "1.5px solid " + (hasErr ? TH.red : (isDone ? "rgba(0,255,180,.4)" : TH.border)) }}>{hasErr ? "!" : (isDone ? "✓" : "○")}</span>
                      <span style={{ fontSize: 10, fontWeight: isActive ? 700 : 500, color: isActive ? TH.text0 : TH.text2 }}>{is.label}</span>
                    </button>;
                  })}
                  {allModulesComplete && integrationState.completed.size === 0 && <button onClick={function() { runIntegrationPipeline(); }} disabled={processing} style={{ marginLeft: "auto", padding: "6px 14px", border: "1px solid " + TH.orange, borderRadius: 4, background: TH.orangeDim, color: TH.orange, fontSize: 11, fontWeight: 600, cursor: processing ? "not-allowed" : "pointer", fontFamily: TH.font, opacity: processing ? 0.5 : 1 }}>▶ Run Integration</button>}
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
                  {activeIntStage === "int_lint" && (function() {
                    const d = integrationState.stageData.int_lint;
                    const err = integrationState.errors && integrationState.errors.int_lint;
                    if (err) return <ErrorBox msg={err} />;
                    if (!d) return <div style={{ padding: 40, textAlign: "center", color: TH.text2, fontSize: 12 }}>Integration lint has not run yet.{allModulesComplete ? " Click ▶ Run Integration above." : " Complete all module pipelines first."}</div>;
                    return <div>
                      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}><Tag color={d.status === "PASS" ? TH.accent : TH.red} bg={d.status === "PASS" ? TH.accentDim : TH.redDim}>{d.status}</Tag><span style={{ fontSize: 12, color: TH.text1 }}>{d.summary}</span></div>
                      {(d.issues || []).length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{(d.issues || []).map(function(iss, i) {
                        return <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: iss.sev === "error" ? TH.redDim : TH.bg0, border: "1px solid " + (iss.sev === "error" ? TH.red : TH.border), borderRadius: 4, flexWrap: "wrap" }}>
                          <Tag color={iss.sev === "error" ? TH.red : TH.yellow} bg={iss.sev === "error" ? TH.redDim : TH.yellowDim}>{iss.sev}</Tag>
                          <Tag color={TH.blue} bg={TH.blueDim}>{iss.type}</Tag>
                          <span style={{ fontSize: 11, color: TH.text0, flex: 1 }}>{iss.msg}</span>
                        </div>;
                      })}</div>}
                    </div>;
                  })()}
                  {activeIntStage === "int_test" && (function() {
                    const d = integrationState.stageData.int_test;
                    if (!d) return <div style={{ padding: 40, textAlign: "center", color: TH.text2, fontSize: 12 }}>System testbench has not been generated yet.</div>;
                    return <div><CodeBlock code={d.code || "// No testbench code"} maxH={450} /></div>;
                  })()}
                  {activeIntStage === "int_judge" && (function() {
                    const d = integrationState.stageData.int_judge;
                    if (!d) return <div style={{ padding: 40, textAlign: "center", color: TH.text2, fontSize: 12 }}>Integration judge has not run yet.</div>;
                    return <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 24, padding: 20, marginBottom: 16 }}>
                        <div style={{ width: 86, height: 86, borderRadius: "50%", background: "conic-gradient(" + (d.overall === "PASS" ? TH.accent : TH.red) + " " + (d.score || 0) + "%, " + TH.bg3 + " " + (d.score || 0) + "%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <div style={{ width: 66, height: 66, borderRadius: "50%", background: TH.bg2, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: TH.fontD, fontSize: 24, fontWeight: 800, color: d.overall === "PASS" ? TH.accent : TH.red }}>{d.score || 0}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 26, fontWeight: 800, color: d.overall === "PASS" ? TH.accent : TH.red, fontFamily: TH.fontD }}>{d.overall}</div>
                          <div style={{ fontSize: 12, color: TH.text2, marginBottom: 10 }}>System Integration Score</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <Btn onClick={handleExportAll} style={{ fontSize: 11 }}>📦 Export Regression Suite</Btn>
                            <Btn variant="secondary" onClick={handleCopyManifest} style={{ fontSize: 11 }}>📋 Copy Manifest</Btn>
                            <Btn variant="secondary" onClick={exportSystemPackage} disabled={d.overall !== "PASS"} style={{ fontSize: 11, opacity: d.overall === "PASS" ? 1 : 0.45 }}>📤 Export System Package</Btn>
                          </div>
                        </div>
                      </div>
                    </div>;
                  })()}
                </div>
              </div>
            ) : (
            /* Normal stage view */
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {/* Stage tabs */}
              {activeStage > 0 && <div style={{ display: "flex", alignItems: "stretch", borderBottom: "1px solid " + TH.border, background: TH.bg0, flexShrink: 0, overflowX: "auto" }}>
                {activeStages.map(function(s) {
                  const done = completed.has(s.id), isCur = activeStage === s.id, isView = viewingStage === s.id, hasErr = !!stageErrors[s.id];
                  const isStale = !!(staleModules[(activeModId || "") + ":" + s.id]);
                  // This stage is currently being looped back to (i.e. an
                  // upstream stage that verify or judge is fixing inside its
                  // regen loop). Render brighter yellow + faster pulse so the
                  // user can see at a glance which previously-completed stage
                  // is being re-worked.
                  //
                  // Scope the loopback animation to the active module: the
                  // loopback object carries `modId`, so we restrict the pulse
                  // to ticks where the loopback module matches what the user is
                  // currently viewing. (loopbackModId being null is treated as
                  // "matches any" for single-module callers that don't carry a
                  // modId.) Without this, system mode would pulse a completed
                  // step in module A's tab strip when module B was the one
                  // looping back.
                  const loopbackInThisMod = !loopbackModId || loopbackModId === activeModId;
                  // A stage is "loopback-active" (fast-blinking yellow) when
                  // EITHER the single-target loopbackStageId points at it, OR
                  // it's a member of the multi-stage reflow set published by
                  // the K-to-X chain runner. We OR the two conditions so the
                  // point-fix flow (loopbackStageId) and the chain flow
                  // (reflowStageIds) both light up the badge.
                  //
                  // The currently-EXECUTING stage (isCur) still gets the slow
                  // pulse, so we exclude it from the fast-blink even if it's
                  // technically in the reflow set. The user's ask was: every
                  // OTHER stage active in the reflow should fast-blink.
                  const reflowInThisMod = !reflowModId || reflowModId === activeModId;
                  const stageInReflowSet = reflowStageIds
                    && reflowInThisMod
                    && reflowStageIds.has(s.id);
                  // The badge shape (triangle vs circle), the replay-arrow
                  // swap, and the loopback animation are all decided inside the
                  // stageBadgeStyle helper below. We just pass the flags in.
                  // Check if the stage completed but with a functional failure
                  const sd = stageData[s.id];
                  const hasFuncFail = done && sd && (
                    sd.status === "FAIL" || sd.overall === "FAIL" ||
                    (sd.fail != null && sd.fail > 0) ||
                    (sd.verdict === "NEEDS_FIX")
                  );
                  // A stage tab is "reachable" (clickable, full opacity)
                  // whenever the user has something they can view inside it.
                  // That includes:
                  //   - done    — completed (with or without func fail)
                  //   - isCur   — currently-active stage
                  //   - isStale — marked stale by a downstream re-run
                  //   - hasErr  — stage threw a hard error. The Retry
                  //     button lives inside the stage content area, so
                  //     blocking the tab blocks access to retry. Without
                  //     this clause a failed lint shows a red `!` badge
                  //     but is greyed out at opacity 0.25, trapping the
                  //     user with no way to read the error or retry.
                  //   - sd != null — partial stage data is present even
                  //     though the stage isn't `done`. This guards
                  //     against any future code path that writes data
                  //     without dispatching MODULE_STAGE_COMPLETE.
                  const reachable = done || isCur || isStale || hasErr || (sd != null);
                  // Delegate badge styling to the stageBadgeStyle helper so
                  // the logic is testable in isolation. The helper produces:
                  //   - badgeStyle (object to spread onto <span>)
                  //   - badgeText  (string content)
                  //   - shape/animation/flags derived from the inputs
                  const _badge = stageBadgeStyle({
                    stageId:        s.id,
                    done:           done,
                    isCur:          isCur,
                    isStale:        isStale,
                    hasErr:         hasErr,
                    hasFuncFail:    hasFuncFail,
                    inReflowSet:    stageInReflowSet,
                    legacyLoopback: loopbackStageId === s.id && loopbackInThisMod,
                    processing:     !!processing,
                  });
                  return <button key={s.id} onClick={function() { if (reachable) setViewingStage(s.id); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", border: "none", cursor: reachable ? "pointer" : "default", background: isView ? TH.bg2 : "transparent", borderBottom: isView ? "2px solid " + TH.accent : "2px solid transparent", opacity: reachable ? 1 : 0.25, transition: "all .15s", fontFamily: TH.font, whiteSpace: "nowrap" }}>
                    <span style={_badge.badgeStyle}>{_badge.badgeText}</span>
                    <span style={{ fontSize: 10, fontWeight: isView ? 700 : 500, color: isView ? TH.text0 : TH.text2 }}>{s.label}</span>
                  </button>;
                })}
              </div>}
              {/* Stage content area */}
              {activeStage > 0 && viewingStage > 0 ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", animation: "fadeIn .25s" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid " + TH.bg3, flexWrap: "wrap", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontFamily: TH.fontD, fontSize: 20, fontWeight: 800, color: TH.accent }}>{String(viewingStage).padStart(2, "0")}</span>
                      <div><div style={{ fontFamily: TH.fontD, fontSize: 15, fontWeight: 700, color: TH.text0 }}>{viewMeta ? viewMeta.label : ""}</div><div style={{ fontSize: 11, color: TH.text2 }}>{viewMeta ? viewMeta.desc : ""}</div></div>
                      {completed.has(viewingStage) && !stageErrors[viewingStage] && <Tag color={TH.accent} bg={TH.accentDim}>COMPLETE</Tag>}
                      {stageErrors[viewingStage] && <Tag color={TH.red} bg={TH.redDim}>ERROR</Tag>}
                      {activeStage === viewingStage && processing && <Tag color={TH.yellow} bg={TH.yellowDim}>RUNNING…</Tag>}
                      {activeStage === viewingStage && processing && <button onClick={abortCurrentStage} style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid " + TH.red, background: TH.redDim, color: TH.red, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: TH.font }}>✕ Abort</button>}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {completed.has(viewingStage) && <Btn variant="danger" onClick={function() { handleRerun(viewingStage); }} disabled={processing}>⟲ Re-run</Btn>}
                      {stageErrors[viewingStage] && <Btn variant="secondary" onClick={function() { runStage(viewingStage); }} disabled={processing}>↻ Retry</Btn>}
                      {!completed.has(viewingStage) && !stageErrors[viewingStage] && !processing && viewingStage === activeStage && <Btn onClick={function() { runStage(viewingStage); }} disabled={processing}>▶ Run</Btn>}
                      {viewingStage === 4 && !processing && <Btn variant="secondary" onClick={function() { setManualImportDialog({ stageId: 4, label: "RTL" }); setManualImportText(""); }}>📁 Import RTL</Btn>}
                      {viewingStage === 7 && !processing && <Btn variant="secondary" onClick={function() { setManualImportDialog({ stageId: 7, label: "Testbench" }); setManualImportText(""); }}>📁 Import TB</Btn>}
                      {viewingStage === activeStage && completed.has(activeStage) && activeStages.findIndex(function(s) { return s.id === activeStage; }) < activeStages.length - 1 && !processing && <Btn onClick={proceed}>{mode === "full-auto" ? "▶ Run All" : "Proceed →"}</Btn>}
                    </div>
                  </div>
                  <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
                    {/* Imported module banner */}
                    {activeModId && modules[activeModId] && modules[activeModId].imported && <div style={{ marginBottom: 12, padding: "8px 14px", background: TH.blueDim, border: "1px solid rgba(56,189,248,.3)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <span style={{ fontSize: 11, color: TH.blue }}>📥 Imported{modules[activeModId].importSource ? " from " + modules[activeModId].importSource : ""} — read-only</span>
                      <button onClick={function() { detachModule(activeModId); }} style={{ background: "none", border: "1px solid " + TH.blue, borderRadius: 4, padding: "3px 10px", cursor: "pointer", color: TH.blue, fontSize: 10, fontWeight: 600, fontFamily: TH.font }}>🔓 Detach</button>
                    </div>}
                    {/* Per-stage run selector dropdown. Only renders when the stage has been
                        run more than once (original + at least one
                        reflow re-run). When the user picks a non-latest
                        run, renderContent below reads from that run's
                        snapshot via the same selectedRunByMod lookup. */}
                    {viewingStage > 0
                      && stageRuns
                      && stageRuns[viewingStage]
                      && stageRuns[viewingStage].length > 1 && (
                      <RunSelectorDropdown
                        stageId={viewingStage}
                        runs={stageRuns[viewingStage]}
                        selectedRunId={
                          (selectedRunByMod && selectedRunByMod[activeModId]
                            && selectedRunByMod[activeModId][viewingStage])
                          || null
                        }
                        onSelectRun={function(runId) {
                          setSelectedRun(viewingStage, runId, activeModId);
                        }}
                      />
                    )}
                    {renderContent(viewingStage)}
                    {/* Collapsed live-activity pill. When the
                        stage has finished but progress events were captured
                        during the run, render this pill below the stage
                        content so the user can re-expand the in-flight
                        trace. Visible only when stageData[viewingStage]
                        exists (i.e. we're rendering completed content). */}
                    {viewingStage > 0
                      && stageData[viewingStage]
                      && Object.keys(stageData[viewingStage] || {}).length > 0
                      && liveProgress
                      && liveProgress[viewingStage]
                      && liveProgress[viewingStage].events
                      && liveProgress[viewingStage].events.length > 0 && (
                      <LivePillContainer
                        stageId={viewingStage}
                        progress={liveProgress[viewingStage]}
                        onClear={typeof clearLiveProgress === "function"
                          ? function() { clearLiveProgress(viewingStage); }
                          : null
                        }
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: TH.text2, fontSize: 12 }}>Select a stage to view</div>
              )}
            </div>
            )}
          </div>
        </div>}
      </div>

      {/* ═══════ Dialogs ═══════ */}
      {showSettings && <SettingsPanel
        config={config} setConfig={setConfig} onClose={function() { setShowSettings(false); }}
        onSave={saveCheckpointNow}
        importedPackages={importedPackages}
        onDeletePackage={deletePackageFromLibrary} onRedownloadPackage={redownloadPackage} onClearLibrary={clearLibrary}
        checkpointIndex={checkpointIndex} onDeleteCheckpoint={discardCheckpoint} onClearCheckpoints={function() { setCheckpointIndex([]); }}
        onBackendVerified={setBackendVerified}
      />}
      {pendingResume && <ResumeDialog
        checkpoint={pendingResume}
        onResume={function(ck) { resumeFromCheckpoint(ck).then(function() { setPendingResume(null); }); }}
        onDiscard={function(pid) { discardCheckpoint(pid); setPendingResume(null); }}
      />}
      {/* Manual import dialog */}
      {manualImportDialog && (function() {
        const dia = manualImportDialog;
        return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", zIndex: 210, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .2s" }} onClick={function(e) { if (e.target === e.currentTarget) setManualImportDialog(null); }}>
          <div style={{ background: TH.bg2, border: "1px solid " + TH.border, borderRadius: 8, width: 600, maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 24 }}>
            <h3 style={{ fontFamily: TH.fontD, fontSize: 16, fontWeight: 700, color: TH.text0, margin: "0 0 4px" }}>Import {dia.label} Code</h3>
            <div style={{ fontSize: 12, color: TH.text2, marginBottom: 16 }}>Paste your {dia.label} code below or upload a file.</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Btn variant="secondary" onClick={function() { manualImportFileRef.current && manualImportFileRef.current.click(); }}>📂 Upload File</Btn>
              <input ref={manualImportFileRef} type="file" accept=".sv,.v,.svh,.vh,.txt" style={{ display: "none" }} onChange={function(e) { if (e.target.files && e.target.files[0]) { const reader = new FileReader(); reader.onload = function(ev) { setManualImportText(ev.target.result || ""); }; reader.readAsText(e.target.files[0]); e.target.value = ""; } }} />
              {manualImportText && <span style={{ fontSize: 11, color: TH.accent, alignSelf: "center" }}>✓ {manualImportText.split("\n").length} lines loaded</span>}
            </div>
            <textarea value={manualImportText} onChange={function(e) { setManualImportText(e.target.value); }} placeholder={"Paste your " + dia.label + " SystemVerilog code here…"} style={{ width: "100%", flex: 1, minHeight: 250, background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: 12, color: TH.text0, fontSize: 11.5, fontFamily: TH.font, resize: "vertical", outline: "none", lineHeight: 1.6 }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <Btn variant="secondary" onClick={function() { setManualImportDialog(null); setManualImportText(""); }}>Cancel</Btn>
              <Btn onClick={function() { handleManualImport(dia.stageId, manualImportText); }} disabled={!manualImportText.trim()}>📥 Import {dia.label}</Btn>
            </div>
          </div>
        </div>;
      })()}
      {/* Export rename dialog */}
      {exportDialog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", zIndex: 210, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .2s" }} onClick={function(e) { if (e.target === e.currentTarget) setExportDialog(null); }}>
          <div style={{ background: TH.bg2, border: "1px solid " + TH.border, borderRadius: 8, width: 480, padding: 24 }}>
            <h3 style={{ fontFamily: TH.fontD, fontSize: 16, fontWeight: 700, color: TH.text0, margin: "0 0 14px" }}>Export Regression Suite</h3>
            <div style={{ marginBottom: 14 }}>
              <Label>Module Name</Label>
              <div style={{ fontSize: 10, color: TH.text2, marginBottom: 6 }}>Changing the name will update all references in RTL, testbench, and filenames.</div>
              <input value={exportNewName} onChange={function(e) { setExportNewName(e.target.value); }} style={{ width: "100%", background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 4, padding: "7px 11px", color: TH.text0, fontSize: 12, fontFamily: TH.font, outline: "none" }} />
            </div>
            {exportNewName.trim() && exportNewName.trim() !== exportDialog.originalName && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                <label style={{ display: "flex", gap: 10, padding: "10px 14px", background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, cursor: "pointer", alignItems: "flex-start" }}>
                  <input type="radio" name="exportMode" value="overwrite" checked={exportMode === "overwrite"} onChange={function() { setExportMode("overwrite"); }} style={{ marginTop: 3, accentColor: TH.accent }} />
                  <div><div style={{ fontSize: 12, fontWeight: 700, color: TH.text0 }}>Overwrite existing</div><div style={{ fontSize: 11, color: TH.text2, lineHeight: 1.5 }}>Replace all occurrences of &quot;{exportDialog.originalName}&quot; with &quot;{exportNewName.trim()}&quot;. No suffix.</div></div>
                </label>
                <label style={{ display: "flex", gap: 10, padding: "10px 14px", background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, cursor: "pointer", alignItems: "flex-start" }}>
                  <input type="radio" name="exportMode" value="new" checked={exportMode === "new"} onChange={function() { setExportMode("new"); }} style={{ marginTop: 3, accentColor: TH.accent }} />
                  <div><div style={{ fontSize: 12, fontWeight: 700, color: TH.text0 }}>Export as new component</div><div style={{ fontSize: 11, color: TH.text2, lineHeight: 1.5 }}>Adds a version suffix to &quot;{exportNewName.trim()}&quot; so the original is preserved.</div></div>
                </label>
              </div>
            )}
            <div style={{ padding: "8px 12px", background: TH.orangeDim, border: "1px solid rgba(251,146,60,.2)", borderRadius: 5, fontSize: 11, color: TH.orange, lineHeight: 1.5, marginBottom: 14 }}>
              {exportNewName.trim() !== exportDialog.originalName
                ? "This will rename all references from \"" + exportDialog.originalName + "\" to \"" + exportNewName.trim() + (exportMode === "new" ? "_vXXXX" : "") + "\" in RTL, testbench, and package files."
                : "Export with the current module name. No renaming will occur."}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={function() { setExportDialog(null); }}>Cancel</Btn>
              <Btn onClick={doExport} disabled={!exportNewName.trim()}>📦 Confirm Export</Btn>
            </div>
          </div>
        </div>
      )}
      {/* Hidden file input for package import */}
      <input ref={importFileRef} type="file" accept=".rtlpkg.json,.rtlsyspkg.json,.json" style={{ display: "none" }} onChange={function(e) { if (e.target.files && e.target.files[0]) { importPackage(e.target.files[0]); e.target.value = ""; } }} />
      {/* System import mode selection dialog */}
      {importDialog && (function() {
        const sysPkg = importDialog.pkg;
        const sys = sysPkg.system || {};
        const modCount = Object.keys(sysPkg.modules || {}).length;
        const instCount = (sysPkg.instances || []).length;
        return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", zIndex: 210, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .2s" }} onClick={function(e) { if (e.target === e.currentTarget) setImportDialog(null); }}>
          <div style={{ background: TH.bg2, border: "1px solid " + TH.border, borderRadius: 8, width: 480, padding: 24 }}>
            <h3 style={{ fontFamily: TH.fontD, fontSize: 16, fontWeight: 700, color: TH.text0, margin: "0 0 4px" }}>Import &quot;{sys.systemName || "system"}&quot;</h3>
            <div style={{ fontSize: 12, color: TH.text2, marginBottom: 16 }}>{modCount} module{modCount !== 1 ? "s" : ""}, {instCount} instance{instCount !== 1 ? "s" : ""}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
              <label style={{ display: "flex", gap: 10, padding: "10px 14px", background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, cursor: "pointer", alignItems: "flex-start" }}>
                <input type="radio" name="importMode" value="blackbox" defaultChecked style={{ marginTop: 3, accentColor: TH.accent }} />
                <div><div style={{ fontSize: 12, fontWeight: 700, color: TH.text0 }}>⊡ Black-box</div><div style={{ fontSize: 11, color: TH.text2, lineHeight: 1.5 }}>Only the top module as a reusable leaf.</div></div>
              </label>
              <label style={{ display: "flex", gap: 10, padding: "10px 14px", background: TH.bg0, border: "1px solid " + TH.border, borderRadius: 6, cursor: "pointer", alignItems: "flex-start" }}>
                <input type="radio" name="importMode" value="exploded" style={{ marginTop: 3, accentColor: TH.accent }} />
                <div><div style={{ fontSize: 12, fontWeight: 700, color: TH.text0 }}>⬡ Exploded</div><div style={{ fontSize: 11, color: TH.text2, lineHeight: 1.5 }}>All {modCount} modules + instances loaded.</div></div>
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={function() { setImportDialog(null); }}>Cancel</Btn>
              <Btn onClick={function() {
                let importMode = "blackbox";
                if (typeof document !== "undefined") {
                  const radios = document.querySelectorAll("input[name=importMode]");
                  radios.forEach(function(r) { if (r.checked) importMode = r.value; });
                }
                if (importMode === "blackbox") importSystemBlackBox(sysPkg);
                else importSystemExploded(sysPkg);
                setImportDialog(null);
              }}>📥 Import</Btn>
            </div>
          </div>
        </div>;
      })()}
    </div>
  );
}
