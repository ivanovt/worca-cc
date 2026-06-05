/**
 * E2E test: global-mode project tags survive a WS runs-list refresh.
 *
 * Verifies that run cards in the History view continue to show their
 * .run-card-project label after a WebSocket rebroadcast for one project —
 * i.e. that the client-side merge does not erase project tags on unrelated runs.
 */
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { attachWsServer } from '../server/ws.js';
import { createInbox } from '../server/webhook-inbox.js';
import { writeProject } from '../server/project-registry.js';
import { seedRun } from './fixtures.js';

async function startTagsServer() {
  const dir = join(tmpdir(), `worca-tags-e2e-${Date.now()}`);
  const prefsDir = join(dir, 'prefs');
  const projectRootA = join(dir, 'proj-a');
  const projectRootB = join(dir, 'proj-b');

  mkdirSync(prefsDir, { recursive: true });
  for (const root of [projectRootA, projectRootB]) {
    mkdirSync(join(root, '.worca', 'runs'), { recursive: true });
    mkdirSync(join(root, '.worca', 'results'), { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{}');
  }

  writeProject(prefsDir, { name: 'alpha', path: projectRootA });
  writeProject(prefsDir, { name: 'beta', path: projectRootB });

  const worcaDirA = join(projectRootA, '.worca');
  const worcaDirB = join(projectRootB, '.worca');

  const settingsPath = join(projectRootA, '.claude', 'settings.json');
  const webhookInbox = createInbox();
  const app = createApp({
    worcaDir: worcaDirA,
    settingsPath,
    projectRoot: projectRootA,
    prefsDir,
    webhookInbox,
  });
  const server = createServer(app);

  const { wss, broadcast, scheduleRefresh } = attachWsServer(server, {
    worcaDir: worcaDirA,
    settingsPath,
    prefsPath: join(dir, 'preferences.json'),
    prefsDir,
    webhookInbox,
  });

  app.locals.broadcast = broadcast;
  app.locals.scheduleRefresh = scheduleRefresh;

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    worcaDirA,
    worcaDirB,
    scheduleRefresh,
    close: () => {
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve)).finally(() =>
        rmSync(dir, { recursive: true, force: true }),
      );
    },
  };
}

test.describe('global-mode project tags survive WS refresh', () => {
  test('both project tags remain visible after rebroadcast for one project', async ({ page }) => {
    const ctx = await startTagsServer();
    try {
      // Seed one completed run in each project
      seedRun(ctx.worcaDirA, 'run-alpha-01', {
        pipeline_status: 'completed',
        stage: 'pr',
        work_request: { title: 'Alpha feature' },
      });
      seedRun(ctx.worcaDirB, 'run-beta-01', {
        pipeline_status: 'completed',
        stage: 'pr',
        work_request: { title: 'Beta feature' },
      });

      // Navigate to history view
      await page.goto(`${ctx.url}/#/history`, { waitUntil: 'domcontentloaded' });

      // Both run cards must appear with project labels
      const alphaTag = page.locator('.run-card-project', { hasText: 'alpha' });
      const betaTag = page.locator('.run-card-project', { hasText: 'beta' });
      await expect(alphaTag).toBeVisible({ timeout: 10000 });
      await expect(betaTag).toBeVisible({ timeout: 10000 });

      // Trigger a WS rebroadcast for alpha by touching its status.json
      seedRun(ctx.worcaDirA, 'run-alpha-01', {
        pipeline_status: 'completed',
        stage: 'pr',
        work_request: { title: 'Alpha feature' },
      });

      // Wait a moment for the file watcher and WS message to propagate
      await page.waitForTimeout(1500);

      // Both project tags must still be present after the rebroadcast
      await expect(alphaTag).toBeVisible({ timeout: 5000 });
      await expect(betaTag).toBeVisible({ timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});
