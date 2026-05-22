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

describe('graphifyBadgeState', () => {
  it('returns "disabled" when effective.enabled is false', async () => {
    const { graphifyBadgeState } = await import('./project-badge.js');
    const status = {
      effective: { enabled: false, reason: 'global-off' },
      detection: {
        installed: false,
        version: null,
        compatible: false,
        error: null,
      },
      graph_stats: null,
    };
    expect(graphifyBadgeState(status)).toBe('disabled');
  });

  it('returns "pending-install" when enabled but not installed', async () => {
    const { graphifyBadgeState } = await import('./project-badge.js');
    const status = {
      effective: { enabled: true, mode: 'structural', reason: null },
      detection: {
        installed: false,
        version: null,
        compatible: false,
        error: null,
      },
      graph_stats: null,
    };
    expect(graphifyBadgeState(status)).toBe('pending-install');
  });

  it('returns "version-mismatch" when installed but not compatible', async () => {
    const { graphifyBadgeState } = await import('./project-badge.js');
    const status = {
      effective: { enabled: true, mode: 'structural', reason: null },
      detection: {
        installed: true,
        version: '3.0.0',
        compatible: false,
        error: null,
      },
      graph_stats: null,
    };
    expect(graphifyBadgeState(status)).toBe('version-mismatch');
  });

  it('returns "degraded" when compatible but detection has an error', async () => {
    const { graphifyBadgeState } = await import('./project-badge.js');
    const status = {
      effective: { enabled: true, mode: 'structural', reason: null },
      detection: {
        installed: true,
        version: '4.2.0',
        compatible: true,
        error: 'hook not found',
      },
      graph_stats: null,
    };
    expect(graphifyBadgeState(status)).toBe('degraded');
  });

  it('returns "ready" when enabled, installed, compatible, no error', async () => {
    const { graphifyBadgeState } = await import('./project-badge.js');
    const status = {
      effective: { enabled: true, mode: 'structural', reason: null },
      detection: {
        installed: true,
        version: '4.2.0',
        compatible: true,
        error: null,
      },
      graph_stats: {
        report_path: '/tmp/GRAPH_REPORT.md',
        age_seconds: 100,
        size_bytes: 5000,
        has_html: true,
      },
    };
    expect(graphifyBadgeState(status)).toBe('ready');
  });
});

describe('GRAPHIFY_BADGE_VARIANT', () => {
  it('maps ready to success', async () => {
    const { GRAPHIFY_BADGE_VARIANT } = await import('./project-badge.js');
    expect(GRAPHIFY_BADGE_VARIANT.ready).toBe('success');
  });

  it('maps disabled to neutral', async () => {
    const { GRAPHIFY_BADGE_VARIANT } = await import('./project-badge.js');
    expect(GRAPHIFY_BADGE_VARIANT.disabled).toBe('neutral');
  });

  it('maps pending-install to warning', async () => {
    const { GRAPHIFY_BADGE_VARIANT } = await import('./project-badge.js');
    expect(GRAPHIFY_BADGE_VARIANT['pending-install']).toBe('warning');
  });

  it('maps version-mismatch to danger', async () => {
    const { GRAPHIFY_BADGE_VARIANT } = await import('./project-badge.js');
    expect(GRAPHIFY_BADGE_VARIANT['version-mismatch']).toBe('danger');
  });

  it('maps degraded to warning', async () => {
    const { GRAPHIFY_BADGE_VARIANT } = await import('./project-badge.js');
    expect(GRAPHIFY_BADGE_VARIANT.degraded).toBe('warning');
  });
});

describe('graphifyBadgeLabel', () => {
  it('returns human-readable label for each state', async () => {
    const { GRAPHIFY_BADGE_LABEL } = await import('./project-badge.js');
    expect(GRAPHIFY_BADGE_LABEL.ready).toBe('Ready');
    expect(GRAPHIFY_BADGE_LABEL.disabled).toBe('Disabled');
    expect(GRAPHIFY_BADGE_LABEL['pending-install']).toBe('Pending install');
    expect(GRAPHIFY_BADGE_LABEL['version-mismatch']).toBe('Version mismatch');
    expect(GRAPHIFY_BADGE_LABEL.degraded).toBe('Degraded');
  });
});

describe('graphifyBadgeView rendering', () => {
  it('renders badge with correct variant for ready state', async () => {
    const { graphifyBadgeView } = await import('./project-badge.js');
    const status = {
      effective: { enabled: true, mode: 'structural', reason: null },
      detection: {
        installed: true,
        version: '4.2.0',
        compatible: true,
        error: null,
      },
      graph_stats: {
        report_path: '/tmp/GRAPH_REPORT.md',
        age_seconds: 100,
        size_bytes: 5000,
        has_html: true,
      },
    };
    const html = renderToString(graphifyBadgeView(status));
    expect(html).toContain('variant="success"');
    expect(html).toContain('Ready');
    expect(html).toContain('graphify-badge');
  });

  it('renders badge with neutral variant for disabled state', async () => {
    const { graphifyBadgeView } = await import('./project-badge.js');
    const status = {
      effective: { enabled: false, reason: 'global-off' },
      detection: {
        installed: false,
        version: null,
        compatible: false,
        error: null,
      },
      graph_stats: null,
    };
    const html = renderToString(graphifyBadgeView(status));
    expect(html).toContain('variant="neutral"');
    expect(html).toContain('Disabled');
  });

  it('renders badge with warning variant for pending-install', async () => {
    const { graphifyBadgeView } = await import('./project-badge.js');
    const status = {
      effective: { enabled: true, mode: 'structural', reason: null },
      detection: {
        installed: false,
        version: null,
        compatible: false,
        error: null,
      },
      graph_stats: null,
    };
    const html = renderToString(graphifyBadgeView(status));
    expect(html).toContain('variant="warning"');
    expect(html).toContain('Pending install');
  });

  it('renders badge with danger variant for version-mismatch', async () => {
    const { graphifyBadgeView } = await import('./project-badge.js');
    const status = {
      effective: { enabled: true, mode: 'structural', reason: null },
      detection: {
        installed: true,
        version: '3.0.0',
        compatible: false,
        error: null,
      },
      graph_stats: null,
    };
    const html = renderToString(graphifyBadgeView(status));
    expect(html).toContain('variant="danger"');
    expect(html).toContain('Version mismatch');
  });

  it('includes tooltip with effective state breakdown', async () => {
    const { graphifyBadgeView } = await import('./project-badge.js');
    const status = {
      effective: { enabled: true, mode: 'full', reason: null },
      detection: {
        installed: true,
        version: '4.2.0',
        compatible: true,
        error: null,
      },
      graph_stats: {
        report_path: '/tmp/GRAPH_REPORT.md',
        age_seconds: 3600,
        size_bytes: 5000,
        has_html: true,
      },
    };
    const html = renderToString(graphifyBadgeView(status));
    expect(html).toContain('title=');
    expect(html).toContain('Mode: full');
    expect(html).toContain('v4.2.0');
  });

  it('returns nothing when status is null', async () => {
    const { graphifyBadgeView } = await import('./project-badge.js');
    const { nothing } = await import('lit-html');
    const result = graphifyBadgeView(null);
    expect(result).toBe(nothing);
  });
});
