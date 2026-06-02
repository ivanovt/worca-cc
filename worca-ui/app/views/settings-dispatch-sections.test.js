import { describe, expect, it, vi } from 'vitest';
import { DISPATCH_DEFAULTS } from '../../server/dispatch-defaults.js';

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

describe('settings.js dispatch sections (W-054)', () => {
  describe('AGENT_NAMES', () => {
    it('includes workspace_planner', async () => {
      const { AGENT_NAMES } = await import('./settings.js');
      expect(AGENT_NAMES).toContain('workspace_planner');
    });

    it('has nine agents total', async () => {
      const { AGENT_NAMES } = await import('./settings.js');
      expect(AGENT_NAMES).toHaveLength(9);
    });
  });

  describe('DEFAULT_GOVERNANCE', () => {
    it('has dispatch.tools section', async () => {
      const { DEFAULT_GOVERNANCE } = await import('./settings.js');
      expect(DEFAULT_GOVERNANCE.dispatch.tools).toBeDefined();
      expect(
        DEFAULT_GOVERNANCE.dispatch.tools.always_disallowed,
      ).toBeInstanceOf(Array);
      expect(DEFAULT_GOVERNANCE.dispatch.tools.per_agent_allow).toBeDefined();
    });

    it('has dispatch.skills section', async () => {
      const { DEFAULT_GOVERNANCE } = await import('./settings.js');
      expect(DEFAULT_GOVERNANCE.dispatch.skills).toBeDefined();
      expect(
        DEFAULT_GOVERNANCE.dispatch.skills.always_disallowed,
      ).toBeInstanceOf(Array);
      expect(DEFAULT_GOVERNANCE.dispatch.skills.default_denied).toBeInstanceOf(
        Array,
      );
    });

    it('has dispatch.subagents section', async () => {
      const { DEFAULT_GOVERNANCE } = await import('./settings.js');
      expect(DEFAULT_GOVERNANCE.dispatch.subagents).toBeDefined();
      expect(
        DEFAULT_GOVERNANCE.dispatch.subagents.always_disallowed,
      ).toBeInstanceOf(Array);
    });

    it('does not have flat subagent_dispatch key', async () => {
      const { DEFAULT_GOVERNANCE } = await import('./settings.js');
      expect(DEFAULT_GOVERNANCE.subagent_dispatch).toBeUndefined();
    });

    it('dispatch sections match DISPATCH_DEFAULTS', async () => {
      const { DEFAULT_GOVERNANCE } = await import('./settings.js');
      expect(DEFAULT_GOVERNANCE.dispatch.tools).toEqual(
        DISPATCH_DEFAULTS.tools,
      );
      expect(DEFAULT_GOVERNANCE.dispatch.skills).toEqual(
        DISPATCH_DEFAULTS.skills,
      );
      expect(DEFAULT_GOVERNANCE.dispatch.subagents).toEqual(
        DISPATCH_DEFAULTS.subagents,
      );
    });
  });

  describe('governanceTab — dispatch sections moved to templates', () => {
    // After the W-062 Phase 6 option-B cleanup, governance.dispatch is
    // template-driven, so the project-Settings Governance tab no longer
    // renders the per-section editors. Instead it shows a deep-link to
    // the Templates page. These tests lock in that contract so we don't
    // accidentally re-introduce the dispatch UI in project settings.
    async function renderTab() {
      const { governanceTab } = await import('./settings.js');
      const worca = {
        governance: {
          guards: {},
          test_gate_strikes: 2,
          dispatch: { ...DISPATCH_DEFAULTS },
        },
      };
      return renderToString(governanceTab(worca, { allow: [] }, vi.fn()));
    }

    it('does not render per-section dispatch editors', async () => {
      const html = await renderTab();
      for (const section of ['tools', 'skills', 'subagents']) {
        expect(html).not.toContain(`data-section="${section}"`);
      }
      expect(html).not.toContain('dispatch-section-details');
    });

    it('renders a deep-link to the Templates page in place of the dispatch UI', async () => {
      const html = await renderTab();
      expect(html).toContain('pipelines-deep-link-card');
      expect(html).toContain('href="#/templates"');
      expect(html).toMatch(/[Dd]ispatch rules/);
    });
  });

  describe('effortTab section layout', () => {
    it('renders Effort Mode section title', async () => {
      const { effortTab } = await import('./settings.js');
      const worca = {
        effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
        agents: {},
      };
      const html = renderToString(effortTab(worca, vi.fn()));
      expect(html).toContain('Effort Mode');
    });

    it('renders Per-Agent Effort section title', async () => {
      const { effortTab } = await import('./settings.js');
      const worca = {
        effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
        agents: {},
      };
      const html = renderToString(effortTab(worca, vi.fn()));
      expect(html).toContain('Per-Agent Effort');
    });

    it('renders auto_mode and auto_cap controls with correct IDs', async () => {
      const { effortTab } = await import('./settings.js');
      const worca = {
        effort: { auto_mode: 'reactive', auto_cap: 'high' },
        agents: {},
      };
      const html = renderToString(effortTab(worca, vi.fn()));
      expect(html).toContain('effort-auto-mode');
      expect(html).toContain('effort-auto-cap');
    });

    it('renders per-agent effort selects for all agents', async () => {
      const { effortTab, AGENT_NAMES } = await import('./settings.js');
      const worca = {
        effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
        agents: {},
      };
      const html = renderToString(effortTab(worca, vi.fn()));
      for (const name of AGENT_NAMES) {
        expect(html).toContain(`effort-agent-${name}`);
      }
    });

    it('wraps content in settings-tab-content', async () => {
      const { effortTab } = await import('./settings.js');
      const worca = { effort: {}, agents: {} };
      const html = renderToString(effortTab(worca, vi.fn()));
      expect(html).toContain('settings-tab-content');
    });
  });
});
