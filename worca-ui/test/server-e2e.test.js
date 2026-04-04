import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { get as httpGet } from 'node:http';
import { WebSocket } from 'ws';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { attachWsServer } from '../server/ws.js';

function fetch(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

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

describe('server e2e', () => {
  let server, port, dir, prefsPath;

  beforeEach(async () => {
    dir = join(tmpdir(), `worca-e2e-${Date.now()}`);
    mkdirSync(join(dir, 'worca', 'results'), { recursive: true });
    prefsPath = join(dir, 'preferences.json');

    const app = createApp();
    server = createServer(app);
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

  it('server boots without crashing', () => {
    expect(server.address().port).toBeGreaterThan(0);
  });

  it('serves index.html on GET /', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>worca-ui</title>');
  });

  it('serves styles.css on GET /styles.css', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
  });

  it('serves index.html for unknown routes (SPA fallback)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/some/unknown/path`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>worca-ui</title>');
  });

  it('WebSocket connects through full server stack', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, { id: '1', type: 'list-runs' });
    expect(reply.ok).toBe(true);
    ws.close();
  });

  it('HTTP and WebSocket work together on same server', async () => {
    const status = {
      started_at: '2026-03-08T10:00:00Z',
      stage: 'implement',
      work_request: { title: 'test run' },
      stages: { plan: { status: 'completed' }, implement: { status: 'in_progress' } }
    };
    writeFileSync(join(dir, 'worca', 'status.json'), JSON.stringify(status));
    // discoverRuns checks pipeline.pid to determine active status
    writeFileSync(join(dir, 'worca', 'pipeline.pid'), String(process.pid));

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const reply = await sendAndReceive(ws, { id: '2', type: 'list-runs' });
    expect(reply.payload.runs.length).toBe(1);
    expect(reply.payload.runs[0].active).toBe(true);
    ws.close();
  });

  it('preferences round-trip through full stack', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);

    const getReply = await sendAndReceive(ws, { id: '3', type: 'get-preferences' });
    expect(getReply.payload.theme).toBe('light');

    const setReply = await sendAndReceive(ws, { id: '4', type: 'set-preferences', payload: { theme: 'dark' } });
    expect(setReply.payload.theme).toBe('dark');

    const getReply2 = await sendAndReceive(ws, { id: '5', type: 'get-preferences' });
    expect(getReply2.payload.theme).toBe('dark');

    ws.close();
  });
});
