import { describe, expect, it } from 'vitest';
import { _stageToJson, runDetailView } from './run-detail.js';

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

function makeRun({
  mode,
  modeReason,
  status = 'completed',
  outcome = 'approve',
  issues,
} = {}) {
  const stage = {
    status,
    iterations: [{ number: 1, status: 'completed', outcome }],
  };
  if (mode !== undefined) stage.mode = mode;
  if (modeReason !== undefined) stage.mode_reason = modeReason;
  if (issues !== undefined)
    stage.iterations[0].output = { issues, outcome, summary: 'test' };
  return {
    stages: {
      plan: { status: 'completed', iterations: [{ number: 1 }] },
      plan_review: stage,
    },
  };
}

describe('plan_review stage mode badge', () => {
  it('shows mode badge with review mode and default reason', () => {
    const html = renderToString(
      runDetailView(makeRun({ mode: 'review', modeReason: 'default' })),
    );
    expect(html).toContain('plan-review-mode-badge');
    expect(html).toContain('Mode:');
    expect(html).toContain('review');
    expect(html).toContain('variant="neutral"');
  });

  it('shows review_and_edit mode label', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          mode: 'review_and_edit',
          modeReason: 'from template/pipeline',
        }),
      ),
    );
    expect(html).toContain('plan-review-mode-badge');
    expect(html).toContain('review & edit');
  });

  it('shows reason as tooltip content', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          mode: 'review',
          modeReason: 'forced by project (governance.plan_review_enforce)',
        }),
      ),
    );
    expect(html).toContain('plan-review-mode-badge');
    expect(html).toContain(
      'forced by project (governance.plan_review_enforce)',
    );
  });

  it('does not show badge when mode is absent', () => {
    const html = renderToString(runDetailView(makeRun({})));
    expect(html).not.toContain('plan-review-mode-badge');
  });

  it('does not show badge on non-plan_review stages', () => {
    const run = {
      stages: {
        implement: {
          status: 'completed',
          mode: 'review',
          mode_reason: 'default',
          iterations: [{ number: 1, status: 'completed' }],
        },
      },
    };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('plan-review-mode-badge');
  });

  it('shows badge on pending plan_review stage', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ mode: 'review', modeReason: 'default', status: 'pending' }),
      ),
    );
    expect(html).toContain('plan-review-mode-badge');
  });

  it('includes mode and mode_reason in stageToJson output', () => {
    const stage = {
      status: 'completed',
      mode: 'review_and_edit',
      mode_reason: 'from template/pipeline',
      iterations: [{ number: 1, status: 'completed' }],
    };
    const json = _stageToJson('plan_review', stage, 'plan_reviewer', 'opus');
    expect(json.mode).toBe('review_and_edit');
    expect(json.mode_reason).toBe('from template/pipeline');
  });

  it('omits mode fields from stageToJson when absent', () => {
    const stage = {
      status: 'completed',
      iterations: [{ number: 1, status: 'completed' }],
    };
    const json = _stageToJson('plan_review', stage, 'plan_reviewer', 'opus');
    expect(json.mode).toBeUndefined();
    expect(json.mode_reason).toBeUndefined();
  });
});

describe('approve_with_edits outcome rendering', () => {
  it('renders approve_with_edits with success (green) variant', () => {
    const html = renderToString(
      runDetailView(makeRun({ outcome: 'approve_with_edits' })),
    );
    expect(html).toContain('variant="success"');
    expect(html).toContain('approve with edits');
  });

  it('shows edited qualifier chip for approve_with_edits', () => {
    const html = renderToString(
      runDetailView(makeRun({ outcome: 'approve_with_edits' })),
    );
    expect(html).toContain('plan-review-edited-chip');
    expect(html).toContain('edited');
  });

  it('does not show edited chip for plain approve', () => {
    const html = renderToString(runDetailView(makeRun({ outcome: 'approve' })));
    expect(html).not.toContain('plan-review-edited-chip');
  });

  it('does not show edited chip for revise outcome', () => {
    const html = renderToString(runDetailView(makeRun({ outcome: 'revise' })));
    expect(html).not.toContain('plan-review-edited-chip');
  });
});

describe('plan_review issues panel labeling', () => {
  const sampleIssues = [
    {
      category: 'completeness',
      severity: 'major',
      description: 'Missing error handling',
    },
    {
      category: 'test_strategy',
      severity: 'minor',
      description: 'Add edge case tests',
    },
  ];

  it('shows "Feedback to planner" heading in review mode', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          mode: 'review',
          modeReason: 'default',
          outcome: 'revise',
          issues: sampleIssues,
        }),
      ),
    );
    expect(html).toContain('Feedback to planner');
    expect(html).not.toContain('Issues resolved by reviewer');
  });

  it('shows "Issues resolved by reviewer" heading in review_and_edit mode', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          mode: 'review_and_edit',
          modeReason: 'from template/pipeline',
          outcome: 'approve_with_edits',
          issues: sampleIssues,
        }),
      ),
    );
    expect(html).toContain('Issues resolved by reviewer');
    expect(html).not.toContain('Feedback to planner');
  });

  it('renders issue descriptions in the panel', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          mode: 'review',
          modeReason: 'default',
          outcome: 'revise',
          issues: sampleIssues,
        }),
      ),
    );
    expect(html).toContain('Missing error handling');
    expect(html).toContain('Add edge case tests');
  });

  it('renders issue severity badges', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          mode: 'review',
          modeReason: 'default',
          outcome: 'revise',
          issues: sampleIssues,
        }),
      ),
    );
    expect(html).toContain('major');
    expect(html).toContain('minor');
  });

  it('does not render issues panel when issues array is empty', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          mode: 'review',
          modeReason: 'default',
          outcome: 'approve',
          issues: [],
        }),
      ),
    );
    expect(html).not.toContain('Feedback to planner');
    expect(html).not.toContain('Issues resolved by reviewer');
  });

  it('does not render issues panel when output has no issues', () => {
    const html = renderToString(
      runDetailView(makeRun({ mode: 'review', modeReason: 'default' })),
    );
    expect(html).not.toContain('Feedback to planner');
    expect(html).not.toContain('Issues resolved by reviewer');
  });

  it('shows "Feedback to planner" when mode is absent (default)', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          outcome: 'revise',
          issues: sampleIssues,
        }),
      ),
    );
    expect(html).toContain('Feedback to planner');
  });
});
