// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

export function provenanceFields(entry) {
  const origins = { source: "Explicit user requirement", derived: "Derivation from user source",
    interpretation: "LLM interpretation", auto_assumption: "Selected assumption",
    user_answer: "User answer", user_revision: "User revision", user_specification: "User specification" };
  const conditional = ["interpretation", "auto_assumption"].includes(entry.kind);
  const passages = (entry.sources || []).map(s => "“" + s.quote + "”"
    + (Number.isInteger(s.start) && Number.isInteger(s.end) ? " (characters " + s.start + "–" + s.end + ")" : ""));
  return [
    ["Requirement", entry.description || ""],
    ["Origin", origins[entry.kind] || entry.origin || "Unclassified"],
    ["Triggering source", passages.join("; ") || entry.quote || (["user_answer", "user_revision", "user_specification"].includes(entry.kind) ? entry.text : "") || "No explicit source passage recorded"],
    ["Reasoning", entry.reasoning || entry.rationale || "No reasoning recorded"],
    ["User confirmation", conditional ? "Unconfirmed" : entry.kind === "derived" ? "Derived from user source" : "User supplied"],
  ];
}

export function provenanceText(entries = []) {
  return entries.flatMap(entry => [entry.id + (entry.ref ? " [" + entry.ref + "]" : ""),
    ...provenanceFields(entry).map(([field, value]) => "  " + field + ": " + value),
    ...(entry.alternatives?.length ? ["  Alternatives: " + entry.alternatives.join("; ")] : [])]).join("\n");
}
