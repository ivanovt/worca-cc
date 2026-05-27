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

// One completed implement iteration carrying an effort block (so the effort
// row renders) plus an optional graphify_invocations count.
function stages(invocations) {
  const iter = {
    number: 1,
    status: 'completed',
    outcome: 'success',
    started_at: '2026-01-01T10:00:00.000Z',
    completed_at: '2026-01-01T10:05:00.000Z',
    effort: { level: 'high', source: 'explicit' },
  };
  if (invocations !== undefined) iter.graphify_invocations = invocations;
  return { plan: { status: 'completed' }, implement: { status: 'completed', iterations: [iter] } };
}

test.describe('run-detail graphify invocation badge', () => {
  test('shows an integer count badge on the effort row when enabled', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-gfx-count';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: true,
        stages: stages(3),
      });
      const panel = await openImplement(page, ctx.url, runId);
      const row = panel.locator('.iteration-tags-row', { hasText: 'Effort:' }).first();
      await expect(row).toBeVisible({ timeout: 8000 });
      await expect(row).toContainText('Graphify:');
      const badge = row.locator('.graphify-invocations-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('3');
      await expect(row).not.toContainText('(disabled)');
    } finally {
      await ctx.close();
    }
  });

  test('shows a plain "(disabled)" value (no badge) when graphify is off', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-gfx-disabled';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: false,
        stages: stages(0),
      });
      const panel = await openImplement(page, ctx.url, runId);
      const row = panel.locator('.iteration-tags-row', { hasText: 'Effort:' }).first();
      await expect(row).toContainText('Graphify:');
      await expect(row).toContainText('(disabled)');
      await expect(row.locator('.graphify-invocations-badge')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('omits the Graphify badge when the iteration has no count field', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-gfx-absent';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: true,
        stages: stages(undefined),
      });
      const panel = await openImplement(page, ctx.url, runId);
      const row = panel.locator('.iteration-tags-row', { hasText: 'Effort:' }).first();
      await expect(row).toBeVisible({ timeout: 8000 });
      await expect(row).not.toContainText('Graphify:');
    } finally {
      await ctx.close();
    }
  });
});

// --- Preflight Graphify Badge ---

async function openPreflight(page, baseUrl, runId) {
  await page.goto(`${baseUrl}/#/history?run=${runId}`, GOTO_OPTS);
  await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
    timeout: 8000,
  });
  const panel = page
    .locator('.stage-panel', {
      has: page.locator('.stage-panel-label', { hasText: 'PREFLIGHT' }),
    })
    .first();
  await panel.locator('.stage-panel-header').click();
  await expect(panel).toHaveAttribute('open', '', { timeout: 5000 });
  return panel;
}

function preflightStages({ graphifyStatus, graphifyOutcome, graphifyMode, graphifyReason } = {}) {
  const stage = {
    status: 'completed',
    iterations: [{
      number: 1,
      status: 'completed',
      outcome: 'success',
      started_at: '2026-01-01T10:00:00.000Z',
      completed_at: '2026-01-01T10:01:00.000Z',
      output: { checks: [{ name: 'branch', status: 'pass', message: 'ok' }], summary: 'All checks passed' },
    }],
  };
  if (graphifyStatus !== undefined) stage.graphify_status = graphifyStatus;
  if (graphifyOutcome !== undefined) stage.graphify_outcome = graphifyOutcome;
  if (graphifyMode !== undefined) stage.graphify_mode = graphifyMode;
  if (graphifyReason !== undefined) stage.graphify_reason = graphifyReason;
  return { preflight: stage };
}

test.describe('preflight graphify badge', () => {
  test('shows "off" neutral badge when graphify is disabled', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-pf-gfx-off';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: false,
        stages: preflightStages(),
      });
      const panel = await openPreflight(page, ctx.url, runId);
      const badge = panel.locator('.preflight-graphify-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toHaveText('off');
      await expect(badge).toHaveAttribute('variant', 'neutral');
    } finally {
      await ctx.close();
    }
  });

  test('shows "skipped" neutral badge when graphify was skipped', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-pf-gfx-skip';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: true,
        stages: preflightStages({ graphifyStatus: 'skipped', graphifyMode: 'structural' }),
      });
      const panel = await openPreflight(page, ctx.url, runId);
      const badge = panel.locator('.preflight-graphify-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toHaveText('skipped');
      await expect(badge).toHaveAttribute('variant', 'neutral');
    } finally {
      await ctx.close();
    }
  });

  test('shows "cached · structural" success badge for cache hit', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-pf-gfx-cached';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: true,
        stages: preflightStages({
          graphifyStatus: 'ready',
          graphifyOutcome: 'cached',
          graphifyMode: 'structural',
        }),
      });
      const panel = await openPreflight(page, ctx.url, runId);
      const badge = panel.locator('.preflight-graphify-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toContainText('cached');
      await expect(badge).toContainText('structural');
      await expect(badge).toHaveAttribute('variant', 'success');
    } finally {
      await ctx.close();
    }
  });

  test('shows "rebuilt · full" success badge for fresh build', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-pf-gfx-rebuilt';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: true,
        stages: preflightStages({
          graphifyStatus: 'ready',
          graphifyOutcome: 'built',
          graphifyMode: 'full',
        }),
      });
      const panel = await openPreflight(page, ctx.url, runId);
      const badge = panel.locator('.preflight-graphify-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toContainText('rebuilt');
      await expect(badge).toContainText('full');
      await expect(badge).toHaveAttribute('variant', 'success');
    } finally {
      await ctx.close();
    }
  });

  test('shows "built (uncommitted) · structural" warning badge for throwaway', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-pf-gfx-throwaway';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: true,
        stages: preflightStages({
          graphifyStatus: 'ready',
          graphifyOutcome: 'throwaway',
          graphifyMode: 'structural',
        }),
      });
      const panel = await openPreflight(page, ctx.url, runId);
      const badge = panel.locator('.preflight-graphify-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toContainText('built (uncommitted)');
      await expect(badge).toContainText('structural');
      await expect(badge).toHaveAttribute('variant', 'warning');
    } finally {
      await ctx.close();
    }
  });

  test('shows "unavailable" danger badge with reason tooltip for degraded', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-pf-gfx-degraded';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        graphify_enabled: true,
        stages: preflightStages({
          graphifyStatus: 'degraded',
          graphifyReason: 'graphify CLI not found on PATH',
        }),
      });
      const panel = await openPreflight(page, ctx.url, runId);
      const badge = panel.locator('.preflight-graphify-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toHaveText('unavailable');
      await expect(badge).toHaveAttribute('variant', 'danger');
      await expect(badge).toHaveAttribute('title', 'graphify CLI not found on PATH');
    } finally {
      await ctx.close();
    }
  });

  test('renders no badge for old runs with no graphify fields', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-pf-gfx-old';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: preflightStages(),
      });
      const panel = await openPreflight(page, ctx.url, runId);
      await expect(panel.locator('.preflight-graphify-badge')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
