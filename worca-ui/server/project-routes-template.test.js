/**
 * Tests: POST /runs template field validation.
 * TDD: written before implementation.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ProcessManager so startPipeline doesn't actually spawn
const mockStartPipeline = vi.fn().mockResolvedValue({ pid: 12345 });

vi.mock('./process-manager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ProcessManager: class MockProcessManager {
      constructor() {}
      getRunningPid() {
        return null;
      }
      reconcileStatus() {
        return false;
      }
      startPipeline(...args) {
        return mockStartPipeline(...args);
      }
      stopPipeline() {
        throw Object.assign(new Error('not running'), { code: 'not_running' });
      }
      pausePipeline() {
        return { paused: true };
      }
    },
  };
});

const { createProjectRoutes, createProjectScopedRoutes, projectResolver } =
  await import('./project-routes.js');

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

describe('POST /runs — template field validation', () => {
  let prefsDir;
  let projectRoot;

  beforeEach(() => {
    prefsDir = join(
      tmpdir(),
      `worca-prefs-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    projectRoot = join(
      tmpdir(),
      `worca-proj-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(prefsDir, { recursive: true });
    mkdirSync(join(projectRoot, '.worca'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{}');
    mockStartPipeline.mockClear();
    mockStartPipeline.mockResolvedValue({ pid: 12345 });
  });

  afterEach(() => {
    rmSync(prefsDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function postRuns(app, projectName, body) {
    return request(app, 'POST', `/api/projects/${projectName}/runs`, body);
  }

  it('accepts a valid template and passes it to startPipeline', async () => {
    const app = await createTestApp(prefsDir, projectRoot);
    const { body: projectsBody } = await request(app, 'GET', '/api/projects');
    const projectName = projectsBody.projects[0].name;

    const { status, body } = await postRuns(app, projectName, {
      prompt: 'do something',
      template: 'my-template',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockStartPipeline).toHaveBeenCalledOnce();
    const opts = mockStartPipeline.mock.calls[0][0];
    expect(opts.template).toBe('my-template');
  });

  it('accepts template with numbers and hyphens', async () => {
    const app = await createTestApp(prefsDir, projectRoot);
    const { body: projectsBody } = await request(app, 'GET', '/api/projects');
    const projectName = projectsBody.projects[0].name;

    const { status } = await postRuns(app, projectName, {
      prompt: 'do something',
      template: 'fast-track-2',
    });

    expect(status).toBe(200);
    const opts = mockStartPipeline.mock.calls[0][0];
    expect(opts.template).toBe('fast-track-2');
  });

  it('returns 400 for template with uppercase letters', async () => {
    const app = await createTestApp(prefsDir, projectRoot);
    const { body: projectsBody } = await request(app, 'GET', '/api/projects');
    const projectName = projectsBody.projects[0].name;

    const { status, body } = await postRuns(app, projectName, {
      prompt: 'do something',
      template: 'MyTemplate',
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/template/i);
  });

  it('returns 400 for template with spaces', async () => {
    const app = await createTestApp(prefsDir, projectRoot);
    const { body: projectsBody } = await request(app, 'GET', '/api/projects');
    const projectName = projectsBody.projects[0].name;

    const { status, body } = await postRuns(app, projectName, {
      prompt: 'do something',
      template: 'my template',
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('returns 400 for template longer than 64 chars', async () => {
    const app = await createTestApp(prefsDir, projectRoot);
    const { body: projectsBody } = await request(app, 'GET', '/api/projects');
    const projectName = projectsBody.projects[0].name;

    const { status, body } = await postRuns(app, projectName, {
      prompt: 'do something',
      template: 'a'.repeat(65),
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('returns 400 for empty string template', async () => {
    const app = await createTestApp(prefsDir, projectRoot);
    const { body: projectsBody } = await request(app, 'GET', '/api/projects');
    const projectName = projectsBody.projects[0].name;

    const { status, body } = await postRuns(app, projectName, {
      prompt: 'do something',
      template: '',
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('omits template from startPipeline when not provided', async () => {
    const app = await createTestApp(prefsDir, projectRoot);
    const { body: projectsBody } = await request(app, 'GET', '/api/projects');
    const projectName = projectsBody.projects[0].name;

    const { status } = await postRuns(app, projectName, {
      prompt: 'do something',
    });

    expect(status).toBe(200);
    const opts = mockStartPipeline.mock.calls[0][0];
    expect(opts.template).toBeUndefined();
  });

  it('accepts null template (treated as absent)', async () => {
    const app = await createTestApp(prefsDir, projectRoot);
    const { body: projectsBody } = await request(app, 'GET', '/api/projects');
    const projectName = projectsBody.projects[0].name;

    const { status } = await postRuns(app, projectName, {
      prompt: 'do something',
      template: null,
    });

    expect(status).toBe(200);
    const opts = mockStartPipeline.mock.calls[0][0];
    expect(opts.template).toBeUndefined();
  });
});
