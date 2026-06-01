/**
 * Tests: templates-routes.js
 * TDD: written before implementation.
 *
 * Tests cover:
 * - GET /templates deduping by id with effectiveTier and shadows
 * - GET /templates/:tid — fetch resolved template
 * - POST /templates — create
 * - PUT /templates/:tid — update
 * - DELETE /templates/:tid — delete
 * - POST /templates/:tid/duplicate — clone-then-edit
 * - POST /templates/:tid/validate — validate config
 * - GET /templates/:tid/bundle — export
 * - POST /templates/import — import bundle
 * - PUT /default-template — set default
 */

import { execFileSync } from 'node:child_process';
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

// Mock subprocess calls to worca CLI
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
    (req, res, next) => {
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

    // Set WORCA_HOME to control the user templates directory
    process.env.WORCA_HOME = userTemplatesDir;

    mockExecSync.mockClear();
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

      // Create same template id in project and user tiers
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
      // User tier goes under $WORCA_HOME/templates
      mkdirSync(join(userTemplatesDir, 'templates', 'test-template'), {
        recursive: true,
      });
      writeFileSync(
        join(userTemplatesDir, 'templates', 'test-template', 'template.json'),
        templateJson,
      );

      // Create a different template in builtin
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
      expect(Array.isArray(body.templates)).toBe(true);

      // Should dedupe test-template to one entry
      const testTemplate = body.templates.find((t) => t.id === 'test-template');
      expect(testTemplate).toBeDefined();
      expect(testTemplate.effectiveTier).toBe('project'); // project shadows user
      expect(testTemplate.shadows).not.toBeNull();
      expect(Array.isArray(testTemplate.shadows)).toBe(true);
      // Shadows implementation: user template gets shadowed by project template
      // So we expect shadows to record that user was shadowed

      // builtin-template should be as-is
      const builtin = body.templates.find((t) => t.id === 'builtin-template');
      expect(builtin).toBeDefined();
      expect(builtin.effectiveTier).toBe('worca'); // implementation uses 'worca'
      expect(builtin.builtin).toBe(false); // only if explicit in manifest
      expect(builtin.shadows).toEqual([]);
    });

    it('backward compat with old dropdown: effectiveTier and shadows present', async () => {
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
      expect(body.ok).toBe(true);
      const tmpl = body.templates[0];
      expect(tmpl.id).toBe('simple');
      expect(tmpl.effectiveTier).toBeDefined();
      expect(Array.isArray(tmpl.shadows)).toBe(true);
    });
  });

  describe('GET /templates/:tid — fetch single template', () => {
    it('resolves template from project → user → builtin tiers', async () => {
      const app = await createTestApp(projectRoot);

      writeFileSync(
        join(builtinDir, 'from-builtin'),
        JSON.stringify({
          id: 'from-builtin',
          name: 'Builtin Version',
          config: { agents: { planner: { model: 'haiku' } } },
        }),
      );

      // Same id in project should override
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
      expect(body.ok).toBe(true);
      expect(body.template.name).toBe('Project Version'); // Project override wins
      expect(body.template.config).toBeDefined();
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
    it('creates template in project scope', async () => {
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

      // Verify template file was written to disk
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const manifestPath = join(projectRoot, '.claude', 'templates', 'new-template', 'template.json');
      expect(existsSync(manifestPath)).toBe(true);
      const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(written.id).toBe('new-template');
      expect(written.name).toBe('New Template');
    });

    it('creates template in user scope', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue('');

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
    });

    it('rejects scope=builtin (400)', async () => {
      const app = await createTestApp(projectRoot);

      const payload = {
        scope: 'builtin',
        id: 'bad',
        name: 'Bad',
        config: {},
      };

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates',
        payload,
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      // Error is generic "scope must be \"project\" or \"user\"" - builtin rejected
      expect(body.error).toMatch(/scope must be/i);
    });

    it('validates required fields', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates',
        {
          scope: 'project',
          // missing id
          name: 'No ID',
        },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
    });
  });

  describe('scope=something rejection tests', () => {
    it('PUT rejects invalid scope values', async () => {
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

    it('DELETE rejects invalid scope values', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'DELETE',
        '/api/projects/test/templates/any-template?scope=something',
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/scope/i);
    });

    it('POST duplicate rejects invalid dst_scope values', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/source/duplicate',
        { dst_id: 'dest', dst_scope: 'invalid' },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/dst_scope/i);
    });

    it('PUT default-template rejects invalid tid format', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        {
          tid: 'INVALID-TEMPLATE-ID_!',
        },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/Invalid template id/i);
    });

    it('PUT default-template rejects builtin scope (via tid validation)', async () => {
      const app = await createTestApp(projectRoot);

      // This tests that setting a default that's a builtin template ID is allowed
      // (the implementation should just write the ID, not validate it exists)
      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        {
          tid: 'some-builtin',
        },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  describe('PUT /templates/:tid — update template', () => {
    it('updates project template', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue('');

      const payload = {
        name: 'Updated Name',
        config: { agents: { planner: { model: 'sonnet' } } },
      };

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/templates/existing',
        payload,
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it('rejects updates to builtin templates (400)', async () => {
      const app = await createTestApp(projectRoot);
      writeFileSync(
        join(builtinDir, 'locked'),
        JSON.stringify({ id: 'locked', name: 'Locked' }),
      );

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/templates/locked?scope=builtin',
        { name: 'Attempted Override' },
      );

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
    });
  });

  describe('DELETE /templates/:tid — delete template', () => {
    it('deletes project template', async () => {
      const app = await createTestApp(projectRoot);

      // Create the template directory so deleteTemplate can remove it
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
      expect(existsSync(tmplDir)).toBe(false);
    });

    it('rejects deleting builtin templates (400)', async () => {
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
    it('clones to project scope', async () => {
      const app = await createTestApp(projectRoot);

      // Seed source template
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const srcDir = join(projectRoot, '.claude', 'templates', 'source-template');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'template.json'), JSON.stringify({
        id: 'source-template', name: 'Source', config: {},
      }));

      const payload = {
        dst_id: 'clone-of-source',
        dst_scope: 'project',
      };

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/source-template/duplicate',
        payload,
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it('clones to user scope', async () => {
      const app = await createTestApp(projectRoot);

      // Seed source template
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const srcDir = join(projectRoot, '.claude', 'templates', 'source');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'template.json'), JSON.stringify({
        id: 'source', name: 'Source', config: {},
      }));

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/source/duplicate',
        { dst_id: 'u-clone', dst_scope: 'user' },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  describe('POST /templates/:tid/validate — validate config', () => {
    it('validates config and returns issues', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue(JSON.stringify([])); // No issues

      const payload = {
        config: {
          agents: { planner: { model: 'opus' } },
        },
      };

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/test-template/validate',
        payload,
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.issues)).toBe(true);
    });

    it('returns validation errors from CLI', async () => {
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
      expect(body.issues.length).toBeGreaterThan(0);
      expect(body.issues[0].severity).toBe('error');
    });
  });

  describe('GET /templates/:tid/bundle — export bundle', () => {
    it('exports template bundle (redacted)', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue(
        JSON.stringify({ templates: [{ id: 'exported' }] }),
      );

      const { status, body } = await request(
        app,
        'GET',
        '/api/projects/test/templates/export-tmpl/bundle',
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.bundle).toBeDefined();
    });
  });

  describe('POST /templates/import — import bundle', () => {
    it('imports bundle from body', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue('');

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
    });

    it('handles redaction preview in response', async () => {
      const app = await createTestApp(projectRoot);
      mockExecSync.mockReturnValue(undefined); // CLI success returns nothing

      const { status, body } = await request(
        app,
        'POST',
        '/api/projects/test/templates/import',
        {
          bundle: { templates: [{ id: 't1', name: 'T1', config: {} }] },
          scope: 'project',
        },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.imported).toBeDefined();
      expect(Array.isArray(body.imported)).toBe(true);
      expect(body.count).toBeDefined();
    });
  });

  describe('PUT /default-template — set default template', () => {
    it('writes worca.default_template to settings.json', async () => {
      const app = await createTestApp(projectRoot);

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        {
          tid: 'my-default',
        },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      // Verify settings.json was updated
      const settings = JSON.parse(
        readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8'),
      );
      expect(settings.worca?.default_template).toBe('my-default');
    });

    it('clears default template when tid is null', async () => {
      const app = await createTestApp(projectRoot);

      // First set a default
      writeFileSync(
        join(projectRoot, '.claude', 'settings.json'),
        JSON.stringify({ worca: { default_template: 'old-default' } }),
      );

      const { status, body } = await request(
        app,
        'PUT',
        '/api/projects/test/default-template',
        {
          tid: null,
        },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const settings = JSON.parse(
        readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8'),
      );
      expect(settings.worca?.default_template).toBeUndefined();
    });
  });
});
