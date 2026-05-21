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

/**
 * Sections collapse by default to keep the Governance tab compact. Tests that
 * interact with chips / inputs inside a section must expand it first.
 */
async function expandDispatchSection(page, section) {
  const details = page.locator(
    `sl-details.dispatch-section-details[data-section="${section}"]`,
  );
  await expect(details).toBeAttached();
  // Click the slotted summary so the user-driven path is exercised — that
  // way the sl-show + rerender cycle runs end-to-end. `el.show()` works
  // too but the click path also exercises the visible summary surface area.
  const isOpen = await details.evaluate((el) => el.open);
  if (!isOpen) {
    await details
      .locator('.dispatch-section-details-summary')
      .first()
      .click();
    await expect(details).toHaveJSProperty('open', true);
  }
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
    await expandDispatchSection(page, 'tools');

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
    await expandDispatchSection(page, 'tools');

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
    await expandDispatchSection(page, 'skills');

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
    await expandDispatchSection(page, 'skills');

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
    await expandDispatchSection(page, 'skills');

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
    await expandDispatchSection(page, 'subagents');

    // After PR B, subagents _defaults starts at ["*"]. Add a named entry
    // alongside the wildcard chip.
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
      page.locator('#dispatch-subagents-_defaults sl-tag[data-value="*"]'),
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('wildcard `*` chip renders with `any` label, wildcard class, and explanatory tooltip', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    // Default tools.per_agent_allow._defaults = ["*"] → wildcard chip should
    // render with the special styling and "any" label.
    await goToGovernance(page, ctx, {});
    await expandDispatchSection(page, 'tools');

    const wildcardChip = page.locator(
      '#dispatch-tools-_defaults sl-tag.dispatch-chip-wildcard[data-value="*"]',
    );
    await expect(wildcardChip).toBeVisible();
    await expect(wildcardChip).toContainText('any');
    // Follow-up #4: hovering the * chip explains what wildcard means.
    await expect(wildcardChip).toHaveAttribute(
      'title',
      /Any item not in the Always Disallowed/,
    );
  } finally {
    await ctx.close();
  }
});

test('skills section: default_denied suggestion item renders .warn class with opt-in hint (PR E)', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});
    await expandDispatchSection(page, 'skills');

    // `review` is in DISPATCH_DEFAULTS.skills.default_denied. When typed into
    // a per-agent suggestion popup, it should render with .warn class and
    // an "opt-in" hint label — not .denied (which is reserved for
    // always_disallowed entries).
    const input = page.locator(
      '#dispatch-skills-implementer .dispatch-tag-input-field',
    );
    await input.click();
    await input.fill('review');

    const suggestions = page.locator(
      '.settings-dispatch-row:has(#dispatch-skills-implementer) .dispatch-suggestions',
    );
    await expect(suggestions).toBeVisible();
    const warnItem = suggestions
      .locator('.item.warn')
      .filter({ hasText: 'review' })
      .first();
    await expect(warnItem).toBeVisible();
    await expect(warnItem).not.toHaveClass(/denied/);
    await expect(warnItem.locator('.item-hint')).toContainText('opt-in');

    // Clicking the warn item should add the chip (no block).
    await warnItem.click();
    await expect(
      page.locator(
        '#dispatch-skills-implementer sl-tag[data-value="review"]',
      ),
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ─── Collapsible sections ────────────────────────────────────────────────────

test('dispatch sections render collapsed by default', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});

    for (const section of ['tools', 'skills', 'subagents']) {
      const details = page.locator(
        `sl-details.dispatch-section-details[data-section="${section}"]`,
      );
      await expect(details).toBeAttached();
      // Shoelace tracks `open` as a JS property reflected to the attribute.
      await expect(details).toHaveJSProperty('open', false);
    }
  } finally {
    await ctx.close();
  }
});

