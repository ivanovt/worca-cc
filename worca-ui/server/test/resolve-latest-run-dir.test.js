import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLatestRunDir } from '../ws-status-watcher.js';

describe('resolveLatestRunDir', () => {
  let worcaDir;

  beforeEach(() => {
    worcaDir = join(
      tmpdir(),
      `worca-rslrd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(worcaDir, { recursive: true });
  });

  afterEach(() => rmSync(worcaDir, { recursive: true, force: true }));

  it('returns worcaDir when no runs/ directory exists', () => {
    expect(resolveLatestRunDir(worcaDir)).toBe(worcaDir);
  });

  it('returns worcaDir when runs/ is empty', () => {
    mkdirSync(join(worcaDir, 'runs'), { recursive: true });
    expect(resolveLatestRunDir(worcaDir)).toBe(worcaDir);
  });

  it('returns worcaDir when run has no pipeline.pid file', () => {
    const runDir = join(worcaDir, 'runs', 'run-001');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({ pipeline_status: 'running' }),
    );
    expect(resolveLatestRunDir(worcaDir)).toBe(worcaDir);
  });

  it('returns worcaDir when pipeline.pid references a dead process', () => {
    const runDir = join(worcaDir, 'runs', 'run-002');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'pipeline.pid'), '999999999', 'utf8');
    expect(resolveLatestRunDir(worcaDir)).toBe(worcaDir);
  });

  it('returns the run dir when pipeline.pid references a live process', () => {
    const runId = 'run-003';
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'pipeline.pid'), String(process.pid), 'utf8');
    expect(resolveLatestRunDir(worcaDir)).toBe(runDir);
  });

  it('returns the latest run dir (by name) when multiple live processes exist', () => {
    const runIds = ['run-2026-01-01', 'run-2026-06-01', 'run-2026-03-01'];
    for (const id of runIds) {
      const dir = join(worcaDir, 'runs', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'pipeline.pid'), String(process.pid), 'utf8');
    }
    expect(resolveLatestRunDir(worcaDir)).toBe(
      join(worcaDir, 'runs', 'run-2026-06-01'),
    );
  });

  it('skips run dirs with invalid PID values', () => {
    const runDir = join(worcaDir, 'runs', 'run-bad-pid');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'pipeline.pid'), 'not-a-number', 'utf8');
    expect(resolveLatestRunDir(worcaDir)).toBe(worcaDir);
  });

  it('worktree-only project returns worktree runDir', () => {
    // No local runs/ at all; only a pipelines.d/ worktree registration with live PID
    const wtDir = join(worcaDir, 'worktree-only-dir');
    const runId = 'run-wt-latest-001';
    const wtRunDir = join(wtDir, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(join(wtRunDir, 'pipeline.pid'), String(process.pid), 'utf8');

    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: wtDir }),
      'utf8',
    );

    // FAILS with current code: current impl only looks in worcaDir/runs/ and
    // falls back to worcaDir when nothing is found there.
    expect(resolveLatestRunDir(worcaDir)).toBe(wtRunDir);
  });

  it('mixed local+worktree returns newest live-PID dir', () => {
    // Local run (older ID, alphabetically earlier)
    const localRunId = 'run-2026-01-01-local';
    const localRunDir = join(worcaDir, 'runs', localRunId);
    mkdirSync(localRunDir, { recursive: true });
    writeFileSync(
      join(localRunDir, 'pipeline.pid'),
      String(process.pid),
      'utf8',
    );

    // Worktree run (newer ID, alphabetically later → should win)
    const wtRunId = 'run-2026-06-01-worktree';
    const wtDir = join(worcaDir, 'worktree-newer-dir');
    const wtRunDir = join(wtDir, '.worca', 'runs', wtRunId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(join(wtRunDir, 'pipeline.pid'), String(process.pid), 'utf8');

    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${wtRunId}.json`),
      JSON.stringify({ run_id: wtRunId, worktree_path: wtDir }),
      'utf8',
    );

    // FAILS with current code: returns localRunDir because the worktree run
    // is invisible (pipelines.d/ is never consulted).
    expect(resolveLatestRunDir(worcaDir)).toBe(wtRunDir);
  });
});
