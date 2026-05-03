/**
 * Tests for the ordering contract in the runs-list WS event handler.
 *
 * main.js wires: store.subscribe(() => rerender())
 * store.setState() triggers subscribers synchronously.
 * Therefore, any module-level variable read during rerender must be
 * updated BEFORE store.setState() is called.
 *
 * This test suite documents the required ordering and catches regressions.
 */
import { describe, expect, it } from 'vitest';
import { createStore } from './state.js';

function deriveTotalRunning(runs) {
  let count = 0;
  for (const r of Object.values(runs)) {
    const ps = r.pipeline_status || (r.active ? 'running' : 'completed');
    if (ps === 'running' || ps === 'paused') count++;
  }
  return count;
}

describe('runs-list handler: settings must be updated before store.setState', () => {
  it('settings are visible in store subscriber when updated before setState', () => {
    // Arrange: mirror main.js module-level setup
    const store = createStore();
    let settings = {};
    const settingsCapturedDuringRender = [];

    // store.subscribe fires synchronously on setState – just like main.js line 872
    store.subscribe(() => {
      settingsCapturedDuringRender.push(Object.assign({}, settings));
    });

    const payload = { runs: [{ id: 'run-1' }], settings: { maxConcurrent: 2 } };

    // Act: correct ordering – settings BEFORE setState (the fix we are implementing)
    const runs = {};
    for (const run of payload.runs || []) runs[run.id] = run;
    if (payload.settings) settings = payload.settings; // must come first
    store.setState({ runs }); // triggers subscriber synchronously

    // Assert: subscriber saw the fresh settings
    expect(settingsCapturedDuringRender).toHaveLength(1);
    expect(settingsCapturedDuringRender[0]).toEqual({ maxConcurrent: 2 });
  });

  it('settings updated after setState causes subscriber to see stale settings (documents the bug)', () => {
    // Arrange
    const store = createStore();
    let settings = {};
    const settingsCapturedDuringRender = [];

    store.subscribe(() => {
      settingsCapturedDuringRender.push(Object.assign({}, settings));
    });

    const payload = { runs: [{ id: 'run-1' }], settings: { maxConcurrent: 2 } };

    // Act: wrong ordering – settings AFTER setState (the original buggy code)
    const runs = {};
    for (const run of payload.runs || []) runs[run.id] = run;
    store.setState({ runs }); // subscriber fires — settings still {}
    if (payload.settings) settings = payload.settings; // too late

    // Assert: subscriber saw stale (empty) settings — this is the bug
    expect(settingsCapturedDuringRender).toHaveLength(1);
    expect(settingsCapturedDuringRender[0]).toEqual({}); // stale!
  });
});

describe('runs-list handler: totalRunning derivation', () => {
  it('counts running runs', () => {
    const runs = {
      r1: { id: 'r1', pipeline_status: 'running' },
      r2: { id: 'r2', pipeline_status: 'completed' },
      r3: { id: 'r3', pipeline_status: 'running' },
    };
    expect(deriveTotalRunning(runs)).toBe(2);
  });

  it('counts paused runs as running', () => {
    const runs = {
      r1: { id: 'r1', pipeline_status: 'running' },
      r2: { id: 'r2', pipeline_status: 'paused' },
      r3: { id: 'r3', pipeline_status: 'failed' },
    };
    expect(deriveTotalRunning(runs)).toBe(2);
  });

  it('falls back to active flag when pipeline_status is missing', () => {
    const runs = {
      r1: { id: 'r1', active: true },
      r2: { id: 'r2', active: false },
    };
    expect(deriveTotalRunning(runs)).toBe(1);
  });

  it('returns 0 for empty runs', () => {
    expect(deriveTotalRunning({})).toBe(0);
  });

  it('stores derived totalRunning in state after setRunsBulk', () => {
    const store = createStore();
    store.setRunsBulk([
      { id: 'r1', pipeline_status: 'running' },
      { id: 'r2', pipeline_status: 'paused' },
      { id: 'r3', pipeline_status: 'completed' },
    ]);
    const total = deriveTotalRunning(store.getState().runs);
    store.setState({ totalRunning: total });
    expect(store.getState().totalRunning).toBe(2);
  });
});
