/**
 * Playwright e2e tests for dispatch tag input on the settings Governance tab.
 * Run with: cd worca-ui && npx playwright test e2e/settings-dispatch.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

/**
 * Write settings.json to the temp project dir and navigate to the Governance tab.
 */
async function goToGovernance(page, ctx, settings = {}) {
  writeFileSync(
    join(ctx.dir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf8',
  );
  await page.goto(`${ctx.url}/#/project-settings`, GOTO_OPTS);
  await page.locator('sl-tab[panel="governance"]').click();
}

/**
 * Click the Save button on the governance tab and wait for the POST /api/settings
 * response to confirm the save completed. Uses page.evaluate to invoke .click()
 * directly so the lit-html @click handler fires reliably.
 */
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

// ─── Test 1: renders tag input with current dispatch values ──────────────────

test('renders tag input with current dispatch values', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          subagent_dispatch: {
            planner: ['Explore'],
            implementer: ['Explore', 'feature-dev:code-reviewer'],
          },
        },
      },
    });

    // planner row has exactly 1 chip: "Explore"
    await expect(
      page.locator('#dispatch-subagents-planner sl-tag[data-value="Explore"]'),
    ).toBeVisible();
    await expect(page.locator('#dispatch-subagents-planner sl-tag')).toHaveCount(1);

    // implementer row has exactly 2 chips
    await expect(
      page.locator('#dispatch-subagents-implementer sl-tag[data-value="Explore"]'),
    ).toBeVisible();
    await expect(
      page.locator(
        '#dispatch-subagents-implementer sl-tag[data-value="feature-dev:code-reviewer"]',
      ),
    ).toBeVisible();
    await expect(page.locator('#dispatch-subagents-implementer sl-tag')).toHaveCount(2);
  } finally {
    await ctx.close();
  }
});

// ─── Test 2: add known subagent type via suggestions ─────────────────────────

test('add known subagent type via suggestions', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Pre-populate coordinator with an explicit empty list to override the
    // section's `_defaults: ["Explore"]` inheritance — otherwise the row
    // would already display Explore as an effective chip and the suggestion
    // filter would exclude it.
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            subagents: { per_agent_allow: { coordinator: [] } },
          },
        },
      },
    });

    const input = page.locator('#dispatch-subagents-coordinator .dispatch-tag-input-field');
    await input.click();
    await input.fill('exp');

    // Suggestions popup should appear with "Explore"
    const suggestions = page.locator(
      '.settings-dispatch-row:has(#dispatch-subagents-coordinator) .dispatch-suggestions',
    );
    await expect(suggestions).toBeVisible();
    const exploreItem = suggestions.locator('.item:not(.denied)').filter({
      hasText: 'Explore',
    });
    await expect(exploreItem).toBeVisible();

    // Click the suggestion
    await exploreItem.click();

    // "Explore" chip should now be in coordinator row
    await expect(
      page.locator('#dispatch-subagents-coordinator sl-tag[data-value="Explore"]'),
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ─── Test 3: add custom freeform subagent type via Enter ─────────────────────

test('add custom freeform subagent type via Enter', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Default settings: coordinator starts with []
    await goToGovernance(page, ctx, {});

    const input = page.locator('#dispatch-subagents-coordinator .dispatch-tag-input-field');
    await input.click();
    await input.fill('my-custom-agent');
    await input.press('Enter');

    // Custom tag chip should appear
    await expect(
      page.locator('#dispatch-subagents-coordinator sl-tag[data-value="my-custom-agent"]'),
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ─── Test 4: remove a tag chip ───────────────────────────────────────────────

test('remove a tag chip', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          subagent_dispatch: {
            planner: ['Explore'],
          },
        },
      },
    });

    const chip = page.locator('#dispatch-subagents-planner sl-tag[data-value="Explore"]');
    await expect(chip).toBeVisible();

    // Dispatch the sl-remove event (remove button lives inside shadow DOM)
    await chip.dispatchEvent('sl-remove');

    // Chip should be gone
    await expect(chip).not.toBeAttached();
  } finally {
    await ctx.close();
  }
});

// ─── Test 5: denied type greyed out in suggestions ───────────────────────────

test('denied type shown greyed out and cannot be added', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Default settings: coordinator starts with []
    await goToGovernance(page, ctx, {});

    const input = page.locator('#dispatch-subagents-coordinator .dispatch-tag-input-field');
    await input.click();
    await input.fill('general');

    // Suggestions popup should show "general-purpose" with denied styling
    const suggestions = page.locator(
      '.settings-dispatch-row:has(#dispatch-subagents-coordinator) .dispatch-suggestions',
    );
    await expect(suggestions).toBeVisible();
    const deniedItem = suggestions
      .locator('.item.denied')
      .filter({ hasText: 'general-purpose' });
    await expect(deniedItem).toBeVisible();

    // Click the denied item — it should NOT be added
    await deniedItem.click();
    await expect(
      page.locator('#dispatch-subagents-coordinator sl-tag[data-value="general-purpose"]'),
    ).not.toBeAttached();
  } finally {
    await ctx.close();
  }
});

