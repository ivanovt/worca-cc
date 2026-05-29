import { describe, expect, it } from 'vitest';

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
