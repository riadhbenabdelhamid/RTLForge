// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// ═══════════════════════════════════════════════════════════════════════════
// measurement — provenance for measured stage results (lint / lint_test / verify)
//
// A measured result is only meaningful for the artifact it measured. The
// pipeline stores results per stage slot, so nothing tied a lint result to
// the RTL it linted: a fix loop that changes the RTL leaves the old verdict
// in the slot, and a later judge gate reads it as a live FAIL (measured on
// run 55: judge spent 2 h 22 min regenerating RTL
// to clear a lint error that verify's fix loop had already removed).
//
// Every measured result now carries `_forHash`, the hashes of the artifacts
// it was measured against. Producers stamp at measurement time (the reflow
// chain runner for nested runs, runStage for top-level runs); consumers ask
// `isFreshFor(stageKey, result, codes)` before treating the result as a
// statement about the current code.
//
// Freshness is per-stage: lint depends on the RTL only; lint_test and verify
// depend on the RTL and the testbench. A result without a stamp (written
// before this change) is "unstamped" — callers decide how to treat legacy
// data; nothing here fails a result merely for being unstamped.
// ═══════════════════════════════════════════════════════════════════════════
import { djb2 } from "./hash.js";

/** Stage key → artifact keys its measurement depends on. */
export const MEASURE_DEPS = Object.freeze({
  lint:      ["rtl"],
  lint_test: ["rtl", "tb"],
  verify:    ["rtl", "tb"],
});

/** Keys of MEASURE_DEPS — the measured stages. */
export const MEASURED_STAGES = Object.freeze(Object.keys(MEASURE_DEPS));

/**
 * Hash of one artifact's source text. djb2 is 32-bit, so the length is
 * appended to make accidental collisions between different-sized sources
 * impossible. Empty / non-string → "" (no artifact).
 */
export function artifactHash(code) {
  const s = typeof code === "string" ? code : "";
  return s.length === 0 ? "" : djb2(s) + ":" + s.length;
}

/**
 * Return a copy of `result` stamped with the hashes of the artifacts it was
 * measured against. `codes` is `{ rtl, tb }` (source text, either may be
 * omitted). Only the artifacts the stage depends on are recorded. A non-object
 * result is returned unchanged.
 */
export function stampMeasurement(stageKey, result, codes) {
  if (!result || typeof result !== "object") return result;
  const deps = MEASURE_DEPS[stageKey];
  if (!deps) return result;
  const c = codes || {};
  const forHash = {};
  for (const dep of deps) forHash[dep] = artifactHash(c[dep]);
  return Object.assign({}, result, { _forHash: forHash });
}

/**
 * Freshness of a measured result against the current artifacts.
 * @returns {"fresh"|"stale"|"unstamped"}
 */
export function measurementFreshness(stageKey, result, codes) {
  if (!result || typeof result !== "object") return "unstamped";
  const stamp = result._forHash;
  const deps = MEASURE_DEPS[stageKey];
  if (!stamp || typeof stamp !== "object" || !deps) return "unstamped";
  const c = codes || {};
  for (const dep of deps) {
    if (!(dep in stamp)) return "unstamped";
    if (stamp[dep] !== artifactHash(c[dep])) return "stale";
  }
  return "fresh";
}

/** True only when the result is stamped AND matches the current artifacts. */
export function isFreshFor(stageKey, result, codes) {
  return measurementFreshness(stageKey, result, codes) === "fresh";
}

/**
 * Measured results a fix chain produced that are valid for the artifacts a
 * node is about to ship: entries of `chainState` (lint / lint_test by
 * default) that differ from `baseState`'s and are stamped fresh for `codes`.
 * Nodes spread the result into their return delta so runStage can mirror it.
 */
export function carriedMeasurements(chainState, baseState, codes, keys) {
  const out = {};
  if (!chainState || typeof chainState !== "object") return out;
  const ks = keys || ["lint", "lint_test"];
  for (const k of ks) {
    const r = chainState[k];
    if (!r || typeof r !== "object") continue;
    if (baseState && baseState[k] === r) continue;
    if (isFreshFor(k, r, codes)) out[k] = r;
  }
  return out;
}

/** `{ rtl, tb }` source text pulled from a pipeline state. */
export function codesOf(state) {
  const s = state || {};
  return {
    rtl: (s.rtl_generate && s.rtl_generate.code) || "",
    tb:  (s.test_generate && s.test_generate.code) || "",
  };
}
