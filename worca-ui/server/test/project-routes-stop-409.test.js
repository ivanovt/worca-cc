import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStopPipelineSync = vi.fn();

vi.mock('../process-manager.js', () => {
  class ProcessManager {
    constructor(opts = {}) {
      this.worcaDir = opts.worcaDir;
      this.projectRoot = opts.projectRoot;
    }
    pausePipeline() {
      return { paused: true };
    }
    startPipeline() {
      return Promise.resolve({ pid: 1 });
    }
    stopPipelineSync(runId, opts) {
      return mockStopPipelineSync(runId, opts);
    }
    getRunningPid() {
      return null;
    }
    reconcileStatus() {
      return false;
    }
    restartStage() {}
  }
  return { ProcessManager };
});

const { createApp } = await import('../app.js');

function startServer(worcaDir) {
  const app = createApp({ worcaDir });
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('POST /api/runs/:id/stop — dead PID returns 409', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stop-409-'));
    mockStopPipelineSync.mockReset();
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 409 with no_running_process when PID is dead and status is running', async () => {
    const err = new Error('No running process');
    err.code = 'not_running';
    mockStopPipelineSync.mockImplementation(() => {
      throw err;
    });

    const runsDir = join(tmpDir, 'runs', 'run-dead');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, 'status.json'),
      JSON.stringify({ pipeline_status: 'running' }),
    );

    const res = await fetch(`${base}/api/runs/run-dead/stop`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('no_running_process');
    expect(data.suggested_action).toBe('cancel');
  });

  it('returns 409 with no_running_process when PID is dead and status is paused', async () => {
    const err = new Error('No running process');
    err.code = 'not_running';
    mockStopPipelineSync.mockImplementation(() => {
      throw err;
    });

    const runsDir = join(tmpDir, 'runs', 'run-paused');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, 'status.json'),
      JSON.stringify({ pipeline_status: 'paused' }),
    );

    const res = await fetch(`${base}/api/runs/run-paused/stop`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('no_running_process');
    expect(data.suggested_action).toBe('cancel');
  });

  it('does not rewrite status.json when PID is dead', async () => {
    const err = new Error('No running process');
    err.code = 'not_running';
    mockStopPipelineSync.mockImplementation(() => {
      throw err;
    });

    const runsDir = join(tmpDir, 'runs', 'run-norewrite');
    mkdirSync(runsDir, { recursive: true });
    const original = { pipeline_status: 'running', stage: 'implement' };
    writeFileSync(join(runsDir, 'status.json'), JSON.stringify(original));

    await fetch(`${base}/api/runs/run-norewrite/stop`, { method: 'POST' });

    const { readFileSync } = await import('node:fs');
    const after = JSON.parse(
      readFileSync(join(runsDir, 'status.json'), 'utf8'),
    );
    expect(after.pipeline_status).toBe('running');
    expect(after.stop_reason).toBeUndefined();
  });

  it('returns 404 when PID is dead and no status file exists', async () => {
    const err = new Error('No running process');
    err.code = 'not_running';
    mockStopPipelineSync.mockImplementation(() => {
      throw err;
    });

    const res = await fetch(`${base}/api/runs/run-nofile/stop`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when PID is dead and status is already terminal', async () => {
    const err = new Error('No running process');
    err.code = 'not_running';
    mockStopPipelineSync.mockImplementation(() => {
      throw err;
    });

    const runsDir = join(tmpDir, 'runs', 'run-done');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, 'status.json'),
      JSON.stringify({ pipeline_status: 'completed' }),
    );

    const res = await fetch(`${base}/api/runs/run-done/stop`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 200 when stopPipeline succeeds (live PID)', async () => {
    mockStopPipelineSync.mockResolvedValue({ pid: 12345 });

    const res = await fetch(`${base}/api/runs/run-live/stop`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.stopped).toBe(true);
  });
});
