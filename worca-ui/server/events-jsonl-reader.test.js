import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _clearEventsJsonlCache,
  readEventsForEnrichment,
} from './events-jsonl-reader.js';

describe('events-jsonl-reader', () => {
  let dir;
  let eventsPath;

  const writeEvents = (events) =>
    writeFileSync(
      eventsPath,
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );

  beforeEach(() => {
    dir = join(tmpdir(), `worca-events-reader-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    eventsPath = join(dir, 'events.jsonl');
    _clearEventsJsonlCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    _clearEventsJsonlCache();
  });

  it('returns empty arrays when the file is missing', () => {
    const { dispatchEvents, graphEvents } = readEventsForEnrichment(eventsPath);
    expect(dispatchEvents).toEqual([]);
    expect(graphEvents).toEqual([]);
  });

  it('returns empty arrays for null/empty path', () => {
    expect(readEventsForEnrichment('')).toEqual({
      dispatchEvents: [],
      graphEvents: [],
    });
    expect(readEventsForEnrichment(null)).toEqual({
      dispatchEvents: [],
      graphEvents: [],
    });
  });

  it('reads BOTH dispatch and graph-query events in a single pass', () => {
    writeEvents([
      { event_type: 'pipeline.run.started', timestamp: 't0', payload: {} },
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: 't1',
        payload: { section: 'subagents', candidate: 'Explore' },
      },
      {
        event_type: 'pipeline.hook.dispatch_blocked',
        timestamp: 't2',
        payload: { candidate: 'general-purpose', reason: 'denylist' },
      },
      {
        event_type: 'pipeline.hook.graph_query',
        timestamp: 't3',
        payload: { engine: 'graphify', op: 'query' },
      },
      {
        event_type: 'pipeline.hook.graph_query',
        timestamp: 't4',
        payload: { engine: 'crg', op: 'explain' },
      },
    ]);

    const { dispatchEvents, graphEvents } = readEventsForEnrichment(eventsPath);
    expect(dispatchEvents).toHaveLength(2);
    expect(dispatchEvents[0]).toMatchObject({
      type: 'pipeline.hook.dispatch_allowed',
      section: 'subagents',
      candidate: 'Explore',
    });
    expect(dispatchEvents[1]).toMatchObject({
      type: 'pipeline.hook.dispatch_blocked',
      candidate: 'general-purpose',
      reason: 'denylist',
    });
    expect(graphEvents).toHaveLength(2);
    expect(graphEvents[0]).toEqual({
      engine: 'graphify',
      op: 'query',
      timestamp: 't3',
    });
    expect(graphEvents[1]).toEqual({
      engine: 'crg',
      op: 'explain',
      timestamp: 't4',
    });
  });

  it('skips malformed lines without throwing', () => {
    writeFileSync(
      eventsPath,
      [
        'not json',
        JSON.stringify({
          event_type: 'pipeline.hook.dispatch_allowed',
          timestamp: 't1',
          payload: { candidate: 'Explore' },
        }),
        '{ broken',
        '',
      ].join('\n'),
    );
    const { dispatchEvents } = readEventsForEnrichment(eventsPath);
    expect(dispatchEvents).toHaveLength(1);
    expect(dispatchEvents[0].candidate).toBe('Explore');
  });

  it('caches by mtime+size: an unchanged file returns the same object (no re-parse)', () => {
    writeEvents([
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: 't1',
        payload: { candidate: 'Explore' },
      },
    ]);
    const first = readEventsForEnrichment(eventsPath);
    const second = readEventsForEnrichment(eventsPath);
    // Same cached reference — the file was parsed at most once.
    expect(second).toBe(first);
  });

  it('re-reads when the file changes (size/mtime key miss)', () => {
    writeEvents([
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: 't1',
        payload: { candidate: 'Explore' },
      },
    ]);
    const first = readEventsForEnrichment(eventsPath);
    expect(first.dispatchEvents).toHaveLength(1);

    // Append a second event — size changes, so the cache key misses.
    writeEvents([
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: 't1',
        payload: { candidate: 'Explore' },
      },
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: 't2',
        payload: { candidate: 'general-purpose' },
      },
    ]);
    const second = readEventsForEnrichment(eventsPath);
    expect(second).not.toBe(first);
    expect(second.dispatchEvents).toHaveLength(2);
  });
});
