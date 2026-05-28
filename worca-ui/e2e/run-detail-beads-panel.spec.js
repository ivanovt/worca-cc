import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

/**
 * Guards the run-detail beads-panel wiring (main.js call site passing
 * { loaded, showSpinner } from runBeads/beadsSpinner into runBeadsSectionView).
 *
 * The panel now renders as part of run-detail immediately — previously it was
 * absent until the list-beads-by-run response arrived. With no .beads/ db the
 * WS resolves to an empty list, so the panel settles on its empty state; the
 * point of this test is that the panel renders (and doesn't throw) on open.
 */
test.describe('run-detail beads panel', () => {
  test('renders on run open and does not stay absent', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-beads-panel-wiring';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stage: 'implement',
        stages: {
          plan: { status: 'completed' },
          implement: { status: 'completed' },
        },
      });

      await page.goto(`${ctx.url}/#/history?run=${runId}`, GOTO_OPTS);
      await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
        timeout: 8000,
      });

      const panel = page.locator('.run-beads-panel');
      await expect(panel).toBeVisible({ timeout: 8000 });
      // The summary title is always rendered (collapsed sl-details).
      await expect(panel.locator('.run-beads-title')).toHaveText('Beads');
    } finally {
      await ctx.close();
    }
  });
});
