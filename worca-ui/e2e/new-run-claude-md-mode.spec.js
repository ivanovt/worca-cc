/**
 * Playwright e2e: new-run CLAUDE.md mode dropdown → /api/runs body.
 *
 * Verifies that selecting an explicit CLAUDE.md mode on the new-run form
 * includes claudeMdMode in the POST body sent to /api/runs.
 *
 * Run with: cd worca-ui && npx playwright test e2e/new-run-claude-md-mode.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

test('selecting Explicit: project sends claudeMdMode in POST body', async ({ page }) => {
  const ctx = await startServer();
  try {
    // Intercept the POST /api/runs request and capture its body, returning a
    // mocked success so the UI doesn't try to spawn a real pipeline process.
    let capturedBody = null;
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        capturedBody = body;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, pid: 99999 }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(`${ctx.url}/#new-run`, GOTO_OPTS);

    // Wait for the new-run form to render
    await expect(page.locator('.new-run-form')).toBeAttached({ timeout: 10000 });

    // Fill in the prompt (required for submit) via Shoelace sl-textarea internal input
    await page.evaluate(() => {
      const ta = document.querySelector('#new-run-prompt');
      if (ta) {
        // Shoelace sl-textarea proxies to an internal <textarea>
        const inner = ta.shadowRoot?.querySelector('textarea');
        if (inner) {
          inner.value = 'Test prompt for claude md mode';
          inner.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // Fallback: set value directly on the element
          ta.value = 'Test prompt for claude md mode';
        }
      }
    });

    // Select 'project' in the CLAUDE.md mode sl-select via programmatic value set
    await page.evaluate(() => {
      const select = document.querySelector('#new-run-claude-md-mode');
      if (select) {
        select.value = 'project';
        select.dispatchEvent(new CustomEvent('sl-change', { bubbles: true }));
      }
    });

    // Click the Launch Pipeline button
    const launchBtn = page.locator('button.action-btn.action-btn--primary').last();
    await expect(launchBtn).toBeAttached({ timeout: 5000 });
    await launchBtn.click();

    // Wait for the intercepted body to be captured
    await page.waitForFunction(() => window.__claudeMdModeTestDone !== undefined, undefined, {
      timeout: 5000,
    }).catch(() => {
      // The page doesn't set this flag; we'll check capturedBody directly below
    });

    // Give the request a moment to be processed
    await page.waitForTimeout(1000);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.claudeMdMode).toBe('project');
  } finally {
    await ctx.close();
  }
});

test('passthrough (null) omits claudeMdMode from POST body', async ({ page }) => {
  const ctx = await startServer();
  try {
    let capturedBody = null;
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, pid: 99999 }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(`${ctx.url}/#new-run`, GOTO_OPTS);
    await expect(page.locator('.new-run-form')).toBeAttached({ timeout: 10000 });

    // Fill in the prompt only — leave CLAUDE.md mode at passthrough (default)
    await page.evaluate(() => {
      const ta = document.querySelector('#new-run-prompt');
      if (ta) {
        const inner = ta.shadowRoot?.querySelector('textarea');
        if (inner) {
          inner.value = 'Test prompt passthrough';
          inner.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          ta.value = 'Test prompt passthrough';
        }
      }
    });

    const launchBtn = page.locator('button.action-btn.action-btn--primary').last();
    await expect(launchBtn).toBeAttached({ timeout: 5000 });
    await launchBtn.click();

    await page.waitForTimeout(1000);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.claudeMdMode).toBeUndefined();
  } finally {
    await ctx.close();
  }
});
