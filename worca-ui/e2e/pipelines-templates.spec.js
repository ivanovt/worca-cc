/**
 * Playwright e2e tests for the Pipeline Templates page (list + editor +
 * action dialogs). Covers the new design after W-062: tier sections,
 * create / duplicate / import / export / delete / rename, the editor
 * tab restructure (Agents / Pipeline / Governance), the description
 * section, the storage badge, the Set/Unset Default toggle in the
 * editor header, and the in-editor save flow that stays on page.
 *
 * Existing siblings (pipelines-editor.spec.js, pipelines-duplicate.spec.js,
 * pipelines-set-default.spec.js, pipelines-concurrent-locks.spec.js)
 * cover save-after-edit, duplicate-flow, set-default, and the
 * in-flight-runs guard dialog. This file fills the gaps: tier
 * rendering, create dialog grouping, import bundles, export bundle,
 * delete (no in-flight runs), description field, read-only built-in
 * editor, validation auto-clear, stage-toggle disables agent select,
 * effort/governance tab edits.
 *
 * Run with:
 *   cd worca-ui && npx playwright test e2e/pipelines-templates.spec.js --workers=1
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, expandAllTierSections } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

/**
 * Poll for a toast with the requested variant (success | danger) and
 * return its trimmed text content. The `worca:toast` event is fanned
 * out to a Shoelace alert in the corner — we wait for it to be
 * visible rather than just attached.
 */
