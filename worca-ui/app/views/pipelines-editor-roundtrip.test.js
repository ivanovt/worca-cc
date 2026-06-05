/**
 * Round-trip tests for `buildFormBuffer` / `formBufferToConfig` —
 * the editor's read-and-write boundary on the template config.
 *
 * Regressions covered (issue #273):
 *
 *   1a. `config.effort` (`auto_mode` / `auto_cap`) must seed
 *       `form.effort`. Without this, a template with
 *       `auto_mode: disabled` opens as the default `adaptive` and a
 *       casual touch in the Agents tab silently overwrites disk.
 *
 *   1b. `config.governance.guards` is cross-template (NOT in
 *       TEMPLATE_OWNED_KEYS) and must be stripped before write.
 *       Saving any template otherwise captures the project's
 *       hook-gate snapshot, which then wins over later project
 *       edits.
 *
 *   1c. `config.governance.dispatch` is template-owned but the
 *       form buffer pre-merges project dispatch for the display
 *       view. The buffer's dirty flag per section controls what's
 *       actually written: untouched sections fall back to the
 *       template-original snapshot, never the merged view.
 *
 *   1d. Unknown per-agent fields (anything beyond
 *       `model / max_turns / effort`) must survive the round-trip.
 *       Currently no built-in template uses extra keys, but adding
 *       one shouldn't silently drop on save.
 */

import { describe, expect, it } from 'vitest';
import { DISPATCH_DEFAULTS } from '../../server/dispatch-defaults.js';
import { buildFormBuffer, formBufferToConfig } from './pipelines-editor.js';

// --- 1a: effort block round-trips ---

describe('buildFormBuffer / formBufferToConfig — effort block', () => {
  it('seeds form.effort from config.effort', () => {
    const config = {
      effort: { auto_mode: 'disabled', auto_cap: 'high' },
    };
    const form = buildFormBuffer(config, { worca: {} });
    expect(form.effort).toEqual({
      auto_mode: 'disabled',
      auto_cap: 'high',
    });
  });

  it('round-trips auto_mode: disabled without silent corruption', () => {
    const config = {
      effort: { auto_mode: 'disabled', auto_cap: 'medium' },
    };
    const form = buildFormBuffer(config, { worca: {} });
    const out = formBufferToConfig(form);
    expect(out.effort.auto_mode).toBe('disabled');
    expect(out.effort.auto_cap).toBe('medium');
  });

  it('preserves a non-default auto_cap when seeded', () => {
    const config = {
      effort: { auto_mode: 'reactive', auto_cap: 'low' },
    };
    const form = buildFormBuffer(config, { worca: {} });
    expect(form.effort.auto_cap).toBe('low');
    expect(formBufferToConfig(form).effort).toEqual({
      auto_mode: 'reactive',
      auto_cap: 'low',
    });
  });

  it('seeds an empty form.effort when config has no effort block', () => {
    const config = {};
    const form = buildFormBuffer(config, { worca: {} });
    expect(form.effort).toEqual({});
    // formBufferToConfig should omit the key entirely so the
    // Python loader uses its own defaults.
    const out = formBufferToConfig(form);
    expect(out).not.toHaveProperty('effort');
  });
});

// --- 1b: governance.guards must NOT leak into the template ---

describe('formBufferToConfig — governance.guards is cross-template', () => {
  it('drops governance.guards from the written config (clean form buffer)', () => {
    const config = {};
    const settings = {
      worca: {
        governance: {
          guards: {
            block_rm_rf: true,
            block_env_write: true,
            block_force_push: false, // a project-local tweak
            restrict_git_commit: true,
          },
        },
      },
    };
    const form = buildFormBuffer(config, settings);
    // buildFormBuffer hydrates form.governance.guards from project
    // settings for the display view…
    expect(form.governance.guards).toBeDefined();
    // …but formBufferToConfig must drop it on write.
    const out = formBufferToConfig(form);
    expect(out.governance).toBeDefined();
    expect(out.governance.guards).toBeUndefined();
  });

  it('drops governance.guards even when the template originally had no guards', () => {
    const config = { governance: { dispatch: {} } };
    const settings = {
      worca: { governance: { guards: { block_rm_rf: true } } },
    };
    const form = buildFormBuffer(config, settings);
    const out = formBufferToConfig(form);
    expect(out.governance.guards).toBeUndefined();
  });

  it('keeps template-owned governance keys (test_gate_strikes, plan_review_enforce)', () => {
    const config = {
      governance: {
        test_gate_strikes: 1,
        plan_review_enforce: 'review',
        dispatch: {},
      },
    };
    const form = buildFormBuffer(config, { worca: {} });
    const out = formBufferToConfig(form);
    expect(out.governance.test_gate_strikes).toBe(1);
    expect(out.governance.plan_review_enforce).toBe('review');
  });
});

