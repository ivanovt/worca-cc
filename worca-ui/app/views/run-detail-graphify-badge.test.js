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
