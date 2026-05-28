import { describe, expect, it } from 'vitest';
import { _stageToJson, runDetailView } from './run-detail.js';

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

// A single-iteration agent stage with an effort row, so the graphify badge
// renders on the same line as Effort (the summary path).
function makeRun({ graphifyEnabled, invocations, withEffort = true } = {}) {
  const iter = {
    number: 1,
    status: 'completed',
    outcome: 'success',
  };
  if (withEffort) iter.effort = { level: 'high', source: 'explicit' };
  if (invocations !== undefined) iter.graphify_invocations = invocations;
  const run = {
    stages: { plan: { status: 'completed', iterations: [iter] } },
  };
  if (graphifyEnabled !== undefined) run.graphify_enabled = graphifyEnabled;
  return run;
}

describe('runDetailView graphify invocation badge', () => {
  it('shows an integer count badge when enabled and the agent queried', () => {
    const html = renderToString(
      runDetailView(makeRun({ graphifyEnabled: true, invocations: 3 })),
    );
    expect(html).toContain('Graphify:');
    expect(html).toContain('graphify-invocations-badge');
    expect(html).toContain('3');
    // blue (primary) when it actually queried
    expect(html).toContain('variant="primary"');
    expect(html).not.toContain('(disabled)');
  });

  it('shows a grey 0 badge when enabled but the agent never queried', () => {
    const html = renderToString(
      runDetailView(makeRun({ graphifyEnabled: true, invocations: 0 })),
    );
    expect(html).toContain('Graphify:');
    expect(html).toContain('graphify-invocations-badge');
    expect(html).toContain('variant="neutral"');
    expect(html).not.toContain('(disabled)');
  });

  it('shows a plain "(disabled)" value (no badge) when graphify is off', () => {
    const html = renderToString(
      runDetailView(makeRun({ graphifyEnabled: false, invocations: 0 })),
    );
    expect(html).toContain('Graphify:');
    expect(html).toContain('(disabled)');
    expect(html).not.toContain('graphify-invocations-badge');
  });

  it('treats a missing graphify_enabled flag as disabled', () => {
    const html = renderToString(
      runDetailView(makeRun({ invocations: 0 })), // no graphify_enabled
    );
    expect(html).toContain('Graphify:');
    expect(html).toContain('(disabled)');
  });

  it('omits the Graphify badge entirely on iterations without the field (pre-feature / non-agent)', () => {
    const html = renderToString(
      runDetailView(makeRun({ graphifyEnabled: true })), // no graphify_invocations
    );
    expect(html).not.toContain('Graphify:');
  });

  it('still shows the badge when effort is absent (own row)', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ graphifyEnabled: true, invocations: 2, withEffort: false }),
      ),
    );
    expect(html).toContain('Graphify:');
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
              graphify_invocations: 1,
            },
            {
              number: 2,
              status: 'completed',
              outcome: 'success',
              effort: { level: 'max', source: 'reactive' },
              graphify_invocations: 4,
            },
          ],
        },
      },
      graphify_enabled: true,
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Graphify:');
    expect(html).toContain('graphify-invocations-badge');
  });
});

// --- Preflight Graphify Badge ---

