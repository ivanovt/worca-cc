import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import {
  _effectiveConfig,
  _graphStats,
  createGraphifyStatus,
  snapshotDir,
} from './graphify-status.js';

function startServer(opts = {}) {
  const app = createApp(opts);
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({ server, base, app });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ── Unit tests for graphify-status.js helpers ──────────────────────────

describe('_effectiveConfig', () => {
  it('returns disabled with reason when global graphify is off', () => {
    const settings = { worca: {} };
    const result = _effectiveConfig(settings, {});
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('global-off');
  });

  it('returns disabled with project-off when global on but project off', () => {
    const global = { worca: { graphify: { enabled: true } } };
    const project = { worca: { graphify: { enabled: false } } };
    const result = _effectiveConfig(global, project);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('project-off');
  });

  it('returns enabled with merged config when both tiers enable', () => {
    const global = { worca: { graphify: { enabled: true } } };
    const project = { worca: { graphify: { enabled: true, mode: 'full' } } };
    const result = _effectiveConfig(global, project);
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('full');
    expect(result.reason).toBeNull();
  });

  it('uses defaults for missing fields', () => {
    const global = { worca: { graphify: { enabled: true } } };
    const result = _effectiveConfig(global, {});
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('structural');
    expect(result.out_dir).toBe('graphify-out');
    expect(result.version_range).toBe('>=0.7.10,<1');
    expect(result.min_repo_files).toBe(100);
  });

  it('project mode overrides global mode', () => {
    const global = {
      worca: { graphify: { enabled: true, mode: 'structural' } },
    };
    const project = { worca: { graphify: { enabled: true, mode: 'full' } } };
    const result = _effectiveConfig(global, project);
    expect(result.mode).toBe('full');
  });
});

describe('_graphStats', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'graphify-stats-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function _snap(dir) {
    // Build a complete snapshot dir: <dir>/graphify/* + .complete
    mkdirSync(join(dir, 'graphify'), { recursive: true });
    writeFileSync(
      join(dir, 'graphify', 'GRAPH_REPORT.md'),
      '# Graph Report\nx',
    );
    writeFileSync(join(dir, '.complete'), 'ok\n');
    return dir;
  }

  it('returns null when snapshot is missing/incomplete', () => {
    expect(_graphStats(null)).toBeNull();
    expect(_graphStats(join(tmpDir, 'nope'))).toBeNull();
    // present report but no .complete marker → still null
    mkdirSync(join(tmpDir, 'graphify'), { recursive: true });
    writeFileSync(join(tmpDir, 'graphify', 'GRAPH_REPORT.md'), '# x');
    expect(_graphStats(tmpDir)).toBeNull();
  });

  it('returns stats when snapshot is complete', () => {
    const result = _graphStats(_snap(tmpDir));
    expect(result).not.toBeNull();
    expect(result.report_path).toContain('GRAPH_REPORT.md');
    expect(result.snapshot_dir).toBe(tmpDir);
    expect(typeof result.age_seconds).toBe('number');
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  it('reports has_html when graph.html present', () => {
    _snap(tmpDir);
    writeFileSync(join(tmpDir, 'graphify', 'graph.html'), '<html></html>');
    expect(_graphStats(tmpDir).has_html).toBe(true);
  });
});

describe('createGraphifyStatus', () => {
  it('returns an object with detect, invalidate, and getStatus methods', () => {
    const gs = createGraphifyStatus({});
    expect(typeof gs.detect).toBe('function');
    expect(typeof gs.invalidate).toBe('function');
    expect(typeof gs.getStatus).toBe('function');
  });

  it('caches detection result for 60 seconds', async () => {
    let callCount = 0;
    const gs = createGraphifyStatus({
      detectFn: async () => {
        callCount++;
        return {
          installed: true,
          version: '4.2.0',
          compatible: true,
          backend_env_present: [],
          error: null,
        };
      },
    });

    await gs.detect();
    await gs.detect();
    expect(callCount).toBe(1);
  });

  it('invalidate clears the cache', async () => {
    let callCount = 0;
    const gs = createGraphifyStatus({
      detectFn: async () => {
        callCount++;
        return {
          installed: false,
          version: null,
          compatible: false,
          backend_env_present: [],
          error: 'not found',
        };
      },
    });

    await gs.detect();
    gs.invalidate();
    await gs.detect();
    expect(callCount).toBe(2);
  });

  it('re-detects after TTL expires', async () => {
    let callCount = 0;
    const gs = createGraphifyStatus({
      ttlMs: 50,
      detectFn: async () => {
        callCount++;
        return {
          installed: true,
          version: '4.1.0',
          compatible: true,
          backend_env_present: [],
          error: null,
        };
      },
    });

    await gs.detect();
    expect(callCount).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    await gs.detect();
    expect(callCount).toBe(2);
  });

  it('getStatus combines effective config, detection, and graph stats', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'graphify-getstatus-'));
    execFileSync('git', ['-C', tmpDir, 'init', '-q']);
    execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 't']);
    writeFileSync(join(tmpDir, 'f.txt'), 'x');
    execFileSync('git', ['-C', tmpDir, 'add', '-A']);
    execFileSync('git', ['-C', tmpDir, 'commit', '-qm', 'init']);

    const prevCache = process.env.WORCA_CACHE;
    process.env.WORCA_CACHE = join(tmpDir, 'cache');

    const gs = createGraphifyStatus({
      detectFn: async () => ({
        installed: true,
        version: '0.8.0',
        compatible: true,
        backend_env_present: [],
        error: null,
      }),
    });

    const globalSettings = { worca: { graphify: { enabled: true } } };
    const projectSettings = {};
    // Seed a complete cache snapshot for the current HEAD.
    const snap = snapshotDir(tmpDir);
    mkdirSync(join(snap, 'graphify'), { recursive: true });
    writeFileSync(join(snap, 'graphify', 'GRAPH_REPORT.md'), '# Report');
    writeFileSync(join(snap, '.complete'), 'ok\n');

    const result = await gs.getStatus({
      globalSettings,
      projectSettings,
      projectRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.effective.enabled).toBe(true);
    expect(result.detection.installed).toBe(true);
    expect(result.graph_stats).not.toBeNull();

    if (prevCache === undefined) delete process.env.WORCA_CACHE;
    else process.env.WORCA_CACHE = prevCache;
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Integration tests for HTTP endpoints ──────────────────────────────

describe('GET /api/graphify/status', () => {
  let server, base, _app, tmpDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'graphify-api-'));
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ worca: { graphify: { enabled: false } } }),
    );
    ({ server, base, _app } = await startServer({
      prefsDir: tmpDir,
      projectRoot: tmpDir,
      settingsPath: join(tmpDir, 'settings.json'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok:true with effective config showing disabled', async () => {
    const res = await fetch(`${base}/api/graphify/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.effective.enabled).toBe(false);
    expect(json.effective.reason).toBe('global-off');
  });

  it('returns detection and graph_stats fields', async () => {
    const res = await fetch(`${base}/api/graphify/status`);
    const json = await res.json();
    expect(json).toHaveProperty('detection');
    expect(json).toHaveProperty('graph_stats');
  });
});

describe('POST /api/graphify/recheck', () => {
  let server, base, _app, tmpDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'graphify-recheck-'));
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ worca: { graphify: { enabled: false } } }),
    );
    ({ server, base, _app } = await startServer({
      prefsDir: tmpDir,
      projectRoot: tmpDir,
      settingsPath: join(tmpDir, 'settings.json'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invalidates cache and returns fresh status', async () => {
    const res = await fetch(`${base}/api/graphify/recheck`, { method: 'POST' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json).toHaveProperty('effective');
    expect(json).toHaveProperty('detection');
  });
});

describe('POST /api/graphify/build + /clear', () => {
  let server, base, app, tmpDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'graphify-build-'));
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ worca: { graphify: { enabled: false } } }),
    );
    ({ server, base, app } = await startServer({
      prefsDir: tmpDir,
      projectRoot: tmpDir,
      settingsPath: join(tmpDir, 'settings.json'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function _ready() {
    app.locals.graphifyStatus = createGraphifyStatus({
      detectFn: async () => ({
        installed: true,
        version: '0.8.0',
        compatible: true,
        backend_env_present: [],
        error: null,
      }),
    });
  }

  it('build returns error when graphify is not enabled', async () => {
    const res = await fetch(`${base}/api/graphify/build`, { method: 'POST' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/not enabled/i);
  });

  it('build returns error when enabled but not detected', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ worca: { graphify: { enabled: true } } }),
    );
    const res = await fetch(`${base}/api/graphify/build`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it('build returns ok:building when ready', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ worca: { graphify: { enabled: true } } }),
    );
    _ready();
    const res = await fetch(`${base}/api/graphify/build`, { method: 'POST' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe('building');
  });

  it('clear is graceful even with no cache', async () => {
    const res = await fetch(`${base}/api/graphify/clear`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe('GET /api/graphify/graph.html', () => {
  let server, base, tmpDir, cacheDirEnv;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'graphify-html-'));
    // Make tmpDir a git repo so repoId/HEAD resolve.
    execFileSync('git', ['-C', tmpDir, 'init', '-q']);
    execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 't']);
    writeFileSync(join(tmpDir, 'f.txt'), 'x');
    execFileSync('git', ['-C', tmpDir, 'add', '-A']);
    execFileSync('git', ['-C', tmpDir, 'commit', '-qm', 'init']);

    cacheDirEnv = process.env.WORCA_CACHE;
    process.env.WORCA_CACHE = join(tmpDir, 'cache');

    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ worca: { graphify: { enabled: true } } }),
    );
    ({ server, base } = await startServer({
      prefsDir: tmpDir,
      projectRoot: tmpDir,
      settingsPath: join(tmpDir, 'settings.json'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    if (cacheDirEnv === undefined) delete process.env.WORCA_CACHE;
    else process.env.WORCA_CACHE = cacheDirEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 when no snapshot graph.html exists', async () => {
    const res = await fetch(`${base}/api/graphify/graph.html`);
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  it('serves graph.html from the cache snapshot when present', async () => {
    const snap = snapshotDir(tmpDir);
    mkdirSync(join(snap, 'graphify'), { recursive: true });
    writeFileSync(
      join(snap, 'graphify', 'graph.html'),
      '<html><body>Graph</body></html>',
    );
    const res = await fetch(`${base}/api/graphify/graph.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html>');
  });
});

// F3: _effectiveConfig() mirrors effective_graphify_config() in
// src/worca/utils/graphify.py. This table mirrors the Python unit tests in
// tests/test_graphify_settings.py::TestEffectiveGraphifyConfig so the two
// implementations cannot silently drift. Update both together.
describe('_effectiveConfig parity with Python', () => {
  const G = (g) => ({ worca: { graphify: g } });
  const cases = [
    {
      name: 'both disabled -> global-off',
      global: G({ enabled: false }),
      project: G({ enabled: false }),
      want: { enabled: false, reason: 'global-off' },
    },
    {
      name: 'global off + project on -> kill-switch (global-off)',
      global: G({ enabled: false }),
      project: G({ enabled: true, mode: 'full' }),
      want: { enabled: false, reason: 'global-off' },
    },
    {
      name: 'global on + project off -> project-off',
      global: G({ enabled: true }),
      project: G({ enabled: false }),
      want: { enabled: false, reason: 'project-off' },
    },
    {
      name: 'global on + project inherits -> enabled, inherits global',
      global: G({ enabled: true, mode: 'full', out_dir: 'custom-out' }),
      project: { worca: {} },
      want: {
        enabled: true,
        reason: null,
        mode: 'full',
        out_dir: 'custom-out',
      },
    },
    {
      name: 'project overrides mode',
      global: G({ enabled: true, mode: 'structural' }),
      project: G({ enabled: true, mode: 'full' }),
      want: { enabled: true, mode: 'full' },
    },
    {
      name: 'empty settings -> global-off + defaults',
      global: {},
      project: {},
      want: {
        enabled: false,
        reason: 'global-off',
        mode: 'structural',
        version_range: '>=0.7.10,<1',
        min_repo_files: 100,
      },
    },
    {
      name: 'project null backend/profile inherits global',
      global: G({ enabled: true, backend: 'ollama', model_profile: 'gp' }),
      project: G({ enabled: true, backend: null, model_profile: null }),
      want: { enabled: true, backend: 'ollama', model_profile: 'gp' },
    },
    {
      name: 'preflight_timeout default 300',
      global: G({ enabled: true }),
      project: G({ enabled: true }),
      want: { enabled: true, preflight_timeout_seconds: 300 },
    },
    {
      name: 'project overrides preflight_timeout',
      global: G({ enabled: true }),
      project: G({ enabled: true, preflight_timeout_seconds: 900 }),
      want: { enabled: true, preflight_timeout_seconds: 900 },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = _effectiveConfig(c.global, c.project);
      for (const [k, v] of Object.entries(c.want)) {
        expect(result[k]).toEqual(v);
      }
    });
  }
});
