import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

function startServer(prefsDir) {
  const app = createApp({ prefsDir });
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({ server, base });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function writeProjectWithRun(prefsDir, name, runId, status) {
  const projectDir = join(prefsDir, `_proj_${name}`);
  const runsDir = join(projectDir, '.worca', 'runs', runId);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, 'status.json'), JSON.stringify(status));
  const projectsDir = join(prefsDir, 'projects.d');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    join(projectsDir, `${name}.json`),
    JSON.stringify({ path: projectDir }),
  );
}

describe('GET /api/status/runs-count', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'status-routes-test-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok, totalRunning, and cap', async () => {
    const res = await fetch(`${base}/api/status/runs-count`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.totalRunning).toBe('number');
    expect(typeof data.cap).toBe('number');
  });

  it('returns default cap of 10 when no global settings exist', async () => {
    const res = await fetch(`${base}/api/status/runs-count`);
    const data = await res.json();
    expect(data.cap).toBe(10);
    expect(data.totalRunning).toBe(0);
  });

  it('reads cap from global settings', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: { parallel: { max_concurrent_pipelines: 5 } },
      }),
    );
    const res = await fetch(`${base}/api/status/runs-count`);
    const data = await res.json();
    expect(data.cap).toBe(5);
  });

  it('counts only liveness-checked running pipelines', async () => {
    writeProjectWithRun(tmpDir, 'proj1', 'run-1', {
      pipeline_status: 'running',
      pid: process.pid,
    });
    writeProjectWithRun(tmpDir, 'proj2', 'run-2', {
      pipeline_status: 'completed',
      pid: process.pid,
    });

    const res = await fetch(`${base}/api/status/runs-count`);
    const data = await res.json();
    expect(data.totalRunning).toBe(1);
  });

  it('does not count stale PIDs', async () => {
    writeProjectWithRun(tmpDir, 'proj1', 'run-1', {
      pipeline_status: 'running',
      pid: 999999999,
    });

    const res = await fetch(`${base}/api/status/runs-count`);
    const data = await res.json();
    expect(data.totalRunning).toBe(0);
  });

  it('is not mounted when prefsDir is not configured', async () => {
    const app = createApp({});
    const srv = createServer(app);
    const { port } = await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve(srv.address()));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status/runs-count`);
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        expect(data).not.toHaveProperty('totalRunning');
      }
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});
