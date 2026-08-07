// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/childInterfaces — Collect child module interfaces for a parent
//
// When a parent module's pipeline stage runs (spec, arch, rtl_generate, etc),
// it needs to know the interfaces of its children so the prompts can reference
// the correct ports, parameters, and overrides. This function collects that
// data from the module registry + instance registry.
//
// The result shape is what the prompt layer expects as its `childInterfaces`
// argument — see `promptElicit(desc, childSummary)`, `promptSpec(el, ci)`,
// etc. Each entry describes one instance in the parent. The module and instance
// registries are passed as explicit function arguments.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every module BELOW `modId`, transitively — its children, their children,
 * and so on — with the RTL each has generated.
 *
 * A parent's stages compile against its children (run 47, 1c4b36c). At depth
 * two that is not enough: pkt_merge_top instantiates ingress_channel, which
 * instantiates sync_fifo, so staging only the DIRECT children hands Verilator
 * an ingress_channel whose own child is missing —
 *
 *   %Error-MODMISSING: ingress_channel.sv:73: Cannot find file containing
 *                      module: 'sync_fifo'
 *
 * and the finding is attributed to the TOP's source at a line that belongs to
 * another file, so the lint fix loop is asked to repair a module that has
 * nothing wrong with it (measured, run 48). Hierarchy has no depth limit, so
 * neither can the file set.
 *
 * Only the RTL travels: a parent's PROMPTS must still describe its direct
 * children alone, because that is what it instantiates. A grandchild is a
 * compilation dependency, not an interface the parent wires.
 *
 * @param {string} modId     - The module whose descendants to collect
 * @param {Object} modules   - Module registry (keyed by modId)
 * @param {Object} instances - Instance registry
 * @param {Set} [seen]       - Guards against a cyclic registry
 * @returns {Array<{modName: string, code: string}>} one entry per descendant
 *   that has generated RTL, each module appearing at most once
 */
export function collectDescendantRtl(modId, modules, instances, seen) {
  const visited = seen || new Set([modId]);
  const out = [];
  const kids = Object.values(instances).filter(function(inst) {
    return inst.parentModuleId === modId;
  });
  for (const inst of kids) {
    if (visited.has(inst.moduleId)) continue;
    visited.add(inst.moduleId);
    const mod = modules[inst.moduleId];
    const code = (mod && mod.stageData && mod.stageData[4]
                  && mod.stageData[4].code) || null;
    if (code) out.push({ modName: inst.moduleId, code: code });
    out.push(...collectDescendantRtl(inst.moduleId, modules, instances, visited));
  }
  return out;
}

/**
 * Collect interface descriptors for all child instances of a parent module.
 *
 * Note: the spec lookup is hard-coded to `modules[childId].stageData[2]`
 * because stage 2 is always "spec" in the ALL_STAGES registry.
 *
 * @param {string} parentModId - The parent module's id
 * @param {Object} modules     - Module registry (keyed by modId)
 * @param {Object} instances   - Instance registry — each value has
 *                               { parentModuleId, moduleId, instanceName,
 *                                 paramOverrides, description }
 * @returns {Array} List of child interface descriptors, empty array if none
 */
export function buildChildInterfaces(parentModId, modules, instances) {
  const childInsts = Object.values(instances).filter(function(inst) {
    return inst.parentModuleId === parentModId;
  });
  return childInsts.map(function(inst) {
    const childMod  = modules[inst.moduleId];
    const childSpec = childMod && childMod.stageData && childMod.stageData[2];
    return {
      instanceName: inst.instanceName,
      moduleId: inst.moduleId,
      modName: inst.moduleId,
      iface:   childSpec ? (childSpec.iface  || []) : [],
      params:  childSpec ? (childSpec.params || []) : [],
      // The child's generated RTL, when it exists. A parent necessarily
      // instantiates its children, so linting or simulating it ALONE can only
      // report "Cannot find file containing module" (run 47) — the sources
      // have to travel with the parent, and the interface descriptor is
      // already the thing that travels.
      code: (childMod && childMod.stageData && childMod.stageData[4]
             && childMod.stageData[4].code) || null,
      // Everything BELOW this child, so a parent at any depth compiles. The
      // prompts read iface/params/paramOverrides and never this, so what a
      // parent is told it instantiates is unchanged (run 48).
      descendants: collectDescendantRtl(inst.moduleId, modules, instances),
      paramOverrides: inst.paramOverrides || {},
      description: inst.description || "",
    };
  });
}
