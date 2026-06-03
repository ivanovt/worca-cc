import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

test.describe('sidebar — history badge count', () => {
  test('seeded completed run shows in History badge', async ({ page }) => {
    const ctx = await startServer();
    try {
      seedRun(ctx.worcaDir, '20260101-side-done', {
        pipeline_status: 'completed',
        completed_at: new Date().toISOString(),
        work_request: { title: 'Done run' },
      });

      await page.goto(ctx.url, GOTO_OPTS);

      const historyItem = page.locator('.sidebar-item').filter({ hasText: 'History' });
      await expect(historyItem).toBeVisible({ timeout: 5000 });
      const badge = historyItem.locator('sl-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toHaveText('1');
    } finally {
      await ctx.close();
    }
  });

  test('multiple seeded runs show correct History count', async ({ page }) => {
    const ctx = await startServer();
    try {
      seedRun(ctx.worcaDir, '20260101-side-1', {
        pipeline_status: 'completed',
        completed_at: new Date().toISOString(),
        work_request: { title: 'Run 1' },
      });
      seedRun(ctx.worcaDir, '20260101-side-2', {
        pipeline_status: 'failed',
        work_request: { title: 'Run 2' },
      });
      seedRun(ctx.worcaDir, '20260101-side-3', {
        pipeline_status: 'paused',
        work_request: { title: 'Run 3' },
      });

      await page.goto(ctx.url, GOTO_OPTS);

      const historyItem = page.locator('.sidebar-item').filter({ hasText: 'History' });
      await expect(historyItem).toBeVisible({ timeout: 5000 });
      const badge = historyItem.locator('sl-badge');
      await expect(badge).toBeVisible({ timeout: 5000 });
      await expect(badge).toHaveText('3');
    } finally {
      await ctx.close();
    }
  });

  test('no badge when zero runs', async ({ page }) => {
    const ctx = await startServer();
    try {
      await page.goto(ctx.url, GOTO_OPTS);

      // Running section should have no badge with zero runs
      const runningItem = page.locator('.sidebar-item').filter({ hasText: 'Running' });
      await expect(runningItem).toBeVisible({ timeout: 5000 });
      const badge = runningItem.locator('sl-badge');
      await expect(badge).toHaveCount(0);

      // History section should also have no badge
      const historyItem = page.locator('.sidebar-item').filter({ hasText: 'History' });
      const histBadge = historyItem.locator('sl-badge');
      await expect(histBadge).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('sidebar — collapse toggle', () => {
  test('toggle button collapses sidebar; persists across reload', async ({ page }) => {
    const ctx = await startServer();
    try {
      await page.goto(ctx.url, GOTO_OPTS);

      const sidebar = page.locator('aside.sidebar');
      const toggle = page.locator('button.sidebar-toggle-btn');
      await expect(toggle).toBeVisible({ timeout: 5000 });
      await expect(sidebar).not.toHaveClass(/collapsed/);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await toggle.click();
      await expect(sidebar).toHaveClass(/collapsed/);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // Nav labels collapse: the visible text shrinks to the toggle's own
      // aria-label only — the "Running" label is hidden.
      await expect(page.locator('.sidebar-item').filter({ hasText: /^Running$/ })).toHaveCount(0);

      // Persisted in localStorage (client-local, not server prefs).
      const stored = await page.evaluate(() =>
        localStorage.getItem('worca.sidebar-collapsed'),
      );
      expect(stored).toBe('1');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('aside.sidebar')).toHaveClass(/collapsed/, {
        timeout: 5000,
      });
    } finally {
      await ctx.close();
    }
  });

  test('Ctrl+B keyboard shortcut toggles the sidebar', async ({ page }) => {
    const ctx = await startServer();
    try {
      await page.goto(ctx.url, GOTO_OPTS);

      const sidebar = page.locator('aside.sidebar');
      await expect(sidebar).toBeVisible({ timeout: 5000 });
      await expect(sidebar).not.toHaveClass(/collapsed/);

      // Use Ctrl+B for cross-platform CI parity (mac Webkit treats it the
      // same as Cmd+B via the metaKey||ctrlKey check in the handler).
      await page.keyboard.press('Control+b');
      await expect(sidebar).toHaveClass(/collapsed/, { timeout: 5000 });

      await page.keyboard.press('Control+b');
      await expect(sidebar).not.toHaveClass(/collapsed/, { timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});

test.describe('sidebar — navigation', () => {
  test('clicking Running navigates to active view', async ({ page }) => {
    const ctx = await startServer();
    try {
      await page.goto(ctx.url, GOTO_OPTS);

      const runningItem = page.locator('.sidebar-item').filter({ hasText: 'Running' });
      await expect(runningItem).toBeVisible({ timeout: 5000 });
      await runningItem.click();

      // Should show the Running Pipelines heading
      await expect(page.locator('h1')).toContainText('Running Pipelines', { timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });

  test('clicking History navigates to history view', async ({ page }) => {
    const ctx = await startServer();
    try {
      seedRun(ctx.worcaDir, '20260101-side-nav', {
        pipeline_status: 'completed',
        completed_at: new Date().toISOString(),
        work_request: { title: 'Nav test' },
      });

      await page.goto(ctx.url, GOTO_OPTS);

      const historyItem = page.locator('.sidebar-item').filter({ hasText: 'History' });
      await expect(historyItem).toBeVisible({ timeout: 5000 });
      await historyItem.click();

      // Should show a run card
      await expect(page.locator('.run-card')).toBeVisible({ timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});
