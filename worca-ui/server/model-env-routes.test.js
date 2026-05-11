import {
  existsSync,
  mkdirSync,
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

describe('PUT /api/settings/model-env', () => {
  let tmpDir, server, base, settingsPath, localPath;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'model-env-routes-test-'));
    settingsPath = join(tmpDir, '.claude', 'settings.json');
    localPath = join(tmpDir, '.claude', 'settings.local.json');
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: { models: { 'alt-fast': { id: 'baseline', env: {} } } },
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

  it('writes env (without id) to settings.local.json', async () => {
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'custom-id',
        env: {
          ANTHROPIC_BASE_URL: 'https://example.com',
          API_TIMEOUT_MS: '3000',
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.model).toBe('alt-fast');
    expect(data.id).toBe('custom-id');
    expect(data.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://example.com',
      API_TIMEOUT_MS: '3000',
    });

    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(local.worca.models['alt-fast']).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://example.com',
        API_TIMEOUT_MS: '3000',
      },
    });
    expect(local.worca.models['alt-fast'].id).toBeUndefined();
  });

  it('moves id to settings.json (string form) and strips env from it', async () => {
    // Seed settings.json with a hand-edited entry that has env — simulating
    // the legacy / footgun case the simplification is meant to eliminate.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          models: {
            'alt-fast': { id: 'baseline', env: { LEGACY: 'leaked' } },
          },
        },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'updated-id',
        env: { ANTHROPIC_BASE_URL: 'https://x' },
      }),
    });
    expect(res.status).toBe(200);
    const baseAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // id moved to settings.json (string form, since no env lives there now)
    expect(baseAfter.worca.models['alt-fast']).toBe('updated-id');
  });

  it('prevents phantom resurrection of env keys from settings.json', async () => {
    // settings.json has env keys hand-edited; PUT must strip them so the
    // wholesale env in local fully replaces the deep-merged view.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          models: {
            'alt-fast': {
              id: 'x',
              env: { GHOST: 'should-disappear', SHARED: 'old' },
            },
          },
        },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'x',
        env: { SHARED: 'new' },
      }),
    });
    expect(res.status).toBe(200);
    const baseAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const localAfter = JSON.parse(readFileSync(localPath, 'utf8'));
    // settings.json entry is string-form, no env
    expect(baseAfter.worca.models['alt-fast']).toBe('x');
    // local has only what was sent
    expect(localAfter.worca.models['alt-fast'].env).toEqual({ SHARED: 'new' });
  });

  it('replaces env wholesale (deleted keys disappear from local)', async () => {
    // Seed local with two keys
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: {
          models: {
            'alt-fast': { env: { KEEP_ME: 'a', DELETE_ME: 'b' } },
          },
        },
      }),
    );
    // PUT with only KEEP_ME
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'x',
        env: { KEEP_ME: 'a' },
      }),
    });
    expect(res.status).toBe(200);
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(local.worca.models['alt-fast'].env).toEqual({ KEEP_ME: 'a' });
  });

  it('rejects reserved key PATH', async () => {
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'x',
        env: { PATH: '/tmp', ANTHROPIC_BASE_URL: 'https://x' },
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.key).toBe('PATH');
    expect(data.error).toMatch(/reserved/i);
    // settings.local.json should not have been created
    expect(existsSync(localPath)).toBe(false);
  });

  it('rejects keys with WORCA_ prefix', async () => {
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'x',
        env: { WORCA_CUSTOM: 'x' },
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.key).toBe('WORCA_CUSTOM');
  });

  it('rejects empty model name', async () => {
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '', id: 'x', env: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-string env value', async () => {
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'x',
        env: { GOOD: 123 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts empty env (drops the model entry from local file)', async () => {
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: { models: { 'alt-fast': { env: { OLD: 'val' } } } },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alt-fast', id: 'x', env: {} }),
    });
    expect(res.status).toBe(200);
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    // Empty env => no local entry needed; id stays in settings.json
    expect(local.worca.models['alt-fast']).toBeUndefined();
    const baseAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(baseAfter.worca.models['alt-fast']).toBe('x');
  });

  it('uses atomic write (settings.local.json is fully written)', async () => {
    await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'x',
        env: { KEY1: 'val1' },
      }),
    });
    expect(existsSync(localPath)).toBe(true);
    const content = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(content.worca.models['alt-fast'].env.KEY1).toBe('val1');
  });

  it('preserves unrelated models in settings.local.json', async () => {
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: {
          models: { other: { env: { OTHER_VAR: 'kept' } } },
        },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        id: 'x',
        env: { NEW_KEY: 'new' },
      }),
    });
    expect(res.status).toBe(200);
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(local.worca.models.other.env.OTHER_VAR).toBe('kept');
    expect(local.worca.models['alt-fast'].env.NEW_KEY).toBe('new');
  });

  it('empty id + empty env drops the entry from both files', async () => {
    // PUT with id: '' is an explicit "clear id" — combined with empty env,
    // the model entry has nothing left and is removed everywhere.
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: { models: { 'alt-fast': { env: { OLD: 'v' } } } },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'alt-fast', id: '', env: {} }),
    });
    expect(res.status).toBe(200);
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(local.worca.models['alt-fast']).toBeUndefined();
    const baseAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(baseAfter.worca.models['alt-fast']).toBeUndefined();
  });

  it('null id preserves existing id from settings.json', async () => {
    // PUT with id: null (or no id key) means "leave id alone".  The
    // existing settings.json id should be carried forward and normalized.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: { models: { 'alt-fast': { id: 'baseline', env: {} } } },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'alt-fast',
        env: { ANTHROPIC_BASE_URL: 'https://x' },
      }),
    });
    expect(res.status).toBe(200);
    const baseAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(baseAfter.worca.models['alt-fast']).toBe('baseline');
    const localAfter = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(localAfter.worca.models['alt-fast'].env).toEqual({
      ANTHROPIC_BASE_URL: 'https://x',
    });
  });
});

