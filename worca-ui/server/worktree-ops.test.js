/**
 * Tests: worktree-ops async API
 * TDD: written before implementation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => mockExecFile(...args) };
});

const { removeWorktree, pruneWorktrees } = await import('./worktree-ops.js');

describe('worktree-ops', () => {
  let tmpDir;
  let worcaDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'worca-ops-'));
    worcaDir = join(tmpDir, '.worca');
    mkdirSync(join(worcaDir, 'multi', 'pipelines.d'), { recursive: true });

    // Default mock: succeed via setImmediate (yields to event loop)
    mockExecFile.mockImplementation((...args) => {
      const cb = args[args.length - 1];
      setImmediate(() => cb(null, '', ''));
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mockExecFile.mockReset();
  });

  function writeReg(runId, data = {}) {
    writeFileSync(
      join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify(data),
    );
  }

  it('event loop is unblocked during parallel removeWorktree calls', async () => {
    let ticks = 0;
    let running = true;
    function ticker() {
      if (running)
        setImmediate(() => {
          ticks++;
          ticker();
        });
    }
    ticker();

    writeReg('run-a');
    writeReg('run-b');

    await Promise.all([
      removeWorktree(worcaDir, 'run-a'),
      removeWorktree(worcaDir, 'run-b'),
    ]);

    running = false;
    // Flush one more round so the last ticker setImmediate can fire
    await new Promise((r) => setImmediate(r));

    expect(ticks).toBeGreaterThan(0);
  });

  it('skipPrune=true skips git worktree prune', async () => {
    writeReg('run-skip');
    await removeWorktree(worcaDir, 'run-skip', { skipPrune: true });

    const pruneCalls = mockExecFile.mock.calls.filter(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1].includes('prune'),
    );
    expect(pruneCalls).toHaveLength(0);
  });

  it('pruneWorktrees runs once after N skipPrune removes', async () => {
    writeReg('run-1');
    writeReg('run-2');
    writeReg('run-3');

    await Promise.all([
      removeWorktree(worcaDir, 'run-1', { skipPrune: true }),
      removeWorktree(worcaDir, 'run-2', { skipPrune: true }),
      removeWorktree(worcaDir, 'run-3', { skipPrune: true }),
    ]);

    mockExecFile.mockClear();
    await pruneWorktrees(worcaDir);

    const pruneCalls = mockExecFile.mock.calls.filter(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1].includes('prune'),
    );
    expect(pruneCalls).toHaveLength(1);
  });
});
