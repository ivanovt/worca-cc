import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findRunStatusPath,
  listPlanIterations,
  resolveRunDir,
} from './run-dir-resolver.js';

describe('resolveRunDir', () => {
  let worcaDir;
  let worktreeRoot;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    worcaDir = join(tmpdir(), `worca-rdr-${stamp}`);
    worktreeRoot = join(tmpdir(), `worca-rdr-wt-${stamp}`);
    mkdirSync(worcaDir, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(worcaDir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('returns local runs/<id> when present', () => {
    const runId = '20260317-084204-001-aaaa';
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });

    expect(resolveRunDir(worcaDir, runId)).toBe(runDir);
  });

  it('returns local results/<id> when run was archived', () => {
    const runId = '20260317-084204-001-bbbb';
    const resultsDir = join(worcaDir, 'results', runId);
    mkdirSync(resultsDir, { recursive: true });

    expect(resolveRunDir(worcaDir, runId)).toBe(resultsDir);
  });

  it('returns worktree-overlay runs/<id> when registered in pipelines.d', () => {
    const runId = '20260317-084204-001-cccc';
    const wtRunDir = join(worktreeRoot, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });

    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreeRoot, pid: 1 }),
    );

    expect(resolveRunDir(worcaDir, runId)).toBe(wtRunDir);
  });

  it('returns null when nothing matches', () => {
    expect(resolveRunDir(worcaDir, '20260317-000000-001-zzzz')).toBeNull();
  });

  it('prefers local runs/<id> over worktree overlay (defensive: same id)', () => {
    const runId = '20260317-084204-001-dddd';
    const localRunDir = join(worcaDir, 'runs', runId);
    mkdirSync(localRunDir, { recursive: true });

    const wtRunDir = join(worktreeRoot, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreeRoot, pid: 1 }),
    );

    expect(resolveRunDir(worcaDir, runId)).toBe(localRunDir);
  });

  it('ignores malformed pipelines.d entries', () => {
    const runId = '20260317-084204-001-eeee';
    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(join(pipelinesDir, `${runId}.json`), 'not json');

    expect(resolveRunDir(worcaDir, runId)).toBeNull();
  });

  it('ignores pipelines.d entry with missing worktree_path', () => {
    const runId = '20260317-084204-001-ffff';
    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({ run_id: runId, pid: 1 }),
    );

    expect(resolveRunDir(worcaDir, runId)).toBeNull();
  });
});

describe('findRunStatusPath', () => {
  let worcaDir;
  let worktreeRoot;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    worcaDir = join(tmpdir(), `worca-frsp-${stamp}`);
    worktreeRoot = join(tmpdir(), `worca-frsp-wt-${stamp}`);
    mkdirSync(worcaDir, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(worcaDir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('returns local runs/<id>/status.json when present', () => {
    const runId = '20260317-084204-001-aaaa';
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const statusPath = join(runDir, 'status.json');
    writeFileSync(statusPath, '{}');

    expect(findRunStatusPath(worcaDir, runId)).toBe(statusPath);
  });

  it('returns worktree status.json when run is in pipelines.d', () => {
    const runId = '20260317-084204-001-cccc';
    const wtRunDir = join(worktreeRoot, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    const statusPath = join(wtRunDir, 'status.json');
    writeFileSync(statusPath, '{}');

    const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreeRoot, pid: 1 }),
    );

    expect(findRunStatusPath(worcaDir, runId)).toBe(statusPath);
  });

  it('returns null when run dir exists but status.json does not', () => {
    const runId = '20260317-084204-001-bbbb';
    mkdirSync(join(worcaDir, 'runs', runId), { recursive: true });

    expect(findRunStatusPath(worcaDir, runId)).toBeNull();
  });

  it('returns legacy results/<id>.json file format', () => {
    const runId = '20260317-084204-001-dddd';
    mkdirSync(join(worcaDir, 'results'), { recursive: true });
    const statusPath = join(worcaDir, 'results', `${runId}.json`);
    writeFileSync(statusPath, '{}');

    expect(findRunStatusPath(worcaDir, runId)).toBe(statusPath);
  });
});

describe('listPlanIterations', () => {
  let runDir;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    runDir = join(tmpdir(), `worca-plan-iter-${stamp}`);
    mkdirSync(runDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it('returns [] for a missing dir', () => {
    expect(listPlanIterations(join(runDir, 'nope'))).toEqual([]);
  });

  it('returns [] when no plan files exist', () => {
    writeFileSync(join(runDir, 'status.json'), '{}');
    expect(listPlanIterations(runDir)).toEqual([]);
  });

  it('lists numbered plan files ascending and ignores non-matching files', () => {
    // Intentionally out of order on disk; only plan-NNN.md (3-digit) match.
    writeFileSync(join(runDir, 'plan-002.md'), 'rev 2');
    writeFileSync(join(runDir, 'plan-001.md'), 'original');
    writeFileSync(join(runDir, 'plan-010.md'), 'rev 10');
    writeFileSync(join(runDir, 'plan.md'), 'not numbered');
    writeFileSync(join(runDir, 'plan-1.md'), 'wrong digits');
    writeFileSync(join(runDir, 'status.json'), '{}');

    const iters = listPlanIterations(runDir);
    expect(iters.map((it) => it.n)).toEqual([1, 2, 10]);
    expect(iters.map((it) => it.file)).toEqual([
      'plan-001.md',
      'plan-002.md',
      'plan-010.md',
    ]);
    expect(iters[0].path).toBe(join(runDir, 'plan-001.md'));
    // latest = last element
    expect(iters[iters.length - 1].n).toBe(10);
  });

  it('returns [] for null/empty input', () => {
    expect(listPlanIterations(null)).toEqual([]);
    expect(listPlanIterations('')).toEqual([]);
  });
});
