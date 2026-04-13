import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeProject } from '../project-registry.js';
import {
  createProjectRoutes,
  createProjectScopedRoutes,
  projectResolver,
} from '../project-routes.js';
import { MIN_WORCA_CC } from '../version-check.js';

async function createTestApp(prefsDir, projectRoot) {
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

describe('GET /api/projects/:id/worca-status — version + outdated extension', () => {
  let prefsDir;
  let projectRoot;

  beforeEach(() => {
    prefsDir = join(
      tmpdir(),
      `worca-prefs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    projectRoot = join(
      tmpdir(),
      `worca-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(prefsDir, { recursive: true });
    mkdirSync(join(projectRoot, '.worca'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{}');
  });

  afterEach(() => {
    rmSync(prefsDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // Case 14: installed with version file — version matches MIN_WORCA_CC (not outdated)
  it('returns version and outdated:false when version.json matches current minimum', async () => {
    mkdirSync(join(projectRoot, '.claude', 'worca'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.claude', 'worca', 'version.json'),
      JSON.stringify({ version: MIN_WORCA_CC }),
    );

    writeProject(prefsDir, { name: 'my-proj', path: projectRoot });
    const app = await createTestApp(prefsDir, projectRoot);
    const { status, body } = await request(
      app,
      'GET',
      '/api/projects/my-proj/worca-status',
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.installed).toBe(true);
    expect(body.version).toBe(MIN_WORCA_CC);
    expect(body.outdated).toBe(false);
  });

  // Case 15: installed without version file — version is null, outdated:false
  it('returns version:null and outdated:false when no version file is present', async () => {
    mkdirSync(join(projectRoot, '.claude', 'worca'), { recursive: true });
    // No version.json or __init__.py written

    writeProject(prefsDir, { name: 'my-proj', path: projectRoot });
    const app = await createTestApp(prefsDir, projectRoot);
    const { status, body } = await request(
      app,
      'GET',
      '/api/projects/my-proj/worca-status',
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.installed).toBe(true);
    expect(body.version).toBeNull();
    expect(body.outdated).toBe(false);
  });

  // Case 16: not installed — installed:false, version:null, outdated:false
  it('returns installed:false with null version and outdated:false when worca not installed', async () => {
    // No .claude/worca directory created
    writeProject(prefsDir, { name: 'my-proj', path: projectRoot });
    const app = await createTestApp(prefsDir, projectRoot);
    const { status, body } = await request(
      app,
      'GET',
      '/api/projects/my-proj/worca-status',
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.installed).toBe(false);
    expect(body.version).toBeNull();
    expect(body.outdated).toBe(false);
  });

  // Case 17: installed with outdated version — outdated:true
  it('returns outdated:true when installed version is below current minimum', async () => {
    mkdirSync(join(projectRoot, '.claude', 'worca'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.claude', 'worca', 'version.json'),
      JSON.stringify({ version: '0.1.0' }),
    );

    writeProject(prefsDir, { name: 'my-proj', path: projectRoot });
    const app = await createTestApp(prefsDir, projectRoot);
    const { status, body } = await request(
      app,
      'GET',
      '/api/projects/my-proj/worca-status',
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.installed).toBe(true);
    expect(body.version).toBe('0.1.0');
    expect(body.outdated).toBe(true);
  });
});
