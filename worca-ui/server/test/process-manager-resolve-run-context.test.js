import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessManager } from '../process-manager.js';

function makeTmpDir() {
  const d = join(
    tmpdir(),
    `worca-rrc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

describe('resolveRunContext', () => {
  let worcaDir;
  const extra = [];

  beforeEach(() => {
    worcaDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(worcaDir, { recursive: true, force: true });
    for (const d of extra) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    extra.length = 0;
  });

  it('resolveRunContext_root: resolves run in root runs/ directory', () => {
    const runId = 'run-root-001';
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({ pipeline_status: 'running' }),
      'utf8',
    );

    const pm = new ProcessManager({ worcaDir });
    const ctx = pm.resolveRunContext(runId);

    expect(ctx).not.toBeNull();
    expect(ctx.worcaDir).toBe(worcaDir);
    expect(ctx.runDir).toBe(runDir);
  });

  it('resolveRunContext_worktree: resolves run from pipelines.d/ registry entry', () => {
    const runId = 'run-wt-001';
    const worktreePath = makeTmpDir();
    extra.push(worktreePath);

    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreePath }),
      'utf8',
    );

    const pm = new ProcessManager({ worcaDir });
    const ctx = pm.resolveRunContext(runId);

    const expectedWorcaDir = join(worktreePath, '.worca');
    expect(ctx).not.toBeNull();
    expect(ctx.worcaDir).toBe(expectedWorcaDir);
    expect(ctx.runDir).toBe(join(expectedWorcaDir, 'runs', runId));
  });

  it('returns null when run is not in root runs/ and has no pipelines.d/ entry', () => {
    const pm = new ProcessManager({ worcaDir });
    expect(pm.resolveRunContext('nonexistent-run')).toBeNull();
  });

  it('returns null when pipelines.d/ entry has no worktree_path', () => {
    const runId = 'run-noreg-001';
    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({ run_id: runId }),
      'utf8',
    );

    const pm = new ProcessManager({ worcaDir });
    expect(pm.resolveRunContext(runId)).toBeNull();
  });

  it('prefers root runs/ over pipelines.d/ when both exist', () => {
    const runId = 'run-both-001';
    const worktreePath = makeTmpDir();
    extra.push(worktreePath);

    // Root run exists
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({ pipeline_status: 'running' }),
      'utf8',
    );

    // pipelines.d/ entry also exists
    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreePath }),
      'utf8',
    );

    const pm = new ProcessManager({ worcaDir });
    const ctx = pm.resolveRunContext(runId);

    // Root takes precedence
    expect(ctx.worcaDir).toBe(worcaDir);
    expect(ctx.runDir).toBe(runDir);
  });
});
