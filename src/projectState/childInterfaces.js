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
      paramOverrides: inst.paramOverrides || {},
      description: inst.description || "",
    };
  });
}
