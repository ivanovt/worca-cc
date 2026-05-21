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
        payload: {
          agent: 'tester',
          section: 'subagents',
          candidate: 'Explore',
          via: 'explicit',
        },
      },
      {
        event_type: 'pipeline.hook.dispatch_blocked',
        timestamp: '2026-04-13T11:02:00.000Z',
        payload: {
          agent: 'tester',
          section: 'subagents',
          candidate: 'general-purpose',
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
    expect(result[0].section).toBe('subagents');
    expect(result[0].candidate).toBe('Explore');
    expect(result[0].via).toBe('explicit');
    expect(result[1].type).toBe('pipeline.hook.dispatch_blocked');
    expect(result[1].section).toBe('subagents');
    expect(result[1].candidate).toBe('general-purpose');
    expect(result[1].reason).toContain('denylist');
    expect(result[1].via).toBeUndefined();
  });

  it('skips malformed JSON lines silently', () => {
    const path = join(root, 'events.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:00:00.000Z',
        payload: { section: 'subagents', candidate: 'Explore' },
      })}\n{not valid json\n\n`,
    );
    const result = readDispatchEventsFromJsonl(path);
    expect(result).toHaveLength(1);
  });

  it('handles skill dispatches via the unified shape with section discriminator', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:01:00.000Z',
        payload: {
          agent: 'implementer',
          section: 'skills',
          candidate: 'review',
          via: 'explicit',
        },
      },
      {
        event_type: 'pipeline.hook.dispatch_blocked',
        timestamp: '2026-04-13T11:02:00.000Z',
        payload: {
          agent: 'implementer',
          section: 'skills',
          candidate: 'worca-install',
          reason: 'always_disallowed',
        },
      },
    ]);
    const result = readDispatchEventsFromJsonl(path);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('pipeline.hook.dispatch_allowed');
    expect(result[0].section).toBe('skills');
    expect(result[0].candidate).toBe('review');
    expect(result[0].via).toBe('explicit');
    expect(result[1].type).toBe('pipeline.hook.dispatch_blocked');
    expect(result[1].section).toBe('skills');
    expect(result[1].candidate).toBe('worca-install');
    expect(result[1].reason).toBe('always_disallowed');
  });

  it('skips dispatch events missing candidate', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:00:00.000Z',
        payload: { agent: 'tester', section: 'subagents' },
      },
    ]);
    const result = readDispatchEventsFromJsonl(path);
    expect(result).toEqual([]);
  });

  it('defaults missing section to "subagents" for backward read compatibility', () => {
    // Hooks always emit section now, but older event logs from pre-PR-D runs
    // may lack the field. Default to "subagents" so the legacy entries render.
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:00:00.000Z',
        payload: { agent: 'tester', candidate: 'Explore', via: 'explicit' },
      },
    ]);
    const result = readDispatchEventsFromJsonl(path);
    expect(result).toHaveLength(1);
    expect(result[0].section).toBe('subagents');
  });

  it('drops legacy skill_* event types (PR D — unified to dispatch_*)', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      {
        event_type: 'pipeline.hook.skill_allowed',
        timestamp: '2026-04-13T11:01:00.000Z',
        payload: { agent: 'implementer', skill: 'review', via: 'explicit' },
      },
      {
        event_type: 'pipeline.hook.skill_blocked',
        timestamp: '2026-04-13T11:02:00.000Z',
        payload: { agent: 'implementer', skill: 'init', reason: 'denied' },
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
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result.implement.iterations[0].dispatch_events).toEqual([
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
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
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T12:00:00.000Z',
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
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result.implement.iterations[0].dispatch_events).toHaveLength(1);
  });

  it('aggregates duplicate (type, section, candidate) with count', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:03:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result.implement.iterations[0].dispatch_events).toEqual([
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        count: 3,
      },
    ]);
  });

  it('keeps different candidates as separate entries', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'feature-dev:code-reviewer',
        via: 'explicit',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    const agg = result.implement.iterations[0].dispatch_events;
    expect(agg).toHaveLength(2);
    const byCandidate = Object.fromEntries(agg.map((e) => [e.candidate, e]));
    expect(byCandidate.Explore.count).toBe(1);
    expect(byCandidate['feature-dev:code-reviewer'].count).toBe(1);
  });

  it('keeps the same candidate name in two sections as separate entries (PR D)', () => {
    // Synthetic case: a subagent and a skill share a name. The dedup key
    // must include section so the two entries don't collide.
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'review',
        via: 'explicit',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'skills',
        candidate: 'review',
        via: 'explicit',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    const agg = result.implement.iterations[0].dispatch_events;
    expect(agg).toHaveLength(2);
    const sections = agg.map((e) => e.section).sort();
    expect(sections).toEqual(['skills', 'subagents']);
  });

  it('keeps allowed and blocked as separate entries even for same candidate', () => {
    const stages = {
      implement: makeStage(
        '2026-04-13T11:00:00.000Z',
        '2026-04-13T11:10:00.000Z',
      ),
    };
    const events = [
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_blocked',
        section: 'subagents',
        candidate: 'Explore',
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
        section: 'subagents',
        candidate: 'general-purpose',
        reason: 'reason A',
        timestamp: '2026-04-13T11:01:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_blocked',
        section: 'subagents',
        candidate: 'general-purpose',
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
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:07:00.000Z',
      },
      {
        type: 'pipeline.hook.dispatch_allowed',
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:12:00.000Z',
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
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
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
        section: 'subagents',
        candidate: 'Explore',
        via: 'explicit',
        timestamp: '2026-04-13T11:02:00.000Z',
      },
    ];
    const result = assignEventsToIterations(events, stages);
    expect(result).toBe(stages);
  });
});
