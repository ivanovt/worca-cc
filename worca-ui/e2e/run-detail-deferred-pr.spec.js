import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

const PR_URL = 'https://github.com/owner/repo/pull/99';

function seedDeferredRun(worcaDir, runId, overrides = {}) {
  return seedRun(worcaDir, runId, {
    pipeline_status: 'completed',
    pr_deferred: true,
    head_branch: 'feature/deferred-pr',
    stages: {
      pr: {
        status: 'completed',
        iterations: [{ number: 1, status: 'completed', outcome: 'success' }],
      },
    },
    ...overrides,
  });
}

async function openPrPanel(page, baseUrl, runId) {
  await page.goto(`${baseUrl}/#/history?run=${runId}`, GOTO_OPTS);
  await expect(page.locator('.run-detail .stage-panels')).toBeVisible({ timeout: 8000 });
  // Use regex for exact label match — 'PREFLIGHT' also contains 'PR' as a substring
  const panel = page
    .locator('.stage-panel', {
      has: page.locator('.stage-panel-label', { hasText: /^PR$/ }),
    })
    .first();
  await panel.locator('.stage-panel-header').click();
  await expect(panel).toHaveAttribute('open', '', { timeout: 5000 });
  return panel;
}

test.describe('run-detail deferred PR creation flow', () => {
  test('shows orange deferred badge when run is deferred with no PR url', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-deferred-badge';
      seedDeferredRun(ctx.worcaDir, runId);

      const panel = await openPrPanel(page, ctx.url, runId);

      const badge = panel.locator('sl-badge.pr-deferred-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toHaveText('deferred');
      await expect(badge).toHaveAttribute('variant', 'warning');
    } finally {
      await ctx.close();
    }
  });

  test('Create PR button shows spinner then PR link on success', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-deferred-create-success';
      seedDeferredRun(ctx.worcaDir, runId);

      // Block the POST until explicitly released so we can assert the spinner
      let releaseRoute;
      const routeBlocked = new Promise((resolve) => {
        releaseRoute = resolve;
      });

      await page.route(`**/runs/${runId}/pr`, async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        await routeBlocked;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ pr_url: PR_URL }),
        });
      });

      const panel = await openPrPanel(page, ctx.url, runId);

      // Click the Create PR button
      await panel.locator('button.action-btn--primary').click();

      // Spinner appears while route is still blocked
      await expect(panel.locator('.pr-deferred-section sl-spinner')).toBeVisible({
        timeout: 5000,
      });

      // Update status.json so the WS broadcasts pr_url after the route resolves
      seedDeferredRun(ctx.worcaDir, runId, { pr_url: PR_URL });

      // Unblock the route — fetch completes, then WS delivers the updated run
      releaseRoute();

      // PR link in the overview (outside sl-details, always visible) should appear
      await expect(
        page.locator(`.run-detail-layout__overview a.run-pr-link[href="${PR_URL}"]`),
      ).toBeVisible({ timeout: 8000 });
    } finally {
      await ctx.close();
    }
  });

  test('Create PR button does NOT reappear after success before the status refresh (no duplicate PR)', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-deferred-no-dup';
      seedDeferredRun(ctx.worcaDir, runId);

      let postCount = 0;
      await page.route(`**/runs/${runId}/pr`, async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        postCount += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ pr_url: PR_URL }),
        });
      });

      const panel = await openPrPanel(page, ctx.url, runId);

      // Click Create PR. Deliberately do NOT seed pr_url into status.json, so
      // the run object the view holds stays stale (the exact gap that used to
      // let the button reappear and fire a second PR creation).
      await panel.locator('button.action-btn--primary').click();

      // The button must be gone — replaced by a "PR created" success badge.
      await expect(
        panel.locator('sl-badge.pr-deferred-badge', { hasText: 'PR created' }),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        panel.locator('button', { hasText: 'Create PR' }),
      ).toHaveCount(0);
      // Optimistic View PR link is shown even before the status refresh.
      await expect(
        panel.locator(`a.run-pr-link[href="${PR_URL}"]`),
      ).toBeVisible({ timeout: 5000 });

      // Exactly one POST fired — no path to a duplicate PR from the UI.
      expect(postCount).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  test('Create PR button shows inline error and Retry button on 500 response', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-deferred-create-fail';
      seedDeferredRun(ctx.worcaDir, runId);

      await page.route(`**/runs/${runId}/pr`, async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'gh: command not found' }),
        });
      });

      const panel = await openPrPanel(page, ctx.url, runId);

      // Click the Create PR button
      await panel.locator('button.action-btn--primary').click();

      // Error message should appear inside the deferred section
      await expect(panel.locator('.pr-deferred-error')).toBeVisible({ timeout: 5000 });
      await expect(panel.locator('.pr-deferred-error')).toContainText('gh: command not found');

      // Retry button should replace the original Create PR button
      const retryBtn = panel.locator('button.action-btn--primary', { hasText: 'Retry' });
      await expect(retryBtn).toBeVisible({ timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});
