import { test, expect } from '@playwright/test';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

/**
 * Navigate to a run's detail page, wait for stage panels to render, and
 * expand the implement stage so its dispatch row becomes visible. Stage
 * panels auto-collapse on completed runs; the dispatch row lives inside
 * the implement panel.
 */
async function openRunDetail(page, baseUrl, runId) {
  await page.goto(`${baseUrl}/#/history?run=${runId}`, GOTO_OPTS);
  await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
    timeout: 8000,
  });
  // Open the implement stage panel. The header is rendered inside the
  // sl-details element with class "stage-panel"; clicking it toggles open.
  const implementPanel = page
    .locator('.stage-panel', {
      has: page.locator('.stage-panel-label', { hasText: 'IMPLEMENT' }),
    })
    .first();
  await implementPanel.locator('.stage-panel-header').click();
  // Wait for the panel body to actually flip to open.
  await expect(implementPanel).toHaveAttribute('open', '', { timeout: 5000 });
}

/**
 * Build a completed-iteration stages map with an embedded dispatch_events
 * list. Bypasses the server-side aggregator (no events.jsonl) so the row
 * renders exactly the events we hand it.
 */
function stagesWithDispatch(events) {
  return {
    plan: { status: 'completed' },
    implement: {
      status: 'completed',
      iterations: [
        {
          number: 1,
          status: 'completed',
          started_at: '2026-01-01T10:00:00.000Z',
          completed_at: '2026-01-01T10:05:00.000Z',
          dispatch_events: events,
        },
      ],
    },
  };
}

