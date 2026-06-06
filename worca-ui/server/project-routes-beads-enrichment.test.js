import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./git-helpers.js', () => ({
  getDefaultBranch: vi.fn().mockReturnValue('main'),
}));

vi.mock('./process-manager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ProcessManager: class MockProcessManager {
      getRunningPid() {
        return null;
      }
      reconcileStatus() {
        return false;
      }
    },
  };
});

const mockDiscoverRuns = vi.fn().mockReturnValue([]);
// /runs now scans via discoverRunsAsync (issue #296 — off the event loop, no
// events.jsonl enrichment). Back both exports with the same mock so the
// existing mockDiscoverRuns.mockReturnValue(...) setups still drive the route.
vi.mock('./watcher.js', () => ({
  discoverRuns: (...args) => mockDiscoverRuns(...args),
  discoverRunsAsync: (...args) => mockDiscoverRuns(...args),
}));

const { createProjectScopedRoutes, projectResolver } = await import(
  './project-routes.js'
);

function createTestApp(prefsDir, projectRoot, { getBeadsCounts } = {}) {
  const app = express();
  app.use(express.json());
  if (getBeadsCounts) {
    app.locals.getBeadsCounts = getBeadsCounts;
  }
  app.use(
    '/api/projects/:projectId',
    projectResolver({ prefsDir, projectRoot }),
    createProjectScopedRoutes(),
  );
  return app;
}

async function request(app, method, path) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
        const json = await res.json();
        resolve({ status: res.status, body: json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe('GET /runs — beads count enrichment', () => {
  let prefsDir;
  let projectRoot;
  let projectName;

  beforeEach(() => {
    prefsDir = join(
      tmpdir(),
      `worca-beads-enrichment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    projectRoot = join(
      tmpdir(),
      `worca-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(projectRoot, '.worca', 'runs'), { recursive: true });
    projectName = basename(projectRoot);
    mockDiscoverRuns.mockReset();
  });

  afterEach(() => {
    rmSync(prefsDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('merges beads_done and beads_total onto runs when counts available', async () => {
    const runs = [
      { id: 'run-1', pipeline_status: 'running', active: true },
      { id: 'run-2', pipeline_status: 'completed', active: false },
    ];
    mockDiscoverRuns.mockReturnValue(runs);

    const getBeadsCounts = vi.fn().mockReturnValue({
      'run-1': { total: 5, done: 3 },
      'run-2': { total: 8, done: 8 },
    });

    const app = createTestApp(prefsDir, projectRoot, { getBeadsCounts });
    const { status, body } = await request(
      app,
      'GET',
      `/api/projects/${projectName}/runs`,
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.runs).toHaveLength(2);

    const r1 = body.runs.find((r) => r.id === 'run-1');
    expect(r1.beads_done).toBe(3);
    expect(r1.beads_total).toBe(5);

    const r2 = body.runs.find((r) => r.id === 'run-2');
    expect(r2.beads_done).toBe(8);
    expect(r2.beads_total).toBe(8);

    expect(getBeadsCounts).toHaveBeenCalledWith(projectName);
  });

  it('leaves runs untouched when no counts for that run ID', async () => {
    const runs = [
      { id: 'run-1', pipeline_status: 'running', active: true },
      { id: 'run-no-beads', pipeline_status: 'completed', active: false },
    ];
    mockDiscoverRuns.mockReturnValue(runs);

    const getBeadsCounts = vi.fn().mockReturnValue({
      'run-1': { total: 3, done: 1 },
    });

    const app = createTestApp(prefsDir, projectRoot, { getBeadsCounts });
    const { body } = await request(
      app,
      'GET',
      `/api/projects/${projectName}/runs`,
    );

    const enriched = body.runs.find((r) => r.id === 'run-1');
    expect(enriched.beads_done).toBe(1);
    expect(enriched.beads_total).toBe(3);

    const plain = body.runs.find((r) => r.id === 'run-no-beads');
    expect(plain.beads_done).toBeUndefined();
    expect(plain.beads_total).toBeUndefined();
  });

  it('works when getBeadsCounts is not set on app.locals', async () => {
    const runs = [{ id: 'run-1', pipeline_status: 'running', active: true }];
    mockDiscoverRuns.mockReturnValue(runs);

    const app = createTestApp(prefsDir, projectRoot);
    const { status, body } = await request(
      app,
      'GET',
      `/api/projects/${projectName}/runs`,
    );

    expect(status).toBe(200);
    expect(body.runs[0].beads_done).toBeUndefined();
    expect(body.runs[0].beads_total).toBeUndefined();
  });

  it('handles getBeadsCounts returning empty object', async () => {
    const runs = [{ id: 'run-1', pipeline_status: 'completed', active: false }];
    mockDiscoverRuns.mockReturnValue(runs);

    const getBeadsCounts = vi.fn().mockReturnValue({});
    const app = createTestApp(prefsDir, projectRoot, { getBeadsCounts });
    const { body } = await request(
      app,
      'GET',
      `/api/projects/${projectName}/runs`,
    );

    expect(body.runs[0].beads_done).toBeUndefined();
    expect(body.runs[0].beads_total).toBeUndefined();
  });

  it('handler is async (does not break on thrown getBeadsCounts)', async () => {
    const runs = [{ id: 'run-1', pipeline_status: 'running', active: true }];
    mockDiscoverRuns.mockReturnValue(runs);

    const getBeadsCounts = vi.fn().mockImplementation(() => {
      throw new Error('watcher not ready');
    });

    const app = createTestApp(prefsDir, projectRoot, { getBeadsCounts });
    const { status, body } = await request(
      app,
      'GET',
      `/api/projects/${projectName}/runs`,
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.runs[0].beads_done).toBeUndefined();
  });
});
