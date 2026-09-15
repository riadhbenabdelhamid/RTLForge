// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { runCli, parseTestLine, parseCLIOutput } from "../cli/index.js";
import { classifySimulationOutcome } from "./classifiers.js";
import { withSharedPackage, cmdWithFiles, childRtlFiles } from "./cliFiles.js";
import { buildSourceContract, mergeSourceEvidence } from "./sourceContract.js";
import { checkerQualification, selectCommonCheckerCandidate } from "./candidateGuard.js";
import { extractModuleInterface } from "../utils/svInterface.js";
import { djb2 } from "../utils/hash.js";

// Real simulation only. This runner never generates/repairs a checker and
// never falls back to an LLM estimate when the execution is incomplete.
export async function runAcceptanceSuite(st, rtl, tb) {
  const name = st.elicit?.modName || st._modName || "module";
  const rtlFile = name + ".sv", tbFile = name + "_tb.sv";
  const cfg = st._config || {};
  if (!cfg.backendUrl || !String(cfg.simCmds || "").trim()) return { status: "UNVERIFIED", tests: [] };
  const files = withSharedPackage({ ...childRtlFiles(st._childInterfaces), [rtlFile]: rtl, [tbFile]: tb }, st._sharedPackageCode);
  const command = cfg.simCmds.split("\n").filter(c => c.trim()).map(c =>
    cmdWithFiles(c, files.order.filter(f => f !== tbFile), rtlFile).replace(/\{TB\}/g, tbFile)).join(" && ");
  try {
    const r = await runCli(cfg.backendUrl, { command, files: files.files }, st._signal, {
      retries: cfg.cliRetryCount ?? 1, timeoutMs: (cfg.backendTimeoutSec || 600) * 1000, logger: st._logger || null,
    });
    if (!r || r._error) return { status: "UNVERIFIED", tests: [], log: r?._msg || "CLI unavailable" };
    const tests = String(r.stdout || "").split("\n").map(parseTestLine).filter(Boolean)
      .map(t => ({ name: t.name, st: t.status }));
    const status = classifySimulationOutcome({ ...r, tests, diagnostics: parseCLIOutput(r.stderr || "") });
    return { status, tests, total: tests.length, pass: tests.filter(t => t.st === "PASS").length,
      cli: true, log: (r.stdout || "") + "\n" + (r.stderr || "") };
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return { status: "UNVERIFIED", tests: [], log: String(e.message || e) };
  }
}

export function createReviewAcceptance(st, incumbent) {
  // Snapshot before a reflow can rewrite stage slots or checker metadata.
  const frozen = { ...st, _config: { ...st._config }, elicit: { ...st.elicit },
    _childInterfaces: JSON.parse(JSON.stringify(st._childInterfaces || [])) };
  const name = st.elicit?.modName || st._modName || "module";
  const contract = buildSourceContract(st._userDesc, st.spec, name);
  const candidate = st.rtl_generate?._standaloneCheckerCandidate;
  const header = extractModuleInterface(st.rtl_generate?._standaloneCandidate?.code || incumbent, name);
  const inputHash = djb2(String(st._userDesc || "") + "\n" + String(header || ""));
  const qualified = candidate && checkerQualification({ checkerCandidate: candidate }, { inputHash }).trustworthy;
  const tb = qualified ? String(candidate.code) : null;
  const reason = contract.status === "UNRESOLVED" ? "SOURCE_UNRESOLVED"
    : !tb && contract.status !== "READY" ? "CHECKER_UNQUALIFIED" : null;
  const checker = { version: "pre-review-v1", seed: "fixed", hash: djb2(contract.hash + "\n" + (tb || "") + "\n" + String(frozen._config.simCmds || "") + JSON.stringify(frozen._childInterfaces) + (frozen._sharedPackageCode || "")) };
  const cache = new Map();
  async function measure(rtl) {
    if (!cache.has(rtl)) cache.set(rtl, (async () => {
      const base = tb ? await runAcceptanceSuite(frozen, rtl, tb) : { status: "MEASURED", tests: [], cli: true };
      const runs = [];
      for (const suite of contract.suites) runs.push(await runAcceptanceSuite(frozen, rtl, suite.code));
      return { ...mergeSourceEvidence(base, contract, runs, rtl), checker };
    })());
    return cache.get(rtl);
  }
  const record = { incumbentHash: djb2(incumbent), checker, sourceStatus: contract.status, decisions: [] };
  return { record, async compare(proposal, current) {
    let decision = { adopted: false, reason };
    if (!reason) {
      const baseline = await measure(current), proposed = await measure(proposal);
      // Unknown/incomplete baseline evidence cannot authorize a behavioral edit.
      const comparable = /^(MEASURED|PASS|FAIL)$/.test(baseline.status) && !baseline._checkerEvidenceInvalid;
      const result = comparable ? selectCommonCheckerCandidate({ code: proposal, verify: proposed }, { code: current, verify: baseline }) : null;
      decision = { adopted: result?.decision === "ACCEPT_IMPROVEMENT", reason: result?.reason || (result ? result.decision : "INCUMBENT_UNVERIFIED"),
        baseline, proposed };
    }
    record.decisions.push({ ...decision, incumbentHash: djb2(current), proposalHash: djb2(proposal) });
    return decision;
  } };
}
