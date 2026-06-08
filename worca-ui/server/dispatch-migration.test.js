import { describe, expect, it } from 'vitest';
import { DISPATCH_DEFAULTS } from './dispatch-defaults.js';
import {
  adoptGeneralPurposeAllowable,
  DISPATCH_MIGRATION_VERSION,
  migrateDispatchGovernance,
  releaseGeneralPurposeDefaultDeny,
} from './dispatch-migration.js';

describe('migrateDispatchGovernance', () => {
  it('migrates subagent_dispatch to dispatch.subagents.per_agent_allow', () => {
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
          coordinator: [],
          implementer: ['Explore', 'feature-dev:code-reviewer'],
        },
      },
    };
    const changes = migrateDispatchGovernance(worca);
    expect(changes).toHaveLength(1);
    expect(worca.governance.subagent_dispatch).toBeUndefined();
    expect(worca.governance.dispatch.subagents.per_agent_allow).toEqual(
      expect.objectContaining({
        planner: ['Explore'],
        coordinator: [],
        implementer: ['Explore', 'feature-dev:code-reviewer'],
      }),
    );
  });

  it('seeds _defaults from DISPATCH_DEFAULTS when missing', () => {
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
        },
      },
    };
    migrateDispatchGovernance(worca);
    expect(
      worca.governance.dispatch.subagents.per_agent_allow._defaults,
    ).toEqual(DISPATCH_DEFAULTS.subagents.per_agent_allow._defaults);
  });

  it('preserves existing _defaults if already present', () => {
    const worca = {
      governance: {
        subagent_dispatch: {
          _defaults: ['Explore', 'Plan'],
          planner: ['Explore'],
        },
      },
    };
    migrateDispatchGovernance(worca);
    expect(
      worca.governance.dispatch.subagents.per_agent_allow._defaults,
    ).toEqual(['Explore', 'Plan']);
  });

  it('seeds always_disallowed and default_denied', () => {
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
        },
      },
    };
    migrateDispatchGovernance(worca);
    expect(worca.governance.dispatch.subagents.always_disallowed).toEqual(
      DISPATCH_DEFAULTS.subagents.always_disallowed,
    );
    expect(worca.governance.dispatch.subagents.default_denied).toEqual(
      DISPATCH_DEFAULTS.subagents.default_denied,
    );
  });

  it('adds tools and skills sections with defaults', () => {
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
        },
      },
    };
    migrateDispatchGovernance(worca);
    expect(worca.governance.dispatch.tools).toEqual(DISPATCH_DEFAULTS.tools);
    expect(worca.governance.dispatch.skills).toEqual(DISPATCH_DEFAULTS.skills);
  });

  it('drops _dispatch_legacy', () => {
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
        },
        _dispatch_legacy: { old_key: 'old_value' },
      },
    };
    migrateDispatchGovernance(worca);
    expect(worca.governance._dispatch_legacy).toBeUndefined();
  });

  it('returns empty changes when no subagent_dispatch key', () => {
    const worca = {
      governance: {
        guards: { plan_check: true },
      },
    };
    const changes = migrateDispatchGovernance(worca);
    expect(changes).toEqual([]);
  });

  it('returns empty changes when governance is missing', () => {
    const worca = {};
    const changes = migrateDispatchGovernance(worca);
    expect(changes).toEqual([]);
  });

  it('returns empty changes when governance is not an object', () => {
    const worca = { governance: 'invalid' };
    const changes = migrateDispatchGovernance(worca);
    expect(changes).toEqual([]);
  });

  it('is idempotent — second call is a no-op', () => {
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
          coordinator: [],
        },
      },
    };
    migrateDispatchGovernance(worca);
    const afterFirst = structuredClone(worca);
    const changes2 = migrateDispatchGovernance(worca);
    expect(changes2).toEqual([]);
    expect(worca).toEqual(afterFirst);
  });

  it('does not overwrite existing dispatch.subagents values', () => {
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
        },
        dispatch: {
          subagents: {
            always_disallowed: ['general-purpose', 'custom-deny'],
            per_agent_allow: {
              tester: ['Explore', 'Plan'],
            },
          },
        },
      },
    };
    migrateDispatchGovernance(worca);
    expect(worca.governance.dispatch.subagents.always_disallowed).toEqual([
      'general-purpose',
      'custom-deny',
    ]);
    expect(worca.governance.dispatch.subagents.per_agent_allow.tester).toEqual([
      'Explore',
      'Plan',
    ]);
    expect(worca.governance.dispatch.subagents.per_agent_allow.planner).toEqual(
      ['Explore'],
    );
  });

  it('collapses the legacy Explore-only default to the new wildcard default', () => {
    // The full eight-agent Explore-only enumeration is the untouched W-038
    // default. The W-054 follow-up adopts the new permissive `_defaults: ["*"]`
    // default for it instead of preserving the per-agent Explore caps.
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
          plan_reviewer: ['Explore'],
          coordinator: [],
          implementer: ['Explore'],
          tester: ['Explore'],
          reviewer: ['Explore'],
          guardian: ['Explore'],
          learner: ['Explore'],
        },
      },
    };
    migrateDispatchGovernance(worca);
    const pa = worca.governance.dispatch.subagents.per_agent_allow;
    expect(pa).toEqual({ _defaults: ['*'] });
    expect(worca.governance.dispatch_migration_version).toBe(
      DISPATCH_MIGRATION_VERSION,
    );
  });

  it('preserves a genuinely customized subagent shape', () => {
    // A shape that differs from the untouched W-038 default (here: an extra
    // allowed subagent) is a deliberate operator choice and must survive.
    const worca = {
      governance: {
        subagent_dispatch: {
          planner: ['Explore'],
          implementer: ['Explore', 'feature-dev:code-reviewer'],
          tester: ['Explore'],
          guardian: ['Explore'],
          reviewer: ['Explore'],
          plan_reviewer: ['Explore'],
          learner: ['Explore'],
        },
      },
    };
    migrateDispatchGovernance(worca);
    const pa = worca.governance.dispatch.subagents.per_agent_allow;
    expect(pa.implementer).toEqual(['Explore', 'feature-dev:code-reviewer']);
    expect(pa.planner).toEqual(['Explore']);
  });
});

