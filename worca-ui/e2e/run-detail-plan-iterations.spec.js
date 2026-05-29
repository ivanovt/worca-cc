import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

// W-061: a run with two append-only plan revisions on disk. plan-001 is the
// original; plan-002 is the current (latest) plan after a plan_review revise.
function seedRunWithPlanRevisions(worcaDir, runId) {
  const runDir = join(worcaDir, 'runs', runId);
  seedRun(worcaDir, runId, {
    pipeline_status: 'completed',
    stage: 'coordinate',
    stages: {
      plan: {
        status: 'completed',
        plan_file: join(runDir, 'plan-002.md'),
        iterations: [{ number: 1, status: 'completed' }],
      },
      plan_review: {
        status: 'completed',
        iterations: [{ number: 1, status: 'completed', outcome: 'approve' }],
      },
      coordinate: {
        status: 'completed',
        iterations: [{ number: 1, status: 'completed' }],
      },
    },
  });
  writeFileSync(
    join(runDir, 'plan-001.md'),
    '# Original Plan\n\nFirst draft content ORIGINALMARKER.\n',
    'utf8',
  );
  writeFileSync(
    join(runDir, 'plan-002.md'),
    '# Revised Plan\n\nUpdated content REVISEDMARKER.\n',
    'utf8',
  );
}

test.describe('run-detail plan revision viewer (W-061)', () => {
  test('lists numbered plan revisions and switches content', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-plan-iters';
      seedRunWithPlanRevisions(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history?run=${runId}`, GOTO_OPTS);
      await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
        timeout: 8000,
      });

      // Open the PLAN stage panel and click "View plan".
      const planPanel = page
        .locator('.stage-panel', {
          has: page.locator('.stage-panel-label', { hasText: 'PLAN' }),
        })
        .first();
      await planPanel.locator('.stage-panel-header').click();
      await expect(planPanel).toHaveAttribute('open', '', { timeout: 5000 });
      await planPanel.locator('.btn-view-run-plan').first().click();

      const dialog = page.locator('sl-dialog.run-plan-dialog');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // The latest revision (v2) is shown by default.
      await expect(dialog).toContainText('REVISEDMARKER', { timeout: 5000 });

      // Both revisions are offered in the selector.
      await expect(dialog.locator('.plan-iter-btn')).toHaveCount(2);

      // Switching to v1 (original) loads the original content.
      await dialog
        .locator('.plan-iter-btn', { hasText: 'original' })
        .first()
        .click();
      await expect(dialog).toContainText('ORIGINALMARKER', { timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });

  test('opens the plan dialog from the plan_review panel (plan panel collapsed)', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-plan-iters-pr';
      seedRunWithPlanRevisions(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history?run=${runId}`, GOTO_OPTS);
      await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
        timeout: 8000,
      });

      // Expand ONLY the plan_review panel; leave the plan panel collapsed.
      // Regression guard: the dialog is rendered once at the top level (not
      // nested in the plan panel), so it must surface even when triggered from
      // plan_review with the plan panel collapsed.
      const reviewPanel = page
        .locator('.stage-panel', {
          has: page.locator('.stage-panel-label', { hasText: 'PLAN REVIEW' }),
        })
        .first();
      await reviewPanel.locator('.stage-panel-header').click();
      await expect(reviewPanel).toHaveAttribute('open', '', { timeout: 5000 });

      await expect(reviewPanel.locator('.btn-view-run-plan')).toHaveCount(1);
      await reviewPanel.locator('.btn-view-run-plan').click();

      const dialog = page.locator('sl-dialog.run-plan-dialog');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog).toContainText('REVISEDMARKER', { timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});
