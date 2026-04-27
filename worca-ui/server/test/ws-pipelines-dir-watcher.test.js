import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachWsServer } from '../ws.js';

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

describe('ws-status-watcher – pipelines.d/ directory watcher', () => {
  let worcaDir;
  let worktreeDir;
  let httpServer;
  let port;

  beforeEach(async () => {
    worcaDir = join(
      tmpdir(),
      `worca-pipd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    worktreeDir = join(
      tmpdir(),
      `worca-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(worcaDir, 'runs'), { recursive: true });
    mkdirSync(join(worcaDir, 'multi', 'pipelines.d'), { recursive: true });
    mkdirSync(join(worktreeDir, '.worca', 'runs'), { recursive: true });

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
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('broadcasts runs-list when a new entry is added to pipelines.d/', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const runId = `run-${Date.now()}`;
    const wtRunDir = join(worktreeDir, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        pipeline_status: 'running',
        stages: { plan: { status: 'running' } },
      }),
    );

    // Adding a pipelines.d/ entry should trigger scheduleRefresh
    writeFileSync(
      join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify({
        run_id: runId,
        worktree_path: worktreeDir,
        title: 'Test worktree run',
        pid: process.pid,
        status: 'running',
      }),
    );

    const msg = await waitForWsEvent(
      ws,
      'runs-list',
      (m) =>
        Array.isArray(m.payload?.runs) &&
        m.payload.runs.some((r) => r.run_id === runId || r.id === runId),
      3000,
    );
    expect(
      msg.payload.runs.some((r) => r.run_id === runId || r.id === runId),
    ).toBe(true);
    ws.close();
  });

  it('broadcasts runs-list when a worktree run status.json changes', async () => {
    const runId = `run-wt-${Date.now()}`;
    const wtRunDir = join(worktreeDir, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        pipeline_status: 'running',
        stages: { plan: { status: 'running' } },
      }),
    );

    // Register the worktree pipeline before starting the server client
    writeFileSync(
      join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify({
        run_id: runId,
        worktree_path: worktreeDir,
        title: 'Test worktree run',
        pid: process.pid,
        status: 'running',
      }),
    );

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Wait for the initial scheduleRefresh (triggered by pipelines.d/ watcher) and
    // per-worktree watcher to be established via reconcileWorktreeWatchers
    await waitMs(400);

    // Update the worktree run's status — per-worktree watcher should fire scheduleRefresh
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        pipeline_status: 'completed',
        completed_at: new Date().toISOString(),
        stages: { plan: { status: 'completed' } },
      }),
    );

    const msg = await waitForWsEvent(ws, 'runs-list', null, 3000);
    expect(msg.payload.runs).toBeDefined();
    ws.close();
  });

  it('does not broadcast stale data for a removed pipelines.d/ entry', async () => {
    const runId = `run-removed-${Date.now()}`;
    const wtRunDir = join(worktreeDir, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        pipeline_status: 'running',
        stages: { plan: { status: 'running' } },
      }),
    );

    const regPath = join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`);
    writeFileSync(
      regPath,
      JSON.stringify({
        run_id: runId,
        worktree_path: worktreeDir,
        title: 'Test run to be removed',
        pid: process.pid,
        status: 'running',
      }),
    );

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Wait for initial watcher setup
    await waitMs(300);

    // Remove the registry entry
    rmSync(regPath);

    // The removal should trigger a scheduleRefresh → runs-list without the removed run
    const msg = await waitForWsEvent(ws, 'runs-list', null, 3000);
    expect(msg.payload.runs).toBeDefined();
    expect(
      msg.payload.runs.every((r) => r.run_id !== runId && r.id !== runId),
    ).toBe(true);
    ws.close();
  });
});
