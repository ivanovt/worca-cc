import { test, expect } from '@playwright/test';
import { startServer, seedRun, writePipelinePid } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

async function openRunDetail(page, baseUrl, runId, pipelineStatus) {
  await page.goto(`${baseUrl}/#/history?run=${runId}`, GOTO_OPTS);
  await expect(page.locator('.run-detail .stage-panels')).toBeVisible();
  if (['running', 'paused', 'failed'].includes(pipelineStatus)) {
    await expect(page.locator('.content-header-actions .action-btn').first()).toBeVisible();
  }
}

test.describe('run-action targeting', () => {
  test('restart stage targets the viewed run', async ({ page }) => {
    const ctx = await startServer();
    try {
      seedRun(ctx.worcaDir, 'run-A', {
        pipeline_status: 'completed',
        completed_at: new Date().toISOString(),
        stage: 'pr',
        stages: {
          plan: { status: 'completed' },
          implement: { status: 'completed' },
          test: { status: 'completed' },
          review: { status: 'completed' },
          pr: { status: 'completed' },
        },
      });
      seedRun(ctx.worcaDir, 'run-B', {
        pipeline_status: 'completed',
        completed_at: new Date().toISOString(),
        stage: 'pr',
        stages: {
          plan: { status: 'completed' },
          implement: { status: 'completed' },
          test: { status: 'completed' },
          review: { status: 'completed' },
          pr: { status: 'completed' },
        },
      });
      seedRun(ctx.worcaDir, 'run-C', {
        pipeline_status: 'failed',
        stage: 'implement',
        stages: {
          plan: { status: 'completed' },
          implement: { status: 'error' },
        },
      });

      const interceptedUrls = [];
      await page.route('**/api/runs/*/stages/*/restart', (route) => {
        interceptedUrls.push(route.request().url());
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      });

      await page.goto(`${ctx.url}/#/history?run=run-C`, GOTO_OPTS);
      await expect(page.locator('.run-detail .stage-panels')).toBeVisible();

      // Expand the errored implement stage panel to reveal the restart button
      const implementPanel = page.locator('sl-details.stage-panel', { hasText: 'IMPLEMENT' });
      await implementPanel.click();

      const restartBtn = page.locator('sl-button[variant="warning"]', { hasText: 'Restart Stage' });
      await expect(restartBtn).toBeVisible();
      await restartBtn.click();

      const confirmBtn = page.locator('#global-confirm-dialog sl-button[variant="warning"]');
      await expect(confirmBtn).toBeVisible();
      await confirmBtn.click();

      await expect.poll(() => interceptedUrls.length).toBeGreaterThan(0);
      expect(interceptedUrls[0]).toContain('/runs/run-C/');
      expect(interceptedUrls[0]).toContain('/stages/implement/restart');
      expect(interceptedUrls[0]).not.toContain('run-A');
      expect(interceptedUrls[0]).not.toContain('run-B');
    } finally {
      await ctx.close();
    }
  });

  test('pause targets the viewed run', async ({ page }) => {
    const ctx = await startServer();
    try {
      writePipelinePid(ctx.worcaDir, 'run-X');
      seedRun(ctx.worcaDir, 'run-X', {
        pipeline_status: 'running',
        stage: 'implement',
        stages: { plan: { status: 'completed' }, implement: { status: 'in_progress' } },
      });
      writePipelinePid(ctx.worcaDir, 'run-Y');
      seedRun(ctx.worcaDir, 'run-Y', {
        pipeline_status: 'running',
        stage: 'test',
        stages: { plan: { status: 'completed' }, implement: { status: 'completed' }, test: { status: 'in_progress' } },
      });

      const interceptedUrls = [];
      await page.route('**/api/runs/*/pause', (route) => {
        interceptedUrls.push(route.request().url());
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, paused: true, runId: 'run-Y' }),
        });
      });

      await openRunDetail(page, ctx.url, 'run-Y', 'running');
      await page.getByRole('button', { name: 'Pause' }).click();

      await expect.poll(() => interceptedUrls.length).toBeGreaterThan(0);
      expect(interceptedUrls[0]).toContain('/runs/run-Y/pause');
      expect(interceptedUrls[0]).not.toContain('run-X');
    } finally {
      await ctx.close();
    }
  });

  test('stop targets the viewed run', async ({ page }) => {
    const ctx = await startServer();
    try {
      writePipelinePid(ctx.worcaDir, 'run-X');
      seedRun(ctx.worcaDir, 'run-X', {
        pipeline_status: 'running',
        stage: 'implement',
        stages: { plan: { status: 'completed' }, implement: { status: 'in_progress' } },
      });
      writePipelinePid(ctx.worcaDir, 'run-Y');
      seedRun(ctx.worcaDir, 'run-Y', {
        pipeline_status: 'running',
        stage: 'test',
        stages: { plan: { status: 'completed' }, implement: { status: 'completed' }, test: { status: 'in_progress' } },
      });

      const interceptedUrls = [];
      await page.route('**/api/runs/*/stop', (route) => {
        interceptedUrls.push(route.request().url());
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, stopped: true, runId: 'run-Y', pid: 99 }),
        });
      });

      await openRunDetail(page, ctx.url, 'run-Y', 'running');
      await page.getByRole('button', { name: 'Stop' }).click();

      await expect(page.locator('#global-confirm-dialog')).toBeVisible();
      await page.locator('#global-confirm-dialog sl-button[variant="danger"]').click();

      await expect.poll(() => interceptedUrls.length).toBeGreaterThan(0);
      expect(interceptedUrls[0]).toContain('/runs/run-Y/stop');
      expect(interceptedUrls[0]).not.toContain('run-X');
    } finally {
      await ctx.close();
    }
  });
});
