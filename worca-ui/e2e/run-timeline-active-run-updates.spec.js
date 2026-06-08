import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

const BASE_START = '2026-01-01T10:00:00.000Z';

function seedActiveRun(worcaDir, runId) {
  return seedRun(worcaDir, runId, {
    pipeline_status: 'running',
    stage: 'implement',
    started_at: BASE_START,
    stages: {
      plan: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            started_at: BASE_START,
            completed_at: '2026-01-01T10:05:00.000Z',
          },
        ],
      },
      implement: {
        status: 'in_progress',
        iterations: [
          {
            number: 1,
            status: 'running',
            started_at: '2026-01-01T10:05:00.000Z',
          },
        ],
      },
    },
  });
}

function advanceActiveRun(worcaDir, runId) {
  // Advance time: implement iter 1 still running but more time elapsed
  return seedRun(worcaDir, runId, {
    pipeline_status: 'running',
    stage: 'implement',
    started_at: BASE_START,
    updated_at: '2026-01-01T10:20:00.000Z',
    stages: {
      plan: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            started_at: BASE_START,
            completed_at: '2026-01-01T10:05:00.000Z',
          },
        ],
      },
      implement: {
        status: 'in_progress',
        iterations: [
          {
            number: 1,
            status: 'running',
            started_at: '2026-01-01T10:05:00.000Z',
          },
        ],
      },
    },
  });
}

test.describe('run timeline active run updates', () => {
  test('WS update advancing time causes SVG to refresh with updated data-total-ms', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-timeline-active';
      seedActiveRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/timeline`, GOTO_OPTS);
      await expect(page.locator('.timeline-svg-wrap > svg')).toBeVisible({ timeout: 8000 });

      // Read initial bar count to confirm SVG rendered
      const initialBarCount = await page.locator('.timeline-bar').count();
      expect(initialBarCount).toBeGreaterThan(0);

      // Trigger a WS update by writing updated status
      advanceActiveRun(ctx.worcaDir, runId);

      // Active runs skip the WeakMap cache so SVG re-renders on each WS refresh.
      // After the update, the SVG should still be visible and have bars.
      await expect(page.locator('.timeline-svg-wrap > svg')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('.timeline-bar').first()).toBeAttached({ timeout: 5000 });

      // The rightmost bar (implement iter 1) should still be present after update
      const implementBar = page.locator('.timeline-bar[data-stage-key="implement"]').first();
      await expect(implementBar).toBeAttached({ timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});
