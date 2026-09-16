// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { TH } from "../../constants/theme.js";
import { provenanceFields } from "../../utils/provenancePresentation.js";

export function RequirementProvenance({ entries = [] }) {
  if (!entries.length) return null;
  return <details style={{ marginTop: 8, fontSize: 12 }}>
    <summary>Requirement provenance — user statements and RTLForge interpretations</summary>
    {entries.map(entry => <div key={entry.id} style={{ margin: "12px 0" }}>
      <strong>{entry.id}{entry.ref ? " [" + entry.ref + "]" : ""}</strong>
      <table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}><tbody>
        {provenanceFields(entry).map(([field, value]) => <tr key={field}>
          <th scope="row" style={{ verticalAlign: "top", padding: 4, width: 145 }}>{field}</th>
          <td style={{ padding: 4, whiteSpace: "pre-wrap", color: field === "User confirmation" && value === "Unconfirmed" ? TH.yellow : TH.text1 }}>{value}</td>
        </tr>)}
      </tbody></table>
      {!!entry.alternatives?.length && <div>Alternatives: {entry.alternatives.join("; ")}</div>}
    </div>)}
  </details>;
}
