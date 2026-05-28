import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import {
  _crgGraphStats,
  _effectiveCrgConfig,
  createCrgStatus,
} from './code-review-graph-status.js';
import { repoCacheDir, snapshotDir } from './graphify-status.js';

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

function safeRmTmp(dir) {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'ENOTEMPTY') throw err;
  }
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ── Unit tests for _effectiveCrgConfig ──────────────────────────────────

describe('_effectiveCrgConfig', () => {
  it('returns project-off when nothing opts in', () => {
    const result = _effectiveCrgConfig({ worca: {} }, {});
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('project-off');
  });

  it('explicit global enabled=false is a hard kill-switch', () => {
    const global = { worca: { code_review_graph: { enabled: false } } };
    const project = {
      worca: { code_review_graph: { enabled: true, embeddings: true } },
    };
    const result = _effectiveCrgConfig(global, project);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('global-off');
  });

  it('enables on project opt-in when global is unset', () => {
    const global = { worca: {} };
    const project = {
      worca: { code_review_graph: { enabled: true, embeddings: true } },
    };
    const result = _effectiveCrgConfig(global, project);
    expect(result.enabled).toBe(true);
    expect(result.embeddings).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('global enabled=true does not auto-enable a project', () => {
    const global = { worca: { code_review_graph: { enabled: true } } };
    const result = _effectiveCrgConfig(global, { worca: {} });
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('project-off');
  });

  it('returns disabled with project-off when project explicitly off', () => {
    const global = { worca: { code_review_graph: { enabled: true } } };
    const project = { worca: { code_review_graph: { enabled: false } } };
    const result = _effectiveCrgConfig(global, project);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('project-off');
  });

  it('returns enabled with merged config when both tiers enable', () => {
    const global = { worca: { code_review_graph: { enabled: true } } };
    const project = {
      worca: { code_review_graph: { enabled: true, embeddings: true } },
    };
    const result = _effectiveCrgConfig(global, project);
    expect(result.enabled).toBe(true);
    expect(result.embeddings).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('uses defaults for missing fields', () => {
    const global = { worca: { code_review_graph: { enabled: true } } };
    const project = { worca: { code_review_graph: { enabled: true } } };
    const result = _effectiveCrgConfig(global, project);
    expect(result.enabled).toBe(true);
    expect(result.embeddings).toBe(false);
    expect(result.version_range).toBe('>=2,<3');
    expect(result.fastmcp_min).toBe('3.2.4');
    expect(result.min_repo_files).toBe(100);
    expect(result.preflight_timeout_seconds).toBe(300);
    expect(result.freshness).toBe('clean_only');
    expect(result.stage_tools).toBeNull();
  });

  it('project embeddings overrides global', () => {
    const global = {
      worca: { code_review_graph: { enabled: true, embeddings: false } },
    };
    const project = {
      worca: { code_review_graph: { enabled: true, embeddings: true } },
    };
    const result = _effectiveCrgConfig(global, project);
    expect(result.embeddings).toBe(true);
  });

  it('merges update_on sub-keys from both tiers', () => {
    const global = {
      worca: {
        code_review_graph: {
          enabled: true,
          update_on: { preflight: false },
        },
      },
    };
    const project = {
      worca: {
        code_review_graph: {
          enabled: true,
          update_on: { post_implement: false },
        },
      },
    };
    const result = _effectiveCrgConfig(global, project);
    expect(result.update_on_preflight).toBe(false);
    expect(result.update_on_post_implement).toBe(false);
    expect(result.update_on_guardian_post_commit).toBe(true);
  });
});

// F3: Parity with Python effective_crg_config() from
// src/worca/utils/code_review_graph.py. Update both together.
describe('_effectiveCrgConfig parity with Python', () => {
  const C = (c) => ({ worca: { code_review_graph: c } });
  const cases = [
    {
      name: 'both disabled -> global-off',
      global: C({ enabled: false }),
      project: C({ enabled: false }),
      want: { enabled: false, reason: 'global-off' },
    },
    {
      name: 'global off + project on -> kill-switch (global-off)',
      global: C({ enabled: false }),
      project: C({ enabled: true, embeddings: true }),
      want: { enabled: false, reason: 'global-off' },
    },
    {
      name: 'global on + project off -> project-off',
      global: C({ enabled: true }),
      project: C({ enabled: false }),
      want: { enabled: false, reason: 'project-off' },
    },
    {
      name: 'global on + project unset -> project-off (must opt in)',
      global: C({ enabled: true, embeddings: true }),
      project: { worca: {} },
      want: { enabled: false, reason: 'project-off' },
    },
    {
      name: 'global unset + project on -> enabled (no global gate)',
      global: { worca: {} },
      project: C({ enabled: true, embeddings: true }),
      want: { enabled: true, reason: null, embeddings: true },
    },
    {
      name: 'project overrides embeddings',
      global: C({ enabled: true, embeddings: false }),
      project: C({ enabled: true, embeddings: true }),
      want: { enabled: true, embeddings: true },
    },
    {
      name: 'empty settings -> project-off + defaults',
      global: {},
      project: {},
      want: {
        enabled: false,
        reason: 'project-off',
        embeddings: false,
        version_range: '>=2,<3',
        fastmcp_min: '3.2.4',
        min_repo_files: 100,
      },
    },
    {
      name: 'preflight_timeout default 300',
      global: C({ enabled: true }),
      project: C({ enabled: true }),
      want: { enabled: true, preflight_timeout_seconds: 300 },
    },
    {
      name: 'project overrides preflight_timeout',
      global: C({ enabled: true }),
      project: C({ enabled: true, preflight_timeout_seconds: 900 }),
      want: { enabled: true, preflight_timeout_seconds: 900 },
    },
    {
      name: 'project null stage_tools inherits global',
      global: C({
        enabled: true,
        stage_tools: { planner: ['query_graph_tool'] },
      }),
      project: C({ enabled: true, stage_tools: null }),
      want: {
        enabled: true,
        stage_tools: { planner: ['query_graph_tool'] },
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = _effectiveCrgConfig(c.global, c.project);
      for (const [k, v] of Object.entries(c.want)) {
        expect(result[k]).toEqual(v);
      }
    });
  }
});

// ── Unit tests for _crgGraphStats ──────────────────────────────────────

describe('_crgGraphStats', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crg-stats-'));
  });

  afterEach(() => {
    safeRmTmp(tmpDir);
  });

  it('returns null when snapshot is missing/incomplete', () => {
    expect(_crgGraphStats(null)).toBeNull();
    expect(_crgGraphStats(join(tmpDir, 'nope'))).toBeNull();
    // CRG subdir exists but no graph.db
    mkdirSync(join(tmpDir, 'code-review-graph'), { recursive: true });
    expect(_crgGraphStats(tmpDir)).toBeNull();
  });

  it('returns stats when graph.db exists', () => {
    mkdirSync(join(tmpDir, 'code-review-graph'), { recursive: true });
    writeFileSync(join(tmpDir, 'code-review-graph', 'graph.db'), 'fake-db');
    const result = _crgGraphStats(tmpDir);
    expect(result).not.toBeNull();
    expect(result.db_path).toContain('graph.db');
    expect(result.snapshot_dir).toBe(tmpDir);
    expect(typeof result.age_seconds).toBe('number');
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  it('reports has_html when graph.html present', () => {
    mkdirSync(join(tmpDir, 'code-review-graph'), { recursive: true });
    writeFileSync(join(tmpDir, 'code-review-graph', 'graph.db'), 'fake-db');
    expect(_crgGraphStats(tmpDir).has_html).toBe(false);
    writeFileSync(
      join(tmpDir, 'code-review-graph', 'graph.html'),
      '<html></html>',
    );
    expect(_crgGraphStats(tmpDir).has_html).toBe(true);
  });
});

// ── Unit tests for createCrgStatus ──────────────────────────────────────

describe('createCrgStatus', () => {
  it('returns an object with detect, invalidate, and getStatus methods', () => {
    const cs = createCrgStatus({});
    expect(typeof cs.detect).toBe('function');
    expect(typeof cs.invalidate).toBe('function');
    expect(typeof cs.getStatus).toBe('function');
  });

  it('caches detection result for 60 seconds', async () => {
    let callCount = 0;
    const cs = createCrgStatus({
      detectFn: async () => {
        callCount++;
        return {
          installed: true,
          version: '2.1.0',
          compatible: true,
          fastmcp_ok: true,
          error: null,
        };
      },
    });
    await cs.detect();
    await cs.detect();
    expect(callCount).toBe(1);
  });

  it('invalidate clears the cache', async () => {
    let callCount = 0;
    const cs = createCrgStatus({
      detectFn: async () => {
        callCount++;
        return {
          installed: false,
          version: null,
          compatible: false,
          fastmcp_ok: false,
          error: 'not found',
        };
      },
    });
    await cs.detect();
    cs.invalidate();
    await cs.detect();
    expect(callCount).toBe(2);
  });

  it('re-detects after TTL expires', async () => {
    let callCount = 0;
    const cs = createCrgStatus({
      ttlMs: 50,
      detectFn: async () => {
        callCount++;
        return {
          installed: true,
          version: '2.0.0',
          compatible: true,
          fastmcp_ok: true,
          error: null,
        };
      },
    });
    await cs.detect();
    expect(callCount).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    await cs.detect();
    expect(callCount).toBe(2);
  });

  it('getStatus combines effective config, detection, and graph stats', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'crg-getstatus-'));
    execFileSync('git', ['-C', tmpDir, 'init', '-q']);
    execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 't']);
    writeFileSync(join(tmpDir, 'f.txt'), 'x');
    execFileSync('git', ['-C', tmpDir, 'add', '-A']);
    execFileSync('git', ['-C', tmpDir, 'commit', '-qm', 'init']);

    const prevCache = process.env.WORCA_CACHE;
    process.env.WORCA_CACHE = join(tmpDir, 'cache');

    const cs = createCrgStatus({
      detectFn: async () => ({
        installed: true,
        version: '2.1.0',
        compatible: true,
        fastmcp_ok: true,
        error: null,
      }),
    });

    const globalSettings = { worca: {} };
    const projectSettings = {
      worca: { code_review_graph: { enabled: true } },
    };
    const snap = snapshotDir(tmpDir);
    mkdirSync(join(snap, 'code-review-graph'), { recursive: true });
    writeFileSync(join(snap, 'code-review-graph', 'graph.db'), 'fake-db');

    const result = await cs.getStatus({
      globalSettings,
      projectSettings,
      projectRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.effective.enabled).toBe(true);
    expect(result.detection.installed).toBe(true);
    expect(result.detection.fastmcp_ok).toBe(true);
    expect(result.graph_stats).not.toBeNull();
    expect(result.cache_path).toBe(repoCacheDir(tmpDir));
    expect(result.cache_path).toContain('ast');

    if (prevCache === undefined) delete process.env.WORCA_CACHE;
    else process.env.WORCA_CACHE = prevCache;
    safeRmTmp(tmpDir);
  });

  it('resolves cache_path even when CRG is disabled', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'crg-disabled-'));
    execFileSync('git', ['-C', tmpDir, 'init', '-q']);

    const prevCache = process.env.WORCA_CACHE;
    process.env.WORCA_CACHE = join(tmpDir, 'cache');

    const cs = createCrgStatus({
      detectFn: async () => ({
        installed: false,
        version: null,
        compatible: false,
        fastmcp_ok: false,
        error: 'code-review-graph not found',
      }),
    });

    const result = await cs.getStatus({
      globalSettings: {
        worca: { code_review_graph: { enabled: false } },
      },
      projectSettings: {},
      projectRoot: tmpDir,
    });

    expect(result.effective.enabled).toBe(false);
    expect(result.graph_stats).toBeNull();
    expect(result.cache_path).toBe(repoCacheDir(tmpDir));
    expect(result.cache_path).toContain('ast');

    if (prevCache === undefined) delete process.env.WORCA_CACHE;
    else process.env.WORCA_CACHE = prevCache;
    safeRmTmp(tmpDir);
  });
});

