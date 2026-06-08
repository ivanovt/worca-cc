import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

function seedTooltipRun(worcaDir, runId) {
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
            model: 'claude-opus-4-5',
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
            model: 'claude-sonnet-4-5',
            started_at: '2026-01-01T10:05:00.000Z',
            completed_at: '2026-01-01T10:15:00.000Z',
          },
        ],
      },
    },
  });
}

test.describe('run timeline tooltip hover', () => {
  test('hovering an iteration bar shows tooltip with stage label, iteration, duration, model, status', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-timeline-tooltip';
      seedTooltipRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/timeline`, GOTO_OPTS);
      await expect(page.locator('.timeline-svg-wrap > svg')).toBeVisible({ timeout: 8000 });

      // Hover the first timeline bar
      const bar = page.locator('.timeline-bar').first();
      await expect(bar).toBeAttached({ timeout: 5000 });

      // Use JavaScript dispatch: Playwright's actionability check fails for SVG rects
      // behind fixed-layer backgrounds; dispatching directly sets e.target correctly.
      await page.evaluate(() => {
        const b = document.querySelector('.timeline-bar');
        const r = b.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const container = b.closest('.run-timeline');
        container.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
        );
        b.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
        );
      });

      const tooltip = page.locator('.timeline-tooltip');
      await expect(tooltip).toBeVisible({ timeout: 3000 });

      // Tooltip header: stage label + iteration N of total
      await expect(tooltip.locator('.tooltip-header')).toContainText('Iteration');
      await expect(tooltip.locator('.tooltip-header')).toContainText('of');

      // Duration row
      await expect(tooltip).toContainText('Duration');

      // Model row
      await expect(tooltip).toContainText('Model');

      // Status row
      await expect(tooltip).toContainText('Status');
    } finally {
      await ctx.close();
    }
  });
});
