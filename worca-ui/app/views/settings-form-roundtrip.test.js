import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, readPipelineFromDom } from './settings.js';

describe('Form round-trip: pr_approval stays absent on no-op Save', () => {
  let origDocument;
  let origFetch;

  beforeEach(() => {
    origDocument = globalThis.document;
    origFetch = globalThis.fetch;
    globalThis.document = {
      querySelectorAll: () => [],
      getElementById: () => null,
    };
  });

  afterEach(() => {
    globalThis.document = origDocument;
    globalThis.fetch = origFetch;
  });

  it('load clean project -> readPipelineFromDom -> no pr_approval key', async () => {
    const serverResponse = {
      worca: {
        milestones: {
          plan_approval: true,
        },
      },
    };

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('/api/subagents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, subagents: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(serverResponse),
      });
    });

    await loadSettings('test-project');

    const elements = {
      'milestone-plan-approval': { checked: true },
      'milestone-pr-approval': { checked: false },
      'cb-enabled': { checked: true },
      'cb-max-failures': { value: '3' },
      'parallel-worktree-base-dir': { value: '.worktrees' },
      'parallel-default-base-branch': { value: 'main' },
    };
    globalThis.document.getElementById = (id) => elements[id] || null;

    const result = readPipelineFromDom();

    expect(result.milestones.plan_approval).toBe(true);
    expect(result.milestones).not.toHaveProperty('pr_approval');
  });
});
