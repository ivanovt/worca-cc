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

  describe('governanceTab renders three section cards', () => {
    it('renders Tools section', async () => {
      const { governanceTab } = await import('./settings.js');
      const worca = {
        governance: {
          guards: {},
          test_gate_strikes: 2,
          dispatch: { ...DISPATCH_DEFAULTS },
        },
      };
      const html = renderToString(governanceTab(worca, { allow: [] }, vi.fn()));
      expect(html).toContain('Tools');
    });

    it('renders Skills section', async () => {
      const { governanceTab } = await import('./settings.js');
      const worca = {
        governance: {
          guards: {},
          test_gate_strikes: 2,
          dispatch: { ...DISPATCH_DEFAULTS },
        },
      };
      const html = renderToString(governanceTab(worca, { allow: [] }, vi.fn()));
      expect(html).toContain('Skills');
    });

    it('renders Subagents section', async () => {
      const { governanceTab } = await import('./settings.js');
      const worca = {
        governance: {
          guards: {},
          test_gate_strikes: 2,
          dispatch: { ...DISPATCH_DEFAULTS },
        },
      };
      const html = renderToString(governanceTab(worca, { allow: [] }, vi.fn()));
      expect(html).toContain('Subagents');
    });

    it('renders all three dispatch-section components', async () => {
      const { governanceTab } = await import('./settings.js');
      const worca = {
        governance: {
          guards: {},
          test_gate_strikes: 2,
          dispatch: { ...DISPATCH_DEFAULTS },
        },
      };
      const html = renderToString(governanceTab(worca, { allow: [] }, vi.fn()));
      // Each section is wrapped in an sl-details with data-section. The
      // inner h4.dispatch-section-title is suppressed when nested in
      // dispatch-section-details (showTitle=false), so count the wrappers.
      const sectionCount = (
        html.match(/data-section="(tools|skills|subagents)"/g) || []
      ).length;
      expect(sectionCount).toBeGreaterThanOrEqual(3);
    });

    it('renders each dispatch section inside a collapsible sl-details', async () => {
      const { governanceTab } = await import('./settings.js');
      const worca = {
        governance: {
          guards: {},
          test_gate_strikes: 2,
          dispatch: { ...DISPATCH_DEFAULTS },
        },
      };
      const html = renderToString(governanceTab(worca, { allow: [] }, vi.fn()));
      for (const section of ['tools', 'skills', 'subagents']) {
        // The sl-details wrapper carries data-section so the e2e tests can
        // target it. We just verify it's rendered (collapsed-by-default
        // behavior is asserted in the e2e suite).
        expect(html).toContain(`data-section="${section}"`);
      }
      expect(html).toContain('dispatch-section-details');
    });
  });
});
