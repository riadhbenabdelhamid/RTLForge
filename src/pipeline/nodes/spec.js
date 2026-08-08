// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/spec — Stage 2: Formal Specification
//
// Three modes:
// 1. Elicit-driven (normal): uses promptSpec with answered elicit questions.
// 2. Full-auto (no elicit): uses promptSpecFromDescription to derive a spec
//    directly from the user description, then synthesises a minimal elicit
//    object with modName/domain so downstream stages have el.modName to
//    reference.
// 3. IMPORTED (st._specImport): the user already has a specification, so it
//    is read rather than generated — .json, .yaml or .md, see specImport.
//    No model is consulted, and a file that cannot be read HALTS the run
//    naming the line and field at fault, because the fix belongs to the user
//    and guessing at their intent is exactly what an imported spec is meant
//    to avoid. Everything after this stage is identical either way.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLMJson, addRetryHint } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptSpec, promptSpecFromDescription } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { detectMalformedSpec, repairSpecPortNames } from "../fixLoopHelpers.js";
import { importSpec, formatImportIssues } from "../../utils/specImport.js";

/**
 * Override each requirement's cat to match its id prefix.
 *
 * The id is more reliably tied to intent than the free-text cat, and the eval
 * gate buckets by cat — so a mismatch would mis-bucket the requirement. Shared
 * by the generated and imported paths: an imported spec gets the same
 * correction, which is why specImport reports a mismatch as a warning rather
 * than refusing the file.
 */
function alignRequirementCats(specData, onLog) {
  if (!specData || !Array.isArray(specData.requirements)) return;
  const PREFIX_TO_CAT = {
    INTF:  "Interface",
    FUNC:  "Functionality",
    TIME:  "Timing",
    ERR:   "Error",
    VERIF: "Verification",
  };
  let aligned = 0;
  specData.requirements = specData.requirements.map(function(req) {
    if (!req || typeof req.id !== "string") return req;
    const m = /^REQ-([A-Z]+)-\d+$/.exec(req.id);
    if (!m) return req;
    const expectedCat = PREFIX_TO_CAT[m[1]];
    if (!expectedCat) return req;
    if (req.cat !== expectedCat) {
      aligned++;
      return Object.assign({}, req, { cat: expectedCat });
    }
    return req;
  });
  if (aligned > 0 && onLog) {
    onLog("ℹ spec node: auto-corrected " + aligned +
      " requirement(s) whose cat field didn't match the id-prefix.");
  }
}

/**
 * Read the user's own specification into this stage.
 *
 * Returns the same shape the generated path returns, with an empty LLM ledger
 * — nothing was spent. Throws when the file cannot be read, with every problem
 * listed against its line: the user owns this file, so the run stops and says
 * what to fix rather than proceeding on a half-understood contract.
 */
function specFromImport(st) {
  const src = st._specImport;
  const name = (src && src.filename) || "spec file";
  const res = importSpec(src.text, name);

  const warnings = (res.issues || []).filter(function(i) { return i.severity === "warning"; });
  if (!res.ok) {
    const errs = (res.issues || []).filter(function(i) { return i.severity === "error"; });
    if (st._onLog) {
      st._onLog("✗ SPEC IMPORT FAILED — " + name + "\n" + formatImportIssues(res.issues, name));
    }
    throw new Error(
      "Could not import the specification from " + name + " — "
      + errs.length + " problem" + (errs.length === 1 ? "" : "s") + " to fix:\n"
      + formatImportIssues(errs, name)
      + "\nNothing was generated: correct the file and run the stage again.");
  }

  const specData = res.spec;
  if (st._onLog) {
    st._onLog("✓ SPEC IMPORTED — " + name + " (" + res.format + ")\n"
      + specData.requirements.length + " requirement(s), " + specData.iface.length + " port(s), "
      + specData.params.length + " parameter(s)"
      + (warnings.length > 0 ? "\n" + formatImportIssues(warnings, name) : ""));
  }

  alignRequirementCats(specData, st._onLog);
  // A SYSTEM run's decomposition owns the module name (run 47): the top level
  // instantiates this child by that id, so a spec file naming it otherwise
  // would break the instantiation rather than rename anything.
  if (st._modName && specData.modName !== st._modName) {
    if (st._onLog) {
      st._onLog("↻ MODULE NAME FROM DECOMPOSITION\n"
        + "the imported spec names \"" + specData.modName + "\"; the system instantiates this child as \""
        + st._modName + "\" — using the decomposition's name.");
    }
    specData.modName = st._modName;
  }

  specData._llms = [];
  specData._importedFrom = { filename: name, format: res.format };
  return {
    spec: specData,
    // Downstream stages read el.modName; an imported spec supplies it without
    // an elicit ever having run.
    elicit: {
      modName: specData.modName,
      domain: specData.domain || "",
      questions: [],
      assumptions: [],
      answers: {},
      customAnswers: {},
      _fromImport: true,
    },
    _llm: null,
    _llms: [],
  };
}

