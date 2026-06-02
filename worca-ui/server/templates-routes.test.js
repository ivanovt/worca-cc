/**
 * Tests: templates-routes.js
 *
 * The routes delegate all mutations (create/update/delete/duplicate/import)
 * to the `worca templates` CLI via execFileSync; tests mock that subprocess
 * and assert on (a) the CLI invocation arguments and (b) the resulting HTTP
 * status/body. Read paths (GET /templates, GET /templates/:tid) and
 * default-template settings writes go through the filesystem directly, so
 * those tests still touch real files in tmpdir.
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

// Mock the CLI subprocess. Each test can override mockExecSync.mockImplementation
// to simulate success (returns stdout string) or failure (throws with .stderr).
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

/** Helper: build a fake execFileSync error matching child_process error shape. */
function cliError(stderr, stdout = '') {
  const err = new Error('Command failed');
  err.status = 1;
  err.stderr = Buffer.from(stderr);
  err.stdout = Buffer.from(stdout);
  return err;
}

/**
 * Helper: pull the args array passed to `worca templates …` on call N.
 *
 * The route handler always inserts `--project-root <projectRoot>` after
 * `templates` so the CLI doesn't need a `.git` walk. We strip that
 * scaffolding here so individual tests can assert against the
 * subcommand and its flags without re-encoding the project path each
 * time. `rawArgs(call)` returns the unmodified args if a test needs
 * to verify the scaffolding itself.
 */
function templateArgs(call) {
  // execFileSync signature: (file, args, opts) → call[1] is the args array
  const args = call[1];
  // Expected prefix: ['templates', '--project-root', <root>, …]
  if (args[0] === 'templates' && args[1] === '--project-root') {
    return ['templates', ...args.slice(3)];
  }
  return args;
}

function rawArgs(call) {
  return call[1];
}

