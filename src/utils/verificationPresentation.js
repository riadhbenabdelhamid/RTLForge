// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { provenanceText } from "./provenancePresentation.js";

// Presentation only: never use these labels to accept artifacts or change gates.
export const UNVERIFIED_EXPLANATION = "UNVERIFIED means there is insufficient evidence to claim overall verification; it does not establish that the RTL is incorrect.";
export const CRITERIA_SCORE_EXPLANATION = "The criteria score measures enabled evaluation criteria, not verification confidence.";

export function outcomePresentation(data) {
  const status = String(data?.overall || data?.status || data?.verdict || "").toUpperCase();
  const unresolved = /^(UNVERIFIED|UNRESOLVED|UNSUPPORTED|SKIPPED|UNKNOWN|UNKNOWN_EXIT|INCONCLUSIVE|STALE|TIMEOUT|NEEDS_SPEC_REVIEW)$/.test(status);
  const failed = !unresolved && (/^(FAIL|NEEDS_FIX|ERROR|TOOL_ERROR|COMPILE_FAILURE|RUNTIME_EXIT|RUNTIME_ERROR|INVALID|MISSING_MARKERS)$/.test(status) || data?.fail > 0);
  return { status, unresolved, failed, tone: unresolved ? "warning" : failed ? "failure" : status === "PASS" ? "success" : "neutral" };
}

