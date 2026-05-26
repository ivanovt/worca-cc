/**
 * E2E tests for workspace launcher planning modes (W-056).
 *
 * Drives the launcher UI at #/workspace-runs/new through each planning
 * strategy (master, existing, per-repo, independent) and asserts the
 * multipart FormData payload submitted to POST /api/workspace-runs.
 *
 * Notes on Shoelace interaction:
 * - sl-select / sl-radio-group: set `.value` + dispatch `sl-change` via evaluate().
 * - sl-textarea: set `.value` + dispatch `sl-input` via evaluate().
 * - File uploads: filePickerButton creates a transient <input type="file">
 *   on each click (never added to DOM). We monkey-patch
 *   HTMLInputElement.prototype.click to inject a synthetic File before
 *   clicking the sl-button.
 */
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApp } from '../server/app.js';
import { attachWsServer } from '../server/ws.js';
import { createInbox } from '../server/webhook-inbox.js';
import { writeProject } from '../server/project-registry.js';
import { createWorkspaceRouter } from '../server/workspace-routes.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

// -- Shoelace helpers --------------------------------------------------------

async function setSlTextareaValue(page, selector, value) {
  await page.locator(selector).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(
      new CustomEvent('sl-input', { bubbles: true, composed: true }),
    );
  }, value);
}

async function setSlSelectValue(page, selector, value) {
  await page.locator(selector).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(
      new CustomEvent('sl-change', { bubbles: true, composed: true }),
    );
  }, value);
}

async function setSlRadioGroupValue(page, groupSelector, value) {
  await page.locator(groupSelector).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(
      new CustomEvent('sl-change', { bubbles: true, composed: true }),
    );
  }, value);
}

async function setSlInputValue(page, selector, value) {
  await page.locator(selector).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(
      new CustomEvent('sl-input', { bubbles: true, composed: true }),
    );
  }, value);
}

// -- Multipart parser --------------------------------------------------------

function parseMultipart(contentType, bodyBuffer) {
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) return { fields: {}, files: [] };
  const boundary = boundaryMatch[1].trim();

  const bodyStr =
    typeof bodyBuffer === 'string' ? bodyBuffer : bodyBuffer.toString('binary');
  const parts = bodyStr.split('--' + boundary).slice(1, -1);

  const fields = {};
  const files = [];

  for (const raw of parts) {
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = raw.slice(0, headerEnd);
    const content = raw.slice(headerEnd + 4).replace(/\r\n$/, '');

    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (filenameMatch) {
      files.push({ name, filename: filenameMatch[1], content });
    } else {
      fields[name] = content;
    }
  }
  return { fields, files };
}

// -- Server setup ------------------------------------------------------------

async function startWorkspaceServer() {
  const dir = join(
    tmpdir(),
    'worca-wsl-e2e-' +
      Date.now() +
      '-' +
      Math.random().toString(36).slice(2, 8),
  );
  const prefsDir = join(dir, 'prefs');
  const projectRoot = join(dir, 'default-project');
  const wsRunsDir = join(dir, 'workspace-runs');
  const workspacesDir = join(dir, 'workspaces.d');

  mkdirSync(prefsDir, { recursive: true });
  mkdirSync(join(projectRoot, '.worca', 'runs'), { recursive: true });
  mkdirSync(join(projectRoot, '.worca', 'results'), { recursive: true });
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  mkdirSync(wsRunsDir, { recursive: true });
  mkdirSync(workspacesDir, { recursive: true });
  writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{}');

  writeProject(prefsDir, { name: 'default-project', path: projectRoot });

  const worcaDir = join(projectRoot, '.worca');
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const webhookInbox = createInbox();

  const wsRouter = createWorkspaceRouter({
    workspaceRunsDir: wsRunsDir,
    workspacesDir,
  });
  const mainApp = createApp({
    worcaDir,
    settingsPath,
    projectRoot,
    prefsDir,
    webhookInbox,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/workspaces', wsRouter.workspaces);
  app.use('/api/workspace-runs', wsRouter.workspaceRuns);
  app.use(mainApp);

  const server = createServer(app);
  const { wss, broadcast, scheduleRefresh } = attachWsServer(server, {
    worcaDir,
    settingsPath,
    prefsPath: join(dir, 'preferences.json'),
    prefsDir,
    webhookInbox,
  });

  mainApp.locals.broadcast = broadcast;
  mainApp.locals.scheduleRefresh = scheduleRefresh;

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: 'http://127.0.0.1:' + port,
    port,
    dir,
    prefsDir,
    wsRunsDir,
    workspacesDir,
    close: () => {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve)).finally(() =>
        rmSync(dir, { recursive: true, force: true }),
      );
    },
  };
}

