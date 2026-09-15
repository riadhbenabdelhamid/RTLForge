// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { c } from "./format.js";
import { verificationSummary, UNVERIFIED_EXPLANATION, CRITERIA_SCORE_EXPLANATION } from "../utils/verificationPresentation.js";

export function printVerificationSummary(stageData, stream = process.stdout) {
  const summary = verificationSummary(stageData);
  const colors = { warning: c.yellow, failure: c.red, success: c.green, neutral: c.dim };
  for (const row of summary.rows) stream.write(row.label + ": " + colors[row.tone](row.value) + "\n");
  if (summary.score != null) stream.write("Criteria score: " + summary.score + "/100. " + CRITERIA_SCORE_EXPLANATION + "\n");
  if (summary.unverified) stream.write(c.yellow(UNVERIFIED_EXPLANATION) + "\n");
  if (summary.reason) stream.write("Reason: " + summary.reason + "\n");
}
