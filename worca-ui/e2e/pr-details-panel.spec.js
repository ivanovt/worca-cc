import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

const PR_DATA = {
  url: 'https://github.com/owner/repo/pull/42',
  number: 42,
  commit_sha: 'abc1234567890',
  source_branch: 'feature/my-feature',
  target_branch: 'main',
  provider: 'github',
};

async function openRunDetail(page, baseUrl, runId) {
  await page.goto(`${baseUrl}/#/history?run=${runId}`, GOTO_OPTS);
  await expect(page.locator('.run-detail .stage-panels')).toBeVisible({ timeout: 8000 });
}

function seedWithPR(worcaDir, runId, prOverrides = {}) {
  return seedRun(worcaDir, runId, {
    pipeline_status: 'completed',
    milestones: { pr_verified: true },
    stages: {
      pr: {
        status: 'completed',
        iterations: [{ number: 1, status: 'completed', outcome: 'success' }],
      },
    },
    pr: { ...PR_DATA, ...prOverrides },
  });
}

test.describe('PR info strip — inline metadata', () => {
  test('strip is rendered when run.pr is set', async ({ page }) => {
    const serverCtx = await startServer();
    try {
      const runId = '20260101-pr-strip-present';
      seedWithPR(serverCtx.worcaDir, runId);
      await openRunDetail(page, serverCtx.url, runId);

      const strip = page.locator('.pr-info-strip');
      await expect(strip).toBeAttached({ timeout: 5000 });
    } finally {
      await serverCtx.close();
    }
  });

  test('PR link has correct href and opens in new tab', async ({ page }) => {
    const serverCtx = await startServer();
    try {
      const runId = '20260101-pr-link-attrs';
      seedWithPR(serverCtx.worcaDir, runId);
      await openRunDetail(page, serverCtx.url, runId);

      const strip = page.locator('.pr-info-strip');
      await expect(strip).toBeAttached();
      const prLink = strip.locator('.run-pr-link').first();
      await expect(prLink).toHaveAttribute('href', PR_DATA.url, { timeout: 5000 });
      await expect(prLink).toHaveAttribute('target', '_blank');
      await expect(prLink).toHaveAttribute('rel', 'noopener noreferrer');
    } finally {
      await serverCtx.close();
    }
  });

  test('copy button carries full commit SHA as value', async ({ page }) => {
    const serverCtx = await startServer();
    try {
      const runId = '20260101-pr-copy-value';
      seedWithPR(serverCtx.worcaDir, runId);
      await openRunDetail(page, serverCtx.url, runId);

      const strip = page.locator('.pr-info-strip');
      const copyButton = strip.locator('sl-copy-button');
      await expect(copyButton).toBeAttached();
      await expect(copyButton).toHaveAttribute('value', PR_DATA.commit_sha);
    } finally {
      await serverCtx.close();
    }
  });

  test('copy button copies commit SHA to clipboard', async ({ page }) => {
    const serverCtx = await startServer();
    try {
      const runId = '20260101-pr-clipboard';
      seedWithPR(serverCtx.worcaDir, runId);

      await page.addInitScript(() => {
        window.__lastClipboardWrite = null;
        navigator.clipboard.writeText = (text) => {
          window.__lastClipboardWrite = text;
          return Promise.resolve();
        };
      });

      await openRunDetail(page, serverCtx.url, runId);
      const strip = page.locator('.pr-info-strip');

      await strip.evaluate((el) => {
        el.querySelector('sl-copy-button')?.handleCopy();
      });

      const written = await page.evaluate(() => window.__lastClipboardWrite);
      expect(written).toBe(PR_DATA.commit_sha);
    } finally {
      await serverCtx.close();
    }
  });

  test('strip absent when run has no PR data', async ({ page }) => {
    const serverCtx = await startServer();
    try {
      const runId = '20260101-pr-no-data';
      seedRun(serverCtx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: {
          pr: {
            status: 'completed',
            iterations: [{ number: 1, status: 'completed', outcome: 'success' }],
          },
        },
      });
      await openRunDetail(page, serverCtx.url, runId);

      await expect(page.locator('.pr-info-strip')).not.toBeAttached();
    } finally {
      await serverCtx.close();
    }
  });
});
