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

function makeRunWithDispatchEvents(dispatchEvents) {
  return {
    stages: {
      implement: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            outcome: 'success',
            dispatch_events: dispatchEvents,
          },
        ],
      },
    },
  };
}

describe('_dispatchEventsView', () => {
  it('renders dispatch allowed events as green badge', () => {
    const run = makeRunWithDispatchEvents([
      {
        type: 'pipeline.hook.dispatch_allowed',
        agent: 'tester',
        subagent_type: 'explore',
      },
    ]);
    const html = renderToString(runDetailView(run));
    expect(html).toContain('dispatch-events-strip');
    expect(html).toContain('variant="success"');
    expect(html).toContain('explore dispatched');
  });

  it('renders dispatch blocked events as red badge with reason', () => {
    const run = makeRunWithDispatchEvents([
      {
        type: 'pipeline.hook.dispatch_blocked',
        agent: 'tester',
        subagent_type: 'general-purpose',
        reason: 'tester cannot dispatch general-purpose',
      },
    ]);
    const html = renderToString(runDetailView(run));
    expect(html).toContain('dispatch-events-strip');
    expect(html).toContain('variant="danger"');
    expect(html).toContain('general-purpose blocked');
    expect(html).toContain('tester cannot dispatch general-purpose');
  });

  it('renders multiple dispatch events for same iteration', () => {
    const run = makeRunWithDispatchEvents([
      {
        type: 'pipeline.hook.dispatch_allowed',
        agent: 'tester',
        subagent_type: 'explore',
      },
      {
        type: 'pipeline.hook.dispatch_blocked',
        agent: 'tester',
        subagent_type: 'general-purpose',
        reason: 'blocked by denylist',
      },
    ]);
    const html = renderToString(runDetailView(run));
    expect(html).toContain('explore dispatched');
    expect(html).toContain('general-purpose blocked');
  });

  it('renders nothing when no dispatch events', () => {
    const run = makeRunWithDispatchEvents([]);
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('dispatch-events-strip');
  });
});
