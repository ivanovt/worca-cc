import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPreferencesRouter } from '../preferences-routes.js';
import { writeProject } from '../project-registry.js';
import {
  createProjectScopedRoutes,
  projectResolver,
} from '../project-routes.js';

let prefsDir, projectRoot, settingsPath, globalSettingsPath, server, base;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/preferences', createPreferencesRouter({ prefsDir }));
  app.use(
    '/api/projects/:projectId',
    projectResolver({ prefsDir, projectRoot }),
    createProjectScopedRoutes({ prefsDir }),
  );
  return app;
}

async function startServer() {
  const app = buildApp();
  server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

async function postSettings(body) {
  return fetch(`${base}/api/projects/myproj/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  prefsDir = join(tmpdir(), `strip-save-test-prefs-${suffix}`);
  projectRoot = join(tmpdir(), `strip-save-test-proj-${suffix}`);

  mkdirSync(prefsDir, { recursive: true });
  mkdirSync(join(projectRoot, '.worca', 'runs'), { recursive: true });
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });

  settingsPath = join(projectRoot, '.claude', 'settings.json');
  globalSettingsPath = join(prefsDir, 'settings.json');

  writeProject(prefsDir, { name: 'myproj', path: projectRoot });
  await startServer();
});

afterEach(async () => {
  if (server) await stopServer();
  rmSync(prefsDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('strip-on-save: global key migration', () => {
  it('extracts misplaced global keys to ~/.worca/settings.json on save', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          parallel: {
            worktree_base_dir: '.worktrees',
            cleanup_policy: 'on-success',
            max_concurrent_pipelines: 3,
          },
          circuit_breaker: {
            enabled: true,
            classifier_model: 'haiku',
          },
          ui: {
            worktree_disk_warning_bytes: 5000000000,
          },
        },
      }),
    );

    const res = await postSettings({
      worca: { parallel: { worktree_base_dir: '.worktrees' } },
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.autoMigrated).toBeDefined();
    expect(data.autoMigrated.globalExtracted).toEqual(
      expect.objectContaining({
        parallel: expect.objectContaining({
          cleanup_policy: 'on-success',
          max_concurrent_pipelines: 3,
        }),
      }),
    );

    const projectFile = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(projectFile.worca.parallel.cleanup_policy).toBeUndefined();
    expect(projectFile.worca.parallel.max_concurrent_pipelines).toBeUndefined();
    expect(projectFile.worca.circuit_breaker?.classifier_model).toBeUndefined();
    expect(projectFile.worca.ui?.worktree_disk_warning_bytes).toBeUndefined();

    const globalFile = JSON.parse(readFileSync(globalSettingsPath, 'utf-8'));
    expect(globalFile.worca.parallel.cleanup_policy).toBe('on-success');
    expect(globalFile.worca.parallel.max_concurrent_pipelines).toBe(3);
    expect(globalFile.worca.circuit_breaker.classifier_model).toBe('haiku');
    expect(globalFile.worca.ui.worktree_disk_warning_bytes).toBe(5000000000);
  });

  it('strips inert milestone keys (pr_approval: true) on save', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          milestones: {
            plan_approval: true,
            pr_approval: true,
            deploy_approval: true,
          },
        },
      }),
    );

    const res = await postSettings({
      worca: { milestones: { plan_approval: true } },
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.autoMigrated.removedMilestones).toContain('pr_approval');
    expect(data.autoMigrated.removedMilestones).toContain('deploy_approval');

    const projectFile = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(projectFile.worca.milestones.pr_approval).toBeUndefined();
    expect(projectFile.worca.milestones.deploy_approval).toBeUndefined();
    expect(projectFile.worca.milestones.plan_approval).toBe(true);
  });

  it('preserves pr_approval: false (user opted out)', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          milestones: { plan_approval: true, pr_approval: false },
        },
      }),
    );

    const res = await postSettings({
      worca: { milestones: { plan_approval: true } },
    });
    expect(res.status).toBe(200);

    const projectFile = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(projectFile.worca.milestones.pr_approval).toBe(false);
  });
});

describe('strip-on-save: round-trip cleanliness', () => {
  it('clean project stays clean after no-op save (no pr_approval reintroduced)', async () => {
    const cleanSettings = {
      worca: {
        parallel: { worktree_base_dir: '.worktrees' },
        milestones: { plan_approval: true },
        agents: { planner: { model: 'opus' } },
      },
    };
    writeFileSync(settingsPath, JSON.stringify(cleanSettings));

    const res = await postSettings(cleanSettings);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.autoMigrated.globalExtracted).toEqual({});
    expect(data.autoMigrated.removedMilestones).toEqual([]);

    const projectFile = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(projectFile.worca.milestones.pr_approval).toBeUndefined();
    expect(projectFile.worca.parallel.cleanup_policy).toBeUndefined();

    expect(existsSync(globalSettingsPath)).toBe(false);
  });
});

describe('strip-on-save: validation failure leaves files unchanged', () => {
  it('validation error leaves both project and global files unchanged', async () => {
    const originalProject = {
      worca: {
        parallel: {
          worktree_base_dir: '.worktrees',
          cleanup_policy: 'on-success',
        },
        agents: { planner: { model: 'opus' } },
      },
    };
    writeFileSync(settingsPath, JSON.stringify(originalProject));

    const res = await postSettings({
      worca: { agents: { hacker: { model: 'opus' } } },
    });
    expect(res.status).toBe(400);

    const projectFile = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(projectFile).toEqual(originalProject);

    expect(existsSync(globalSettingsPath)).toBe(false);
  });

  it('validation error with existing global file leaves it unchanged', async () => {
    const originalProject = {
      worca: {
        parallel: {
          worktree_base_dir: '.worktrees',
          cleanup_policy: 'on-success',
        },
      },
    };
    writeFileSync(settingsPath, JSON.stringify(originalProject));

    const originalGlobal = {
      worca: { parallel: { max_concurrent_pipelines: 5 } },
    };
    writeFileSync(globalSettingsPath, JSON.stringify(originalGlobal));

    const res = await postSettings({
      worca: { agents: { hacker: { model: 'opus' } } },
    });
    expect(res.status).toBe(400);

    const projectFile = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(projectFile).toEqual(originalProject);

    const globalFile = JSON.parse(readFileSync(globalSettingsPath, 'utf-8'));
    expect(globalFile).toEqual(originalGlobal);
  });
});
