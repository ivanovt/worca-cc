import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

function startServer(opts) {
  const app = createApp(opts);
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

describe('GET /api/settings/secrets', () => {
  let tmpDir, server, base, settingsPath;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'secrets-routes-test-'));
    settingsPath = join(tmpDir, '.claude', 'settings.json');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    ({ server, base } = await startServer({
      projectRoot: tmpDir,
      settingsPath,
      worcaDir: join(tmpDir, '.worca'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty models when no settings exist', async () => {
    const res = await fetch(`${base}/api/settings/secrets`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.models).toEqual({});
  });

  it('returns public env vars from settings.json', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          models: {
            'alt-fast': {
              id: 'some-model',
              env: {
                ANTHROPIC_BASE_URL: 'https://example.com',
                API_TIMEOUT_MS: '3000',
              },
            },
          },
        },
      }),
    );
    const res = await fetch(`${base}/api/settings/secrets`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models['alt-fast'].ANTHROPIC_BASE_URL).toEqual({
      source: 'public',
      value: 'https://example.com',
    });
    expect(data.models['alt-fast'].API_TIMEOUT_MS).toEqual({
      source: 'public',
      value: '3000',
    });
  });

  it('returns masked secret env vars from settings.local.json', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: { models: { 'alt-fast': { id: 'x', env: {} } } },
      }),
    );
    const localPath = join(tmpDir, '.claude', 'settings.local.json');
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: {
          models: { 'alt-fast': { env: { SECRET_TOKEN: 'sk-abc123' } } },
        },
      }),
    );
    const res = await fetch(`${base}/api/settings/secrets`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models['alt-fast'].SECRET_TOKEN).toEqual({
      source: 'secret',
      value: '••••••••',
    });
  });

  it('marks keys present in both as override with masked value', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          models: { mymodel: { id: 'x', env: { MY_KEY: 'public-val' } } },
        },
      }),
    );
    const localPath = join(tmpDir, '.claude', 'settings.local.json');
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: { models: { mymodel: { env: { MY_KEY: 'secret-val' } } } },
      }),
    );
    const res = await fetch(`${base}/api/settings/secrets`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models.mymodel.MY_KEY).toEqual({
      source: 'override',
      value: '••••••••',
    });
  });

  it('ignores string-form model entries (no env)', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: { models: { opus: 'claude-opus-4-6' } },
      }),
    );
    const res = await fetch(`${base}/api/settings/secrets`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models).toEqual({});
  });
});

describe('PUT /api/settings/secrets', () => {
  let tmpDir, server, base, settingsPath;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'secrets-routes-put-'));
    settingsPath = join(tmpDir, '.claude', 'settings.json');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: { models: { 'alt-fast': { id: 'x', env: {} } } },
      }),
    );
    ({ server, base } = await startServer({
      projectRoot: tmpDir,
      settingsPath,
      worcaDir: join(tmpDir, '.worca'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets a secret key in settings.local.json', async () => {
    const res = await fetch(`${base}/api/settings/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        key: 'MY_SECRET',
        value: 'sk-123',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const localPath = join(tmpDir, '.claude', 'settings.local.json');
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(local.worca.models['alt-fast'].env.MY_SECRET).toBe('sk-123');
  });

  it('deletes a secret key when value is null', async () => {
    const localPath = join(tmpDir, '.claude', 'settings.local.json');
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: { models: { 'alt-fast': { env: { MY_SECRET: 'old' } } } },
      }),
    );
    const res = await fetch(`${base}/api/settings/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        key: 'MY_SECRET',
        value: null,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(local.worca.models['alt-fast'].env.MY_SECRET).toBeUndefined();
  });

  it('rejects reserved key PATH', async () => {
    const res = await fetch(`${base}/api/settings/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alt-fast', key: 'PATH', value: '/tmp' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/reserved/i);
  });

  it('rejects keys with WORCA_ prefix', async () => {
    const res = await fetch(`${base}/api/settings/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        key: 'WORCA_CUSTOM',
        value: 'x',
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/reserved/i);
  });

  it('rejects empty model name', async () => {
    const res = await fetch(`${base}/api/settings/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '', key: 'MY_KEY', value: 'x' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('rejects empty key name', async () => {
    const res = await fetch(`${base}/api/settings/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alt-fast', key: '', value: 'x' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('uses atomic write (settings.local.json survives concurrent reads)', async () => {
    const res = await fetch(`${base}/api/settings/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alt-fast', key: 'KEY1', value: 'val1' }),
    });
    expect(res.status).toBe(200);
    const localPath = join(tmpDir, '.claude', 'settings.local.json');
    expect(existsSync(localPath)).toBe(true);
    const content = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(content.worca.models['alt-fast'].env.KEY1).toBe('val1');
  });

  it('preserves existing keys in settings.local.json when adding new secret', async () => {
    const localPath = join(tmpDir, '.claude', 'settings.local.json');
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: { models: { 'alt-fast': { env: { EXISTING: 'keep' } } } },
      }),
    );
    const res = await fetch(`${base}/api/settings/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alt-fast', key: 'NEW_KEY', value: 'new' }),
    });
    expect(res.status).toBe(200);
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(local.worca.models['alt-fast'].env.EXISTING).toBe('keep');
    expect(local.worca.models['alt-fast'].env.NEW_KEY).toBe('new');
  });
});

describe('reserved-env-keys.json', () => {
  it('is the shared source of truth for both Python and JS', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const denylist = require('./reserved-env-keys.json');
    expect(denylist.keys).toContain('PATH');
    expect(denylist.keys).toContain('WORCA_AGENT');
    expect(denylist.keys).toContain('CLAUDECODE');
    expect(denylist.prefixes).toContain('WORCA_');
  });
});
