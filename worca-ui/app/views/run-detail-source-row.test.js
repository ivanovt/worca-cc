/**
 * Tests: run-detail.js Source row (source_type + source_ref in overview).
 * TDD: written to drive implementation.
 */

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

describe('runDetailView — Source row', () => {
  it('renders source row when source_type is set', () => {
    const run = {
      ...baseRun,
      source_type: 'github_pr',
      source_ref: 'gh:pr:99',
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('run-source');
    expect(html).toContain('Source:');
  });

  it('renders source_type value in source row', () => {
    const run = {
      ...baseRun,
      source_type: 'github_pr',
      source_ref: 'gh:pr:99',
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('github_pr');
  });

  it('renders source_ref value in source row when present', () => {
    const run = {
      ...baseRun,
      source_type: 'github_pr',
      source_ref: 'gh:pr:99',
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('gh:pr:99');
  });

  it('renders source row with only source_type when source_ref is absent', () => {
    const run = { ...baseRun, source_type: 'prompt' };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('run-source');
    expect(html).toContain('prompt');
  });

  it('does not render source row when source_type is absent', () => {
    const html = renderToString(runDetailView(baseRun));
    expect(html).not.toContain('run-source');
    expect(html).not.toContain('Source:');
  });

  it('does not render source row when source_type is null', () => {
    const run = { ...baseRun, source_type: null };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('run-source');
  });
});
