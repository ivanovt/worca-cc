/**
 * Tests: POST /templates/advise — Suggest Template button endpoint.
 *
 * Mutations delegate to `worca templates advise`; we mock execFileSync and
 * assert on CLI args + HTTP shape.
 */

import { mkdirSync, rmSync } from 'node:fs';
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

function createTestApp(projectRoot) {
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

function cliOk(stdout) {
  return stdout;
}

function cliError(stderr) {
  const err = new Error('Command failed');
  err.status = 1;
  err.stderr = Buffer.from(stderr);
  err.stdout = Buffer.from('');
  return err;
}

describe('POST /templates/advise', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = join(
      tmpdir(),
      `worca-advise-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(projectRoot, { recursive: true });
    mockExecSync.mockReset();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns the advisor payload on success', async () => {
    mockExecSync.mockReturnValueOnce(
      cliOk(
        JSON.stringify({
          template_id: 'bugfix',
          rationale: 'bug language and tight scope',
          confidence: 'high',
          alternatives: [],
        }),
      ),
    );
    const app = createTestApp(projectRoot);
    const res = await request(
      app,
      'POST',
      '/api/projects/p1/templates/advise',
      {
        sourceType: 'none',
        sourceValue: 'Fix the broken login flow',
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.advice.template_id).toBe('bugfix');
    expect(res.body.advice.confidence).toBe('high');
  });

  it('maps launcher "none" → backend "prompt" on the CLI', async () => {
    mockExecSync.mockReturnValueOnce(
      cliOk(
        JSON.stringify({
          template_id: 'bugfix',
          rationale: 'x',
          confidence: 'high',
        }),
      ),
    );
    const app = createTestApp(projectRoot);
    await request(app, 'POST', '/api/projects/p1/templates/advise', {
      sourceType: 'none',
      sourceValue: 'do a thing',
    });
    const args = mockExecSync.mock.calls[0][1];
    expect(args).toContain('advise');
    const idx = args.indexOf('--source-type');
    expect(args[idx + 1]).toBe('prompt');
  });

  it('streams the prompt text via stdin to avoid argv blow-up', async () => {
    mockExecSync.mockReturnValueOnce(
      cliOk(
        JSON.stringify({
          template_id: 'bugfix',
          rationale: 'x',
          confidence: 'high',
        }),
      ),
    );
    const longPrompt = 'a'.repeat(20000);
    const app = createTestApp(projectRoot);
    await request(app, 'POST', '/api/projects/p1/templates/advise', {
      sourceType: 'none',
      sourceValue: longPrompt,
    });
    const args = mockExecSync.mock.calls[0][1];
    const idx = args.indexOf('--source-value');
    expect(args[idx + 1]).toBe('-');
    const opts = mockExecSync.mock.calls[0][2];
    expect(opts.input).toBe(longPrompt);
  });

  it('accepts each launcher source type', async () => {
    const app = createTestApp(projectRoot);
    for (const sourceType of ['spec', 'source', 'pr']) {
      mockExecSync.mockReturnValueOnce(
        cliOk(
          JSON.stringify({
            template_id: 'bugfix',
            rationale: 'x',
            confidence: 'high',
          }),
        ),
      );
      const res = await request(
        app,
        'POST',
        '/api/projects/p1/templates/advise',
        { sourceType, sourceValue: 'some-value' },
      );
      expect(res.status).toBe(200);
    }
  });

  it('rejects missing sourceType', async () => {
    const app = createTestApp(projectRoot);
    const res = await request(
      app,
      'POST',
      '/api/projects/p1/templates/advise',
      {
        sourceValue: 'x',
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sourceType/);
  });

  it('rejects unknown sourceType', async () => {
    const app = createTestApp(projectRoot);
    const res = await request(
      app,
      'POST',
      '/api/projects/p1/templates/advise',
      {
        sourceType: 'bogus',
        sourceValue: 'x',
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be one of/);
  });

  it('rejects empty prompt', async () => {
    const app = createTestApp(projectRoot);
    const res = await request(
      app,
      'POST',
      '/api/projects/p1/templates/advise',
      {
        sourceType: 'none',
        sourceValue: '   ',
      },
    );
    expect(res.status).toBe(400);
  });

  it('rejects empty source value for non-prompt sources', async () => {
    const app = createTestApp(projectRoot);
    const res = await request(
      app,
      'POST',
      '/api/projects/p1/templates/advise',
      {
        sourceType: 'source',
        sourceValue: '',
      },
    );
    expect(res.status).toBe(400);
  });

  it('passes the model alias through to the CLI', async () => {
    mockExecSync.mockReturnValueOnce(
      cliOk(
        JSON.stringify({
          template_id: 'bugfix',
          rationale: 'x',
          confidence: 'high',
        }),
      ),
    );
    const app = createTestApp(projectRoot);
    await request(app, 'POST', '/api/projects/p1/templates/advise', {
      sourceType: 'none',
      sourceValue: 'x',
      model: 'opus',
    });
    const args = mockExecSync.mock.calls[0][1];
    const idx = args.indexOf('--model');
    expect(args[idx + 1]).toBe('opus');
  });

  it('defaults to sonnet when no model is provided', async () => {
    mockExecSync.mockReturnValueOnce(
      cliOk(
        JSON.stringify({
          template_id: 'bugfix',
          rationale: 'x',
          confidence: 'high',
        }),
      ),
    );
    const app = createTestApp(projectRoot);
    await request(app, 'POST', '/api/projects/p1/templates/advise', {
      sourceType: 'none',
      sourceValue: 'x',
    });
    const args = mockExecSync.mock.calls[0][1];
    const idx = args.indexOf('--model');
    expect(args[idx + 1]).toBe('sonnet');
  });

  it('surfaces CLI errors as 500 with the error text', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw cliError('claude CLI exited 1: boom');
    });
    const app = createTestApp(projectRoot);
    const res = await request(
      app,
      'POST',
      '/api/projects/p1/templates/advise',
      {
        sourceType: 'none',
        sourceValue: 'x',
      },
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/boom/);
  });
});