// ── Integration tests for HTTP endpoints ────────────────────────────────

describe('GET /api/crg/status', () => {
  let server, base, tmpDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crg-api-'));
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: { code_review_graph: { enabled: false } },
      }),
    );
    ({ server, base } = await startServer({
      prefsDir: tmpDir,
      projectRoot: tmpDir,
      settingsPath: join(tmpDir, 'settings.json'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    safeRmTmp(tmpDir);
  });

  it('returns ok:true with effective config showing disabled', async () => {
    const res = await fetch(`${base}/api/crg/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.effective.enabled).toBe(false);
    expect(json.effective.reason).toBe('global-off');
  });

  it('returns detection and graph_stats fields', async () => {
    const res = await fetch(`${base}/api/crg/status`);
    const json = await res.json();
    expect(json).toHaveProperty('detection');
    expect(json).toHaveProperty('graph_stats');
  });
});

describe('POST /api/crg/recheck', () => {
  let server, base, tmpDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crg-recheck-'));
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: { code_review_graph: { enabled: false } },
      }),
    );
    ({ server, base } = await startServer({
      prefsDir: tmpDir,
      projectRoot: tmpDir,
      settingsPath: join(tmpDir, 'settings.json'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    safeRmTmp(tmpDir);
  });

  it('invalidates cache and returns fresh status', async () => {
    const res = await fetch(`${base}/api/crg/recheck`, { method: 'POST' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json).toHaveProperty('effective');
    expect(json).toHaveProperty('detection');
  });
});

describe('POST /api/crg/build + /clear', () => {
  let server, base, app, tmpDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crg-build-'));
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: { code_review_graph: { enabled: false } },
      }),
    );
    ({ server, base, app } = await startServer({
      prefsDir: tmpDir,
      projectRoot: tmpDir,
      settingsPath: join(tmpDir, 'settings.json'),
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    safeRmTmp(tmpDir);
  });

  function _ready() {
    app.locals.crgStatus = createCrgStatus({
      detectFn: async () => ({
        installed: true,
        version: '2.1.0',
        compatible: true,
        fastmcp_ok: true,
        error: null,
      }),
    });
  }

  it('build returns error when CRG is not enabled', async () => {
    const res = await fetch(`${base}/api/crg/build`, { method: 'POST' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/not enabled/i);
  });

  it('build returns error when enabled but not detected', async () => {
    app.locals.crgStatus = createCrgStatus({
      detectFn: async () => ({
        installed: false,
        version: null,
        compatible: false,
        fastmcp_ok: false,
        error: 'code-review-graph not found on PATH',
      }),
    });
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: { code_review_graph: { enabled: true } },
      }),
    );
    const res = await fetch(`${base}/api/crg/build`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it('build returns error when fastmcp not ok', async () => {
    app.locals.crgStatus = createCrgStatus({
      detectFn: async () => ({
        installed: true,
        version: '2.1.0',
        compatible: true,
        fastmcp_ok: false,
        error: 'fastmcp not installed',
      }),
    });
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: { code_review_graph: { enabled: true } },
      }),
    );
    const res = await fetch(`${base}/api/crg/build`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it('build returns ok:building when ready', async () => {
    writeFileSync(
      join(tmpDir, 'settings.json'),
      JSON.stringify({
        worca: { code_review_graph: { enabled: true } },
      }),
    );
    _ready();
    const res = await fetch(`${base}/api/crg/build`, { method: 'POST' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe('building');
  });

  it('clear is graceful even with no cache', async () => {
    const res = await fetch(`${base}/api/crg/clear`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe('GET /api/crg/graph.html', () => {
  let server, base, tmpDir, cacheDirEnv;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crg-html-'));
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
      JSON.stringify({
        worca: { code_review_graph: { enabled: true } },
      }),
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
    safeRmTmp(tmpDir);
  });

  it('returns 404 when no snapshot graph.html exists', async () => {
    const res = await fetch(`${base}/api/crg/graph.html`);
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  it('serves graph.html from the cache snapshot when present', async () => {
    const snap = snapshotDir(tmpDir);
    mkdirSync(join(snap, 'code-review-graph'), { recursive: true });
    writeFileSync(
      join(snap, 'code-review-graph', 'graph.html'),
      '<html><body>CRG Graph</body></html>',
    );
    const res = await fetch(`${base}/api/crg/graph.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html>');
  });
});

describe('GET /api/crg/status?project=<id> (global mode)', () => {
  let server, base, tmpDir, projDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crg-prefs-'));
    projDir = mkdtempSync(join(tmpdir(), 'crg-proj-'));
    writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ worca: {} }));
    mkdirSync(join(tmpDir, 'projects.d'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'projects.d', 'proj-b.json'),
      JSON.stringify({ name: 'proj-b', path: projDir }),
    );
    mkdirSync(join(projDir, '.claude'), { recursive: true });
    writeFileSync(
      join(projDir, '.claude', 'settings.json'),
      JSON.stringify({
        worca: { code_review_graph: { enabled: true, embeddings: true } },
      }),
    );
    ({ server, base } = await startServer({ prefsDir: tmpDir }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    safeRmTmp(tmpDir);
    safeRmTmp(projDir);
  });

  it("honors the selected project's project-level enablement", async () => {
    const noProj = await (await fetch(`${base}/api/crg/status`)).json();
    expect(noProj.effective.enabled).toBe(false);
    expect(noProj.effective.reason).toBe('project-off');

    const withProj = await (
      await fetch(`${base}/api/crg/status?project=proj-b`)
    ).json();
    expect(withProj.effective.enabled).toBe(true);
    expect(withProj.effective.embeddings).toBe(true);
    expect(withProj.effective.reason).toBeNull();
  });
});
