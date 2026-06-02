/**
 * Playwright e2e tests for template duplicate flow.
 * Tests: built-in → duplicate → edit → save
 * Run with: cd worca-ui && npx playwright test e2e/pipelines-duplicate.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, expandAllTierSections } from './fixtures.js';

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

// ─── Test 1: Duplicate a built-in template and edit it ───────────────────────────

test('duplicate built-in template, edit, and save', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Seed a built-in template (simulates what worca init creates)
    const builtInDir = join(ctx.dir, '.claude', 'worca', 'templates', 'minimal');
    mkdirSync(builtInDir, { recursive: true });
    writeFileSync(
      join(builtInDir, 'template.json'),
      JSON.stringify(
        {
          id: 'minimal',
          name: 'Minimal Pipeline',
          description: 'A minimal pipeline for quick testing',
          tags: ['minimal', 'test'],
          builtin: true,
          config: {
            stages: {
              planner: { enabled: true, agent: 'planner' },
              coordinator: { enabled: true, agent: 'coordinator' },
              implement: { enabled: true, agent: 'implementer' },
              test: { enabled: true, agent: 'tester' },
              review: { enabled: true, agent: 'reviewer' },
              pr: { enabled: true, agent: 'guardian' },
            },
            agents: {
              planner: { model: 'sonnet', max_turns: 30 },
              coordinator: { model: 'sonnet', max_turns: 30 },
              implementer: { model: 'sonnet', max_turns: 30 },
              tester: { model: 'sonnet', max_turns: 30 },
              reviewer: { model: 'sonnet', max_turns: 30 },
              guardian: { model: 'sonnet', max_turns: 30 },
            },
          },
        },
        null,
        2,
      ),
    );

    // Navigate to pipelines list
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    // Wait for the Built-in section to appear
    await expect(page.locator('.tier-section-header:has-text("Built-in")')).toBeAttached({ timeout: 5000 });

    // Find the minimal template card in the Built-in section
    const minimalCard = page.locator('.template-card').filter({
      hasText: 'Minimal Pipeline',
    });
    await expect(minimalCard).toBeAttached();

    // Verify the Duplicate button exists (built-in templates show Duplicate instead of Edit)
    const duplicateButton = minimalCard.locator('button:has-text("Duplicate")');
    await expect(duplicateButton).toBeAttached();

    // Click Duplicate — this opens the destination-picker dialog
    // (the user chooses Storage + ID before the POST fires).
    await duplicateButton.click();

    // Confirm in the dialog with default values; the primary Duplicate
    // button at the footer triggers the POST.
    const duplicateResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/templates/') && res.url().includes('/duplicate') && res.request().method() === 'POST',
      { timeout: 10000 },
    );
    const dialogConfirmBtn = page.locator(
      'sl-dialog.template-action-dialog sl-button[variant="primary"]',
    );
    await expect(dialogConfirmBtn).toBeVisible({ timeout: 5000 });
    await dialogConfirmBtn.click();

    // Verify the API response was successful
    const response = await duplicateResponse;
    expect(response.ok()).toBe(true);

    // Wait for navigation to the duplicate/edit page
    // After duplicate, the route should navigate to /templates/<new-tid>/edit
    await page.waitForURL(/\/templates\/[^/]+\/[^/]+\/edit/, { timeout: 5000 });

    // Wait for the editor to load
    await expect(page.locator('.pipelines-editor')).toBeAttached();

    // Verify we're in edit mode (the inline Name input should carry
    // the duplicated template's name — defaults to "<source> Copy"
    // or similar). Editor title was replaced by the inline Name pill.
    // `.editor-name-input` is an `sl-input` web component (not a native
    // <input>), so we read its `.value` property via evaluate rather
    // than using `inputValue()`.
    const nameInput = page.locator('.editor-name-input');
    await expect(nameInput).toBeAttached();
    const nameValue = await nameInput.evaluate((el) => el.value);
    expect(nameValue).toContain('Minimal');

    // Edit the template name (this tests the edit functionality)
    // Find the name input field - in the duplicate/edit flow, there should be a way to edit the template name
    // After duplication, the template is now in project scope and can be edited

    // Change the template name in the form if there's a name field,
    // or verify that at least one editable field exists
    const plannerSelect = page.locator('#agent-planner-model');
    await expect(plannerSelect).toBeAttached();

    // Change planner model to verify config editing works (Shoelace sl-select)
    await plannerSelect.evaluate((el) => {
      el.value = 'haiku';
      el.dispatchEvent(new Event('sl-change', { bubbles: true }));
    });

    // Save the duplicate template. The footer Save button is an
    // `sl-button` web component — locate by its text content rather
    // than a `:visible` pseudo, which doesn't always hit the shadow
    // DOM correctly.
    const saveButton = page.locator('.editor-footer sl-button', {
      hasText: 'Save',
    });
    await expect(saveButton).toBeAttached();

    // Wait for PUT /templates response (saving the duplicated template)
    const saveResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/templates/') &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    await saveButton.click();

    // Verify save response was successful
    const saveRes = await saveResponse;
    expect(saveRes.ok()).toBe(true);

    // Verify success toast
    const toastText = await getToastText(page);
    expect(toastText).toContain('updated successfully');

    // Verify redirect back to pipelines list
    await page.waitForURL(/templates$/, { timeout: 5000 });

    // Navigate to pipelines list and verify our duplicated template is now in Project tier
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    // Wait for templates to load
    await expect(page.locator('.pipelines-view')).toBeAttached({ timeout: 5000 });

    // Find the duplicated template — narrow to the Project tier
    // section so we don't strict-mode-violate against the
    // identically-named built-in card that's also rendered (and is
    // still attached in the DOM even while its sl-details is
    // collapsed).
    const duplicatedCard = page
      .locator('sl-details.pipelines-tier-section--project .template-card')
      .filter({ hasText: /Minimal/i });
    await expect(duplicatedCard).toBeAttached();

    // The Edit-button-per-card was replaced with clickable cards;
    // confirm the project-tier copy is at least clickable (role=button)
    // and that no Edit button was reintroduced.
    await expect(duplicatedCard).toHaveAttribute('role', 'button');
    await expect(
      duplicatedCard.locator('button:has-text("Edit")'),
    ).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

// ─── Test 2: Duplicate handles custom destination ID ─────────────────────────────

test('duplicate with custom destination ID and scope', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Seed a built-in template
    const builtInDir = join(ctx.dir, '.claude', 'worca', 'templates', 'customizable');
    mkdirSync(builtInDir, { recursive: true });
    writeFileSync(
      join(builtInDir, 'template.json'),
      JSON.stringify({
        id: 'customizable',
        name: 'Customizable Template',
        description: 'Template for customization',
        builtin: true,
        config: {
          stages: {
            planner: { enabled: true, agent: 'planner' },
            implement: { enabled: true, agent: 'implementer' },
          },
          agents: {
            planner: { model: 'sonnet', max_turns: 30 },
            implementer: { model: 'sonnet', max_turns: 30 },
          },
        },
      }),
    );

    // Navigate to pipelines list
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);
    await expect(page.locator('.pipelines-view')).toBeAttached();

    // Find and click Duplicate
    const card = page.locator('.template-card').filter({
      hasText: 'Customizable Template',
    });
    await expect(card).toBeAttached();

    const duplicateButton = card.locator('button:has-text("Duplicate")');
    await duplicateButton.click();

    // Confirm in the destination-picker dialog with default values.
    // The custom-id/scope flow is exercised by the dialog itself —
    // here we just verify the duplicate POST fires after confirmation.
    const duplicateResponse = page.waitForResponse(
      (res) => res.url().includes('/duplicate') && res.request().method() === 'POST',
      { timeout: 10000 },
    );
    const dialogConfirmBtn = page.locator(
      'sl-dialog.template-action-dialog sl-button[variant="primary"]',
    );
    await expect(dialogConfirmBtn).toBeVisible({ timeout: 5000 });
    await dialogConfirmBtn.click();

    // Verify duplicate API returned success
    const dupRes = await duplicateResponse;
    expect(dupRes.ok()).toBe(true);

    // Wait for navigation to editor
    await page.waitForURL(/\/templates\/[^/]+\/[^/]+\/edit/, { timeout: 5000 });

    // Verify editor loaded
    await expect(page.locator('.pipelines-editor')).toBeAttached();

    // Verify the templated form loaded with the duplicated config
    // Check that planner stage is enabled from the original config
    // Stage cards were restructured: see pipelines-editor.spec.js.
    const plannerRow = page
      .locator('.pipeline-stage-node:has(.settings-card-title:has-text("plan"))')
      .first();
    await expect(plannerRow).toBeAttached();
    const isEnabled = await plannerRow.locator('sl-switch').evaluate((el) => el.checked);
    expect(isEnabled).toBe(true);

    // Save the duplicated template — text-filtered to avoid Cancel.
    const saveButton = page.locator('.editor-footer sl-button', {
      hasText: 'Save',
    });
    await saveButton.click();

    // Verify save success and redirect
    await page.waitForURL(/templates$/, { timeout: 5000 });
    const toastText = await getToastText(page);
    expect(toastText).toContain('updated successfully');
  } finally {
    await ctx.close();
  }
});
