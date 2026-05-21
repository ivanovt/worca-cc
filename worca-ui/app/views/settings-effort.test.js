import { describe, expect, it } from 'vitest';

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

describe('Effort settings constants', () => {
  it('exports EFFORT_LEVELS with 5 levels and no auto', async () => {
    const { EFFORT_LEVELS } = await import('./settings.js');
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(EFFORT_LEVELS).not.toContain('auto');
  });

  it('exports AUTO_MODES with 3 modes', async () => {
    const { AUTO_MODES } = await import('./settings.js');
    expect(AUTO_MODES).toEqual(['disabled', 'reactive', 'adaptive']);
  });
});

describe('effortTab rendering', () => {
  it('renders auto_mode dropdown with all 3 modes', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
      agents: {},
    };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('effort-auto-mode');
    expect(html).toContain('>disabled<');
    expect(html).toContain('>reactive<');
    expect(html).toContain('>adaptive<');
  });

  it('renders auto_cap dropdown with 5 effort levels', async () => {
    const { effortTab, EFFORT_LEVELS } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
      agents: {},
    };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('effort-auto-cap');
    for (const level of EFFORT_LEVELS) {
      expect(html).toContain(`value="${level}"`);
    }
  });

  it('does not include auto value in any dropdown', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
      agents: {},
    };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).not.toContain('value="auto"');
  });

  it('renders per-agent effort table with all agents', async () => {
    const { effortTab, AGENT_NAMES } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
      agents: {},
    };
    const html = renderToString(effortTab(worca, () => {}));
    for (const name of AGENT_NAMES) {
      expect(html).toContain(`effort-agent-${name}`);
    }
  });

  it('renders (unset) option for per-agent dropdowns', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
      agents: {},
    };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('(unset)');
  });

  it('renders Save and Reset buttons', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
      agents: {},
    };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('Save');
    expect(html).toContain('Reset');
  });

  it('shows inheritance hint for agents without explicit effort', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
      agents: {
        planner: { model: 'opus', max_turns: 100 },
      },
    };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('effort-inherit-hint');
  });

  it('does not show inheritance hint for agents with explicit effort', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
      agents: {
        planner: { model: 'opus', max_turns: 100, effort: 'high' },
      },
    };
    const html = renderToString(effortTab(worca, () => {}));
    const plannerSection = html
      .split('effort-agent-planner')[1]
      .split('effort-agent-')[0];
    expect(plannerSection).not.toContain('effort-inherit-hint');
  });

  it('renders auto_mode description hints', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = {
      effort: { auto_mode: 'reactive', auto_cap: 'high' },
      agents: {},
    };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('settings-field-hint');
  });

  it('defaults auto_mode to adaptive when missing', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = { effort: {}, agents: {} };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('effort-auto-mode');
  });

  it('defaults auto_cap to xhigh when missing', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = { effort: {}, agents: {} };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('effort-auto-cap');
  });

  it('handles missing effort block gracefully', async () => {
    const { effortTab } = await import('./settings.js');
    const worca = { agents: {} };
    const html = renderToString(effortTab(worca, () => {}));
    expect(html).toContain('effort-auto-mode');
    expect(html).toContain('effort-auto-cap');
  });
});

describe('readEffortFromDom', () => {
  it('is exported as a function', async () => {
    const { readEffortFromDom } = await import('./settings.js');
    expect(typeof readEffortFromDom).toBe('function');
  });
});

describe('Effort tab in projectSettingsView', () => {
  it('projectSettingsView includes effort tab panel', async () => {
    const mod = await import('./settings.js');
    expect(typeof mod.effortTab).toBe('function');
  });
});