describe('templates-routes', () => {
  let projectRoot;
  let templatesDir;
  let userTemplatesDir;
  let builtinDir;
  let originalWorcaHome;

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
    // Default: any CLI call succeeds with empty stdout. Individual tests
    // override for specific scenarios (validate output, conflict, etc.).
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
      /* ignore cleanup errors in tmpdir */
    }
  });

  describe('GET /templates — list with deduping', () => {
    it('dedupes by id with effectiveTier and shadows', async () => {
      const app = await createTestApp(projectRoot);

      const templateJson = JSON.stringify({
        id: 'test-template',
        name: 'Test Template',
        description: 'Test',
        config: { agents: { planner: { model: 'opus' } } },
      });

      mkdirSync(join(templatesDir, 'test-template'), { recursive: true });
      writeFileSync(
        join(templatesDir, 'test-template', 'template.json'),
        templateJson,
      );
      mkdirSync(join(userTemplatesDir, 'templates', 'test-template'), {
        recursive: true,
      });
      writeFileSync(
        join(userTemplatesDir, 'templates', 'test-template', 'template.json'),
        templateJson,
      );

      mkdirSync(join(builtinDir, 'builtin-template'), { recursive: true });
      writeFileSync(
        join(builtinDir, 'builtin-template', 'template.json'),
        JSON.stringify({ id: 'builtin-template', name: 'Builtin' }),
      );

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates',
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      // Project wins over user; user is recorded as shadowed.
      const testTemplate = body.templates.find((t) => t.id === 'test-template');
      expect(testTemplate).toBeDefined();
      expect(testTemplate.effectiveTier).toBe('project');
      expect(testTemplate.shadows).toEqual(['user']);

      // Builtin-only template: tier label matches Python's 'builtin'.
      const builtin = body.templates.find((t) => t.id === 'builtin-template');
      expect(builtin).toBeDefined();
      expect(builtin.effectiveTier).toBe('builtin');
      expect(builtin.shadows).toEqual([]);
    });

    it('records all lower-priority tiers in shadows when id exists in all three', async () => {
      const app = await createTestApp(projectRoot);

      const manifest = (id) => JSON.stringify({ id, name: id });

      mkdirSync(join(templatesDir, 'everywhere'), { recursive: true });
      writeFileSync(
        join(templatesDir, 'everywhere', 'template.json'),
        manifest('everywhere'),
      );
      mkdirSync(join(userTemplatesDir, 'templates', 'everywhere'), {
        recursive: true,
      });
      writeFileSync(
        join(userTemplatesDir, 'templates', 'everywhere', 'template.json'),
        manifest('everywhere'),
      );
      mkdirSync(join(builtinDir, 'everywhere'), { recursive: true });
      writeFileSync(
        join(builtinDir, 'everywhere', 'template.json'),
        manifest('everywhere'),
      );

      const { body } = await request(
        app,
        'GET',
        '/api/projects/test/templates',
      );

      const t = body.templates.find((x) => x.id === 'everywhere');
      expect(t.effectiveTier).toBe('project');
      // Order is priority order with the winner sliced off:
      expect(t.shadows).toEqual(['user', 'builtin']);
    });

    it('exposes effectiveTier and shadows on every entry', async () => {
      const app = await createTestApp(projectRoot);

      mkdirSync(join(templatesDir, 'simple'), { recursive: true });
      writeFileSync(
        join(templatesDir, 'simple', 'template.json'),
        JSON.stringify({ id: 'simple', name: 'Simple' }),
      );

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates',
      );

      expect(status).toBe(200);
      const tmpl = body.templates[0];
      expect(tmpl.id).toBe('simple');
      expect(tmpl.effectiveTier).toBe('project');
      expect(Array.isArray(tmpl.shadows)).toBe(true);
    });
  });

  describe('GET /templates/:tid — fetch single template', () => {
    it('resolves project → user → builtin (project wins)', async () => {
      const app = await createTestApp(projectRoot);

      mkdirSync(join(builtinDir, 'from-builtin'), { recursive: true });
      writeFileSync(
        join(builtinDir, 'from-builtin', 'template.json'),
        JSON.stringify({
          id: 'from-builtin',
          name: 'Builtin Version',
          config: { agents: { planner: { model: 'haiku' } } },
        }),
      );

      mkdirSync(join(templatesDir, 'from-builtin'), { recursive: true });
      writeFileSync(
        join(templatesDir, 'from-builtin', 'template.json'),
        JSON.stringify({
          id: 'from-builtin',
          name: 'Project Version',
          config: { agents: { planner: { model: 'sonnet' } } },
        }),
      );

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/from-builtin',
      );

      expect(status).toBe(200);
      expect(body.template.name).toBe('Project Version');
      expect(body.tier).toBe('project');
    });

    it('honors ?tier=builtin to fetch the shadowed built-in', async () => {
      const app = await createTestApp(projectRoot);

      mkdirSync(join(builtinDir, 'shadowed'), { recursive: true });
      writeFileSync(
        join(builtinDir, 'shadowed', 'template.json'),
        JSON.stringify({ id: 'shadowed', name: 'Builtin Version' }),
      );
      mkdirSync(join(templatesDir, 'shadowed'), { recursive: true });
      writeFileSync(
        join(templatesDir, 'shadowed', 'template.json'),
        JSON.stringify({ id: 'shadowed', name: 'Project Override' }),
      );

      const { body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/shadowed?tier=builtin',
      );

      expect(body.template.name).toBe('Builtin Version');
      expect(body.tier).toBe('builtin');
    });

    it('accepts ids with underscores (e.g. worca init`s _legacy-settings)', async () => {
      // Regression: TEMPLATE_RE used to be /^[a-z0-9-]{1,64}$/ which rejected
      // the auto-migrated `_legacy-settings` template id with a 400, even
      // though it exists on disk after `worca init --upgrade`.
      const app = await createTestApp(projectRoot);
      mkdirSync(join(templatesDir, '_legacy-settings'), { recursive: true });
      writeFileSync(
        join(templatesDir, '_legacy-settings', 'template.json'),
        JSON.stringify({ id: '_legacy-settings', name: 'Legacy' }),
      );

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/_legacy-settings',
      );
      expect(status).toBe(200);
      expect(body.template.name).toBe('Legacy');
    });

    it('accepts the deprecated ?tier=worca alias for ?tier=builtin', async () => {
      const app = await createTestApp(projectRoot);

      mkdirSync(join(builtinDir, 'legacy'), { recursive: true });
      writeFileSync(
        join(builtinDir, 'legacy', 'template.json'),
        JSON.stringify({ id: 'legacy', name: 'Builtin Legacy' }),
      );

      const { body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/legacy?tier=worca',
      );

      expect(body.template.name).toBe('Builtin Legacy');
      expect(body.tier).toBe('builtin');
    });

    it('returns 404 for non-existent template', async () => {
      const app = await createTestApp(projectRoot);
      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/missing',
      );
      expect(status).toBe(404);
      expect(body.ok).toBe(false);
    });
  });

  describe('POST /templates — create template', () => {
    it('passes --project-root to the CLI so non-git project roots resolve correctly', async () => {
      const app = await createTestApp(projectRoot);
      await request(app, 'POST', '/api/projects/test/templates', {
        scope: 'project',
        id: 'flag-check',
        name: 'Flag Check',
        config: {},
      });
      const raw = rawArgs(mockExecSync.mock.calls[0]);
      const flagIdx = raw.indexOf('--project-root');
      expect(flagIdx).toBe(1);
      expect(raw[flagIdx + 1]).toBe(projectRoot);
    });

    it('delegates to `worca templates create --from-file <path>` in project scope', async () => {
      const app = await createTestApp(projectRoot);

      const payload = {
        scope: 'project',
        id: 'new-template',
        name: 'New Template',
        description: 'A test template',
        config: { agents: { planner: { model: 'opus' } } },
      };

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates',
        payload,
      );

      expect(status).toBe(201);
      expect(body.ok).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args[0]).toBe('templates');
      expect(args[1]).toBe('create');
      expect(args[2]).toBe('--from-file');
      // Should NOT pass --global for project scope.
      expect(args).not.toContain('--global');
    });

    it('passes --global to the CLI for user scope', async () => {
      const app = await createTestApp(projectRoot);

      const payload = {
        scope: 'user',
        id: 'user-template',
        name: 'User Template',
        config: {},
      };

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates',
        payload,
      );

      expect(status).toBe(201);
      expect(body.ok).toBe(true);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toContain('--global');
    });

    it('returns 409 when the id already exists in any tier', async () => {
      const app = await createTestApp(projectRoot);

      mkdirSync(join(templatesDir, 'exists'), { recursive: true });
      writeFileSync(
        join(templatesDir, 'exists', 'template.json'),
        JSON.stringify({ id: 'exists', name: 'Exists' }),
      );

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates',
        { scope: 'project', id: 'exists', name: 'Dup' },
      );

      expect(status).toBe(409);
      expect(body.ok).toBe(false);
      // CLI must not be invoked when the existence check fails up front.
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('rejects scope=builtin (400)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates',
        { scope: 'builtin', id: 'bad', name: 'Bad', config: {} },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/scope must be/i);
    });

    it('validates required fields', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates',
        { scope: 'project', name: 'No ID' },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
    });
  });

  describe('PUT /templates/:tid — upsert template', () => {
    it('delegates to `worca templates create` for project-scope upsert', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/templates/existing',
        { name: 'Updated Name', config: {} },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args.slice(0, 3)).toEqual(['templates', 'create', '--from-file']);
      expect(args).not.toContain('--global');
    });

    it('rejects invalid scope values (400)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/templates/any-template?scope=something',
        { name: 'test' },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/scope/i);
    });
  });

  describe('DELETE /templates/:tid — delete template', () => {
    it('delegates to `worca templates delete <id>` for project scope', async () => {
      const app = await createTestApp(projectRoot);

      const tmplDir = join(projectRoot, '.claude', 'templates', 'project-tmpl');
      mkdirSync(tmplDir, { recursive: true });
      writeFileSync(
        join(tmplDir, 'template.json'),
        JSON.stringify({ id: 'project-tmpl', name: 'Project Template' }),
      );

      const { status, body } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/project-tmpl?scope=project',
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toEqual(['templates', 'delete', 'project-tmpl']);
    });

    it('passes --global to the CLI for user-scope delete', async () => {
      const app = await createTestApp(projectRoot);

      const userTmplDir = join(userTemplatesDir, 'templates', 'user-tmpl');
      mkdirSync(userTmplDir, { recursive: true });
      writeFileSync(
        join(userTmplDir, 'template.json'),
        JSON.stringify({ id: 'user-tmpl', name: 'User Template' }),
      );

      const { status } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/user-tmpl?scope=user',
      );

      expect(status).toBe(200);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toEqual(['templates', 'delete', 'user-tmpl', '--global']);
    });

    it('returns 404 if the template is not present in the named scope', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/missing?scope=project',
      );

      expect(status).toBe(404);
      expect(body.ok).toBe(false);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('rejects invalid scope values (400)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/any-template?scope=something',
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
    });

    it('rejects scope=builtin (400)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/builtin-tmpl?scope=builtin',
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
    });
  });

  describe('POST /templates/:tid/duplicate — clone template', () => {
    it('delegates to `worca templates duplicate` for project destination', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/source/duplicate',
        { dst_id: 'clone-of-source', dst_scope: 'project' },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args).toEqual([
        'templates',
        'duplicate',
        'source',
        '--dst',
        'clone-of-source',
        '--dst-scope',
        'project',
      ]);
    });

    it('duplicating a built-in to the same id is allowed (canonical shadow flow)', async () => {
      // The UI's "Duplicate" button on a built-in template card sends
      // dst_id == src_id; that's how a user clones a built-in into their
      // project scope to edit it. The CLI must accept this; the server
      // must propagate as 200.
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue('');

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/minimal/duplicate',
        { dst_id: 'minimal', dst_scope: 'project' },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it('maps CLI name_collision to HTTP 409', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockImplementation(() => {
        throw cliError("Template ID 'taken' already exists in project scope.");
      });

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/source/duplicate',
        { dst_id: 'taken', dst_scope: 'project' },
      );

      expect(status).toBe(409);
      expect(body.code).toBe('name_collision');
    });

    it('rejects invalid dst_scope values (400)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/source/duplicate',
        { dst_id: 'dest', dst_scope: 'invalid' },
      );

      expect(status).toBe(400);
      expect(body.error).toMatch(/dst_scope/i);
    });
  });

  describe('POST /templates/:tid/rename — rename / move template', () => {
    function seedProject(id) {
      mkdirSync(join(templatesDir, id), { recursive: true });
      writeFileSync(
        join(templatesDir, id, 'template.json'),
        JSON.stringify({ id, name: id }),
      );
    }

    it('composes duplicate + delete on the CLI', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('old-id');

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/old-id/rename?scope=project',
        { dst_id: 'new-id', dst_scope: 'project' },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockExecSync).toHaveBeenCalledTimes(2);
      const dupArgs = templateArgs(mockExecSync.mock.calls[0]);
      expect(dupArgs.slice(0, 2)).toEqual(['templates', 'duplicate']);
      expect(dupArgs).toContain('--dst');
      expect(dupArgs).toContain('new-id');
      const delArgs = templateArgs(mockExecSync.mock.calls[1]);
      expect(delArgs.slice(0, 3)).toEqual(['templates', 'delete', 'old-id']);
    });

    it('passes --global on the delete leg when moving from user → project', async () => {
      const app = await createTestApp(projectRoot);
      // Seed a user-tier template so the existence check passes.
      mkdirSync(join(userTemplatesDir, 'templates', 'cross-tier'), {
        recursive: true,
      });
      writeFileSync(
        join(userTemplatesDir, 'templates', 'cross-tier', 'template.json'),
        JSON.stringify({ id: 'cross-tier', name: 'Cross Tier' }),
      );

      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/cross-tier/rename?scope=user',
        { dst_id: 'cross-tier', dst_scope: 'project' },
      );

      expect(status).toBe(200);
      const dupArgs = templateArgs(mockExecSync.mock.calls[0]);
      expect(dupArgs).toContain('--dst-scope');
      expect(dupArgs[dupArgs.indexOf('--dst-scope') + 1]).toBe('project');
      const delArgs = templateArgs(mockExecSync.mock.calls[1]);
      expect(delArgs).toContain('--global');
    });

    it('rejects no-op (same id + same scope) with 400', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('static');

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/static/rename?scope=project',
        { dst_id: 'static', dst_scope: 'project' },
      );

      expect(status).toBe(400);
      expect(body.error).toMatch(/no change/i);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('returns 404 if the source does not exist in the named scope', async () => {
      const app = await createTestApp(projectRoot);

      const { status } = await request(
        app,
        'POST',
        '/api/projects/test/templates/ghost/rename?scope=project',
        { dst_id: 'phantom', dst_scope: 'project' },
      );

      expect(status).toBe(404);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('rejects scope=builtin (built-ins are immutable)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/whatever/rename?scope=builtin',
        { dst_id: 'whatever', dst_scope: 'project' },
      );

      expect(status).toBe(400);
      expect(body.error).toMatch(/scope/i);
    });

    it('surfaces partial_rename when duplicate succeeds but delete fails', async () => {
      const app = await createTestApp(projectRoot);
      seedProject('half');
      // First call (duplicate) succeeds; second call (delete) throws.
      let n = 0;
      mockExecSync.mockImplementation(() => {
        n++;
        if (n === 1) return '';
        throw cliError('delete blew up');
      });

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/half/rename?scope=project',
        { dst_id: 'whole', dst_scope: 'project' },
      );

      expect(status).toBe(500);
      expect(body.code).toBe('partial_rename');
      expect(body.error).toMatch(/Renamed to "whole"/);
    });
  });

  describe('POST /templates/:tid/validate — validate config', () => {
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
        '/api/projects/test/templates/tmpl/validate',
        { config: { agents: { bad: {} } } },
      );

      expect(status).toBe(200);
      expect(body.issues).toHaveLength(1);
      expect(body.issues[0].severity).toBe('error');
    });

    it('returns empty issues when the CLI emits an empty array', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue('[]');

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/test-template/validate',
        { config: { agents: { planner: { model: 'opus' } } } },
      );

      expect(status).toBe(200);
      expect(body.issues).toEqual([]);
    });

    it('rejects non-object config (400)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/x/validate',
        { config: 'not-an-object' },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
    });
  });

  describe('POST /templates/import — import bundle', () => {
    it('writes the bundle to a temp file and delegates to `worca templates import`', async () => {
      const app = await createTestApp(projectRoot);

      const payload = {
        bundle: {
          templates: [{ id: 'imported', name: 'Imported', config: {} }],
        },
        scope: 'project',
      };

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/import',
        payload,
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const args = templateArgs(mockExecSync.mock.calls[0]);
      expect(args[0]).toBe('templates');
      expect(args[1]).toBe('import');
      expect(args).toContain('--scope');
      expect(args).toContain('project');
      expect(args).toContain('--non-interactive');
    });

    it('rejects invalid scope (400)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/import',
        { bundle: { templates: [] }, scope: 'whatever' },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
    });
  });

  describe('PUT /default-template — set default template', () => {
    it('writes worca.default_template to settings.json', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        { tid: 'my-default' },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const settings = JSON.parse(
        readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8'),
      );
      expect(settings.worca?.default_template).toBe('my-default');
    });

    it('clears default template when tid is null', async () => {
      const app = await createTestApp(projectRoot);

      writeFileSync(
        join(projectRoot, '.claude', 'settings.json'),
        JSON.stringify({ worca: { default_template: 'old-default' } }),
      );

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        { tid: null },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const settings = JSON.parse(
        readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8'),
      );
      expect(settings.worca?.default_template).toBeUndefined();
    });

    it('rejects invalid tid format (400)', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        { tid: 'INVALID-TEMPLATE-ID_!' },
      );

      expect(status).toBe(400);
      expect(body.error).toMatch(/Invalid template id/i);
    });

    it('accepts any valid tid format without checking existence', async () => {
      // Setting a default that doesn't (yet) resolve to a template is allowed —
      // the writer is a thin shim, not an enforcer.
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        { tid: 'some-future-template' },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  // The Read tests above use real filesystem fixtures (no execFileSync needed).
  // We sanity-check that the mock isn't called on those paths.
  it('GET /templates does not invoke the CLI', async () => {
    const app = await createTestApp(projectRoot);
    mkdirSync(join(templatesDir, 'sample'), { recursive: true });
    writeFileSync(
      join(templatesDir, 'sample', 'template.json'),
      JSON.stringify({ id: 'sample', name: 'Sample' }),
    );
    await request(app, 'GET', '/api/projects/test/templates');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('GET /templates/:tid does not invoke the CLI', async () => {
    const app = await createTestApp(projectRoot);
    mkdirSync(join(templatesDir, 'sample'), { recursive: true });
    writeFileSync(
      join(templatesDir, 'sample', 'template.json'),
      JSON.stringify({ id: 'sample', name: 'Sample' }),
    );
    await request(app, 'GET', '/api/projects/test/templates/sample');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  // Self-check: confirms cleanup didn't leave the project tree dangling.
  it('cleans up project tree between tests', () => {
    expect(existsSync(projectRoot)).toBe(true);
  });
});
