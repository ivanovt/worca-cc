import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessManager } from '../process-manager.js';

function makeTmpDir() {
  const d = join(
    tmpdir(),
    `worca-noar-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function makeRun(worcaDir, runId, status) {
  const runDir = join(worcaDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'status.json'),
    `${JSON.stringify(status, null, 2)}\n`,
    'utf8',
  );
  return runDir;
}

describe('deleteRun — no active_run cleanup', () => {
  let worcaDir;

  beforeEach(() => {
    worcaDir = makeTmpDir();
  });
  afterEach(() => rmSync(worcaDir, { recursive: true, force: true }));

  it('deletes the run dir without touching any active_run file', () => {
    const runId = 'run-del-001';
    makeRun(worcaDir, runId, { pipeline_status: 'completed' });
    const activeRunPath = join(worcaDir, 'active_run');
    writeFileSync(activeRunPath, runId, 'utf8');

    const pm = new ProcessManager({ worcaDir, projectRoot: worcaDir });
    pm.deleteRun(runId);

    // Run dir is gone
    expect(existsSync(join(worcaDir, 'runs', runId))).toBe(false);
    // active_run is untouched (no longer managed by deleteRun)
    expect(existsSync(activeRunPath)).toBe(true);
  });
});

describe('restartStage — runId as first param', () => {
  let worcaDir;

  beforeEach(() => {
    worcaDir = makeTmpDir();
    // Create the pipeline script so restartStage reaches status/stage checks
    const scriptDir = join(worcaDir, '.claude', 'worca', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, 'run_pipeline.py'), '# stub', 'utf8');
  });
  afterEach(() => rmSync(worcaDir, { recursive: true, force: true }));

  it('throws stage_not_found when runId refers to run with no matching stage', async () => {
    const runId = 'run-rs-001';
    makeRun(worcaDir, runId, {
      pipeline_status: 'failed',
      stages: { plan: { status: 'completed' } },
    });

    const pm = new ProcessManager({ worcaDir, projectRoot: worcaDir });
    await expect(pm.restartStage(runId, 'nonexistent')).rejects.toMatchObject({
      code: 'stage_not_found',
    });
  });

  it('throws stage_not_error when stage is not in error state', async () => {
    const runId = 'run-rs-002';
    makeRun(worcaDir, runId, {
      pipeline_status: 'failed',
      stages: { plan: { status: 'completed' } },
    });

    const pm = new ProcessManager({ worcaDir, projectRoot: worcaDir });
    await expect(pm.restartStage(runId, 'plan')).rejects.toMatchObject({
      code: 'stage_not_error',
    });
  });

  it('throws no_status when runId directory does not contain status.json', async () => {
    const runId = 'run-rs-003';
    // Create run dir but no status.json
    mkdirSync(join(worcaDir, 'runs', runId), { recursive: true });

    const pm = new ProcessManager({ worcaDir, projectRoot: worcaDir });
    await expect(pm.restartStage(runId, 'plan')).rejects.toMatchObject({
      code: 'no_status',
    });
  });

  it('throws no_status when runId directory does not exist', async () => {
    const pm = new ProcessManager({ worcaDir, projectRoot: worcaDir });
    await expect(
      pm.restartStage('run-nonexistent', 'plan'),
    ).rejects.toMatchObject({
      code: 'no_status',
    });
  });
});
