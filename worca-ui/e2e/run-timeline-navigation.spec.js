import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

function seedTimelineRun(worcaDir, runId) {
  return seedRun(worcaDir, runId, {
    pipeline_status: 'completed',
    stage: 'pr',
    completed_at: '2026-01-01T10:15:00.000Z',
    stages: {
      plan: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            started_at: '2026-01-01T10:00:00.000Z',
            completed_at: '2026-01-01T10:05:00.000Z',
          },
        ],
      },
      implement: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            started_at: '2026-01-01T10:05:00.000Z',
            completed_at: '2026-01-01T10:15:00.000Z',
          },
        ],
      },
    },
  });
}

test.describe('run timeline navigation', () => {
  test('clicking Timeline button navigates to timeline URL and renders SVG', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-timeline-nav-fwd';
      seedTimelineRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history?run=${runId}`, GOTO_OPTS);
      await expect(page.locator('.run-detail .stage-panels')).toBeVisible({ timeout: 8000 });

      const timelineBtn = page.locator(
        '.pipeline-timing-bar-actions button.action-btn--primary',
      );
      await expect(timelineBtn).toBeVisible({ timeout: 5000 });
      await timelineBtn.click();

      await expect(page).toHaveURL(new RegExp(`#/history/${runId}/timeline$`), { timeout: 5000 });

      await expect(page.locator('.timeline-svg-wrap > svg')).toBeVisible({ timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});
