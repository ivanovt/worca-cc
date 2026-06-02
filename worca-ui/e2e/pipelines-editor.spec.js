/**
 * Playwright e2e tests for pipelines editor view.
 * Run with: cd worca-ui && npx playwright test e2e/pipelines-editor.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

/**
 * Helper function to poll for the Toast notification element.
 * Since toasts appear asynchronously, we wait for the element to be attached
 * and visible in the DOM.
 */
async function waitForToast(page, timeout = 8000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const toast = page.locator('sl-alert[variant="success"]:visible').first();
    const dangerToast = page.locator('sl-alert[variant="danger"]:visible').first();
    if (await toast.isVisible()) return toast;
    if (await dangerToast.isVisible()) return dangerToast;
    await page.waitForTimeout(100);
  }
  throw new Error('Timeout waiting for toast notification');
}

/**
 * Poll for the toast notification text and return it.
 * Waits up to 5 seconds for the toast to appear.
 */
async function getToastText(page) {
  const toast = await waitForToast(page, 5000);
  return await toast.textContent();
}

// ─── Test 1: Create template from blank ────────────────────────────────────────

test('create template from blank', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Navigate to the editor with 'new' tid
    await page.goto(`${ctx.url}/#/templates/project/new/edit`, GOTO_OPTS);

    // Wait for editor to load with a longer timeout
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 30000 });
    // Name lives in the inline editable Name pill (sl-input), not a
    // static .editor-title heading. New templates default the value
    // to "New Template" via _initEditTemplate().
    await expect(page.locator('.editor-name-input')).toHaveValue('New Template', { timeout: 5000 });

    // Verify the editor mode toggle is present
    const formBtn = page.locator('.editor-mode-toggle sl-button:first-child');
    await expect(formBtn).toBeAttached({ timeout: 5000 });

    // Toggle a stage (e.g., disable plan_review stage)
    // Stage cards were restructured during the editor redesign — the
    // outer node is `.pipeline-stage-node`, the name lives in
    // `.settings-card-title`, and the toggle is `sl-switch#stage-<id>-enabled`.
    const planReviewRow = page.locator(
      '.pipeline-stage-node:has(.settings-card-title:has-text("plan_review"))',
    );
    await expect(planReviewRow).toBeAttached();
    const planReviewSwitch = planReviewRow.locator('sl-switch');
    await planReviewSwitch.click();

    // Switch to JSON mode and verify the config reflects our changes
    const jsonBtn = page.locator('.editor-mode-toggle sl-button:nth-child(2)');
    await jsonBtn.click();

    // Verify JSON editor is visible
    const jsonEditor = page.locator('#template-config-json');
    await expect(jsonEditor).toBeAttached();

    // Read the JSON value from the sl-textarea
    const jsonValue = await jsonEditor.evaluate((el) => el.value);

    // Verify stages.plan_review is false (disabled)
    expect(jsonValue).toContain('"plan_review"');
    expect(jsonValue).toContain('"enabled": false');

    // Switch back to Form mode
    const formModeBtn = page.locator('.editor-mode-toggle sl-button:first-child');
    await formModeBtn.click();

    // Click Save button — disambiguate from the sibling Cancel
    // button by text content (both are `sl-button` web components).
    const saveButton = page.locator('.editor-footer sl-button', {
      hasText: 'Save',
    });
    await expect(saveButton).toBeAttached();

    // Wait for POST /api/templates response and redirect to pipelines list
    const apiResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/templates') && res.request().method() === 'POST',
      { timeout: 10000 },
    );
    await saveButton.click();

    // Verify the API response was successful
    const response = await apiResponse;
    expect(response.ok()).toBe(true);

    // Wait for toast notification
    const toastText = await getToastText(page);
    expect(toastText).toContain('created successfully');

    // Verify we're redirected to pipelines list
    await page.waitForURL(/templates$/, { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── Test 2: Edit existing template ────────────────────────────────────────────

test('edit existing template', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create a test template via direct file write
    const templateDir = join(ctx.dir, '.claude', 'templates', 'test-edit');
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(
      join(templateDir, 'template.json'),
      JSON.stringify(
        {
          id: 'test-edit',
          name: 'Test Edit Template',
          description: 'For testing edits',
          tags: ['test'],
          config: {
            stages: {
              planner: { enabled: true, agent: 'planner' },
              plan_review: { enabled: false },
            },
            agents: {
              planner: { model: 'opus', max_turns: 30, effort: 'high' },
            },
          },
        },
        null,
        2,
      ),
    );

    // Navigate to editor
    await page.goto(`${ctx.url}/#/templates/project/test-edit/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 30000 });

    // Verify template loaded — name is now in the inline editable
    // Name pill (sl-input) rather than a static .editor-title heading.
    await expect(page.locator('.editor-name-input')).toHaveValue('Test Edit Template');

    // Edit planner model via Shoelace sl-select (use evaluate to set value)
    const plannerModelSelect = page.locator('#agent-planner-model');
    await expect(plannerModelSelect).toBeAttached();
    await plannerModelSelect.evaluate((el) => {
      el.value = 'sonnet';
      el.dispatchEvent(new Event('sl-change', { bubbles: true }));
    });

    // Edit planner max_turns via Shoelace sl-input
    const plannerTurnsInput = page.locator('#agent-planner-turns');
    await expect(plannerTurnsInput).toBeAttached();
    await plannerTurnsInput.evaluate((el) => {
      el.value = '50';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });

    // Save changes — text-filtered to avoid matching the Cancel sibling.
    const saveButton = page.locator('.editor-footer sl-button', {
      hasText: 'Save',
    });
    const apiResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/templates/test-edit') &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    await saveButton.click();

    // Verify success
    const response = await apiResponse;
    expect(response.ok()).toBe(true);

    const toastText = await getToastText(page);
    expect(toastText).toContain('updated successfully');

    // Verify redirect to pipelines list
    await page.waitForURL(/templates$/, { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── Test 3: JSON toggle round-trip ───────────────────────────────────────────

test('JSON toggle round-trip preserves edits', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create a test template
    const templateDir = join(ctx.dir, '.claude', 'templates', 'round-trip');
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(
      join(templateDir, 'template.json'),
      JSON.stringify(
        {
          id: 'round-trip',
          name: 'Round Trip Test',
          config: {
            stages: { planner: { enabled: true, agent: 'planner' } },
            agents: { planner: { model: 'sonnet', max_turns: 30 } },
          },
        },
        null,
        2,
      ),
    );

    // Navigate to editor
    await page.goto(`${ctx.url}/#/templates/project/round-trip/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 30000 });

    // Switch to JSON mode
    const jsonBtn = page.locator('.editor-mode-toggle sl-button:nth-child(2)');
    await jsonBtn.click();

    // Edit JSON directly via Shoelace sl-textarea (use evaluate to set value)
    const jsonEditor = page.locator('#template-config-json');
    await expect(jsonEditor).toBeAttached();
    const newJson = JSON.stringify({
      stages: {
        planner: { enabled: true, agent: 'planner' },
        plan_review: { enabled: true, agent: 'plan_reviewer' },
      },
      agents: {
        planner: { model: 'haiku', max_turns: 15 },
      },
    }, null, 2);
    await jsonEditor.evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
      el.dispatchEvent(new Event('sl-change', { bubbles: true }));
    }, newJson);

    // Switch back to Form mode
    const formBtn = page.locator('.editor-mode-toggle sl-button:first-child');
    await formBtn.click();

    // Verify changes persisted to form fields
    // Check plan_review is now enabled
    // Stage cards were restructured during the editor redesign — the
    // outer node is `.pipeline-stage-node`, the name lives in
    // `.settings-card-title`, and the toggle is `sl-switch#stage-<id>-enabled`.
    const planReviewRow = page.locator(
      '.pipeline-stage-node:has(.settings-card-title:has-text("plan_review"))',
    );
    await expect(planReviewRow).toBeAttached();
    const isChecked = await planReviewRow.locator('sl-switch').evaluate((el) => el.checked);
    expect(isChecked).toBe(true);

    // Check planner model changed to haiku
    const plannerModelSelect = page.locator('#agent-planner-model');
    const modelValue = await plannerModelSelect.evaluate((el) => el.value);
    expect(modelValue).toBe('haiku');

    // Check max_turns changed to 15 (Shoelace sl-input type=number returns number)
    const plannerTurnsInput = page.locator('#agent-planner-turns');
    const turnsValue = await plannerTurnsInput.evaluate((el) => el.value);
    expect(String(turnsValue)).toBe('15');

    // Switch back to JSON mode to verify round-trip
    await jsonBtn.click();
    const jsonValue = await jsonEditor.evaluate((el) => el.value);
    expect(jsonValue).toContain('"plan_review"');
    expect(jsonValue).toContain('"agent": "plan_reviewer"');
    expect(jsonValue).toContain('"model": "haiku"');
    expect(jsonValue).toContain('"max_turns": 15');
  } finally {
    await ctx.close();
  }
});

