import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

const MARKDOWN_PROMPT = [
  '## Setup',
  '',
  'Install dependencies with **npm install**.',
  '',
  '- step one',
  '- step two',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  'Use `inline code` here.',
].join('\n');

function seedRunWithPrompt(worcaDir, runId, promptMarkdown) {
  const runDir = join(worcaDir, 'runs', runId);
  const resolvedDir = join(runDir, 'agents', 'resolved');
  mkdirSync(resolvedDir, { recursive: true });
  writeFileSync(
    join(resolvedDir, 'implement-sonnet-iter-0.md'),
    promptMarkdown,
    'utf8',
  );
  seedRun(worcaDir, runId, {
    pipeline_status: 'completed',
    stages: {
      plan: { status: 'completed' },
      implement: {
        status: 'completed',
        agent: 'sonnet',
        prompt: 'Build the feature',
        iterations: [
          {
            number: 0,
            status: 'completed',
            started_at: '2026-01-01T10:00:00.000Z',
            completed_at: '2026-01-01T10:05:00.000Z',
          },
        ],
      },
    },
  });
}

async function openRunDetail(page, baseUrl, runId) {
  await page.goto(`${baseUrl}/#/history?run=${runId}`, GOTO_OPTS);
  await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
    timeout: 8000,
  });
}

async function expandImplementStage(page) {
  const implementPanel = page
    .locator('.stage-panel', {
      has: page.locator('.stage-panel-label', { hasText: 'IMPLEMENT' }),
    })
    .first();
  await implementPanel.locator('.stage-panel-header').click();
  await expect(implementPanel).toHaveAttribute('open', '', { timeout: 5000 });
  return implementPanel;
}

async function expandAgentPromptSection(page) {
  const section = page.locator('.agent-prompt-section').first();
  await section.locator('[slot="summary"]').click();
  await expect(section).toHaveAttribute('open', '', { timeout: 5000 });
  return section;
}

// ─── Agent prompt markdown rendering ──────────────────────────────────────

test.describe('markdown rendering — agent prompts', () => {
  test('agent prompt renders formatted HTML from markdown', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-md-prompt-render';
      seedRunWithPrompt(ctx.worcaDir, runId, MARKDOWN_PROMPT);
      await openRunDetail(page, ctx.url, runId);
      await expandImplementStage(page);
      await expandAgentPromptSection(page);

      const promptBlock = page.locator('.agent-prompt-block').first();
      await expect(promptBlock).toBeVisible({ timeout: 8000 });

      const markdownBody = promptBlock.locator('.markdown-body');
      await expect(markdownBody).toBeVisible();

      await expect(markdownBody.locator('h2')).toContainText('Setup');
      await expect(markdownBody.locator('strong')).toContainText('npm install');
      await expect(markdownBody.locator('ul > li').first()).toContainText(
        'step one',
      );
      await expect(markdownBody.locator('code').first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('copy button yields raw markdown, not rendered HTML', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const ctx = await startServer();
    try {
      const runId = '20260101-md-prompt-copy';
      seedRunWithPrompt(ctx.worcaDir, runId, MARKDOWN_PROMPT);
      await openRunDetail(page, ctx.url, runId);
      await expandImplementStage(page);
      await expandAgentPromptSection(page);

      const promptBlock = page.locator('.agent-prompt-block').first();
      await expect(promptBlock).toBeVisible({ timeout: 8000 });

      const copyBtn = promptBlock.locator('.copy-btn');
      await copyBtn.click();

      const clipboardText = await page.evaluate(() =>
        navigator.clipboard.readText(),
      );
      expect(clipboardText).toContain('## Setup');
      expect(clipboardText).toContain('**npm install**');
      expect(clipboardText).toContain('- step one');
      expect(clipboardText).toContain('```js');
      expect(clipboardText).not.toContain('<h2>');
      expect(clipboardText).not.toContain('<strong>');
    } finally {
      await ctx.close();
    }
  });
});

// ─── Bead tooltip and row markdown rendering ─────────────────────────────

const BEAD_MARKDOWN_BODY = [
  '## Description',
  '',
  'This bead has **bold** and *italic* text.',
  '',
  '- list item one',
  '- list item two',
].join('\n');

function seedBeadsDb(projectDir, runId) {
  const beadsDir = join(projectDir, '.beads');
  mkdirSync(beadsDir, { recursive: true });
  const dbPath = join(beadsDir, 'beads.db');
  execFileSync('bd', ['init'], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 10000,
  });
  const createOut = execFileSync(
    'bd',
    [
      'create',
      '--title',
      'Markdown bead',
      '--description',
      BEAD_MARKDOWN_BODY,
      '--priority',
      '2',
      '--json',
      '--db',
      dbPath,
    ],
    { cwd: projectDir, encoding: 'utf8', timeout: 10000 },
  );
  const issue = JSON.parse(createOut);
  execFileSync(
    'bd',
    ['label', 'add', issue.id, `run:${runId}`, '--db', dbPath],
    { cwd: projectDir, encoding: 'utf8', timeout: 10000 },
  );
  return issue;
}