// ─── Test 6: reset to default ────────────────────────────────────────────────

test('reset to default button restores default tags', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          subagent_dispatch: {
            implementer: ['Explore', 'custom-thing'],
          },
        },
      },
    });

    // Both chips should be present (customized state)
    await expect(
      page.locator('#dispatch-subagents-implementer sl-tag[data-value="Explore"]'),
    ).toBeVisible();
    await expect(
      page.locator('#dispatch-subagents-implementer sl-tag[data-value="custom-thing"]'),
    ).toBeVisible();

    // Reset button should be visible for the customized row
    const resetBtn = page.locator(
      '.settings-dispatch-row:has(#dispatch-subagents-implementer) .dispatch-reset-btn',
    );
    await expect(resetBtn).toBeVisible();

    // Click reset
    await resetBtn.click();

    // Default is ["Explore"] — custom-thing should be gone
    await expect(
      page.locator('#dispatch-subagents-implementer sl-tag[data-value="Explore"]'),
    ).toBeVisible();
    await expect(
      page.locator('#dispatch-subagents-implementer sl-tag[data-value="custom-thing"]'),
    ).not.toBeAttached();
    // Reset button disappears when back to default
    await expect(resetBtn).not.toBeAttached();
  } finally {
    await ctx.close();
  }
});

// ─── Test 7: legacy key warning banner and migration on save ─────────────────

test('legacy governance.dispatch shows warning and migrates to dispatch.subagents on save', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            planner: ['Explore'],
            implementer: ['Explore'],
          },
        },
      },
    });

    // Warning banner should be visible mentioning governance.dispatch
    const warning = page.locator('sl-alert[variant="warning"]').filter({
      hasText: 'governance.dispatch',
    });
    await expect(warning).toBeVisible();

    // Values from legacy key should be rendered in the new per-agent rows
    await expect(
      page.locator('#dispatch-subagents-planner sl-tag[data-value="Explore"]'),
    ).toBeVisible();

    await saveGovernanceTab(page);

    // worca-namespace keys persist to settings.json (committed, propagated
    // to worktrees); only permissions/hooks land in settings.local.json.
    const basePath = join(ctx.dir, 'settings.json');
    expect(existsSync(basePath)).toBe(true);
    const saved = JSON.parse(readFileSync(basePath, 'utf8'));

    // Post-W-054: values land under dispatch.subagents.per_agent_allow;
    // the flat agent-keyed shape and intermediate subagent_dispatch are gone.
    expect(
      saved.worca?.governance?.dispatch?.subagents?.per_agent_allow?.planner,
    ).toEqual(['Explore']);
    expect(
      saved.worca?.governance?.dispatch?.subagents?.per_agent_allow?.implementer,
    ).toEqual(['Explore']);
    expect(saved.worca?.governance?.subagent_dispatch).toBeUndefined();
    expect(saved.worca?.governance?.dispatch?.planner).toBeUndefined();
    expect(saved.worca?.governance?.dispatch?.implementer).toBeUndefined();
  } finally {
    await ctx.close();
  }
});

// ─── Test 8: save round-trip preserves all dispatch values ───────────────────

test('save round-trip preserves all dispatch values', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Start with default settings
    await goToGovernance(page, ctx, {});

    // implementer starts with ["Explore"] by default; add a second tag
    const input = page.locator('#dispatch-subagents-implementer .dispatch-tag-input-field');
    await input.click();
    await input.fill('feature-dev:code-reviewer');
    await input.press('Enter');

    await expect(
      page.locator(
        '#dispatch-subagents-implementer sl-tag[data-value="feature-dev:code-reviewer"]',
      ),
    ).toBeVisible();

    await saveGovernanceTab(page);

    // Reload the page from scratch
    await page.goto(`${ctx.url}/#/project-settings`, GOTO_OPTS);
    await page.locator('sl-tab[panel="governance"]').click();

    // Both chips should still be present after reload
    await expect(
      page.locator('#dispatch-subagents-implementer sl-tag[data-value="Explore"]'),
    ).toBeVisible();
    await expect(
      page.locator(
        '#dispatch-subagents-implementer sl-tag[data-value="feature-dev:code-reviewer"]',
      ),
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});