describe('normalizeDispatchDefaults (W-054 follow-up)', () => {
  // Pop-1 fixture: already on the W-054 nested shape (no legacy keys) but still
  // pinned to the stale Explore-only subagent default + broad worca-* skills
  // glob, with no version stamp.
  function pop1Config() {
    return {
      governance: {
        dispatch: {
          subagents: {
            per_agent_allow: {
              planner: ['Explore'],
              coordinator: [],
              implementer: ['Explore'],
              tester: ['Explore'],
              guardian: ['Explore'],
              reviewer: ['Explore'],
              plan_reviewer: ['Explore'],
              learner: ['Explore'],
              _defaults: ['*'],
            },
            always_disallowed: ['general-purpose'],
            default_denied: [],
          },
          skills: {
            always_disallowed: [
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
            ],
            default_denied: [],
            per_agent_allow: { _defaults: ['*'] },
          },
          tools: {
            always_disallowed: [],
            default_denied: [],
            per_agent_allow: { _defaults: ['*'] },
          },
        },
      },
    };
  }

  it('collapses stale Pop-1 subagent default and narrows the skills glob', () => {
    const worca = pop1Config();
    const changes = migrateDispatchGovernance(worca);
    const d = worca.governance.dispatch;
    expect(d.subagents.per_agent_allow).toEqual({ _defaults: ['*'] });
    expect(d.subagents.always_disallowed).toEqual([]);
    // general-purpose is moved to default_denied (v2) then released (v3) —
    // net: allowed under "*", in neither deny tier.
    expect(d.subagents.default_denied).toEqual([]);
    expect(d.skills.always_disallowed).not.toContain('worca-*');
    expect(d.skills.always_disallowed).toContain('worca-release');
    expect(worca.governance.dispatch_migration_version).toBe(
      DISPATCH_MIGRATION_VERSION,
    );
    expect(changes.length).toBeGreaterThan(0);
  });

  it('is idempotent — a second pass makes no changes', () => {
    const worca = pop1Config();
    migrateDispatchGovernance(worca);
    const snapshot = JSON.stringify(worca);
    const changes = migrateDispatchGovernance(worca);
    expect(changes).toEqual([]);
    expect(JSON.stringify(worca)).toBe(snapshot);
  });

  it('does not touch a config already stamped at the current version', () => {
    const worca = pop1Config();
    worca.governance.dispatch_migration_version = DISPATCH_MIGRATION_VERSION;
    const changes = migrateDispatchGovernance(worca);
    // Stamp present → stale shapes are left exactly as the operator left them.
    expect(changes).toEqual([]);
    expect(worca.governance.dispatch.subagents.per_agent_allow.planner).toEqual(
      ['Explore'],
    );
    expect(worca.governance.dispatch.skills.always_disallowed).toContain(
      'worca-*',
    );
  });

  it('preserves a Pop-1 config with a customized _defaults', () => {
    const worca = pop1Config();
    worca.governance.dispatch.subagents.per_agent_allow._defaults = ['Explore'];
    migrateDispatchGovernance(worca);
    // Customized _defaults means the operator touched it → not collapsed.
    expect(worca.governance.dispatch.subagents.per_agent_allow.planner).toEqual(
      ['Explore'],
    );
  });
});

