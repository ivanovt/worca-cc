import {
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
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('/api/models — tier-aware CRUD', () => {
  let tmpDir;
  let projectSettingsPath;
  let projectLocalPath;
  let worcaHome;
  let userSettingsPath;
  let server;
  let base;
  let prevWorcaHome;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'models-routes-test-'));
    projectSettingsPath = join(tmpDir, '.claude', 'settings.json');
    projectLocalPath = join(tmpDir, '.claude', 'settings.local.json');
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(projectSettingsPath, JSON.stringify({ worca: {} }));

    worcaHome = mkdtempSync(join(tmpdir(), 'models-routes-home-'));
    userSettingsPath = join(worcaHome, 'settings.json');
    prevWorcaHome = process.env.WORCA_HOME;
    process.env.WORCA_HOME = worcaHome;

    ({ server, base } = await startServer({
      projectRoot: tmpDir,
      settingsPath: projectSettingsPath,
      worcaDir: join(tmpDir, '.worca'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(worcaHome, { recursive: true, force: true });
    if (prevWorcaHome === undefined) delete process.env.WORCA_HOME;
    else process.env.WORCA_HOME = prevWorcaHome;
  });

  describe('GET /api/models', () => {
    it('returns the 3 builtin aliases by default', async () => {
      const res = await fetch(`${base}/api/models`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      const builtins = data.models.filter((m) => m.tier === 'builtin');
      expect(builtins.map((m) => m.alias).sort()).toEqual([
        'haiku',
        'opus',
        'sonnet',
      ]);
      // No project or user entries yet.
      expect(data.models.filter((m) => m.tier === 'project')).toHaveLength(0);
      expect(data.models.filter((m) => m.tier === 'user')).toHaveLength(0);
    });

    it('lists project and user tier entries when present', async () => {
      writeFileSync(
        projectSettingsPath,
        JSON.stringify({
          worca: { models: { 'project-alias': 'claude-opus-4-7' } },
        }),
      );
      writeFileSync(
        userSettingsPath,
        JSON.stringify({
          worca: { models: { 'user-alias': 'claude-sonnet-4-6' } },
        }),
      );

      const res = await fetch(`${base}/api/models`);
      const data = await res.json();
      const aliases = data.models.map((m) => `${m.tier}:${m.alias}`);
      expect(aliases).toContain('project:project-alias');
      expect(aliases).toContain('user:user-alias');
    });
  });

  describe('GET /api/models/:tier/:alias', () => {
    it('returns a builtin row read-only', async () => {
      const res = await fetch(`${base}/api/models/builtin/opus`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.model.tier).toBe('builtin');
      expect(data.model.builtin).toBe(true);
      expect(data.model.id).toBe('claude-opus-4-7');
    });

    it('returns 404 for an unknown alias', async () => {
      const res = await fetch(`${base}/api/models/project/missing-alias`);
      expect(res.status).toBe(404);
    });

    it('returns 400 for an invalid tier', async () => {
      const res = await fetch(`${base}/api/models/bogus/opus`);
      expect(res.status).toBe(400);
    });

    it('surfaces imported_from when present on the entry', async () => {
      writeFileSync(
        projectSettingsPath,
        JSON.stringify({
          worca: {
            models: {
              'imported-one': {
                id: 'claude-opus-4-7',
                _imported_from: 'shared-bundle.json',
              },
            },
          },
        }),
      );
      const res = await fetch(`${base}/api/models/project/imported-one`);
      const data = await res.json();
      expect(data.model.imported_from).toBe('shared-bundle.json');
    });
  });

  describe('PUT /api/models/:tier/:alias', () => {
    it('refuses builtin tier writes', async () => {
      const res = await fetch(`${base}/api/models/builtin/opus`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'foo' }),
      });
      expect(res.status).toBe(403);
    });

    it('writes id to settings.json, env to settings.local.json (project tier)', async () => {
      const res = await fetch(`${base}/api/models/project/glm-ds`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: 'glm-ds',
          id: 'zai-glm-4.6',
          env: { ANTHROPIC_BASE_URL: 'https://glm/' },
        }),
      });
      expect(res.status).toBe(200);

      const base_ = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      // Object form because env exists (preserves deep-merge with .local).
      expect(base_.worca.models['glm-ds']).toEqual({ id: 'zai-glm-4.6' });
      const local = JSON.parse(readFileSync(projectLocalPath, 'utf8'));
      expect(local.worca.models['glm-ds']).toEqual({
        env: { ANTHROPIC_BASE_URL: 'https://glm/' },
      });
    });

    it('writes string-form when env is empty', async () => {
      await fetch(`${base}/api/models/project/plain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'plain', id: 'claude-opus-4-7' }),
      });
      const base_ = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      // String form is canonical when no env.
      expect(base_.worca.models.plain).toBe('claude-opus-4-7');
    });

    it('writes pricing into settings.json (committed)', async () => {
      await fetch(`${base}/api/models/project/pricy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: 'pricy',
          id: 'claude-opus-4-7',
          pricing: { input_per_mtok: 15, output_per_mtok: 75 },
        }),
      });
      const base_ = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      expect(base_.worca.pricing.models.pricy).toEqual({
        input_per_mtok: 15,
        output_per_mtok: 75,
      });
    });

    it('rejects reserved env keys', async () => {
      const res = await fetch(`${base}/api/models/project/bad`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: 'bad',
          id: 'claude-opus-4-7',
          env: { WORCA_AGENT: 'x' },
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.key).toBe('WORCA_AGENT');
    });

    it('rejects invalid alias name', async () => {
      const res = await fetch(`${base}/api/models/project/bad`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'bad name!', id: 'claude-opus-4-7' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects alias containing colon', async () => {
      const res = await fetch(`${base}/api/models/project/bad`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'user:opus', id: 'claude-opus-4-7' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/colon/i);
    });

    it('detects rename collisions in the same tier', async () => {
      // Pre-existing entry.
      writeFileSync(
        projectSettingsPath,
        JSON.stringify({
          worca: {
            models: { existing: 'claude-opus-4-7', other: 'claude-sonnet-4-6' },
          },
        }),
      );
      const res = await fetch(`${base}/api/models/project/other`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'existing', id: 'claude-sonnet-4-6' }),
      });
      expect(res.status).toBe(409);
    });

    it('renames cleanly (deletes the old alias slot)', async () => {
      writeFileSync(
        projectSettingsPath,
        JSON.stringify({
          worca: { models: { old: 'claude-opus-4-7' } },
        }),
      );
      const res = await fetch(`${base}/api/models/project/old`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'fresh', id: 'claude-opus-4-7' }),
      });
      expect(res.status).toBe(200);
      const base_ = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      expect(base_.worca.models).toEqual({ fresh: 'claude-opus-4-7' });
    });

    it('writes user-tier entries into the user-global settings.json', async () => {
      await fetch(`${base}/api/models/user/from-user`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'from-user', id: 'claude-opus-4-7' }),
      });
      const user = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
      expect(user.worca.models['from-user']).toBe('claude-opus-4-7');
      // Project settings.json should NOT carry the user-tier alias.
      const proj = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      expect(proj.worca?.models?.['from-user']).toBeUndefined();
    });

    it('drops _imported_from on UI save (ownership transfer)', async () => {
      writeFileSync(
        projectSettingsPath,
        JSON.stringify({
          worca: {
            models: {
              imported: {
                id: 'claude-opus-4-7',
                _imported_from: 'shared.json',
              },
            },
          },
        }),
      );
      await fetch(`${base}/api/models/project/imported`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'imported', id: 'claude-opus-4-7' }),
      });
      const base_ = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      // String form again, no _imported_from carried over.
      expect(base_.worca.models.imported).toBe('claude-opus-4-7');
    });
  });

  describe('DELETE /api/models/:tier/:alias', () => {
    it('removes from both settings.json and settings.local.json', async () => {
      writeFileSync(
        projectSettingsPath,
        JSON.stringify({
          worca: { models: { gone: { id: 'claude-opus-4-7' } } },
        }),
      );
      writeFileSync(
        projectLocalPath,
        JSON.stringify({ worca: { models: { gone: { env: { K: 'v' } } } } }),
      );
      const res = await fetch(`${base}/api/models/project/gone`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const base_ = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      expect(base_.worca.models?.gone).toBeUndefined();
      const local = JSON.parse(readFileSync(projectLocalPath, 'utf8'));
      expect(local.worca.models?.gone).toBeUndefined();
    });

    it('refuses to delete builtin tier', async () => {
      const res = await fetch(`${base}/api/models/builtin/opus`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/models/:tier/:alias/duplicate', () => {
    it('copies a builtin entry to project tier with a new alias', async () => {
      const res = await fetch(`${base}/api/models/builtin/opus/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dst_tier: 'project', dst_alias: 'my-opus' }),
      });
      expect(res.status).toBe(200);
      const base_ = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      expect(base_.worca.models['my-opus']).toBe('claude-opus-4-7');
    });

    it('detects alias collision at destination tier', async () => {
      writeFileSync(
        projectSettingsPath,
        JSON.stringify({
          worca: { models: { existing: 'claude-opus-4-7' } },
        }),
      );
      const res = await fetch(`${base}/api/models/builtin/opus/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dst_tier: 'project', dst_alias: 'existing' }),
      });
      expect(res.status).toBe(409);
    });

    it('refuses to duplicate to an invalid tier', async () => {
      const res = await fetch(`${base}/api/models/builtin/opus/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dst_tier: 'builtin', dst_alias: 'x' }),
      });
      expect(res.status).toBe(400);
    });

    it('refuses alias names with invalid characters', async () => {
      const res = await fetch(`${base}/api/models/builtin/opus/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dst_tier: 'project', dst_alias: 'bad alias!' }),
      });
      expect(res.status).toBe(400);
    });
  });
});
