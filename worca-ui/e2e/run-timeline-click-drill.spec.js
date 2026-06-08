import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

function seedDrillRun(worcaDir, runId) {
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
            cost_usd: 0.12,
            input_tokens: 1000,
            output_tokens: 500,
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

test.describe('run timeline click drill', () => {
  test('clicking a bar opens sl-drawer with iteration header and raw JSON details', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-timeline-drill';
      seedDrillRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/timeline`, GOTO_OPTS);
      await expect(page.locator('.timeline-svg-wrap > svg')).toBeVisible({ timeout: 8000 });

      const bar = page.locator('.timeline-bar').first();
      await expect(bar).toBeAttached({ timeout: 5000 });

      // Dispatch click directly: Playwright's actionability check fails for SVG rects
      // behind fixed-layer backgrounds; dispatching on the bar bubbles to the container
      // with e.target = bar so the click-drill handler fires correctly.
      await page.evaluate(() => {
        const b = document.querySelector('.timeline-bar');
        const r = b.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        b.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
        );
      });

      // sl-drawer should open
      const drawer = page.locator('sl-drawer.iteration-drawer');
      await expect(drawer).toHaveAttribute('open', { timeout: 5000 });

      // Drawer label should contain iteration info
      const label = await drawer.getAttribute('label');
      expect(label).toMatch(/Iteration \d+/);

      // Raw JSON section should be present
      await expect(drawer.locator('details.drawer-raw-json')).toBeAttached({ timeout: 3000 });
      await expect(drawer.locator('details.drawer-raw-json summary')).toContainText('Raw JSON');
    } finally {
      await ctx.close();
    }
  });
});
