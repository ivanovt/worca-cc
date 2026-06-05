import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assignGraphQueryCountsToIterations,
  readGraphQueryEventsFromJsonl,
} from './graph-query-aggregator.js';

let root;

beforeEach(() => {
  root = join(
    tmpdir(),
    `worca-graphq-agg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJsonl(path, entries) {
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

function gq(engine, op, timestamp) {
  return {
    event_type: 'pipeline.hook.graph_query',
    timestamp,
    payload: { engine, op },
  };
}

describe('readGraphQueryEventsFromJsonl', () => {
  it('returns [] when file does not exist', () => {
    expect(readGraphQueryEventsFromJsonl(join(root, 'nope.jsonl'))).toEqual([]);
  });

  it('reads only graph_query events with a valid engine', () => {
    const p = join(root, 'events.jsonl');
    writeJsonl(p, [
      gq('crg', 'query_graph_tool', '2026-06-06T00:00:01Z'),
      gq('graphify', 'query', '2026-06-06T00:00:02Z'),
      { event_type: 'pipeline.hook.dispatch_allowed', payload: {} },
      gq('bogus', 'x', '2026-06-06T00:00:03Z'),
      'not json',
    ]);
    const out = readGraphQueryEventsFromJsonl(p);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      engine: 'crg',
      op: 'query_graph_tool',
      timestamp: '2026-06-06T00:00:01Z',
    });
    expect(out[1].engine).toBe('graphify');
  });
});

describe('assignGraphQueryCountsToIterations', () => {
  function runningStages() {
    return {
      plan: {
        iterations: [
          { number: 1, started_at: '2026-06-06T00:00:00Z' }, // no completed_at → running
        ],
      },
    };
  }

  it('counts live queries onto a running iteration by engine', () => {
    const events = [
      {
        engine: 'crg',
        op: 'query_graph_tool',
        timestamp: '2026-06-06T00:00:05Z',
      },
      {
        engine: 'crg',
        op: 'query_graph_tool',
        timestamp: '2026-06-06T00:00:06Z',
      },
      {
        engine: 'crg',
        op: 'list_communities_tool',
        timestamp: '2026-06-06T00:00:07Z',
      },
      { engine: 'graphify', op: 'query', timestamp: '2026-06-06T00:00:08Z' },
    ];
    const out = assignGraphQueryCountsToIterations(events, runningStages());
    const iter = out.plan.iterations[0];
    expect(iter.graphify_invocations).toBe(1);
    expect(iter.crg_invocations).toBe(3);
    expect(iter.crg_tool_counts).toEqual({
      query_graph_tool: 2,
      list_communities_tool: 1,
    });
  });

  it('does NOT clobber a completed iteration with the runner count', () => {
    const stages = {
      plan: {
        iterations: [
          {
            number: 1,
            started_at: '2026-06-06T00:00:00Z',
            completed_at: '2026-06-06T00:01:00Z',
            crg_invocations: 38, // authoritative runner tally
            graphify_invocations: 0,
          },
        ],
      },
    };
    const events = [
      {
        engine: 'crg',
        op: 'query_graph_tool',
        timestamp: '2026-06-06T00:00:05Z',
      },
    ];
    const out = assignGraphQueryCountsToIterations(events, stages);
    // Unchanged — the completed iteration keeps the runner's number.
    expect(out.plan.iterations[0].crg_invocations).toBe(38);
  });

  it('ignores events outside the iteration window', () => {
    const events = [
      { engine: 'crg', op: 'q', timestamp: '2025-01-01T00:00:00Z' }, // before start
    ];
    const out = assignGraphQueryCountsToIterations(events, runningStages());
    expect(out.plan.iterations[0].crg_invocations).toBeUndefined();
  });

  it('is a no-op for empty events', () => {
    const stages = runningStages();
    expect(assignGraphQueryCountsToIterations([], stages)).toBe(stages);
  });
});
