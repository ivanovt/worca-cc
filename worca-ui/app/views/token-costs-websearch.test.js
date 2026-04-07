import { describe, expect, it } from 'vitest';
import { tokenCostsView } from './token-costs.js';

function renderToString(template) {
  if (template == null) return '';
  if (typeof template === 'string') return template;
  if (typeof template === 'number') return String(template);
  if (Array.isArray(template)) return template.map(renderToString).join('');
  if (!template.strings) return ''; // skip directives, symbols, functions
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      result += renderToString(template.values[i]);
    }
  });
  return result;
}

function makeRun(id, costUsd = 0.5) {
  return {
    id,
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T01:00:00Z',
    stages: {
      plan: { iterations: [{ cost_usd: costUsd, number: 1 }] },
    },
  };
}

describe('tokenCostsView — web search summary card (3b)', () => {
  it('shows Web Searches card when webSearchRequests > 0', () => {
    const state = { runs: { r1: makeRun('r1') }, archivedRuns: {} };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 3,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, { tokenData, onToggleRun: () => {} }),
    );
    expect(output).toContain('Web Searches');
    expect(output).toContain('stat-web-search');
    expect(output).toContain('3');
  });

  it('does NOT show Web Searches card when webSearchRequests is 0', () => {
    const state = { runs: { r1: makeRun('r1') }, archivedRuns: {} };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, { tokenData, onToggleRun: () => {} }),
    );
    expect(output).not.toContain('Web Searches');
    expect(output).not.toContain('stat-web-search');
  });

  it('does NOT show Web Searches card when tokenData has no webSearchRequests field', () => {
    const state = { runs: { r1: makeRun('r1') }, archivedRuns: {} };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, { tokenData, onToggleRun: () => {} }),
    );
    expect(output).not.toContain('Web Searches');
  });

  it('sums webSearchRequests across multiple runs and stages', () => {
    const state = {
      runs: { r1: makeRun('r1'), r2: makeRun('r2') },
      archivedRuns: {},
    };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 2,
          },
        ],
      },
      r2: {
        plan: [
          {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 4,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, { tokenData, onToggleRun: () => {} }),
    );
    expect(output).toContain('Web Searches');
    // Total should be 6
    expect(output).toContain('6');
  });
});

describe('tokenCostsView — web search badge on cost rows (3c)', () => {
  it('shows cost-badge when iteration has webSearchRequests > 0', () => {
    const run = makeRun('r1', 0.5);
    const state = { runs: { r1: run }, archivedRuns: {} };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 2,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, {
        tokenData,
        expandedRun: 'r1',
        onToggleRun: () => {},
      }),
    );
    expect(output).toContain('cost-badge');
    expect(output).toContain('web search');
  });

  it('does NOT show cost-badge when iteration has webSearchRequests = 0', () => {
    const run = makeRun('r1', 0.5);
    const state = { runs: { r1: run }, archivedRuns: {} };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, {
        tokenData,
        expandedRun: 'r1',
        onToggleRun: () => {},
      }),
    );
    expect(output).not.toContain('cost-badge');
  });

  it('badge title includes the request count', () => {
    const run = makeRun('r1', 0.5);
    const state = { runs: { r1: run }, archivedRuns: {} };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 5,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, {
        tokenData,
        expandedRun: 'r1',
        onToggleRun: () => {},
      }),
    );
    expect(output).toContain('5');
    expect(output).toContain('cost-badge');
  });
});

describe('tokenCostsView — cache write tooltip (3d)', () => {
  it('shows 1h/5m breakdown in title attribute when cacheEphemeral1hTokens > 0', () => {
    const run = makeRun('r1', 0.5);
    const state = { runs: { r1: run }, archivedRuns: {} };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 56131,
            cacheEphemeral1hTokens: 50000,
            cacheEphemeral5mTokens: 6131,
            webSearchRequests: 0,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, {
        tokenData,
        expandedRun: 'r1',
        onToggleRun: () => {},
      }),
    );
    expect(output).toContain('1h:');
    expect(output).toContain('5m:');
  });

  it('does NOT add 1h/5m tooltip when cacheEphemeral1hTokens is 0', () => {
    const run = makeRun('r1', 0.5);
    const state = { runs: { r1: run }, archivedRuns: {} };
    const tokenData = {
      r1: {
        plan: [
          {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 1000,
            cacheEphemeral1hTokens: 0,
            cacheEphemeral5mTokens: 0,
            webSearchRequests: 0,
          },
        ],
      },
    };
    const output = renderToString(
      tokenCostsView(state, {
        tokenData,
        expandedRun: 'r1',
        onToggleRun: () => {},
      }),
    );
    expect(output).not.toContain('1h:');
  });
});