function seedWorkspace(ctx, name, parentDir, projects) {
  mkdirSync(parentDir, { recursive: true });
  for (const p of projects) {
    mkdirSync(join(parentDir, p.name, '.git'), { recursive: true });
  }
  writeFileSync(
    join(parentDir, 'workspace.json'),
    JSON.stringify({ name, projects }, null, 2) + '\n',
  );
  writeFileSync(
    join(ctx.workspacesDir, name + '.json'),
    JSON.stringify({ name, path: parentDir }, null, 2) + '\n',
  );
}

// -- Shared helpers ----------------------------------------------------------

async function openLauncherAndFillBasics(page, ctx, wsName, promptText) {
  await page.goto(ctx.url + '/#/workspace-runs/new', GOTO_OPTS);

  await expect(
    page.locator('.select-workspace sl-option'),
  ).toBeAttached({ timeout: 10000 });

  await setSlSelectValue(page, '.select-workspace', wsName);

  await expect(page.locator('.workspace-repo-tag').first()).toBeAttached({
    timeout: 5000,
  });

  await setSlTextareaValue(page, '.textarea-fleet-prompt', promptText);
}

function interceptWorkspaceRunPost(page) {
  const captured = [];

  page.route('**/api/workspace-runs', async (route, request) => {
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }

    const ct = request.headers()['content-type'] || '';
    const body = request.postData() || '';
    const parsed = parseMultipart(ct, body);
    captured.push(parsed);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        workspace_id: 'ws_' + Date.now() + '_mock0001',
      }),
    });
  });

  return captured;
}

async function prepareFileInjection(page, fileName, fileContent, fileType) {
  await page.evaluate(
    ({ name, content, type }) => {
      const origClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') {
          HTMLInputElement.prototype.click = origClick;
          const file = new File([content], name, { type });
          const dt = new DataTransfer();
          dt.items.add(file);
          Object.defineProperty(this, 'files', {
            value: dt.files,
            configurable: true,
          });
          if (this.onchange) this.onchange(new Event('change'));
        } else {
          origClick.call(this);
        }
      };
    },
    { name: fileName, content: fileContent, type: fileType },
  );
}

async function clickLaunch(page) {
  await page
    .locator('button.action-btn:has-text("Launch")')
    .click({ timeout: 5000 });
}

// == Tests ===================================================================

test.describe('workspace launcher: master mode (default)', () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await startWorkspaceServer();
    seedWorkspace(ctx, 'test-ws', join(ctx.dir, 'ws-repos'), [
      { name: 'api', path: 'api', role: 'service', depends_on: [] },
      { name: 'web', path: 'web', role: 'frontend', depends_on: ['api'] },
    ]);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('submits with plan_mode=master and no plan files', async ({ page }) => {
    const captured = interceptWorkspaceRunPost(page);

    await openLauncherAndFillBasics(page, ctx, 'test-ws', 'Migrate to v2');

    await clickLaunch(page);

    await expect.poll(() => captured.length, { timeout: 10000 }).toBe(1);

    const { fields, files } = captured[0];
    expect(fields.workspace_name).toBe('test-ws');
    expect(fields.prompt).toBe('Migrate to v2');
    expect(fields.plan_mode).toBe('master');
    expect(files.filter((f) => f.name === 'workspace_plan_file')).toHaveLength(
      0,
    );
    expect(
      files.filter((f) => f.name.startsWith('project_plan_')),
    ).toHaveLength(0);
  });
});

