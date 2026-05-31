import { expect, test } from '@playwright/test';
import { seedRun, startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

// Pin the rendering of the Model / ID label pair end-to-end. The runner
// records model_alias on each stage and per-iteration when the user-typed
// alias resolves to a different id (e.g. "glm-ds" -> "opus"); the UI then
// renders "Model Alias: glm-ds  Model ID: opus" instead of a single "Model ID: opus" line.
// Old runs without the field still render the original single-label form.
test.describe('run-detail Model / ID rendering', () => {
  test('renders Model Alias: <alias>  Model ID: <id> when stage.model_alias is recorded', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-model-alias-pair';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stage: 'plan',
        stages: {
          plan: {
            status: 'completed',
            agent: 'planner',
            model: 'opus',
            model_alias: 'glm-ds',
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
      // Two labels are rendered when the alias differs from the resolved id.
      const labels = infoStrip.locator('.meta-label');
      await expect(labels.filter({ hasText: 'Model Alias:' })).toHaveCount(1);
      await expect(labels.filter({ hasText: 'Model ID:' })).toHaveCount(1);
      // The alias is the primary "Model Alias:" value, the resolved id is the "Model ID:" value.
      await expect(infoStrip).toContainText('Model Alias: glm-ds');
      await expect(infoStrip).toContainText('Model ID: opus');
    } finally {
      await ctx.close();
    }
  });

  test('renders only Model ID: <id> when no alias is recorded (backward-compatible)', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      // Old runs predate the model_alias field. The stage info strip must
      // continue to render exactly one Model row with the resolved id and
      // no ID row at all — keeps existing run pages unchanged.
      const runId = '20260101-model-no-alias';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stage: 'plan',
        stages: {
          plan: {
            status: 'completed',
            agent: 'planner',
            model: 'opus',
            iterations: [
              {
                number: 1,
                status: 'completed',
                agent: 'planner',
                model: 'opus',
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
      const labels = infoStrip.locator('.meta-label');
      await expect(labels.filter({ hasText: 'Model ID:' })).toHaveCount(1);
      await expect(labels.filter({ hasText: 'Model Alias:' })).toHaveCount(0);
      await expect(infoStrip).toContainText('Model ID: opus');
    } finally {
      await ctx.close();
    }
  });
});
