import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('PUT /api/projects/:id/settings — persistence split', () => {
  let projectRoot;
  let prefsDir;
  let baseSettingsPath;
  let localSettingsPath;
  let projectName;

  beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    projectRoot = join(tmpdir(), `worca-split-proj-${stamp}`);
    prefsDir = join(tmpdir(), `worca-split-prefs-${stamp}`);

    mkdirSync(join(projectRoot, '.worca'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    baseSettingsPath = join(projectRoot, '.claude', 'settings.json');
    localSettingsPath = join(projectRoot, '.claude', 'settings.local.json');
    writeFileSync(
      baseSettingsPath,
      JSON.stringify({
        worca: {
          agents: { implementer: { model: 'sonnet', max_turns: 300 } },
        },
      }),
    );
    mkdirSync(prefsDir, { recursive: true });

    const app = buildApp(prefsDir, projectRoot);
    const list = await request(app, 'GET', '/api/projects');
    projectName = list.body.projects[0].name;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(prefsDir, { recursive: true, force: true });
  });

  it('writes worca.agents to settings.json (NOT settings.local.json)', async () => {
    const app = buildApp(prefsDir, projectRoot);
    const res = await request(
      app,
      'POST',
      `/api/projects/${projectName}/settings`,
      {
        worca: { agents: { implementer: { model: 'opus', max_turns: 500 } } },
      },
    );

    expect(res.status).toBe(200);

    const base = JSON.parse(readFileSync(baseSettingsPath, 'utf8'));
    expect(base.worca.agents.implementer).toEqual({
      model: 'opus',
      max_turns: 500,
    });

    // local must not contain worca.agents (or local file should not exist)
    let local = {};
    try {
      local = JSON.parse(readFileSync(localSettingsPath, 'utf8'));
    } catch {
      /* fine — file may not exist */
    }
    expect(local.worca?.agents).toBeUndefined();
  });

  it('writes permissions to settings.local.json (machine-specific)', async () => {
    const app = buildApp(prefsDir, projectRoot);
    const res = await request(
      app,
      'POST',
      `/api/projects/${projectName}/settings`,
      {
        permissions: { allow: ['Bash'], deny: [] },
      },
    );

    expect(res.status).toBe(200);

    const local = JSON.parse(readFileSync(localSettingsPath, 'utf8'));
    expect(local.permissions).toEqual({ allow: ['Bash'], deny: [] });

    // permissions must NOT have leaked into base
    const base = JSON.parse(readFileSync(baseSettingsPath, 'utf8'));
    expect(base.permissions).toBeUndefined();
  });

  it('preserves unrelated worca keys when only one is updated', async () => {
    writeFileSync(
      baseSettingsPath,
      JSON.stringify({
        worca: {
          agents: { implementer: { model: 'sonnet', max_turns: 300 } },
          governance: { strict: true },
        },
      }),
    );

    const app = buildApp(prefsDir, projectRoot);
    await request(app, 'POST', `/api/projects/${projectName}/settings`, {
      worca: { agents: { implementer: { model: 'opus', max_turns: 100 } } },
    });

    const base = JSON.parse(readFileSync(baseSettingsPath, 'utf8'));
    expect(base.worca.agents.implementer.model).toBe('opus');
    expect(base.worca.governance).toEqual({ strict: true });
  });

  it('handles a payload with both worca and permissions correctly', async () => {
    const app = buildApp(prefsDir, projectRoot);
    await request(app, 'POST', `/api/projects/${projectName}/settings`, {
      worca: { agents: { tester: { model: 'haiku' } } },
      permissions: { allow: ['Read'], deny: ['Bash'] },
    });

    const base = JSON.parse(readFileSync(baseSettingsPath, 'utf8'));
    expect(base.worca.agents.tester).toEqual({ model: 'haiku' });
    expect(base.permissions).toBeUndefined();

    const local = JSON.parse(readFileSync(localSettingsPath, 'utf8'));
    expect(local.permissions).toEqual({ allow: ['Read'], deny: ['Bash'] });
    expect(local.worca).toBeUndefined();
  });
});
