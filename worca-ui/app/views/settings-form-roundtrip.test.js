import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSettings,
  readEffortFromDom,
  readPipelineFromDom,
} from './settings.js';

describe('Form round-trip: Project Settings Pipeline tab no longer owns milestones', () => {
  // worca.milestones (approval gates) is template-owned per
  // TEMPLATE_OWNED_KEYS — moved to the template editor's Pipeline
  // tab in the W-062 Phase 6 cleanup. readPipelineFromDom in
  // Project Settings no longer reads or emits the field.
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

  it('readPipelineFromDom does not return a milestones key', () => {
    const result = readPipelineFromDom();
    expect(result).not.toHaveProperty('milestones');
  });
});

describe('Form round-trip: effort block survives form -> JSON -> form cycle', () => {
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

  it('readEffortFromDom returns auto_mode, auto_cap, and per-agent effort', async () => {
    const serverResponse = {
      worca: {
        effort: { auto_mode: 'reactive', auto_cap: 'high' },
        agents: {
          planner: { model: 'opus', max_turns: 100, effort: 'xhigh' },
          implementer: { model: 'sonnet', max_turns: 300 },
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
      'effort-auto-mode': { value: 'reactive' },
      'effort-auto-cap': { value: 'high' },
      'effort-agent-planner': { value: 'xhigh' },
      'effort-agent-implementer': { value: '' },
      'effort-agent-coordinator': { value: '' },
      'effort-agent-tester': { value: '' },
      'effort-agent-reviewer': { value: '' },
      'effort-agent-guardian': { value: '' },
      'effort-agent-plan_reviewer': { value: '' },
      'effort-agent-learner': { value: '' },
      'effort-agent-workspace_planner': { value: '' },
    };
    globalThis.document.getElementById = (id) => elements[id] || null;

    const result = readEffortFromDom();

    expect(result.auto_mode).toBe('reactive');
    expect(result.auto_cap).toBe('high');
    expect(result.agents.planner).toEqual({ effort: 'xhigh' });
    expect(result.agents.implementer).toEqual({ effort: null });
  });

  it('readEffortFromDom defaults to adaptive/xhigh when DOM elements are missing', () => {
    const result = readEffortFromDom();

    expect(result.auto_mode).toBe('adaptive');
    expect(result.auto_cap).toBe('xhigh');
  });
});
