import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, seedRun } from './fixtures.js';

const GOTO_OPTS = { waitUntil: 'domcontentloaded' };

/**
 * Seed a completed `implement` stage with a user message (-p) stored on the
 * stage and a resolved agent prompt file on disk, so the "Agent Instructions"
 * panel renders both blocks (Agent Prompt + User Message).
 */
function seedRunWithBothPrompts(worcaDir, runId) {
  seedRun(worcaDir, runId, {
    pipeline_status: 'completed',
    stage: 'implement',
    stages: {
      plan: { status: 'completed' },
      implement: {
        status: 'completed',
        agent: 'implementer',
        prompt: 'Add user auth to the app and write tests for the login flow.',
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
  const resolvedDir = join(worcaDir, 'runs', runId, 'agents', 'resolved');
  mkdirSync(resolvedDir, { recursive: true });
  writeFileSync(
    join(resolvedDir, 'implement-implementer-iter-1.md'),
    'You are the implementer agent. Follow the plan in MASTER_PLAN.md...\n',
    'utf8',
  );
}

async function openAgentInstructions(page, baseUrl, runId) {
  await page.goto(`${baseUrl}/#/history?run=${runId}`, GOTO_OPTS);
  await expect(page.locator('.run-detail .stage-panels')).toBeVisible({
    timeout: 8000,
  });
  const implementPanel = page
    .locator('.stage-panel', {
      has: page.locator('.stage-panel-label', { hasText: 'IMPLEMENT' }),
    })
    .first();
  await implementPanel.locator('.stage-panel-header').click();
  await expect(implementPanel).toHaveAttribute('open', '', { timeout: 5000 });

  // The prompt data is fetched lazily over WS; wait for the section, then expand.
  const section = page.locator('sl-details.agent-prompt-section').first();
  await expect(section).toBeVisible({ timeout: 8000 });
  await section.locator('.agent-prompt-header').click();
  await expect(section).toHaveAttribute('open', '', { timeout: 5000 });
  return section;
}

test.describe('run-detail Agent Instructions — block separation', () => {
  test('renders both blocks with a divider and accented headers', async ({
    page,
  }) => {
    const ctx = await startServer();
    try {
      const runId = '20260101-agent-prompt-separation';
      seedRunWithBothPrompts(ctx.worcaDir, runId);
      const section = await openAgentInstructions(page, ctx.url, runId);

      // No modifier classes — locate each block by its header label.
      const agentBlock = section.locator('.agent-prompt-block', {
        has: page.locator('.agent-prompt-label', { hasText: 'Agent Prompt' }),
      });
      const userBlock = section.locator('.agent-prompt-block', {
        has: page.locator('.agent-prompt-label', { hasText: 'User Message' }),
      });
      await expect(agentBlock).toBeVisible();
      await expect(userBlock).toBeVisible();

      // A divider sits before the user message header (top border on the
      // second block); the first block has none.
      const userBorderTop = await userBlock.evaluate(
        (el) => getComputedStyle(el).borderTopWidth,
      );
      const agentBorderTop = await agentBlock.evaluate(
        (el) => getComputedStyle(el).borderTopWidth,
      );
      expect(parseFloat(userBorderTop)).toBeGreaterThan(0);
      expect(parseFloat(agentBorderTop)).toBe(0);

      // Headers are accented — both labels share one accent colour, distinct
      // from the (neutral) markdown body text.
      const agentLabelColor = await agentBlock
        .locator('.agent-prompt-label')
        .evaluate((el) => getComputedStyle(el).color);
      const userLabelColor = await userBlock
        .locator('.agent-prompt-label')
        .evaluate((el) => getComputedStyle(el).color);
      const bodyColor = await section
        .locator('.markdown-body')
        .first()
        .evaluate((el) => getComputedStyle(el).color);
      expect(agentLabelColor).toBe(userLabelColor);
      expect(agentLabelColor).not.toBe(bodyColor);

      // Bodies stay neutral — no accent left-bar on the markdown body.
      const userBodyLeft = await userBlock
        .locator('.markdown-body')
        .evaluate((el) => getComputedStyle(el).borderLeftWidth);
      expect(parseFloat(userBodyLeft)).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});