test.describe('workspace launcher: existing mode', () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await startWorkspaceServer();
    seedWorkspace(ctx, 'exist-ws', join(ctx.dir, 'exist-repos'), [
      { name: 'svc-a', path: 'svc-a', role: 'service', depends_on: [] },
      {
        name: 'svc-b',
        path: 'svc-b',
        role: 'service',
        depends_on: ['svc-a'],
      },
    ]);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('submits workspace_plan_file when file is selected', async ({
    page,
  }) => {
    const captured = interceptWorkspaceRunPost(page);

    await openLauncherAndFillBasics(
      page,
      ctx,
      'exist-ws',
      'Apply workspace plan',
    );

    await setSlRadioGroupValue(page, '.plan-mode-group', 'existing');

    await expect(
      page.locator('.workspace-plan-upload'),
    ).toBeAttached({ timeout: 5000 });

    const planJson = JSON.stringify({
      projects: [
        { name: 'svc-a', instructions: 'Build service A' },
        { name: 'svc-b', instructions: 'Build service B' },
      ],
    });
    await prepareFileInjection(
      page,
      'workspace-plan.json',
      planJson,
      'application/json',
    );

    await page.locator('.btn-workspace-plan-browse').click();

    await expect(
      page.locator('.workspace-plan-tag'),
    ).toBeAttached({ timeout: 5000 });

    await clickLaunch(page);

    await expect.poll(() => captured.length, { timeout: 10000 }).toBe(1);

    const { fields, files } = captured[0];
    expect(fields.plan_mode).toBe('existing');
    expect(fields.workspace_name).toBe('exist-ws');
    const planFile = files.find((f) => f.name === 'workspace_plan_file');
    expect(planFile).toBeTruthy();
    expect(planFile.filename).toBe('workspace-plan.json');
    expect(fields.workspace_plan).toBeUndefined();
  });

  test('submits workspace_plan path when no file but path is set', async ({
    page,
  }) => {
    const captured = interceptWorkspaceRunPost(page);

    await openLauncherAndFillBasics(
      page,
      ctx,
      'exist-ws',
      'Apply server-side plan',
    );

    await setSlRadioGroupValue(page, '.plan-mode-group', 'existing');

    await expect(
      page.locator('.workspace-plan-upload'),
    ).toBeAttached({ timeout: 5000 });

    await page.locator('.workspace-plan-advanced').evaluate((el) => {
      el.open = true;
    });
    await expect(
      page.locator('.input-workspace-plan-path'),
    ).toBeVisible({ timeout: 5000 });

    await setSlInputValue(
      page,
      '.input-workspace-plan-path',
      '/tmp/my-workspace-plan.json',
    );

    await clickLaunch(page);

    await expect.poll(() => captured.length, { timeout: 10000 }).toBe(1);

    const { fields, files } = captured[0];
    expect(fields.plan_mode).toBe('existing');
    expect(fields.workspace_plan).toBe('/tmp/my-workspace-plan.json');
    expect(files.filter((f) => f.name === 'workspace_plan_file')).toHaveLength(
      0,
    );
  });
});

test.describe('workspace launcher: per-repo mode', () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await startWorkspaceServer();
    seedWorkspace(ctx, 'perrepo-ws', join(ctx.dir, 'perrepo-repos'), [
      { name: 'lib', path: 'lib', role: 'library', depends_on: [] },
      { name: 'app', path: 'app', role: 'service', depends_on: ['lib'] },
    ]);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('submits project_plan_files for each uploaded project plan', async ({
    page,
  }) => {
    const captured = interceptWorkspaceRunPost(page);

    await openLauncherAndFillBasics(
      page,
      ctx,
      'perrepo-ws',
      'Per-project plans',
    );

    await setSlRadioGroupValue(page, '.plan-mode-group', 'per-repo');

    await expect(
      page.locator('.per-project-plan-row').first(),
    ).toBeAttached({ timeout: 5000 });

    await expect(page.locator('.per-repo-fallback-alert')).toBeAttached();

    const rows = page.locator('.per-project-plan-row');
    const rowCount = await rows.count();
    expect(rowCount).toBe(2);

    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const projName = await row
        .locator('.per-project-plan-name')
        .textContent();
      const trimmed = projName.trim();
      await prepareFileInjection(
        page,
        trimmed + '-plan.md',
        '# Plan for ' + trimmed + '\n\nImplement feature.',
        'text/markdown',
      );
      await row.locator('.btn-per-repo-plan-browse').click();
    }

    await expect(page.locator('.per-project-plan-tag')).toHaveCount(2, {
      timeout: 5000,
    });

    await clickLaunch(page);

    await expect.poll(() => captured.length, { timeout: 10000 }).toBe(1);

    const { fields, files } = captured[0];
    expect(fields.plan_mode).toBe('per-repo');
    expect(fields.workspace_name).toBe('perrepo-ws');

    const planFiles = files.filter((f) => f.name.startsWith('project_plan_'));
    expect(planFiles).toHaveLength(2);
    const filenames = planFiles.map((f) => f.filename).sort();
    expect(filenames).toEqual(['app-plan.md', 'lib-plan.md']);
  });
});

