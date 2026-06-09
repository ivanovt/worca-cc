/**
 * Playwright e2e tests for pipelines set-as-default functionality.
 * Run with: cd worca-ui && npx playwright test e2e/pipelines-set-default.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
    const toast = page.locator('sl-alert[variant="success"]:visible');
    const dangerToast = page.locator('sl-alert[variant="danger"]:visible');
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

/**
 * Helper: navigate into the template editor for `templateName` and
 * return the header Set/Unset Default toggle locator. Callers should
 * `await btn.click()` to fire the PUT. The per-card Set Default
 * button was removed in the W-062 Phase 6 cleanup — Set Default
 * lives in the editor's page header as a toggle that alternates
 * between "Set Default" and "Unset Default".
 *
 * The helper enters the editor via the whole-card click (cards are
 * now `role="button"` and route to the editor on click). It does
 * NOT click the toggle itself; the caller does, after wiring up a
 * waitForResponse listener so the network assertion catches the PUT.
 */
async function findSetDefaultButton(page, templateName) {
  const card = page.locator(
    `.template-card:has(.run-card-title:has-text("${templateName}"))`,
  );
  await expect(card).toBeAttached();
  await card.click();
  await expect(page.locator('.pipelines-editor')).toBeAttached({
    timeout: 10000,
  });
  const toggle = page.locator(
    '.content-header button:has-text("Set Default"), .content-header button:has-text("Unset Default")',
  );
  await expect(toggle).toBeVisible({ timeout: 5000 });
  return toggle;
}

/**
 * Create a test template at the project scope.
 */
function createTestTemplate(dir, tid, name) {
  const templateDir = join(dir, '.claude', 'templates', tid);
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    join(templateDir, 'template.json'),
    JSON.stringify(
      {
        id: tid,
        name,
        description: `Test template for ${name}`,
        tags: ['test'],
        config: {
          stages: {
            planner: { enabled: true, agent: 'planner' },
            coordinator: { enabled: true, agent: 'coordinator' },
            implementer: { enabled: true, agent: 'implementer' },
            tester: { enabled: true, agent: 'tester' },
            reviewer: { enabled: false },
          },
        },
      },
      null,
      2,
    ),
  );
}

// ─── Test 1: Set as default button updates star badge ────────────────────────────

test('set as default button updates star badge on template card', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create two test templates
    createTestTemplate(ctx.dir, 'test-one', 'Test Template One');
    createTestTemplate(ctx.dir, 'test-two', 'Test Template Two');

    // Navigate to pipelines page
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    // Wait for templates to load - wait for the templates to be fetched and cards to appear
    const cards = page.locator('.template-card');
    await expect(cards.first()).toBeAttached({ timeout: 15000 });
    await expect(cards).toHaveCount(2, { timeout: 5000 });

    // Verify neither template has the default badge initially
    const defaultBadges = page.locator('.template-default-badge');
    await expect(defaultBadges).toHaveCount(0);

    // Register response listener BEFORE click to avoid race
    const apiResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/default-template') &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );

    // Find and click the editor header's Set Default toggle for
    // test-one (the helper navigates into the editor; the toggle is
    // in the page header).
    const setDefaultBtn = await findSetDefaultButton(page, 'Test Template One');
    await setDefaultBtn.click();

    // Wait for success toast
    const toastText = await getToastText(page);
    expect(toastText).toMatch(/default.*template/i);

    // Verify the API response was successful
    const response = await apiResponse;
    expect(response.ok()).toBe(true);

    // Navigate back to the list to verify the card badge updated.
    // The editor doesn't auto-navigate after the toggle — the user
    // would click Back; the test simulates that.
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    // Verify test-one now shows the default badge with star
    const testOneCard = page.locator(
      `.template-card:has(.run-card-title:has-text("Test Template One"))`,
    );
    const testOneBadge = testOneCard.locator('.template-default-badge');
    await expect(testOneBadge).toBeVisible();
    await expect(testOneBadge).toHaveText(/★ Default/i);

    // The per-card Set Default button is gone — Set Default lives in
    // the editor header now. The card's badge is the canonical
    // status indicator, and the toggle is on the editor page.
    expect(
      await testOneCard.locator('button:has-text("Set Default")').count(),
    ).toBe(0);

    // Verify settings.json was updated
    const settingsPath = join(ctx.dir, 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.worca).toBeDefined();
    // default_template is now the object form `{tier, id}` — see
    // server/templates-routes.js PUT /default-template. The bare
    // string form is still accepted on read for backward compat,
    // but writes always emit the structured shape.
    expect(settings.worca.default_template).toEqual({
      tier: 'project',
      id: 'test-one',
    });
  } finally {
    await ctx.close();
  }
});

// ─── Test 2: Setting default updates the new-run dropdown ────────────────────────

