import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import {
  clearCache,
  compareVersions,
  fetchNpmVersions,
  fetchPyPIVersions,
  getDevPathVersions,
  parsePyPIPreRelease,
} from '../versions.js';

// ─── Pure function tests ───────────────────────────────────────────────

describe('parsePyPIPreRelease', () => {
  it('parses rc version', () => {
    expect(parsePyPIPreRelease('0.6.0rc7')).toEqual({ base: '0.6.0', rc: 7 });
  });

  it('parses single-digit rc', () => {
    expect(parsePyPIPreRelease('1.0.0rc1')).toEqual({ base: '1.0.0', rc: 1 });
  });

  it('returns null for stable version', () => {
    expect(parsePyPIPreRelease('0.6.0')).toBeNull();
  });

  it('returns null for npm-style rc', () => {
    expect(parsePyPIPreRelease('0.6.0-rc.7')).toBeNull();
  });

  it('returns null for alpha/beta', () => {
    expect(parsePyPIPreRelease('0.6.0a1')).toBeNull();
    expect(parsePyPIPreRelease('0.6.0b2')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('equal versions return 0', () => {
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
  });

  it('higher major returns 1', () => {
    expect(compareVersions('1.0.0', '0.6.0')).toBe(1);
  });

  it('lower major returns -1', () => {
    expect(compareVersions('0.5.0', '1.0.0')).toBe(-1);
  });

  it('higher minor returns 1', () => {
    expect(compareVersions('0.7.0', '0.6.0')).toBe(1);
  });

  it('higher patch returns 1', () => {
    expect(compareVersions('0.6.1', '0.6.0')).toBe(1);
  });

  it('handles pre-release suffixes (strips to numeric)', () => {
    // "0.6.0rc3" → parseInt("0rc3") = 0, so 0.6.0rc3 parses as 0.6.0
    expect(compareVersions('0.6.0rc3', '0.6.0')).toBe(0);
  });

  it('returns 0 for null inputs', () => {
    expect(compareVersions(null, '0.6.0')).toBe(0);
    expect(compareVersions('0.6.0', null)).toBe(0);
  });

  it('handles mismatched segment counts', () => {
    expect(compareVersions('0.7', '0.6.0')).toBe(1);
    expect(compareVersions('0.6', '0.6.0')).toBe(0);
  });
});

// ─── Registry fetch tests (mocked fetch) ───────────────────────────────

describe('fetchNpmVersions', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('extracts latest and rc from dist-tags', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          'dist-tags': { latest: '0.1.0', rc: '0.1.1-rc.3' },
          versions: {},
        }),
    });
    const result = await fetchNpmVersions('@worca/ui');
    expect(result).toEqual({ latest: '0.1.0', latestRc: '0.1.1-rc.3' });
  });

  it('scans versions when rc dist-tag is missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          'dist-tags': { latest: '0.1.0' },
          versions: {
            '0.1.0': {},
            '0.1.0-rc.1': {},
            '0.1.0-rc.5': {},
            '0.1.0-rc.3': {},
          },
        }),
    });
    const result = await fetchNpmVersions('@worca/ui');
    expect(result.latest).toBe('0.1.0');
    expect(result.latestRc).toBe('0.1.0-rc.5');
  });

  it('returns nulls on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await fetchNpmVersions('@worca/ui');
    expect(result).toEqual({ latest: null, latestRc: null });
  });

  it('returns nulls on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchNpmVersions('nonexistent-pkg');
    expect(result).toEqual({ latest: null, latestRc: null });
  });

  it('returns nulls when no rc versions exist', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': {}, '0.9.0': {} },
        }),
    });
    const result = await fetchNpmVersions('@worca/ui');
    expect(result).toEqual({ latest: '1.0.0', latestRc: null });
  });
});

describe('fetchPyPIVersions', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('extracts latest from info.version and scans for rc', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          info: { version: '0.6.0' },
          releases: {
            '0.5.0': [],
            '0.6.0': [],
            '0.6.0rc3': [],
            '0.6.0rc7': [],
          },
        }),
    });
    const result = await fetchPyPIVersions('worca-cc');
    expect(result).toEqual({ latest: '0.6.0', latestRc: '0.6.0rc7' });
  });

  it('returns nulls on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await fetchPyPIVersions('worca-cc');
    expect(result).toEqual({ latest: null, latestRc: null });
  });

  it('returns null latestRc when no rc versions exist', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          info: { version: '1.0.0' },
          releases: { '1.0.0': [], '0.9.0': [] },
        }),
    });
    const result = await fetchPyPIVersions('worca-cc');
    expect(result).toEqual({ latest: '1.0.0', latestRc: null });
  });

  it('returns nulls on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchPyPIVersions('nonexistent-pkg');
    expect(result).toEqual({ latest: null, latestRc: null });
  });
});

