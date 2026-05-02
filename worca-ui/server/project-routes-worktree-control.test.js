import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectRoutes,
  createProjectScopedRoutes,
  projectResolver,
} from './project-routes.js';

function buildApp(prefsDir, projectRoot) {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', createProjectRoutes({ prefsDir, projectRoot }));
  app.use(
    '/api/projects/:projectId',
    projectResolver({ prefsDir, projectRoot }),
    createProjectScopedRoutes(),
  );
  return app;
}

async function request(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const options = {
          method,
          headers: { 'Content-Type': 'application/json' },
        };
        if (body) options.body = JSON.stringify(body);
        const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
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

/** Spawn a long-living child process whose PID we can pass to /stop. */
function spawnDummy() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'setInterval(() => {}, 60000); process.on("SIGTERM", () => process.exit(0));',
    ],
    { stdio: 'ignore', detached: false },
  );
  return child;
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode != null || child.signalCode != null)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Child did not exit')),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe(
  'POST /api/projects/:id/runs/:runId/stop — worktree pipeline',
  { timeout: 15000 },
  () => {
    let projectRoot;
    let prefsDir;
    let worktreePath;
    let child;
    const runId = '20260317-084204-001-stop';

    beforeEach(() => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      projectRoot = join(tmpdir(), `worca-prc-proj-${stamp}`);
      prefsDir = join(tmpdir(), `worca-prc-prefs-${stamp}`);
      worktreePath = join(tmpdir(), `worca-prc-wt-${stamp}`);

      mkdirSync(join(projectRoot, '.worca', 'multi', 'pipelines.d'), {
        recursive: true,
      });
      mkdirSync(join(projectRoot, '.claude'), { recursive: true });
      writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{}');
      mkdirSync(prefsDir, { recursive: true });
    });

    afterEach(() => {
      if (child && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(prefsDir, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    });

    it('stops a worktree-registered pipeline via /runs/:id/stop', async () => {
      child = spawnDummy();
      const childPid = child.pid;

      const wtRunDir = join(worktreePath, '.worca', 'runs', runId);
      mkdirSync(join(wtRunDir, 'logs'), { recursive: true });
      writeFileSync(join(wtRunDir, 'pipeline.pid'), String(childPid));
      writeFileSync(
        join(wtRunDir, 'status.json'),
        JSON.stringify({
          run_id: runId,
          pipeline_status: 'running',
          stages: {},
        }),
      );

      writeFileSync(
        join(projectRoot, '.worca', 'multi', 'pipelines.d', `${runId}.json`),
        JSON.stringify({
          run_id: runId,
          worktree_path: worktreePath,
          pid: childPid,
          status: 'running',
        }),
      );

      const app = buildApp(prefsDir, projectRoot);
      const projectName = (await request(app, 'GET', '/api/projects')).body
        .projects[0].name;

      const res = await request(
        app,
        'POST',
        `/api/projects/${projectName}/runs/${runId}/stop`,
      );

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      await waitForExit(child);
    });

    it('cancels a worktree-registered pipeline via /runs/:id/cancel', async () => {
      child = spawnDummy();
      const childPid = child.pid;

      const wtRunDir = join(worktreePath, '.worca', 'runs', runId);
      mkdirSync(join(wtRunDir, 'logs'), { recursive: true });
      writeFileSync(join(wtRunDir, 'pipeline.pid'), String(childPid));
      writeFileSync(
        join(wtRunDir, 'status.json'),
        JSON.stringify({
          run_id: runId,
          pipeline_status: 'running',
          stages: {},
        }),
      );

      writeFileSync(
        join(projectRoot, '.worca', 'multi', 'pipelines.d', `${runId}.json`),
        JSON.stringify({
          run_id: runId,
          worktree_path: worktreePath,
          pid: childPid,
          status: 'running',
        }),
      );

      const app = buildApp(prefsDir, projectRoot);
      const projectName = (await request(app, 'GET', '/api/projects')).body
        .projects[0].name;

      const res = await request(
        app,
        'POST',
        `/api/projects/${projectName}/runs/${runId}/cancel`,
      );

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.cancelled).toBe(true);
    });
  },
);
