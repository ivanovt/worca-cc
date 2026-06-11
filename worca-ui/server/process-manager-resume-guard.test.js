/**
 * Tests: ProcessManager.startPipeline() resume double-spawn guard.
 *
 * The in-place resume path resolves on a 2s timer, not actual pipeline
 * startup, leaving a window where a second resume of the same run spawns a
 * duplicate run_pipeline.py (architecture review 2026-06). The guard:
 *   1. refuses to resume a run whose pipeline.pid is alive, and
 *   2. refuses a resume while another resume of the same run is in flight.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Build a fake child process with exit/error emitters. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  child.removeAllListeners =
    EventEmitter.prototype.removeAllListeners.bind(child);
  return child;
}

// A PID that is certainly not a live process (far above typical pid_max);
// process.kill(pid, 0) throws, which getRunningPid treats as stale.
const DEAD_PID = 2147483646;

describe('startPipeline() resume double-spawn guard', () => {
  let worcaDir;
  let projectRoot;
  let pm;

  beforeEach(() => {
    const base = join(
      tmpdir(),
      `worca-pm-rg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    projectRoot = join(base, 'project');
    worcaDir = join(projectRoot, '.worca');
    mkdirSync(join(worcaDir, 'runs', 'run-001'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude', 'worca', 'scripts'), {
      recursive: true,
    });
    writeFileSync(
      join(projectRoot, '.claude/worca/scripts/run_pipeline.py'),
      '# stub\n',
    );
    writeFileSync(
      join(worcaDir, 'runs', 'run-001', 'status.json'),
      JSON.stringify({ run_id: 'run-001', pipeline_status: 'interrupted' }),
    );
    pm = new ProcessManager({ worcaDir, projectRoot });
    nextChild = makeFakeChild();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(join(projectRoot, '..'), { recursive: true, force: true });
  });

  it('refuses resume when the run already has a live pipeline process', async () => {
    writeFileSync(
      join(worcaDir, 'runs', 'run-001', 'pipeline.pid'),
      `${process.pid}\n`,
    );

    await expect(
      pm.startPipeline({ resume: true, runId: 'run-001', projectRoot }),
    ).rejects.toMatchObject({ code: 'already_running' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('allows resume when the pid file is stale (dead pid)', async () => {
    vi.useFakeTimers();
    writeFileSync(
      join(worcaDir, 'runs', 'run-001', 'pipeline.pid'),
      `${DEAD_PID}\n`,
    );

    const p = pm.startPipeline({
      resume: true,
      runId: 'run-001',
      projectRoot,
    });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    await expect(p).resolves.toMatchObject({ pid: 4242 });
  });

  it('rejects a concurrent resume of the same run', async () => {
    vi.useFakeTimers();

    const first = pm.startPipeline({
      resume: true,
      runId: 'run-001',
      projectRoot,
    });
    const second = pm.startPipeline({
      resume: true,
      runId: 'run-001',
      projectRoot,
    });

    await expect(second).rejects.toMatchObject({ code: 'already_running' });
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    await expect(first).resolves.toMatchObject({ pid: 4242 });
  });

  it('releases the in-flight guard after the first resume settles', async () => {
    vi.useFakeTimers();

    const first = pm.startPipeline({
      resume: true,
      runId: 'run-001',
      projectRoot,
    });
    vi.advanceTimersByTime(2000);
    await first;

    // No live pid file was written (spawn is mocked) — a later resume must
    // be allowed again once the first settled.
    nextChild = makeFakeChild();
    const again = pm.startPipeline({
      resume: true,
      runId: 'run-001',
      projectRoot,
    });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    await expect(again).resolves.toMatchObject({ pid: 4242 });
  });

  it('does not guard distinct runs against each other', async () => {
    vi.useFakeTimers();
    mkdirSync(join(worcaDir, 'runs', 'run-002'), { recursive: true });
    writeFileSync(
      join(worcaDir, 'runs', 'run-002', 'status.json'),
      JSON.stringify({ run_id: 'run-002', pipeline_status: 'interrupted' }),
    );

    const a = pm.startPipeline({
      resume: true,
      runId: 'run-001',
      projectRoot,
    });
    nextChild = makeFakeChild();
    const b = pm.startPipeline({
      resume: true,
      runId: 'run-002',
      projectRoot,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    await expect(a).resolves.toBeTruthy();
    await expect(b).resolves.toBeTruthy();
    expect(existsSync(join(worcaDir, 'runs', 'run-001'))).toBe(true);
  });
});
