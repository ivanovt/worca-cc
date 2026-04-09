/**
 * Tests: run-detail.js pipeline_template display and formatPipelineTemplate helper.
 * TDD: written to drive implementation.
 */

import { describe, expect, it } from 'vitest';
import { formatPipelineTemplate, runDetailView } from './run-detail.js';

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
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

// ─── formatPipelineTemplate unit tests ──────────────────────────────────────

describe('formatPipelineTemplate', () => {
  it('returns null for null input', () => {
    expect(formatPipelineTemplate(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(formatPipelineTemplate(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(formatPipelineTemplate('')).toBeNull();
  });

  it('passes through worca:xxx values unchanged', () => {
    expect(formatPipelineTemplate('worca:default')).toBe('worca:default');
    expect(formatPipelineTemplate('worca:fast-track')).toBe('worca:fast-track');
  });

  it('converts builtin:xxx to worca:xxx', () => {
    expect(formatPipelineTemplate('builtin:default')).toBe('worca:default');
    expect(formatPipelineTemplate('builtin:fast-track')).toBe(
      'worca:fast-track',
    );
  });

  it('passes through project:xxx values unchanged', () => {
    expect(formatPipelineTemplate('project:my-template')).toBe(
      'project:my-template',
    );
  });

  it('passes through user:xxx values unchanged', () => {
    expect(formatPipelineTemplate('user:custom')).toBe('user:custom');
  });

  it('passes through plain strings without a prefix unchanged', () => {
    expect(formatPipelineTemplate('some-template')).toBe('some-template');
  });
});

// ─── runDetailView rendering tests ──────────────────────────────────────────

describe('runDetailView — pipeline_template display', () => {
  const baseRun = {
    stages: {
      implement: {
        status: 'completed',
        iterations: [{ number: 1, status: 'completed' }],
      },
    },
  };

  it('renders .run-template div when pipeline_template is set', () => {
    const run = { ...baseRun, pipeline_template: 'worca:default' };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('run-template');
    expect(html).toContain('Pipeline Template:');
    expect(html).toContain('worca:default');
  });

  it('does not render .run-template when pipeline_template is absent', () => {
    const html = renderToString(runDetailView(baseRun));
    expect(html).not.toContain('run-template');
  });

  it('does not render .run-template when pipeline_template is empty string', () => {
    const run = { ...baseRun, pipeline_template: '' };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('run-template');
  });

  it('uses meta-label and meta-value classes', () => {
    const run = { ...baseRun, pipeline_template: 'project:my-template' };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('meta-label');
    expect(html).toContain('meta-value');
    expect(html).toContain('project:my-template');
  });

  it('renders .run-template after .run-branch when both are present', () => {
    const run = {
      ...baseRun,
      branch: 'feature/my-branch',
      pipeline_template: 'worca:fast-track',
    };
    const html = renderToString(runDetailView(run));
    const branchIdx = html.indexOf('run-branch');
    const templateIdx = html.indexOf('run-template');
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(templateIdx).toBeGreaterThan(branchIdx);
  });

  it('converts builtin:xxx to worca:xxx in display', () => {
    const run = { ...baseRun, pipeline_template: 'builtin:default' };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('worca:default');
    expect(html).not.toContain('builtin:default');
  });
});

// ─── run-card pipeline_template badge tests ─────────────────────────────────

import { runCardView } from './run-card.js';

describe('runCardView — pipeline_template badge', () => {
  const baseRun = {
    work_request: { title: 'Test run' },
    stages: {},
    started_at: '2024-01-01T00:00:00Z',
  };

  it('shows pipeline_template badge when set', () => {
    const run = { ...baseRun, pipeline_template: 'worca:fast-track' };
    const html = renderToString(runCardView(run));
    expect(html).toContain('worca:fast-track');
  });

  it('does not show template badge when pipeline_template is absent', () => {
    const html = renderToString(runCardView(baseRun));
    expect(html).not.toContain('run-card-template');
  });
});
