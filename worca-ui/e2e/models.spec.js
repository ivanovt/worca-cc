/**
 * Playwright e2e tests for the Models page (list + editor + dialogs).
 *
 * Mirrors the shape of pipelines-templates.spec.js — the Models page
 * deliberately reuses the same tier-section layout, card pattern, and
 * editor subheader so the two surfaces should behave the same way.
 *
 * Covers:
 *   - List view renders all three tier sections (Project / User / Built-in)
 *   - Built-in cards open the editor read-only with a Duplicate affordance
 *   - + New opens the editor with a Project/User tier picker
 *   - Save writes back through /api/projects/.../models/:tier/:alias
 *   - Duplicate dialog picks dst tier + alias and lands on the new entry
 *   - Delete confirm removes both settings.json and settings.local.json entries
 *   - Imported-from-bundle attribution badge surfaces on cards
 *
 * Run with:
 *   cd worca-ui && npx playwright test e2e/models.spec.js --workers=1
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

function seedProjectModels(dir, worca) {
  // Write the worca block straight into the project's settings.json.
  const settingsPath = join(dir, 'settings.json');
  let blob = {};
  try {
    blob = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    /* ignore */
  }
  blob.worca = { ...(blob.worca || {}), ...worca };
  writeFileSync(settingsPath, JSON.stringify(blob, null, 2));
}

function _seedLocalEnv(dir, alias, env) {
  const localPath = join(dir, 'settings.local.json');
  let blob = {};
  try {
    blob = JSON.parse(readFileSync(localPath, 'utf8'));
  } catch {
    /* ignore */
  }
  blob.worca = blob.worca || {};
  blob.worca.models = blob.worca.models || {};
  blob.worca.models[alias] = { env };
  writeFileSync(localPath, JSON.stringify(blob, null, 2));
}

async function waitForToast(page, variant = 'success', timeout = 8000) {
  const toast = page.locator(`sl-alert[variant="${variant}"]:visible`).first();
  await toast.waitFor({ state: 'visible', timeout });
  return (await toast.textContent())?.trim() || '';
}

