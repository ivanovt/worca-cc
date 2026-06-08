/**
 * Playwright e2e for the template Export dialog (standalone vs delta).
 * Run with: cd worca-ui && npx playwright test e2e/pipelines-export.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, expandAllTierSections } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

function seedMinimal(dir) {
  const builtInDir = join(dir, '.claude', 'worca', 'templates', 'minimal');
  mkdirSync(builtInDir, { recursive: true });
  writeFileSync(
    join(builtInDir, 'template.json'),
    JSON.stringify({
      id: 'minimal',
      name: 'Minimal Pipeline',
      description: 'A minimal pipeline for quick testing',
      tags: ['minimal'],
      builtin: true,
      config: { agents: { implementer: { model: 'sonnet', max_turns: 30 } } },
    }),
  );
}

test('export dialog defaults to standalone and can switch to delta', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedMinimal(ctx.dir);
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    const card = page
      .locator('.template-card')
      .filter({ hasText: 'Minimal Pipeline' });
    await expect(card).toBeAttached();

    // Open the export dialog.
    const exportButton = card.locator('button:has-text("Export")').first();
    await exportButton.click();

    const dialog = page.locator('sl-dialog.template-action-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Both modes present; standalone selected by default.
    const group = dialog.locator('#dlg-export-mode');
    await expect(group).toHaveJSProperty('value', 'standalone');
    await expect(dialog.locator('sl-radio[value="standalone"]')).toBeVisible();
    await expect(dialog.locator('sl-radio[value="delta"]')).toBeVisible();

    // Confirm in standalone mode → GET /bundle?mode=standalone, download fires.
    const standaloneReq = page.waitForRequest(
      (r) => r.url().includes('/bundle?mode=standalone'),
      { timeout: 10000 },
    );
    const download1 = page.waitForEvent('download', { timeout: 10000 });
    await dialog
      .locator('sl-button[variant="primary"]')
      .click();
    await standaloneReq;
    await download1;

    // Re-open, switch to delta, confirm → GET /bundle?mode=delta.
    await exportButton.click();
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.locator('sl-radio[value="delta"]').click();
    const deltaReq = page.waitForRequest(
      (r) => r.url().includes('/bundle?mode=delta'),
      { timeout: 10000 },
    );
    const download2 = page.waitForEvent('download', { timeout: 10000 });
    await dialog.locator('sl-button[variant="primary"]').click();
    await deltaReq;
    await download2;
  } finally {
    await ctx.close?.();
  }
});
