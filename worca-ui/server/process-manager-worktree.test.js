import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessManager } from './process-manager.js';

describe('ProcessManager.getRunningPid — worktree overlay', () => {
  let parentWorca;
  let worktreePath;
  const runId = '20260317-084204-001-aaaa';

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    parentWorca = join(tmpdir(), `worca-pm-parent-${stamp}`, '.worca');
    worktreePath = join(tmpdir(), `worca-pm-wt-${stamp}`);
    mkdirSync(join(parentWorca, 'multi', 'pipelines.d'), { recursive: true });
  });

  afterEach(() => {
    rmSync(join(parentWorca, '..'), { recursive: true, force: true });
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('finds the worktree pipeline.pid when run is registered in pipelines.d', () => {
    const wtRunDir = join(worktreePath, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(join(wtRunDir, 'pipeline.pid'), String(process.pid));

    writeFileSync(
      join(parentWorca, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify({
        run_id: runId,
        worktree_path: worktreePath,
        pid: process.pid,
      }),
    );

    const pm = new ProcessManager({ worcaDir: parentWorca });
    const result = pm.getRunningPid(runId);

    expect(result).not.toBeNull();
    expect(result.pid).toBe(process.pid);
  });

  it('returns null for an unregistered runId not present locally or in worktree', () => {
    const pm = new ProcessManager({ worcaDir: parentWorca });
    expect(pm.getRunningPid('nonexistent-run-id')).toBeNull();
  });

  it('still finds local runs/<id>/pipeline.pid (no worktree overlay needed)', () => {
    const localRunDir = join(parentWorca, 'runs', runId);
    mkdirSync(localRunDir, { recursive: true });
    writeFileSync(join(localRunDir, 'pipeline.pid'), String(process.pid));

    const pm = new ProcessManager({ worcaDir: parentWorca });
    const result = pm.getRunningPid(runId);

    expect(result).not.toBeNull();
    expect(result.pid).toBe(process.pid);
  });
});
