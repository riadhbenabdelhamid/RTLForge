// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { TH } from "../../constants/theme.js";
import { RequirementProvenance } from "./requirementProvenance.jsx";
import { verificationSummary, UNVERIFIED_EXPLANATION, CRITERIA_SCORE_EXPLANATION } from "../../utils/verificationPresentation.js";

export function VerificationSummary({ stageData }) {
  const summary = verificationSummary(stageData);
  const colors = { success: TH.accent, failure: TH.red, warning: TH.yellow, neutral: TH.text2 };
  return <div style={{ fontSize: 12, marginBottom: 16, lineHeight: 1.6 }}>
    <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", margin: 0 }}>
      {summary.rows.map(row => <div key={row.label} style={{ display: "contents" }}>
        <dt style={{ color: TH.text2 }}>{row.label}:</dt>
        <dd style={{ margin: 0, color: colors[row.tone] }}
          title={row.status === "UNVERIFIED" ? UNVERIFIED_EXPLANATION : undefined}
          tabIndex={row.status === "UNVERIFIED" ? 0 : undefined}>{row.value}</dd>
      </div>)}
    </dl>
    <RequirementProvenance entries={summary.provenance} />
    {summary.score != null && <div title={CRITERIA_SCORE_EXPLANATION} style={{ marginTop: 6, color: TH.text2 }}>
      Criteria score: {summary.score}/100. {CRITERIA_SCORE_EXPLANATION}
    </div>}
  </div>;
}
