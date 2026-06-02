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
    it('composes duplicate + delete on the CLI', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('old-id');
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/old-id/rename',
        { dst_tier: 'project', dst_id: 'new-id' },
      );
      expect(status).toBe(200);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
      const dup = templateArgs(mockExecSync.mock.calls[0]);
      expect(dup.slice(0, 2)).toEqual(['templates', 'duplicate']);
      expect(dup).toContain('new-id');
      const del = templateArgs(mockExecSync.mock.calls[1]);
      expect(del.slice(0, 3)).toEqual(['templates', 'delete', 'old-id']);
    });

    it('passes --global on delete when moving project → user', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('cross-tier');
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/project/cross-tier/rename',
        { dst_tier: 'user', dst_id: 'cross-tier' },
      );
      expect(status).toBe(200);
      const dup = templateArgs(mockExecSync.mock.calls[0]);
      expect(dup).toContain('--dst-scope');
      expect(dup[dup.indexOf('--dst-scope') + 1]).toBe('user');
      const del = templateArgs(mockExecSync.mock.calls[1]);
      // src tier was project — no --global on the delete leg
      expect(del).not.toContain('--global');
    });

    it('passes --global on delete when src is user', async () => {
      const app = await createTestApp(projectRoot);
      seedUser('user-src');
      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/user/user-src/rename',
        { dst_tier: 'project', dst_id: 'user-src' },
      );
      expect(status).toBe(200);
      const del = templateArgs(mockExecSync.mock.calls[1]);
      expect(del).toContain('--global');
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

    it('surfaces partial_rename when delete fails after duplicate', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('half');
      let n = 0;
      mockExecSync.mockImplementation(() => {
        n++;
        if (n === 1) return '';
        throw cliError('delete blew up');
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
    });
  });

  // ─── POST /templates/:tier/:id/validate ───────────────────────────

  describe('POST /templates/:tier/:id/validate', () => {
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
        '/api/projects/test/templates/project/tmpl/validate',
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
        '/api/projects/test/templates/project/x/validate',
        { config: 'not-an-object' },
      );
      expect(status).toBe(400);
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
});
