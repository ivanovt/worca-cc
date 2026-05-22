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

test('renders Graphify tab with the off/structural/full state control', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGraphifyTab(page, ctx, {
      worca: { graphify: { enabled: true, mode: 'structural' } },
    });

    // Single combined control replaces the former switch + mode radios.
    await expect(page.locator('#graphify-state')).toBeAttached();
    await expect(page.locator('#graphify-enabled')).toHaveCount(0);
    await expect(page.locator('#graphify-mode')).toHaveCount(0);
    // Model Profile is shown only when not off.
    await expect(page.locator('#graphify-backend')).toBeAttached();
  } finally {
    await ctx.close();
  }
});

test('state control reflects off when graphify is disabled', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGraphifyTab(page, ctx, {
      worca: { graphify: { enabled: false } },
    });

    const stateGroup = page.locator('#graphify-state');
    await expect(stateGroup).toBeAttached();
    const value = await stateGroup.evaluate((el) => el.value);
    expect(value).toBe('off');
    // Off hides the model profile + privacy notice.
    await expect(page.locator('#graphify-backend')).toHaveCount(0);
    await expect(page.locator('#graphify-privacy-notice')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test('state control renders as registered sl-radio-button controls', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGraphifyTab(page, ctx, {
      worca: { graphify: { enabled: true, mode: 'structural' } },
    });

    // Regression guard: the state control uses <sl-radio-button>, which must
    // be registered (imported in main.js) or it renders as inert run-together
    // text ("offstructuralfull") instead of a segmented toggle. radio-group's
    // .value works regardless, so value-only assertions don't catch this.
    const defined = await page.evaluate(() =>
      Boolean(customElements.get('sl-radio-button')),
    );
    expect(defined).toBe(true);
    await expect(page.locator('#graphify-state sl-radio-button')).toHaveCount(3);
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