async function waitForToastText(page, variant = 'success', timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const toast = page.locator(`sl-alert[variant="${variant}"]:visible`).first();
    if (await toast.isVisible().catch(() => false)) {
      return (await toast.textContent())?.trim() || '';
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout waiting for ${variant} toast`);
}

/**
 * Write a project-tier template directly to .claude/templates/<id>/.
 * Useful for setting up fixture state without going through the API.
 */
function seedProjectTemplate(dir, tid, overrides = {}) {
  const templateDir = join(dir, '.claude', 'templates', tid);
  mkdirSync(templateDir, { recursive: true });
  const tpl = {
    id: tid,
    name: overrides.name || tid,
    description: overrides.description ?? `Template ${tid}`,
    tags: overrides.tags || ['test'],
    config: overrides.config || {
      stages: {
        planner: { enabled: true, agent: 'planner' },
        coordinator: { enabled: true, agent: 'coordinator' },
        implement: { enabled: true, agent: 'implementer' },
      },
      agents: {
        planner: { model: 'sonnet', max_turns: 30 },
      },
    },
  };
  writeFileSync(
    join(templateDir, 'template.json'),
    JSON.stringify(tpl, null, 2),
  );
  return tpl;
}

/**
 * Write a builtin template under .claude/worca/templates/<id>/.
 * Mirrors what `worca init --upgrade` creates.
 */
function seedBuiltinTemplate(dir, tid, overrides = {}) {
  const templateDir = join(dir, '.claude', 'worca', 'templates', tid);
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    join(templateDir, 'template.json'),
    JSON.stringify(
      {
        id: tid,
        name: overrides.name || tid,
        description: overrides.description ?? `Builtin ${tid}`,
        builtin: true,
        config: overrides.config || {
          stages: { planner: { enabled: true, agent: 'planner' } },
        },
      },
      null,
      2,
    ),
  );
}

/**
 * Seed the built-in core prompt files the server resolves the Prompts
 * tab against (mirrors `.claude/worca/agents/core/` from `worca init`).
 */
function seedCorePrompts(dir, files) {
  const coreDir = join(dir, '.claude', 'worca', 'agents', 'core');
  mkdirSync(coreDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(coreDir, name), content, 'utf8');
  }
}

/**
 * Write a user-tier template under <WORCA_HOME>/templates/<id>/. The
 * server resolves the user-tier directory via `templatesDir()` in
 * `worca-ui/server/paths.js`, which honors `$WORCA_HOME` (else falls
 * back to `~/.worca`). Callers must point `WORCA_HOME` at `worcaDir`
 * before navigating so the route picks up the seeded file rather
 * than the host machine's real `~/.worca/templates`.
 */
function seedUserTemplate(worcaDir, tid, overrides = {}) {
  const templateDir = join(worcaDir, 'templates', tid);
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    join(templateDir, 'template.json'),
    JSON.stringify(
      {
        id: tid,
        name: overrides.name || tid,
        description: overrides.description ?? `User ${tid}`,
        config: overrides.config || {
          stages: { planner: { enabled: true, agent: 'planner' } },
        },
      },
      null,
      2,
    ),
  );
}

/**
 * Point `WORCA_HOME` at the test's isolated worcaDir for the duration
 * of `fn`, then restore the prior value. Required for any test that
 * exercises user-tier reads (the server resolves user-tier via
 * `templatesDir()` which honors `$WORCA_HOME`).
 */
async function withUserHome(worcaDir, fn) {
  const prev = process.env.WORCA_HOME;
  process.env.WORCA_HOME = worcaDir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.WORCA_HOME;
    else process.env.WORCA_HOME = prev;
  }
}

// ─── A. Tier sections rendering ────────────────────────────────────────────

test('list page renders all three tier sections with counts', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'proj-a', { name: 'Project A' });
    seedProjectTemplate(ctx.dir, 'proj-b', { name: 'Project B' });
    seedUserTemplate(ctx.worcaDir, 'user-a', { name: 'User A' });
    seedBuiltinTemplate(ctx.dir, 'builtin-a', { name: 'Builtin A' });

    await withUserHome(ctx.worcaDir, async () => {
      await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);

    // All three sections must render even if a tier is empty — the
    // page structure should be invariant.
    await expect(
      page.locator('sl-details.pipelines-tier-section--project'),
    ).toBeAttached();
    await expect(
      page.locator('sl-details.pipelines-tier-section--user'),
    ).toBeAttached();
    await expect(
      page.locator('sl-details.pipelines-tier-section--builtin'),
    ).toBeAttached();

    // Project opens by default; user / built-in start collapsed.
    await expect
      .poll(
        async () =>
          await page
            .locator('sl-details.pipelines-tier-section--project')
            .evaluate((d) => d.open),
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          await page
            .locator('sl-details.pipelines-tier-section--user')
            .evaluate((d) => d.open),
      )
      .toBe(false);

    // Count badges reflect the per-tier template count.
    const projCount = page
      .locator('sl-details.pipelines-tier-section--project .tier-section-count')
      .first();
    await expect(projCount).toHaveText('2');
    const userCount = page
      .locator('sl-details.pipelines-tier-section--user .tier-section-count')
      .first();
    await expect(userCount).toHaveText('1');
    const builtinCount = page
      .locator('sl-details.pipelines-tier-section--builtin .tier-section-count')
      .first();
    await expect(builtinCount).toHaveText('1');
    });
  } finally {
    await ctx.close();
  }
});

test('empty tier section renders the empty-state copy', async ({ page }) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'only-project', { name: 'Only Project' });

    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    const userEmpty = page.locator(
      'sl-details.pipelines-tier-section--user .tier-section-empty',
    );
    await expect(userEmpty).toBeVisible();
    await expect(userEmpty).toContainText(/No user templates yet/i);
  } finally {
    await ctx.close();
  }
});

// ─── B. New + Create dialog ────────────────────────────────────────────────

test('New button opens create dialog with grouped base dropdown', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'p1', { name: 'P One' });
    seedUserTemplate(ctx.worcaDir, 'u1', { name: 'U One' });
    seedBuiltinTemplate(ctx.dir, 'b1', { name: 'B One' });

    await withUserHome(ctx.worcaDir, async () => {
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);

    // Header New button is a plain <button.action-btn.action-btn--primary>
    // (not sl-button). Filter by text to avoid matching dashboard's
    // "Run Pipeline" if it ever gets rendered above.
    const newBtn = page.locator('.content-header button.action-btn--primary', {
      hasText: 'New',
    });
    await expect(newBtn).toBeVisible();
    await newBtn.click();

    const dialog = page.locator('sl-dialog.template-action-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // The base-template dropdown groups by tier with USER / PROJECT /
    // BUILT-IN small labels. Verify all three labels render — that is
    // the W-062 phase 5 grouping.
    const baseSelect = dialog.locator('sl-select#dlg-base');
    await expect(baseSelect).toBeAttached();
    await baseSelect.click();
    const labels = dialog.locator('small.template-group-label');
    await expect(labels.filter({ hasText: 'USER' })).toBeVisible();
    await expect(labels.filter({ hasText: 'PROJECT' })).toBeVisible();
    await expect(labels.filter({ hasText: 'BUILT-IN' })).toBeVisible();

    // The base options use `<tier>:<id>` values, with the human
    // name on the first line and `ID: <id>` in the suffix.
    const builtinOpt = dialog.locator(
      'sl-option.template-grouped[value="builtin:b1"]',
    );
    await expect(builtinOpt).toBeAttached();
    await expect(builtinOpt).toContainText('ID: b1');
    });
  } finally {
    await ctx.close();
  }
});

test('create dialog auto-slugs name → id until id is manually edited', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);

    await page
      .locator('.content-header button.action-btn--primary', { hasText: 'New' })
      .click();
    const dialog = page.locator('sl-dialog.template-action-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const nameInput = dialog.locator('sl-input#dlg-name');
    const idInput = dialog.locator('sl-input#dlg-id');

    await nameInput.evaluate((el) => {
      el.value = 'Feature (Fast)';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });

    // The id field should now mirror the slugged name.
    await expect
      .poll(async () => await idInput.evaluate((el) => el.value), {
        timeout: 3000,
      })
      .toBe('feature-fast');

    // Touching the id field stops auto-slug — further name edits
    // should NOT overwrite the id.
    await idInput.evaluate((el) => {
      el.value = 'my-custom-id';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });
    await nameInput.evaluate((el) => {
      el.value = 'Different Name';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    const idAfterEdit = await idInput.evaluate((el) => el.value);
    expect(idAfterEdit).toBe('my-custom-id');
  } finally {
    await ctx.close();
  }
});

test('create blank: POST /templates/:tier and lands on the editor', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);

    await page
      .locator('.content-header button.action-btn--primary', { hasText: 'New' })
      .click();
    const dialog = page.locator('sl-dialog.template-action-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    await dialog.locator('sl-input#dlg-name').evaluate((el) => {
      el.value = 'Brand New';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });
    // Auto-slug should put 'brand-new' in dlg-id; verify before submit.
    await expect
      .poll(
        async () =>
          await dialog.locator('sl-input#dlg-id').evaluate((el) => el.value),
        { timeout: 3000 },
      )
      .toBe('brand-new');

    const createPost = page.waitForResponse(
      (res) =>
        res.url().endsWith('/templates/project') &&
        res.request().method() === 'POST',
      { timeout: 10000 },
    );
    await dialog
      .locator('sl-button[slot="footer"][variant="primary"]')
      .click();
    const res = await createPost;
    expect(res.ok()).toBe(true);

    // The dialog confirms and routes to the editor on the new id.
    await page.waitForURL(/\/templates\/project\/brand-new\/edit/, {
      timeout: 5000,
    });
    await expect(page.locator('.pipelines-editor')).toBeAttached();
  } finally {
    await ctx.close();
  }
});

test('create dialog shows inline error when destination id collides', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'taken', { name: 'Taken' });

    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);

    await page
      .locator('.content-header button.action-btn--primary', { hasText: 'New' })
      .click();
    const dialog = page.locator('sl-dialog.template-action-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    await dialog.locator('sl-input#dlg-name').evaluate((el) => {
      el.value = 'Taken';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });

    // The id field auto-slugs to "taken" which already exists in the
    // project tier — the dialog should surface a validation message
    // and disable Confirm.
    await expect
      .poll(
        async () =>
          await dialog.locator('sl-input#dlg-id').evaluate((el) => el.value),
        { timeout: 3000 },
      )
      .toBe('taken');

    const inlineError = dialog.locator('sl-alert.dialog-error');
    await expect(inlineError).toBeVisible({ timeout: 3000 });
    await expect(inlineError).toContainText(/already exists/i);

    const confirmBtn = dialog.locator(
      'sl-button[slot="footer"][variant="primary"]',
    );
    await expect
      .poll(async () => await confirmBtn.evaluate((el) => el.disabled))
      .toBe(true);
  } finally {
    await ctx.close();
  }
});

// ─── C. Import dialog ──────────────────────────────────────────────────────

test('Import dialog renders bundle preview and POSTs /templates/import', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);

    // Header Import button.
    const importBtn = page.locator(
      '.content-header button.action-btn--secondary',
      { hasText: 'Import' },
    );
    await expect(importBtn).toBeVisible();
    await importBtn.click();

    const dialog = page.locator('sl-dialog.template-action-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Write a bundle file under the temp dir so we can supply it
    // to the file picker.
    const bundlePath = join(ctx.dir, 'bundle.json');
    // `worca templates import` validates bundles against the
    // worca_bundle_version=1 schema — see src/worca/templates/bundle.py.
    // Without this key the CLI rejects the bundle with "unsupported
    // bundle version None".
    const bundle = {
      worca_bundle_version: 1,
      generated_at: new Date().toISOString(),
      templates: [
        {
          id: 'imported-one',
          name: 'Imported One',
          description: 'Imported from a bundle',
          tags: [],
          config: { stages: { planner: { enabled: true, agent: 'planner' } } },
          params: {},
        },
      ],
    };
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    const fileInput = dialog.locator('input#dlg-import-file[type="file"]');
    await fileInput.setInputFiles(bundlePath);

    // The dialog should render a preview list with the bundle's id.
    const preview = dialog.locator('ul.dialog-bundle-list');
    await expect(preview).toBeVisible({ timeout: 3000 });
    await expect(preview).toContainText('imported-one');

    const importPost = page.waitForResponse(
      (res) =>
        res.url().endsWith('/templates/import') &&
        res.request().method() === 'POST',
      { timeout: 10000 },
    );
    await dialog
      .locator('sl-button[slot="footer"][variant="primary"]')
      .click();
    const res = await importPost;
    expect(res.ok()).toBe(true);

    // Dialog dismisses; the new template lands in the Project tier.
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    await expandAllTierSections(page);
    const newCard = page
      .locator('sl-details.pipelines-tier-section--project .template-card')
      .filter({ hasText: 'Imported One' });
    await expect(newCard).toBeAttached({ timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── D. Export bundle URL must include tier ────────────────────────────────

test('Export Card button GETs /templates/:tier/:id/bundle (tier in URL)', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'expo', { name: 'Exportable' });

    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    const card = page
      .locator('.template-card')
      .filter({ hasText: 'Exportable' });
    // Target the bundle-download button by its unique title — "Export (gist)"
    // also matches has-text("Export").
    const exportBtn = card.locator('button[title="Export template bundle"]');
    await expect(exportBtn).toBeVisible();

    // The Export button now opens a mode-picker dialog; the GET fires on
    // confirm and carries ?mode=<standalone|delta> (default standalone).
    await exportBtn.click();
    const dialog = page.locator('sl-dialog.template-action-dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const bundleRes = page.waitForResponse(
      (res) =>
        /\/templates\/project\/expo\/bundle\?mode=standalone$/.test(res.url()) &&
        res.request().method() === 'GET',
      { timeout: 10000 },
    );
    await dialog.locator('sl-button[variant="primary"]').click();
    const res = await bundleRes;
    expect(res.ok()).toBe(true);

    const toastText = await waitForToastText(page, 'success', 5000);
    expect(toastText).toMatch(/exported successfully/i);
  } finally {
    await ctx.close();
  }
});

// ─── E. Delete (no in-flight runs) ─────────────────────────────────────────

test('Delete card button (no in-flight runs) DELETEs and removes the card', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'goner', { name: 'Goner' });

    await page.goto(`${ctx.url}/#/templates`, GOTO_OPTS);
    await expandAllTierSections(page);

    const card = page.locator('.template-card').filter({ hasText: 'Goner' });
    await expect(card).toBeAttached();

    await card.locator('button:has-text("Delete")').click();

    // Global confirm dialog (not the in-flight guard) renders for the
    // no-runs path. It is opened via sl-dialog#global-confirm-dialog.
    const confirm = page.locator('#global-confirm-dialog');
    await expect(confirm).toBeVisible({ timeout: 3000 });
    const confirmBtn = confirm.locator('sl-button[variant="danger"]');
    await expect(confirmBtn).toBeVisible();

    const del = page.waitForResponse(
      (res) =>
        /\/templates\/project\/goner$/.test(res.url()) &&
        res.request().method() === 'DELETE',
      { timeout: 10000 },
    );
    await confirmBtn.click();
    const res = await del;
    expect(res.ok()).toBe(true);

    // The card disappears once the templates list refreshes.
    await expect(card).toHaveCount(0, { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// ─── F. Editor description field ───────────────────────────────────────────

test('editor description textarea persists across save+reload', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'has-desc', {
      name: 'Has Desc',
      description: 'Original desc',
    });

    await page.goto(`${ctx.url}/#/templates/project/has-desc/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });

    const descInput = page.locator('sl-textarea#editor-description-input');
    await expect(descInput).toBeAttached();
    await expect
      .poll(async () => await descInput.evaluate((el) => el.value))
      .toBe('Original desc');

    await descInput.evaluate((el) => {
      el.value = 'A new, longer description';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });

    const saveResponse = page.waitForResponse(
      (res) =>
        /\/templates\/project\/has-desc$/.test(res.url()) &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    await page
      .locator('.editor-footer sl-button', { hasText: 'Save' })
      .click();
    const res = await saveResponse;
    expect(res.ok()).toBe(true);

    // Save stays on the editor page — the URL must NOT change.
    await waitForToastText(page, 'success', 5000);
    expect(page.url()).toMatch(/\/templates\/project\/has-desc\/edit/);

    // Reload and verify the description survived.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });
    await expect
      .poll(
        async () =>
          await page
            .locator('sl-textarea#editor-description-input')
            .evaluate((el) => el.value),
        { timeout: 5000 },
      )
      .toBe('A new, longer description');
  } finally {
    await ctx.close();
  }
});

// ─── G. Read-only built-in editor ─────────────────────────────────────────

test('built-in template editor is read-only: no Save, Close instead of Cancel', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedBuiltinTemplate(ctx.dir, 'frozen', { name: 'Frozen Builtin' });

    await page.goto(`${ctx.url}/#/templates/builtin/frozen/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });

    // Read-only badge in the page header.
    await expect(
      page.locator('.content-header sl-badge[variant="warning"]'),
    ).toContainText(/read-only/i);

    // No Save button — only Close.
    await expect(
      page.locator('.editor-footer sl-button', { hasText: 'Save' }),
    ).toHaveCount(0);
    await expect(
      page.locator('.editor-footer sl-button', { hasText: 'Close' }),
    ).toBeAttached();

    // Description textarea is disabled.
    await expect
      .poll(
        async () =>
          await page
            .locator('sl-textarea#editor-description-input')
            .evaluate((el) => el.disabled),
      )
      .toBe(true);
  } finally {
    await ctx.close();
  }
});

// The read-only editor bleaches + pointer-locks every tab panel, but the
// Prompts tab is itself a read-only viewer — it must stay scrollable and
// full-contrast even for a built-in template. Regression guard for the
// CSS exemption in styles.css (`sl-tab-panel[name="prompts"]`).
test('built-in Prompts tab stays scrollable and full-contrast (not bleached)', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedBuiltinTemplate(ctx.dir, 'frozen', { name: 'Frozen Builtin' });
    // A planner body long enough to overflow the inner 480px scroll pane.
    const longBody = Array.from(
      { length: 200 },
      (_, i) => `Line ${i}: built-in planner instruction text.`,
    ).join('\n\n');
    seedCorePrompts(ctx.dir, {
      'planner.md': `# Planner\n\n${longBody}`,
    });

    await page.goto(`${ctx.url}/#/templates/builtin/frozen/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });

    // The editor is in read-only mode (the wrapper carries the class that
    // drives the bleach/pointer-lock the exemption must override).
    await expect(page.locator('.editor-content--readonly')).toBeAttached();

    const promptsTab = page.locator(
      '.editor-tab-group sl-tab[panel="prompts"]',
    );
    await expect(promptsTab).toBeVisible({ timeout: 8000 });
    await promptsTab.click();

    const panel = page.locator('sl-tab-panel[name="prompts"]');
    await expect(panel).toBeAttached({ timeout: 5000 });

    // Outer prompts panel: not bleached, not pointer-locked.
    await expect
      .poll(async () =>
        panel.evaluate((el) => getComputedStyle(el).pointerEvents),
      )
      .not.toBe('none');
    await expect
      .poll(async () => panel.evaluate((el) => getComputedStyle(el).opacity))
      .toBe('1');

    // Expand the stage so the nested per-stage sub-tab panel renders.
    const stageCard = panel.locator('sl-details.overlay-stage-card').first();
    await expect(stageCard).toBeAttached({ timeout: 5000 });
    await stageCard.evaluate((el) => {
      el.open = true;
    });

    // Nested sub-tab panel (the spot that re-matched pointer-events:none
    // before the exemption) must also be interactive + full-contrast.
    const nestedPanel = panel.locator('sl-tab-panel').first();
    await expect(nestedPanel).toBeAttached({ timeout: 5000 });
    await expect
      .poll(async () =>
        nestedPanel.evaluate((el) => getComputedStyle(el).pointerEvents),
      )
      .not.toBe('none');
    await expect
      .poll(async () =>
        nestedPanel.evaluate((el) => getComputedStyle(el).opacity),
      )
      .toBe('1');

    // The inner 480px scroll pane overflows and can actually be scrolled.
    const pane = panel.locator('.prompt-file-content.markdown-body').first();
    await expect(pane).toBeAttached({ timeout: 5000 });
    await expect
      .poll(async () =>
        pane.evaluate((el) => el.scrollHeight > el.clientHeight),
      )
      .toBe(true);
    await pane.evaluate((el) => {
      el.scrollTop = 120;
    });
    await expect
      .poll(async () => pane.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

// ─── H. Pipeline tab: stage toggle disables its agent select ──────────────

test('Pipeline tab: disabling a stage disables its agent select', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'stage-toggle', {
      name: 'Stage Toggle',
      config: {
        stages: {
          planner: { enabled: true, agent: 'planner' },
          plan_review: { enabled: true, agent: 'plan_reviewer' },
        },
      },
    });

    await page.goto(
      `${ctx.url}/#/templates/project/stage-toggle/edit`,
      GOTO_OPTS,
    );
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });

    await page
      .locator('.editor-tab-group sl-tab[panel="pipeline"]')
      .click();

    // Agent select is enabled while the stage switch is on.
    const reviewSelect = page.locator('sl-select#stage-plan_review-agent');
    await expect(reviewSelect).toBeAttached();
    await expect
      .poll(async () => await reviewSelect.evaluate((el) => el.disabled))
      .toBe(false);

    // Flip the stage off and verify the agent select disables.
    const switchEl = page.locator('sl-switch#stage-plan_review-enabled');
    await switchEl.click();
    await expect
      .poll(async () => await reviewSelect.evaluate((el) => el.disabled), {
        timeout: 3000,
      })
      .toBe(true);
  } finally {
    await ctx.close();
  }
});

