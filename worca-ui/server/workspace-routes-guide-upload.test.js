/**
 * Tests for workspace multipart guide upload (W-047 §10.10).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceRouter } from './workspace-routes.js';

function writeWorkspaceJson(root, workspace) {
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify(workspace, null, 2),
  );
}

function baseWorkspace() {
  return {
    name: 'upload-test',
    repos: [{ name: 'api', path: 'api', depends_on: [] }],
  };
}

function createTestServer(opts = {}) {
  const app = express();
  app.use(express.json());
  const router = createWorkspaceRouter(opts);
  app.use('/api/workspaces', router.workspaces);
  app.use('/api/workspace-runs', router.workspaceRuns);
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

function buildMultipart(fields, files, boundary = 'BOUNDARY123') {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        value,
    );
  }
  for (const { name, filename, content } of files) {
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n` +
        content,
    );
  }
  parts.push(`--${boundary}--`);
  return parts.join('\r\n');
}

describe('Workspace Routes — Guide Upload (multipart)', () => {
  let tmpDir;
  let wsRunsDir;
  let workspacesDir;
  let wsRoot;
  let server;
  let base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ws-guide-upload-test-'));
    wsRunsDir = join(tmpDir, 'workspace-runs');
    workspacesDir = join(tmpDir, 'workspaces.d');
    wsRoot = join(tmpDir, 'workspace-root');
    mkdirSync(wsRoot, { recursive: true });
    mkdirSync(join(wsRoot, 'api'), { recursive: true });

    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(
      join(workspacesDir, 'upload-test.json'),
      JSON.stringify({ name: 'upload-test', path: wsRoot }),
    );
    writeWorkspaceJson(wsRoot, baseWorkspace());

    const dispatchWorkspace = vi.fn();
    ({ server, base } = await createTestServer({
      workspaceRunsDir: wsRunsDir,
      workspacesDir,
      dispatchWorkspace,
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates workspace run with uploaded guide files', async () => {
    const boundary = 'TESTBOUNDARY';
    const body = buildMultipart(
      { workspace_name: 'upload-test', prompt: 'apply migration' },
      [
        {
          name: 'guide',
          filename: 'migration-spec.md',
          content: '# Migration Spec\n\nStep 1...',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.workspace_id).toMatch(/^ws_\d{12}_[0-9a-f]+$/);

    const pointer = JSON.parse(
      readFileSync(join(wsRunsDir, `${data.workspace_id}.json`), 'utf8'),
    );
    const manifestPath = join(
      pointer.workspace_root,
      '.worca',
      'workspace-runs',
      data.workspace_id,
      'workspace-manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.guide).not.toBeNull();
    expect(manifest.guide.filenames).toContain('migration-spec.md');
    expect(manifest.guide.uploaded).toBe(true);
  });

  it('saves guide files on disk in the guides/ subdirectory', async () => {
    const boundary = 'DISKTEST';
    const body = buildMultipart(
      { workspace_name: 'upload-test', prompt: 'test' },
      [
        {
          name: 'guide',
          filename: 'spec.md',
          content: '# Spec',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const data = await res.json();
    const pointer = JSON.parse(
      readFileSync(join(wsRunsDir, `${data.workspace_id}.json`), 'utf8'),
    );
    const guidesDir = join(
      pointer.workspace_root,
      '.worca',
      'workspace-runs',
      data.workspace_id,
      'guides',
    );
    expect(existsSync(join(guidesDir, 'spec.md'))).toBe(true);
    expect(readFileSync(join(guidesDir, 'spec.md'), 'utf8')).toBe('# Spec');
  });

  it('handles multiple guide files with deduplication', async () => {
    const boundary = 'MULTI';
    const body = buildMultipart(
      { workspace_name: 'upload-test', prompt: 'test' },
      [
        { name: 'guide', filename: 'spec.md', content: 'file 1' },
        { name: 'guide', filename: 'spec.md', content: 'file 2' },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const data = await res.json();
    expect(data.ok).toBe(true);

    const pointer = JSON.parse(
      readFileSync(join(wsRunsDir, `${data.workspace_id}.json`), 'utf8'),
    );
    const manifest = JSON.parse(
      readFileSync(
        join(
          pointer.workspace_root,
          '.worca',
          'workspace-runs',
          data.workspace_id,
          'workspace-manifest.json',
        ),
        'utf8',
      ),
    );
    expect(manifest.guide.filenames).toHaveLength(2);
    expect(manifest.guide.filenames).toContain('spec.md');
    expect(manifest.guide.filenames).toContain('spec-1.md');
  });

  it('rejects guide upload exceeding size cap', async () => {
    await stopServer(server);
    const dispatchWorkspace = vi.fn();
    ({ server, base } = await createTestServer({
      workspaceRunsDir: wsRunsDir,
      workspacesDir,
      dispatchWorkspace,
      guideCapBytes: 10,
    }));

    const boundary = 'OVERCAP';
    const body = buildMultipart(
      { workspace_name: 'upload-test', prompt: 'test' },
      [
        {
          name: 'guide',
          filename: 'big.md',
          content: 'x'.repeat(20),
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/exceed/i);
  });

  it('sanitizes unsafe filenames', async () => {
    const boundary = 'SANITIZE';
    const body = buildMultipart(
      { workspace_name: 'upload-test', prompt: 'test' },
      [
        {
          name: 'guide',
          filename: '../../../etc/passwd',
          content: 'safe content',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const data = await res.json();
    expect(data.ok).toBe(true);

    const pointer = JSON.parse(
      readFileSync(join(wsRunsDir, `${data.workspace_id}.json`), 'utf8'),
    );
    const manifest = JSON.parse(
      readFileSync(
        join(
          pointer.workspace_root,
          '.worca',
          'workspace-runs',
          data.workspace_id,
          'workspace-manifest.json',
        ),
        'utf8',
      ),
    );
    expect(manifest.guide.filenames[0]).not.toContain('..');
    expect(manifest.guide.filenames[0]).toBe('passwd');
  });
});
