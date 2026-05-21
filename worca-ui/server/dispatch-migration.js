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

// --- One-time dispatch-default normalization (W-054 follow-up) -------------
//
// Mirror of normalize_dispatch_defaults() in src/worca/hooks/tracking.py.
// Bumped when a new one-time normalization is added; stamped onto
// governance.dispatch_migration_version so it runs exactly once per config.
export const DISPATCH_MIGRATION_VERSION = 1;

// Pre-W-054 (W-038-era) shipped subagent default: every pipeline agent capped
// to Explore-only. coordinator:[] / empty lists fall through to _defaults and
// are ignored in the comparison.
const _LEGACY_EXPLORE_SUBAGENT_DEFAULT = {
  planner: ['Explore'],
  implementer: ['Explore'],
  tester: ['Explore'],
  guardian: ['Explore'],
  reviewer: ['Explore'],
  plan_reviewer: ['Explore'],
  learner: ['Explore'],
};

// Pre-narrowing skills denylist (carried the broad `worca-*` glob).
const _LEGACY_SKILLS_ALWAYS_DISALLOWED = new Set([
  'batch',
  'fewer-permission-prompts',
  'loop',
  'schedule',
  'worca-*',
  'update-config',
  'hookify:hookify',
  'hookify:configure',
  'hookify:list',
  'hookify:writing-rules',
  'init',
]);

function _canonicalPerAgent(perAgent) {
  const out = {};
  for (const [agent, allow] of Object.entries(perAgent)) {
    if (agent === '_defaults') continue;
    if (!Array.isArray(allow) || allow.length === 0) continue;
    out[agent] = [...allow].sort();
  }
  return out;
}

function _sameStringMap(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (!Array.isArray(bv) || av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
  }
  return true;
}

/**
 * Collapse a stale Explore-only per_agent_allow to the new `_defaults: ["*"]`
 * default. Only fires on the untouched W-038 shape with an unset/wildcard
 * _defaults. Returns true if changed.
 */
export function adoptStaleSubagentDefault(subagentsCfg) {
  if (!subagentsCfg || typeof subagentsCfg !== 'object') return false;
  const pa = subagentsCfg.per_agent_allow;
  if (!pa || typeof pa !== 'object' || Array.isArray(pa)) return false;
  const def = pa._defaults;
  const defOk =
    def === undefined ||
    (Array.isArray(def) && def.length === 1 && def[0] === '*');
  if (!defOk) return false;
  const expected = _canonicalPerAgent(_LEGACY_EXPLORE_SUBAGENT_DEFAULT);
  if (!_sameStringMap(_canonicalPerAgent(pa), expected)) return false;
  subagentsCfg.per_agent_allow = { _defaults: ['*'] };
  return true;
}

/**
 * Widen an untouched skills denylist (broad `worca-*`) to the current set.
 * Exact-match (set) guarded. Returns true if changed.
 */
export function adoptNarrowedSkillsDenylist(skillsCfg) {
  if (!skillsCfg || typeof skillsCfg !== 'object') return false;
  const current = skillsCfg.always_disallowed;
  if (!Array.isArray(current)) return false;
  if (current.length !== _LEGACY_SKILLS_ALWAYS_DISALLOWED.size) return false;
  for (const item of current) {
    if (!_LEGACY_SKILLS_ALWAYS_DISALLOWED.has(item)) return false;
  }
  skillsCfg.always_disallowed = [...DISPATCH_DEFAULTS.skills.always_disallowed];
  return true;
}

/**
 * Apply one-time dispatch-default normalizations, gated by a version stamp.
 * Brings an *untouched* config up to current shipped defaults for the two
 * things that changed after W-054 (subagent per_agent_allow, skills denylist).
 * Mutates governanceCfg; returns change descriptions.
 */
export function normalizeDispatchDefaults(governanceCfg) {
  const changes = [];
  if (!governanceCfg || typeof governanceCfg !== 'object') return changes;
  let stamp = governanceCfg.dispatch_migration_version;
  if (!Number.isInteger(stamp)) stamp = 0;
  if (stamp >= DISPATCH_MIGRATION_VERSION) return changes;
  const dispatch = governanceCfg.dispatch;
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    return changes;
  }
  if (adoptStaleSubagentDefault(dispatch.subagents)) {
    changes.push(
      'governance.dispatch.subagents: adopted new default (_defaults:["*"]) for config pinned to legacy Explore-only set',
    );
  }
  if (adoptNarrowedSkillsDenylist(dispatch.skills)) {
    changes.push(
      'governance.dispatch.skills.always_disallowed: narrowed legacy "worca-*" glob to the current must-disallow set',
    );
  }
  governanceCfg.dispatch_migration_version = DISPATCH_MIGRATION_VERSION;
  return changes;
}

/**
 * Migrate legacy governance.subagent_dispatch and/or legacy flat
 * governance.dispatch (agent-keyed) → governance.dispatch.subagents.per_agent_allow,
 * then apply the one-time dispatch-default normalization.
 *
 * Seeds _defaults, adds tools/skills defaults, drops _dispatch_legacy. The
 * normalization runs even with no legacy shape so already-migrated configs
 * pinned to the stale Explore-only subagent default (or the broad `worca-*`
 * skills glob) self-heal on next save. Gated by a version stamp → idempotent.
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

  if (hasSubagentDispatch || hasLegacyFlatDispatch) {
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
      subagents.default_denied = [
        ...DISPATCH_DEFAULTS.subagents.default_denied,
      ];
    }

    if (!dispatch.tools) {
      dispatch.tools = structuredClone(DISPATCH_DEFAULTS.tools);
    }
    if (!dispatch.skills) {
      dispatch.skills = structuredClone(DISPATCH_DEFAULTS.skills);
    }

    delete gov._dispatch_legacy;
  }

  changes.push(...normalizeDispatchDefaults(gov));

  return changes;
}
