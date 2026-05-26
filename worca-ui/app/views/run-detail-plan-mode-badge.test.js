import { describe, expect, it } from 'vitest';
import { runDetailView } from './run-detail.js';

function renderToString(template) {
  if (!template) return '';
  if (template.overview)
    return renderToString(template.overview) + renderToString(template.stages);
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (typeof v === 'number') result += String(v);
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

const baseRun = {
  stages: {
    implement: {
      status: 'completed',
      iterations: [{ number: 1, status: 'completed' }],
    },
  },
};

describe('runDetailView — planning mode badge', () => {
  it('shows Planning badge with plan_mode from manifest for workspace runs', () => {
    const run = {
      ...baseRun,
      workspace_id: 'ws-123',
      group_type: 'workspace',
      manifest: { plan_mode: 'independent' },
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('plan-mode-badge');
    expect(html).toContain('Planning:');
    expect(html).toContain('independent');
  });

  it('defaults to master when manifest.plan_mode is absent', () => {
    const run = {
      ...baseRun,
      workspace_id: 'ws-456',
      group_type: 'workspace',
      manifest: {},
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('plan-mode-badge');
    expect(html).toContain('Planning:');
    expect(html).toContain('master');
  });

  it('defaults to master when manifest is absent', () => {
    const run = {
      ...baseRun,
      workspace_id: 'ws-789',
      group_type: 'workspace',
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('plan-mode-badge');
    expect(html).toContain('Planning:');
    expect(html).toContain('master');
  });

  it('does not show plan-mode-badge for non-workspace runs', () => {
    const html = renderToString(runDetailView(baseRun));
    expect(html).not.toContain('plan-mode-badge');
  });

  it('does not show plan-mode-badge for fleet runs', () => {
    const run = {
      ...baseRun,
      fleet_id: 'fleet-1',
      group_type: 'fleet',
    };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('plan-mode-badge');
  });

  it('shows existing plan_mode', () => {
    const run = {
      ...baseRun,
      workspace_id: 'ws-existing',
      group_type: 'workspace',
      manifest: { plan_mode: 'existing' },
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('existing');
  });

  it('shows per-repo plan_mode', () => {
    const run = {
      ...baseRun,
      workspace_id: 'ws-perrepo',
      group_type: 'workspace',
      manifest: { plan_mode: 'per-repo' },
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('per-repo');
  });

  it('renders the badge near the workspace header', () => {
    const run = {
      ...baseRun,
      workspace_id: 'ws-order',
      group_type: 'workspace',
      manifest: { plan_mode: 'independent' },
    };
    const html = renderToString(runDetailView(run));
    const wsIdx = html.indexOf('workspace-runs/ws-order');
    const badgeIdx = html.indexOf('plan-mode-badge');
    expect(wsIdx).toBeGreaterThanOrEqual(0);
    expect(badgeIdx).toBeGreaterThan(wsIdx);
  });
});
