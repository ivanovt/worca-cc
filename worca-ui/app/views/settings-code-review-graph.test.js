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

describe('CRG_STATES', () => {
  it('exports Off and Structural (no full — structural only in v1)', async () => {
    const { CRG_STATES } = await import('./settings-code-review-graph.js');
    expect(CRG_STATES).toEqual(['off', 'structural']);
  });
});

describe('crgStateValue', () => {
  it('maps enabled/disabled onto the 2-way control value', async () => {
    const { crgStateValue } = await import('./settings-code-review-graph.js');
    expect(crgStateValue({ enabled: false })).toBe('off');
    expect(crgStateValue({})).toBe('off');
    expect(crgStateValue({ enabled: true })).toBe('structural');
  });
});

describe('isCrgUnavailable', () => {
  it('treats null detection (not fetched yet) as available', async () => {
    const { isCrgUnavailable } = await import(
      './settings-code-review-graph.js'
    );
    expect(isCrgUnavailable(null)).toBe(false);
    expect(isCrgUnavailable(undefined)).toBe(false);
  });

  it('is unavailable when not installed', async () => {
    const { isCrgUnavailable } = await import(
      './settings-code-review-graph.js'
    );
    expect(
      isCrgUnavailable({
        installed: false,
        compatible: false,
        fastmcp_ok: false,
      }),
    ).toBe(true);
  });

  it('is unavailable when installed but version-incompatible', async () => {
    const { isCrgUnavailable } = await import(
      './settings-code-review-graph.js'
    );
    expect(
      isCrgUnavailable({
        installed: true,
        compatible: false,
        fastmcp_ok: true,
      }),
    ).toBe(true);
  });

  it('is unavailable when installed and compatible but fastmcp missing', async () => {
    const { isCrgUnavailable } = await import(
      './settings-code-review-graph.js'
    );
    expect(
      isCrgUnavailable({
        installed: true,
        compatible: true,
        fastmcp_ok: false,
      }),
    ).toBe(true);
  });

  it('is available only when installed AND compatible AND fastmcp_ok', async () => {
    const { isCrgUnavailable } = await import(
      './settings-code-review-graph.js'
    );
    expect(
      isCrgUnavailable({
        installed: true,
        compatible: true,
        fastmcp_ok: true,
      }),
    ).toBe(false);
  });
});

describe('crgInstallCommand', () => {
  it('suggests pip install code-review-graph with version range', async () => {
    const { crgInstallCommand, CRG_VERSION_RANGE_DEFAULT } = await import(
      './settings-code-review-graph.js'
    );
    expect(crgInstallCommand()).toBe(
      `pip install 'code-review-graph${CRG_VERSION_RANGE_DEFAULT}'`,
    );
  });

  it('accepts a custom version range', async () => {
    const { crgInstallCommand } = await import(
      './settings-code-review-graph.js'
    );
    expect(crgInstallCommand('>=3,<4')).toBe(
      "pip install 'code-review-graph>=3,<4'",
    );
  });

  it('falls back to the default for empty/nullish ranges', async () => {
    const { crgInstallCommand } = await import(
      './settings-code-review-graph.js'
    );
    expect(crgInstallCommand('')).toBe("pip install 'code-review-graph>=2,<3'");
    expect(crgInstallCommand(null)).toBe(
      "pip install 'code-review-graph>=2,<3'",
    );
  });
});

describe('crgTab rendering', () => {
  it('renders Off/Structural status control', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const worca = { code_review_graph: { enabled: false } };
    const html = renderToString(crgTab(worca, () => {}));
    expect(html).toContain('crg-state');
    expect(html).toContain('Off');
    expect(html).toContain('Structural');
  });

  it('reflects the persisted state in the control value', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const off = renderToString(
      crgTab({ code_review_graph: { enabled: false } }, () => {}),
    );
    expect(off).toContain('value="off"');
    const on = renderToString(
      crgTab({ code_review_graph: { enabled: true } }, () => {}),
    );
    expect(on).toContain('value="structural"');
  });

  it('renders embeddings toggle disabled with coming-soon hint in v1', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const worca = { code_review_graph: { enabled: true } };
    const html = renderToString(crgTab(worca, () => {}));
    expect(html).toContain('crg-embeddings');
    expect(html).toContain('coming soon');
  });

  it('renders Save and Reset buttons', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const worca = { code_review_graph: { enabled: true } };
    const html = renderToString(crgTab(worca, () => {}));
    expect(html).toContain('Save');
    expect(html).toContain('Reset');
  });

  it('shows disabled hint when off', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const worca = { code_review_graph: { enabled: false } };
    const html = renderToString(crgTab(worca, () => {}));
    expect(html).toContain('crg-disabled-hint');
  });

  it('renders Build/Clear cache actions when enabled', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const worca = { code_review_graph: { enabled: true } };
    const html = renderToString(crgTab(worca, () => {}));
    expect(html).toContain('crg-cache-actions');
    expect(html).toContain('crg-build-btn');
    expect(html).toContain('crg-clear-btn');
    expect(html).toContain('Build / refresh graph');
    expect(html).toContain('Clear cache');
    expect(html).toContain('Cache location');
    expect(html).toContain('crg-cache-path');
    expect(html).toContain('sl-copy-button');
    expect(html).toContain('crg-copy-path-btn');
  });

  it('hides cache actions when off', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const worca = { code_review_graph: { enabled: false } };
    const html = renderToString(crgTab(worca, () => {}));
    expect(html).not.toContain('crg-cache-actions');
    expect(html).not.toContain('crg-build-btn');
  });

  it('renders per-stage MCP tools info box when enabled', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const worca = { code_review_graph: { enabled: true } };
    const html = renderToString(crgTab(worca, () => {}));
    expect(html).toContain('crg-stage-tools');
    expect(html).toContain('planner');
    expect(html).toContain('implementer');
    expect(html).toContain('reviewer');
  });

  it('hides stage tools info when off', async () => {
    const { crgTab } = await import('./settings-code-review-graph.js');
    const worca = { code_review_graph: { enabled: false } };
    const html = renderToString(crgTab(worca, () => {}));
    expect(html).not.toContain('crg-stage-tools');
  });
});

describe('DEFAULT_STAGE_TOOLS', () => {
  it('lists read-only tools per stage', async () => {
    const { DEFAULT_STAGE_TOOLS } = await import(
      './settings-code-review-graph.js'
    );
    expect(Object.keys(DEFAULT_STAGE_TOOLS)).toContain('planner');
    expect(Object.keys(DEFAULT_STAGE_TOOLS)).toContain('implementer');
    expect(Object.keys(DEFAULT_STAGE_TOOLS)).toContain('reviewer');
    expect(Object.keys(DEFAULT_STAGE_TOOLS)).toContain('tester');
    expect(Object.keys(DEFAULT_STAGE_TOOLS)).toContain('guardian');
    for (const tools of Object.values(DEFAULT_STAGE_TOOLS)) {
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    }
  });
});
