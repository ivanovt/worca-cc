import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assignEventsToIterations,
  readDispatchEventsFromJsonl,
} from './dispatch-events-aggregator.js';

let root;

beforeEach(() => {
  root = join(
    tmpdir(),
    `worca-dispatch-agg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJsonl(path, entries) {
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

describe('readDispatchEventsFromJsonl', () => {
  it('returns [] when file does not exist', () => {
    const result = readDispatchEventsFromJsonl(join(root, 'missing.jsonl'));
    expect(result).toEqual([]);
  });

  it('filters to only dispatch_{allowed,blocked} events', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      {
        event_type: 'pipeline.run.started',
        timestamp: '2026-04-13T11:00:00.000Z',
        payload: {},
      },
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:01:00.000Z',
        payload: { agent: 'tester', subagent_type: 'Explore' },
      },
      {
        event_type: 'pipeline.hook.dispatch_blocked',
        timestamp: '2026-04-13T11:02:00.000Z',
        payload: {
          agent: 'tester',
          subagent_type: 'general-purpose',
          reason: 'Blocked: denylist',
        },
      },
      {
        event_type: 'pipeline.hook.blocked', // different event type — skip
        timestamp: '2026-04-13T11:03:00.000Z',
        payload: {},
      },
    ]);
    const result = readDispatchEventsFromJsonl(path);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('pipeline.hook.dispatch_allowed');
    expect(result[1].type).toBe('pipeline.hook.dispatch_blocked');
    expect(result[1].reason).toContain('denylist');
  });

  it('skips malformed JSON lines silently', () => {
    const path = join(root, 'events.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:00:00.000Z',
        payload: { subagent_type: 'Explore' },
      })}\n{not valid json\n\n`,
    );
    const result = readDispatchEventsFromJsonl(path);
    expect(result).toHaveLength(1);
  });

  it('skips dispatch events missing subagent_type', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:00:00.000Z',
        payload: { agent: 'tester' },
      },
    ]);
    const result = readDispatchEventsFromJsonl(path);
    expect(result).toEqual([]);
  });
});

describe('assignEventsToIterations', () => {
  function makeStage(started, completed, number = 1) {
    return {
      status: 'completed',
      iterations: [
        {
          number,
          started_at: started,
          completed_at: completed,
        },
      ],
    };
  }

  it('assigns events within an iteration time window', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:05:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result.implement.iterations[0].dispatch_events).toEqual([
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        count: 1,
      },
    ]);
  });

  it('drops events that fall outside any iteration window', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:05:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T12:00:00.000Z', // after iteration ended
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result.implement.iterations[0].dispatch_events).toBeUndefined();
  });

  it('treats an open iteration (no completed_at) as still-running', () => {
    const stages = {
      implement: {
        status: 'in_progress',
        iterations: [{ number: 1, started_at: '2026-04-13T11:00:00.000Z' }],
      },
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result.implement.iterations[0].dispatch_events).toHaveLength(1);
  });

  it('aggregates duplicate (type, subagent_type) with count', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:03:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result.implement.iterations[0].dispatch_events).toEqual([
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        count: 3,
      },
    ]);
  });

  it('keeps different subagent types as separate entries', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'feature-dev:code-reviewer',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    const agg = result.implement.iterations[0].dispatch_events;
    expect(agg).toHaveLength(2);
    const byType = Object.fromEntries(agg.map((e) => [e.subagent_type, e]));
    expect(byType.Explore.count).toBe(1);
    expect(byType['feature-dev:code-reviewer'].count).toBe(1);
  });

  it('keeps allowed and blocked as separate entries even for same subagent', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_blocked',
        subagent_type: 'Explore',
        reason: 'Blocked: rule mismatch',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    const agg = result.implement.iterations[0].dispatch_events;
    expect(agg).toHaveLength(2);
    expect(agg.find((e) => e.type.endsWith('allowed')).count).toBe(1);
    const blocked = agg.find((e) => e.type.endsWith('blocked'));
    expect(blocked.count).toBe(1);
    expect(blocked.reason).toBe('Blocked: rule mismatch');
  });

  it('preserves the first reason when duplicate blocked events are aggregated', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_blocked',
        subagent_type: 'general-purpose',
        reason: 'reason A',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_blocked',
        subagent_type: 'general-purpose',
        reason: 'reason B',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    const agg = result.implement.iterations[0].dispatch_events;
    expect(agg).toHaveLength(1);
    expect(agg[0].count).toBe(2);
    expect(agg[0].reason).toBe('reason A');
  });

  it('assigns events across multiple stages and iterations by timestamp', () => {
    const stages = {
      implement: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            started_at: '2026-04-13T11:00:00.000Z',
            completed_at: '2026-04-13T11:05:00.000Z',
          },
          {
            number: 2,
            started_at: '2026-04-13T11:05:30.000Z',
            completed_at: '2026-04-13T11:10:00.000Z',
          },
        ],
      },
      test: makeStage('2026-04-13T11:10:30.000Z', '2026-04-13T11:15:00.000Z'),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:02:00.000Z', // implement iter 1
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:07:00.000Z', // implement iter 2
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:12:00.000Z', // test iter 1
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result.implement.iterations[0].dispatch_events).toHaveLength(1);
    expect(result.implement.iterations[1].dispatch_events).toHaveLength(1);
    expect(result.test.iterations[0].dispatch_events).toHaveLength(1);
  });

  it('returns stages unchanged when events list is empty', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const result = assignEventsToIterations([], stages);
    expect(result).toBe(stages);
  });

  it('returns stages unchanged when no event matches any iteration', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:05:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T12:00:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result).toBe(stages);
  });

  it('handles stages with no iterations gracefully', () => {
    const stages = { implement: { status: 'pending' } };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        subagent_type: 'Explore',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result).toBe(stages);
  });
});
