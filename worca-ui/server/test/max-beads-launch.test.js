import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStartPipeline = vi.fn().mockResolvedValue({ pid: 12345 });

vi.mock('../process-manager.js', () => {
  class ProcessManager {
    constructor(opts = {}) {
      this.worcaDir = opts.worcaDir;
      this.projectRoot = opts.projectRoot;
    }
    startPipeline(opts) {
      return mockStartPipeline(opts);
    }
    getRunningPid() {
      return null;
    }
    reconcileStatus() {
      return false;
    }
  }
  return { ProcessManager };
});

vi.mock('../process-registry.js', () => ({
  countRunningPipelinesAcrossProjects: () => 0,
}));

const { createApp } = await import('../app.js');

function startServer(prefsDir, projectRoot) {
  const app = createApp({ prefsDir, projectRoot });
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

async function postRun(base, projectName, body) {
  return fetch(`${base}/api/projects/${projectName}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/projects/:id/runs - maxBeads', () => {
  let prefsDir, projectRoot, server, base;

  beforeEach(async () => {
    prefsDir = mkdtempSync(join(tmpdir(), 'max-beads-prefs-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'max-beads-proj-'));
    mkdirSync(join(projectRoot, '.worca', 'runs'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{}');
    mkdirSync(join(prefsDir, 'projects.d'), { recursive: true });
    writeFileSync(
      join(prefsDir, 'projects.d', 'test-proj.json'),
      JSON.stringify({ name: 'test-proj', path: projectRoot }),
    );

    mockStartPipeline.mockClear();
    mockStartPipeline.mockResolvedValue({ pid: 12345 });

    ({ server, base } = await startServer(prefsDir, projectRoot));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(prefsDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('passes maxBeads to startPipeline when provided', async () => {
    const res = await postRun(base, 'test-proj', {
      prompt: 'Add feature X',
      maxBeads: 5,
    });
    expect(res.status).toBe(200);
    const call = mockStartPipeline.mock.calls[0][0];
    expect(call.maxBeads).toBe(5);
  });

  it('clamps maxBeads to 50 when above max', async () => {
    const res = await postRun(base, 'test-proj', {
      prompt: 'Add feature X',
      maxBeads: 999,
    });
    expect(res.status).toBe(200);
    const call = mockStartPipeline.mock.calls[0][0];
    expect(call.maxBeads).toBe(50);
  });

  it('clamps maxBeads to 0 when below min', async () => {
    const res = await postRun(base, 'test-proj', {
      prompt: 'Add feature X',
      maxBeads: -5,
    });
    expect(res.status).toBe(200);
    const call = mockStartPipeline.mock.calls[0][0];
    expect(call.maxBeads).toBe(0);
  });

  it('rounds fractional maxBeads', async () => {
    const res = await postRun(base, 'test-proj', {
      prompt: 'Add feature X',
      maxBeads: 3.7,
    });
    expect(res.status).toBe(200);
    const call = mockStartPipeline.mock.calls[0][0];
    expect(call.maxBeads).toBe(4);
  });

  it('omits maxBeads from startPipeline when not provided', async () => {
    const res = await postRun(base, 'test-proj', { prompt: 'Add feature X' });
    expect(res.status).toBe(200);
    const call = mockStartPipeline.mock.calls[0][0];
    expect(call.maxBeads).toBeUndefined();
  });

  it('omits maxBeads from startPipeline when null', async () => {
    const res = await postRun(base, 'test-proj', {
      prompt: 'Add feature X',
      maxBeads: null,
    });
    expect(res.status).toBe(200);
    const call = mockStartPipeline.mock.calls[0][0];
    expect(call.maxBeads).toBeUndefined();
  });
});
