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
import { promptSpec, promptSpecFromDescription, promptSpecCoverageReview } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { buildSourceContract } from "../sourceContract.js";
import { detectMalformedSpec, repairSpecPortNames } from "../fixLoopHelpers.js";
import { importSpec, formatImportIssues } from "../../utils/specImport.js";
import { extractUserInterfaceContract, interfaceContractViolations, validateRequiredModuleName } from "../../utils/interfaceContract.js";
import { unsupportedParentheticals, describeUnsupported,
         uncitedRequirements, describeUncited,
         unsourcedRequirements, describeUnsourced,
         uncoveredDescription, describeUncovered } from "../specTraceability.js";

/**
 * Report requirement wording the description never supports.
 *
 * REPORTS ONLY — the requirements are passed through untouched. An earlier
 * version of this idea deleted the offending text and, when its heuristic
 * missed, silently removed the encodings a design depended on. Flagging can be
 * wrong and costs a glance; editing can be wrong and costs a design.
 */
function flagUnsupportedWording(specData, sourceText, onLog) {
  if (!specData || !Array.isArray(specData.requirements)) return;
  // Derived fields: recomputed from scratch every time, so a spec object that
  // arrives with stale flags (a resumed checkpoint, a re-asked spec) never
  // keeps a verdict the current requirements no longer earn.
  delete specData.uncited; delete specData.unsourced; delete specData.uncovered; delete specData.unsupportedTerms;
  // Citation check first: it is exact (string containment on a quote the spec
  // stage claims to have copied), so it needs no judgement about meaning.
  const uncited = uncitedRequirements(specData.requirements, sourceText);
  if (uncited.length > 0) {
    specData.uncited = uncited;
    if (onLog) {
      onLog("⚠ spec node: " + uncited.length + " requirement(s) cite text that is not in the description\n"
        + describeUncited(uncited)
        + "\nThe requirements are unchanged. A quote that cannot be found is either a paraphrase — "
        + "harmless but unverifiable — or a reading nobody asked for.");
    }
  }
  // Empty citations: the spec stage saying "nothing supports this". Reported,
  // never blocked — on run 59 this class held every first-shot failure.
  const unsourced = unsourcedRequirements(specData.requirements);
  if (unsourced.length > 0) {
    specData.unsourced = unsourced;
    if (onLog) {
      onLog("⚠ spec node: " + unsourced.length + " requirement(s) carry no citation — behaviour the description "
        + "never stated\n" + describeUnsourced(unsourced)
        + "\nThe requirements are unchanged. Each of these is a rule the spec stage added; a default the "
        + "description leaves open is fine, added behaviour is where first-shot designs go wrong.");
    }
  }
  // Coverage: rows and directive sentences of the description that no
  // requirement cites — omissions, which no provenance check can see.
  const uncovered = uncoveredDescription(specData.requirements, sourceText);
  if (uncovered.length > 0) {
    specData.uncovered = uncovered;
    if (onLog) {
      onLog("⚠ spec node: " + uncovered.length + " part(s) of the description no requirement cites\n"
        + describeUncovered(uncovered)
        + "\nThe requirements are unchanged. A dropped table row or sentence is a behaviour the "
        + "design will not implement and the testbench will not check.");
    }
  }
  const flags = unsupportedParentheticals(specData.requirements, sourceText);
  if (flags.length === 0) return;
  specData.unsupportedTerms = flags;
  if (onLog) {
    onLog("⚠ spec node: " + flags.length + " requirement phrase(s) not traceable to the description\n"
      + describeUnsupported(flags)
      + "\nThe requirements are unchanged. Check whether each is the reading you intended: a wrong one "
      + "here drives the RTL, the testbench and any formal property at once, so no gate downstream can "
      + "see it.");
  }
}

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

function specContractIssues(specData, contract) {
  if (!contract || !specData) return [];
  return interfaceContractViolations({
    moduleName: specData.modName,
    ports: Array.isArray(specData.iface) ? specData.iface : [],
    params: Array.isArray(specData.params) ? specData.params : [],
  }, contract, { exactPorts: contract.explicit.portsExhaustive === true });
}

function addContractIssues(malformed, specData, contract, requiredModuleName) {
  const issues = specContractIssues(specData, contract);
  if (requiredModuleName && (!specData || specData.modName !== requiredModuleName)) {
    issues.push({ kind: "module_name", message: "requiredModuleName must remain "
      + requiredModuleName + " (candidate has " + String((specData && specData.modName) || "") + ")" });
  }
  if (issues.length === 0) return malformed;
  const out = malformed || { schema: [], missingPorts: [], advisories: [], fidelity: [] };
  out.fidelity = (out.fidelity || []).concat(issues.map(function(i) {
    return "explicit user interface contract: " + i.message;
  }));
  return out;
}

/**
 * Read the user's own specification into this stage.
 *
 * Returns the same shape the generated path returns, with an empty LLM ledger
 * — nothing was spent. Throws when the file cannot be read, with every problem
 * listed against its line: the user owns this file, so the run stops and says
 * what to fix rather than proceeding on a half-understood contract.
 */