export function verificationSummary(stageData = {}) {
  const verify = stageData[8], judge = stageData[9], formal = stageData[13];
  const overall = outcomePresentation(verify?._specConflict ? { overall: "UNVERIFIED" } : judge || (verify?.unsupported > 0 && verify.fail === 0
    ? { status: "UNVERIFIED" } : verify?.status === "UNVERIFIED" ? verify : null));
  const rows = [{ label: "Overall", status: overall.status, tone: overall.tone,
    value: overall.status === "UNVERIFIED" ? "Verification incomplete (UNVERIFIED)" : overall.status || "No final verdict recorded" }];

  // Measured checks and the overall evidence gate are separate. A source
  // qualification block can coexist with a complete, passing simulator run.
  let simulation = "NOT RUN", detail = "", simTone = "neutral";
  if (verify) {
    const unsupported = verify.unsupported || 0;
    const counts = [verify.pass, verify.fail, verify.total, unsupported];
    const complete = counts.every(n => Number.isInteger(n) && n >= 0)
      && verify.total > 0 && verify.pass + verify.fail + unsupported === verify.total;
    const pendingStatus = verify.status === "NEEDS_SPEC_REVIEW" && verify._specConflict?.simulationStatus;
    const status = typeof pendingStatus === "string" ? pendingStatus.toUpperCase() : outcomePresentation(verify).status;
    const sourceBlocked = status === "UNVERIFIED" && verify._sourceEvidence?.status === "UNVERIFIED"
      && verify._sourceEvidence.issues?.length > 0;
    // Source qualification sets _checkerEvidenceInvalid even when the
    // simulator completed successfully. Keep that separate from tool errors.
    const invalid = verify._compileFailure || verify._runtimeExit || verify._unknownExit
      || verify._noMarkers || verify._missingMarkers || (verify._checkerEvidenceInvalid && !sourceBlocked);
    if (verify.cli !== true) {
      simulation = "UNVERIFIED"; simTone = "warning";
      detail = "no measured CLI simulation recorded";
    } else if (invalid || !complete || !["PASS", "FAIL", "MEASURED", ""].includes(status) && !sourceBlocked) {
      simulation = "INCONCLUSIVE"; simTone = "warning";
      detail = "incomplete or invalid simulator evidence";
    } else {
      simulation = verify.fail > 0 || status === "FAIL" ? "FAIL" : unsupported ? "UNVERIFIED" : "PASS";
      simTone = simulation === "PASS" ? "success" : simulation === "FAIL" ? "failure" : "warning";
      detail = unsupported ? verify.pass + " PASS, " + verify.fail + " supported FAIL, " + unsupported + " UNSUPPORTED"
        : verify.pass + "/" + verify.total + " measured checks";
      if (verify._specConflict) detail += " (specification under review)";
    }
  }
  rows.push({ label: "Simulation", status: simulation, tone: simTone, value: simulation + (detail ? " — " + detail : "") });

  const formalOutcome = outcomePresentation(formal);
  const sourceBlockedFormal = formalOutcome.status === "SKIPPED"
    && (/source.*(?:unresolved|provenance|qualification)|unresolved.*source/i.test(formal?.reason || "")
      || (formal?.sourceIssues || []).length > 0);
  const formalStatus = formal?.proven ? "PROVEN" : formalOutcome.status || "NOT RUN";
  const formalDetail = sourceBlockedFormal ? "source qualification blocked"
    : formal?.reason || (formalStatus === "PASS" ? "bounded checks" + (formal.depth != null ? " (depth " + formal.depth + ")" : "") : "");
  rows.push({ label: "Formal", status: formalStatus, tone: formal?.proven ? "success" : formalOutcome.tone,
    value: formalStatus + (formalDetail ? " — " + formalDetail : "")
      + (formal?.contractAssumptions?.length ? " — against completed specification with recorded assumptions" : "") });

  const source = verify?._sourceEvidence || judge?.sourceEvidence || stageData[2]?._sourceContract;
  const issues = source?.issues || [];
  const assumptions = issues.filter(i => /assumption|behavioral default/i.test(i.reason || "")).length;
  const other = issues.length - assumptions;
  const selected = source?.assumptions || judge?.contractAssumptions || [];
  const issueText = [assumptions ? assumptions + " unresolved assumption " + (assumptions === 1 ? "entry" : "entries") : "",
    other ? other + " other unresolved source " + (other === 1 ? "issue" : "issues") : ""].filter(Boolean).join("; ");
  rows.push({ label: "Source traceability", status: source?.status || "", tone: issues.length || selected.length ? "warning" : outcomePresentation(source).tone,
    value: [issueText, selected.length ? selected.length + " auto-selected assumption " + (selected.length === 1 ? "entry" : "entries") + " (unconfirmed user intent)" : ""].filter(Boolean).join("; ") || (source?.status === "FAIL" ? "FAIL — source checks failed"
      : source?.status === "UNRESOLVED" || source?.status === "UNVERIFIED" ? "Incomplete source evidence"
      : source ? "No unresolved source entries recorded" : "No source assessment recorded") });
  const policy = stageData[2]?._designContract?.attributionPolicy;
  if (verify?._specConflict) rows.push({ label: "Specification", status: "NEEDS_SPEC_REVIEW", tone: "warning",
    value: "Review required — " + verify._specConflict.reason });
  if (policy) rows.push({ label: "Attribution policy", status: "", tone: "neutral",
    value: policy.requested + " → " + policy.effective + " (" + policy.executionMode + ")" });
  return { rows, assumptions: selected, provenance: stageData[2]?._designContract?.entries || selected,
    score: judge?.score, reason: judge?.unverifiedReason || "",
    unverified: rows.some(r => r.status === "UNVERIFIED") };
}

export function verificationSummaryText(stageData) {
  const summary = verificationSummary(stageData);
  const lines = summary.rows.map(r => r.label + ": " + r.value);
  if (summary.score != null) lines.push("Criteria score: " + summary.score + "/100. " + CRITERIA_SCORE_EXPLANATION);
  if (summary.unverified) lines.push(UNVERIFIED_EXPLANATION);
  const compatibility = stageData?.[8]?._simulationCompatibility;
  if (compatibility) {
    lines.push("Simulator limitation: " + compatibility.reason);
    for (const check of compatibility.checks || []) lines.push("  UNSUPPORTED " + check.label + ": " + check.condition);
  }
  if (summary.assumptions.length) {
    lines.push("Recorded implementation choices (not confirmed user intent):");
    for (const choice of summary.assumptions) lines.push("  " + choice.id + " [" + choice.ref + "]: " + choice.description);
  }
  if (summary.reason) lines.push("Reason: " + summary.reason);
  if (summary.provenance.length) lines.push("Requirement provenance:", provenanceText(summary.provenance));
  return lines.join("\n");
}
