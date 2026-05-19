/**
 * Dispatch governance migration — JS port of Python
 * _migrate_dispatch_governance() in src/worca/cli/init.py (§10.3).
 *
 * Mutates worcaConfig in place following the same pattern as
 * global-keys.js:extractAndStripGlobalKeys().
 */

import { DISPATCH_DEFAULTS } from './dispatch-defaults.js';

const _DISPATCH_SECTION_KEYS = new Set(['tools', 'skills', 'subagents']);

/**
 * Returns true if `dispatch` has at least one agent-name key directly at the
 * top level (the pre-W-038 legacy flat shape, e.g. `{planner: [...]}`),
 * rather than the W-054 nested shape `{tools, skills, subagents}`.
 */
function _isLegacyFlatDispatch(dispatch) {
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    return false;
  }
  for (const key of Object.keys(dispatch)) {
    if (!_DISPATCH_SECTION_KEYS.has(key) && Array.isArray(dispatch[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Strip agent-name keys from `dispatch`, moving their values into
 * `dispatch.subagents.per_agent_allow` so the legacy flat shape is normalized.
 */
function _absorbFlatDispatchKeys(dispatch) {
  const flatKeys = [];
  for (const key of Object.keys(dispatch)) {
    if (!_DISPATCH_SECTION_KEYS.has(key) && Array.isArray(dispatch[key])) {
      flatKeys.push(key);
    }
  }
  if (flatKeys.length === 0) return false;

  if (!dispatch.subagents) dispatch.subagents = {};
  if (!dispatch.subagents.per_agent_allow) {
    dispatch.subagents.per_agent_allow = {};
  }
  for (const key of flatKeys) {
    const incoming = dispatch[key];
    const existing = dispatch.subagents.per_agent_allow[key];
    if (!existing || existing.length === 0) {
      dispatch.subagents.per_agent_allow[key] = incoming;
    }
    delete dispatch[key];
  }
  return true;
}

/**
 * Migrate legacy governance.subagent_dispatch and/or legacy flat
 * governance.dispatch (agent-keyed) → governance.dispatch.subagents.per_agent_allow.
 *
 * Seeds _defaults, adds tools/skills defaults, drops _dispatch_legacy.
 * Idempotent — returns [] on already-migrated configs.
 *
 * @param {object} worcaConfig — the `worca` object from settings (mutated)
 * @returns {string[]} list of change descriptions (empty = no-op)
 */
export function migrateDispatchGovernance(worcaConfig) {
  const changes = [];
  const gov = worcaConfig.governance;
  if (!gov || typeof gov !== 'object') return changes;

  const hasSubagentDispatch = 'subagent_dispatch' in gov;
  const hasLegacyFlatDispatch = _isLegacyFlatDispatch(gov.dispatch);

  if (!hasSubagentDispatch && !hasLegacyFlatDispatch) return changes;

  if (!gov.dispatch || Array.isArray(gov.dispatch)) gov.dispatch = {};
  const dispatch = gov.dispatch;

  // Absorb legacy flat shape (pre-W-038) first so subagent_dispatch values
  // take precedence below.
  if (hasLegacyFlatDispatch) {
    _absorbFlatDispatchKeys(dispatch);
    changes.push(
      'governance.dispatch (flat agent-keyed) -> governance.dispatch.subagents (W-054)',
    );
  }

  if (hasSubagentDispatch) {
    const old = gov.subagent_dispatch;
    delete gov.subagent_dispatch;
    if (!dispatch.subagents) dispatch.subagents = {};
    if (!dispatch.subagents.per_agent_allow) {
      dispatch.subagents.per_agent_allow = {};
    }
    Object.assign(dispatch.subagents.per_agent_allow, old);
    changes.push(
      'governance.subagent_dispatch -> governance.dispatch.subagents (W-054)',
    );
  }

  if (!dispatch.subagents) dispatch.subagents = {};
  const subagents = dispatch.subagents;

  if (!subagents.per_agent_allow) subagents.per_agent_allow = {};
  if (!('_defaults' in subagents.per_agent_allow)) {
    subagents.per_agent_allow._defaults = [
      ...DISPATCH_DEFAULTS.subagents.per_agent_allow._defaults,
    ];
  }

  if (!subagents.always_disallowed) {
    subagents.always_disallowed = [
      ...DISPATCH_DEFAULTS.subagents.always_disallowed,
    ];
  }
  if (!subagents.default_denied) {
    subagents.default_denied = [...DISPATCH_DEFAULTS.subagents.default_denied];
  }

  if (!dispatch.tools) {
    dispatch.tools = structuredClone(DISPATCH_DEFAULTS.tools);
  }
  if (!dispatch.skills) {
    dispatch.skills = structuredClone(DISPATCH_DEFAULTS.skills);
  }

  delete gov._dispatch_legacy;

  return changes;
}
