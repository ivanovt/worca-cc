/**
 * Tests for T15: Expose events to worca-ui via WebSocket
 * - watchEvents() in watcher.js
 * - get-events, subscribe-events, unsubscribe-events handlers in ws.js
 * - pipeline-event broadcast
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { watchEvents } from './watcher.js';
import { attachWsServer } from './ws.js';

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForWsEvent(ws, type, predicate = null, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for WS event "${type}"`)),
      timeoutMs,
    );
    function onMessage(data) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === type && (!predicate || predicate(msg))) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

function makeEvent(event_id, event_type, run_id = 'run-123') {
  return {
    schema_version: '1',
    event_id,
    event_type,
    timestamp: new Date().toISOString(),
    run_id,
    pipeline: { branch: 'test', work_request: { title: 'test' } },
    payload: {},
  };
}

// ================================================================
// watchEvents() unit tests
// ================================================================

describe('watchEvents', () => {
  let runDir;
  const openWatchers = [];

  beforeEach(() => {
    runDir = join(
      tmpdir(),
      `worca-we-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(runDir, { recursive: true });
  });

  afterEach(async () => {
    for (const w of openWatchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    openWatchers.length = 0;
    rmSync(runDir, { recursive: true, force: true });
  });

  it('detects new lines appended to events.jsonl and invokes callback with parsed JSON', async () => {
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, ''); // Create empty file

    const received = [];
    const w = watchEvents(runDir, (event) => received.push(event));
    openWatchers.push(w);

    await waitMs(150);

    const event = makeEvent('evt-001', 'pipeline.run.started');
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);

    await waitMs(400);

    expect(received).toHaveLength(1);
    expect(received[0].event_id).toBe('evt-001');
    expect(received[0].event_type).toBe('pipeline.run.started');
  });

  it('handles file creation (file does not exist initially, then is created)', async () => {
    const eventsPath = join(runDir, 'events.jsonl');
    expect(existsSync(eventsPath)).toBe(false);

    const received = [];
    const w = watchEvents(runDir, (event) => received.push(event));
    openWatchers.push(w);

    await waitMs(150);

    // Now create the file with an event
    const event = makeEvent('evt-002', 'pipeline.stage.started');
    writeFileSync(eventsPath, `${JSON.stringify(event)}\n`);

    await waitMs(600);

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].event_id).toBe('evt-002');
  });

  it('handles malformed JSON lines gracefully (skips, does not crash)', async () => {
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, '');

    const received = [];
    const w = watchEvents(runDir, (event) => received.push(event));
    openWatchers.push(w);

    await waitMs(150);

    appendFileSync(eventsPath, 'this is not valid json\n');
    const goodEvent = makeEvent('evt-003', 'pipeline.run.completed');
    appendFileSync(eventsPath, `${JSON.stringify(goodEvent)}\n`);

    await waitMs(400);

    // Should receive only the good event — no crash
    expect(received).toHaveLength(1);
    expect(received[0].event_id).toBe('evt-003');
  });

  it('invokes callback multiple times for multiple appended events', async () => {
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, '');

    const received = [];
    const w = watchEvents(runDir, (event) => received.push(event));
    openWatchers.push(w);

    await waitMs(150);

    appendFileSync(
      eventsPath,
      `${JSON.stringify(makeEvent('e1', 'pipeline.run.started'))}\n`,
    );
    appendFileSync(
      eventsPath,
      `${JSON.stringify(makeEvent('e2', 'pipeline.stage.started'))}\n`,
    );
    appendFileSync(
      eventsPath,
      `${JSON.stringify(makeEvent('e3', 'pipeline.stage.completed'))}\n`,
    );

    await waitMs(500);

    expect(received.length).toBe(3);
    expect(received.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('close() stops watching and callback is no longer invoked', async () => {
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, '');

    const received = [];
    const w = watchEvents(runDir, (event) => received.push(event));
    // Do NOT push to openWatchers — we close manually

    await waitMs(150);

    w.close();

    await waitMs(50);

    appendFileSync(
      eventsPath,
      JSON.stringify(makeEvent('evt-after-close', 'pipeline.run.started')) +
        '\n',
    );

    await waitMs(400);

    expect(received).toHaveLength(0);
  });
});

// ================================================================
// get-events WebSocket handler
// ================================================================

describe('get-events WebSocket handler', () => {
  let worcaDir;
  let httpServer;
  let port;

  beforeEach(async () => {
    worcaDir = join(
      tmpdir(),
      `worca-ge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(worcaDir, { recursive: true });
    httpServer = createServer();
    attachWsServer(httpServer, {
      worcaDir,
      settingsPath: join(worcaDir, 'settings.json'),
      prefsPath: join(worcaDir, 'prefs.json'),
    });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    rmSync(worcaDir, { recursive: true, force: true });
  });

  function makeEventsFile(runId, events) {
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const content = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(join(runDir, 'events.jsonl'), content);
    return runDir;
  }

  async function connect() {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return ws;
  }

  it('returns all events when no filters applied', async () => {
    const runId = `run-${Date.now()}`;
    const events = [
      makeEvent('e1', 'pipeline.run.started', runId),
      makeEvent('e2', 'pipeline.stage.started', runId),
    ];
    makeEventsFile(runId, events);

    const ws = await connect();
    ws.send(
      JSON.stringify({ id: 'req-all', type: 'get-events', payload: { runId } }),
    );

    const msg = await waitForWsEvent(ws, 'get-events', null, 2000);
    expect(msg.ok).toBe(true);
    expect(msg.payload.events).toHaveLength(2);
    ws.close();
  });

  it('returns events after since_event_id (exclusive)', async () => {
    const runId = `run-${Date.now()}`;
    const events = [
      makeEvent('evt-a1', 'pipeline.run.started', runId),
      makeEvent('evt-a2', 'pipeline.stage.started', runId),
      makeEvent('evt-a3', 'pipeline.stage.completed', runId),
    ];
    makeEventsFile(runId, events);

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-1',
        type: 'get-events',
        payload: { runId, since_event_id: 'evt-a1' },
      }),
    );

    const msg = await waitForWsEvent(ws, 'get-events', null, 2000);
    expect(msg.ok).toBe(true);
    expect(msg.payload.events.map((e) => e.event_id)).toEqual([
      'evt-a2',
      'evt-a3',
    ]);
    ws.close();
  });

  it('returns events filtered by event_types glob patterns', async () => {
    const runId = `run-${Date.now()}`;
    const events = [
      makeEvent('evt-b1', 'pipeline.run.started', runId),
      makeEvent('evt-b2', 'pipeline.stage.started', runId),
      makeEvent('evt-b3', 'pipeline.stage.completed', runId),
      makeEvent('evt-b4', 'pipeline.run.completed', runId),
    ];
    makeEventsFile(runId, events);

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-2',
        type: 'get-events',
        payload: { runId, event_types: ['pipeline.stage.*'] },
      }),
    );

    const msg = await waitForWsEvent(ws, 'get-events', null, 2000);
    expect(msg.ok).toBe(true);
    expect(msg.payload.events.map((e) => e.event_id)).toEqual([
      'evt-b2',
      'evt-b3',
    ]);
    ws.close();
  });

  it('event_types glob with ** matches across segments', async () => {
    const runId = `run-${Date.now()}`;
    const events = [
      makeEvent('p1', 'pipeline.run.started', runId),
      makeEvent('p2', 'pipeline.stage.started', runId),
      makeEvent('p3', 'pipeline.run.completed', runId),
      makeEvent('c1', 'control.pipeline.abort', runId),
    ];
    makeEventsFile(runId, events);

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-glob2',
        type: 'get-events',
        payload: { runId, event_types: ['pipeline.**'] },
      }),
    );

    const msg = await waitForWsEvent(ws, 'get-events', null, 2000);
    expect(msg.ok).toBe(true);
    const ids = msg.payload.events.map((e) => e.event_id);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
    expect(ids).toContain('p3');
    expect(ids).not.toContain('c1');
    ws.close();
  });

  it('respects limit parameter', async () => {
    const runId = `run-${Date.now()}`;
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent(`evt-c${i + 1}`, 'pipeline.stage.started', runId),
    );
    makeEventsFile(runId, events);

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-3',
        type: 'get-events',
        payload: { runId, limit: 3 },
      }),
    );

    const msg = await waitForWsEvent(ws, 'get-events', null, 2000);
    expect(msg.ok).toBe(true);
    expect(msg.payload.events).toHaveLength(3);
    ws.close();
  });

  it('returns empty array when no events.jsonl exists', async () => {
    const runId = `run-${Date.now()}`;
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    // No events.jsonl

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-empty',
        type: 'get-events',
        payload: { runId },
      }),
    );

    const msg = await waitForWsEvent(ws, 'get-events', null, 2000);
    expect(msg.ok).toBe(true);
    expect(msg.payload.events).toEqual([]);
    ws.close();
  });

  it('returns error when runId is missing', async () => {
    const ws = await connect();
    ws.send(
      JSON.stringify({ id: 'req-no-id', type: 'get-events', payload: {} }),
    );

    const msg = await waitForWsEvent(ws, 'get-events', null, 2000);
    expect(msg.ok).toBe(false);
    expect(msg.error.code).toBe('bad_request');
    ws.close();
  });
});

// ================================================================
// subscribe-events / unsubscribe-events
// ================================================================

describe('subscribe-events / unsubscribe-events', () => {
  let worcaDir;
  let httpServer;
  let port;

  beforeEach(async () => {
    worcaDir = join(
      tmpdir(),
      `worca-se-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(worcaDir, { recursive: true });
    httpServer = createServer();
    attachWsServer(httpServer, {
      worcaDir,
      settingsPath: join(worcaDir, 'settings.json'),
      prefsPath: join(worcaDir, 'prefs.json'),
    });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    rmSync(worcaDir, { recursive: true, force: true });
  });

  async function connect() {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return ws;
  }

  it('subscribe-events returns ok acknowledgement', async () => {
    const runId = `run-${Date.now()}`;
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-sub',
        type: 'subscribe-events',
        payload: { runId },
      }),
    );

    const msg = await waitForWsEvent(ws, 'subscribe-events', null, 2000);
    expect(msg.ok).toBe(true);
    expect(msg.payload.subscribed).toBe(true);
    ws.close();
  });

  it('subscribe-events returns error when runId is missing', async () => {
    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-no-id',
        type: 'subscribe-events',
        payload: {},
      }),
    );

    const msg = await waitForWsEvent(ws, 'subscribe-events', null, 2000);
    expect(msg.ok).toBe(false);
    ws.close();
  });

  it('starts broadcasting pipeline-event messages after subscribe-events', async () => {
    const runId = `run-${Date.now()}`;
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, '');

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-sub1',
        type: 'subscribe-events',
        payload: { runId },
      }),
    );
    await waitForWsEvent(ws, 'subscribe-events', null, 1000);

    await waitMs(200); // let watcher settle

    const event = makeEvent('evt-live1', 'pipeline.stage.started', runId);
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);

    const msg = await waitForWsEvent(ws, 'pipeline-event', null, 3000);
    expect(msg.payload.event_id).toBe('evt-live1');
    expect(msg.payload.event_type).toBe('pipeline.stage.started');
    ws.close();
  });

  it('pipeline-event messages contain the full event envelope', async () => {
    const runId = `run-${Date.now()}`;
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, '');

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-sub2',
        type: 'subscribe-events',
        payload: { runId },
      }),
    );
    await waitForWsEvent(ws, 'subscribe-events', null, 1000);

    await waitMs(200);

    const event = {
      schema_version: '1',
      event_id: 'evt-full',
      event_type: 'pipeline.run.completed',
      timestamp: '2026-03-20T08:00:00Z',
      run_id: runId,
      pipeline: { branch: 'main', work_request: { title: 'test' } },
      payload: { duration_ms: 1000 },
    };
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);

    const msg = await waitForWsEvent(ws, 'pipeline-event', null, 3000);
    expect(msg.payload.schema_version).toBe('1');
    expect(msg.payload.event_id).toBe('evt-full');
    expect(msg.payload.event_type).toBe('pipeline.run.completed');
    expect(msg.payload.pipeline).toBeDefined();
    expect(msg.payload.payload).toEqual({ duration_ms: 1000 });
    ws.close();
  });

  it('unsubscribe-events returns ok acknowledgement', async () => {
    const runId = `run-${Date.now()}`;
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-sub3',
        type: 'subscribe-events',
        payload: { runId },
      }),
    );
    await waitForWsEvent(ws, 'subscribe-events', null, 1000);

    ws.send(
      JSON.stringify({
        id: 'req-unsub',
        type: 'unsubscribe-events',
        payload: {},
      }),
    );
    const unsubMsg = await waitForWsEvent(ws, 'unsubscribe-events', null, 1000);
    expect(unsubMsg.ok).toBe(true);
    expect(unsubMsg.payload.unsubscribed).toBe(true);
    ws.close();
  });

  it('unsubscribe-events stops broadcasting pipeline-event messages', async () => {
    const runId = `run-${Date.now()}`;
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, '');

    const ws = await connect();
    ws.send(
      JSON.stringify({
        id: 'req-sub4',
        type: 'subscribe-events',
        payload: { runId },
      }),
    );
    await waitForWsEvent(ws, 'subscribe-events', null, 1000);

    await waitMs(200);

    ws.send(
      JSON.stringify({
        id: 'req-unsub2',
        type: 'unsubscribe-events',
        payload: {},
      }),
    );
    await waitForWsEvent(ws, 'unsubscribe-events', null, 1000);

    // After unsubscribe, no pipeline-event messages should arrive
    const pipelineEvents = [];
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'pipeline-event') pipelineEvents.push(m);
    });

    appendFileSync(
      eventsPath,
      `${JSON.stringify(
        makeEvent('evt-after-unsub', 'pipeline.run.started', runId),
      )}\n`,
    );

    await waitMs(500);
    expect(pipelineEvents).toHaveLength(0);
    ws.close();
  });

  it('only sends pipeline-event to the subscribed client, not all clients', async () => {
    const runId1 = `run-a-${Date.now()}`;
    const runId2 = `run-b-${Date.now()}`;

    const runDir1 = join(worcaDir, 'runs', runId1);
    const runDir2 = join(worcaDir, 'runs', runId2);
    mkdirSync(runDir1, { recursive: true });
    mkdirSync(runDir2, { recursive: true });
    const eventsPath1 = join(runDir1, 'events.jsonl');
    writeFileSync(eventsPath1, '');

    const ws1 = await connect();
    const ws2 = await connect();

    // ws1 subscribes to runId1, ws2 subscribes to runId2
    ws1.send(
      JSON.stringify({
        id: 'sub-a',
        type: 'subscribe-events',
        payload: { runId: runId1 },
      }),
    );
    ws2.send(
      JSON.stringify({
        id: 'sub-b',
        type: 'subscribe-events',
        payload: { runId: runId2 },
      }),
    );
    await Promise.all([
      waitForWsEvent(ws1, 'subscribe-events', null, 1000),
      waitForWsEvent(ws2, 'subscribe-events', null, 1000),
    ]);

    await waitMs(200);

    const ws2Events = [];
    ws2.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'pipeline-event') ws2Events.push(m);
    });

    // Only write to runId1's events file
    appendFileSync(
      eventsPath1,
      JSON.stringify(makeEvent('evt-r1', 'pipeline.run.started', runId1)) +
        '\n',
    );

    // ws1 should receive the event
    await waitForWsEvent(ws1, 'pipeline-event', null, 3000);

    await waitMs(300);
    // ws2 should NOT receive it
    expect(ws2Events).toHaveLength(0);

    ws1.close();
    ws2.close();
  });
});
