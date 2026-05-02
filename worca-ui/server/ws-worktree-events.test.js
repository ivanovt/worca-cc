import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachWsServer } from './ws.js';

function waitForWsEvent(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for WS event'));
    }, timeoutMs);
    function onMessage(data) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

describe('WS event subscription for worktree-hosted runs', () => {
  let parentWorca;
  let worktreePath;
  let runId;
  let httpServer;
  let port;

  beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    parentWorca = join(tmpdir(), `worca-wte-parent-${stamp}`, '.worca');
    worktreePath = join(tmpdir(), `worca-wte-wt-${stamp}`);
    runId = '20260317-084204-001-evts';

    // Parent .worca: registry entry pointing at worktree
    mkdirSync(join(parentWorca, 'multi', 'pipelines.d'), { recursive: true });
    writeFileSync(
      join(parentWorca, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify({
        run_id: runId,
        worktree_path: worktreePath,
        pid: process.pid,
        status: 'running',
      }),
    );

    // Worktree .worca: actual run dir + status + empty events.jsonl
    const wtRunDir = join(worktreePath, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(join(wtRunDir, 'pipeline.pid'), String(process.pid));
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        pipeline_status: 'running',
        stage: 'implement',
        stages: {},
      }),
    );
    writeFileSync(
      join(wtRunDir, 'events.jsonl'),
      `${JSON.stringify({
        schema_version: '1',
        event_id: 'evt-1',
        event_type: 'pipeline.run.started',
        timestamp: '2026-03-17T08:42:04Z',
        run_id: runId,
        payload: {},
      })}\n`,
    );

    httpServer = createServer();
    attachWsServer(httpServer, {
      worcaDir: parentWorca,
      settingsPath: join(parentWorca, '..', '.claude', 'settings.json'),
      prefsPath: join(parentWorca, 'prefs.json'),
    });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    rmSync(join(parentWorca, '..'), { recursive: true, force: true });
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('streams pipeline-event when worktree events.jsonl gets a new line', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });

    // First subscribe to events for this runId — establishes the file watcher
    ws.send(
      JSON.stringify({
        id: 'sub-1',
        type: 'subscribe-events',
        payload: { runId },
      }),
    );

    // Wait briefly for the watcher to come up
    await new Promise((r) => setTimeout(r, 400));

    const eventPromise = waitForWsEvent(
      ws,
      (m) =>
        m.type === 'pipeline-event' &&
        m.payload?.event_type === 'pipeline.stage.started',
    );

    // Append a new event to the worktree's events.jsonl
    appendFileSync(
      join(worktreePath, '.worca', 'runs', runId, 'events.jsonl'),
      `${JSON.stringify({
        schema_version: '1',
        event_id: 'evt-2',
        event_type: 'pipeline.stage.started',
        timestamp: '2026-03-17T08:42:05Z',
        run_id: runId,
        payload: { stage: 'plan' },
      })}\n`,
    );

    const evt = await eventPromise;
    expect(evt.payload.run_id).toBe(runId);
    ws.close();
  });
});