test('setting default template pre-selects it in new run dropdown', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create test templates
    createTestTemplate(ctx.dir, 'alpha-template', 'Alpha Template');
    createTestTemplate(ctx.dir, 'beta-template', 'Beta Template');
    createTestTemplate(ctx.dir, 'gamma-template', 'Gamma Template');

    // Navigate to pipelines and set beta as default
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);
    await expect(page.locator('.template-card').first()).toBeAttached({ timeout: 15000 });
    await expect(page.locator('.template-card')).toHaveCount(3, { timeout: 5000 });

    const apiResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/default-template') &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    const setDefaultBtn = await findSetDefaultButton(page, 'Beta Template');
    await setDefaultBtn.click();
    await apiResponse;

    // Navigate to new run page
    await page.goto(`${ctx.url}/#/new-run`, GOTO_OPTS);

    // Find the template dropdown via its sibling label
    const slSelect = page.locator('sl-select:has(sl-option[value="default"])');
    await expect(slSelect).toBeAttached({ timeout: 10000 });

    // Wait for async fetchTemplates to complete — template options render after
    // the /api/templates response arrives, so the sl-select initially only has
    // the static "default" option.
    const betaOption = slSelect.locator('sl-option.template-grouped[value="beta-template"]');
    await expect(betaOption).toBeAttached({ timeout: 10000 });

    // Get all options from the dropdown
    const options = await slSelect.locator('sl-option').all();
    expect(options.length).toBeGreaterThan(3);
    await expect(betaOption).toHaveText(/Beta Template.*★/);

    // Find the option for Alpha Template — NOT the default, should NOT have ★
    const alphaOption = slSelect.locator('sl-option.template-grouped[value="alpha-template"]');
    await expect(alphaOption).toBeAttached();
    await expect(alphaOption).not.toHaveText(/★/);

    // Verify the default option shows the template name
    const defaultOption = slSelect.locator('sl-option[value="default"]');
    await expect(defaultOption).toBeAttached();
    const defaultText = await defaultOption.textContent();
    expect(defaultText).toContain('Beta Template');
    expect(defaultText).toContain('★');
  } finally {
    await ctx.close();
  }
});

// ─── Test 3: Switching default from one template to another ─────────────────────

test('switching default template from one to another updates badges correctly', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    // Create test templates
    createTestTemplate(ctx.dir, 'first-template', 'First Template');
    createTestTemplate(ctx.dir, 'second-template', 'Second Template');

    // Navigate to pipelines and set first as default
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);
    await expect(page.locator('.template-card')).toHaveCount(2);

    let apiResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/default-template') &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    let btn = await findSetDefaultButton(page, 'First Template');
    await btn.click();
    await apiResponse;
    // Return to list to inspect badges (the editor stays put after
    // the toggle — user navigates back themselves).
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    // Verify first has badge
    const firstCard = page.locator(
      `.template-card:has(.run-card-title:has-text("First Template"))`,
    );
    await expect(firstCard.locator('.template-default-badge')).toBeVisible();

    // Now set second as default
    apiResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/default-template') &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    btn = await findSetDefaultButton(page, 'Second Template');
    await btn.click();
    await apiResponse;
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    // Verify second now has the badge
    const secondCard = page.locator(
      `.template-card:has(.run-card-title:has-text("Second Template"))`,
    );
    await expect(secondCard.locator('.template-default-badge')).toBeVisible();

    // Verify first no longer has the badge
    await expect(firstCard.locator('.template-default-badge')).not.toBeAttached();

    // The per-card Set Default button is gone for both — the
    // toggle is on the editor header now. The card badges are the
    // only canonical "is this the default?" indicator in the list.
    expect(
      await firstCard.locator('button:has-text("Set Default")').count(),
    ).toBe(0);
    expect(
      await secondCard.locator('button:has-text("Set Default")').count(),
    ).toBe(0);
  } finally {
    await ctx.close();
  }
});

// ─── Test 4: Built-in templates can be set as default ───────────────────────────