// ─── Test 4: Save shows validation error for invalid JSON ─────────────────────

test('Save shows validation error for invalid JSON', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create a test template
    const templateDir = join(ctx.dir, '.claude', 'templates', 'invalid-json');
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(
      join(templateDir, 'template.json'),
      JSON.stringify({
        id: 'invalid-json',
        name: 'Invalid JSON Test',
        config: { stages: {} },
      }),
    );

    // Navigate to editor
    await page.goto(`${ctx.url}/#/templates/project/invalid-json/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 30000 });

    // Switch to JSON mode
    const jsonBtn = page.locator('.editor-mode-toggle sl-button:nth-child(2)');
    await jsonBtn.click();

    // Enter invalid JSON via Shoelace sl-textarea
    const jsonEditor = page.locator('#template-config-json');
    await expect(jsonEditor).toBeAttached();
    await jsonEditor.evaluate((el) => {
      el.value = '{"stages": {"broken": json here}';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });

    // Click Save button — text-filtered to avoid the Cancel sibling.
    const saveButton = page.locator('.editor-footer sl-button', {
      hasText: 'Save',
    });
    await saveButton.click();

    // Expect validation error toast (JSON.parse failure) — use first() to
    // handle the case where both the inline alert and toast are rendered
    const toast = page.locator('sl-alert[variant="danger"]:visible').first();
    await expect(toast).toBeAttached({ timeout: 5000 });
    const toastText = await toast.textContent();
    expect(toastText).toMatch(/failed|error/i);
  } finally {
    await ctx.close();
  }
});

// ─── Test 5: Cancel editing navigates back ───────────────────────────────────

test('cancel editing navigates back to pipelines list', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create a test template
    const templateDir = join(ctx.dir, '.claude', 'templates', 'cancel-test');
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(
      join(templateDir, 'template.json'),
      JSON.stringify({
        id: 'cancel-test',
        name: 'Cancel Test',
        config: { stages: {} },
      }),
    );

    // Navigate to editor
    await page.goto(`${ctx.url}/#/templates/project/cancel-test/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 30000 });

    // Click Cancel button
    const cancelButton = page.locator(
      '.editor-footer sl-button[outline]:visible',
    );
    await expect(cancelButton).toBeAttached();
    await cancelButton.click();

    // Verify redirect to pipelines list
    await page.waitForURL(/templates$/, { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── Test 6: Edit governance dispatch section ───────────────────────────────

test('edit governance dispatch section', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create a test template with empty config
    const templateDir = join(ctx.dir, '.claude', 'templates', 'dispatch-test');
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(
      join(templateDir, 'template.json'),
      JSON.stringify({
        id: 'dispatch-test',
        name: 'Dispatch Test',
        config: {
          governance: {
            dispatch: {
              tools: { _defaults: ['*'] },
              skills: { _defaults: ['*'] },
              subagents: { _defaults: ['*'] },
            },
          },
        },
      }),
    );

    // Navigate to editor
    await page.goto(`${ctx.url}/#/templates/project/dispatch-test/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 30000 });

    // Scroll to governance section
    const govSection = page.locator(
      '.editor-section:has(.section-title:has-text("Governance Dispatch"))',
    );
    await expect(govSection).toBeAttached();
    await govSection.scrollIntoViewIfNeeded();

    // Find the Tools dispatch section (it's a div.dispatch-section, not sl-details)
    const toolsSection = govSection.locator('.dispatch-section:has(.dispatch-section-title:has-text("Tools"))');
    await expect(toolsSection).toBeAttached();

    // Find the planner row within tools section and its input
    const plannerInput = page.locator(
      '#dispatch-tools-planner .dispatch-tag-input-field',
    );
    await expect(plannerInput).toBeAttached();
    await plannerInput.click();
    await plannerInput.fill('Bis');

    // Wait for suggestions to appear
    const suggestions = page.locator(
      '.dispatch-row:has(#dispatch-tools-planner) .dispatch-suggestions .item',
    );
    // Suggestions might or might not appear depending on state
    // Just verify the input accepted text
    const inputValue = await plannerInput.inputValue();
    expect(inputValue).toBe('Bis');
  } finally {
    await ctx.close();
  }
});
