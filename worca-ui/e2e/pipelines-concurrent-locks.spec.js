/**
 * Playwright e2e tests for template concurrent lock guards.
 * Tests: delete/edit template with in-flight runs shows guard dialog
 * Run with: cd worca-ui && npx playwright test e2e/pipelines-concurrent-locks.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

function createProjectTemplate(dir, tid, name) {
  const templateDir = join(dir, '.claude', 'templates', tid);
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    join(templateDir, 'template.json'),
    JSON.stringify({
      id: tid,
      name,
      description: `Template: ${name}`,
      tags: ['test'],
      config: {
        stages: {
          planner: { enabled: true, agent: 'planner' },
          implement: { enabled: true, agent: 'implementer' },
          test: { enabled: true, agent: 'tester' },
        },
      },
    }),
  );
}

// ─── Test 1: Delete template with in-flight runs shows guard dialog ─────────

test('delete button shows guard dialog when runs are in-flight using the template', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    createProjectTemplate(ctx.dir, 'active-template', 'Active Template');

    // Seed two running runs that reference this template
    seedRun(ctx.worcaDir, 'run-001', {
      pipeline_status: 'running',
      pipeline_template: 'active-template',
      stage: 'implement',
      work_request: { title: 'First run' },
      stages: { implement: { status: 'in_progress' } },
    });
    seedRun(ctx.worcaDir, 'run-002', {
      pipeline_status: 'running',
      pipeline_template: 'active-template',
      stage: 'test',
      work_request: { title: 'Second run' },
      stages: { test: { status: 'in_progress' } },
    });

    // Seed a completed run (should NOT count as in-flight)
    seedRun(ctx.worcaDir, 'run-003', {
      pipeline_status: 'completed',
      pipeline_template: 'active-template',
      stage: 'pr',
      work_request: { title: 'Done run' },
      stages: { pr: { status: 'completed' } },
    });

    await page.goto(`${ctx.url}/#/pipelines`, GOTO_OPTS);
    await expect(page.locator('.template-card')).toBeAttached({ timeout: 10000 });

    // Click the Delete button on the template card
    const card = page.locator('.template-card:has(.run-card-title:has-text("Active Template"))');
    await expect(card).toBeAttached();
    const deleteBtn = card.locator('button:has-text("Delete")');
    await deleteBtn.click();

    // A guard dialog should appear warning about in-flight runs
    const dialog = page.locator('sl-dialog.template-guard-dialog');
    await expect(dialog).toBeAttached({ timeout: 5000 });

    // Dialog should mention the number of in-flight runs
    const dialogContent = await dialog.textContent();
    expect(dialogContent).toMatch(/2\s*(runs?|pipelines?)\s*(in.flight|running|active)/i);

    // Dialog should have a cancel button
    const cancelBtn = dialog.locator('sl-button[variant="default"], sl-button:has-text("Cancel")');
    await expect(cancelBtn).toBeAttached();

    // Dialog should have a confirm/proceed button
    const confirmBtn = dialog.locator(
      'sl-button[variant="danger"], sl-button:has-text("Delete Anyway")',
    );
    await expect(confirmBtn).toBeAttached();

    // Clicking cancel should dismiss the dialog without deleting
    await cancelBtn.click();
    await expect(dialog).not.toBeVisible();

    // Verify the template still exists (card is still present)
    await expect(card).toBeAttached();
  } finally {
    await ctx.close();
  }
});

// ─── Test 2: Delete proceeds after confirming guard dialog ──────────────────

test('confirming guard dialog on delete actually deletes the template', async ({ page }) => {
  const ctx = await startServer();
  try {
    createProjectTemplate(ctx.dir, 'deletable-tmpl', 'Deletable Template');

    // Seed one running run using this template
    seedRun(ctx.worcaDir, 'run-active', {
      pipeline_status: 'running',
      pipeline_template: 'deletable-tmpl',
      stage: 'plan',
      work_request: { title: 'Active run' },
      stages: { plan: { status: 'in_progress' } },
    });

    await page.goto(`${ctx.url}/#/pipelines`, GOTO_OPTS);
    await expect(page.locator('.template-card')).toBeAttached({ timeout: 10000 });

    const card = page.locator(
      '.template-card:has(.run-card-title:has-text("Deletable Template"))',
    );
    const deleteBtn = card.locator('button:has-text("Delete")');
    await deleteBtn.click();

    // Guard dialog appears
    const dialog = page.locator('sl-dialog.template-guard-dialog');
    await expect(dialog).toBeAttached({ timeout: 5000 });

    // Mentions 1 run in flight
    const dialogContent = await dialog.textContent();
    expect(dialogContent).toMatch(/1\s*(run|pipeline)\s*(in.flight|running|active)/i);

    // Click the confirm/danger button to proceed with delete
    const confirmBtn = dialog.locator(
      'sl-button[variant="danger"], sl-button:has-text("Delete Anyway")',
    );

    // Set up response interception before clicking
    const deleteResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/templates/deletable-tmpl') &&
        res.request().method() === 'DELETE',
      { timeout: 10000 },
    );
    await confirmBtn.click();
    await deleteResponse;

    // Template card should be gone after re-fetch
    await expect(card).not.toBeAttached({ timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── Test 3: Edit template with in-flight runs shows guard dialog ───────────

test('edit button shows guard dialog when runs are in-flight using the template', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    createProjectTemplate(ctx.dir, 'busy-template', 'Busy Template');

    // Seed three running runs using this template
    seedRun(ctx.worcaDir, 'run-a', {
      pipeline_status: 'running',
      pipeline_template: 'busy-template',
      stage: 'implement',
      work_request: { title: 'Run A' },
      stages: { implement: { status: 'in_progress' } },
    });
    seedRun(ctx.worcaDir, 'run-b', {
      pipeline_status: 'running',
      pipeline_template: 'busy-template',
      stage: 'plan',
      work_request: { title: 'Run B' },
      stages: { plan: { status: 'in_progress' } },
    });
    seedRun(ctx.worcaDir, 'run-c', {
      pipeline_status: 'running',
      pipeline_template: 'busy-template',
      stage: 'review',
      work_request: { title: 'Run C' },
      stages: { review: { status: 'in_progress' } },
    });

    await page.goto(`${ctx.url}/#/pipelines`, GOTO_OPTS);
    await expect(page.locator('.template-card')).toBeAttached({ timeout: 10000 });

    const card = page.locator('.template-card:has(.run-card-title:has-text("Busy Template"))');
    const editBtn = card.locator('button:has-text("Edit")');
    await editBtn.click();

    // Guard dialog should appear
    const dialog = page.locator('sl-dialog.template-guard-dialog');
    await expect(dialog).toBeAttached({ timeout: 5000 });

    // Should mention 3 runs
    const dialogContent = await dialog.textContent();
    expect(dialogContent).toMatch(/3\s*(runs?|pipelines?)\s*(in.flight|running|active)/i);

    // Should have a proceed/continue button (not danger for edit)
    const proceedBtn = dialog.locator(
      'sl-button[variant="warning"], sl-button[variant="primary"], sl-button:has-text("Edit Anyway")',
    );
    await expect(proceedBtn).toBeAttached();

    // Clicking proceed should navigate to editor
    await proceedBtn.click();
    await page.waitForURL(/\/pipelines\/busy-template\/edit/, { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── Test 4: No guard dialog when no runs are in-flight ─────────────────────

test('no guard dialog when template has no in-flight runs', async ({ page }) => {
  const ctx = await startServer();
  try {
    createProjectTemplate(ctx.dir, 'idle-template', 'Idle Template');

    // Seed only completed runs using this template
    seedRun(ctx.worcaDir, 'run-done-1', {
      pipeline_status: 'completed',
      pipeline_template: 'idle-template',
      stage: 'pr',
      work_request: { title: 'Done 1' },
      stages: { pr: { status: 'completed' } },
    });
    seedRun(ctx.worcaDir, 'run-done-2', {
      pipeline_status: 'failed',
      pipeline_template: 'idle-template',
      stage: 'test',
      work_request: { title: 'Failed' },
      stages: { test: { status: 'failed' } },
    });

    await page.goto(`${ctx.url}/#/pipelines`, GOTO_OPTS);
    await expect(page.locator('.template-card')).toBeAttached({ timeout: 10000 });

    const card = page.locator('.template-card:has(.run-card-title:has-text("Idle Template"))');
    const deleteBtn = card.locator('button:has-text("Delete")');

    // Set up response interception before clicking
    const deleteResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/templates/idle-template') &&
        res.request().method() === 'DELETE',
      { timeout: 10000 },
    );

    await deleteBtn.click();

    // No guard dialog should appear — delete goes through directly
    const dialog = page.locator('sl-dialog.template-guard-dialog');
    await expect(dialog).not.toBeAttached({ timeout: 1000 });

    // Delete should proceed
    const response = await deleteResponse;
    expect(response.ok()).toBe(true);

    // Template card should be removed
    await expect(card).not.toBeAttached({ timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── Test 5: Guard dialog does not count runs using different templates ──────

test('guard dialog only counts runs using the specific template', async ({ page }) => {
  const ctx = await startServer();
  try {
    createProjectTemplate(ctx.dir, 'target-tmpl', 'Target Template');
    createProjectTemplate(ctx.dir, 'other-tmpl', 'Other Template');

    // Seed a running run using target template
    seedRun(ctx.worcaDir, 'run-target', {
      pipeline_status: 'running',
      pipeline_template: 'target-tmpl',
      stage: 'implement',
      work_request: { title: 'Target run' },
      stages: { implement: { status: 'in_progress' } },
    });

    // Seed running runs using a DIFFERENT template (should not count)
    seedRun(ctx.worcaDir, 'run-other-1', {
      pipeline_status: 'running',
      pipeline_template: 'other-tmpl',
      stage: 'plan',
      work_request: { title: 'Other 1' },
      stages: { plan: { status: 'in_progress' } },
    });
    seedRun(ctx.worcaDir, 'run-other-2', {
      pipeline_status: 'running',
      pipeline_template: 'other-tmpl',
      stage: 'test',
      work_request: { title: 'Other 2' },
      stages: { test: { status: 'in_progress' } },
    });

    await page.goto(`${ctx.url}/#/pipelines`, GOTO_OPTS);
    await expect(page.locator('.template-card').first()).toBeAttached({ timeout: 10000 });

    const card = page.locator('.template-card:has(.run-card-title:has-text("Target Template"))');
    const deleteBtn = card.locator('button:has-text("Delete")');
    await deleteBtn.click();

    // Guard dialog should show 1 run (only the one using target-tmpl)
    const dialog = page.locator('sl-dialog.template-guard-dialog');
    await expect(dialog).toBeAttached({ timeout: 5000 });
    const dialogContent = await dialog.textContent();
    expect(dialogContent).toMatch(/1\s*(run|pipeline)\s*(in.flight|running|active)/i);
  } finally {
    await ctx.close();
  }
});
