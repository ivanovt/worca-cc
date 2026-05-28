import { describe, expect, it } from 'vitest';
import { runDetailView } from './run-detail.js';

function renderToString(template) {
  if (!template) return '';
  if (template.overview)
    return renderToString(template.overview) + renderToString(template.stages);
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (typeof v === 'number') result += String(v);
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

function makeRun({
  crgEnabled,
  invocations,
  toolCounts,
  withEffort = true,
} = {}) {
  const iter = {
    number: 1,
    status: 'completed',
    outcome: 'success',
  };
  if (withEffort) iter.effort = { level: 'high', source: 'explicit' };
  if (invocations !== undefined) iter.crg_invocations = invocations;
  if (toolCounts !== undefined) iter.crg_tool_counts = toolCounts;
  const run = {
    stages: { plan: { status: 'completed', iterations: [iter] } },
  };
  if (crgEnabled !== undefined) run.crg_enabled = crgEnabled;
  return run;
}

describe('runDetailView CRG invocation badge', () => {
  it('shows an integer count badge when enabled and the agent used CRG tools', () => {
    const html = renderToString(
      runDetailView(makeRun({ crgEnabled: true, invocations: 5 })),
    );
    expect(html).toContain('CRG:');
    expect(html).toContain('crg-invocations-badge');
    expect(html).toContain('5');
    expect(html).toContain('variant="primary"');
    expect(html).not.toContain('(disabled)');
  });

  it('shows a grey 0 badge when enabled but the agent never used CRG tools', () => {
    const html = renderToString(
      runDetailView(makeRun({ crgEnabled: true, invocations: 0 })),
    );
    expect(html).toContain('CRG:');
    expect(html).toContain('crg-invocations-badge');
    expect(html).toContain('variant="neutral"');
    expect(html).not.toContain('(disabled)');
  });

  it('shows a per-tool breakdown tooltip (busiest first) when count > 0', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          crgEnabled: true,
          invocations: 7,
          toolCounts: {
            get_architecture_overview_tool: 2,
            get_minimal_context_tool: 5,
          },
        }),
      ),
    );
    expect(html).toContain('crg-invocations-badge');
    expect(html).toContain('<sl-tooltip');
    // one tool per line, busiest first
    expect(html).toContain(
      'get_minimal_context_tool ×5\nget_architecture_overview_tool ×2',
    );
  });

  it('omits the breakdown tooltip when count is 0', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          crgEnabled: true,
          invocations: 0,
          toolCounts: {},
        }),
      ),
    );
    expect(html).toContain('crg-invocations-badge');
    expect(html).not.toContain('×');
  });

  it('shows a plain "(disabled)" value (no badge) when CRG is off', () => {
    const html = renderToString(
      runDetailView(makeRun({ crgEnabled: false, invocations: 0 })),
    );
    expect(html).toContain('CRG:');
    expect(html).toContain('(disabled)');
    expect(html).not.toContain('crg-invocations-badge');
  });

  it('treats a missing crg_enabled flag as disabled', () => {
    const html = renderToString(runDetailView(makeRun({ invocations: 0 })));
    expect(html).toContain('CRG:');
    expect(html).toContain('(disabled)');
  });

  it('omits the CRG badge entirely on iterations without the field (pre-feature / non-agent)', () => {
    const html = renderToString(runDetailView(makeRun({ crgEnabled: true })));
    expect(html).not.toContain('CRG:');
  });

  it('still shows the badge when effort is absent (own row)', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ crgEnabled: true, invocations: 2, withEffort: false }),
      ),
    );
    expect(html).toContain('CRG:');
    expect(html).toContain('2');
  });

  it('renders the badge in a multi-iteration stage (tabbed path)', () => {
    const run = {
      stages: {
        implement: {
          status: 'completed',
          iterations: [
            {
              number: 1,
              status: 'completed',
              outcome: 'error',
              effort: { level: 'high', source: 'explicit' },
              crg_invocations: 1,
            },
            {
              number: 2,
              status: 'completed',
              outcome: 'success',
              effort: { level: 'max', source: 'reactive' },
              crg_invocations: 7,
            },
          ],
        },
      },
      crg_enabled: true,
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('CRG:');
    expect(html).toContain('crg-invocations-badge');
  });
});

