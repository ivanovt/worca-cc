/**
 * Tests: ProcessManager.startPipeline() launch confirmation for worktree runs.
 *
 * run_worktree.py is a fire-and-forget *launcher* that exits 0 only after the
 * real pipeline started, and non-zero (with stderr) on any failure. The server
 * must wait for that exit code instead of resolving "started" on a fixed timer
 * — otherwise slow failures (PR fetch + worktree collision) report success
 * while nothing runs. run_pipeline.py (in-place) keeps the timer path.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let nextChild = null;
const mockSpawn = vi.fn(() => nextChild);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (...args) => mockSpawn(...args),
  };
});

const { ProcessManager } = await import('./process-manager.js');

/** Build a fake child process with a stderr stream and exit/error emitters. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  child.removeAllListeners =
    EventEmitter.prototype.removeAllListeners.bind(child);
  return child;
}

describe('startPipeline() worktree launch confirmation', () => {
  let worcaDir;
  let projectRoot;

  beforeEach(() => {
    worcaDir = join(tmpdir(), `worca-pm-lc-${Date.now()}-${Math.random()}`);
    projectRoot = join(
      tmpdir(),
      `worca-proj-lc-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(worcaDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude', 'worca', 'scripts'), {
      recursive: true,
    });
    // Both scripts present → startPipeline selects run_worktree.py (launcher).
    writeFileSync(
      join(projectRoot, '.claude/worca/scripts/run_pipeline.py'),
      '# stub\n',
    );
    writeFileSync(
      join(projectRoot, '.claude/worca/scripts/run_worktree.py'),
      '# stub\n',
    );
    mockSpawn.mockClear();
    nextChild = makeFakeChild();
  });

  afterEach(() => {
    rmSync(worcaDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('selects the worktree launcher and captures stderr (pipe, not ignore)', async () => {
    const pm = new ProcessManager({ worcaDir, projectRoot });
    const p = pm.startPipeline({ sourceType: 'none', prompt: 'hi' });
    // Resolve via launcher exit 0.
    nextChild.emit('exit', 0, null);
    await p;

    const [, args, opts] = mockSpawn.mock.calls[0];
    expect(args[0]).toContain('run_worktree.py');
    // stderr must be piped so the failure reason can be surfaced.
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
  });

  it('resolves with the pid when the launcher exits 0', async () => {
    const pm = new ProcessManager({ worcaDir, projectRoot });
    const p = pm.startPipeline({ sourceType: 'none', prompt: 'hi' });
    nextChild.emit('exit', 0, null);
    const result = await p;
    expect(result.pid).toBe(4242);
    expect(nextChild.unref).toHaveBeenCalled();
  });

  it('rejects with stderr detail when the launcher exits non-zero', async () => {
    const pm = new ProcessManager({ worcaDir, projectRoot });
    const p = pm.startPipeline({ sourceType: 'none', prompt: 'hi' });
    nextChild.stderr.emit(
      'data',
      Buffer.from('error: failed to create worktree for run X\n'),
    );
    nextChild.emit('exit', 1, null);

    await expect(p).rejects.toThrow(/failed to create worktree/);
    await expect(p.catch((e) => e.code)).resolves.toBe('spawn_error');
  });

  it('does NOT resolve early on a timer — pends until the launcher exits', async () => {
    vi.useFakeTimers();
    try {
      const pm = new ProcessManager({ worcaDir, projectRoot });
      let settled = false;
      const p = pm
        .startPipeline({ sourceType: 'none', prompt: 'hi' })
        .then(() => {
          settled = true;
        });
      // Advance well past the old 2s success window.
      await vi.advanceTimersByTimeAsync(10000);
      expect(settled).toBe(false);
      nextChild.emit('exit', 0, null);
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
