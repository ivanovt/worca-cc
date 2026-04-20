import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    getRunningPid() {
      return null;
    }
    reconcileStatus() {
      return false;
    }
    restartStage() {}
    deleteRun(runId) {
      const runDir = join(this.worcaDir, 'runs', runId);
      if (!existsSync(runDir)) {
        const err = new Error(`Run "${runId}" not found`);
        err.code = 'not_found';
        throw err;
      }
      rmSync(runDir, { recursive: true, force: true });
      return { deleted: true };
    }
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

function writeStatus(worcaDir, runId, status) {
  const runDir = join(worcaDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'status.json'),
    JSON.stringify(status, null, 2),
    'utf8',
  );
}

describe('POST /api/runs/:id/delete', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'del-run-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes a completed run and returns ok', async () => {
    writeStatus(tmpDir, 'run-1', { pipeline_status: 'completed' });
    const res = await fetch(`${base}/api/runs/run-1/delete`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(true);
    expect(body.runId).toBe('run-1');
    expect(existsSync(join(tmpDir, 'runs', 'run-1'))).toBe(false);
  });

  it('deletes a failed run', async () => {
    writeStatus(tmpDir, 'run-2', { pipeline_status: 'failed' });
    const res = await fetch(`${base}/api/runs/run-2/delete`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('deletes a cancelled run', async () => {
    writeStatus(tmpDir, 'run-3', { pipeline_status: 'cancelled' });
    const res = await fetch(`${base}/api/runs/run-3/delete`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('deletes a paused run', async () => {
    writeStatus(tmpDir, 'run-4', { pipeline_status: 'paused' });
    const res = await fetch(`${base}/api/runs/run-4/delete`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('deletes an interrupted run', async () => {
    writeStatus(tmpDir, 'run-5', { pipeline_status: 'interrupted' });
    const res = await fetch(`${base}/api/runs/run-5/delete`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('rejects delete on a running pipeline with 409', async () => {
    writeStatus(tmpDir, 'run-6', { pipeline_status: 'running' });
    const res = await fetch(`${base}/api/runs/run-6/delete`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('action_not_allowed');
  });

  it('returns 404 for non-existent run', async () => {
    const res = await fetch(`${base}/api/runs/no-such-run/delete`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid runId', async () => {
    const res = await fetch(`${base}/api/runs/bad%20id!/delete`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });
});