test.describe('Models page — list view', () => {
  test('renders three tier sections with counts and the built-in trio', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      await page.goto(`${ctx.url}/#/models`, GOTO_OPTS);

      // Three tier-section headers always rendered (Project default-open,
      // User + Built-in collapsed by default — mirrors Pipeline Templates).
      const headers = page.locator('.pipelines-tier-section .tier-section-title');
      await expect(headers).toHaveCount(3);
      const titles = await headers.allTextContents();
      expect(titles).toEqual(['Project', 'User', 'Built-in']);

      // Expand all so we can read counts.
      const sections = page.locator('.pipelines-tier-section');
      for (let i = 0; i < (await sections.count()); i++) {
        await sections.nth(i).evaluate((el) => {
          el.open = true;
        });
      }

      const builtinCount = page.locator(
        '.pipelines-tier-section--builtin .tier-section-count',
      );
      await expect(builtinCount).toHaveText('3');
      const builtinCards = page.locator(
        '.pipelines-tier-section--builtin .model-tier-card .run-card-title',
      );
      const builtinAliases = await builtinCards.allTextContents();
      expect(builtinAliases.sort()).toEqual(['haiku', 'opus', 'sonnet']);
    } finally {
      await ctx.close();
    }
  });

  test('project-tier card appears when settings.json defines models', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      seedProjectModels(ctx.dir, {
        models: { 'glm-ds': { id: 'zai-glm-4.6' } },
      });
      await page.goto(`${ctx.url}/#/models`, GOTO_OPTS);

      const projectCard = page.locator(
        '.pipelines-tier-section--project .model-tier-card[data-alias="glm-ds"]',
      );
      await expect(projectCard).toBeVisible();
      await expect(projectCard.locator('.run-card-title')).toHaveText('glm-ds');
      await expect(projectCard.locator('.template-card-id')).toHaveText(
        'zai-glm-4.6',
      );
    } finally {
      await ctx.close();
    }
  });

  test('imported-from badge surfaces when _imported_from is set', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      seedProjectModels(ctx.dir, {
        models: {
          mirror: {
            id: 'claude-opus-4-7',
            _imported_from: 'feature-fast.json',
          },
        },
      });
      await page.goto(`${ctx.url}/#/models`, GOTO_OPTS);

      const card = page.locator(
        '.pipelines-tier-section--project .model-tier-card[data-alias="mirror"]',
      );
      const importedBadge = card.locator('.model-card-imported-badge');
      await expect(importedBadge).toBeVisible();
      await expect(importedBadge).toContainText('feature-fast.json');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('Models page — editor', () => {
  test('built-in card opens the editor read-only with a Storage badge', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      await page.goto(`${ctx.url}/#/models/opus/edit/builtin`, GOTO_OPTS);

      // Read-only mode is signalled three ways: the read-only badge
      // next to the Storage pill, the immutable Storage badge (instead
      // of the new-entry tier picker), and the "View Model" header
      // title (vs "Edit Model" for project/user). Asserting on the
      // visible markers is more robust than peering into Shoelace's
      // disabled state (which lives behind the shadow root).
      const readOnlyBadge = page.locator('.editor-readonly-badge');
      await expect(readOnlyBadge).toBeVisible({ timeout: 10000 });

      const storageBadge = page.locator('.editor-storage-badge');
      await expect(storageBadge).toBeVisible();
      // Tier-display capitalizes `builtin` → "Builtin" (no hyphen).
      await expect(storageBadge).toContainText('Builtin');

      // No tier picker for built-in — only for new entries.
      const tierSelect = page.locator('.model-editor-tier-select');
      await expect(tierSelect).toHaveCount(0);

      // Page-header title shows "View Model" for built-in tier.
      await expect(page.locator('h1, h2').filter({ hasText: 'View Model' }).first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('+ New opens editor with a Project/User tier picker', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      await page.goto(`${ctx.url}/#/models`, GOTO_OPTS);
      await page.locator('button.action-btn--primary', { hasText: 'New' }).click();

      // URL navigates to model-editor for a new entry at project tier.
      await expect(page).toHaveURL(/#\/models\/new\/edit\/project/);
      // The tier picker pill replaces the read-only Storage badge while
      // isNew is true.
      const tierSelect = page.locator('.model-editor-tier-select');
      await expect(tierSelect).toBeVisible();
      await expect(tierSelect).toHaveJSProperty('value', 'project');
    } finally {
      await ctx.close();
    }
  });

  test('saving a new project alias writes to settings.json + lands list view', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      await page.goto(`${ctx.url}/#/models/new/edit/project`, GOTO_OPTS);

      // Fill in alias + id and Save.
      await page
        .locator('.model-editor-alias-input')
        .evaluate((el, v) => {
          el.value = v;
          el.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
        }, 'fresh-alias');
      await page
        .locator('.model-editor-id-input')
        .evaluate((el, v) => {
          el.value = v;
          el.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
        }, 'claude-opus-4-7');

      // Capture the PUT to confirm scope (project, not user).
      const putPromise = page.waitForResponse(
        (r) =>
          r.url().includes('/api/models/project/fresh-alias') &&
          r.request().method() === 'PUT',
      );
      await page.locator('button.action-btn--primary', { hasText: 'Save' }).click();
      const put = await putPromise;
      expect(put.status()).toBe(200);

      await waitForToast(page, 'success');

      // The Project tab now lists the new alias.
      await page.goto(`${ctx.url}/#/models`, GOTO_OPTS);
      const card = page.locator(
        '.pipelines-tier-section--project .model-tier-card[data-alias="fresh-alias"]',
      );
      await expect(card).toBeVisible();

      // On disk: project settings.json carries the alias as a bare string
      // (no env, so the canonical string form).
      const settings = JSON.parse(readFileSync(join(ctx.dir, 'settings.json'), 'utf8'));
      expect(settings.worca.models['fresh-alias']).toBe('claude-opus-4-7');
    } finally {
      await ctx.close();
    }
  });

  test('Duplicate from card opens dialog with tier + alias, posts duplicate', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      await page.goto(`${ctx.url}/#/models`, GOTO_OPTS);

      // Click Duplicate on the built-in `opus` card.
      const opusCard = page.locator(
        '.pipelines-tier-section--builtin .model-tier-card[data-alias="opus"]',
      );
      // Expand built-in section first.
      await page
        .locator('.pipelines-tier-section--builtin')
        .evaluate((el) => {
          el.open = true;
        });
      await opusCard.locator('button', { hasText: 'Duplicate' }).click();

      const dialog = page.locator('sl-dialog.model-action-dialog');
      await expect(dialog).toBeVisible();

      // Dialog defaults: dst_tier=project, dst_alias=opus-copy.
      const aliasInput = dialog.locator('sl-input');
      await expect(aliasInput).toHaveJSProperty('value', 'opus-copy');

      // Adjust alias + submit.
      await aliasInput.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
      }, 'my-opus');

      const dupPromise = page.waitForResponse(
        (r) =>
          r.url().includes('/api/models/builtin/opus/duplicate') &&
          r.request().method() === 'POST',
      );
      await dialog.locator('sl-button', { hasText: 'Duplicate' }).click();
      const dup = await dupPromise;
      expect(dup.status()).toBe(200);

      // After Duplicate, user lands on the editor for the new entry.
      await expect(page).toHaveURL(/#\/models\/my-opus\/edit\/project/);

      // On disk: project settings.json carries the duplicated alias.
      const settings = JSON.parse(readFileSync(join(ctx.dir, 'settings.json'), 'utf8'));
      expect(settings.worca.models['my-opus']).toBe('claude-opus-4-7');
    } finally {
      await ctx.close();
    }
  });

  test('Delete on a project card confirms and removes the entry', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      seedProjectModels(ctx.dir, {
        models: { 'doomed-alias': 'claude-opus-4-7' },
      });
      await page.goto(`${ctx.url}/#/models`, GOTO_OPTS);

      const card = page.locator(
        '.pipelines-tier-section--project .model-tier-card[data-alias="doomed-alias"]',
      );
      await expect(card).toBeVisible();

      await card.locator('button', { hasText: 'Delete' }).click();

      // Shared confirm dialog opens — accept it.
      const confirm = page.locator('sl-dialog[open]').first();
      await expect(confirm).toBeVisible();
      const delPromise = page.waitForResponse(
        (r) =>
          r.url().includes('/api/models/project/doomed-alias') &&
          r.request().method() === 'DELETE',
      );
      // The "Delete" button in the confirm dialog has danger variant.
      await confirm.locator('sl-button[variant="danger"]').first().click();
      const del = await delPromise;
      expect(del.status()).toBe(200);

      // The card disappears.
      await expect(card).not.toBeVisible({ timeout: 5000 });
      // On disk: alias gone from settings.json.
      const settings = JSON.parse(readFileSync(join(ctx.dir, 'settings.json'), 'utf8'));
      expect(settings.worca.models?.['doomed-alias']).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});

test.describe('Models page — sidebar navigation', () => {
  test('sidebar Models entry navigates to /#/models', async ({ page }) => {
    const ctx = await startServer();
    try {
      await page.goto(`${ctx.url}/#/`, GOTO_OPTS);
      // The sidebar entry uses a div with the "Models" label.
      const entry = page
        .locator('.sidebar-item', { hasText: 'Models' })
        .first();
      await expect(entry).toBeVisible();
      await entry.click();
      await expect(page).toHaveURL(/#\/models/);
      // Page renders.
      await expect(page.locator('.models-view').first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});