describe('DELETE /api/settings/model-env', () => {
  let tmpDir, server, base, settingsPath, localPath;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'model-env-routes-del-'));
    settingsPath = join(tmpDir, '.claude', 'settings.json');
    localPath = join(tmpDir, '.claude', 'settings.local.json');
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ worca: { models: {} } }));
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

  it('removes a model from settings.local.json', async () => {
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: {
          models: {
            doomed: { env: { K: 'v' } },
            keeper: { env: { K: 'v2' } },
          },
        },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env?model=doomed`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.removed).toBe(true);
    expect(data.fromLocal).toBe(true);
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(local.worca.models.doomed).toBeUndefined();
    expect(local.worca.models.keeper).toBeDefined();
  });

  it('removes a model from settings.json', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          models: {
            doomed: { id: 'x', env: { K: 'v' } },
            keeper: 'claude-x',
          },
        },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env?model=doomed`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.removed).toBe(true);
    expect(data.fromBase).toBe(true);
    const baseAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(baseAfter.worca.models.doomed).toBeUndefined();
    expect(baseAfter.worca.models.keeper).toBe('claude-x');
  });

  it('removes from BOTH files when model exists in both', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        worca: {
          models: {
            doomed: { id: 'x', env: { PUBLIC: 'p' } },
          },
        },
      }),
    );
    writeFileSync(
      localPath,
      JSON.stringify({
        worca: { models: { doomed: { env: { SECRET: 's' } } } },
      }),
    );
    const res = await fetch(`${base}/api/settings/model-env?model=doomed`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fromBase).toBe(true);
    expect(data.fromLocal).toBe(true);

    const baseAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const localAfter = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(baseAfter.worca.models.doomed).toBeUndefined();
    expect(localAfter.worca.models.doomed).toBeUndefined();
  });

  it('returns removed=false when model is in neither file', async () => {
    writeFileSync(
      localPath,
      JSON.stringify({ worca: { models: { other: { env: { K: 'v' } } } } }),
    );
    const res = await fetch(`${base}/api/settings/model-env?model=missing`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.removed).toBe(false);
    expect(data.fromBase).toBe(false);
    expect(data.fromLocal).toBe(false);
  });

  it('rejects empty model name', async () => {
    const res = await fetch(`${base}/api/settings/model-env`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
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
