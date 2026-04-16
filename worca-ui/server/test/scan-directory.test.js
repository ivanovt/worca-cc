import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

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
        if (body !== undefined) options.body = JSON.stringify(body);
        const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
        const json = await res.json();
        resolve({ status: res.status, body: json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe('POST /api/scan-directory', () => {
  let tmpDir;
  let app;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `worca-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    app = createApp({});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Case 1: Valid workspace with git subfolders
  it('returns git subfolders found in the directory', async () => {
    mkdirSync(join(tmpDir, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'repo-b', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'no-git'), { recursive: true });

    const { status, body } = await request(app, 'POST', '/api/scan-directory', {
      path: tmpDir,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.subfolders).toHaveLength(2);
    expect(body.subfolders.map((s) => s.name)).toEqual(['repo-a', 'repo-b']);
    expect(body.subfolders[0].path).toBe(join(tmpDir, 'repo-a'));
  });

  // Case 2: Empty directory — returns empty subfolders array
  it('returns empty subfolders array for a directory with no git children', async () => {
    const { status, body } = await request(app, 'POST', '/api/scan-directory', {
      path: tmpDir,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.subfolders).toEqual([]);
  });

  // Case 3: Non-existent path — returns 400
  it('returns 400 for a non-existent path', async () => {
    const { status, body } = await request(app, 'POST', '/api/scan-directory', {
      path: join(tmpDir, 'does-not-exist'),
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/does not exist/);
  });

  // Case 4: Relative path — returns 400
  it('returns 400 for a relative path', async () => {
    const { status, body } = await request(app, 'POST', '/api/scan-directory', {
      path: 'relative/path',
    });

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/absolute/);
  });

  // Case 5: Skips dotfiles and node_modules even if they have .git
  it('skips dotfiles and node_modules directories', async () => {
    mkdirSync(join(tmpDir, '.hidden', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'node_modules', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'real-repo', '.git'), { recursive: true });

    const { status, body } = await request(app, 'POST', '/api/scan-directory', {
      path: tmpDir,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.subfolders).toHaveLength(1);
    expect(body.subfolders[0].name).toBe('real-repo');
  });

  // Case 6: Results sorted alphabetically
  it('returns results sorted alphabetically by name', async () => {
    mkdirSync(join(tmpDir, 'zebra', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'alpha', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'middle', '.git'), { recursive: true });

    const { status, body } = await request(app, 'POST', '/api/scan-directory', {
      path: tmpDir,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.subfolders.map((s) => s.name)).toEqual([
      'alpha',
      'middle',
      'zebra',
    ]);
  });

  // Case 8: Enriched with worca installation status + version
  it('returns installed + worcaVersion fields for each folder', async () => {
    // repo-a: no worca installed
    mkdirSync(join(tmpDir, 'repo-a', '.git'), { recursive: true });
    // repo-b: worca installed with version.json
    mkdirSync(join(tmpDir, 'repo-b', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'repo-b', '.claude', 'worca'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'repo-b', '.claude', 'worca', 'version.json'),
      JSON.stringify({ version: '0.6.0' }),
    );
    // repo-c: worca installed without version file
    mkdirSync(join(tmpDir, 'repo-c', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'repo-c', '.claude', 'worca'), { recursive: true });

    const { status, body } = await request(app, 'POST', '/api/scan-directory', {
      path: tmpDir,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const byName = Object.fromEntries(body.subfolders.map((s) => [s.name, s]));
    expect(byName['repo-a'].installed).toBe(false);
    expect(byName['repo-a'].worcaVersion).toBeNull();
    expect(byName['repo-b'].installed).toBe(true);
    expect(byName['repo-b'].worcaVersion).toBe('0.6.0');
    expect(byName['repo-c'].installed).toBe(true);
    expect(byName['repo-c'].worcaVersion).toBeNull();
  });

  // Case 7: No entry cap — all results returned
  it('returns all git subfolders without a cap (60 dirs)', async () => {
    for (let i = 0; i < 60; i++) {
      mkdirSync(join(tmpDir, `repo-${String(i).padStart(3, '0')}`, '.git'), {
        recursive: true,
      });
    }

    const { status, body } = await request(app, 'POST', '/api/scan-directory', {
      path: tmpDir,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.subfolders).toHaveLength(60);
  });
});
