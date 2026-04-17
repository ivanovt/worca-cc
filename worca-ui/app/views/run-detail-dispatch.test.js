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
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

function makeRun(iterOverrides = {}) {
  return {
    stages: {
      implement: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            outcome: 'success',
            ...iterOverrides,
          },
        ],
      },
    },
  };
}

describe('iteration tags layout', () => {
  // --- Trigger + Outcome row ---

  it('renders trigger as neutral sl-badge pill with label', () => {
    const html = renderToString(runDetailView(makeRun({ trigger: 'initial' })));
    expect(html).toContain('Iteration Trigger:');
    expect(html).toContain('variant="neutral"');
    expect(html).toContain('Initial run');
  });

  it('renders outcome as colored sl-badge pill with label', () => {
    const html = renderToString(runDetailView(makeRun({ outcome: 'approve' })));
    expect(html).toContain('Iteration Outcome:');
    expect(html).toContain('variant="success"');
    expect(html).toContain('approve');
  });

  it('renders request_changes outcome as warning variant', () => {
    const html = renderToString(
      runDetailView(makeRun({ outcome: 'request_changes' })),
    );
    expect(html).toContain('variant="warning"');
    expect(html).toContain('request changes');
  });

  it('renders rejected outcome as danger variant', () => {
    const html = renderToString(
      runDetailView(makeRun({ outcome: 'rejected' })),
    );
    expect(html).toContain('variant="danger"');
  });

  it('renders trigger and outcome on the same row', () => {
    const html = renderToString(
      runDetailView(makeRun({ trigger: 'test_failure', outcome: 'success' })),
    );
    // Both labels + badges inside a single iteration-tags-row
    expect(html).toContain('Iteration Trigger:');
    expect(html).toContain('Iteration Outcome:');
    expect(html).toContain('Test failure');
  });

  it('omits tags row when neither trigger nor outcome present', () => {
    const html = renderToString(
      runDetailView(makeRun({ trigger: undefined, outcome: undefined })),
    );
    expect(html).not.toContain('Iteration Trigger:');
    expect(html).not.toContain('Iteration Outcome:');
  });

  // --- Agent info strip ---

  it('renders agent and model as labeled values', () => {
    const run = makeRun({
      agent: 'implementer',
      model: 'claude-sonnet-4-6',
      turns: 9,
    });
    // Set stage-level agent/model (used by single-iteration path)
    run.stages.implement.agent = 'implementer';
    run.stages.implement.model = 'claude-sonnet-4-6';
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Agent:');
    expect(html).toContain('implementer');
    expect(html).toContain('Model:');
    expect(html).toContain('claude-sonnet-4-6');
    // Old parenthesized format should not appear
    expect(html).not.toContain('(claude-sonnet-4-6)');
  });

  // --- Subagents row ---

  it('renders dispatch events with Subagents label', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              subagent_type: 'Explore',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Subagents:');
    expect(html).toContain('Explore dispatched');
    expect(html).toContain('variant="success"');
  });

  it('renders blocked dispatch with tooltip', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_blocked',
              subagent_type: 'general-purpose',
              reason: 'denylist',
              count: 2,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Subagents:');
    expect(html).toContain('general-purpose blocked (×2)');
    expect(html).toContain('title="denylist"');
  });

  it('omits Subagents row when no dispatch events', () => {
    const html = renderToString(runDetailView(makeRun()));
    expect(html).not.toContain('Subagents:');
  });

  it('renders ×N suffix only when count > 1', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              subagent_type: 'Explore',
              count: 5,
            },
            {
              type: 'pipeline.hook.dispatch_allowed',
              subagent_type: 'Plan',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Explore dispatched (×5)');
    expect(html).toContain('Plan dispatched');
    expect(html).not.toContain('Plan dispatched (×');
  });

  // --- Classification row ---

  it('renders classification as inline label:value pairs', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          classification: {
            category: 'logic_stuck',
            retriable: false,
            similar_to_previous: false,
          },
        }),
      ),
    );
    expect(html).toContain('Fail Category:');
    expect(html).toContain('logic_stuck');
    expect(html).toContain('Severity:');
    // Old bordered classification-strip should not appear
    expect(html).not.toContain('classification-strip');
  });

  it('shows similar flag when true', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          classification: {
            category: 'infra_transient',
            retriable: true,
            similar_to_previous: true,
          },
        }),
      ),
    );
    expect(html).toContain('Similar:');
    expect(html).toContain('yes');
  });

  it('omits classification row when absent', () => {
    const html = renderToString(runDetailView(makeRun()));
    expect(html).not.toContain('Fail Category:');
  });
});