export async function specNode(st) {
  // An imported specification replaces the generation entirely — no prompt is
  // built and no model is called.
  if (st._specImport && String(st._specImport.text || "").trim()) {
    return specFromImport(st);
  }
  const ci = st._childInterfaces || [];
  const hasElicit = st.elicit && st.elicit.modName && st.elicit.questions && st.elicit.questions.length > 0;

  let p;
  const extraReturn = {};

  if (hasElicit) {
    p = promptSpec(st.elicit, ci, st._userDesc);
  } else {
    // Full-auto mode: generate spec directly from the user description
    p = promptSpecFromDescription(st._userDesc, ci);
  }

  // Skill overlay applies to both modes — same stageKey "spec".
  p = await applySkillsToPrompt(p, st, "spec");

  const _sc = getStageConfig(st._config, "spec");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  // Cross-RUN hint: when the user manually re-runs the stage after a
  // failure, st._lastError carries the previous run's message.
  addRetryHint(p, st._lastError);

  // callLLMJson adds the IN-CALL recovery: callLLM + extractJSON + one
  // hinted re-ask when the reply fails to parse (the spec's long
  // requirement lists are a frequent JSON-defect source). jr.llms carries
  // every attempt so the ledger sees real spend.
  let jr = await callLLMJson(p);
  let specData = jr.data;
  let allJrLlms = jr.llms;

  // ─── Malformed-spec guard (measured: run 12) ──────────────────────────
  // The spec LLM once returned a bare port-map (no requirements/iface
  // arrays) and dropped a user-named port (wr_en); every downstream stage
  // built and reviewed against that broken contract for 3.5 hours. Same
  // pattern as the cold-gen implausible-artifact guard: one corrective
  // re-ask, then an honest halt for SCHEMA problems only. Missing
  // user-named ports and advisories (e.g. no functional-Must requirement,
  // run 17) join the re-ask but stay non-fatal after it — the eval gate
  // keeps final, user-configurable authority over the contract's content.
  //
  // The functional-Must advisory is skipped entirely when the user disabled
  // the req_func_must criterion — the guard must not be stricter than the
  // gate it front-runs.
  const _evalCrit = (st._config && st._config.evalCriteria) || {};
  const _fmOpts = {
    checkFuncMust: !(_evalCrit.req_func_must && _evalCrit.req_func_must.enabled === false),
  };
  let _malformed = detectMalformedSpec(specData, st._userDesc, _fmOpts);
  // Deterministic rename repair BEFORE spending an LLM re-ask (run 43): a
  // decorated port name (wdata_i for a described wdata) is mechanical.
  if (_malformed && (_malformed.fidelity || []).length > 0) {
    const _rep = repairSpecPortNames(specData, st._userDesc);
    if (_rep.renamed.length > 0) {
      specData = _rep.spec;
      if (st._onLog) st._onLog("✂ SPEC PORT RENAME REPAIR\n"
        + _rep.renamed.map(function(r) { return r.from + " → " + r.to; }).join(", "));
      _malformed = detectMalformedSpec(specData, st._userDesc, _fmOpts);
    }
  }
  if (_malformed) {
    const _issueLines = _malformed.schema.map(function(s) { return "- " + s; })
      .concat((_malformed.fidelity || []).map(function(v) { return "- " + v; }))
      .concat(_malformed.missingPorts.map(function(t) {
        return "- the user's description names the signal \"" + t + "\" — it must appear as an iface port";
      }))
      .concat((_malformed.advisories || []).map(function(a) { return "- " + a; }));
    if (st._onLog) st._onLog("↻ SPEC-SCHEMA RE-ASK\n"
      + "The spec output needs correction — re-asking with the exact requirements:\n"
      + _issueLines.join("\n"));
    // Up to TWO corrective re-asks (run 43: the first re-ask took 9 fidelity
    // violations to 1 on one attempt and to 3 on another — converging both
    // times — and the single-round halt threw that progress away twice).
    // Each round rebuilds the issue list from the CURRENT output; a round
    // that does not reduce the violation count stops early, since a model
    // ignoring the correction will keep ignoring it.
    let _issues = _issueLines;
    let _prevCount = _issues.length;
    for (let _reask = 1; _reask <= 2 && _malformed; _reask++) {
      if (_reask > 1 && st._onLog) st._onLog("↻ SPEC-SCHEMA RE-ASK (round " + _reask + ")\n" + _issues.join("\n"));
      const p2 = Object.assign({}, p, {
        userMessage: (p.userMessage || "") + "\n\n━━ SPEC CONTRACT REQUIREMENTS ━━\n"
          + "The previous output was structurally incomplete. Return the complete spec JSON with:\n"
          + _issues.join("\n") + "\n"
          + "Top-level keys: \"requirements\" (array), \"iface\" (array of {name, dir, width, desc}), \"params\" (array).",
      });
      jr = await callLLMJson(p2);
      specData = jr.data;
      allJrLlms = allJrLlms.concat(jr.llms);
      _malformed = detectMalformedSpec(specData, st._userDesc, _fmOpts);
      if (_malformed && (_malformed.fidelity || []).length > 0) {
        const _rep2 = repairSpecPortNames(specData, st._userDesc);
        if (_rep2.renamed.length > 0) {
          specData = _rep2.spec;
          if (st._onLog) st._onLog("✂ SPEC PORT RENAME REPAIR (post re-ask)\n"
            + _rep2.renamed.map(function(r) { return r.from + " → " + r.to; }).join(", "));
          _malformed = detectMalformedSpec(specData, st._userDesc, _fmOpts);
        }
      }
      if (!_malformed) break;
      _issues = _malformed.schema.map(function(x) { return "- " + x; })
        .concat((_malformed.fidelity || []).map(function(v) { return "- " + v; }))
        .concat(_malformed.missingPorts.map(function(t) {
          return "- the user's description names the signal \"" + t + "\" — it must appear as an iface port";
        }))
        .concat((_malformed.advisories || []).map(function(a) { return "- " + a; }));
      if (_issues.length >= _prevCount) break;   // not converging — stop paying
      _prevCount = _issues.length;
    }
    if (_malformed && _malformed.schema.length > 0) {
      throw new Error("spec produced no usable contract after a corrective re-ask "
        + "— halting honestly instead of building against it: "
        + _malformed.schema.join("; "));
    }
    // Fidelity violations that survive the re-ask HALT the run (runs
    // 37/38/41/42): the description's literal interface facts are not the
    // model's to rewrite, and run 42 proved a dropped port can become a
    // functionally UNDETECTABLE defect — the TB is built from the same wrong
    // contract. config.specFidelity: "warn" downgrades to the warning path
    // for descriptions that intentionally deviate.
    if (_malformed && (_malformed.fidelity || []).length > 0) {
      if (st._config && st._config.specFidelity === "warn") {
        if (st._onLog) st._onLog("⚠ SPEC FIDELITY (downgraded by config)\n"
          + _malformed.fidelity.join("\n"));
      } else {
        throw new Error("spec contradicts the description's literal interface after a "
          + "corrective re-ask — halting before 4 hours are built against the wrong "
          + "contract:\n" + _malformed.fidelity.join("\n"));
      }
    }
    if (_malformed && _malformed.missingPorts.length > 0 && st._onLog) {
      st._onLog("⚠ SPEC PORT FIDELITY\n"
        + "After the re-ask these user-named signals are still absent from iface: "
        + _malformed.missingPorts.join(", ")
        + ". Proceeding (may be a deliberate rename) — review the interface before trusting downstream results.");
    }
    if (_malformed && (_malformed.advisories || []).length > 0 && st._onLog) {
      st._onLog("⚠ SPEC CONTRACT ADVISORY\n"
        + "After the re-ask: " + _malformed.advisories.join("; ")
        + ". Proceeding — the judge's eval gate has final authority over this.");
    }
  }

  // ─── Align requirement cat with id-prefix ─────────────────────────────
  // The LLM sometimes returns mismatched (id, cat) pairs — e.g.
  // id="REQ-FUNC-003" with cat="Interface". The ID prefix is more
  // reliably tied to intent than the free-text cat field, so when there's
  // a mismatch we override the cat to match the prefix. This keeps the
  // eval gate (which uses cat to bucket requirements) accurate.
  //
  // Mapping: REQ-INTF-* → "Interface", REQ-FUNC-* → "Functionality",
  // REQ-TIME-* → "Timing", REQ-ERR-* → "Error", REQ-VERIF-* → "Verification".
  // Unknown prefixes are left alone (no override).
  alignRequirementCats(specData, st._onLog);
  // ──────────────────────────────────────────────────────────────────────

  // In a SYSTEM run the decomposition already named this module, and the top
  // level instantiates the child by that name. A model-chosen name is a
  // different name for the same thing, so the registry wins: run 47 showed
  // the failure would surface at integration as a missing instance rather
  // than as the naming disagreement it is. (Single-module runs never set
  // _modName, so their name still comes from the model.)
  if (st._modName && specData && specData.modName !== st._modName) {
    if (specData.modName && st._onLog) {
      st._onLog("↻ MODULE NAME FROM DECOMPOSITION\n"
        + "spec proposed \"" + specData.modName + "\"; the system instantiates this child as \""
        + st._modName + "\" — using the decomposition's name.");
    }
    specData.modName = st._modName;
  }

  // When generated from description, the result also contains modName and domain
  // — synthesise a minimal elicit object so downstream stages have el.modName
  if (!hasElicit && specData.modName) {
    extraReturn.elicit = {
      modName: specData.modName,
      domain: specData.domain || "",
      questions: [],
      assumptions: [],
      answers: {},
      customAnswers: {},
      _fromDescription: true,
    };
  }

  extraReturn.spec = specData;
  // Every attempt (incl. any failed-parse one that triggered the hinted
  // re-ask, and the spec-schema corrective re-ask) is ledgered; _llm stays
  // the LAST attempt for back-compat.
  const _llms = allJrLlms.map(function(r) { return Object.assign({ stage: "spec" }, r); });
  extraReturn._llm = _llms[_llms.length - 1];
  // _llms mirror for the Duration/Tokens tabs; attached to specData so it lands
  // in stageData[2]._llms.
  specData._llms = _llms;
  extraReturn._llms = _llms;
  return extraReturn;
}