// --- 1c: dispatch must not capture project snapshot ---

describe('formBufferToConfig — governance.dispatch is template-owned but not project-leaked', () => {
  function projectSettingsWithDispatch() {
    return {
      worca: {
        governance: {
          dispatch: {
            tools: {
              always_disallowed: [],
              default_denied: [],
              per_agent_allow: { coordinator: ['Read', 'Grep'] },
            },
            skills: {
              per_agent_allow: { planner: ['some-project-skill'] },
            },
            subagents: {
              per_agent_allow: { _defaults: ['*'] },
            },
          },
        },
      },
    };
  }

  it('preserves a clean template (no edits) exactly as the template originally had it', () => {
    // Template has only ONE narrow dispatch entry; project has more.
    const config = {
      governance: {
        dispatch: {
          tools: {
            per_agent_allow: { planner: ['Read'] },
          },
        },
      },
    };
    const form = buildFormBuffer(config, projectSettingsWithDispatch());
    const out = formBufferToConfig(form);

    // Tools: template original wins (no widening from project).
    expect(out.governance.dispatch.tools).toEqual({
      per_agent_allow: { planner: ['Read'] },
    });
    // Skills + subagents: template never declared them; project's
    // snapshot must NOT leak into the saved template.
    expect(out.governance.dispatch.skills).toBeUndefined();
    expect(out.governance.dispatch.subagents).toBeUndefined();
  });

  it('omits dispatch entirely when the template had no dispatch and the user never touched it', () => {
    const config = {};
    const form = buildFormBuffer(config, projectSettingsWithDispatch());
    const out = formBufferToConfig(form);
    expect(out.governance.dispatch).toBeUndefined();
  });

  it('writes the user-edited section when its dirty flag is set', () => {
    const config = {
      governance: {
        dispatch: {
          tools: { per_agent_allow: { planner: ['Read'] } },
        },
      },
    };
    const form = buildFormBuffer(config, projectSettingsWithDispatch());

    // Simulate a UI edit to the tools section: update the merged
    // view AND set the dirty flag.
    form.governance.dispatch.tools = {
      per_agent_allow: { planner: ['Read', 'Grep'] },
    };
    form._dispatchDirty.tools = true;

    const out = formBufferToConfig(form);
    expect(out.governance.dispatch.tools).toEqual({
      per_agent_allow: { planner: ['Read', 'Grep'] },
    });
    // Other sections still untouched — no project leakage.
    expect(out.governance.dispatch.skills).toBeUndefined();
    expect(out.governance.dispatch.subagents).toBeUndefined();
  });

  it('treats sections independently — dirty tools does not flush clean skills', () => {
    const config = {
      governance: {
        dispatch: {
          skills: { per_agent_allow: { planner: ['something'] } },
        },
      },
    };
    const form = buildFormBuffer(config, projectSettingsWithDispatch());
    form.governance.dispatch.tools = {
      per_agent_allow: { coordinator: ['Read'] },
    };
    form._dispatchDirty.tools = true;

    const out = formBufferToConfig(form);
    expect(out.governance.dispatch.tools).toEqual({
      per_agent_allow: { coordinator: ['Read'] },
    });
    // Skills was in the template's original — preserved exactly.
    expect(out.governance.dispatch.skills).toEqual({
      per_agent_allow: { planner: ['something'] },
    });
    expect(out.governance.dispatch.subagents).toBeUndefined();
  });
});

// --- 1e: dispatch display is correctly sectioned + deny tiers editable ---

