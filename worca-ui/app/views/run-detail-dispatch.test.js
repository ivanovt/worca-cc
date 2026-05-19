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
              section: 'subagents',
              candidate: 'Explore',
              via: 'explicit',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Dispatch:');
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
              section: 'subagents',
              candidate: 'general-purpose',
              reason: 'denylist',
              count: 2,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Dispatch:');
    expect(html).toContain('general-purpose blocked (×2)');
    // PR B tooltip composition: section/via/reason joined by " · "
    expect(html).toMatch(/title="[^"]*denylist[^"]*"/);
    expect(html).toMatch(/title="[^"]*section: subagents[^"]*"/);
  });

  it('renders skill dispatches via the unified dispatch_allowed event (section: skills)', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'skills',
              candidate: 'review',
              via: 'wildcard',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Dispatch:');
    expect(html).toContain('review dispatched');
    expect(html).toContain('variant="success"');
  });

  it('renders explicit empty-state for completed iterations with no dispatch', () => {
    const html = renderToString(runDetailView(makeRun()));
    expect(html).toContain('Dispatch:');
    expect(html).toContain('No subagent or skill activity in this iteration');
  });

  it('omits Dispatch row for in-progress iterations with no events', () => {
    // In-progress iterations stay blank so empty-state doesn't flicker into
    // view before the first hook fires.
    const html = renderToString(
      runDetailView({
        stages: {
          implement: {
            status: 'in_progress',
            iterations: [
              {
                number: 1,
                status: 'in_progress',
                started_at: '2026-04-13T11:00:00.000Z',
              },
            ],
          },
        },
      }),
    );
    expect(html).not.toContain('Dispatch:');
    expect(html).not.toContain('No subagent or skill activity');
  });

  it('collapses dispatch events into a +N more overflow at 7+ entries', () => {
    const events = Array.from({ length: 9 }, (_, i) => ({
      type: 'pipeline.hook.dispatch_allowed',
      section: 'subagents',
      candidate: `Agent${i}`,
      via: 'wildcard',
      count: 1,
    }));
    const html = renderToString(
      runDetailView(makeRun({ dispatch_events: events })),
    );
    expect(html).toContain('Dispatch:');
    // Six visible inline
    for (let i = 0; i < 6; i += 1) {
      expect(html).toContain(`Agent${i} dispatched`);
    }
    // Remaining 3 sit behind the overflow control
    expect(html).toContain('+3 more');
    expect(html).toContain('dispatch-events-overflow');
  });

  it('does NOT show overflow when count is at or below the visible limit', () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      type: 'pipeline.hook.dispatch_allowed',
      section: 'subagents',
      candidate: `Agent${i}`,
      via: 'wildcard',
      count: 1,
    }));
    const html = renderToString(
      runDetailView(makeRun({ dispatch_events: events })),
    );
    expect(html).not.toContain('more');
    expect(html).not.toContain('dispatch-events-overflow');
  });

  it('renders ×N suffix only when count > 1', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'subagents',
              candidate: 'Explore',
              via: 'explicit',
              count: 5,
            },
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'subagents',
              candidate: 'Plan',
              via: 'wildcard',
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

  it('back-compat: legacy subagent_type payload key still renders', () => {
    // Status snapshots written before W-054 PR D still carry the old field.
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              subagent_type: 'Explore',
              via: 'explicit',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Explore dispatched');
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

describe('dispatch activity counter', () => {
  it('renders counter with explicit and wildcard counts', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'subagents',
              candidate: 'Explore',
              via: 'explicit',
              count: 3,
            },
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'subagents',
              candidate: 'Plan',
              via: 'wildcard',
              count: 2,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Dispatch activity:');
    expect(html).toContain('3 explicit');
    expect(html).toContain('2 via wildcard');
  });

  it('omits wildcard segment when all events are explicit', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'subagents',
              candidate: 'Explore',
              via: 'explicit',
              count: 5,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('5 explicit');
    expect(html).not.toContain('wildcard');
  });

  it('counts skill dispatches alongside subagent dispatches via the unified type', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'subagents',
              candidate: 'Explore',
              via: 'explicit',
              count: 1,
            },
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'skills',
              candidate: 'review',
              via: 'wildcard',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('1 explicit');
    expect(html).toContain('1 via wildcard');
  });

  it('excludes blocked events from counter', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_allowed',
              section: 'subagents',
              candidate: 'Explore',
              via: 'explicit',
              count: 2,
            },
            {
              type: 'pipeline.hook.dispatch_blocked',
              section: 'subagents',
              candidate: 'general-purpose',
              reason: 'denylist',
              count: 3,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('2 explicit');
  });

  it('aggregates counts across multiple stages', () => {
    const run = {
      stages: {
        implement: {
          status: 'completed',
          agent: 'implementer',
          iterations: [
            {
              number: 1,
              status: 'completed',
              dispatch_events: [
                {
                  type: 'pipeline.hook.dispatch_allowed',
                  section: 'subagents',
                  candidate: 'Explore',
                  via: 'explicit',
                  count: 3,
                },
              ],
            },
          ],
        },
        test: {
          status: 'completed',
          agent: 'tester',
          iterations: [
            {
              number: 1,
              status: 'completed',
              dispatch_events: [
                {
                  type: 'pipeline.hook.dispatch_allowed',
                  section: 'subagents',
                  candidate: 'Explore',
                  via: 'wildcard',
                  count: 2,
                },
              ],
            },
          ],
        },
      },
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('3 explicit');
    expect(html).toContain('2 via wildcard');
  });

  it('renders expanded tuples with agent, child, and via', () => {
    const run = {
      stages: {
        implement: {
          status: 'completed',
          agent: 'implementer',
          iterations: [
            {
              number: 1,
              status: 'completed',
              dispatch_events: [
                {
                  type: 'pipeline.hook.dispatch_allowed',
                  section: 'subagents',
                  candidate: 'Explore',
                  via: 'explicit',
                  count: 1,
                },
                {
                  type: 'pipeline.hook.dispatch_allowed',
                  section: 'subagents',
                  candidate: 'Plan',
                  via: 'wildcard',
                  count: 1,
                },
              ],
            },
          ],
        },
      },
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('implementer');
    expect(html).toContain('Explore');
    expect(html).toContain('Plan');
    expect(html).toContain('explicit');
    expect(html).toContain('wildcard');
  });

  it('omits counter when no allowed dispatch events exist', () => {
    const html = renderToString(runDetailView(makeRun()));
    expect(html).not.toContain('Dispatch activity:');
  });

  it('omits counter when only blocked events exist', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          dispatch_events: [
            {
              type: 'pipeline.hook.dispatch_blocked',
              section: 'subagents',
              candidate: 'general-purpose',
              reason: 'denylist',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).not.toContain('Dispatch activity:');
  });
});