test('built-in templates show Set Default button and can be pinned as default', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create a built-in template (in worca directory)
    const builtinDir = join(ctx.dir, '.claude', 'worca', 'templates', 'builtin-test');
    mkdirSync(builtinDir, { recursive: true });
    writeFileSync(
      join(builtinDir, 'template.json'),
      JSON.stringify({
        id: 'builtin-test',
        name: 'Built-in Test Template',
        builtin: true,
        config: {
          stages: {
            planner: { enabled: true },
          },
        },
      }),
    );

    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);
    await expect(page.locator('.template-card').first()).toBeAttached({ timeout: 15000 });
    await expect(page.locator('.template-card')).toHaveCount(1, { timeout: 5000 });

    const builtinCard = page.locator(
      `.template-card:has(.run-card-title:has-text("Built-in Test Template"))`,
    );
    await expect(builtinCard).toBeAttached();

    // Builtin cards still have no per-card Set Default button (it
    // lives in the editor header now, for all tiers).
    await expect(builtinCard.locator('button:has-text("Set Default")')).not.toBeAttached();
    await expect(builtinCard.locator('button:has-text("Duplicate")')).toBeVisible();

    // Open the editor via card click and verify the Set Default
    // toggle IS present for built-ins (builtin templates are portable
    // — they ship with the package — so pinning one as project
    // default is meaningful).
    const apiResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/default-template') &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );

    await builtinCard.locator('.run-card-title').click();
    await expect(page.locator('.pipelines-editor')).toBeAttached({ timeout: 10000 });

    const toggle = page.locator(
      '.content-header button:has-text("Set Default"), .content-header button:has-text("Unset Default")',
    );
    await expect(toggle).toBeVisible({ timeout: 5000 });

    await toggle.click();
    const toastText = await getToastText(page);
    expect(toastText).toMatch(/default.*template/i);

    const response = await apiResponse;
    expect(response.ok()).toBe(true);

    // Verify settings.json was written with tier: 'builtin'
    const settingsPath = join(ctx.dir, 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.worca.default_template).toEqual({
      tier: 'builtin',
      id: 'builtin-test',
    });

    // Navigate back to the list and verify the ★ Default badge appears
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);
    const badge = page.locator(
      `.template-card:has(.run-card-title:has-text("Built-in Test Template")) .template-default-badge`,
    );
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/★ Default/i);
  } finally {
    await ctx.close();
  }
});

// ─── Test 5: Invalid template ID shows error toast ──────────────────────────────

test('invalid template ID shows error toast when setting default', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Create a valid template
    createTestTemplate(ctx.dir, 'valid-template', 'Valid Template');

    // Navigate to templates
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);
    await expect(page.locator('.template-card')).toHaveCount(1);

    // Intercept the PUT request and modify the body to send an invalid tid.
    // The server rejects tids containing special characters.
    await page.route(
      (url) => url.pathname.includes('/default-template'),
      async (route) => {
        const req = route.request();
        if (req.method() !== 'PUT') {
          route.continue();
          return;
        }
        const body = req.postData();
        if (body) {
          try {
            const parsed = JSON.parse(body);
            // PUT body is now `{tier, id}` (was `{tid}`). Override
            // `id` with an invalid value containing special chars
            // that fail the server's TEMPLATE_RE check.
            parsed.id = 'invalid-template-id-with-$$$-chars';
            route.continue({
              postData: JSON.stringify(parsed),
            });
            return;
          } catch {
            // If body parsing fails, just continue normally
          }
        }
        route.continue();
      },
    );

    // Click Set Default button
    const btn = await findSetDefaultButton(page, 'Valid Template');
    await btn.click();

    // Wait for error toast
    const dangerToast = page.locator('sl-alert[variant="danger"]:visible');
    await expect(dangerToast).toBeAttached({ timeout: 5000 });
    const toastText = await dangerToast.textContent();
    expect(toastText.toLowerCase()).toMatch(/invalid|error/);
  } finally {
    await ctx.close();
  }
});

// ─── Test 6: New run dropdown shows star for newly-set default ─────────────────

test('new run dropdown shows star annotation for newly-set default template', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    // Create a template that will become default
    createTestTemplate(ctx.dir, 'custom-default', 'Custom Default');

    // First navigate to new-run and note the dropdown state before setting default
    await page.goto(`${ctx.url}/#/new-run`, GOTO_OPTS);
    const slSelect = page.locator('sl-select:has(sl-option[value="default"])');
    await expect(slSelect).toBeAttached({ timeout: 10000 });

    // Verify the custom template option doesn't have a star yet
    const customOption = slSelect.locator('sl-option.template-grouped[value="custom-default"]');
    await expect(customOption).toBeAttached({ timeout: 5000 });
    const initialText = await customOption.textContent();
    expect(initialText).not.toContain('★');

    // Now set it as default
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);
    await expect(page.locator('.template-card')).toHaveCount(1);
    const apiResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/default-template') &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    const setDefaultBtn = await findSetDefaultButton(page, 'Custom Default');
    await setDefaultBtn.click();
    await apiResponse;

    // Navigate back to new-run and verify the star is now shown
    await page.goto(`${ctx.url}/#/new-run`, GOTO_OPTS);
    const newSelect = page.locator('sl-select:has(sl-option[value="default"])');
    await expect(newSelect).toBeAttached({ timeout: 10000 });

    const newCustomOption = newSelect.locator('sl-option.template-grouped[value="custom-default"]');
    await expect(newCustomOption).toBeAttached({ timeout: 5000 });
    const updatedText = await newCustomOption.textContent();
    expect(updatedText).toContain('★');
  } finally {
    await ctx.close();
  }
});
