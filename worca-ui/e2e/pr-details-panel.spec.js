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

/**
 * Open an sl-details element and wait for its animation to finish
 * (sl-after-show fires once content is fully visible).
 */
async function expandDetails(detailsLocator) {
  await detailsLocator.evaluate((el) => {
    return new Promise((resolve) => {
      el.addEventListener('sl-after-show', resolve, { once: true });
      el.show();
    });
  });
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

test.describe('PR details panel — collapsible subsection', () => {
  test('section is collapsed by default', async ({ page }) => {
    const serverCtx = await startServer();
    try {
      const runId = '20260101-pr-closed-default';
      seedWithPR(serverCtx.worcaDir, runId);
      await openRunDetail(page, serverCtx.url, runId);

      const details = page.locator('sl-details.pr-details-section');
      await expect(details).toBeAttached({ timeout: 5000 });
      await expect(details).not.toHaveAttribute('open');
    } finally {
      await serverCtx.close();
    }
  });

  test('section expands and collapses', async ({ page }) => {
    const serverCtx = await startServer();
    try {
      const runId = '20260101-pr-toggle';
      seedWithPR(serverCtx.worcaDir, runId);
      await openRunDetail(page, serverCtx.url, runId);

      const details = page.locator('sl-details.pr-details-section');
      await expect(details).not.toHaveAttribute('open');

      await expandDetails(details);
      await expect(details).toHaveAttribute('open');

      await details.evaluate((el) => el.hide());
      await expect(details).not.toHaveAttribute('open', { timeout: 3000 });
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

      const details = page.locator('sl-details.pr-details-section');
      await expandDetails(details);

      // The link exists in the DOM inside the expanded section.
      // toHaveAttribute works regardless of visibility state.
      const prLink = details.locator('.run-pr-link').first();
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

      const details = page.locator('sl-details.pr-details-section');
      await expandDetails(details);

      const copyButton = details.locator('sl-copy-button');
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

      // Mock clipboard.writeText before navigation so Shoelace's component
      // uses our spy when handleCopy() is invoked.
      await page.addInitScript(() => {
        window.__lastClipboardWrite = null;
        navigator.clipboard.writeText = (text) => {
          window.__lastClipboardWrite = text;
          return Promise.resolve();
        };
      });

      await openRunDetail(page, serverCtx.url, runId);
      const details = page.locator('sl-details.pr-details-section');
      await expandDetails(details);

      // Call handleCopy() directly — it's a public method on the Shoelace
      // component and calls navigator.clipboard.writeText(this.value).
      await details.evaluate((el) => {
        el.querySelector('sl-copy-button')?.handleCopy();
      });

      const written = await page.evaluate(() => window.__lastClipboardWrite);
      expect(written).toBe(PR_DATA.commit_sha);
    } finally {
      await serverCtx.close();
    }
  });

  test('section absent when run has no PR data', async ({ page }) => {
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

      await expect(page.locator('sl-details.pr-details-section')).not.toBeAttached();
    } finally {
      await serverCtx.close();
    }
  });
});
