import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

function seedZoomRun(worcaDir, runId) {
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

test.describe('run timeline zoom controls', () => {
  test('clicking + zooms in (bars widen) and reset restores fit-to-run', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-timeline-zoom';
      seedZoomRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/timeline`, GOTO_OPTS);
      await expect(page.locator('.run-timeline svg')).toBeVisible({ timeout: 8000 });

      const bar = page.locator('.timeline-bar').first();
      await expect(bar).toBeAttached({ timeout: 5000 });

      // Measure initial bar width from SVG attribute
      const widthBefore = await bar.evaluate((el) => parseFloat(el.getAttribute('width') || '0'));

      // Click zoom-in button
      const zoomInBtn = page.locator('button[aria-label="Zoom in"]');
      await expect(zoomInBtn).toBeVisible({ timeout: 3000 });
      await zoomInBtn.click();

      // The swimlane-content transform scale changes — verify via transform attribute
      const swimlane = page.locator('.swimlane-content');
      const transformAfterZoom = await swimlane.getAttribute('transform');
      expect(transformAfterZoom).toMatch(/scale\(2/);

      // Click reset button
      const resetBtn = page.locator('button[aria-label="Reset zoom"]');
      await resetBtn.click();

      const transformAfterReset = await swimlane.getAttribute('transform');
      expect(transformAfterReset).toMatch(/scale\(1/);

      // Bar width is stored in SVG attribute — should still be the original value
      const widthAfterReset = await bar.evaluate((el) => parseFloat(el.getAttribute('width') || '0'));
      expect(widthAfterReset).toBeCloseTo(widthBefore, 1);
    } finally {
      await ctx.close();
    }
  });
});