test('dispatch section summary shows always-disallowed count and customization', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            tools: {
              per_agent_allow: { _defaults: ['*'], planner: ['Read'] },
            },
          },
        },
      },
    });

    const summary = page.locator(
      'sl-details.dispatch-section-details[data-section="tools"] .dispatch-section-details-summary',
    );
    await expect(summary).toContainText('always-disallowed');
    // The customized planner row should be counted in the summary.
    await expect(summary).toContainText('customized agent');
  } finally {
    await ctx.close();
  }
});

test('expanding a section reveals its per-agent rows', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});

    // The dispatch-tag-input container itself carries id="dispatch-skills-implementer".
    const skillsRow = page.locator('#dispatch-skills-implementer');
    // Collapsed by default — the row is not visible (display:none inside sl-details).
    await expect(skillsRow).not.toBeVisible();

    await expandDispatchSection(page, 'skills');
    await expect(skillsRow).toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ─── Auto-included Skill/Agent meta-chips (Tools section) ───────────────────

test('tools section: named per-agent list shows auto-included Skill + Agent chips', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            tools: {
              per_agent_allow: { _defaults: ['*'], planner: ['Read', 'Grep'] },
            },
          },
        },
      },
    });
    await expandDispatchSection(page, 'tools');

    const plannerRow = page.locator('#dispatch-tools-planner');
    await expect(
      plannerRow.locator('sl-tag[data-value="Read"]'),
    ).toBeVisible();
    // Auto-include locks Skill + Agent as visual-only pseudo-chips.
    const skillAuto = plannerRow.locator(
      'sl-tag[data-value="Skill"][data-auto-included="true"]',
    );
    const agentAuto = plannerRow.locator(
      'sl-tag[data-value="Agent"][data-auto-included="true"]',
    );
    await expect(skillAuto).toBeVisible();
    await expect(agentAuto).toBeVisible();
    await expect(skillAuto).toHaveAttribute('title', /Auto-included/);
    await expect(skillAuto).not.toHaveAttribute('removable', '');
  } finally {
    await ctx.close();
  }
});

test('tools section: wildcard row does not show auto-included meta-chips', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});
    await expandDispatchSection(page, 'tools');

    const defaultsRow = page.locator('#dispatch-tools-_defaults');
    // _defaults: ["*"] renders the wildcard chip — auto-include not needed.
    await expect(
      defaultsRow.locator('[data-auto-included="true"]'),
    ).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

// ─── Lockdown chip (["none"] sentinel) ──────────────────────────────────────

test('lockdown chip renders for an agent with the ["none"] sentinel', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            skills: {
              per_agent_allow: { _defaults: ['*'], coordinator: ['none'] },
            },
          },
        },
      },
    });
    await expandDispatchSection(page, 'skills');

    const lockdown = page.locator(
      '#dispatch-skills-coordinator sl-tag[data-lockdown="true"]',
    );
    await expect(lockdown).toBeVisible();
    await expect(lockdown).toContainText('Lockdown');
    await expect(lockdown).toHaveAttribute('title', /lockdown/i);
    // Lockdown placeholder is not removable.
    await expect(lockdown).not.toHaveAttribute('removable', '');
    // The raw "none" sentinel chip must NOT be surfaced separately.
    await expect(
      page.locator(
        '#dispatch-skills-coordinator sl-tag[data-value="none"][removable]',
      ),
    ).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test('empty per-agent list shows the Inherits-defaults chip, not Lockdown', async ({
  page,
}) => {
  // Empty [] falls through to _defaults at resolve time — must not be
  // labeled lockdown. See src/worca/hooks/tracking.py:resolve_per_agent_entry
  // and docs/governance.md:164-177.
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            skills: {
              per_agent_allow: { _defaults: ['*'], coordinator: [] },
            },
          },
        },
      },
    });
    await expandDispatchSection(page, 'skills');

    await expect(
      page.locator(
        '#dispatch-skills-coordinator sl-tag[data-lockdown="true"]',
      ),
    ).toHaveCount(0);

    const inherits = page.locator(
      '#dispatch-skills-coordinator sl-tag[data-inherits="true"]',
    );
    await expect(inherits).toBeVisible();
    await expect(inherits).toContainText('Inherits defaults');
  } finally {
    await ctx.close();
  }
});

