import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./worktree-ops.js', () => ({
  removeWorktree: vi.fn(),
}));

import { ProcessManager } from './process-manager.js';
import { removeWorktree } from './worktree-ops.js';

describe('ProcessManager.maybeAutoCleanup', () => {
  let tmpDir, worcaDir, prefsDir;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `pm-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    worcaDir = join(tmpDir, 'project', '.worca');
    prefsDir = join(tmpDir, 'prefs');
    mkdirSync(join(worcaDir, 'runs', 'run-001'), { recursive: true });
    mkdirSync(prefsDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeStatus(runId, status) {
    const dir = join(worcaDir, 'runs', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2));
  }

  function writeGlobalPrefs(prefs) {
    writeFileSync(
      join(prefsDir, 'settings.json'),
      JSON.stringify(prefs, null, 2),
    );
  }

  it('on-success + completed → calls removeWorktree and emits event', () => {
    writeStatus('run-001', {
      pipeline_status: 'completed',
      worktree_path: '/tmp/wt/run-001',
      run_id: 'run-001',
    });
    writeGlobalPrefs({
      worca: { parallel: { cleanup_policy: 'on-success' } },
    });

    const pm = new ProcessManager({ worcaDir, prefsDir });
    const result = pm.maybeAutoCleanup('run-001');

    expect(result.cleaned).toBe(true);
    expect(result.runId).toBe('run-001');
    expect(result.path).toBe('/tmp/wt/run-001');
    expect(result.reason).toBe('on-success');
    expect(removeWorktree).toHaveBeenCalledWith(worcaDir, 'run-001');

    const eventsPath = join(worcaDir, 'runs', 'run-001', 'events.jsonl');
    const events = readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('worktree.auto_cleanup');
    expect(events[0].payload.path).toBe('/tmp/wt/run-001');
    expect(events[0].payload.reason).toBe('on-success');
  });

  it('on-success + failed → no cleanup', () => {
    writeStatus('run-001', {
      pipeline_status: 'failed',
      worktree_path: '/tmp/wt/run-001',
    });
    writeGlobalPrefs({
      worca: { parallel: { cleanup_policy: 'on-success' } },
    });

    const pm = new ProcessManager({ worcaDir, prefsDir });
    const result = pm.maybeAutoCleanup('run-001');

    expect(result.cleaned).toBe(false);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('never policy + completed → no cleanup', () => {
    writeStatus('run-001', {
      pipeline_status: 'completed',
      worktree_path: '/tmp/wt/run-001',
    });
    writeGlobalPrefs({
      worca: { parallel: { cleanup_policy: 'never' } },
    });

    const pm = new ProcessManager({ worcaDir, prefsDir });
    const result = pm.maybeAutoCleanup('run-001');

    expect(result.cleaned).toBe(false);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('manual-only policy + completed → no cleanup', () => {
    writeStatus('run-001', {
      pipeline_status: 'completed',
      worktree_path: '/tmp/wt/run-001',
    });
    writeGlobalPrefs({
      worca: { parallel: { cleanup_policy: 'manual-only' } },
    });

    const pm = new ProcessManager({ worcaDir, prefsDir });
    const result = pm.maybeAutoCleanup('run-001');

    expect(result.cleaned).toBe(false);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('no worktree_path in status → no cleanup', () => {
    writeStatus('run-001', {
      pipeline_status: 'completed',
    });
    writeGlobalPrefs({
      worca: { parallel: { cleanup_policy: 'on-success' } },
    });

    const pm = new ProcessManager({ worcaDir, prefsDir });
    const result = pm.maybeAutoCleanup('run-001');

    expect(result.cleaned).toBe(false);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('no prefsDir → defaults to never, no cleanup', () => {
    writeStatus('run-001', {
      pipeline_status: 'completed',
      worktree_path: '/tmp/wt/run-001',
    });

    const pm = new ProcessManager({ worcaDir });
    const result = pm.maybeAutoCleanup('run-001');

    expect(result.cleaned).toBe(false);
    expect(removeWorktree).not.toHaveBeenCalled();
  });
});
