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

describe('WS log subscription for worktree-hosted runs', () => {
  let parentWorca;
  let worktreePath;
  let runId;
  let httpServer;
  let port;

  beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    parentWorca = join(tmpdir(), `worca-wtl-parent-${stamp}`, '.worca');
    worktreePath = join(tmpdir(), `worca-wtl-wt-${stamp}`);
    runId = '20260317-084204-001-aaaa';

    // Parent .worca: empty runs/, registry entry pointing at worktree
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

    // Worktree .worca: actual run dir + status + implement log
    const wtRunDir = join(worktreePath, '.worca', 'runs', runId);
    mkdirSync(join(wtRunDir, 'logs', 'implement'), { recursive: true });
    writeFileSync(join(wtRunDir, 'pipeline.pid'), String(process.pid));
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        pipeline_status: 'running',
        stage: 'implement',
        stages: { implement: { status: 'in_progress' } },
      }),
    );
    writeFileSync(
      join(wtRunDir, 'logs', 'implement', 'iter-1.log'),
      'wt-line-1\nwt-line-2\n',
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

  it('sends backfill log-bulk from the worktree run dir', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });

    ws.send(
      JSON.stringify({
        id: 'sub-1',
        type: 'subscribe-log',
        payload: { stage: 'implement', runId },
      }),
    );

    const bulk = await waitForWsEvent(
      ws,
      (m) => m.type === 'log-bulk' && m.payload?.stage === 'implement',
    );
    expect(bulk.payload.lines).toEqual(['wt-line-1', 'wt-line-2']);
    ws.close();
  });

  it('streams log-line events when worktree log file grows', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });

    ws.send(
      JSON.stringify({
        id: 'sub-1',
        type: 'subscribe-log',
        payload: { stage: 'implement', runId },
      }),
    );

    // Wait for backfill so the watcher is established.
    await waitForWsEvent(ws, (m) => m.type === 'log-bulk');

    const lineEvent = waitForWsEvent(
      ws,
      (m) => m.type === 'log-line' && m.payload?.line === 'wt-line-3',
    );

    appendFileSync(
      join(
        worktreePath,
        '.worca',
        'runs',
        runId,
        'logs',
        'implement',
        'iter-1.log',
      ),
      'wt-line-3\n',
    );

    const evt = await lineEvent;
    expect(evt.payload.stage).toBe('implement');
    ws.close();
  });
});
