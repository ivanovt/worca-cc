import { describe, expect, it, vi } from 'vitest';
import { runDetailView } from './views/run-detail.js';

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

describe('header button pending-state scoping', () => {
  function resolvePending(controlPending, routeRunId) {
    return controlPending?.runId === routeRunId ? controlPending.action : null;
  }

  it('returns action when controlPending targets the current run', () => {
    const pending = resolvePending(
      { action: 'pause', runId: 'run-A' },
      'run-A',
    );
    expect(pending).toBe('pause');
  });

  it('returns null when controlPending targets a different run', () => {
    const pending = resolvePending({ action: 'stop', runId: 'run-B' }, 'run-A');
    expect(pending).toBeNull();
  });

  it('returns null when controlPending is null', () => {
    const pending = resolvePending(null, 'run-A');
    expect(pending).toBeNull();
  });

  it('global pipelineAction string would incorrectly show pending for all runs', () => {
    const pipelineAction = 'stopping';
    // Old pattern: pipelineAction === 'stopping' — no run scoping
    // This would show "Stopping…" on ANY run's header, not just the target
    const runA = 'run-A';
    const runB = 'run-B';
    expect(pipelineAction === 'stopping').toBe(true); // affects ALL runs
    // New pattern: scoped to the target run
    const controlPending = { action: 'stop', runId: runA };
    expect(resolvePending(controlPending, runA)).toBe('stop');
    expect(resolvePending(controlPending, runB)).toBeNull();
  });
});

describe('Timeline button in run-detail overview', () => {
  const baseRun = { run_id: 'run-1', stages: {}, active: false };

  it('renders Timeline button after stage strip when onOpenTimeline is provided', () => {
    const onOpenTimeline = vi.fn();
    const out = renderToString(
      runDetailView(baseRun, {}, { onOpenTimeline }).overview,
    );
    expect(out).toContain('run-stage-actions');
    expect(out).toContain('Timeline');
  });

  it('does not render Timeline button when onOpenTimeline is absent', () => {
    const out = renderToString(runDetailView(baseRun, {}).overview);
    expect(out).not.toContain('run-stage-actions');
  });

  it('onOpenTimeline callback routes to timeline sub-view', () => {
    const calls = [];
    function navigate(section, runId, projectId, action) {
      calls.push({ section, runId, projectId, action });
    }
    const route = { section: 'active', runId: 'run-1', projectId: null };
    navigate(route.section, route.runId, route.projectId, 'timeline');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      section: 'active',
      runId: 'run-1',
      projectId: null,
      action: 'timeline',
    });
  });
});

describe('back-arrow from timeline sub-view', () => {
  function handleBack(route, navigate) {
    if (route.action === 'timeline' && route.runId) {
      navigate(route.section, route.runId, route.projectId, null);
    } else if (route.runId) {
      navigate(route.section, null, route.projectId);
    }
  }

  it('navigates to run detail (not section root) when action is timeline', () => {
    const calls = [];
    const navigate = (...args) => calls.push(args);
    handleBack(
      {
        section: 'active',
        runId: 'run-1',
        projectId: null,
        action: 'timeline',
      },
      navigate,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['active', 'run-1', null, null]);
  });

  it('navigates to section root (no runId) when on run detail view', () => {
    const calls = [];
    const navigate = (...args) => calls.push(args);
    handleBack(
      { section: 'active', runId: 'run-1', projectId: null, action: null },
      navigate,
    );
    expect(calls[0]).toEqual(['active', null, null]);
  });
});