test('lockdown chip is absent when an agent inherits defaults', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});
    await expandDispatchSection(page, 'skills');

    // No agent has been customized to ["none"], so no lockdown placeholder.
    await expect(
      page.locator('sl-tag[data-lockdown="true"]'),
    ).toHaveCount(0);
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
    await expandDispatchSection(page, 'subagents');

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

// ─── W-054 follow-up: strikethrough removal + per-section / per-tab reset ─────

test('always_disallowed chips are not struck through', async ({ page }) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {});
    await expandDispatchSection(page, 'tools');

    const lockedChip = page.locator(
      'sl-tag.dispatch-chip-locked[data-value="EnterPlanMode"]',
    );
    await expect(lockedChip).toBeVisible();
    const decoration = await lockedChip.evaluate(
      (el) => getComputedStyle(el).textDecorationLine,
    );
    expect(decoration).not.toBe('line-through');
  } finally {
    await ctx.close();
  }
});

test('per-section Reset stages defaults and persists on Save', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            subagents: {
              always_disallowed: ['general-purpose'],
              default_denied: [],
              per_agent_allow: {
                planner: ['Explore', 'Plan'],
                _defaults: ['*'],
              },
            },
          },
        },
      },
    });
    await expandDispatchSection(page, 'subagents');

    const planChip = page.locator(
      '#dispatch-subagents-planner sl-tag[data-value="Plan"]',
    );
    await expect(planChip).toBeVisible();

    // Per-section Reset (top-right of the expanded panel) stages defaults.
    await page
      .locator('.dispatch-section-reset[data-section="subagents"]')
      .click();
    await expect(planChip).not.toBeAttached();

    // Persist and round-trip.
    await saveGovernanceTab(page);
    await page.reload(GOTO_OPTS);
    await page.locator('sl-tab[panel="governance"]').click();
    await expandDispatchSection(page, 'subagents');
    await expect(
      page.locator('#dispatch-subagents-planner sl-tag[data-value="Plan"]'),
    ).not.toBeAttached();
  } finally {
    await ctx.close();
  }
});

test('bottom Reset stages tab defaults in memory and requires Save to persist', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await goToGovernance(page, ctx, {
      worca: {
        governance: {
          dispatch: {
            subagents: {
              always_disallowed: ['general-purpose'],
              default_denied: [],
              per_agent_allow: {
                planner: ['Explore', 'Plan'],
                _defaults: ['*'],
              },
            },
          },
        },
      },
    });
    await expandDispatchSection(page, 'subagents');
    const planChip = page.locator(
      '#dispatch-subagents-planner sl-tag[data-value="Plan"]',
    );
    await expect(planChip).toBeVisible();

    // Bottom Reset (whole tab) → confirm dialog → reset staged in memory.
    await page
      .locator(
        'sl-tab-panel[name="governance"] .settings-tab-actions sl-button[variant="default"]',
      )
      .click();
    // showConfirm() opens the dialog via getElementById().show(); when more than
    // one #global-confirm-dialog is mounted (app shell + settings view) only the
    // opened one carries the [open] attribute.
    const dialog = page.locator('#global-confirm-dialog[open]');
    await expect(dialog).toBeVisible();
    await dialog.locator('sl-button[variant="danger"]').click();

    // Staged in memory — custom chip gone without a Save.
    await expect(planChip).not.toBeAttached();

    // Not persisted: reload (no Save) restores the on-disk customization.
    await page.reload(GOTO_OPTS);
    await page.locator('sl-tab[panel="governance"]').click();
    await expandDispatchSection(page, 'subagents');
    await expect(
      page.locator('#dispatch-subagents-planner sl-tag[data-value="Plan"]'),
    ).toBeVisible();
  } finally {
    await ctx.close();
  }
});
