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
      else if (typeof v === 'number') result += String(v);
      else if (typeof v === 'boolean') result += '';
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

describe('graphifyTab rendering', () => {
  it('renders enabled toggle', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: false } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('graphify-enabled');
    expect(html).toContain('sl-switch');
  });

  it('renders mode radio group with structural and full options', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: true, mode: 'structural' } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('graphify-mode');
    expect(html).toContain('structural');
    expect(html).toContain('full');
  });

  it('renders backend dropdown', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = {
      graphify: { enabled: true, mode: 'structural' },
      models: { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6' },
    };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('graphify-backend');
  });

  it('shows full-mode privacy text when mode is full', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: true, mode: 'full' } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('graphify-privacy-notice');
    expect(html).toContain('sends document and diagram summaries');
    expect(html).toContain('graphify-privacy-expanded');
  });

  it('shows structural-mode privacy text when mode is structural', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: true, mode: 'structural' } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('graphify-privacy-notice');
    expect(html).toContain('fully local');
    expect(html).not.toContain('graphify-privacy-expanded');
  });

  it('renders Save and Reset buttons', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: true, mode: 'structural' } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('Save');
    expect(html).toContain('Reset');
  });

  it('disables mode and backend when graphify is disabled', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: false } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('graphify-mode');
    expect(html).toContain('graphify-backend');
  });
});

describe('graphifyTab constants', () => {
  it('exports GRAPHIFY_MODES', async () => {
    const { GRAPHIFY_MODES } = await import('./settings-graphify.js');
    expect(GRAPHIFY_MODES).toEqual(['structural', 'full']);
  });
});
