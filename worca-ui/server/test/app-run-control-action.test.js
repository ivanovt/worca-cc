import {
  existsSync,
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
    stopPipelineSync() {
      return Promise.resolve({});
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
      resolve({ server, base: `http://127.0.0.1:${port}`, app });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('POST /api/runs/:id/control', () => {
  let tmpDir, server, base;

  function writeStatus(runId, statusObj, dir = 'runs') {
    const runDir = join(tmpDir, dir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify(statusObj, null, 2),
      'utf8',
    );
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'run-control-action-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes control.json with approve action', async () => {
    writeStatus('run-abc', {
      pipeline_status: 'paused',
      milestones: { pr_approved: false },
    });
    const res = await fetch(`${base}/api/runs/run-abc/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', source: 'ui-pr-approval' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const controlPath = join(tmpDir, 'runs', 'run-abc', 'control.json');
    expect(existsSync(controlPath)).toBe(true);
    const control = JSON.parse(readFileSync(controlPath, 'utf8'));
    expect(control.action).toBe('approve');
    expect(control.source).toBe('ui-pr-approval');
    expect(control.requested_at).toBeDefined();
  });

  it('writes control.json with reject action', async () => {
    writeStatus('run-abc', {
      pipeline_status: 'paused',
      milestones: { pr_approved: false },
    });
    const res = await fetch(`${base}/api/runs/run-abc/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const controlPath = join(tmpDir, 'runs', 'run-abc', 'control.json');
    const control = JSON.parse(readFileSync(controlPath, 'utf8'));
    expect(control.action).toBe('reject');
  });

  it('returns 404 when run not found', async () => {
    const res = await fetch(`${base}/api/runs/nonexistent/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('returns 409 when run is not paused', async () => {
    writeStatus('run-abc', { pipeline_status: 'running' });
    const res = await fetch(`${base}/api/runs/run-abc/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('returns 409 when run is completed', async () => {
    writeStatus('run-abc', { pipeline_status: 'completed' });
    const res = await fetch(`${base}/api/runs/run-abc/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('returns 400 for invalid action', async () => {
    writeStatus('run-abc', { pipeline_status: 'paused' });
    const res = await fetch(`${base}/api/runs/run-abc/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invalid' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('returns 400 for missing action', async () => {
    writeStatus('run-abc', { pipeline_status: 'paused' });
    const res = await fetch(`${base}/api/runs/run-abc/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid runId', async () => {
    const res = await fetch(`${base}/api/runs/../../../etc/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect([400, 404]).toContain(res.status);
  });
});