// ─── I. Agents tab: effort auto_mode dropdown ─────────────────────────────

test('Agents tab: effort auto_mode dropdown is editable and persists', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'effort-mode', { name: 'Effort Mode' });

    await page.goto(
      `${ctx.url}/#/templates/project/effort-mode/edit`,
      GOTO_OPTS,
    );
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });

    const modeSelect = page.locator('sl-select#effort-auto-mode');
    await expect(modeSelect).toBeAttached();

    await modeSelect.evaluate((el) => {
      el.value = 'disabled';
      el.dispatchEvent(new Event('sl-change', { bubbles: true }));
    });

    const saveRes = page.waitForResponse(
      (res) =>
        /\/templates\/project\/effort-mode$/.test(res.url()) &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    await page
      .locator('.editor-footer sl-button', { hasText: 'Save' })
      .click();
    const res = await saveRes;
    expect(res.ok()).toBe(true);

    // Inspect the saved config server-side via the read endpoint —
    // this verifies the formBuffer → config mapping actually emits
    // worca.effort.auto_mode = 'disabled'.
    const readBack = await page.evaluate(async () => {
      const r = await fetch('/api/templates/project/effort-mode');
      return await r.json();
    });
    expect(readBack.ok).toBe(true);
    expect(readBack.template.config.effort?.auto_mode).toBe('disabled');
  } finally {
    await ctx.close();
  }
});