test.describe('run-detail dispatch row — badge + layout', () => {
  test('renders both Skills and Subagents sections on a single row', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-dispatch-single-row';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: stagesWithDispatch([
          {
            type: 'pipeline.hook.dispatch_allowed',
            section: 'skills',
            candidate: 'ascii-banner',
            via: 'wildcard',
            count: 1,
          },
          {
            type: 'pipeline.hook.dispatch_allowed',
            section: 'subagents',
            candidate: 'Explore',
            via: 'explicit',
            count: 1,
          },
        ]),
      });
      await openRunDetail(page, ctx.url, runId);

      // Single combined row, both section groups present.
      const row = page.locator('.dispatch-events-row').first();
      await expect(row).toBeVisible({ timeout: 8000 });
      await expect(
        row.locator('[data-dispatch-section="skills"]'),
      ).toBeVisible();
      await expect(
        row.locator('[data-dispatch-section="subagents"]'),
      ).toBeVisible();
      // Both labels appear inside the row.
      await expect(row).toContainText('Skills:');
      await expect(row).toContainText('Subagents:');
      // (none) placeholder does NOT show when both sides have events.
      await expect(row.locator('.dispatch-events-empty')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('shows (none) placeholder for sections with no dispatch events', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-dispatch-skills-only';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: stagesWithDispatch([
          {
            type: 'pipeline.hook.dispatch_blocked',
            section: 'skills',
            candidate: 'ascii-banner',
            reason: 'lockdown',
            count: 1,
          },
        ]),
      });
      await openRunDetail(page, ctx.url, runId);

      const row = page.locator('.dispatch-events-row').first();
      await expect(row).toBeVisible({ timeout: 8000 });
      // Subagents section is empty — keeps its label and shows "(none)".
      const subagentsSection = row.locator(
        '[data-dispatch-section="subagents"]',
      );
      await expect(subagentsSection).toBeVisible();
      await expect(subagentsSection).toContainText('Subagents:');
      await expect(subagentsSection).toContainText('(none)');
      // Skills section has the blocked badge — no placeholder there.
      const skillsSection = row.locator('[data-dispatch-section="skills"]');
      await expect(skillsSection.locator('.dispatch-events-empty')).toHaveCount(
        0,
      );
    } finally {
      await ctx.close();
    }
  });

  test('completed iteration with zero dispatch keeps the row with (none) in both', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-dispatch-completely-empty';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: {
          plan: { status: 'completed' },
          implement: {
            status: 'completed',
            iterations: [
              {
                number: 1,
                status: 'completed',
                started_at: '2026-01-01T10:00:00.000Z',
                completed_at: '2026-01-01T10:05:00.000Z',
              },
            ],
          },
        },
      });
      await openRunDetail(page, ctx.url, runId);

      const row = page.locator('.dispatch-events-row').first();
      await expect(row).toBeVisible({ timeout: 8000 });
      // Both labels still present; both bodies show the (none) placeholder.
      await expect(row).toContainText('Skills:');
      await expect(row).toContainText('Subagents:');
      await expect(row.locator('.dispatch-events-empty')).toHaveCount(2);
      // Old empty-state message is gone.
      await expect(row).not.toContainText(
        'No subagent or skill activity in this iteration',
      );
    } finally {
      await ctx.close();
    }
  });

  test('allowed dispatch renders a green badge with check icon', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-dispatch-allowed-styling';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: stagesWithDispatch([
          {
            type: 'pipeline.hook.dispatch_allowed',
            section: 'skills',
            candidate: 'ascii-banner',
            via: 'wildcard',
            count: 1,
          },
        ]),
      });
      await openRunDetail(page, ctx.url, runId);

      const badge = page
        .locator('.dispatch-badge', { hasText: 'ascii-banner' })
        .first();
      await expect(badge).toBeVisible({ timeout: 8000 });
      // Shoelace renders variant as an attribute we can read.
      await expect(badge).toHaveAttribute('variant', 'success');
      // Icon span sits inside the badge body.
      await expect(badge.locator('.dispatch-badge-icon')).toBeVisible();
      // Tooltip is rendered as an sl-tooltip wrapping the badge — read its
      // `content` attribute.
      const tooltip = page.locator('sl-tooltip', { has: badge }).first();
      await expect(tooltip).toHaveAttribute(
        'content',
        /Allowed by project dispatch policy/,
      );
    } finally {
      await ctx.close();
    }
  });

  test('blocked dispatch renders a red badge with X icon and lockdown tooltip', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-dispatch-blocked-styling';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: stagesWithDispatch([
          {
            type: 'pipeline.hook.dispatch_blocked',
            section: 'skills',
            candidate: 'ascii-banner',
            reason: 'lockdown',
            count: 1,
          },
        ]),
      });
      await openRunDetail(page, ctx.url, runId);

      const badge = page
        .locator('.dispatch-badge', { hasText: 'ascii-banner' })
        .first();
      await expect(badge).toBeVisible({ timeout: 8000 });
      await expect(badge).toHaveAttribute('variant', 'danger');
      await expect(badge.locator('.dispatch-badge-icon')).toBeVisible();
      // Label drops the "blocked" suffix — colour + icon now carry that
      // signal. Tooltip is the authoritative explanation.
      await expect(badge).not.toContainText('blocked');
      const tooltip = page.locator('sl-tooltip', { has: badge }).first();
      await expect(tooltip).toHaveAttribute(
        'content',
        /Blocked by project dispatch policy.*reason: lockdown/,
      );
    } finally {
      await ctx.close();
    }
  });

  test('wildcard allowed badge is green (no italic), not neutral', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-dispatch-wildcard-green';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: stagesWithDispatch([
          {
            type: 'pipeline.hook.dispatch_allowed',
            section: 'skills',
            candidate: 'ascii-banner',
            via: 'wildcard',
            count: 1,
          },
        ]),
      });
      await openRunDetail(page, ctx.url, runId);

      const badge = page
        .locator('.dispatch-badge', { hasText: 'ascii-banner' })
        .first();
      await expect(badge).toBeVisible({ timeout: 8000 });
      // Wildcard class still tagged so styling hooks have something to
      // attach to, but the variant is success (green) like explicit allows.
      await expect(badge).toHaveClass(/dispatch-badge-wildcard/);
      await expect(badge).toHaveAttribute('variant', 'success');
      // Italic was a previous distinguishing cue for wildcard chips; user
      // wants regular weight. Check computed font-style on the badge host
      // (shadow part inheritance varies by browser version).
      const style = await badge.evaluate(
        (el) => getComputedStyle(el).fontStyle,
      );
      expect(style).toBe('normal');
    } finally {
      await ctx.close();
    }
  });
});
