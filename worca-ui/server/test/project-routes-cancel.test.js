import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStopPipelineSync = vi.fn();
const mockDispatchExternal = vi.fn(() => Promise.resolve({ ok: true }));

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
    stopPipeline() {
      return { pid: 1 };
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

vi.mock('../dispatch-external.js', () => ({
  dispatchExternal: (...args) => mockDispatchExternal(...args),
}));

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

function writeStatus(worcaDir, runId, status) {
  const runsDir = join(worcaDir, 'runs', runId);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, 'status.json'), JSON.stringify(status));
  return join(runsDir, 'status.json');
}

describe('POST /api/runs/:id/cancel', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cancel-'));
    mockStopPipelineSync.mockReset();
    mockDispatchExternal.mockReset();
    mockDispatchExternal.mockResolvedValue({ ok: true });
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 400 for invalid runId', async () => {
    const res = await fetch(`${base}/api/runs/bad%2F..run/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when run does not exist', async () => {
    const res = await fetch(`${base}/api/runs/no-such-run/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns already for completed runs', async () => {
    writeStatus(tmpDir, 'run-done', { pipeline_status: 'completed' });
    const res = await fetch(`${base}/api/runs/run-done/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.already).toBe('completed');
    expect(mockDispatchExternal).not.toHaveBeenCalled();
  });

  it('returns already for cancelled runs', async () => {
    writeStatus(tmpDir, 'run-x', { pipeline_status: 'cancelled' });
    const res = await fetch(`${base}/api/runs/run-x/cancel`, {
      method: 'POST',
    });
    const data = await res.json();
    expect(data.already).toBe('cancelled');
    expect(mockDispatchExternal).not.toHaveBeenCalled();
  });

  it('calls stopPipelineSync when status is running', async () => {
    writeStatus(tmpDir, 'run-live', {
      pipeline_status: 'running',
      stage: 'implement',
      started_at: new Date().toISOString(),
    });
    mockStopPipelineSync.mockResolvedValue({ pid: 123, exitCode: null });

    const res = await fetch(`${base}/api/runs/run-live/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(mockStopPipelineSync).toHaveBeenCalledWith('run-live', {
      timeoutMs: 5000,
    });

    const st = JSON.parse(
      readFileSync(join(tmpDir, 'runs', 'run-live', 'status.json'), 'utf8'),
    );
    expect(st.pipeline_status).toBe('cancelled');
    expect(st.stop_reason).toBe('force_cancelled');
  });

  it('continues cancel even if stopPipelineSync throws (already dead)', async () => {
    writeStatus(tmpDir, 'run-dead', {
      pipeline_status: 'running',
      started_at: new Date().toISOString(),
    });
    mockStopPipelineSync.mockRejectedValue(
      Object.assign(new Error('No running process'), { code: 'not_running' }),
    );

    const res = await fetch(`${base}/api/runs/run-dead/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled).toBe(true);
  });

  it('cancels paused run without calling stopPipelineSync', async () => {
    writeStatus(tmpDir, 'run-paused', {
      pipeline_status: 'paused',
      stage: 'test',
      started_at: new Date().toISOString(),
    });

    const res = await fetch(`${base}/api/runs/run-paused/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(mockStopPipelineSync).not.toHaveBeenCalled();

    const st = JSON.parse(
      readFileSync(join(tmpDir, 'runs', 'run-paused', 'status.json'), 'utf8'),
    );
    expect(st.pipeline_status).toBe('cancelled');
  });

  it('cancels failed run (actionAllowed permits it)', async () => {
    writeStatus(tmpDir, 'run-fail', {
      pipeline_status: 'failed',
      started_at: new Date().toISOString(),
    });

    const res = await fetch(`${base}/api/runs/run-fail/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled).toBe(true);
  });

  it('cancels interrupted run', async () => {
    writeStatus(tmpDir, 'run-int', {
      pipeline_status: 'interrupted',
      started_at: new Date().toISOString(),
    });

    const res = await fetch(`${base}/api/runs/run-int/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled).toBe(true);
  });

  it('cancels pending run', async () => {
    writeStatus(tmpDir, 'run-pend', {
      pipeline_status: 'pending',
      started_at: new Date().toISOString(),
    });

    const res = await fetch(`${base}/api/runs/run-pend/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled).toBe(true);
  });

  it('writes cancelled status and completed_at to status.json', async () => {
    writeStatus(tmpDir, 'run-w', {
      pipeline_status: 'paused',
      stage: 'review',
      started_at: '2025-01-01T00:00:00.000Z',
    });

    await fetch(`${base}/api/runs/run-w/cancel`, { method: 'POST' });

    const st = JSON.parse(
      readFileSync(join(tmpDir, 'runs', 'run-w', 'status.json'), 'utf8'),
    );
    expect(st.pipeline_status).toBe('cancelled');
    expect(st.stop_reason).toBe('force_cancelled');
    expect(st.completed_at).toBeTruthy();
  });

  it('calls dispatchExternal with pipeline.run.cancelled', async () => {
    writeStatus(tmpDir, 'run-disp', {
      pipeline_status: 'paused',
      stage: 'test',
      started_at: '2025-01-01T00:00:00.000Z',
    });

    await fetch(`${base}/api/runs/run-disp/cancel`, { method: 'POST' });

    expect(mockDispatchExternal).toHaveBeenCalledTimes(1);
    const call = mockDispatchExternal.mock.calls[0][0];
    expect(call.eventType).toBe('pipeline.run.cancelled');
    expect(call.payload.source).toBe('user_cancel');
    expect(call.payload.cancelled_stage).toBe('test');
    expect(typeof call.payload.elapsed_ms).toBe('number');
  });

  it('responds before dispatchExternal resolves', async () => {
    writeStatus(tmpDir, 'run-async', {
      pipeline_status: 'paused',
      started_at: new Date().toISOString(),
    });

    let resolveDispatch;
    mockDispatchExternal.mockReturnValue(
      new Promise((r) => {
        resolveDispatch = r;
      }),
    );

    const res = await fetch(`${base}/api/runs/run-async/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled).toBe(true);

    resolveDispatch({ ok: true });
  });

  it('broadcasts run-cancelled via WebSocket', async () => {
    if (server) await stopServer(server);

    const broadcasts = [];
    const app = createApp({ worcaDir: tmpDir });
    app.locals.broadcast = (ev, data) => broadcasts.push({ ev, data });
    const srv = createServer(app);
    const localBase = await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    server = srv;

    writeStatus(tmpDir, 'run-bc', {
      pipeline_status: 'paused',
      started_at: new Date().toISOString(),
    });

    await fetch(`${localBase}/api/runs/run-bc/cancel`, { method: 'POST' });

    expect(broadcasts.some((b) => b.ev === 'run-cancelled')).toBe(true);
  });
});