function makePreflightRun({
  graphifyEnabled,
  graphifyStatus,
  graphifyOutcome,
  graphifyMode,
  graphifyReason,
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
  if (graphifyStatus !== undefined) stage.graphify_status = graphifyStatus;
  if (graphifyOutcome !== undefined) stage.graphify_outcome = graphifyOutcome;
  if (graphifyMode !== undefined) stage.graphify_mode = graphifyMode;
  if (graphifyReason !== undefined) stage.graphify_reason = graphifyReason;
  const run = { stages: { preflight: stage } };
  if (graphifyEnabled !== undefined) run.graphify_enabled = graphifyEnabled;
  return run;
}

describe('preflight graphify badge', () => {
  it('shows "Graphify: cached · structural" with success variant for cache hit', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          graphifyEnabled: true,
          graphifyStatus: 'ready',
          graphifyOutcome: 'cached',
          graphifyMode: 'structural',
        }),
      ),
    );
    expect(html).toContain('preflight-graphify-badge');
    expect(html).toContain('cached · structural');
    expect(html).toContain('variant="success"');
    // labeled, aligned row (not a floating bare badge)
    expect(html).toContain('Graphify:');
    expect(html).toContain('iteration-tags-row');
    // explanatory tooltip + mode hint
    expect(html).toContain('Reused the knowledge graph');
    expect(html).toContain('structural mode');
  });

  it('shows "Graphify: rebuilt · full" with success variant for fresh build', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          graphifyEnabled: true,
          graphifyStatus: 'ready',
          graphifyOutcome: 'built',
          graphifyMode: 'full',
        }),
      ),
    );
    expect(html).toContain('preflight-graphify-badge');
    expect(html).toContain('rebuilt · full');
    expect(html).toContain('variant="success"');
    expect(html).toContain('Graphify:');
    expect(html).toContain('No cached graph for this commit');
    expect(html).toContain('full mode');
  });

  it('shows "Graphify: built (uncommitted) · structural" with warning variant for throwaway', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          graphifyEnabled: true,
          graphifyStatus: 'ready',
          graphifyOutcome: 'throwaway',
          graphifyMode: 'structural',
        }),
      ),
    );
    expect(html).toContain('preflight-graphify-badge');
    expect(html).toContain('built (uncommitted) · structural');
    expect(html).toContain('variant="warning"');
    expect(html).toContain('Graphify:');
    expect(html).toContain('Working tree had uncommitted changes');
    expect(html).toContain('structural mode');
  });

  it('shows "Graphify: unavailable" with danger variant for degraded', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          graphifyEnabled: true,
          graphifyStatus: 'degraded',
          graphifyReason: 'CLI not found',
        }),
      ),
    );
    expect(html).toContain('preflight-graphify-badge');
    expect(html).toContain('unavailable');
    expect(html).toContain('variant="danger"');
    expect(html).toContain('Graphify:');
    // shows the underlying reason and points to settings — no inline command
    expect(html).toContain('CLI not found');
    expect(html).toContain('See Project Settings');
    expect(html).not.toContain('uv tool install');
    expect(html).not.toContain('pip install');
  });

  it('shows "Graphify: off" with neutral variant when disabled', () => {
    const html = renderToString(
      runDetailView(makePreflightRun({ graphifyEnabled: false })),
    );
    expect(html).toContain('preflight-graphify-badge');
    expect(html).toContain('off');
    expect(html).toContain('variant="neutral"');
    expect(html).toContain('Graphify:');
    expect(html).toContain('disabled for this project');
  });

  it('shows "Graphify: skipped" with neutral variant for skipped status', () => {
    const html = renderToString(
      runDetailView(
        makePreflightRun({
          graphifyEnabled: true,
          graphifyStatus: 'skipped',
          graphifyMode: 'structural',
        }),
      ),
    );
    expect(html).toContain('preflight-graphify-badge');
    expect(html).toContain('skipped');
    expect(html).toContain('variant="neutral"');
    expect(html).toContain('Graphify:');
    expect(html).toContain('no graph was available');
  });

  it('renders the preflight badge in a multi-iteration preflight stage', () => {
    const run = {
      stages: {
        preflight: {
          status: 'completed',
          graphify_status: 'ready',
          graphify_outcome: 'cached',
          graphify_mode: 'full',
          iterations: [
            { number: 1, status: 'completed', outcome: 'error' },
            { number: 2, status: 'completed', outcome: 'success' },
          ],
        },
      },
      graphify_enabled: true,
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('preflight-graphify-badge');
    expect(html).toContain('cached · full');
    expect(html).toContain('Graphify:');
  });

  it('renders nothing when graphify fields are entirely absent (old runs)', () => {
    const html = renderToString(runDetailView(makePreflightRun({})));
    expect(html).not.toContain('preflight-graphify-badge');
  });

  it('renders nothing on non-preflight stages', () => {
    const run = {
      stages: {
        plan: {
          status: 'completed',
          graphify_status: 'ready',
          graphify_outcome: 'cached',
          graphify_mode: 'structural',
          iterations: [{ number: 1, status: 'completed', outcome: 'success' }],
        },
      },
      graphify_enabled: true,
    };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('preflight-graphify-badge');
  });
});

describe('_stageToJson includes preflight graphify fields', () => {
  it('includes graphify_outcome, graphify_mode, graphify_reason', () => {
    const stage = {
      status: 'completed',
      graphify_status: 'ready',
      graphify_outcome: 'built',
      graphify_mode: 'full',
      graphify_reason: 'test reason',
      iterations: [{ number: 1, status: 'completed' }],
    };
    const json = _stageToJson('preflight', stage, null, null, null);
    expect(json.graphify_outcome).toBe('built');
    expect(json.graphify_mode).toBe('full');
    expect(json.graphify_reason).toBe('test reason');
  });

  it('omits absent graphify fields', () => {
    const stage = {
      status: 'completed',
      iterations: [{ number: 1, status: 'completed' }],
    };
    const json = _stageToJson('preflight', stage, null, null, null);
    expect(json.graphify_outcome).toBeUndefined();
    expect(json.graphify_mode).toBeUndefined();
    expect(json.graphify_reason).toBeUndefined();
  });
});
