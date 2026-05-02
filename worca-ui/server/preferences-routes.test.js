import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

function startServer(prefsDir) {
  const app = createApp({ prefsDir });
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({ server, base });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('GET /api/preferences', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'prefs-routes-test-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when settings.json is missing', async () => {
    const res = await fetch(`${base}/api/preferences`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.preferences.worca.parallel.cleanup_policy).toBe('never');
    expect(data.preferences.worca.parallel.max_concurrent_pipelines).toBe(10);
    expect(data.preferences.worca.ui.worktree_disk_warning_bytes).toBe(
      2_000_000_000,
    );
    expect(data.preferences.worca.circuit_breaker.classifier_model).toBe(
      'haiku',
    );
  });

  it('returns defaults when settings.json contains malformed JSON', async () => {
    writeFileSync(join(tmpDir, 'settings.json'), 'not valid json{{{');
    const res = await fetch(`${base}/api/preferences`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.preferences.worca.parallel.cleanup_policy).toBe('never');
    expect(data.preferences.worca.parallel.max_concurrent_pipelines).toBe(10);
  });

  it('merges stored values with defaults', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: { parallel: { cleanup_policy: 'on-success' } },
      }),
    );
    const res = await fetch(`${base}/api/preferences`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.preferences.worca.parallel.cleanup_policy).toBe('on-success');
    expect(data.preferences.worca.parallel.max_concurrent_pipelines).toBe(10);
    expect(data.preferences.worca.circuit_breaker.classifier_model).toBe(
      'haiku',
    );
  });
});

describe('PUT /api/preferences', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'prefs-routes-test-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function put(body) {
    return fetch(`${base}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('deep-merges into existing settings', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: {
          parallel: {
            cleanup_policy: 'on-success',
            max_concurrent_pipelines: 5,
          },
        },
      }),
    );
    const res = await put({
      worca: { parallel: { max_concurrent_pipelines: 8 } },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.preferences.worca.parallel.max_concurrent_pipelines).toBe(8);
    expect(data.preferences.worca.parallel.cleanup_policy).toBe('on-success');
  });

  it('creates file from scratch when missing', async () => {
    const res = await put({
      worca: { parallel: { cleanup_policy: 'on-success' } },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.preferences.worca.parallel.cleanup_policy).toBe('on-success');
    expect(data.preferences.worca.parallel.max_concurrent_pipelines).toBe(10);
  });

  it('rejects max_concurrent_pipelines outside 1-100', async () => {
    const res = await put({
      worca: { parallel: { max_concurrent_pipelines: 0 } },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error.details).toContainEqual(
      expect.stringContaining('max_concurrent_pipelines'),
    );
  });

  it('rejects max_concurrent_pipelines over 100', async () => {
    const res = await put({
      worca: { parallel: { max_concurrent_pipelines: 101 } },
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-integer max_concurrent_pipelines', async () => {
    const res = await put({
      worca: { parallel: { max_concurrent_pipelines: 3.5 } },
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid cleanup_policy', async () => {
    const res = await put({
      worca: { parallel: { cleanup_policy: 'delete-everything' } },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.details).toContainEqual(
      expect.stringContaining('cleanup_policy'),
    );
  });

  it('rejects invalid classifier_model', async () => {
    const res = await put({
      worca: { circuit_breaker: { classifier_model: 'gpt4' } },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.details).toContainEqual(
      expect.stringContaining('classifier_model'),
    );
  });

  it('rejects worktree_disk_warning_bytes below 500 MB', async () => {
    const res = await put({
      worca: { ui: { worktree_disk_warning_bytes: 100 } },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.details).toContainEqual(
      expect.stringContaining('worktree_disk_warning_bytes'),
    );
  });

  it('rejects worktree_disk_warning_bytes above 50 GB', async () => {
    const res = await put({
      worca: { ui: { worktree_disk_warning_bytes: 51_000_000_000 } },
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-object request body', async () => {
    const res = await fetch(`${base}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBe(400);
  });

  it('rejects when worca is not an object', async () => {
    const res = await put({ worca: 'bad' });
    expect(res.status).toBe(400);
  });

  it('returns full merged state after write', async () => {
    const res = await put({
      worca: { circuit_breaker: { classifier_model: 'sonnet' } },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.preferences.worca.circuit_breaker.classifier_model).toBe(
      'sonnet',
    );
    expect(data.preferences.worca.parallel.cleanup_policy).toBe('never');
    expect(data.preferences.worca.parallel.max_concurrent_pipelines).toBe(10);
  });
});