describe('adoptGeneralPurposeAllowable', () => {
  it('moves general-purpose from always_disallowed to default_denied', () => {
    const cfg = { always_disallowed: ['general-purpose'], default_denied: [] };
    expect(adoptGeneralPurposeAllowable(cfg)).toBe(true);
    expect(cfg.always_disallowed).toEqual([]);
    expect(cfg.default_denied).toEqual(['general-purpose']);
  });

  it('preserves existing default_denied entries', () => {
    const cfg = {
      always_disallowed: ['general-purpose'],
      default_denied: ['foo'],
    };
    expect(adoptGeneralPurposeAllowable(cfg)).toBe(true);
    expect(cfg.default_denied).toEqual(['foo', 'general-purpose']);
  });

  it('leaves a customized denylist (extra entries) alone', () => {
    const cfg = {
      always_disallowed: ['general-purpose', 'custom-deny'],
      default_denied: [],
    };
    expect(adoptGeneralPurposeAllowable(cfg)).toBe(false);
    expect(cfg.always_disallowed).toEqual(['general-purpose', 'custom-deny']);
  });

  it('is a no-op when already migrated', () => {
    const cfg = { always_disallowed: [], default_denied: ['general-purpose'] };
    expect(adoptGeneralPurposeAllowable(cfg)).toBe(false);
  });

  it('current migration version is 3', () => {
    expect(DISPATCH_MIGRATION_VERSION).toBe(3);
  });
});

describe('releaseGeneralPurposeDefaultDeny (v3)', () => {
  it('removes general-purpose from default_denied', () => {
    const cfg = { always_disallowed: [], default_denied: ['general-purpose'] };
    expect(releaseGeneralPurposeDefaultDeny(cfg)).toBe(true);
    expect(cfg.default_denied).toEqual([]);
  });

  it('is a no-op when default_denied is already clear', () => {
    const cfg = { always_disallowed: [], default_denied: [] };
    expect(releaseGeneralPurposeDefaultDeny(cfg)).toBe(false);
  });

  it('leaves a customized default_denied (extra entries) alone', () => {
    const cfg = {
      always_disallowed: [],
      default_denied: ['general-purpose', 'custom'],
    };
    expect(releaseGeneralPurposeDefaultDeny(cfg)).toBe(false);
    expect(cfg.default_denied).toEqual(['general-purpose', 'custom']);
  });

  it('heals a v2-stamped config on upgrade (the field scenario)', () => {
    const worca = {
      governance: {
        dispatch: {
          subagents: {
            always_disallowed: [],
            default_denied: ['general-purpose'],
            per_agent_allow: { _defaults: ['*'] },
          },
        },
        dispatch_migration_version: 2,
      },
    };
    migrateDispatchGovernance(worca);
    expect(worca.governance.dispatch.subagents.default_denied).toEqual([]);
    expect(worca.governance.dispatch_migration_version).toBe(
      DISPATCH_MIGRATION_VERSION,
    );
  });
});