// ─── J. Governance tab: test_gate_strikes is editable + saved ────────────

test('Governance tab: test_gate_strikes input is editable and persists', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'gov-strike', { name: 'Strike Gate' });

    await page.goto(
      `${ctx.url}/#/templates/project/gov-strike/edit`,
      GOTO_OPTS,
    );
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });

    await page
      .locator('.editor-tab-group sl-tab[panel="governance"]')
      .click();

    const strikeInput = page.locator('sl-input#test-gate-strikes');
    await expect(strikeInput).toBeAttached();
    await strikeInput.evaluate((el) => {
      el.value = '5';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
      el.dispatchEvent(new Event('sl-change', { bubbles: true }));
    });

    const saveRes = page.waitForResponse(
      (res) =>
        /\/templates\/project\/gov-strike$/.test(res.url()) &&
        res.request().method() === 'PUT',
      { timeout: 10000 },
    );
    await page
      .locator('.editor-footer sl-button', { hasText: 'Save' })
      .click();
    const res = await saveRes;
    expect(res.ok()).toBe(true);

    const readBack = await page.evaluate(async () => {
      const r = await fetch('/api/templates/project/gov-strike');
      return await r.json();
    });
    expect(readBack.ok).toBe(true);
    expect(readBack.template.config.governance?.test_gate_strikes).toBe(5);
  } finally {
    await ctx.close();
  }
});

