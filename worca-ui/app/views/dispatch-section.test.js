import { describe, expect, it, vi } from 'vitest';
import { DISPATCH_DEFAULTS } from '../../server/dispatch-defaults.js';
import { dispatchSectionView } from './dispatch-section.js';

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
});
