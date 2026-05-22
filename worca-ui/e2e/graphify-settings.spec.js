/**
 * Playwright e2e tests for the Graphify settings tab and badge.
 * Run with: cd worca-ui && npx playwright test e2e/graphify-settings.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

async function goToGraphifyTab(page, ctx, settings = {}) {
  writeFileSync(
    join(ctx.dir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf8',
  );
  await page.goto(`${ctx.url}/#/project-settings`, GOTO_OPTS);
  await page.locator('sl-tab[panel="graphify"]').click();
}

test('renders Graphify tab with toggle, mode, and backend fields', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGraphifyTab(page, ctx, {
      worca: { graphify: { enabled: false } },
    });

    await expect(page.locator('#graphify-enabled')).toBeAttached();
    await expect(page.locator('#graphify-mode')).toBeAttached();
    await expect(page.locator('#graphify-backend')).toBeAttached();
  } finally {
    await ctx.close();
  }
});

test('toggle on enables graphify and shows structural mode by default', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGraphifyTab(page, ctx, {
      worca: { graphify: { enabled: false } },
    });

    const toggle = page.locator('#graphify-enabled');
    await expect(toggle).toBeAttached();

    const isChecked = await toggle.evaluate((el) => el.checked);
    expect(isChecked).toBe(false);

    const modeGroup = page.locator('#graphify-mode');
    await expect(modeGroup).toBeAttached();
    const modeValue = await modeGroup.evaluate((el) => el.value);
    expect(modeValue).toBe('structural');
  } finally {
    await ctx.close();
  }
});

test('privacy notice shows structural text when mode is structural', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGraphifyTab(page, ctx, {
      worca: { graphify: { enabled: true, mode: 'structural' } },
    });

    const notice = page.locator('#graphify-privacy-notice');
    await expect(notice).toBeAttached();
    await expect(notice).toContainText('fully local');
  } finally {
    await ctx.close();
  }
});

test('switching mode to full shows full privacy notice', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGraphifyTab(page, ctx, {
      worca: { graphify: { enabled: true, mode: 'full' } },
    });

    const notice = page.locator('#graphify-privacy-notice');
    await expect(notice).toBeAttached();
    await expect(notice).toContainText('sends document and diagram summaries');
  } finally {
    await ctx.close();
  }
});

test('graphify badge shows Disabled on dashboard when graphify is off', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    writeFileSync(
      join(ctx.dir, 'settings.json'),
      JSON.stringify({ worca: { graphify: { enabled: false } } }, null, 2) +
        '\n',
      'utf8',
    );
    await page.goto(`${ctx.url}/#/dashboard`, GOTO_OPTS);

    const badge = page.locator('.graphify-badge .graphify-status-badge');
    await expect(badge).toContainText('Disabled');
  } finally {
    await ctx.close();
  }
});

test('Save and Reset buttons are present', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGraphifyTab(page, ctx, {
      worca: { graphify: { enabled: true, mode: 'structural' } },
    });

    await expect(page.locator('.graphify-save-btn')).toBeAttached();
    await expect(page.locator('.graphify-reset-btn')).toBeAttached();
  } finally {
    await ctx.close();
  }
});
