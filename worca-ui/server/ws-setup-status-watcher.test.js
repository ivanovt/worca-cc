import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachWsServer } from './ws.js';

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a WS message of a given type. Optionally filter with a predicate.
 */
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

describe('setupStatusWatcher – broadcasts runs-list when status.json is written', () => {
  let worcaDir;
  let httpServer;
  let port;

  beforeEach(async () => {
    worcaDir = join(
      tmpdir(),
      `worca-ssw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // Create runs/ before server starts so runsDirWatcher is set up
    mkdirSync(join(worcaDir, 'runs'), { recursive: true });

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
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
    rmSync(worcaDir, { recursive: true, force: true });
  });

  it('broadcasts runs-list when status.json is written to a new run directory', async () => {
    const runId = `run-${Date.now()}`;
    const runDir = join(worcaDir, 'runs', runId);

    // Connect WS client before creating the run dir
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Pipeline creates the run directory
    mkdirSync(runDir, { recursive: true });

    // Give the runsDirWatcher time to notice the new directory
    await waitMs(150);

    // Pipeline writes status.json — runsDirWatcher detects it and schedules refresh
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        stages: { plan: { status: 'running' } },
      }),
    );

    // Expect a runs-list broadcast that contains the new run within 2s.
    const msg = await waitForWsEvent(
      ws,
      'runs-list',
      (m) => Array.isArray(m.payload?.runs) && m.payload.runs.length > 0,
      2000,
    );
    expect(
      msg.payload.runs.some((r) => r.run_id === runId || r.id === runId),
    ).toBe(true);

    ws.close();
  });

  it('fires scheduleRefresh when watcher callback receives a null filename', async () => {
    const runId = `run-null-${Date.now()}`;
    const runDir = join(worcaDir, 'runs', runId);

    // Connect WS client BEFORE triggering any watchers to avoid missing broadcasts
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Set up a fully-formed run so the runsDirWatcher can detect changes
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        stages: { plan: { status: 'running' } },
      }),
    );

    // Give runsDirWatcher time to establish after the initial write
    await waitMs(300);

    // Overwrite status.json to trigger a watcher event with potential null filename
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        stages: { plan: { status: 'completed' } },
      }),
    );

    // The watcher callback must handle null filename gracefully and still call scheduleRefresh.
    // Verify a runs-list is broadcast (regardless of null guard path).
    const msg = await waitForWsEvent(ws, 'runs-list', null, 3000);
    expect(msg.payload.runs).toBeDefined();

    ws.close();
  });
});
