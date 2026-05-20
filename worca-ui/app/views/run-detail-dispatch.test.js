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

  it('renders subagent dispatches under a Subagents: label', () => {
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
    expect(html).toContain('Subagents:');
    expect(html).not.toContain('Skills:');
    expect(html).toContain('Explore dispatched');
    expect(html).toContain('variant="success"');
  });

  it('renders blocked subagent dispatch with tooltip and Subagents: label', () => {
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
    expect(html).toContain('Subagents:');
    expect(html).toContain('general-purpose blocked (×2)');
    // PR B tooltip composition: section/via/reason joined by " · "
    expect(html).toMatch(/title="[^"]*denylist[^"]*"/);
    expect(html).toMatch(/title="[^"]*section: subagents[^"]*"/);
  });

  it('renders skill dispatches under a Skills: label (per-section row)', () => {
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
    expect(html).toContain('Skills:');
    expect(html).not.toContain('Subagents:');
    expect(html).toContain('review dispatched');
    expect(html).toContain('variant="success"');
  });

  it('splits mixed dispatches into separate Subagents: and Skills: rows', () => {
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
              candidate: 'simplify',
              via: 'explicit',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Subagents:');
    expect(html).toContain('Skills:');
    expect(html).toContain('data-dispatch-section="subagents"');
    expect(html).toContain('data-dispatch-section="skills"');
    expect(html).toContain('Explore dispatched');
    expect(html).toContain('simplify dispatched');
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
    expect(html).not.toContain('Subagents:');
    expect(html).not.toContain('Skills:');
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
    expect(html).toContain('Subagents:');
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

describe('overview no longer shows the redundant hero "Dispatch activity" counter', () => {
  it('does NOT render a Dispatch activity panel above the stage timeline', () => {
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
    // The hero counter was removed — per-section iteration rows now carry
    // the same information without duplicating it in the overview.
    expect(html).not.toContain('Dispatch activity:');
    expect(html).not.toContain('dispatch-activity-counter');
    expect(html).not.toContain('dispatch-activity-tuples');
  });

  it('per-iteration Subagents/Skills rows still carry the counts', () => {
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
              section: 'skills',
              candidate: 'simplify',
              via: 'explicit',
              count: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('Subagents:');
    expect(html).toContain('Skills:');
    expect(html).toContain('Explore dispatched (×3)');
    expect(html).toContain('simplify dispatched');
  });

  // Kept here so future regressions that try to re-introduce the hero
  // counter trip a test rather than slip through review.
  it('synthetic placeholder so the suite keeps a recognizable name', () => {
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
