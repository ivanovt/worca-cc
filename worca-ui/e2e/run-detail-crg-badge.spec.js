import { expect, test } from '@playwright/test';
import { seedRun, startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

async function openImplement(page, baseUrl, runId) {
  await page.goto(`${baseUrl}/#/history?run=${runId}`, GOTO_OPTS);
  await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
    timeout: 8000,
  });
  const panel = page
    .locator('.stage-panel', {
      has: page.locator('.stage-panel-label', { hasText: 'IMPLEMENT' }),
    })
    .first();
  await panel.locator('.stage-panel-header').click();
  await expect(panel).toHaveAttribute('open', '', { timeout: 5000 });
  return panel;
}

function stages(invocations) {
  const iter = {
    number: 1,
    status: 'completed',
    outcome: 'success',
    started_at: '2026-01-01T10:00:00.000Z',
    completed_at: '2026-01-01T10:05:00.000Z',
    effort: { level: 'high', source: 'explicit' },
  };
  if (invocations !== undefined) iter.crg_invocations = invocations;
  return { plan: { status: 'completed' }, implement: { status: 'completed', iterations: [iter] } };
}

test.describe('run-detail CRG invocation badge', () => {
  test('shows an integer count badge on the effort row when enabled', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-crg-count';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        crg_enabled: true,
        stages: stages(5),
      });
      const panel = await openImplement(page, ctx.url, runId);
      const row = panel.locator('.iteration-tags-row', { hasText: 'Effort:' }).first();
      await expect(row).toBeVisible({ timeout: 8000 });
      await expect(row).toContainText('Code Review Graph:');
      const badge = row.locator('.crg-invocations-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('5');
      await expect(row).not.toContainText('(disabled)');
    } finally {
      await ctx.close();
    }
  });

  test('shows a plain "(disabled)" value (no badge) when CRG is off', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-crg-disabled';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        crg_enabled: false,
        stages: stages(0),
      });
      const panel = await openImplement(page, ctx.url, runId);
      const row = panel.locator('.iteration-tags-row', { hasText: 'Effort:' }).first();
      await expect(row).toContainText('Code Review Graph:');
      await expect(row).toContainText('(disabled)');
      await expect(row.locator('.crg-invocations-badge')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('omits the CRG badge when the iteration has no count field', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-crg-absent';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        crg_enabled: true,
        stages: stages(undefined),
      });
      const panel = await openImplement(page, ctx.url, runId);
      const row = panel.locator('.iteration-tags-row', { hasText: 'Effort:' }).first();
      await expect(row).toBeVisible({ timeout: 8000 });
      await expect(row).not.toContainText('Code Review Graph:');
    } finally {
      await ctx.close();
    }
  });
});
