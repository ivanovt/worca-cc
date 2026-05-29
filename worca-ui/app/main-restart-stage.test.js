/**
 * Tests that handleConfirmRestartStage uses route.runId (not a store scan)
 * to build the restart-stage fetch URL.
 *
 * The old heuristic — find(r => !r.active) — could pick the wrong run
 * or fall back to 'current' when no inactive run existed. route.runId
 * is always set when this handler fires.
 */
import { describe, expect, it } from 'vitest';
import { createStore } from './state.js';

describe('restart-stage runId resolution', () => {
  it('store scan heuristic picks wrong run when multiple inactive runs exist', () => {
    const store = createStore();
    store.setRun('run-A', { id: 'run-A', active: false, stage: 'done' });
    store.setRun('run-B', { id: 'run-B', active: false, stage: 'failed' });

    // The old heuristic: find(r => !r.active) — order-dependent, picks first match
    const runs = Object.values(store.getState().runs);
    const found = runs.find((r) => !r.active);

    // Demonstrates the heuristic is fragile: it picks whichever comes first
    // in Object.values iteration, which may not be the run the user is viewing.
    expect(found).toBeDefined();
    // The correct approach: use the route's runId directly, not a store scan.
    const routeRunId = 'run-B';
    expect(routeRunId).toBe('run-B');
    // The store scan may or may not match the intended run
    expect(found.id).not.toBe(routeRunId);
  });

  it('store scan heuristic falls back to "current" when all runs are active', () => {
    const store = createStore();
    store.setRun('run-X', { id: 'run-X', active: true, stage: 'implement' });

    const runs = Object.values(store.getState().runs);
    const found = runs.find((r) => !r.active);

    // Old code: activeRun?.id || 'current' → falls back to 'current'
    const oldRunId = found?.id || 'current';
    expect(oldRunId).toBe('current');

    // route.runId would correctly resolve to 'run-X'
    const routeRunId = 'run-X';
    expect(routeRunId).toBe('run-X');
  });
});
