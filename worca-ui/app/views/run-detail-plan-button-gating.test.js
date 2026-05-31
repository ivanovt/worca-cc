// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _ensureRunPlanFetched,
  _runPlanTextNotFound,
  runDetailView,
} from './run-detail.js';

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

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// _planIterationButton completion guard
// ---------------------------------------------------------------------------
describe('plan iteration button gating', () => {
  it('does NOT render View plan button when plan iteration is in_progress', () => {
    const run = {
      id: 'run-gate-1',
      worktree_path: '/tmp/wt',
      stages: {
        plan: {
          status: 'in_progress',
          iterations: [{ number: 1, status: 'in_progress' }],
        },
      },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('btn-view-run-plan');
    expect(out).not.toContain('View plan');
  });

  it('renders View plan button when plan iteration is completed', () => {
    const run = {
      id: 'run-gate-2',
      worktree_path: '/tmp/wt',
      stages: {
        plan: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
      },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('btn-view-run-plan');
    expect(out).toContain('View plan · plan-001.md');
  });

  it('does NOT render View plan button when plan_review iteration is in_progress', () => {
    const run = {
      id: 'run-gate-3',
      worktree_path: '/tmp/wt',
      stages: {
        plan: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
        plan_review: {
          status: 'in_progress',
          iterations: [{ number: 1, status: 'in_progress' }],
        },
      },
    };
    const out = renderToString(runDetailView(run));
    // plan stage button should be present (completed)
    expect(out).toContain('View plan · plan-001.md');
    // plan_review button should NOT be present (in_progress)
    const buttons = out.match(/btn-view-plan-iter/g) || [];
    // Only 1 button (from plan stage), not 2
    expect(buttons.length).toBe(1);
  });

  it('plan_review with approve_with_edits shows revision N+1', () => {
    const run = {
      id: 'run-gate-4',
      worktree_path: '/tmp/wt',
      stages: {
        plan: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
        plan_review: {
          status: 'completed',
          iterations: [
            {
              number: 1,
              status: 'completed',
              outcome: 'approve_with_edits',
            },
          ],
        },
      },
    };
    const out = renderToString(runDetailView(run));
    // plan_review iter 1 with approve_with_edits → rev 2 → plan-002.md
    expect(out).toContain('View plan · plan-002.md');
  });
});

// ---------------------------------------------------------------------------
// Dialog empty states (in_progress vs terminal)
// ---------------------------------------------------------------------------
describe('plan dialog empty states', () => {
  let nextRunId = 0;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("shows 'Planner is still writing' when plan stage is in_progress and plan not found", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    });
    const runId = `run-dialog-${++nextRunId}`;
    const run = {
      id: runId,
      project: 'proj',
      worktree_path: '/tmp/wt',
      stages: { plan: { status: 'in_progress' } },
    };
    const rerender = vi.fn();

    _ensureRunPlanFetched(run, null, rerender);
    await flush();

    expect(_runPlanTextNotFound.has(`${runId}#latest`)).toBe(true);
  });

  it('marks key as not-found on 404, clears on subsequent success', async () => {
    const runId = `run-dialog-${++nextRunId}`;
    const run = {
      id: runId,
      project: 'proj',
      worktree_path: '/tmp/wt',
      stages: { plan: { status: 'in_progress' } },
    };
    const rerender = vi.fn();

    // 404 first
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    });
    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(_runPlanTextNotFound.has(`${runId}#latest`)).toBe(true);

    // Success after
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('# Plan'),
    });
    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(_runPlanTextNotFound.has(`${runId}#latest`)).toBe(false);
  });
});
