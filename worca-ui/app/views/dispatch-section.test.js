import { describe, expect, it, vi } from 'vitest';
import { DISPATCH_DEFAULTS } from '../../server/dispatch-defaults.js';
import { dispatchSectionView, resetSectionConfig } from './dispatch-section.js';

function renderToString(template) {
  if (!template) return '';
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

const AGENT_ROLES = [
  'planner',
  'coordinator',
  'implementer',
  'tester',
  'reviewer',
  'guardian',
  'learner',
  'workspace_planner',
];

const KNOWN_SUBAGENTS = [
  { name: 'Explore', label: '(built-in)', group: 'Built-in' },
  { name: 'Plan', label: '(built-in)', group: 'Built-in' },
];

describe('dispatch-section', () => {
  describe('wildcard chip renders distinctly', () => {
    it('* chip has the dispatch-chip-wildcard class', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'subagents',
          config: {
            always_disallowed: ['general-purpose'],
            default_denied: [],
            per_agent_allow: { _defaults: ['*'] },
          },
          knownItems: KNOWN_SUBAGENTS,
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.subagents,
          onChange: vi.fn(),
        }),
      );
      expect(html).toContain('dispatch-chip-wildcard');
    });

    it('* chip displays "any" label', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'subagents',
          config: {
            always_disallowed: [],
            default_denied: [],
            per_agent_allow: { _defaults: ['*'] },
          },
          knownItems: KNOWN_SUBAGENTS,
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.subagents,
          onChange: vi.fn(),
        }),
      );
      expect(html).toContain('any');
    });

    it('named chip does not have wildcard class', () => {
      // Pass narrow defaults so per-agent rows fall back to "Explore" (not
      // the post-PR-B `*` default), then assert the named chip itself does
      // not carry the wildcard class.
      const narrowDefaults = {
        always_disallowed: [],
        default_denied: [],
        per_agent_allow: { _defaults: ['Explore'] },
      };
      const html = renderToString(
        dispatchSectionView({
          section: 'subagents',
          config: narrowDefaults,
          knownItems: KNOWN_SUBAGENTS,
          agentRoles: AGENT_ROLES,
          defaults: narrowDefaults,
          onChange: vi.fn(),
        }),
      );
      expect(html).not.toContain('dispatch-chip-wildcard');
    });
  });

  describe('mixed form parses', () => {
    it('renders both wildcard and named chips for ["*", "review"]', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'skills',
          config: {
            always_disallowed: [],
            default_denied: ['review'],
            per_agent_allow: { _defaults: ['*', 'review'] },
          },
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.skills,
          onChange: vi.fn(),
        }),
      );
      expect(html).toContain('dispatch-chip-wildcard');
      expect(html).toContain('review');
    });

    it('mixed form renders per-agent row with both chips', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'subagents',
          config: {
            always_disallowed: [],
            default_denied: [],
            per_agent_allow: {
              _defaults: ['Explore'],
              implementer: ['*', 'feature-dev:code-reviewer'],
            },
          },
          knownItems: KNOWN_SUBAGENTS,
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.subagents,
          onChange: vi.fn(),
        }),
      );
      expect(html).toContain('dispatch-chip-wildcard');
      expect(html).toContain('feature-dev:code-reviewer');
    });
  });

  describe('always_disallowed chips locked', () => {
    it('locked chips have dispatch-chip-locked class', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'tools',
          config: {
            always_disallowed: ['EnterPlanMode', 'TodoWrite'],
            default_denied: [],
            per_agent_allow: { _defaults: ['*'] },
          },
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.tools,
          onChange: vi.fn(),
        }),
      );
      expect(html).toContain('dispatch-chip-locked');
      expect(html).toContain('EnterPlanMode');
      expect(html).toContain('TodoWrite');
    });

    it('locked chips have no remove button (not removable)', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'subagents',
          config: {
            always_disallowed: ['general-purpose'],
            default_denied: [],
            per_agent_allow: { _defaults: ['Explore'] },
          },
          knownItems: KNOWN_SUBAGENTS,
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.subagents,
          onChange: vi.fn(),
        }),
      );
      // Locate the chip element by its data-value rather than slicing on a
      // section divider — the "Default Denied" header isn't rendered when
      // the section is empty.
      const chipMatch = html.match(
        /<sl-tag([^>]*)data-value="general-purpose"/,
      );
      expect(chipMatch).not.toBeNull();
      expect(chipMatch[1]).not.toContain('removable');
    });
  });

  describe('default_denied chips editable', () => {
    it('default_denied chips have dispatch-chip-warn class', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'skills',
          config: {
            always_disallowed: [],
            default_denied: ['review', 'security-review'],
            per_agent_allow: { _defaults: ['*'] },
          },
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.skills,
          onChange: vi.fn(),
        }),
      );
      expect(html).toContain('dispatch-chip-warn');
      expect(html).toContain('review');
      expect(html).toContain('security-review');
    });

    it('default_denied chips are removable', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'skills',
          config: {
            always_disallowed: [],
            default_denied: ['review'],
            per_agent_allow: { _defaults: ['*'] },
          },
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.skills,
          onChange: vi.fn(),
        }),
      );
      const deniedSection =
        html.split('Default Denied')[1]?.split('Per-Agent')[0] || '';
      expect(deniedSection).toContain('removable');
    });
  });

  describe('per-agent allow rows', () => {
    it('renders _defaults row', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'subagents',
          config: {
            always_disallowed: [],
            default_denied: [],
            per_agent_allow: { _defaults: ['Explore'] },
          },
          knownItems: KNOWN_SUBAGENTS,
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.subagents,
          onChange: vi.fn(),
        }),
      );
      expect(html).toContain('_defaults');
    });

    it('renders per-agent rows for each agent role', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'subagents',
          config: {
            always_disallowed: [],
            default_denied: [],
            per_agent_allow: { _defaults: ['Explore'] },
          },
          knownItems: KNOWN_SUBAGENTS,
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.subagents,
          onChange: vi.fn(),
        }),
      );
      for (const agent of AGENT_ROLES) {
        expect(html).toContain(agent);
      }
    });
  });

  describe('section titles', () => {
    it('renders section heading matching section name', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'tools',
          config: DISPATCH_DEFAULTS.tools,
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.tools,
          onChange: vi.fn(),
        }),
      );
      expect(html).toContain('Tools');
    });
  });

  describe('wildcard tooltip', () => {
    it('* chip carries a title attribute explaining wildcard semantics', () => {
      const html = renderToString(
        dispatchSectionView({
          section: 'subagents',
          config: {
            always_disallowed: ['general-purpose'],
            default_denied: [],
            per_agent_allow: { _defaults: ['*'] },
          },
          knownItems: KNOWN_SUBAGENTS,
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.subagents,
          onChange: vi.fn(),
        }),
      );
      // The wildcard chip should expose a tooltip via the title attribute.
      expect(html).toMatch(
        /title="[^"]*Any item not in the Always Disallowed[^"]*"/,
      );
    });
  });

  describe('auto-included Skill/Agent meta-chips (tools only)', () => {
    function render(perAgent, section) {
      return renderToString(
        dispatchSectionView({
          section,
          config: {
            always_disallowed: [],
            default_denied: [],
            per_agent_allow: perAgent,
          },
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS[section],
          onChange: vi.fn(),
        }),
      );
    }

    it('renders Skill + Agent auto-included chips when tools has a named list', () => {
      const html = render(
        { _defaults: ['*'], planner: ['Read', 'Grep'] },
        'tools',
      );
      // Locate the planner row chips
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      expect(plannerRow).toContain('data-auto-included="true"');
      expect(plannerRow).toMatch(
        /data-value="Skill"[^>]*data-auto-included="true"/,
      );
      expect(plannerRow).toMatch(
        /data-value="Agent"[^>]*data-auto-included="true"/,
      );
      expect(plannerRow).toContain('dispatch-chip-auto');
    });

    it('does NOT render auto-included chips when tools uses wildcard', () => {
      const html = render({ _defaults: ['*'] }, 'tools');
      expect(html).not.toContain('data-auto-included="true"');
    });

    it('does NOT render auto-included chips when tools per-agent is the lockdown sentinel', () => {
      const html = render({ _defaults: ['*'], planner: ['none'] }, 'tools');
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      expect(plannerRow).not.toContain('data-auto-included="true"');
    });

    it('does NOT render auto-included chips when tools per-agent is empty (inherits defaults)', () => {
      // Empty [] falls through to _defaults at resolve time, so no named-list
      // restriction is in effect — the auto-included meta-tools are
      // unnecessary here.
      const html = render({ _defaults: ['*'], planner: [] }, 'tools');
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      expect(plannerRow).not.toContain('data-auto-included="true"');
    });

    it('skips duplicates when user already typed Skill or Agent', () => {
      const html = render(
        { _defaults: ['*'], planner: ['Read', 'Skill'] },
        'tools',
      );
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      // User's Skill chip is editable (no auto-include flag). Only Agent
      // should be auto-included.
      const autoMatches = plannerRow.match(/data-auto-included="true"/g) || [];
      expect(autoMatches).toHaveLength(1);
      expect(plannerRow).toMatch(
        /data-value="Agent"[^>]*data-auto-included="true"/,
      );
    });

    it('skills section never gets the auto-include treatment', () => {
      const html = render(
        { _defaults: ['*'], planner: ['my-custom-skill'] },
        'skills',
      );
      expect(html).not.toContain('data-auto-included="true"');
    });
  });

  describe('Lockdown chip — only the ["none"] sentinel triggers it', () => {
    function render(perAgent, section) {
      return renderToString(
        dispatchSectionView({
          section,
          config: {
            always_disallowed: [],
            default_denied: [],
            per_agent_allow: perAgent,
          },
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS[section],
          onChange: vi.fn(),
        }),
      );
    }

    it('renders Lockdown chip when per-agent list is the ["none"] sentinel', () => {
      const html = render({ _defaults: ['*'], planner: ['none'] }, 'skills');
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      expect(plannerRow).toContain('data-lockdown="true"');
      expect(plannerRow).toContain('Lockdown');
      expect(plannerRow).toContain('dispatch-chip-lockdown');
    });

    it('hides the raw "none" sentinel chip when lockdown is active', () => {
      const html = render({ _defaults: ['*'], planner: ['none'] }, 'skills');
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      // The Lockdown chip uses data-value="none"; assert there is NOT a
      // separate raw chip rendering the bare sentinel.
      const removableNoneChips = plannerRow.match(
        /data-value="none"[^>]*removable/g,
      );
      expect(removableNoneChips).toBeNull();
    });

    it('does NOT render Lockdown when per-agent list is empty []', () => {
      // Empty [] falls through to _defaults at resolve time — that's
      // "inherits defaults", not lockdown.
      const html = render({ _defaults: ['*'], planner: [] }, 'skills');
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      expect(plannerRow).not.toContain('data-lockdown="true"');
      expect(plannerRow).not.toContain('dispatch-chip-lockdown');
    });

    it('does NOT render Lockdown when row inherits non-empty defaults', () => {
      const html = render({ _defaults: ['*'] }, 'skills');
      expect(html).not.toContain('data-lockdown="true"');
    });

    it('does NOT render Lockdown for the _defaults row itself', () => {
      const html = render({ _defaults: ['none'] }, 'skills');
      const defaultsRow =
        html.split('data-agent="_defaults"')[1]?.split('data-agent="')[0] || '';
      expect(defaultsRow).not.toContain('data-lockdown="true"');
    });

    it('renders Lockdown across all three sections when ["none"] is used', () => {
      for (const section of ['tools', 'skills', 'subagents']) {
        const html = render({ _defaults: ['*'], planner: ['none'] }, section);
        const plannerRow =
          html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
        expect(plannerRow).toContain('data-lockdown="true"');
      }
    });
  });

  describe('Inherits-defaults chip for empty per-agent lists', () => {
    function render(perAgent, section) {
      return renderToString(
        dispatchSectionView({
          section,
          config: {
            always_disallowed: [],
            default_denied: [],
            per_agent_allow: perAgent,
          },
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS[section],
          onChange: vi.fn(),
        }),
      );
    }

    it('renders Inherits-defaults chip when per-agent list is empty []', () => {
      const html = render({ _defaults: ['*'], planner: [] }, 'subagents');
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      expect(plannerRow).toContain('data-inherits="true"');
      expect(plannerRow).toContain('Inherits defaults');
      expect(plannerRow).toContain('dispatch-chip-inherits');
    });

    it('does NOT render Inherits chip when per-agent list is ["none"]', () => {
      const html = render({ _defaults: ['*'], planner: ['none'] }, 'subagents');
      const plannerRow =
        html.split('data-agent="planner"')[1]?.split('data-agent="')[0] || '';
      expect(plannerRow).not.toContain('data-inherits="true"');
    });

    it('does NOT render Inherits chip for an uncustomized agent', () => {
      // When the agent has no explicit key, _effectiveTags falls back to
      // _defaults visually — no placeholder needed.
      const html = render({ _defaults: ['*'] }, 'subagents');
      expect(html).not.toContain('data-inherits="true"');
    });

    it('does NOT render Inherits chip for the _defaults row itself', () => {
      const html = render({ _defaults: [] }, 'subagents');
      const defaultsRow =
        html.split('data-agent="_defaults"')[1]?.split('data-agent="')[0] || '';
      expect(defaultsRow).not.toContain('data-inherits="true"');
    });
  });

  describe('suggestion popup tri-state (PR E)', () => {
    const KNOWN_SKILLS = [
      { name: 'review', group: 'Built-in' },
      { name: 'simplify', group: 'Built-in' },
      { name: 'batch', group: 'Built-in' },
      { name: 'my-custom-skill', group: 'User' },
    ];

    function renderWithOpenSuggestions({ defaultDenied, alwaysDisallowed }) {
      const state = { planner: { input: '', showSuggestions: true } };
      return renderToString(
        dispatchSectionView({
          section: 'skills',
          config: {
            always_disallowed: alwaysDisallowed,
            default_denied: defaultDenied,
            per_agent_allow: { _defaults: ['*'] },
          },
          knownItems: KNOWN_SKILLS,
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS.skills,
          onChange: vi.fn(),
          state,
          rerender: () => {},
        }),
      );
    }

    it('default_denied items render with .warn class on suggestion items', () => {
      const html = renderWithOpenSuggestions({
        defaultDenied: ['simplify'],
        alwaysDisallowed: [],
      });
      expect(html).toMatch(/class="item\s+warn"/);
    });

    it('default_denied items render an opt-in hint label', () => {
      const html = renderWithOpenSuggestions({
        defaultDenied: ['simplify'],
        alwaysDisallowed: [],
      });
      expect(html).toContain('item-hint');
      expect(html).toContain('opt-in');
    });

    it('always_disallowed items render with .denied class (not .warn)', () => {
      const html = renderWithOpenSuggestions({
        defaultDenied: [],
        alwaysDisallowed: ['batch'],
      });
      // The batch suggestion item gets .denied
      expect(html).toMatch(/class="item\s+denied"/);
      expect(html).not.toMatch(/class="item\s+warn"/);
    });

    it('always_disallowed wins over default_denied on suggestion items', () => {
      const html = renderWithOpenSuggestions({
        defaultDenied: ['batch'],
        alwaysDisallowed: ['batch'],
      });
      // batch should be denied (line-through), NOT warn
      expect(html).toMatch(/class="item\s+denied"/);
      // The opt-in hint should not appear for an always-disallowed item
      expect(html).not.toContain('item-hint');
    });

    it('available items render with no special class', () => {
      const html = renderWithOpenSuggestions({
        defaultDenied: [],
        alwaysDisallowed: [],
      });
      expect(html).toContain('class="item"');
    });
  });

  describe('bare * in deny tier surfaces a warning', () => {
    function renderWithWildcardInDeny(
      section,
      alwaysDisallowed,
      defaultDenied,
    ) {
      return renderToString(
        dispatchSectionView({
          section,
          config: {
            always_disallowed: alwaysDisallowed,
            default_denied: defaultDenied,
            per_agent_allow: { _defaults: ['*'] },
          },
          knownItems: [],
          agentRoles: AGENT_ROLES,
          defaults: DISPATCH_DEFAULTS[section],
          onChange: vi.fn(),
        }),
      );
    }

    it('renders sl-alert with dispatch-wildcard-deny-warning class when * is in always_disallowed', () => {
      const html = renderWithWildcardInDeny('skills', ['*'], []);
      expect(html).toContain('dispatch-wildcard-deny-warning');
      expect(html).toContain('Always Disallowed');
    });

    it('renders the warning when * is in default_denied', () => {
      const html = renderWithWildcardInDeny('subagents', [], ['*']);
      expect(html).toContain('dispatch-wildcard-deny-warning');
      expect(html).toContain('Default Denied');
    });

    it('mentions both tiers when * is in both', () => {
      const html = renderWithWildcardInDeny('tools', ['*'], ['*']);
      expect(html).toContain('Always Disallowed');
      expect(html).toContain('Default Denied');
    });

    it('does NOT render the warning when no deny tier contains *', () => {
      const html = renderWithWildcardInDeny(
        'skills',
        ['worca-*', 'init'],
        ['review'],
      );
      expect(html).not.toContain('dispatch-wildcard-deny-warning');
    });
  });

  describe('per-section reset', () => {
    // Collect every function value (event handler) reachable in the template
    // tree so we can invoke the section-reset handler directly — renderToString
    // skips functions.
    function collectHandlers(template, out = []) {
      if (!template || !template.values) return out;
      for (const v of template.values) {
        if (typeof v === 'function') out.push(v);
        else if (Array.isArray(v)) {
          for (const item of v) collectHandlers(item, out);
        } else if (v?.strings) collectHandlers(v, out);
      }
      return out;
    }

    for (const section of ['tools', 'skills', 'subagents']) {
      it(`renders a per-section Reset button for ${section}`, () => {
        const html = renderToString(
          dispatchSectionView({
            section,
            config: {
              always_disallowed: [],
              default_denied: [],
              per_agent_allow: { _defaults: ['*'] },
            },
            knownItems: [],
            agentRoles: AGENT_ROLES,
            defaults: DISPATCH_DEFAULTS[section],
            onChange: vi.fn(),
          }),
        );
        expect(html).toContain('dispatch-section-reset');
        expect(html).toContain(`data-section="${section}"`);
      });
    }

    it('reset handler emits onChange with the reset section config', () => {
      const onChange = vi.fn();
      // A customized config (planner pinned) that differs from defaults.
      const config = {
        always_disallowed: ['general-purpose'],
        default_denied: [],
        per_agent_allow: { planner: ['Explore'], _defaults: ['*'] },
      };
      const template = dispatchSectionView({
        section: 'subagents',
        config,
        knownItems: KNOWN_SUBAGENTS,
        agentRoles: AGENT_ROLES,
        defaults: DISPATCH_DEFAULTS.subagents,
        onChange,
      });
      for (const fn of collectHandlers(template)) {
        try {
          fn();
        } catch {
          /* per-agent input handlers expect a DOM event — ignore */
        }
      }
      const expected = resetSectionConfig(config, DISPATCH_DEFAULTS.subagents);
      const resetCall = onChange.mock.calls.find(
        ([arg]) => JSON.stringify(arg) === JSON.stringify(expected),
      );
      expect(resetCall).toBeTruthy();
      // planner is reset away from the customization, back to the wildcard.
      expect(resetCall[0].per_agent_allow.planner).toEqual(['*']);
    });
  });

  describe('resetSectionConfig (deep-merge-safe reset)', () => {
    it('returns a deep copy of the defaults (no shared reference)', () => {
      const out = resetSectionConfig(
        { per_agent_allow: { _defaults: ['*'] } },
        DISPATCH_DEFAULTS.skills,
      );
      expect(out).not.toBe(DISPATCH_DEFAULTS.skills);
      expect(out.always_disallowed).toEqual(
        DISPATCH_DEFAULTS.skills.always_disallowed,
      );
    });

    it('overwrites a customized agent with its default value so save can clear it', () => {
      // subagents defaults have no per-agent entries → planner falls back to the
      // wildcard default rather than being silently dropped.
      const out = resetSectionConfig(
        { per_agent_allow: { planner: ['Explore', 'Plan'], _defaults: ['*'] } },
        DISPATCH_DEFAULTS.subagents,
      );
      expect(out.per_agent_allow.planner).toEqual(['*']);
    });

    it('restores a section-default agent value (skills implementer)', () => {
      const out = resetSectionConfig(
        {
          per_agent_allow: { implementer: ['custom-skill'], _defaults: ['*'] },
        },
        DISPATCH_DEFAULTS.skills,
      );
      expect(out.per_agent_allow.implementer).toEqual(
        DISPATCH_DEFAULTS.skills.per_agent_allow.implementer,
      );
    });
  });
});
