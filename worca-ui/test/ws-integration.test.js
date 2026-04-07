import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachWsServer } from '../server/ws.js';

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

function sendAndReceive(ws, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    ws.send(JSON.stringify(msg));
  });
}

describe('WebSocket integration', () => {
  let server, port, dir, prefsPath;

  beforeEach(async () => {
    dir = join(tmpdir(), `worca-ws-test-${Date.now()}`);
    mkdirSync(join(dir, 'worca'), { recursive: true });
    mkdirSync(join(dir, 'worca', 'results'), { recursive: true });
    prefsPath = join(dir, 'preferences.json');

    server = createServer();
    attachWsServer(server, {
      worcaDir: join(dir, 'worca'),
      settingsPath: join(dir, 'settings.json'),
      prefsPath
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('list-runs returns empty when no status.json exists', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, { id: '1', type: 'list-runs' });
    expect(reply.ok).toBe(true);
    expect(reply.payload.runs).toEqual([]);
    ws.close();
  });

  it('list-runs finds active run after writing status.json', async () => {
    const status = {
      started_at: '2026-03-08T10:00:00Z',
      stage: 'implement',
      work_request: { title: 'test run' },
      stages: { plan: { status: 'completed' }, implement: { status: 'in_progress' } }
    };
    writeFileSync(join(dir, 'worca', 'status.json'), JSON.stringify(status));
    // discoverRuns checks pipeline.pid to determine active status
    writeFileSync(join(dir, 'worca', 'pipeline.pid'), String(process.pid));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, { id: '2', type: 'list-runs' });
    expect(reply.ok).toBe(true);
    expect(reply.payload.runs.length).toBe(1);
    expect(reply.payload.runs[0].active).toBe(true);
    expect(reply.payload.runs[0].stage).toBe('implement');
    ws.close();
  });

  it('list-runs finds completed runs from results/', async () => {
    const result = {
      started_at: '2026-03-07T09:00:00Z',
      stage: 'pr',
      work_request: { title: 'old run' },
      stages: { plan: { status: 'completed' }, pr: { status: 'completed' } }
    };
    writeFileSync(join(dir, 'worca', 'results', 'abc123.json'), JSON.stringify(result));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, { id: '3', type: 'list-runs' });
    expect(reply.ok).toBe(true);
    expect(reply.payload.runs.length).toBe(1);
    expect(reply.payload.runs[0].active).toBe(false);
    ws.close();
  });

  it('subscribe-run returns snapshot for known runId', async () => {
    const status = {
      started_at: '2026-03-08T10:00:00Z',
      stage: 'plan',
      work_request: { title: 'test' },
      stages: { plan: { status: 'in_progress' } }
    };
    writeFileSync(join(dir, 'worca', 'status.json'), JSON.stringify(status));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);

    // First get the runId
    const listReply = await sendAndReceive(ws, { id: '4', type: 'list-runs' });
    const runId = listReply.payload.runs[0].id;

    const subReply = await sendAndReceive(ws, { id: '5', type: 'subscribe-run', payload: { runId } });
    expect(subReply.ok).toBe(true);
    expect(subReply.payload.stage).toBe('plan');
    ws.close();
  });

  it('subscribe-run returns error for unknown runId', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, { id: '6', type: 'subscribe-run', payload: { runId: 'nonexistent' } });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('NOT_FOUND');
    ws.close();
  });

  it('get-preferences and set-preferences round-trip', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);

    // Get defaults
    const getReply = await sendAndReceive(ws, { id: '7', type: 'get-preferences' });
    expect(getReply.ok).toBe(true);
    expect(getReply.payload.theme).toBe('light');

    // Set dark theme
    const setReply = await sendAndReceive(ws, { id: '8', type: 'set-preferences', payload: { theme: 'dark' } });
    expect(setReply.ok).toBe(true);
    expect(setReply.payload.theme).toBe('dark');

    // Get again to verify persistence
    const getReply2 = await sendAndReceive(ws, { id: '9', type: 'get-preferences' });
    expect(getReply2.payload.theme).toBe('dark');

    ws.close();
  });

  it('set-preferences broadcasts to all connected clients', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    // ws2 listens for broadcast
    const broadcastPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('broadcast timeout')), 5000);
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'preferences') {
          clearTimeout(timer);
          resolve(msg.payload);
        }
      });
    });

    // ws1 sets preferences
    ws1.send(JSON.stringify({ id: '10', type: 'set-preferences', payload: { theme: 'dark' } }));

    const broadcast = await broadcastPromise;
    expect(broadcast.theme).toBe('dark');

    ws1.close();
    ws2.close();
  });

  it('get-agent-prompt returns agent instructions for a known run and stage', async () => {
    // Create a run with a status and rendered agent file
    const runId = '20260309-120000';
    mkdirSync(join(dir, 'worca', 'runs', runId, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'worca', 'runs', runId, 'status.json'), JSON.stringify({
      started_at: '2026-03-09T12:00:00Z',
      run_id: runId,
      stage: 'implement',
      work_request: { title: 'Test feature', description: 'Implement the test feature' },
      stages: {
        plan: { status: 'completed', agent: 'planner' },
        implement: { status: 'in_progress', agent: 'implementer' },
      },
    }));
    writeFileSync(join(dir, 'worca', 'runs', runId, 'agents', 'implementer.md'),
      '# Implementer Agent\n\nYou are the Implementer.');
    writeFileSync(join(dir, 'worca', 'active_run'), runId);
    // discoverRuns checks pipeline.pid to determine active status for active_run entries
    writeFileSync(join(dir, 'worca', 'pipeline.pid'), String(process.pid));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);

    // Get the run ID from discovery
    const listReply = await sendAndReceive(ws, { id: 'p1', type: 'list-runs' });
    const discoveredRunId = listReply.payload.runs.find(r => r.run_id === runId)?.id;
    expect(discoveredRunId).toBeTruthy();

    const reply = await sendAndReceive(ws, {
      id: 'p2', type: 'get-agent-prompt',
      payload: { runId: discoveredRunId, stage: 'implement' },
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload.agent).toBe('implementer');
    expect(reply.payload.userPrompt).toContain('Implement the test feature');
    expect(reply.payload.promptSource).toBe('reconstructed');
    expect(reply.payload.agentInstructions).toContain('Implementer Agent');
    ws.close();
  });

  it('get-agent-prompt returns error for unknown run', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, {
      id: 'p3', type: 'get-agent-prompt',
      payload: { runId: 'nonexistent', stage: 'plan' },
    });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('NOT_FOUND');
    ws.close();
  });
});