// ─── K. Validation: live-clears as user fixes the bad field ──────────────

test('editor validation alert clears live when the bad ID is fixed', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'dup-source', { name: 'Dup Source' });
    seedProjectTemplate(ctx.dir, 'rename-me', { name: 'Rename Me' });

    await page.goto(
      `${ctx.url}/#/templates/project/rename-me/edit`,
      GOTO_OPTS,
    );
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });

    // Edit the ID to collide with another project-tier template.
    const idInput = page.locator('sl-input.editor-id-input');
    await idInput.evaluate((el) => {
      el.value = 'dup-source';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });

    // The collision badge appears and Save is disabled.
    await expect(
      page.locator('sl-badge.editor-id-collision-badge'),
    ).toBeVisible({ timeout: 3000 });
    const saveBtn = page.locator('.editor-footer sl-button', {
      hasText: 'Save',
    });
    await expect
      .poll(async () => await saveBtn.evaluate((el) => el.disabled))
      .toBe(true);

    // Fix the ID — the collision indicator should disappear and
    // Save re-enable.
    await idInput.evaluate((el) => {
      el.value = 'rename-me-v2';
      el.dispatchEvent(new Event('sl-input', { bubbles: true }));
    });
    await expect(
      page.locator('sl-badge.editor-id-collision-badge'),
    ).toHaveCount(0, { timeout: 3000 });
    await expect
      .poll(async () => await saveBtn.evaluate((el) => el.disabled))
      .toBe(false);
  } finally {
    await ctx.close();
  }
});

// ─── L. Storage badge is blue (primary) pill ─────────────────────────────

test('editor storage badge is the blue primary pill with the tier name', async ({
  page,
}) => {
  const ctx = await startServer();
  try {
    seedProjectTemplate(ctx.dir, 'badge', { name: 'Badge' });

    await page.goto(`${ctx.url}/#/templates/project/badge/edit`, GOTO_OPTS);
    await expect(page.locator('.pipelines-editor')).toBeAttached({
      timeout: 10000,
    });

    const badge = page.locator('sl-badge.editor-storage-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('variant', 'primary');
    await expect(badge).toContainText(/Storage:\s*Project/i);
    // The pill flag must be set so the badge keeps its rounded shape.
    await expect
      .poll(async () => await badge.evaluate((el) => el.hasAttribute('pill')))
      .toBe(true);
  } finally {
    await ctx.close();
  }
});
