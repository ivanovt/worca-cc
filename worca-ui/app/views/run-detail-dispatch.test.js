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
        subagent_type: 'Explore',
      },
    ]);
    const html = renderToString(runDetailView(run));
    expect(html).toContain('dispatch-events-strip');
    expect(html).toContain('variant="success"');
    expect(html).toContain('Explore dispatched');
  });

  it('renders dispatch blocked events as short red badge with reason in tooltip', () => {
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
    // Reason is in the title tooltip, not in the visible badge text
    expect(html).toContain('title="tester cannot dispatch general-purpose"');
    expect(html).not.toContain(
      'general-purpose blocked — tester cannot dispatch general-purpose',
    );
  });

  it('renders multiple dispatch events for same iteration', () => {
    const run = makeRunWithDispatchEvents([
      {
        type: 'pipeline.hook.dispatch_allowed',
        agent: 'tester',
        subagent_type: 'Explore',
      },
      {
        type: 'pipeline.hook.dispatch_blocked',
        agent: 'tester',
        subagent_type: 'general-purpose',
        reason: 'blocked by denylist',
      },
    ]);
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Explore dispatched');
    expect(html).toContain('general-purpose blocked');
  });

  it('renders nothing when no dispatch events', () => {
    const run = makeRunWithDispatchEvents([]);
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('dispatch-events-strip');
  });

  it('renders ×N suffix when count > 1 on allowed events', () => {
    const run = makeRunWithDispatchEvents([
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        count: 5,
      },
    ]);
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Explore dispatched (×5)');
  });

  it('renders ×N suffix when count > 1 on blocked events, reason in tooltip only', () => {
    const run = makeRunWithDispatchEvents([
      {
        type: 'pipeline.hook.dispatch_blocked',
        subagent_type: 'general-purpose',
        reason: 'blocked by denylist',
        count: 3,
      },
    ]);
    const html = renderToString(runDetailView(run));
    expect(html).toContain('general-purpose blocked (×3)');
    expect(html).toContain('title="blocked by denylist"');
    expect(html).not.toContain('general-purpose blocked (×3) —');
  });

  it('omits the suffix when count is 1, absent, or invalid', () => {
    const run = makeRunWithDispatchEvents([
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'one',
        count: 1,
      },
      { type: 'pipeline.hook.dispatch_allowed', subagent_type: 'two' },
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'three',
        count: 0,
      },
    ]);
    const html = renderToString(runDetailView(run));
    expect(html).toContain('one dispatched');
    expect(html).not.toContain('one dispatched (×');
    expect(html).toContain('two dispatched');
    expect(html).not.toContain('two dispatched (×');
    expect(html).toContain('three dispatched');
    expect(html).not.toContain('three dispatched (×');
  });
});
