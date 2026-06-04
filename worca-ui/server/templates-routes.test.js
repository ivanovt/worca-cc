/**
 * Tests: templates-routes.js — (tier, id) contract.
 *
 * Mutations delegate to `worca templates …`; we mock execFileSync and
 * assert on CLI args + HTTP shape. Read paths and the default-template
 * write touch the real filesystem (tmpdir).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: (...args) => mockExecSync(...args),
  };
});

const { createTemplatesRoutes } = await import('./templates-routes.js');

async function createTestApp(projectRoot) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/projects/:projectId',
    (req, _res, next) => {
      req.project = {
        name: req.params.projectId,
        path: projectRoot,
        settingsPath: join(projectRoot, '.claude', 'settings.json'),
        worcaDir: join(projectRoot, '.worca'),
        projectRoot,
      };
      next();
    },
    createTemplatesRoutes(),
  );
  return app;
}

async function request(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const options = {
          method,
          headers: { 'Content-Type': 'application/json' },
        };
        if (body) options.body = JSON.stringify(body);
        const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
        resolve({ status: res.status, body: json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

async function requestBinary(app, method, path, body, contentType) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { 'Content-Type': contentType },
          body,
        });
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
        resolve({ status: res.status, body: json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function cliError(stderr, stdout = '') {
  const err = new Error('Command failed');
  err.status = 1;
  err.stderr = Buffer.from(stderr);
  err.stdout = Buffer.from(stdout);
  return err;
}

/**
 * Pull the args array passed to `worca templates …` on call N, strip
 * the boilerplate `--project-root <path>` prefix so individual tests
 * can assert on the subcommand without re-encoding the path each time.
 */
function templateArgs(call) {
  const args = call[1];
  if (args[0] === 'templates' && args[1] === '--project-root') {
    return ['templates', ...args.slice(3)];
  }
  return args;
}
function rawArgs(call) {
  return call[1];
}

