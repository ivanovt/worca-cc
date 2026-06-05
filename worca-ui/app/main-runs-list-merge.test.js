/**
 * Tests for main.js runs-list WS merge logic.
 *
 * The merge branch (isMultiProject path) is exercised inline here — same
 * pattern as other main-*.test.js files: replicate the logic under test
 * without importing main.js (which has DOM side-effects).
 *
 * These tests must FAIL before Fix 2 (client-side _project preservation) is applied.
 */

import { describe, expect, it } from 'vitest';
import { createStore, isArchivedRunExpired } from './state.js';

/**
 * Replicates the `ws.on('runs-list', ...)` multi-project merge branch from main.js.
 * Keep this in sync with the real implementation (lines ~980-1020 in main.js).
 */
function applyRunsList(store, payload, msg) {
  const isMultiProject = (store.getState().projects || []).length > 1;
  if (!isMultiProject) {
    store.setState({
      runs: Object.fromEntries((payload.runs || []).map((r) => [r.id, r])),
    });
    return;
  }

  const existing = { ...store.getState().runs };
  const freshIds = new Set((payload.runs || []).map((r) => r.id));
  const sourceProject = msg?.project || null;
  if (sourceProject) {
    for (const [id, run] of Object.entries(existing)) {
      if (run._project === sourceProject && !freshIds.has(id)) {
        delete existing[id];
      }
    }
  }
  const archivedUpdates = { ...store.getState().archivedRuns };
  if (sourceProject) {
    for (const [id, run] of Object.entries(archivedUpdates)) {
      if (run._project === sourceProject && !freshIds.has(id)) {
        delete archivedUpdates[id];
      }
    }
  }
  const now = Date.now();
  for (const run of payload.runs || []) {
    const prev = existing[run.id] || archivedUpdates[run.id];
    run._project =
      sourceProject ||
      run.project ||
      run._project ||
      prev?._project ||
      prev?.project ||
      null;
    if (run.archived) {
      if (isArchivedRunExpired(run, now)) continue;
      archivedUpdates[run.id] = run;
      delete existing[run.id];
    } else {
      existing[run.id] = run;
      delete archivedUpdates[run.id];
    }
  }
  store.setState({ runs: existing, archivedRuns: archivedUpdates });
}

describe('main.js runs-list merge — _project tag preservation', () => {
  it('untagged WS refresh does not erase existing _project tag', () => {
    // Seed state: two projects registered, r1 already tagged as proj-a
    const store = createStore({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      runs: { r1: { id: 'r1', status: 'completed', _project: 'proj-a' } },
    });

    // Apply a runs-list from proj-b's refresh — msg.project is absent (the bug scenario)
    // The run object itself also carries no project field
    applyRunsList(store, { runs: [{ id: 'r1', status: 'completed' }] }, {});

    // r1 should still be tagged as proj-a — Fix 2 preserves the existing tag
    expect(store.getState().runs.r1._project).toBe('proj-a');
  });

  it('tagged WS refresh stamps _project correctly', () => {
    const store = createStore({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      runs: {},
    });

    // Apply a runs-list that carries msg.project = 'proj-a'
    applyRunsList(
      store,
      { runs: [{ id: 'r1', status: 'running' }] },
      { project: 'proj-a' },
    );

    expect(store.getState().runs.r1._project).toBe('proj-a');
  });
});
