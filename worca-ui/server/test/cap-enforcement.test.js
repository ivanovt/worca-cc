import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStartPipeline = vi.fn().mockResolvedValue({ pid: 12345 });
let mockRunningPid = null;
let mockGlobalCount = 0;

vi.mock('../process-manager.js', () => {
  class ProcessManager {
    constructor(opts = {}) {
      this.worcaDir = opts.worcaDir;
      this.projectRoot = opts.projectRoot;
    }
    startPipeline(opts) {
      return mockStartPipeline(this.worcaDir, opts);
    }
    stopPipeline(runId) {
      return vi.fn()(runId);
    }
    pausePipeline(runId) {
      return vi.fn()(runId);
    }
    getRunningPid() {
      return mockRunningPid;
    }
    reconcileStatus() {
      return false;
    }
    restartStage() {
      return vi.fn()();
    }
  }
  return { ProcessManager };
});

vi.mock('../process-registry.js', () => ({
  countRunningPipelinesAcrossProjects: () => mockGlobalCount,
}));

const { createApp } = await import('../app.js');

function startServer(prefsDir, projectRoot) {
  const app = createApp({ prefsDir, projectRoot });
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

async function postRun(base, projectName, body) {
  return fetch(`${base}/api/projects/${projectName}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/projects/:id/runs - max_concurrent_pipelines cap', () => {
  let prefsDir, projectRoot, server, base, projectName;

  beforeEach(async () => {
    prefsDir = mkdtempSync(join(tmpdir(), 'cap-test-prefs-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'cap-test-proj-'));
    mkdirSync(join(projectRoot, '.worca', 'runs'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{}');

    // Write global settings with a low cap
    mkdirSync(prefsDir, { recursive: true });
    writeFileSync(
      join(prefsDir, 'settings.json'),
      JSON.stringify({
        worca: { parallel: { max_concurrent_pipelines: 2 } },
      }),
    );

    // Register the project
    mkdirSync(join(prefsDir, 'projects.d'), { recursive: true });
    writeFileSync(
      join(prefsDir, 'projects.d', 'test-proj.json'),
      JSON.stringify({ name: 'test-proj', path: projectRoot }),
    );

    mockStartPipeline.mockClear();
    mockStartPipeline.mockResolvedValue({ pid: 12345 });
    mockRunningPid = null;
    mockGlobalCount = 0;
    projectName = 'test-proj';

    ({ server, base } = await startServer(prefsDir, projectRoot));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(prefsDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('allows start when below cap', async () => {
    mockGlobalCount = 1;
    const res = await postRun(base, projectName, { prompt: 'Add feature X' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockStartPipeline).toHaveBeenCalled();
  });

  it('returns 409 with max_concurrent_exceeded when at cap', async () => {
    mockGlobalCount = 2;
    const res = await postRun(base, projectName, { prompt: 'Add feature X' });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('max_concurrent_exceeded');
    expect(data.error).toMatch(/maximum concurrent/i);
    expect(mockStartPipeline).not.toHaveBeenCalled();
  });

  it('returns 409 with max_concurrent_exceeded when above cap', async () => {
    mockGlobalCount = 5;
    const res = await postRun(base, projectName, { prompt: 'Add feature X' });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('max_concurrent_exceeded');
    expect(mockStartPipeline).not.toHaveBeenCalled();
  });

  it('uses default cap of 10 when no global settings exist', async () => {
    // Remove global settings file
    rmSync(join(prefsDir, 'settings.json'), { force: true });
    mockGlobalCount = 9;

    const res = await postRun(base, projectName, { prompt: 'Add feature X' });
    expect(res.status).toBe(200);
    expect(mockStartPipeline).toHaveBeenCalled();
  });

  it('blocks at default cap of 10 when no global settings exist', async () => {
    rmSync(join(prefsDir, 'settings.json'), { force: true });
    mockGlobalCount = 10;

    const res = await postRun(base, projectName, { prompt: 'Add feature X' });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('max_concurrent_exceeded');
  });

  it('still checks per-project running before global cap', async () => {
    mockRunningPid = 99999;
    mockGlobalCount = 0;
    const res = await postRun(base, projectName, { prompt: 'Add feature X' });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('already_running');
  });
});