describe('buildFormBuffer — display dispatch is keyed by section', () => {
  it('produces tools/skills/subagents sections (not a single flat tier-set)', () => {
    const form = buildFormBuffer({}, { worca: {} });
    const d = form.governance.dispatch;
    expect(d.tools).toBeDefined();
    expect(d.skills).toBeDefined();
    expect(d.subagents).toBeDefined();
    // The pre-fix bug produced a flat {always_disallowed,...} at the top
    // level; guard against its return.
    expect(d.always_disallowed).toBeUndefined();
  });

  it('seeds each section deny tiers from the shipped DISPATCH_DEFAULTS floor', () => {
    const form = buildFormBuffer({}, { worca: {} });
    expect(form.governance.dispatch.tools.always_disallowed).toEqual(
      DISPATCH_DEFAULTS.tools.always_disallowed,
    );
    expect(form.governance.dispatch.skills.default_denied).toEqual(
      DISPATCH_DEFAULTS.skills.default_denied,
    );
  });

  it("preserves the template's own per_agent_allow (regression: was dropped)", () => {
    const config = {
      governance: {
        dispatch: { tools: { per_agent_allow: { planner: ['Read'] } } },
      },
    };
    const form = buildFormBuffer(config, { worca: {} });
    expect(form.governance.dispatch.tools.per_agent_allow).toEqual({
      planner: ['Read'],
    });
  });

  it('does NOT seed the project dispatch as the floor (templates are portable)', () => {
    const config = {};
    const projectSettings = {
      worca: {
        governance: {
          dispatch: {
            tools: { always_disallowed: ['ProjectOnlyTool'] },
          },
        },
      },
    };
    const form = buildFormBuffer(config, projectSettings);
    expect(form.governance.dispatch.tools.always_disallowed).not.toContain(
      'ProjectOnlyTool',
    );
    expect(form.governance.dispatch.tools.always_disallowed).toEqual(
      DISPATCH_DEFAULTS.tools.always_disallowed,
    );
  });
});

describe('formBufferToConfig — deny tiers strip-on-write vs persist-when-customized', () => {
  it('strips deny tiers that equal the shipped defaults (per_agent_allow-only edit)', () => {
    const config = {
      governance: {
        dispatch: { tools: { per_agent_allow: { planner: ['Read'] } } },
      },
    };
    const form = buildFormBuffer(config, { worca: {} });
    // dirty the section (deny tiers untouched = seeded defaults)
    form._dispatchDirty.tools = true;
    const out = formBufferToConfig(form);
    expect(out.governance.dispatch.tools).toEqual({
      per_agent_allow: { planner: ['Read'] },
    });
  });

  it('persists an added always_disallowed entry', () => {
    const form = buildFormBuffer({}, { worca: {} });
    form.governance.dispatch.tools.always_disallowed = [
      ...DISPATCH_DEFAULTS.tools.always_disallowed,
      'CustomTool',
    ];
    form._dispatchDirty.tools = true;
    const out = formBufferToConfig(form);
    expect(out.governance.dispatch.tools.always_disallowed).toContain(
      'CustomTool',
    );
  });

  it('persists a pruned default_denied entry as the shorter list', () => {
    const form = buildFormBuffer({}, { worca: {} });
    form.governance.dispatch.skills.default_denied =
      DISPATCH_DEFAULTS.skills.default_denied.filter((x) => x !== 'simplify');
    form._dispatchDirty.skills = true;
    const out = formBufferToConfig(form);
    expect(out.governance.dispatch.skills.default_denied).not.toContain(
      'simplify',
    );
  });
});

// --- 1d: unknown per-agent fields survive round-trip ---

describe('formBufferToConfig — per-agent unknown keys survive round-trip', () => {
  it('preserves an arbitrary future per-agent key', () => {
    const config = {
      agents: {
        planner: {
          model: 'opus',
          max_turns: 100,
          effort: 'high',
          // A hypothetical future key that the editor UI does not
          // know about. Must NOT be silently dropped on save.
          custom_future_knob: 'enabled',
        },
      },
    };
    const form = buildFormBuffer(config, { worca: {} });
    const out = formBufferToConfig(form);
    expect(out.agents.planner.model).toBe('opus');
    expect(out.agents.planner.max_turns).toBe(100);
    expect(out.agents.planner.effort).toBe('high');
    expect(out.agents.planner.custom_future_knob).toBe('enabled');
  });

  it('drops effort when the user explicitly cleared it (null in form buffer)', () => {
    const config = {
      agents: {
        planner: { model: 'opus', max_turns: 100, effort: 'high' },
      },
    };
    const form = buildFormBuffer(config, { worca: {} });
    form.agents.planner.effort = null; // user cleared the dropdown
    const out = formBufferToConfig(form);
    expect(out.agents.planner).not.toHaveProperty('effort');
    expect(out.agents.planner.model).toBe('opus');
    expect(out.agents.planner.max_turns).toBe(100);
  });

  it('preserves model/max_turns when the template had no agents block at all', () => {
    const config = {};
    const form = buildFormBuffer(config, { worca: {} });
    const out = formBufferToConfig(form);
    // Every agent in AGENT_NAMES gets defaults.
    expect(out.agents.planner.model).toBe('sonnet');
    expect(out.agents.planner.max_turns).toBe(30);
  });
});
