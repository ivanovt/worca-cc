import { describe, expect, it } from 'vitest';
import { DISPATCH_DEFAULTS, matchesAny } from './dispatch-defaults.js';

describe('DISPATCH_DEFAULTS', () => {
  it('has all three sections', () => {
    expect(DISPATCH_DEFAULTS).toHaveProperty('tools');
    expect(DISPATCH_DEFAULTS).toHaveProperty('skills');
    expect(DISPATCH_DEFAULTS).toHaveProperty('subagents');
  });

  it('each section has the three-tier shape', () => {
    for (const section of ['tools', 'skills', 'subagents']) {
      const s = DISPATCH_DEFAULTS[section];
      expect(s).toHaveProperty('always_disallowed');
      expect(s).toHaveProperty('default_denied');
      expect(s).toHaveProperty('per_agent_allow');
      expect(s.per_agent_allow).toHaveProperty('_defaults');
      expect(Array.isArray(s.always_disallowed)).toBe(true);
      expect(Array.isArray(s.default_denied)).toBe(true);
    }
  });

  it('tools always_disallowed includes the three footgun tools', () => {
    expect(DISPATCH_DEFAULTS.tools.always_disallowed).toEqual(
      expect.arrayContaining(['EnterPlanMode', 'EnterWorktree', 'TodoWrite']),
    );
  });

  it('tools _defaults is wildcard', () => {
    expect(DISPATCH_DEFAULTS.tools.per_agent_allow._defaults).toEqual(['*']);
  });

  it('skills always_disallowed includes pipeline-recursion skills', () => {
    expect(DISPATCH_DEFAULTS.skills.always_disallowed).toEqual(
      expect.arrayContaining(['loop', 'schedule', 'init']),
    );
  });

  it('skills always_disallowed names dangerous worca-* skills individually, not via a glob', () => {
    // The broad `worca-*` glob was narrowed so useful dev skills (precommit,
    // coverage, ui/event scaffolding) are dispatchable; only genuinely
    // dangerous worca-* skills (release/sync/override/launch) stay hard-denied.
    expect(DISPATCH_DEFAULTS.skills.always_disallowed).not.toContain('worca-*');
    expect(DISPATCH_DEFAULTS.skills.always_disallowed).toEqual(
      expect.arrayContaining([
        'worca-release',
        'worca-rc',
        'worca-pr-prep',
        'worca-install',
        'worca-sync',
        'worca-agent-override',
        'worca-analyze',
        'worca-plan-new',
      ]),
    );
  });

  it('skills always_disallowed includes new dangerous bundled skills (PR A)', () => {
    expect(DISPATCH_DEFAULTS.skills.always_disallowed).toEqual(
      expect.arrayContaining(['batch', 'fewer-permission-prompts']),
    );
  });

  it('skills default_denied includes review and feature-dev:feature-dev', () => {
    expect(DISPATCH_DEFAULTS.skills.default_denied).toEqual(
      expect.arrayContaining([
        'review',
        'security-review',
        'feature-dev:feature-dev',
      ]),
    );
  });

  it('skills default_denied includes new bundled skills with per-agent opt-ins (PR A)', () => {
    expect(DISPATCH_DEFAULTS.skills.default_denied).toEqual(
      expect.arrayContaining(['simplify', 'debug', 'claude-api']),
    );
  });

  it('skills _defaults is wildcard', () => {
    expect(DISPATCH_DEFAULTS.skills.per_agent_allow._defaults).toEqual(['*']);
  });

  it('skills per_agent_allow opts implementer into simplify and claude-api', () => {
    expect(DISPATCH_DEFAULTS.skills.per_agent_allow.implementer).toEqual(
      expect.arrayContaining(['simplify', 'claude-api']),
    );
  });

  it('skills per_agent_allow opts tester into debug', () => {
    expect(DISPATCH_DEFAULTS.skills.per_agent_allow.tester).toEqual(
      expect.arrayContaining(['debug']),
    );
  });

  it('skills per_agent_allow opts reviewer into review/security-review', () => {
    expect(DISPATCH_DEFAULTS.skills.per_agent_allow.reviewer).toEqual(
      expect.arrayContaining(['review', 'security-review']),
    );
  });

  it('skills per_agent_allow opts learner into claude-md-management skills', () => {
    expect(DISPATCH_DEFAULTS.skills.per_agent_allow.learner).toEqual(
      expect.arrayContaining([
        'claude-md-management:revise-claude-md',
        'claude-md-management:claude-md-improver',
      ]),
    );
  });

  it('subagents always_disallowed is general-purpose', () => {
    expect(DISPATCH_DEFAULTS.subagents.always_disallowed).toEqual([
      'general-purpose',
    ]);
  });

  it('subagents default_denied is empty', () => {
    expect(DISPATCH_DEFAULTS.subagents.default_denied).toEqual([]);
  });

  it('subagents _defaults is wildcard (PR B)', () => {
    expect(DISPATCH_DEFAULTS.subagents.per_agent_allow._defaults).toEqual([
      '*',
    ]);
  });
});

describe('matchesAny', () => {
  it('exact match', () => {
    expect(matchesAny('hookify:hookify', ['hookify:hookify'])).toBe(true);
  });

  it('exact match — no match', () => {
    expect(matchesAny('hookify:list', ['hookify:hookify'])).toBe(false);
  });

  it('trailing-* prefix glob matches', () => {
    expect(matchesAny('worca-install', ['worca-*'])).toBe(true);
  });

  it('trailing-* prefix glob does not match without prefix', () => {
    expect(matchesAny('worca', ['worca-*'])).toBe(false);
  });

  it('bare * matches everything', () => {
    expect(matchesAny('anything', ['*'])).toBe(true);
  });

  it('empty candidate does not match worca-*', () => {
    expect(matchesAny('', ['worca-*'])).toBe(false);
  });

  it('empty patterns list matches nothing', () => {
    expect(matchesAny('foo', [])).toBe(false);
  });

  it('multiple patterns — first match wins', () => {
    expect(matchesAny('worca-sync', ['loop', 'schedule', 'worca-*'])).toBe(
      true,
    );
  });

  it('multiple patterns — none match', () => {
    expect(matchesAny('my-custom-skill', ['loop', 'schedule', 'worca-*'])).toBe(
      false,
    );
  });

  it('bare * as a pattern in a list with other patterns', () => {
    expect(matchesAny('anything', ['foo', '*'])).toBe(true);
  });

  it('prefix glob with colon-namespaced skill', () => {
    expect(matchesAny('hookify:configure', ['hookify:*'])).toBe(true);
  });
});