// --- Preflight Code Review Graph badge ---

function makePreflightRun({
  crgEnabled,
  crgStatus,
  crgOutcome,
  crgReason,
} = {}) {
  const stage = {
    status: 'completed',
    iterations: [
      {
        number: 1,
        status: 'completed',
        outcome: 'success',
        output: { checks: [], summary: 'ok' },
      },
    ],
  };
  if (crgStatus !== undefined) stage.crg_status = crgStatus;
  if (crgOutcome !== undefined) stage.crg_outcome = crgOutcome;
  if (crgReason !== undefined) stage.crg_reason = crgReason;
  const run = { stages: { preflight: stage } };
  if (crgEnabled !== undefined) run.crg_enabled = crgEnabled;
  return run;
}

describe('preflight Code Review Graph badge', () => {
  it('shows "cached" success badge for a cache hit', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          crgEnabled: true,
          crgStatus: 'ready',
          crgOutcome: 'cached',
        }),
      ),
    );
    expect(html).toContain('preflight-crg-badge');
    expect(html).toContain('Code Review Graph:');
    expect(html).toContain('cached');
    expect(html).toContain('variant="success"');
  });

  it('shows "rebuilt" success badge for a fresh build', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          crgEnabled: true,
          crgStatus: 'ready',
          crgOutcome: 'built',
        }),
      ),
    );
    expect(html).toContain('rebuilt');
    expect(html).toContain('variant="success"');
  });

  it('shows "built (uncommitted)" warning badge for a throwaway', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          crgEnabled: true,
          crgStatus: 'ready',
          crgOutcome: 'throwaway',
        }),
      ),
    );
    expect(html).toContain('built (uncommitted)');
    expect(html).toContain('variant="warning"');
  });

  it('falls back to "ready" when status is ready but no outcome (old runs)', () => {
    const html = renderToString(
      runDetailView(makePreflightRun({ crgEnabled: true, crgStatus: 'ready' })),
    );
    expect(html).toContain('preflight-crg-badge');
    expect(html).toContain('Code Review Graph:');
    expect(html).toContain('ready');
    expect(html).toContain('variant="success"');
  });

  it('shows "unavailable" danger badge with reason for degraded', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          crgEnabled: true,
          crgStatus: 'degraded',
          crgReason: 'code-review-graph not found on PATH',
        }),
      ),
    );
    expect(html).toContain('preflight-crg-badge');
    expect(html).toContain('Code Review Graph:');
    expect(html).toContain('unavailable');
    expect(html).toContain('variant="danger"');
    expect(html).toContain('code-review-graph not found on PATH');
    expect(html).toContain('See Project Settings');
    // no inline install command in the tooltip
    expect(html).not.toContain('pip install');
  });

  it('shows "skipped" neutral badge when enabled but no graph this run', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({ crgEnabled: true, crgStatus: 'skipped' }),
      ),
    );
    expect(html).toContain('preflight-crg-badge');
    expect(html).toContain('Code Review Graph:');
    expect(html).toContain('skipped');
    expect(html).toContain('variant="neutral"');
  });

  it('shows "off" neutral badge when CRG is disabled', () => {
    const html = renderToString(
      runDetailView(makePreflightRun({ crgEnabled: false })),
    );
    expect(html).toContain('preflight-crg-badge');
    expect(html).toContain('Code Review Graph:');
    expect(html).toContain('off');
    expect(html).toContain('variant="neutral"');
  });

  it('renders nothing when CRG fields are entirely absent (old runs)', () => {
    const html = renderToString(runDetailView(makePreflightRun({})));
    expect(html).not.toContain('preflight-crg-badge');
  });

  it('renders nothing on non-preflight stages', () => {
    const run = {
      stages: {
        plan: {
          status: 'completed',
          crg_status: 'ready',
          iterations: [{ number: 1, status: 'completed', outcome: 'success' }],
        },
      },
      crg_enabled: true,
    };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('preflight-crg-badge');
  });
});
