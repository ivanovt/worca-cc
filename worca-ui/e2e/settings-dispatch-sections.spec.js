/**
 * Playwright e2e tests for the W-054 three-section dispatch editor —
 * tools, skills, and cross-cutting behavior. Complements
 * settings-dispatch.spec.js (which focuses on subagents).
 *
 * Run with: cd worca-ui && npx playwright test e2e/settings-dispatch-sections.spec.js --workers=1
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

async function goToGovernance(page, ctx, settings = {}) {
  writeFileSync(
    join(ctx.dir, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  );
  await page.goto(`${ctx.url}/#/project-settings`, GOTO_OPTS);
  await page.locator('sl-tab[panel="governance"]').click();
}

async function saveGovernanceTab(page) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes('/api/settings') &&
        res.request().method() === 'POST',
      { timeout: 8000 },
    ),
    page.evaluate(() => {
      const panel = document.querySelector('sl-tab-panel[name="governance"]');
      if (!panel) throw new Error('governance sl-tab-panel not found');
      const btn = panel.querySelector(
        '.settings-tab-actions sl-button[variant="primary"]',
      );
      if (!btn) throw new Error('Save sl-button not found in governance panel');
      btn.click();
    }),
  ]);
  expect(response.ok()).toBe(true);
}

// ─── Tools section ───────────────────────────────────────────────────────────

test('tools section: always_disallowed chips render locked and non-removable', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});

    // EnterPlanMode is in DISPATCH_DEFAULTS.tools.always_disallowed.
    // It should render with the dispatch-chip-locked class and NOT have the
    // removable attribute.
    const lockedChip = page.locator(
      'sl-tag.dispatch-chip-locked[data-value="EnterPlanMode"]',
    );
    await expect(lockedChip).toBeVisible();
    await expect(lockedChip).not.toHaveAttribute('removable', '');
  } finally {
    await ctx.close();
  }
});

test('tools section: add custom tag via Enter persists through save round-trip', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});

    const input = page.locator(
      '#dispatch-tools-planner .dispatch-tag-input-field',
    );
    await input.click();
    await input.fill('Bash');
    await input.press('Enter');

    await expect(
      page.locator('#dispatch-tools-planner sl-tag[data-value="Bash"]'),
    ).toBeVisible();

    await saveGovernanceTab(page);

    const basePath = join(ctx.dir, 'settings.json');
    expect(existsSync(basePath)).toBe(true);
    const saved = JSON.parse(readFileSync(basePath, 'utf8'));
    expect(
      saved.worca?.governance?.dispatch?.tools?.per_agent_allow?.planner,
    ).toContain('Bash');
  } finally {
    await ctx.close();
  }
});

// ─── Skills section ──────────────────────────────────────────────────────────

test('skills section: default_denied chip renders with warn class and is removable', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});

    // `review` is in DISPATCH_DEFAULTS.skills.default_denied. The Default
    // Denied tier renders chips with dispatch-chip-warn + removable.
    const reviewChip = page.locator(
      'sl-tag.dispatch-chip-warn[data-value="review"]',
    );
    await expect(reviewChip).toBeVisible();
    await expect(reviewChip).toHaveAttribute('removable', '');

    await reviewChip.dispatchEvent('sl-remove');
    await expect(reviewChip).not.toBeAttached();
  } finally {
    await ctx.close();
  }
});

test('skills section: add via suggestions persists through save round-trip', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});

    const input = page.locator(
      '#dispatch-skills-implementer .dispatch-tag-input-field',
    );
    await input.click();
    // feature-dev:code-reviewer is in known-skills.json and NOT in any
    // skill deny tier — should appear as a non-denied suggestion.
    await input.fill('code-reviewer');

    const suggestions = page.locator(
      '.settings-dispatch-row:has(#dispatch-skills-implementer) .dispatch-suggestions',
    );
    await expect(suggestions).toBeVisible();
    const item = suggestions.locator('.item:not(.denied)').filter({
      hasText: 'feature-dev:code-reviewer',
    });
    await expect(item).toBeVisible();
    await item.click();

    await expect(
      page.locator(
        '#dispatch-skills-implementer sl-tag[data-value="feature-dev:code-reviewer"]',
      ),
    ).toBeVisible();

    await saveGovernanceTab(page);

    const saved = JSON.parse(
      readFileSync(join(ctx.dir, 'settings.json'), 'utf8'),
    );
    expect(
      saved.worca?.governance?.dispatch?.skills?.per_agent_allow?.implementer,
    ).toContain('feature-dev:code-reviewer');
  } finally {
    await ctx.close();
  }
});

test('skills section: always_disallowed item appears greyed in suggestions and cannot be added', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});

    const input = page.locator(
      '#dispatch-skills-coordinator .dispatch-tag-input-field',
    );
    await input.click();
    // `loop` is in DISPATCH_DEFAULTS.skills.always_disallowed.
    await input.fill('loop');

    const suggestions = page.locator(
      '.settings-dispatch-row:has(#dispatch-skills-coordinator) .dispatch-suggestions',
    );
    await expect(suggestions).toBeVisible();
    const deniedItem = suggestions
      .locator('.item.denied')
      .filter({ hasText: 'loop' });
    await expect(deniedItem).toBeVisible();

    await deniedItem.click();
    await expect(
      page.locator('#dispatch-skills-coordinator sl-tag[data-value="loop"]'),
    ).not.toBeAttached();
  } finally {
    await ctx.close();
  }
});

// ─── Cross-cutting ───────────────────────────────────────────────────────────

test('_defaults row is editable like any per-agent row', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});

    // Subagents _defaults starts with ["Explore"]. Add a second tag.
    const input = page.locator(
      '#dispatch-subagents-_defaults .dispatch-tag-input-field',
    );
    await input.click();
    await input.fill('Plan');
    await input.press('Enter');

    await expect(
      page.locator('#dispatch-subagents-_defaults sl-tag[data-value="Plan"]'),
    ).toBeVisible();
    await expect(
      page.locator('#dispatch-subagents-_defaults sl-tag[data-value="Explore"]'),
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('wildcard `*` chip renders with `any` label and dispatch-chip-wildcard class', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    // Default tools.per_agent_allow._defaults = ["*"] → wildcard chip should
    // render with the special styling and "any" label.
    await goToGovernance(page, ctx, {});

    const wildcardChip = page.locator(
      '#dispatch-tools-_defaults sl-tag.dispatch-chip-wildcard[data-value="*"]',
    );
    await expect(wildcardChip).toBeVisible();
    await expect(wildcardChip).toContainText('any');
  } finally {
    await ctx.close();
  }
});

test('Esc clears input and dismisses suggestions popup', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Pre-populate coordinator: [] so the row is truly empty (otherwise the
    // section's `_defaults: ["Explore"]` would render an effective chip and
    // exclude Explore from the suggestion matches for 'exp').
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            subagents: { per_agent_allow: { coordinator: [] } },
          },
        },
      },
    });

    const input = page.locator(
      '#dispatch-subagents-coordinator .dispatch-tag-input-field',
    );
    await input.click();
    await input.fill('exp');

    const suggestions = page.locator(
      '.settings-dispatch-row:has(#dispatch-subagents-coordinator) .dispatch-suggestions',
    );
    await expect(suggestions).toBeVisible();

    await input.press('Escape');

    await expect(suggestions).not.toBeAttached();
    await expect(input).toHaveValue('');
    // No tag added either
    await expect(
      page.locator('#dispatch-subagents-coordinator sl-tag[data-value="exp"]'),
    ).not.toBeAttached();
  } finally {
    await ctx.close();
  }
});
