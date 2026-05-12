import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFleetRouter } from './fleet-routes.js';

function createTestServer(opts = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/fleet-runs', createFleetRouter(opts));
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

describe('Fleet guide upload (multipart)', () => {
  let tmpDir;
  let fleetRunsDir;
  let server;
  let base;
  let dispatchFleet;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-upload-test-'));
    fleetRunsDir = join(tmpDir, 'fleet-runs');
    dispatchFleet = vi.fn().mockResolvedValue({});
    ({ server, base } = await createTestServer({
      fleetRunsDir,
      dispatchFleet,
      guideCapBytes: 512, // small cap for testing
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function postFleetMultipart(form) {
    return fetch(`${base}/api/fleet-runs`, {
      method: 'POST',
      body: form,
    });
  }

  it('saves uploaded guide files under ~/.worca/fleet-runs/<fleet_id>/guides/', async () => {
    const form = new FormData();
    form.append('prompt', 'migrate all repos');
    form.append(
      'guide_files',
      new Blob(['# Migration spec\n\nDo X.'], { type: 'text/markdown' }),
      'spec.md',
    );

    const res = await postFleetMultipart(form);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const guidesDir = join(fleetRunsDir, data.fleet_id, 'guides');
    expect(existsSync(guidesDir)).toBe(true);
    const files = readdirSync(guidesDir);
    expect(files).toContain('spec.md');
    expect(readFileSync(join(guidesDir, 'spec.md'), 'utf8')).toContain(
      '# Migration spec',
    );
  });

  it('sets guide.uploaded === true in manifest for UI uploads', async () => {
    const form = new FormData();
    form.append('prompt', 'test');
    form.append(
      'guide_files',
      new Blob(['content'], { type: 'text/plain' }),
      'guide.txt',
    );

    const res = await postFleetMultipart(form);
    const data = await res.json();
    const manifest = JSON.parse(
      readFileSync(join(fleetRunsDir, `${data.fleet_id}.json`), 'utf8'),
    );
    expect(manifest.guide.uploaded).toBe(true);
    expect(manifest.guide.filenames).toContain('guide.txt');
  });

  it('sets guide === null in manifest when no files uploaded (JSON POST)', async () => {
    await stopServer(server);
    ({ server, base } = await createTestServer({
      fleetRunsDir,
      dispatchFleet,
    }));

    const res = await fetch(`${base}/api/fleet-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'no guide', projects: ['/proj'] }),
    });
    const data = await res.json();
    const manifest = JSON.parse(
      readFileSync(join(fleetRunsDir, `${data.fleet_id}.json`), 'utf8'),
    );
    expect(manifest.guide).toBeNull();
  });

  it('sanitizes filenames: strips path separators', async () => {
    const form = new FormData();
    form.append('prompt', 'test');
    form.append(
      'guide_files',
      new Blob(['evil content'], { type: 'text/plain' }),
      '../evil.md', // path traversal attempt
    );

    const res = await postFleetMultipart(form);
    expect(res.status).toBe(201);
    const data = await res.json();

    const guidesDir = join(fleetRunsDir, data.fleet_id, 'guides');
    const files = readdirSync(guidesDir);
    // Should NOT contain path with '..'
    for (const f of files) {
      expect(f).not.toContain('..');
      expect(f).not.toContain('/');
      expect(f).not.toContain('\\');
    }
    expect(files.length).toBe(1);
  });

  it('deduplicates colliding filenames by appending -1, -2', async () => {
    const form = new FormData();
    form.append('prompt', 'test');
    form.append(
      'guide_files',
      new Blob(['content A'], { type: 'text/plain' }),
      'spec.md',
    );
    form.append(
      'guide_files',
      new Blob(['content B'], { type: 'text/plain' }),
      'spec.md',
    );

    const res = await postFleetMultipart(form);
    expect(res.status).toBe(201);
    const data = await res.json();

    const guidesDir = join(fleetRunsDir, data.fleet_id, 'guides');
    const files = readdirSync(guidesDir).sort();
    expect(files).toContain('spec.md');
    expect(files).toContain('spec-1.md');
  });

  it('returns 400 when total guide size exceeds cap', async () => {
    const largeContent = 'x'.repeat(600); // exceeds 512-byte cap
    const form = new FormData();
    form.append('prompt', 'test');
    form.append(
      'guide_files',
      new Blob([largeContent], { type: 'text/plain' }),
      'big.md',
    );

    const res = await postFleetMultipart(form);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('cap');
  });

  it('does not dispatch fleet when guide cap is exceeded', async () => {
    const largeContent = 'x'.repeat(600);
    const form = new FormData();
    form.append('prompt', 'test');
    form.append(
      'guide_files',
      new Blob([largeContent], { type: 'text/plain' }),
      'big.md',
    );

    await postFleetMultipart(form);
    expect(dispatchFleet).not.toHaveBeenCalled();
  });

  it('saves file contents correctly (binary-safe)', async () => {
    const form = new FormData();
    form.append('prompt', 'test');
    const expectedContent = '## Guide\n\n- step 1\n- step 2\n';
    form.append(
      'guide_files',
      new Blob([expectedContent], { type: 'text/markdown' }),
      'steps.md',
    );

    const res = await postFleetMultipart(form);
    const data = await res.json();

    const guidesDir = join(fleetRunsDir, data.fleet_id, 'guides');
    const actual = readFileSync(join(guidesDir, 'steps.md'), 'utf8');
    expect(actual).toBe(expectedContent);
  });

  it('records guide bytes in manifest', async () => {
    const content = '# spec content';
    const form = new FormData();
    form.append('prompt', 'test');
    form.append(
      'guide_files',
      new Blob([content], { type: 'text/markdown' }),
      'spec.md',
    );

    const res = await postFleetMultipart(form);
    const data = await res.json();
    const manifest = JSON.parse(
      readFileSync(join(fleetRunsDir, `${data.fleet_id}.json`), 'utf8'),
    );
    expect(manifest.guide.bytes).toBe(Buffer.byteLength(content));
  });
});
