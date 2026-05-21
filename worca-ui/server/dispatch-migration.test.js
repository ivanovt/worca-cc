import { describe, expect, it } from 'vitest';
import { DISPATCH_DEFAULTS } from './dispatch-defaults.js';
import { migrateDispatchGovernance } from './dispatch-migration.js';

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

  it('preserves full eight-agent enumerated shape', () => {
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
    expect(pa.planner).toEqual(['Explore']);
    expect(pa.coordinator).toEqual([]);
    expect(pa.implementer).toEqual(['Explore']);
    // PR B: subagents _defaults is now ['*']; the migration seeds the new
    // default for projects that didn't have an explicit _defaults entry.
    expect(pa._defaults).toEqual(['*']);
  });
});
