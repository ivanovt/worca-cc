/**
 * Tests: run-card.js 'Revising PR #N' badge when revises_pr is set.
 * TDD: written to drive implementation.
 */

import { describe, expect, it } from 'vitest';
import { runCardView } from './run-card.js';

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
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

const baseRun = {
  id: 'run-1',
  work_request: { title: 'Test run' },
  stages: {},
  started_at: '2024-01-01T00:00:00Z',
};

describe('runCardView — Revising PR badge', () => {
  it('renders Revising PR #N badge when revises_pr is set', () => {
    const run = { ...baseRun, revises_pr: 42 };
    const html = renderToString(runCardView(run));
    expect(html).toContain('Revising PR #42');
  });

  it('renders correct PR number in badge', () => {
    const run = { ...baseRun, revises_pr: 123 };
    const html = renderToString(runCardView(run));
    expect(html).toContain('Revising PR #123');
  });

  it('does not render Revising PR badge when revises_pr is absent', () => {
    const html = renderToString(runCardView(baseRun));
    expect(html).not.toContain('Revising PR #');
  });

  it('does not render Revising PR badge when revises_pr is null', () => {
    const run = { ...baseRun, revises_pr: null };
    const html = renderToString(runCardView(run));
    expect(html).not.toContain('Revising PR #');
  });

  it('renders badge with warning variant (orange = revising/needs attention)', () => {
    const run = { ...baseRun, revises_pr: 7 };
    const html = renderToString(runCardView(run));
    expect(html).toContain('Revising PR #7');
    expect(html).toContain('warning');
  });
});
