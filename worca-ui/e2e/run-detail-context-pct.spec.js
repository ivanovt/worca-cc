import { expect, test } from '@playwright/test';
import { seedRun, startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

test.describe('run-detail Context Consumed rendering', () => {
  test('renders Context: NN% in iteration info strip when context_final_pct is present', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-context-pct-present';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stage: 'plan',
        stages: {
          plan: {
            status: 'completed',
            agent: 'planner',
            model: 'sonnet',
            iterations: [
              {
                number: 1,
                status: 'completed',
                agent: 'planner',
                model: 'sonnet',
                context_final_pct: 42,
              },
              {
                number: 2,
                status: 'completed',
                agent: 'planner',
                model: 'sonnet',
                context_final_pct: 67,
              },
            ],
          },
        },
      });

      await page.goto(`${ctx.url}/#/history?run=${runId}`, GOTO_OPTS);
      await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
        timeout: 8000,
      });

      const planPanel = page
        .locator('.stage-panel', {
          has: page.locator('.stage-panel-label', { hasText: 'PLAN' }),
        })
        .first();
      await planPanel.locator('.stage-panel-header').click();
      await expect(planPanel).toHaveAttribute('open', '', { timeout: 5000 });

      const infoStrip = planPanel.locator('.stage-info-strip').first();
      await expect(infoStrip.locator('.meta-label').filter({ hasText: 'Context:' })).toHaveCount(1);
      await expect(infoStrip).toContainText('42%');
    } finally {
      await ctx.close();
    }
  });

  test('does not render Context label when context_final_pct is absent', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-context-pct-absent';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stage: 'plan',
        stages: {
          plan: {
            status: 'completed',
            agent: 'planner',
            model: 'sonnet',
            iterations: [
              {
                number: 1,
                status: 'completed',
                agent: 'planner',
                model: 'sonnet',
              },
            ],
          },
        },
      });

      await page.goto(`${ctx.url}/#/history?run=${runId}`, GOTO_OPTS);
      await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
        timeout: 8000,
      });

      const planPanel = page
        .locator('.stage-panel', {
          has: page.locator('.stage-panel-label', { hasText: 'PLAN' }),
        })
        .first();
      await planPanel.locator('.stage-panel-header').click();
      await expect(planPanel).toHaveAttribute('open', '', { timeout: 5000 });

      const infoStrip = planPanel.locator('.stage-info-strip').first();
      await expect(infoStrip.locator('.meta-label').filter({ hasText: 'Context:' })).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
