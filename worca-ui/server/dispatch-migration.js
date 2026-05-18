/**
 * Dispatch governance migration — JS port of Python
 * _migrate_dispatch_governance() in src/worca/cli/init.py (§10.3).
 *
 * Mutates worcaConfig in place following the same pattern as
 * global-keys.js:extractAndStripGlobalKeys().
 */

import { DISPATCH_DEFAULTS } from './dispatch-defaults.js';

/**
 * Migrate legacy governance.subagent_dispatch →
 * governance.dispatch.subagents.per_agent_allow (W-054).
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
  if (!('subagent_dispatch' in gov)) return changes;

  const old = gov.subagent_dispatch;
  delete gov.subagent_dispatch;

  if (!gov.dispatch) gov.dispatch = {};
  const dispatch = gov.dispatch;

  if (!dispatch.subagents) dispatch.subagents = {};
  const subagents = dispatch.subagents;

  if (!subagents.per_agent_allow) subagents.per_agent_allow = {};
  Object.assign(subagents.per_agent_allow, old);

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

  changes.push(
    'governance.subagent_dispatch -> governance.dispatch.subagents (W-054)',
  );
  return changes;
}