test.describe('workspace launcher: independent mode', () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await startWorkspaceServer();
    seedWorkspace(ctx, 'indep-ws', join(ctx.dir, 'indep-repos'), [
      { name: 'core', path: 'core', role: 'library', depends_on: [] },
      { name: 'ui', path: 'ui', role: 'frontend', depends_on: ['core'] },
    ]);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('submits with plan_mode=independent and shows warning', async ({
    page,
  }) => {
    const captured = interceptWorkspaceRunPost(page);

    await openLauncherAndFillBasics(
      page,
      ctx,
      'indep-ws',
      'Independent planning',
    );

    await setSlRadioGroupValue(page, '.plan-mode-group', 'independent');

    await expect(
      page.locator('.plan-mode-independent-warning'),
    ).toBeAttached({ timeout: 5000 });

    await clickLaunch(page);

    await expect.poll(() => captured.length, { timeout: 10000 }).toBe(1);

    const { fields, files } = captured[0];
    expect(fields.plan_mode).toBe('independent');
    expect(fields.workspace_name).toBe('indep-ws');
    expect(fields.prompt).toBe('Independent planning');
    expect(files.filter((f) => f.name === 'workspace_plan_file')).toHaveLength(
      0,
    );
    expect(
      files.filter((f) => f.name.startsWith('project_plan_')),
    ).toHaveLength(0);
  });
});

test.describe('workspace launcher: guide files coexist with plan', () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await startWorkspaceServer();
    seedWorkspace(ctx, 'guide-ws', join(ctx.dir, 'guide-repos'), [
      { name: 'svc', path: 'svc', role: 'service', depends_on: [] },
    ]);
  });

  test.afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('guide files are sent alongside existing-mode plan file', async ({
    page,
  }) => {
    const captured = interceptWorkspaceRunPost(page);

    await openLauncherAndFillBasics(
      page,
      ctx,
      'guide-ws',
      'Guide + existing plan',
    );

    await prepareFileInjection(
      page,
      'guide.md',
      '# Migration Guide\n\nFollow these steps.',
      'text/markdown',
    );
    await page.locator('.btn-guide-browse').click();

    await expect(page.locator('.guide-tag')).toBeAttached({ timeout: 5000 });

    await setSlRadioGroupValue(page, '.plan-mode-group', 'existing');
    await expect(
      page.locator('.workspace-plan-upload'),
    ).toBeAttached({ timeout: 5000 });

    await prepareFileInjection(
      page,
      'ws-plan.json',
      JSON.stringify({
        projects: [{ name: 'svc', instructions: 'Build it' }],
      }),
      'application/json',
    );
    await page.locator('.btn-workspace-plan-browse').click();

    await expect(
      page.locator('.workspace-plan-tag'),
    ).toBeAttached({ timeout: 5000 });

    await clickLaunch(page);

    await expect.poll(() => captured.length, { timeout: 10000 }).toBe(1);

    const { fields, files } = captured[0];
    expect(fields.plan_mode).toBe('existing');

    const guideFiles = files.filter((f) => f.name === 'guide_files');
    expect(guideFiles.length).toBeGreaterThanOrEqual(1);
    expect(guideFiles[0].filename).toBe('guide.md');

    const planFiles = files.filter((f) => f.name === 'workspace_plan_file');
    expect(planFiles).toHaveLength(1);
    expect(planFiles[0].filename).toBe('ws-plan.json');
  });
});
