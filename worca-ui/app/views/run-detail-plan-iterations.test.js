// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { runDetailView } from './run-detail.js';

// Mirror of the recursive stringifier used by the other run-detail tests: it
// walks template.overview + template.stages so stage-panel content (where the
// plan viewer lives) is captured.
function renderToString(template) {
  if (!template) return '';
  if (template.overview)
    return renderToString(template.overview) + renderToString(template.stages);
  if (typeof template === 'string') return template;
  if (template._$litDirective$ && template.values)
    return template.values[0] || '';
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
      else if (v?._$litDirective$ && v?.values) result += v.values[0] || '';
    }
  });
  return result;
}

describe('runDetailView plan revision viewer (W-061)', () => {
  function _run() {
    return {
      id: 'run-w061',
      worktree_path: '/tmp/wt',
      stages: {
        plan: {
          status: 'completed',
          plan_file: '/tmp/wt/.worca/runs/run-w061/plan-002.md',
          iterations: [{ number: 1, status: 'completed' }],
        },
        plan_review: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed', outcome: 'approve' }],
        },
      },
    };
  }

  it('renders a "View plan" button on both the planner and plan_review stages', () => {
    const out = renderToString(runDetailView(_run()));
    const buttons = out.match(/btn-view-run-plan/g) || [];
    // One on the plan stage, one on the plan_review stage.
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it('renders the plan dialog exactly once (shared, on the plan stage only)', () => {
    const out = renderToString(runDetailView(_run()));
    const dialogs = out.match(/run-plan-dialog/g) || [];
    expect(dialogs.length).toBe(1);
  });
});
