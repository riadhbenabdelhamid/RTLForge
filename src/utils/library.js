// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// library — Module library compatibility checking and matching
// ═══════════════════════════════════════════════════════════════════════════

import { computeInterfaceSignature } from "./hash.js";
import { levenshtein } from "./levenshtein.js";

/**
 * Check whether an imported interface is compatible with a required interface.
 * Returns { compatible: boolean, reason: string }.
 */
export function isInterfaceCompatible(importedIface, requiredIface) {
  if (!importedIface || !requiredIface) {
    return { compatible: false, reason: "Missing interface data" };
  }

  const importedPorts = {};
  (importedIface.iface || []).forEach((p) => { importedPorts[p.name] = p; });

  const reqPorts = requiredIface.iface || [];
  for (let i = 0; i < reqPorts.length; i++) {
    const req = reqPorts[i];
    const imp = importedPorts[req.name];
    if (!imp) return { compatible: false, reason: "Missing port: " + req.name };
    if (imp.dir !== req.dir) return { compatible: false, reason: "Dir mismatch: " + req.name };
    if (imp.width !== req.width && !Number.isNaN(Number(imp.width)) && !Number.isNaN(Number(req.width))) {
      return { compatible: false, reason: "Width mismatch: " + req.name };
    }
  }

  const importedParams = {};
  (importedIface.params || []).forEach((p) => { importedParams[p.name] = p; });

  const reqParams = requiredIface.params || [];
  for (let j = 0; j < reqParams.length; j++) {
    if (!importedParams[reqParams[j].name]) {
      return { compatible: false, reason: "Missing param: " + reqParams[j].name };
    }
  }

  return { compatible: true, reason: "All ports and params present" };
}

/**
 * Match decomposition modules against an imported package library.
 * Returns ordered match list with confidence scores.
 *
 * Match strategies (in priority order):
 *   a) Exact modId match           — confidence 1.0
 *   b) Interface signature match    — confidence 0.95
 *   c) Name similarity (Lev ≤ 2)    — confidence 0.7
 */
export function matchLibrary(decomposition, importedPackages) {
  if (!decomposition || !importedPackages) return [];
  const decompMods = decomposition.modules || [];
  const libKeys = Object.keys(importedPackages);
  if (libKeys.length === 0 || decompMods.length === 0) return [];

  const matches = [];

  decompMods.forEach((dm) => {
    let bestMatch = null;

    libKeys.forEach((libKey) => {
      const entry = importedPackages[libKey];
      const pkg = entry.pkg;
      const libType = entry.type; // "module" or "system"

      if (libType === "module") {
        const modId = pkg.module ? pkg.module.modId : libKey;
        const libIface = pkg.interface || {};
        const libSig = pkg.signature || {};
        const judgeData = pkg.artifacts ? pkg.artifacts.judge : {};

        // a) Exact modId match
        if (dm.modId === modId) {
          const compat = isInterfaceCompatible(libIface, { iface: dm.iface || [], params: dm.params || [] });
          const m = {
            decompModId: dm.modId, libraryKey: libKey, libraryType: "module",
            matchType: "exact_id", confidence: 1.0,
            interfaceCompatible: compat.compatible,
            reason: "Exact modId match" + (compat.compatible ? "" : " (⚠ " + compat.reason + ")"),
            suggestedMode: "leaf",
            score: judgeData ? judgeData.score : null,
            overall: judgeData ? judgeData.overall : null,
          };
          if (!bestMatch || m.confidence > bestMatch.confidence) bestMatch = m;
          return;
        }

        // b) Signature match
        if (libSig.portHash && dm.iface && dm.iface.length > 0) {
          const decompSig = computeInterfaceSignature(dm.iface || [], dm.params || []);
          if (decompSig.portHash === libSig.portHash && decompSig.paramHash === libSig.paramHash) {
            const compat2 = isInterfaceCompatible(libIface, { iface: dm.iface || [], params: dm.params || [] });
            const m2 = {
              decompModId: dm.modId, libraryKey: libKey, libraryType: "module",
              matchType: "signature_match", confidence: 0.95,
              interfaceCompatible: compat2.compatible,
              reason: "Interface signature match" + (compat2.compatible ? "" : " (⚠ " + compat2.reason + ")"),
              suggestedMode: "leaf",
              score: judgeData ? judgeData.score : null,
              overall: judgeData ? judgeData.overall : null,
            };
            if (!bestMatch || m2.confidence > bestMatch.confidence) bestMatch = m2;
            return;
          }
        }

        // c) Name similarity
        if (levenshtein(dm.modId, modId) <= 2) {
          const compat3 = isInterfaceCompatible(libIface, { iface: dm.iface || [], params: dm.params || [] });
          const m3 = {
            decompModId: dm.modId, libraryKey: libKey, libraryType: "module",
            matchType: "name_similar", confidence: 0.7,
            interfaceCompatible: compat3.compatible,
            reason: "Name similar (Levenshtein ≤ 2)" + (compat3.compatible ? "" : " (⚠ " + compat3.reason + ")"),
            suggestedMode: "leaf",
            score: judgeData ? judgeData.score : null,
            overall: judgeData ? judgeData.overall : null,
          };
          if (!bestMatch || m3.confidence > bestMatch.confidence) bestMatch = m3;
        }
      } else if (libType === "system") {
        const sys = pkg.system || {};
        const topModId = sys.topModule;
        const pkgModules = pkg.modules || {};
        const intJudge = pkg.integration ? pkg.integration.judge : {};

        // System top module match → blackbox
        if (dm.modId === topModId && pkgModules[topModId]) {
          const topIface = pkgModules[topModId].interface || {};
          const compat4 = isInterfaceCompatible(topIface, { iface: dm.iface || [], params: dm.params || [] });
          const m4 = {
            decompModId: dm.modId, libraryKey: libKey, libraryType: "system",
            matchType: "exact_id", confidence: 1.0,
            interfaceCompatible: compat4.compatible,
            reason: "System top module match" + (compat4.compatible ? "" : " (⚠ " + compat4.reason + ")"),
            suggestedMode: "blackbox",
            score: intJudge ? intJudge.score : null,
            overall: intJudge ? intJudge.overall : null,
          };
          if (!bestMatch || m4.confidence > bestMatch.confidence) bestMatch = m4;
          return;
        }

        // Internal module match
        let internalMatchCount = 0;
        Object.keys(pkgModules).forEach((intModId) => {
          if (dm.modId === intModId) internalMatchCount++;
        });
        if (internalMatchCount > 0) {
          const intMod = pkgModules[dm.modId];
          const intIface = intMod ? intMod.interface || {} : {};
          const compat5 = isInterfaceCompatible(intIface, { iface: dm.iface || [], params: dm.params || [] });

          let totalInternalMatches = 0;
          decompMods.forEach((otherDm) => {
            if (pkgModules[otherDm.modId]) totalInternalMatches++;
          });
          const sugMode = totalInternalMatches > 1 ? "exploded" : "leaf";

          const m5 = {
            decompModId: dm.modId, libraryKey: libKey, libraryType: "system",
            matchType: "exact_id", confidence: 0.9,
            interfaceCompatible: compat5.compatible,
            reason: "Internal module of system " + (sys.systemName || libKey) + (compat5.compatible ? "" : " (⚠ " + compat5.reason + ")"),
            suggestedMode: sugMode,
            score: intJudge ? intJudge.score : null,
            overall: intJudge ? intJudge.overall : null,
          };
          if (!bestMatch || m5.confidence > bestMatch.confidence) bestMatch = m5;
        }
      }
    });

    if (bestMatch) matches.push(bestMatch);
  });

  return matches;
}
