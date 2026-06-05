import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { seedRun, startServer } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccessEvent(runId, stage, iteration, beadId, fileAccess) {
  return JSON.stringify({
    event_type: 'pipeline.iteration.access',
    payload: {
      run_id: runId,
      stage,
      agent: stage === 'implement' ? 'implementer' : stage,
      iteration,
      bead_id: beadId,
      file_access: fileAccess,
    },
  });
}

function seedEventsJsonl(worcaDir, runId, events) {
  const runDir = join(worcaDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'events.jsonl'), `${events.join('\n')}\n`, 'utf8');
}

/**
 * Seed a completed run with one implement iteration that reads src/bar.py
 * (read-only, category=read) and reads+writes src/foo.py (category=write),
 * plus one broad Grep search (scope='.') so the KPI card turns amber.
 */
function seedAccessRun(worcaDir, runId) {
  seedRun(worcaDir, runId, {
    pipeline_status: 'completed',
    stage: 'implement',
    stages: {
      implement: {
        status: 'completed',
        iterations: [{ number: 1, status: 'completed' }],
      },
    },
  });
  seedEventsJsonl(worcaDir, runId, [
    makeAccessEvent(runId, 'implement', 1, 'bead-abc', {
      reads: { 'src/foo.py': 2, 'src/bar.py': 1 },
      writes: { 'src/foo.py': 1 },
      searches: [
        { tool: 'Grep', pattern: 'def run', scope: '.', result_count: 3, filter: null },
      ],
      totals: {
        distinct_read: 2,
        total_read: 3,
        distinct_write: 1,
        total_write: 1,
        grep: 1,
        glob: 0,
        zero_result: 0,
        root_scoped: 1,
      },
      capture: { hook_writes: 1, git_writes: 1, leakage_pct: 0.0, oracle: 'ok' },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('file access view — treetable', () => {
  test('Access button on run-detail navigates to access view with R/W badges', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-fa-treetable-nav';
      seedAccessRun(ctx.worcaDir, runId);

      // Start on run-detail
      await page.goto(`${ctx.url}/#/history?run=${runId}`, GOTO_OPTS);
      await expect(page.locator('.run-detail .stage-panels')).toBeVisible({ timeout: 8000 });

      // Click the Access button in the timing-bar actions
      const accessBtn = page.locator('.pipeline-timing-bar-actions button', { hasText: 'Access' });
      await expect(accessBtn).toBeVisible({ timeout: 5000 });
      await accessBtn.click();

      // URL should update to /access
      await expect(page).toHaveURL(new RegExp(`#/history/${runId}/access$`), { timeout: 5000 });

      // Treetable renders
      await expect(page.locator('.access-treetable')).toBeVisible({ timeout: 10000 });

      // read or write op pill present
      await expect(
        page.locator('.access-badge--read, .access-badge--write').first(),
      ).toBeVisible({ timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });

  test('direct URL to /access renders treetable', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-fa-treetable-direct';
      seedAccessRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/access`, GOTO_OPTS);
      await expect(page.locator('.access-treetable')).toBeVisible({ timeout: 10000 });

      // KPI strip with distinct-read count
      await expect(page.locator('.access-kpi-strip')).toBeVisible({ timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });
});

test.describe('file access view — category chip toggle', () => {
  test('toggling Reads chip hides read-only file rows', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-fa-chip-reads';
      seedAccessRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/access`, GOTO_OPTS);
      await expect(page.locator('.access-treetable')).toBeVisible({ timeout: 10000 });

      // src/bar.py is read-only (category=read); visible initially
      await expect(page.locator('.access-row--file[data-path="src/bar.py"]')).toBeVisible({
        timeout: 5000,
      });

      // Toggle Reads chip off
      await page.locator('.access-chip--reads').click();

      // Read-only row should disappear
      await expect(page.locator('.access-row--file[data-path="src/bar.py"]')).not.toBeVisible({
        timeout: 3000,
      });

      // src/foo.py (has writes → category=write) should still be visible
      await expect(page.locator('.access-row--file[data-path="src/foo.py"]')).toBeVisible({
        timeout: 3000,
      });
    } finally {
      await ctx.close();
    }
  });
});

test.describe('file access view — stage group collapse', () => {
  test('clicking stage group header collapses columns', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-fa-stage-collapse';
      seedAccessRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/access`, GOTO_OPTS);
      await expect(page.locator('.access-treetable')).toBeVisible({ timeout: 10000 });

      // At least one stage group header
      const stageHeader = page.locator('.access-stage-group-header').first();
      await expect(stageHeader).toBeVisible({ timeout: 5000 });

      // Click to collapse
      await stageHeader.click();

      // Header should gain the collapsed class (columns fold to a single Σ)
      await expect(
        page.locator('.access-stage-group-header--collapsed'),
      ).toBeVisible({ timeout: 3000 });
    } finally {
      await ctx.close();
    }
  });
});

test.describe('file access view — file drawer', () => {
  test('clicking file name opens drawer with history and Open in Timeline link', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-fa-drawer';
      seedAccessRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/access`, GOTO_OPTS);
      await expect(page.locator('.access-treetable')).toBeVisible({ timeout: 10000 });

      // Click the first file name button
      const fileBtn = page.locator('.access-file-name-btn').first();
      await expect(fileBtn).toBeVisible({ timeout: 5000 });
      await fileBtn.click();

      // File drawer opens
      await expect(page.locator('.access-file-drawer')).toBeVisible({ timeout: 3000 });

      // Drawer contains the history section label
      await expect(page.locator('.access-drawer-section-label')).toContainText(
        'File access history',
      );

      // At least one history entry
      await expect(page.locator('.access-file-history-item').first()).toBeVisible({
        timeout: 3000,
      });

      // Open in Timeline link is rendered (requires onOpenTimeline wiring)
      await expect(page.locator('.access-timeline-link').first()).toBeVisible({ timeout: 3000 });

      // Close drawer
      await page.locator('.access-drawer-close').first().click();
      await expect(page.locator('.access-file-drawer')).not.toBeVisible({ timeout: 2000 });
    } finally {
      await ctx.close();
    }
  });
});

test.describe('file access view — searches lane', () => {
  test('searches lane shows broad-scan amber KPI card when root-scoped search present', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-fa-broad-scan';
      seedAccessRun(ctx.worcaDir, runId);

      await page.goto(`${ctx.url}/#/history/${runId}/access`, GOTO_OPTS);
      await expect(page.locator('.access-kpi-strip')).toBeVisible({ timeout: 10000 });

      // Broad-scans KPI card is amber because root_scoped=1
      await expect(page.locator('.access-kpi-card--amber')).toBeVisible({ timeout: 5000 });

      // Searches lane renders the broad badge
      await expect(page.locator('.access-searches')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('.access-badge--broad')).toBeVisible({ timeout: 3000 });
    } finally {
      await ctx.close();
    }
  });
});

test.describe('file access view — empty state', () => {
  test('run with no access events shows empty-state copy', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-fa-empty';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stage: 'implement',
        stages: {
          implement: { status: 'completed' },
        },
      });
      // No events.jsonl seeded → server returns { enabled: false }

      await page.goto(`${ctx.url}/#/history/${runId}/access`, GOTO_OPTS);

      await expect(page.locator('.access-empty-state')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.access-empty-state')).toContainText('No file access data');
    } finally {
      await ctx.close();
    }
  });
});
