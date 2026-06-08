/**
 * Playwright e2e tests for the Prompts tab in the Pipelines editor.
 *
 * The Prompts tab is always shown and always lists the effective per-stage
 * prompt, classifying each file as Built-in (fallback), Replaced (the pipeline
 * overrides it wholesale), or Merged (the pipeline appends/overwrites sections
 * of the built-in). These tests seed the built-in core prompts (always present
 * in a real install) plus a project-tier template overlay and assert the
 * resulting visualization.
 *
 * Run with:
 *   cd worca-ui && npx playwright test e2e/pipelines-overlays.spec.js --workers=1
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

/** Seed the built-in core prompts the server resolves against. */
function seedCorePrompts(dir, files) {
  const coreDir = join(dir, '.claude', 'worca', 'agents', 'core');
  mkdirSync(coreDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(coreDir, name), content, 'utf8');
  }
}

/** Write a project-tier template, optionally with overlay files. */
function seedTemplate(dir, tid, overlays = null) {
  const templateDir = join(dir, '.claude', 'templates', tid);
  mkdirSync(templateDir, { recursive: true });
  const tpl = {
    id: tid,
    name: `Template ${tid}`,
    description: 'test',
    tags: ['test'],
    config: {
      stages: { plan: { enabled: true, agent: 'planner' } },
      agents: { planner: { model: 'sonnet', max_turns: 30 } },
    },
  };
  writeFileSync(join(templateDir, 'template.json'), JSON.stringify(tpl, null, 2));
  if (overlays) {
    const agentsDir = join(templateDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    for (const [name, content] of Object.entries(overlays)) {
      writeFileSync(join(agentsDir, name), content, 'utf8');
    }
  }
}

async function openPromptsTab(page, ctx, tid) {
  await page.goto(`${ctx.url}/#/templates/project/${tid}/edit`, GOTO_OPTS);
  await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 15000 });
  const promptsTab = page.locator('.editor-tab-group sl-tab[panel="prompts"]');
  await expect(promptsTab).toBeVisible({ timeout: 8000 });
  await promptsTab.click();
  const panel = page.locator('sl-tab-panel[name="prompts"]');
  await expect(panel).toBeAttached({ timeout: 5000 });
  return panel;
}

// ─── Test 1: tab is always present, even with no overlays ────────────────────

test('Prompts tab is always shown, even for a template with no overlays', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedCorePrompts(ctx.dir, { 'planner.md': '# Core Planner\n\nbuilt-in body' });
    seedTemplate(ctx.dir, 'plain-tpl'); // no overlays

    const panel = await openPromptsTab(page, ctx, 'plain-tpl');
    const planDetails = panel.locator('sl-details[summary="Plan"]');
    await expect(planDetails).toBeAttached({ timeout: 5000 });
    await planDetails.click();
    // Built-in fallback content is shown.
    await expect(panel.locator('.markdown-body').first()).toContainText(
      'Core Planner',
      { timeout: 5000 },
    );
    // …with a Built-in source badge inside the stage card.
    await expect(planDetails.locator('.prompt-source-badge').first()).toContainText(
      'Built-in',
    );
  } finally {
    await ctx.close();
  }
});

// ─── Test 2: replace overlay → "Replaced" badge + overlay content ────────────

test('Prompts tab shows a Replaced badge and the overlay content for a full override', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedCorePrompts(ctx.dir, { 'planner.md': '# Core Planner\n\nbuilt-in body' });
    seedTemplate(ctx.dir, 'replace-tpl', {
      'planner.md': '# Custom Planner\n\nfully replaced body',
    });

    const panel = await openPromptsTab(page, ctx, 'replace-tpl');
    const planDetails = panel.locator('sl-details[summary="Plan"]');
    await planDetails.click();
    await expect(planDetails.locator('.prompt-source-badge').first()).toContainText(
      'Replaced',
    );
    await expect(panel.locator('.markdown-body').first()).toContainText(
      'Custom Planner',
      { timeout: 5000 },
    );
  } finally {
    await ctx.close();
  }
});

// ─── Test 3: append overlay → "Merged" badge + green append highlight ────────

test('Prompts tab merges an append overlay and highlights the appended section', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedCorePrompts(ctx.dir, {
      'planner.md': '# Core Planner\n\n## Rules\n\nbuilt-in rules',
    });
    seedTemplate(ctx.dir, 'append-tpl', {
      'planner.md':
        '<!-- append -->\n## Override: Rules\nan extra project-specific rule',
    });

    const panel = await openPromptsTab(page, ctx, 'append-tpl');
    const planDetails = panel.locator('sl-details[summary="Plan"]');
    await planDetails.click();
    await expect(planDetails.locator('.prompt-source-badge').first()).toContainText(
      'Merged',
    );
    // The built-in base is shown…
    await expect(planDetails).toContainText('Built-in base', { timeout: 5000 });
    // …and the appended section is highlighted with the append (green) treatment.
    await expect(planDetails.locator('.prompt-merge-append').first()).toBeAttached({
      timeout: 5000,
    });
    await expect(planDetails).toContainText('Appends to');
    await expect(planDetails).toContainText('an extra project-specific rule');
  } finally {
    await ctx.close();
  }
});
