import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcileStatus } from '../process-manager.js';

function makeTmpDir() {
  const d = join(
    tmpdir(),
    `worca-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writeStatus(worcaDir, runId, status) {
  const runDir = join(worcaDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'status.json'),
    `${JSON.stringify(status, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(worcaDir, 'active_run'), runId, 'utf8');
}

function readStatus(worcaDir, runId) {
  return JSON.parse(
    readFileSync(join(worcaDir, 'runs', runId, 'status.json'), 'utf8'),
  );
}

describe('reconcileStatus', () => {
  let worcaDir;

  beforeEach(() => {
    worcaDir = makeTmpDir();
  });
  afterEach(() => rmSync(worcaDir, { recursive: true, force: true }));

  it('fixes stale running status when process is dead', () => {
    writeStatus(worcaDir, 'run-001', {
      pipeline_status: 'running',
      stage: 'plan',
    });
    // No PID file → getRunningPid returns null → process is "dead"

    const fixed = reconcileStatus(worcaDir);

    expect(fixed).toBe(true);
    const status = readStatus(worcaDir, 'run-001');
    expect(status.pipeline_status).toBe('failed');
    expect(status.stop_reason).toBe('stale');
  });

  it('does not change status when process is alive (per-run PID)', () => {
    writeStatus(worcaDir, 'run-002', {
      pipeline_status: 'running',
      stage: 'test',
    });
    // Write a per-run PID file pointing to our own PID (which is alive)
    writeFileSync(
      join(worcaDir, 'runs', 'run-002', 'pipeline.pid'),
      String(process.pid),
      'utf8',
    );

    const fixed = reconcileStatus(worcaDir);

    expect(fixed).toBe(false);
    const status = readStatus(worcaDir, 'run-002');
    expect(status.pipeline_status).toBe('running');
  });

  it('does not change status when process is alive (project-level PID)', () => {
    writeStatus(worcaDir, 'run-002b', {
      pipeline_status: 'running',
      stage: 'test',
    });
    // Write a project-level PID file (backward compat)
    writeFileSync(join(worcaDir, 'pipeline.pid'), String(process.pid), 'utf8');

    const fixed = reconcileStatus(worcaDir);

    expect(fixed).toBe(false);
    const status = readStatus(worcaDir, 'run-002b');
    expect(status.pipeline_status).toBe('running');
  });

  it('does not change status when already failed', () => {
    writeStatus(worcaDir, 'run-003', {
      pipeline_status: 'failed',
      stop_reason: 'pipeline_error',
      stage: 'test',
    });

    const fixed = reconcileStatus(worcaDir);

    expect(fixed).toBe(false);
    const status = readStatus(worcaDir, 'run-003');
    expect(status.pipeline_status).toBe('failed');
    expect(status.stop_reason).toBe('pipeline_error');
  });

  it('preserves existing stop_reason when fixing stale status', () => {
    writeStatus(worcaDir, 'run-004', {
      pipeline_status: 'running',
      stop_reason: 'signal',
      stage: 'implement',
    });

    const fixed = reconcileStatus(worcaDir);

    expect(fixed).toBe(true);
    const status = readStatus(worcaDir, 'run-004');
    expect(status.pipeline_status).toBe('failed');
    expect(status.stop_reason).toBe('signal'); // preserved, not overwritten to "stale"
  });

  it('returns false when no active_run file exists and no per-run PIDs', () => {
    // worcaDir exists but no active_run file and no per-run PIDs
    const fixed = reconcileStatus(worcaDir);
    expect(fixed).toBe(false);
  });

  it('fixes multiple stale runs with per-run PID files', () => {
    // Two runs both with stale PID files (non-existent PIDs)
    writeStatus(worcaDir, 'run-multi-1', {
      pipeline_status: 'running',
      stage: 'plan',
    });
    writeFileSync(
      join(worcaDir, 'runs', 'run-multi-1', 'pipeline.pid'),
      '999999999',
      'utf8',
    );

    writeStatus(worcaDir, 'run-multi-2', {
      pipeline_status: 'running',
      stage: 'implement',
    });
    writeFileSync(
      join(worcaDir, 'runs', 'run-multi-2', 'pipeline.pid'),
      '999999998',
      'utf8',
    );

    // active_run points to run-multi-2 only (but both should be reconciled)
    writeFileSync(join(worcaDir, 'active_run'), 'run-multi-2', 'utf8');

    const fixed = reconcileStatus(worcaDir);

    expect(fixed).toBe(true);
    expect(readStatus(worcaDir, 'run-multi-1').pipeline_status).toBe('failed');
    expect(readStatus(worcaDir, 'run-multi-1').stop_reason).toBe('stale');
    expect(readStatus(worcaDir, 'run-multi-2').pipeline_status).toBe('failed');
    expect(readStatus(worcaDir, 'run-multi-2').stop_reason).toBe('stale');
  });
});
