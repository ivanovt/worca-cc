/**
 * Playwright e2e tests for the Overlays tab in the Pipelines editor.
 *
 * W-064 Phase 7: verifies that a template with overlays shows an Overlays
 * tab in the editor, that the tab is absent for templates without overlays,
 * and that expanding a stage card renders the markdown content.
 *
 * Run with:
 *   cd worca-ui && npx playwright test e2e/pipelines-overlays.spec.js --workers=1
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

/**
 * Write a project-tier template with overlay files to the fixture dir.
 */
function seedTemplateWithOverlays(dir, tid, overlays = {}) {
  const templateDir = join(dir, '.claude', 'templates', tid);
  const agentsDir = join(templateDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });

  const tpl = {
    id: tid,
    name: `Overlay Template ${tid}`,
    description: 'Has prompt overlays',
    tags: ['test'],
    config: {
      stages: { plan: { enabled: true, agent: 'planner' } },
      agents: { planner: { model: 'sonnet', max_turns: 30 } },
    },
  };
  writeFileSync(join(templateDir, 'template.json'), JSON.stringify(tpl, null, 2));

  for (const [filename, content] of Object.entries(overlays)) {
    writeFileSync(join(agentsDir, filename), content, 'utf8');
  }
}

/**
 * Write a project-tier template without any overlay files.
 */
function seedTemplateNoOverlays(dir, tid) {
  const templateDir = join(dir, '.claude', 'templates', tid);
  mkdirSync(templateDir, { recursive: true });
  const tpl = {
    id: tid,
    name: `Plain Template ${tid}`,
    description: 'No overlays',
    tags: ['test'],
    config: {},
  };
  writeFileSync(join(templateDir, 'template.json'), JSON.stringify(tpl, null, 2));
}

// ─── Test 1: Overlays tab visible when overlays present ──────────────────────

test('Overlays tab appears in editor when template has overlay files', async ({ page }) => {
  const ctx = await startServer();
  try {
    seedTemplateWithOverlays(ctx.dir, 'overlay-tpl', {
      'planner.md': '# Custom Planner\n\nThis is the **custom** planner overlay.',
    });

    await page.goto(`${ctx.url}/#/templates/project/overlay-tpl/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 15000 });

    // Wait for overlays to be probed (async background fetch on template load)
    await expect
      .poll(
        async () => {
          const tab = page.locator('.editor-tab-group sl-tab[panel="overlays"]');
          return await tab.isVisible().catch(() => false);
        },
        { timeout: 8000 },
      )
      .toBe(true);

    const overlaysTab = page.locator('.editor-tab-group sl-tab[panel="overlays"]');
    await expect(overlaysTab).toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ─── Test 2: Overlays tab absent when no overlays ────────────────────────────

test('Overlays tab is absent when template has no overlay files', async ({ page }) => {
  const ctx = await startServer();
  try {
    seedTemplateNoOverlays(ctx.dir, 'plain-tpl');

    await page.goto(`${ctx.url}/#/templates/project/plain-tpl/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 15000 });

    // Wait for template to load fully (Agents tab is default)
    await expect(page.locator('.editor-tab-group sl-tab[panel="agents"]')).toBeVisible({
      timeout: 8000,
    });

    // Give overlays probe time to complete
    await page.waitForTimeout(1500);

    const overlaysTab = page.locator('.editor-tab-group sl-tab[panel="overlays"]');
    await expect(overlaysTab).not.toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ─── Test 3: Expand Plan card → assert markdown rendered ─────────────────────

test('Overlays tab — expand Plan card renders markdown heading', async ({ page }) => {
  const ctx = await startServer();
  try {
    const plannerContent = '# My Planner Overlay\n\nHello from the **planner** overlay.';
    seedTemplateWithOverlays(ctx.dir, 'md-tpl', {
      'planner.md': plannerContent,
    });

    await page.goto(`${ctx.url}/#/templates/project/md-tpl/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 15000 });

    // Wait for Overlays tab to appear
    const overlaysTab = page.locator('.editor-tab-group sl-tab[panel="overlays"]');
    await expect
      .poll(
        async () => overlaysTab.isVisible().catch(() => false),
        { timeout: 8000 },
      )
      .toBe(true);

    // Click the Overlays tab
    await overlaysTab.click();

    // Wait for the overlays panel to be visible
    const overlaysPanel = page.locator('sl-tab-panel[name="overlays"]');
    await expect(overlaysPanel).toBeAttached({ timeout: 5000 });

    // The Plan stage should render as sl-details (expandable)
    const planDetails = overlaysPanel.locator('sl-details[summary="Plan"]');
    await expect(planDetails).toBeAttached({ timeout: 5000 });

    // Open the Plan stage card
    await planDetails.click();

    // The markdown content should contain the heading text
    const markdownBody = overlaysPanel.locator('.markdown-body');
    await expect(markdownBody.first()).toContainText('My Planner Overlay', { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── Test 4: Disabled stages rendered for stages without overlays ─────────────

test('Overlays tab — stages with no overlays are disabled (not sl-details)', async ({ page }) => {
  const ctx = await startServer();
  try {
    seedTemplateWithOverlays(ctx.dir, 'partial-tpl', {
      'planner.md': '# Planner only',
    });

    await page.goto(`${ctx.url}/#/templates/project/partial-tpl/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 15000 });

    const overlaysTab = page.locator('.editor-tab-group sl-tab[panel="overlays"]');
    await expect
      .poll(
        async () => overlaysTab.isVisible().catch(() => false),
        { timeout: 8000 },
      )
      .toBe(true);

    await overlaysTab.click();

    const overlaysPanel = page.locator('sl-tab-panel[name="overlays"]');
    await expect(overlaysPanel).toBeAttached({ timeout: 5000 });

    // Disabled cards for stages without overlays
    const disabledCards = overlaysPanel.locator('.overlay-stage-card--disabled');
    const disabledCount = await disabledCards.count();
    // There are 8 stages total; only plan has an overlay → 7 disabled
    expect(disabledCount).toBe(7);
  } finally {
    await ctx.close();
  }
});