describe('templates-routes — (tier, id) contract', () => {
  let projectRoot;
  let templatesDir;
  let userTemplatesDir;
  let builtinDir;
  let originalWorcaHome;

  function seedProject(id, body = {}) {
    mkdirSync(join(templatesDir, id), { recursive: true });
    writeFileSync(
      join(templatesDir, id, 'template.json'),
      JSON.stringify({ id, name: id, ...body }),
    );
  }
  function seedUser(id, body = {}) {
    mkdirSync(join(userTemplatesDir, 'templates', id), { recursive: true });
    writeFileSync(
      join(userTemplatesDir, 'templates', id, 'template.json'),
      JSON.stringify({ id, name: id, ...body }),
    );
  }
  function seedBuiltin(id, body = {}) {
    mkdirSync(join(builtinDir, id), { recursive: true });
    writeFileSync(
      join(builtinDir, id, 'template.json'),
      JSON.stringify({ id, name: id, ...body }),
    );
  }

  beforeEach(() => {
    originalWorcaHome = process.env.WORCA_HOME;
    projectRoot = join(
      tmpdir(),
      `worca-proj-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    templatesDir = join(projectRoot, '.claude', 'templates');
    userTemplatesDir = join(tmpdir(), `worca-user-tpl-${Date.now()}`);
    builtinDir = join(projectRoot, '.claude', 'worca', 'templates');

    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(templatesDir, { recursive: true });
    mkdirSync(userTemplatesDir, { recursive: true });
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{}');

    process.env.WORCA_HOME = userTemplatesDir;
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('');
  });

  afterEach(() => {
    try {
      if (originalWorcaHome === undefined) {
        delete process.env.WORCA_HOME;
      } else {
        process.env.WORCA_HOME = originalWorcaHome;
      }
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(userTemplatesDir, { recursive: true, force: true });
    } catch {
      /* tmpdir cleanup best-effort */
    }
  });

  // ─── GET /templates — flat list, every tier ───────────────────────

  describe('GET /templates — flat list', () => {
    it('returns every template with its own tier — no dedup', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('bugfix');
      seedBuiltin('bugfix');
      seedBuiltin('feature');
      seedUser('my-user-tpl');

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates',
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const entries = body.templates;
      // 4 on disk → 4 in the response (no dedup)
      expect(entries).toHaveLength(4);
      // (tier, id) pairs round-trip
      const refs = entries.map((t) => `${t.tier}:${t.id}`).sort();
      expect(refs).toEqual([
        'builtin:bugfix',
        'builtin:feature',
        'project:bugfix',
        'user:my-user-tpl',
      ]);
      // Built-in entry exists for `bugfix` even though project shadows it
      const builtinBugfix = entries.find(
        (t) => t.tier === 'builtin' && t.id === 'bugfix',
      );
      expect(builtinBugfix).toBeDefined();
      expect(builtinBugfix.builtin).toBe(true);
    });

    it('orders builtin → project → user (matches Python TemplateResolver.list)', async () => {
      const app = await createTestApp(projectRoot);
      seedBuiltin('w-tpl');
      seedProject('p-tpl');
      seedUser('u-tpl');
      const { body } = await request(
        app,
        'GET',
        '/api/projects/test/templates',
      );
      const tiers = body.templates.map((t) => t.tier);
      expect(tiers).toEqual(['builtin', 'project', 'user']);
    });

    it('omits the old `effectiveTier` / `shadows` fields', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('foo');
      seedBuiltin('foo');
      const { body } = await request(
        app,
        'GET',
        '/api/projects/test/templates',
      );
      for (const t of body.templates) {
        expect(t.effectiveTier).toBeUndefined();
        expect(t.shadows).toBeUndefined();
      }
    });
  });

  // ─── GET /templates/:tier/:id ─────────────────────────────────────

  describe('GET /templates/:tier/:id — fetch exact', () => {
    it('returns the project copy when both project and builtin exist', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('foo', { name: 'Project Foo' });
      seedBuiltin('foo', { name: 'Builtin Foo' });
      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/project/foo',
      );
      expect(status).toBe(200);
      expect(body.template.name).toBe('Project Foo');
      expect(body.tier).toBe('project');
    });

    it('returns the built-in copy by explicit tier', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('foo', { name: 'Project Foo' });
      seedBuiltin('foo', { name: 'Builtin Foo' });
      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/builtin/foo',
      );
      expect(status).toBe(200);
      expect(body.template.name).toBe('Builtin Foo');
      expect(body.tier).toBe('builtin');
    });

    it('returns 404 when the (tier, id) does not exist', async () => {
      const app = await createTestApp(projectRoot);
      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/project/missing',
      );
      expect(status).toBe(404);
      expect(body.ok).toBe(false);
    });

    it('rejects unknown tier (400)', async () => {
      const app = await createTestApp(projectRoot);
      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/whatever/foo',
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/tier/i);
    });

    it('accepts underscored ids (regression for _legacy-settings)', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('_legacy-settings');
      const { status } = await request(
        app,
        'GET',
        '/api/projects/test/templates/project/_legacy-settings',
      );
      expect(status).toBe(200);
    });
  });

  // ─── POST /templates/:tier — create ───────────────────────────────

  describe('POST /templates/:tier — create', () => {
    it('delegates to `worca templates create --from-file <path>` for project tier', async () => {
      const app = await createTestApp(projectRoot);
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project',
        { id: 'new-tpl', name: 'New', config: {} },
      );
      expect(status).toBe(201);
      expect(body.ok).toBe(true);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args.slice(0, 3)).toEqual(['templates', 'create', '--from-file']);
      expect(args).not.toContain('--global');
    });

    it('passes --global to the CLI for user tier', async () => {
      const app = await createTestApp(projectRoot);
      await request(app, 'POST', '/api/projects/test/templates/user', {
        id: 'user-tpl',
        name: 'User',
        config: {},
      });
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toContain('--global');
    });

    it('returns 409 when (tier, id) already exists', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('clash');
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project',
        { id: 'clash', name: 'Clash' },
      );
      expect(status).toBe(409);
      expect(body.ok).toBe(false);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('rejects writes to builtin tier with 405', async () => {
      const app = await createTestApp(projectRoot);
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/builtin',
        { id: 'something', name: 'x' },
      );
      expect(status).toBe(405);
      expect(body.error).toMatch(/immutable/i);
    });

    it('rejects missing id (400)', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project',
        { name: 'No ID' },
      );
      expect(status).toBe(400);
    });

    it('passes --project-root so the CLI does not need a `.git` walk', async () => {
      const app = await createTestApp(projectRoot);
      await request(app, 'POST', '/api/projects/test/templates/project', {
        id: 'flag-check',
        name: 'Flag Check',
        config: {},
      });
      const raw = rawArgs(mockExecSync.mock.calls[0]);
      const idx = raw.indexOf('--project-root');
      expect(idx).toBe(1);
      expect(raw[idx + 1]).toBe(projectRoot);
    });
  });

  // ─── PUT /templates/:tier/:id — upsert ────────────────────────────

  describe('PUT /templates/:tier/:id', () => {
    it('delegates to the same create CLI for project upsert', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'PUT',
        '/api/projects/test/templates/project/existing',
        { name: 'Updated', config: {} },
      );
      expect(status).toBe(200);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args.slice(0, 3)).toEqual(['templates', 'create', '--from-file']);
    });

    it('rejects PUT to builtin with 405', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'PUT',
        '/api/projects/test/templates/builtin/foo',
        { name: 'attempt' },
      );
      expect(status).toBe(405);
    });
  });

  // ─── DELETE /templates/:tier/:id ──────────────────────────────────

  describe('DELETE /templates/:tier/:id', () => {
    it('delegates to `worca templates delete <id>` for project tier', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('proj-tmpl');
      const { status } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/project/proj-tmpl',
      );
      expect(status).toBe(200);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toEqual(['templates', 'delete', 'proj-tmpl']);
    });

    it('passes --global for user tier', async () => {
      const app = await createTestApp(projectRoot);
      seedUser('user-tmpl');
      const { status } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/user/user-tmpl',
      );
      expect(status).toBe(200);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toEqual(['templates', 'delete', 'user-tmpl', '--global']);
    });

    it('returns 404 when the (tier, id) does not exist', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/project/missing',
      );
      expect(status).toBe(404);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('rejects DELETE to builtin with 405', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/builtin/foo',
      );
      expect(status).toBe(405);
    });
  });

  // ─── POST /templates/:tier/:id/duplicate ─────────────────────────

  describe('POST /templates/:tier/:id/duplicate', () => {
    it('delegates duplicate with dst_tier + dst_id', async () => {
      const app = await createTestApp(projectRoot);
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/builtin/bugfix/duplicate',
        { dst_tier: 'project', dst_id: 'bugfix' },
      );
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toEqual([
        'templates',
        'duplicate',
        'bugfix',
        '--dst',
        'bugfix',
        '--dst-scope',
        'project',
      ]);
    });

    it('rejects dst_tier=builtin (immutable) with 405', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/foo/duplicate',
        { dst_tier: 'builtin', dst_id: 'foo' },
      );
      expect(status).toBe(405);
    });

    it('maps CLI name_collision to HTTP 409', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockImplementation(() => {
        throw cliError("Template ID 'x' already exists in project scope.");
      });
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/foo/duplicate',
        { dst_tier: 'project', dst_id: 'x' },
      );
      expect(status).toBe(409);
      expect(body.code).toBe('name_collision');
    });
  });

  // ─── POST /templates/:tier/:id/rename ─────────────────────────────

  describe('POST /templates/:tier/:id/rename', () => {
    it('uses a single rename CLI invocation', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('old-id');
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/old-id/rename',
        { dst_tier: 'project', dst_id: 'new-id' },
      );
      expect(status).toBe(200);
      // Single call — no longer two separate duplicate + delete calls
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args.slice(0, 2)).toEqual(['templates', 'rename']);
      expect(args).toContain('--src-id');
      expect(args[args.indexOf('--src-id') + 1]).toBe('old-id');
      expect(args).toContain('--dst-id');
      expect(args[args.indexOf('--dst-id') + 1]).toBe('new-id');
    });

    it('passes --src-scope and --dst-scope on cross-tier rename', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('cross-tier');
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/cross-tier/rename',
        { dst_tier: 'user', dst_id: 'cross-tier' },
      );
      expect(status).toBe(200);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toContain('--src-scope');
      expect(args[args.indexOf('--src-scope') + 1]).toBe('project');
      expect(args).toContain('--dst-scope');
      expect(args[args.indexOf('--dst-scope') + 1]).toBe('user');
    });

    it('passes --src-scope user when src is user tier', async () => {
      const app = await createTestApp(projectRoot);
      seedUser('user-src');
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/user/user-src/rename',
        { dst_tier: 'project', dst_id: 'user-src' },
      );
      expect(status).toBe(200);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toContain('--src-scope');
      expect(args[args.indexOf('--src-scope') + 1]).toBe('user');
    });

    it('rejects rename FROM builtin with 405', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/builtin/foo/rename',
        { dst_tier: 'project', dst_id: 'foo' },
      );
      expect(status).toBe(405);
    });

    it('rejects rename TO builtin with 405', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('foo');
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/foo/rename',
        { dst_tier: 'builtin', dst_id: 'foo' },
      );
      expect(status).toBe(405);
    });

    it('rejects no-op (same tier + same id) with 400', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('static');
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/static/rename',
        { dst_tier: 'project', dst_id: 'static' },
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/no change/i);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('returns 404 if source missing', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/ghost/rename',
        { dst_tier: 'project', dst_id: 'phantom' },
      );
      expect(status).toBe(404);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('surfaces partial_rename response shape when CLI reports partial failure', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('half');
      // Single rename call fails with partial_rename in stderr
      mockExecSync.mockImplementation(() => {
        throw cliError("error: partial_rename: Renamed to 'whole' but failed to remove 'half'");
      });
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/half/rename',
        { dst_tier: 'project', dst_id: 'whole' },
      );
      expect(status).toBe(500);
      expect(body.code).toBe('partial_rename');
      expect(body.error).toMatch(/Renamed to "whole"/);
      expect(body.src_tier).toBe('project');
      expect(body.src_id).toBe('half');
      expect(body.dst_tier).toBe('project');
      expect(body.dst_id).toBe('whole');
    });
  });

  // ─── POST /templates/validate ─────────────────────────────────────

  describe('POST /templates/validate', () => {
    // Moved out of `/templates/:tier/:id/validate` because the
    // validator is generic — it inspects the posted config only,
    // and Express was failing to match the 3-segment path when the
    // client sent the placeholder `_check/validate` (2 segments).
    it('returns parsed issues from the CLI', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue(
        JSON.stringify([
          {
            field: 'agents.unknown',
            severity: 'error',
            message: 'Unknown agent',
          },
        ]),
      );
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/validate',
        { config: { agents: {} } },
      );
      expect(status).toBe(200);
      expect(body.issues).toHaveLength(1);
    });

    it('rejects non-object config (400)', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/validate',
        { config: 'not-an-object' },
      );
      expect(status).toBe(400);
    });

    it('does not collide with `POST /templates/:tier` (creating a "validate" tier)', async () => {
      // Guard against route-order regressions: if `/templates/:tier`
      // is registered before `/templates/validate`, Express captures
      // "validate" as a tier slug and the validate POST disappears.
      const app = await createTestApp(projectRoot);
      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/validate',
        { config: { stages: {} } },
      );
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  // ─── POST /templates/import ───────────────────────────────────────

  describe('POST /templates/import', () => {
    it('delegates with --scope <dst_tier>', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/import',
        {
          bundle: { templates: [{ id: 'imp', name: 'Imp', config: {} }] },
          dst_tier: 'project',
        },
      );
      expect(status).toBe(200);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args[0]).toBe('templates');
      expect(args[1]).toBe('import');
      expect(args).toContain('--scope');
      expect(args[args.indexOf('--scope') + 1]).toBe('project');
      expect(args).toContain('--non-interactive');
    });

    it('rejects dst_tier=builtin with 405', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/import',
        {
          bundle: { templates: [] },
          dst_tier: 'builtin',
        },
      );
      expect(status).toBe(405);
    });

    it('rejects invalid dst_tier (400)', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/import',
        { bundle: { templates: [] }, dst_tier: 'nope' },
      );
      expect(status).toBe(400);
    });
  });

  // ─── PUT /default-template ────────────────────────────────────────

  describe('PUT /default-template', () => {
    it('writes worca.default_template as {tier, id}', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        { tier: 'project', id: 'my-default' },
      );
      expect(status).toBe(200);
      const settings = JSON.parse(
        readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8'),
      );
      expect(settings.worca.default_template).toEqual({
        tier: 'project',
        id: 'my-default',
      });
    });

    it('clears the default when both tier and id are null', async () => {
      const app = await createTestApp(projectRoot);
      writeFileSync(
        join(projectRoot, '.claude', 'settings.json'),
        JSON.stringify({
          worca: { default_template: { tier: 'project', id: 'old' } },
        }),
      );
      const { status } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        { tier: null, id: null },
      );
      expect(status).toBe(200);
      const settings = JSON.parse(
        readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8'),
      );
      expect(settings.worca.default_template).toBeUndefined();
    });

    it('rejects invalid tier (400)', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        { tier: 'whatever', id: 'foo' },
      );
      expect(status).toBe(400);
    });

    it('rejects invalid id (400)', async () => {
      const app = await createTestApp(projectRoot);
      const { status } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        { tier: 'project', id: 'INVALID!' },
      );
      expect(status).toBe(400);
    });
  });

  // ─── Read paths never invoke the CLI ──────────────────────────────

  it('GET /templates does not invoke the CLI', async () => {
    const app = await createTestApp(projectRoot);
    seedProject('sample');
    await request(app, 'GET', '/api/projects/test/templates');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('GET /templates/:tier/:id does not invoke the CLI', async () => {
    const app = await createTestApp(projectRoot);
    seedProject('sample');
    await request(app, 'GET', '/api/projects/test/templates/project/sample');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  // ─── POST /templates/import — zip binary path ──────────────────────

  describe('POST /templates/import — zip binary path', () => {
    // Minimal valid empty-zip sentinel (empty central directory)
    const EMPTY_ZIP = Buffer.from([
      0x50,
      0x4b,
      0x05,
      0x06, // End of central directory signature
      0x00,
      0x00, // disk number
      0x00,
      0x00, // start disk
      0x00,
      0x00, // entries on disk
      0x00,
      0x00, // total entries
      0x00,
      0x00,
      0x00,
      0x00, // central directory size
      0x00,
      0x00,
      0x00,
      0x00, // central directory offset
      0x00,
      0x00, // comment length
    ]);

    it('happy-path zip import returns 200 with structured summary', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue('');

      const { status, body } = await requestBinary(
        app,
        'POST',
        '/api/projects/test/templates/import?dst_tier=project',
        EMPTY_ZIP,
        'application/zip',
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args[0]).toBe('templates');
      expect(args[1]).toBe('import');
      expect(args).toContain('--from');
      // Verify it passes scope
      expect(args).toContain('--scope');
      expect(args[args.indexOf('--scope') + 1]).toBe('project');
      expect(args).toContain('--non-interactive');
      // The --from path must point to a .zip file
      const fromPath = args[args.indexOf('--from') + 1];
      expect(fromPath).toMatch(/\.zip$/);
    });

    it('rejects oversized zip body (>1 MiB) at middleware layer', async () => {
      const app = await createTestApp(projectRoot);

      // 1.1 MiB — exceeds the 1mb limit on expressRaw
      const bigBuffer = Buffer.alloc(Math.ceil(1.1 * 1024 * 1024), 0x50);

      const { status } = await requestBinary(
        app,
        'POST',
        '/api/projects/test/templates/import?dst_tier=project',
        bigBuffer,
        'application/zip',
      );

      // Express raw middleware sends 413 when the body exceeds limit
      expect(status).toBe(413);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('malformed zip → CLI exits non-zero → 400', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockImplementation(() => {
        throw cliError('invalid zip: not a valid zip archive');
      });

      const { status, body } = await requestBinary(
        app,
        'POST',
        '/api/projects/test/templates/import?dst_tier=project',
        EMPTY_ZIP,
        'application/zip',
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toBeTruthy();
      expect(body.code).toBe('validation_error');
    });

    it('rejects dst_tier=builtin via zip path with 405', async () => {
      const app = await createTestApp(projectRoot);

      const { status } = await requestBinary(
        app,
        'POST',
        '/api/projects/test/templates/import?dst_tier=builtin',
        EMPTY_ZIP,
        'application/zip',
      );

      expect(status).toBe(405);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('rejects invalid dst_tier via zip path with 400', async () => {
      const app = await createTestApp(projectRoot);

      const { status } = await requestBinary(
        app,
        'POST',
        '/api/projects/test/templates/import?dst_tier=nope',
        EMPTY_ZIP,
        'application/zip',
      );

      expect(status).toBe(400);
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  // ─── GET /templates/:tier/:id/overlays ─────────────────────────────

  describe('GET /templates/:tier/:id/overlays', () => {
    it('returns md files from agents/ directory', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('tpl-overlays');
      const agentsDir = join(templatesDir, 'tpl-overlays', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'planner.md'), '# Planner overlay');
      writeFileSync(join(agentsDir, 'plan.block.md'), '# Block content');
      // Non-md file that must be excluded
      writeFileSync(join(agentsDir, 'ignored.txt'), 'not overlay');

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/project/tpl-overlays/overlays',
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(Object.keys(body.overlays).sort()).toEqual([
        'plan.block.md',
        'planner.md',
      ]);
      expect(body.overlays['planner.md']).toBe('# Planner overlay');
      expect(body.overlays['plan.block.md']).toBe('# Block content');
    });

    it('returns empty overlays object when no agents/ directory', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('no-overlays');

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/project/no-overlays/overlays',
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.overlays).toEqual({});
    });

    it('returns 404 for unknown template', async () => {
      const app = await createTestApp(projectRoot);

      const { status } = await request(
        app,
        'GET',
        '/api/projects/test/templates/project/missing/overlays',
      );

      expect(status).toBe(404);
    });

    it('does not invoke the CLI', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('no-cli-tpl');

      await request(
        app,
        'GET',
        '/api/projects/test/templates/project/no-cli-tpl/overlays',
      );

      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  // ─── has_overlays in GET /templates list ───────────────────────────

  describe('GET /templates list — has_overlays field', () => {
    it('includes has_overlays boolean for each template', async () => {
      const app = await createTestApp(projectRoot);

      seedProject('plain');
      seedProject('with-overlays');
      const agentsDir = join(templatesDir, 'with-overlays', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'planner.md'), '# Planner');

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates',
      );

      expect(status).toBe(200);
      const plain = body.templates.find((t) => t.id === 'plain');
      const withOverlays = body.templates.find((t) => t.id === 'with-overlays');
      expect(plain.has_overlays).toBe(false);
      expect(withOverlays.has_overlays).toBe(true);
    });

    it('has_overlays is false when agents/ exists but has no md files', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('empty-agents');
      const agentsDir = join(templatesDir, 'empty-agents', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'readme.txt'), 'not an overlay');

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates',
      );

      expect(status).toBe(200);
      const t = body.templates.find((t) => t.id === 'empty-agents');
      expect(t.has_overlays).toBe(false);
    });
  });
});
