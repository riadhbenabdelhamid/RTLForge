// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/datasetWriter — append run artifacts to a JSONL dataset
//
// One file per model, so a dataset assembled across models never mixes rows
// that would train differently. The model name is also inside every record;
// the split is for convenience, the field is the source of truth.
//
// Appends only, and never throws into the run: a dataset is a by-product, and
// losing a row must never cost a pipeline stage that took an hour to reach.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

function slug(s) {
  return String(s || "unknown").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

/**
 * @param {string} dir  destination directory (created if absent)
 * @param {object} [opts] { onLog }
 * @returns {function(Array<object>): void} the tap to place on config._datasetTap
 */
export function createDatasetWriter(dir, opts) {
  const outDir = path.resolve(dir);
  const onLog = (opts && opts.onLog) || null;
  let made = false;
  let written = 0;

  return function datasetTap(records) {
    if (!Array.isArray(records) || records.length === 0) return;
    try {
      if (!made) {
        fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
        made = true;
      }
      const byModel = new Map();
      for (const rec of records) {
        const key = slug(rec && rec.model);
        if (!byModel.has(key)) byModel.set(key, []);
        byModel.get(key).push(rec);
      }
      for (const [key, rows] of byModel) {
        const file = path.join(outDir, "artifacts-" + key + ".jsonl");
        fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        written += rows.length;
      }
      if (onLog) onLog("[dataset] +" + records.length + " record(s) → " + outDir + " (" + written + " total)");
    } catch (e) {
      // A dataset is a by-product. Never let it fail a stage.
      if (onLog) onLog("[dataset] write failed (ignored): " + ((e && e.message) || e));
    }
  };
}