function specFromImport(st, requiredModuleName) {
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
  if (requiredModuleName && specData.modName !== requiredModuleName) {
    throw new Error("imported specification module name \"" + specData.modName
      + "\" conflicts with requiredModuleName \"" + requiredModuleName + "\"");
  }
  if (st._onLog) {
    st._onLog("✓ SPEC IMPORTED — " + name + " (" + res.format + ")\n"
      + specData.requirements.length + " requirement(s), " + specData.iface.length + " port(s), "
      + specData.params.length + " parameter(s)"
      + (warnings.length > 0 ? "\n" + formatImportIssues(warnings, name) : ""));
  }

  alignRequirementCats(specData, st._onLog);
  flagUnsupportedWording(specData, st._userDesc, st._onLog);
  // A SYSTEM run's decomposition owns the module name (run 47): the top level
  // instantiates this child by that id, so a spec file naming it otherwise
  // would break the instantiation rather than rename anything.
  if (st._modName && !requiredModuleName && specData.modName !== st._modName) {
    if (st._onLog) {
      st._onLog("↻ MODULE NAME FROM DECOMPOSITION\n"
        + "the imported spec names \"" + specData.modName + "\"; the system instantiates this child as \""
        + st._modName + "\" — using the decomposition's name.");
    }
    specData.modName = st._modName;
  }

  specData._llms = [];
  specData._sourceContract = buildSourceContract(st._userDesc, specData, specData.modName);
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


/**
 * Coverage self-review (run 59). When the coverage check finds description
 * rows or directive sentences that no requirement cites, ask the model ONCE to
 * cover them in the description's words or to say why they need no
 * requirement. The re-asked requirements replace the first ones only when they
 * are well formed — every original id kept, ids unique, shapes valid — and
 * coverage did not get worse; otherwise the first spec stands and the attempt
 * is ledgered. iface and params are never taken from the re-ask. Opt-in:
 * config.specReask.
 */
const REQ_ID_RE = /^REQ-(INTF|FUNC|TIME|ERR|VERIF)-\d{3}$/;

function reaskRejection(original, reqs) {
  if (!Array.isArray(reqs) || reqs.length === 0) return "no requirements array";
  const ids = reqs.map(function(r) { return r && r.id; });
  if (ids.some(function(id) { return typeof id !== "string" || !REQ_ID_RE.test(id); })) return "malformed requirement id";
  if (new Set(ids).size !== ids.length) return "duplicate requirement ids";
  if (reqs.some(function(r) { return typeof r.desc !== "string" || r.desc.trim().length < 12; })) return "a requirement without text";
  const missing = (original || []).map(function(r) { return r.id; }).filter(function(id) { return ids.indexOf(id) < 0; });
  if (missing.length > 0) return "dropped requirement(s) " + missing.join(", ");
  if (reqs.length > (original || []).length + 12) return "added " + (reqs.length - original.length) + " requirements — more than the review can justify";
  return null;
}

async function coverageReask(st, specData, stageConfig) {
  const before = specData.uncovered;
  const p = promptSpecCoverageReview(st._userDesc, specData, before);
  p.config = stageConfig;
  p.maxTokens = stageConfig._maxTokens;
  p.onChunk = st._onLog;
  if (st._onLog) {
    st._onLog("↻ SPEC COVERAGE RE-ASK\n" + before.length + " part(s) of the description no requirement cites:\n"
      + describeUncovered(before));
  }
  let jr;
  try {
    jr = await callLLMJson(p);
  } catch (e) {
    if (st._onLog) st._onLog("⚠ SPEC COVERAGE RE-ASK failed (" + String(e && e.message).slice(0, 120) + ") — keeping the first spec");
    return { spec: specData, llms: (e && e.llms) || [] };
  }
  const out = jr.data || {};
  const why = reaskRejection(specData.requirements, out.requirements);
  if (why) {
    if (st._onLog) st._onLog("⚠ SPEC COVERAGE RE-ASK rejected: " + why + " — keeping the first spec");
    return { spec: specData, llms: jr.llms };
  }
  const next = Object.assign({}, specData, { requirements: out.requirements });
  delete next.uncovered; delete next.unsourced; delete next.unsupportedTerms; delete next.uncited;
  alignRequirementCats(next, null);
  flagUnsupportedWording(next, st._userDesc, null);
  const after = next.uncovered || [];
  if (after.length > before.length) {
    if (st._onLog) st._onLog("⚠ SPEC COVERAGE RE-ASK rejected: coverage got worse (" + before.length + " → " + after.length + ") — keeping the first spec");
    return { spec: specData, llms: jr.llms };
  }
  const table = Array.isArray(out.coverage) ? out.coverage.slice(0, 40) : [];
  next._coverageReask = { before: before.length, after: after.length, coverage: table };
  if (st._onLog) {
    st._onLog("✓ SPEC COVERAGE RE-ASK — uncovered " + before.length + " → " + after.length
      + ", requirements " + specData.requirements.length + " → " + next.requirements.length + "\n"
      + table.map(function(c) {
        return "  " + (c.action === "covered" ? "covered  " : "not needed") + (c.by ? " by " + c.by : "")
          + ': "' + String(c.item || "").slice(0, 60) + '"' + (c.why ? " — " + String(c.why).slice(0, 80) : "");
      }).join("\n")
      + (after.length > 0 ? "\nStill uncited:\n" + describeUncovered(after) : ""));
  }
  return { spec: next, llms: jr.llms };
}

export async function specNode(st) {
  const interfaceContract = extractUserInterfaceContract(st._userDesc);
  const requiredModuleName = validateRequiredModuleName(
    st._config && st._config.requiredModuleName, interfaceContract);
  // An imported specification replaces the generation entirely — no prompt is
  // built and no model is called.
  if (st._specImport && String(st._specImport.text || "").trim()) {
    return specFromImport(st, requiredModuleName);
  }
  const ci = st._childInterfaces || [];
  const hasElicit = st.elicit && st.elicit.modName && st.elicit.questions && st.elicit.questions.length > 0;

  let p;
  const extraReturn = {};

  if (hasElicit) {
    p = promptSpec(st.elicit, ci, st._userDesc, interfaceContract, requiredModuleName);
  } else {
    // Full-auto mode: generate spec directly from the user description
    p = promptSpecFromDescription(st._userDesc, ci, interfaceContract, requiredModuleName);
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
  let _malformed = addContractIssues(
    detectMalformedSpec(specData, st._userDesc, _fmOpts), specData, interfaceContract, requiredModuleName);
  // Deterministic rename repair BEFORE spending an LLM re-ask (run 43): a
  // decorated port name (wdata_i for a described wdata) is mechanical.
  if (_malformed && (_malformed.fidelity || []).length > 0 && !interfaceContract.explicit.ports) {
    const _rep = repairSpecPortNames(specData, st._userDesc);
    if (_rep.renamed.length > 0) {
      specData = _rep.spec;
      if (st._onLog) st._onLog("✂ SPEC PORT RENAME REPAIR\n"
        + _rep.renamed.map(function(r) { return r.from + " → " + r.to; }).join(", "));
      _malformed = addContractIssues(
        detectMalformedSpec(specData, st._userDesc, _fmOpts), specData, interfaceContract, requiredModuleName);
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
          + "Top-level keys: \"modName\" (the configured/source module name copied exactly), "
          + "\"requirements\" (array), \"iface\" (array of {name, dir, width, desc}), \"params\" (array).",
      });
      jr = await callLLMJson(p2);
      specData = jr.data;
      allJrLlms = allJrLlms.concat(jr.llms);
      _malformed = addContractIssues(
        detectMalformedSpec(specData, st._userDesc, _fmOpts), specData, interfaceContract, requiredModuleName);
      if (_malformed && (_malformed.fidelity || []).length > 0 && !interfaceContract.explicit.ports) {
        const _rep2 = repairSpecPortNames(specData, st._userDesc);
        if (_rep2.renamed.length > 0) {
          specData = _rep2.spec;
          if (st._onLog) st._onLog("✂ SPEC PORT RENAME REPAIR (post re-ask)\n"
            + _rep2.renamed.map(function(r) { return r.from + " → " + r.to; }).join(", "));
          _malformed = addContractIssues(
            detectMalformedSpec(specData, st._userDesc, _fmOpts), specData, interfaceContract, requiredModuleName);
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
    if (_malformed && requiredModuleName && (!specData || specData.modName !== requiredModuleName)) {
      throw new Error("spec conflicts with requiredModuleName \"" + requiredModuleName
        + "\" after corrective re-asks; refusing to substitute an exported RTL name");
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
  flagUnsupportedWording(specData, st._userDesc, st._onLog);
  // Coverage self-review: one re-ask when the description has rows or
  // sentences no requirement cites (run 59). Opt-in via config.specReask.
  if (st._config && st._config.specReask && specData
      && Array.isArray(specData.uncovered) && specData.uncovered.length > 0) {
    const rr = await coverageReask(st, specData, _sc);
    specData = rr.spec;
    allJrLlms = allJrLlms.concat(rr.llms || []);
  }
  // ──────────────────────────────────────────────────────────────────────

  // In a SYSTEM run the decomposition already named this module, and the top
  // level instantiates the child by that name. A model-chosen name is a
  // different name for the same thing, so the registry wins: run 47 showed
  // the failure would surface at integration as a missing instance rather
  // than as the naming disagreement it is. (Single-module runs never set
  // _modName, so their name still comes from the model.)
  if (st._modName && !requiredModuleName && specData && specData.modName !== st._modName) {
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

  specData._sourceContract = buildSourceContract(st._userDesc, specData, specData.modName);
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