test.describe('markdown rendering — bead tooltip', () => {
  test('bead tooltip renders rich markdown content', async ({ page }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-md-bead-tooltip';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: {
          plan: { status: 'completed' },
          implement: { status: 'completed' },
        },
      });
      seedBeadsDb(ctx.dir, runId);

      await openRunDetail(page, ctx.url, runId);

      const beadsPanel = page.locator('.run-beads-panel');
      // The panel now renders immediately in a loading state; wait for the bead
      // rows to load into the DOM (the bd query can be slow on a cold daemon)
      // before expanding, so we don't race the loading→loaded re-render.
      const beadRow = page.locator('.run-bead-row').first();
      await expect(beadRow).toBeAttached({ timeout: 20000 });
      await beadsPanel.scrollIntoViewIfNeeded();
      await beadsPanel.locator('[slot="summary"]').click();
      await expect(beadsPanel).toHaveAttribute('open', '', { timeout: 5000 });
      await expect(beadRow).toBeVisible({ timeout: 8000 });

      await beadRow.hover();

      const tooltipContent = page.locator('.bead-tooltip-content').first();
      await expect(tooltipContent).toBeVisible({ timeout: 5000 });

      const excerpt = tooltipContent.locator('.bead-tooltip-excerpt');
      await expect(excerpt).toBeVisible();
      await expect(excerpt).toHaveClass(/markdown-body/);
      await expect(excerpt.locator('h2')).toContainText('Description');
      await expect(excerpt.locator('strong')).toContainText('bold');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('markdown rendering — bead row', () => {
  test('run-detail bead row shows plain title, not raw markdown', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-md-bead-row-strip';
      seedRun(ctx.worcaDir, runId, {
        pipeline_status: 'completed',
        stages: {
          plan: { status: 'completed' },
          implement: { status: 'completed' },
        },
      });
      seedBeadsDb(ctx.dir, runId);

      await openRunDetail(page, ctx.url, runId);

      const beadsPanel = page.locator('.run-beads-panel');
      // Panel renders immediately (loading); wait for bead data in the DOM
      // before expanding (cold-daemon bd query can be slow).
      await expect(page.locator('.run-bead-row').first()).toBeAttached({
        timeout: 20000,
      });
      await beadsPanel.scrollIntoViewIfNeeded();
      await beadsPanel.locator('[slot="summary"]').click();
      await expect(beadsPanel).toHaveAttribute('open', '', { timeout: 5000 });

      const beadTitle = page.locator('.run-bead-title').first();
      await expect(beadTitle).toBeVisible({ timeout: 8000 });
      await expect(beadTitle).toContainText('Markdown bead');

      const rowText = await page.locator('.run-bead-row').first().textContent();
      expect(rowText).not.toContain('##');
      expect(rowText).not.toContain('**');
    } finally {
      await ctx.close();
    }
  });
});
