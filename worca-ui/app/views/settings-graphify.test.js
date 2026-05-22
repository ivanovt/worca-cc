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
  it('renders a single off/structural/full state control', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: false } };
    const html = renderToString(graphifyTab(worca, () => {}));
    // One combined control replaces the former switch + mode radios.
    expect(html).toContain('graphify-state');
    expect(html).not.toContain('graphify-enabled');
    expect(html).not.toContain('sl-switch');
    expect(html).toContain('Off');
    expect(html).toContain('Structural');
    expect(html).toContain('Full');
  });

  it('reflects the persisted state in the control value', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const off = renderToString(
      graphifyTab({ graphify: { enabled: false } }, () => {}),
    );
    expect(off).toContain('value="off"');
    const structural = renderToString(
      graphifyTab(
        { graphify: { enabled: true, mode: 'structural' } },
        () => {},
      ),
    );
    expect(structural).toContain('value="structural"');
    const full = renderToString(
      graphifyTab({ graphify: { enabled: true, mode: 'full' } }, () => {}),
    );
    expect(full).toContain('value="full"');
  });

  it('renders model profile dropdown in full mode', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = {
      graphify: { enabled: true, mode: 'full' },
      models: { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6' },
    };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('graphify-model-profile');
  });

  it('hides model profile in structural mode (LLM-only setting)', async () => {
    // Structural mode runs graphify with --no-llm, so the model profile is
    // inert there — the control must not render.
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = {
      graphify: { enabled: true, mode: 'structural' },
      models: { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6' },
    };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).not.toContain('graphify-model-profile');
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

  it('hides model profile and privacy notice when off', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: false } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).not.toContain('graphify-model-profile');
    expect(html).not.toContain('graphify-privacy-notice');
    expect(html).toContain('graphify-disabled-hint');
  });

  it('renders Build/Clear cache actions when enabled', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: true, mode: 'structural' } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).toContain('graphify-cache-actions');
    expect(html).toContain('graphify-build-btn');
    expect(html).toContain('graphify-clear-btn');
    expect(html).toContain('Build / refresh graph');
    expect(html).toContain('Clear cache');
    // Selectable cache-location path field.
    expect(html).toContain('Cache location');
    expect(html).toContain('graphify-cache-path');
  });

  it('hides cache actions when off', async () => {
    const { graphifyTab } = await import('./settings-graphify.js');
    const worca = { graphify: { enabled: false } };
    const html = renderToString(graphifyTab(worca, () => {}));
    expect(html).not.toContain('graphify-cache-actions');
    expect(html).not.toContain('graphify-build-btn');
  });
});

describe('graphifyStateValue', () => {
  it('maps enabled/mode onto the 3-way control value', async () => {
    const { graphifyStateValue } = await import('./settings-graphify.js');
    expect(graphifyStateValue({ enabled: false })).toBe('off');
    expect(graphifyStateValue({})).toBe('off');
    expect(graphifyStateValue({ enabled: true, mode: 'structural' })).toBe(
      'structural',
    );
    expect(graphifyStateValue({ enabled: true, mode: 'full' })).toBe('full');
    // enabled with no mode defaults to structural
    expect(graphifyStateValue({ enabled: true })).toBe('structural');
  });
});

describe('graphifyTab constants', () => {
  it('exports GRAPHIFY_MODES', async () => {
    const { GRAPHIFY_MODES } = await import('./settings-graphify.js');
    expect(GRAPHIFY_MODES).toEqual(['structural', 'full']);
  });

  it('exports GRAPHIFY_STATES', async () => {
    const { GRAPHIFY_STATES } = await import('./settings-graphify.js');
    expect(GRAPHIFY_STATES).toEqual(['off', 'structural', 'full']);
  });
});
