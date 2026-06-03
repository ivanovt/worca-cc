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

  it('passes through builtin:xxx values unchanged (canonical)', () => {
    expect(formatPipelineTemplate('builtin:default')).toBe('builtin:default');
    expect(formatPipelineTemplate('builtin:fast-track')).toBe(
      'builtin:fast-track',
    );
  });

  it('converts legacy worca:xxx to builtin:xxx', () => {
    expect(formatPipelineTemplate('worca:default')).toBe('builtin:default');
    expect(formatPipelineTemplate('worca:fast-track')).toBe(
      'builtin:fast-track',
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
    const run = { ...baseRun, pipeline_template: 'builtin:default' };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('run-template');
    expect(html).toContain('Pipeline Template:');
    expect(html).toContain('builtin:default');
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
      pipeline_template: 'builtin:fast-track',
    };
    const html = renderToString(runDetailView(run));
    const branchIdx = html.indexOf('run-branch');
    const templateIdx = html.indexOf('run-template');
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(templateIdx).toBeGreaterThan(branchIdx);
  });

  it('converts legacy worca:xxx to builtin:xxx in display', () => {
    // Old `status.json` files (pre-rename) still say "worca:" on disk;
    // the UI should translate those for display so the run card matches
    // the page's tier vocabulary.
    const run = { ...baseRun, pipeline_template: 'worca:default' };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('builtin:default');
    expect(html).not.toContain('worca:default');
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

  it('shows pipeline_template badge when set (builtin: prefix verbatim)', () => {
    const run = { ...baseRun, pipeline_template: 'builtin:fast-track' };
    const html = renderToString(runCardView(run));
    expect(html).toContain('builtin:fast-track');
  });

  it('translates legacy worca: prefix to builtin: on the card', () => {
    // Older runs on disk still say "worca:" — UI normalizes for display.
    const run = { ...baseRun, pipeline_template: 'worca:fast-track' };
    const html = renderToString(runCardView(run));
    expect(html).toContain('builtin:fast-track');
    expect(html).not.toContain('worca:fast-track');
  });

  it('does not show template badge when pipeline_template is absent', () => {
    const html = renderToString(runCardView(baseRun));
    expect(html).not.toContain('run-card-template');
  });
});
