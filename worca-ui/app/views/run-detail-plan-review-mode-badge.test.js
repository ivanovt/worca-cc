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

describe('plan_review stage mode data', () => {
  // The header used to carry an always-on "review & edit" mode badge per the
  // original W-059 §6 audit triad. We dropped it: the mode is already implied
  // by the dialog heading ("Issues resolved by reviewer" vs "Feedback to
  // planner") and the approve_with_edits chip, so the header badge was
  // redundant noise on top of an already-busy stage card.
  it('does not render a mode badge in the stage header', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          mode: 'review_and_edit',
          modeReason: 'from template/pipeline',
        }),
      ),
    );
    expect(html).not.toContain('plan-review-mode-badge');
    expect(html).not.toContain('review & edit');
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

describe('plan_review issues dialog UX', () => {
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

  function makeRunWithId(opts = {}) {
    const run = makeRun(opts);
    run.id = 'test-run-001';
    return run;
  }

  it('renders the "View issues" button next to "View plan" with the issue count', () => {
    const html = renderToString(
      runDetailView(makeRunWithId({ mode: 'review', issues: sampleIssues })),
    );
    expect(html).toContain('btn-view-plan-issues');
    expect(html).toContain('View issues');
    // Count badge matches sampleIssues length
    expect(html).toContain('View issues · 2');
  });

  it('does not render the "View issues" button when there are no issues', () => {
    const html = renderToString(
      runDetailView(makeRunWithId({ mode: 'review', issues: [] })),
    );
    expect(html).not.toContain('btn-view-plan-issues');
    expect(html).not.toContain('View issues');
  });

  it('renders the issue type/category as a badge (consistency with severity)', () => {
    const html = renderToString(
      runDetailView(
        makeRunWithId({ mode: 'review_and_edit', issues: sampleIssues }),
      ),
    );
    // The new category badge is rendered alongside the severity badge, not
    // as a plain inline span. The dedicated class lets us style + scope it.
    expect(html).toContain('plan-review-issue-category-badge');
    // Category text still surfaces in the rendered HTML (inside the badge).
    expect(html).toContain('completeness');
    expect(html).toContain('test_strategy');
  });

  it('renders the same dialog mechanism in review mode (consistency)', () => {
    const html = renderToString(
      runDetailView(makeRunWithId({ mode: 'review', issues: sampleIssues })),
    );
    // Same dialog class in both modes — the only mode-dependent piece is the
    // heading text inside the dialog label.
    expect(html).toContain('plan-review-issues-dialog');
    expect(html).toContain('Feedback to planner');
  });

  it('plan_review button shows the editor output (plan-002.md) when outcome is approve_with_edits', () => {
    // In edit mode an actual edit produces plan-(N+1) — surface it here so
    // the user sees the moves-forward plan, not just the input the editor
    // reviewed. With outcome='approve_with_edits' on iter 1, the button
    // should label plan-002.md (not plan-001.md).
    const html = renderToString(
      runDetailView(
        makeRunWithId({
          mode: 'review_and_edit',
          outcome: 'approve_with_edits',
          issues: sampleIssues,
        }),
      ),
    );
    expect(html).toContain('View plan · plan-002.md');
  });

  it('plan_review button stays on plan-001.md when the editor did not actually edit (approve)', () => {
    // Honest-outcome no-edit case: outcome downgraded to 'approve' and
    // plan-002 collapsed back, so the iter ends at plan-001.md.
    const html = renderToString(
      runDetailView(
        makeRunWithId({
          mode: 'review_and_edit',
          outcome: 'approve',
          issues: sampleIssues,
        }),
      ),
    );
    expect(html).toContain('View plan · plan-001.md');
    expect(html).not.toContain('View plan · plan-002.md');
  });
});