// ─── Dev path tests (real temp dirs) ────────────────────────────────────

describe('getDevPathVersions', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'versions-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads versions from valid repo', () => {
    writeFileSync(
      join(tmpDir, 'pyproject.toml'),
      '[project]\nname = "worca-cc"\nversion = "0.7.0-dev"\n',
    );
    mkdirSync(join(tmpDir, 'worca-ui'));
    writeFileSync(
      join(tmpDir, 'worca-ui', 'package.json'),
      '{ "version": "0.2.0-dev" }',
    );
    const result = getDevPathVersions(tmpDir);
    expect(result).toEqual({
      worcaCc: '0.7.0-dev',
      worcaUi: '0.2.0-dev',
      worcaCcDev: null,
      worcaUiDev: null,
    });
  });

  it('returns null worcaCc when pyproject.toml is missing', () => {
    mkdirSync(join(tmpDir, 'worca-ui'));
    writeFileSync(
      join(tmpDir, 'worca-ui', 'package.json'),
      '{ "version": "0.2.0" }',
    );
    const result = getDevPathVersions(tmpDir);
    expect(result.worcaCc).toBeNull();
    expect(result.worcaUi).toBe('0.2.0');
  });

  it('returns null worcaUi when package.json is missing', () => {
    writeFileSync(join(tmpDir, 'pyproject.toml'), 'version = "0.7.0"\n');
    const result = getDevPathVersions(tmpDir);
    expect(result.worcaCc).toBe('0.7.0');
    expect(result.worcaUi).toBeNull();
  });

  it('returns nulls for nonexistent path', () => {
    const result = getDevPathVersions('/nonexistent/path/abc123');
    expect(result).toEqual({
      worcaCc: null,
      worcaUi: null,
      worcaCcDev: null,
      worcaUiDev: null,
    });
  });

  it('returns nulls when sourceRepo is empty', () => {
    const result = getDevPathVersions('');
    expect(result).toEqual({
      worcaCc: null,
      worcaUi: null,
      worcaCcDev: null,
      worcaUiDev: null,
    });
  });
});

// ─── Integration test (full server) ─────────────────────────────────────

describe('GET /api/versions', () => {
  let server;
  let base;
  let originalFetch;
  let tmpDir;

  function startServer(options = {}) {
    const app = createApp(options);
    app.locals.worcaVersion = {
      ok: true,
      installed: '0.6.0rc7',
      minimum: '0.6.0',
      message: '',
    };
    const srv = createServer(app);
    return new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        resolve({ server: srv, base: `http://127.0.0.1:${port}` });
      });
    });
  }

  function stopServer(srv) {
    return new Promise((resolve) => srv.close(resolve));
  }

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    tmpDir = mkdtempSync(join(tmpdir(), 'versions-api-'));
    // Write a preferences file with source_repo
    writeFileSync(
      join(tmpDir, 'preferences.json'),
      JSON.stringify({ source_repo: '' }),
    );
    clearCache();
    const started = await startServer({ prefsDir: tmpDir });
    server = started.server;
    base = started.base;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns version info', async () => {
    // Mock registry fetches to avoid real network calls
    const realFetch = originalFetch;
    globalThis.fetch = vi.fn((url, opts) => {
      if (typeof url === 'string' && url.includes('registry.npmjs.org')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              'dist-tags': { latest: '0.1.0' },
              versions: {},
            }),
        });
      }
      if (typeof url === 'string' && url.includes('pypi.org')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              info: { version: '0.6.0' },
              releases: { '0.6.0': [] },
            }),
        });
      }
      // Pass through to real fetch for the test server request
      return realFetch(url, opts);
    });

    const res = await realFetch(`${base}/api/versions`);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.worcaCc).toBeDefined();
    expect(data.worcaUi).toBeDefined();
    expect(data.worcaCc.installed).toBe('0.6.0rc7');
    expect(data.cachedAt).toBeDefined();
  });

  it('respects force=1 to bypass cache', async () => {
    const realFetch = originalFetch;
    let callCount = 0;
    globalThis.fetch = vi.fn((url, opts) => {
      if (typeof url === 'string' && url.includes('registry.npmjs.org')) {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              'dist-tags': { latest: '0.1.0' },
              versions: {},
            }),
        });
      }
      if (typeof url === 'string' && url.includes('pypi.org')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              info: { version: '0.6.0' },
              releases: {},
            }),
        });
      }
      return realFetch(url, opts);
    });

    // First call populates cache
    await realFetch(`${base}/api/versions`);
    const firstCount = callCount;

    // Second call without force should use cache (no new registry fetch)
    await realFetch(`${base}/api/versions`);
    expect(callCount).toBe(firstCount);

    // Third call with force=1 should bypass cache
    await realFetch(`${base}/api/versions?force=1`);
    expect(callCount).toBeGreaterThan(firstCount);
  });
});
