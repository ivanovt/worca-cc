import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getMaxProjects,
  readProjects,
  writeProject,
} from '../project-registry.js';
import { createProjectRoutes } from '../project-routes.js';

function createTestApp(prefsDir) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/projects',
    createProjectRoutes({ prefsDir, projectRoot: null }),
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
        if (body !== undefined) options.body = JSON.stringify(body);
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

describe('POST /api/projects/batch', () => {
  let prefsDir;
  let tmpDir;
  let app;

  beforeEach(() => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    prefsDir = join(tmpdir(), `worca-prefs-${id}`);
    tmpDir = join(tmpdir(), `worca-dirs-${id}`);
    mkdirSync(prefsDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    app = createTestApp(prefsDir);
  });

  afterEach(() => {
    rmSync(prefsDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Case 8: Batch add 3 valid projects — all registered, 201 response
  it('registers all valid projects and returns 201', async () => {
    const paths = ['auth-service', 'web-app', 'shared-utils'].map((name) => {
      const p = join(tmpDir, name);
      mkdirSync(p, { recursive: true });
      return { name, path: p };
    });

    const { status, body } = await request(app, 'POST', '/api/projects/batch', {
      projects: paths,
    });

    expect(status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.projects).toHaveLength(3);

    const registered = readProjects(prefsDir);
    expect(registered).toHaveLength(3);
    expect(registered.map((p) => p.name).sort()).toEqual([
      'auth-service',
      'shared-utils',
      'web-app',
    ]);
  });

  // Case 9: Batch with one invalid name — 400, nothing written
  it('returns 400 for invalid name and writes nothing', async () => {
    const validPath = join(tmpDir, 'good-proj');
    mkdirSync(validPath, { recursive: true });

    const { status, body } = await request(app, 'POST', '/api/projects/batch', {
      projects: [
        { name: 'good-proj', path: validPath },
        { name: 'bad project name!', path: validPath },
      ],
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].name).toBe('bad project name!');

    const registered = readProjects(prefsDir);
    expect(registered).toHaveLength(0);
  });

  // Case 10: Batch with non-existent path — 400, nothing written
  it('returns 400 when a path does not exist and writes nothing', async () => {
    const validPath = join(tmpDir, 'exists');
    mkdirSync(validPath, { recursive: true });

    const { status, body } = await request(app, 'POST', '/api/projects/batch', {
      projects: [
        { name: 'exists', path: validPath },
        { name: 'missing', path: join(tmpDir, 'does-not-exist') },
      ],
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].name).toBe('missing');
    expect(body.failed[0].error).toMatch(/does not exist/);

    const registered = readProjects(prefsDir);
    expect(registered).toHaveLength(0);
  });

  // Case 11: Batch exceeding max projects limit — 400 with limit error
  it('returns 400 when batch would exceed max projects limit', async () => {
    // Fill up to 1 below the default limit (20)
    const max = getMaxProjects(prefsDir);
    for (let i = 0; i < max - 1; i++) {
      const p = join(tmpDir, `existing-${i}`);
      mkdirSync(p, { recursive: true });
      writeProject(prefsDir, { name: `existing-${i}`, path: p });
    }

    // Try to add 2 more (would exceed by 1)
    const newPaths = [0, 1].map((i) => {
      const p = join(tmpDir, `new-${i}`);
      mkdirSync(p, { recursive: true });
      return { name: `new-${i}`, path: p };
    });

    const { status, body } = await request(app, 'POST', '/api/projects/batch', {
      projects: newPaths,
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/limit/);
  });

  // Case 12: Batch with duplicate paths against existing — 400
  it('returns 400 when a path is already registered', async () => {
    const existingPath = join(tmpDir, 'already-here');
    mkdirSync(existingPath, { recursive: true });
    writeProject(prefsDir, { name: 'already-here', path: existingPath });

    const newPath = join(tmpDir, 'new-proj');
    mkdirSync(newPath, { recursive: true });

    const { status, body } = await request(app, 'POST', '/api/projects/batch', {
      projects: [
        { name: 'already-here-dup', path: existingPath },
        { name: 'new-proj', path: newPath },
      ],
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].error).toMatch(/already registered/);
  });

  // Case 13: Empty batch array — 400
  it('returns 400 for an empty projects array', async () => {
    const { status, body } = await request(app, 'POST', '/api/projects/batch', {
      projects: [],
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/non-empty/);
  });
});
