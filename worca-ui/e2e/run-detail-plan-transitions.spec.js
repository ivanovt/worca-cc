import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

test.describe('run-detail PLAN stage transitions', () => {
  test('no View plan button during in_progress; Model Alias + Model ID visible', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-plan-trans-inprog';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'running',
        stage: 'plan',
        stages: {
          plan: {
            status: 'in_progress',
            agent: 'planner',
            model: 'opus',
            model_alias: 'glm-ds',
            iterations: [
              {
                number: 1,
                status: 'in_progress',
                agent: 'planner',
                model: 'opus',
                model_alias: 'glm-ds',
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
      // in_progress stages auto-expand (?open=${status === 'in_progress'})
      await expect(planPanel).toHaveAttribute('open', '', { timeout: 5000 });

      await expect(planPanel.locator('.btn-view-run-plan')).toHaveCount(0);

      const infoStrip = planPanel.locator('.stage-info-strip').first();
      await expect(infoStrip).toContainText('Model Alias:');
      await expect(infoStrip).toContainText('glm-ds');
      await expect(infoStrip).toContainText('Model ID:');
      await expect(infoStrip).toContainText('opus');
    } finally {
      await ctx.close();
    }
  });

  test('View plan button appears on completed; click opens dialog with plan content', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-plan-trans-done';
      const runDir = join(ctx.worcaDir, 'runs', runId);
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'running',
        stage: 'coordinate',
        stages: {
          plan: {
            status: 'completed',
            agent: 'planner',
            model: 'opus',
            model_alias: 'glm-ds',
            plan_file: join(runDir, 'plan-001.md'),
            iterations: [
              {
                number: 1,
                status: 'completed',
                agent: 'planner',
                model: 'opus',
                model_alias: 'glm-ds',
              },
            ],
          },
        },
      });
      writeFileSync(
        join(runDir, 'plan-001.md'),
        '# Transition Test Plan\n\nThis is the plan content TRANSITIONMARKER.\n',
        'utf8',
      );

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

      const planBtn = planPanel.locator('.btn-view-run-plan').first();
      await expect(planBtn).toContainText('plan-001.md');
      await planBtn.click();

      const dialog = page.locator('sl-dialog.run-plan-dialog');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog).toContainText('TRANSITIONMARKER', { timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});
