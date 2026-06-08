/**
 * Tests: run-detail.js PR strip semantic reorder for revise runs.
 * W-067 P5: For revise runs, the PR being revised is the INPUT.
 * Show the PR strip from run start (overview), not just in the PR stage.
 * The changes_requested review_status badge is the trigger, not an outcome.
 * TDD: written to drive implementation.
 */

import { describe, expect, it } from 'vitest';
import { runDetailView } from './run-detail.js';

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

const prObject = {
  url: 'https://github.com/owner/repo/pull/42',
  number: 42,
  review_status: 'changes_requested',
  source_branch: 'feature/my-feature',
  target_branch: 'main',
};

const prStage = {
  status: 'completed',
  iterations: [{ number: 1, status: 'completed' }],
};

const reviseRun = {
  revises_pr: 42,
  pr: prObject,
  stages: { pr: prStage },
};

const normalRun = {
  pr: prObject,
  stages: { pr: prStage },
};

describe('_prInfoStripView — revise run semantic reorder', () => {
  it('renders pr-info-strip in overview section for revise runs', () => {
    const result = runDetailView(reviseRun);
    const overviewHtml = renderToString(result.overview);
    expect(overviewHtml).toContain('pr-info-strip');
  });

  it('does not render pr-info-strip in overview for normal runs', () => {
    const result = runDetailView(normalRun);
    const overviewHtml = renderToString(result.overview);
    expect(overviewHtml).not.toContain('pr-info-strip');
  });

  it('suppresses pr-info-strip from pr stage section for revise runs', () => {
    const result = runDetailView(reviseRun);
    const stagesHtml = renderToString(result.stages);
    expect(stagesHtml).not.toContain('pr-info-strip');
  });

  it('still shows pr-info-strip in pr stage section for normal runs', () => {
    const result = runDetailView(normalRun);
    const stagesHtml = renderToString(result.stages);
    expect(stagesHtml).toContain('pr-info-strip');
  });

  it('labels review_status badge as Trigger for revise runs', () => {
    const result = runDetailView(reviseRun);
    const overviewHtml = renderToString(result.overview);
    expect(overviewHtml).toContain('Trigger:');
  });

  it('does not label review_status badge as Trigger for normal runs', () => {
    const result = runDetailView(normalRun);
    const allHtml =
      renderToString(result.overview) + renderToString(result.stages);
    expect(allHtml).not.toContain('Trigger:');
  });

  it('renders PR link in overview for revise run', () => {
    const result = runDetailView(reviseRun);
    const overviewHtml = renderToString(result.overview);
    expect(overviewHtml).toContain('https://github.com/owner/repo/pull/42');
  });

  it('renders revise PR strip even before pr stage begins (no pr stage data)', () => {
    const earlyReviseRun = {
      revises_pr: 99,
      pr: { url: 'https://github.com/owner/repo/pull/99', number: 99 },
      stages: {},
    };
    const result = runDetailView(earlyReviseRun);
    const overviewHtml = renderToString(result.overview);
    expect(overviewHtml).toContain('pr-info-strip');
    expect(overviewHtml).toContain('#99');
  });
});
