/**
 * Tests for workspace multipart plan file upload dispatch (W-056 §3).
 *
 * Verifies that the multipart parsing loop routes workspace_plan_file and
 * project_plan_<name> parts to dedicated variables before the guideFiles
 * catch-all, writes plan files to wsRunDir paths with the 256KB per-project
 * cap, and accepts workspace_plan string field as server-side path fallback.
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
    name: 'plan-test',
    projects: [
      { name: 'api', path: 'api', depends_on: [] },
      { name: 'web', path: 'web', depends_on: ['api'] },
    ],
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

function readManifestFromResponse(wsRunsDir, workspaceId) {
  const pointer = JSON.parse(
    readFileSync(join(wsRunsDir, `${workspaceId}.json`), 'utf8'),
  );
  return JSON.parse(
    readFileSync(
      join(
        pointer.workspace_root,
        '.worca',
        'workspace-runs',
        workspaceId,
        'workspace-manifest.json',
      ),
      'utf8',
    ),
  );
}

function wsRunDirFromResponse(wsRunsDir, workspaceId) {
  const pointer = JSON.parse(
    readFileSync(join(wsRunsDir, `${workspaceId}.json`), 'utf8'),
  );
  return join(pointer.workspace_root, '.worca', 'workspace-runs', workspaceId);
}

describe('Workspace Routes — Plan File Upload (multipart)', () => {
  let tmpDir;
  let wsRunsDir;
  let workspacesDir;
  let wsRoot;
  let server;
  let base;
  let dispatchWorkspace;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ws-plan-upload-test-'));
    wsRunsDir = join(tmpDir, 'workspace-runs');
    workspacesDir = join(tmpDir, 'workspaces.d');
    wsRoot = join(tmpDir, 'workspace-root');
    mkdirSync(wsRoot, { recursive: true });
    mkdirSync(join(wsRoot, 'api'), { recursive: true });
    mkdirSync(join(wsRoot, 'web'), { recursive: true });

    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(
      join(workspacesDir, 'plan-test.json'),
      JSON.stringify({ name: 'plan-test', path: wsRoot }),
    );
    writeWorkspaceJson(wsRoot, baseWorkspace());

    dispatchWorkspace = vi.fn();
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

  // ── multipart dispatch routing ──────────────────────────────────────

  it('routes workspace_plan_file to workspacePlanFileData, not guideFiles', async () => {
    const boundary = 'PLANFILE';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'existing' },
      [
        {
          name: 'workspace_plan_file',
          filename: 'workspace-plan.json',
          content: '{"projects":{}}',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);

    // Plan file should NOT appear in guide
    expect(manifest.guide).toBeNull();

    // Plan file should be written to wsRunDir
    const dir = wsRunDirFromResponse(wsRunsDir, data.workspace_id);
    expect(existsSync(join(dir, 'workspace-plan.json'))).toBe(true);
    expect(readFileSync(join(dir, 'workspace-plan.json'), 'utf8')).toBe(
      '{"projects":{}}',
    );
    expect(manifest.workspace_plan_path).toBe(join(dir, 'workspace-plan.json'));
  });

  it('routes project_plan_* parts to projectPlanFiles map, not guideFiles', async () => {
    const boundary = 'PROJPLAN';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'per-repo' },
      [
        {
          name: 'project_plan_api',
          filename: 'api-plan.md',
          content: '# API Plan\n\nStep 1...',
        },
        {
          name: 'project_plan_web',
          filename: 'web-plan.md',
          content: '# Web Plan\n\nStep 1...',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    const dir = wsRunDirFromResponse(wsRunsDir, data.workspace_id);

    // Project plans should NOT appear in guide
    expect(manifest.guide).toBeNull();

    // Project plans should be written to wsRunDir/plans/
    expect(existsSync(join(dir, 'plans', 'api.md'))).toBe(true);
    expect(existsSync(join(dir, 'plans', 'web.md'))).toBe(true);
    expect(readFileSync(join(dir, 'plans', 'api.md'), 'utf8')).toBe(
      '# API Plan\n\nStep 1...',
    );
    expect(readFileSync(join(dir, 'plans', 'web.md'), 'utf8')).toBe(
      '# Web Plan\n\nStep 1...',
    );

    // Manifest should record project_plans with original names as keys
    expect(manifest.project_plans).toEqual({
      api: join(dir, 'plans', 'api.md'),
      web: join(dir, 'plans', 'web.md'),
    });
  });

  it('routes guide files alongside plan files correctly', async () => {
    const boundary = 'MIXED';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'per-repo' },
      [
        {
          name: 'guide',
          filename: 'migration-spec.md',
          content: '# Migration Guide',
        },
        {
          name: 'project_plan_api',
          filename: 'api-plan.md',
          content: '# API Plan',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    const dir = wsRunDirFromResponse(wsRunsDir, data.workspace_id);

    // Guide should be present
    expect(manifest.guide).not.toBeNull();
    expect(manifest.guide.filenames).toContain('migration-spec.md');

    // Project plan should also be present on disk
    expect(existsSync(join(dir, 'plans', 'api.md'))).toBe(true);
    expect(manifest.project_plans).toHaveProperty('api');
  });

  // ── 256KB per-project cap ───────────────────────────────────────────

  it('rejects project plan exceeding 256KB with 400', async () => {
    const boundary = 'OVERCAP';
    const bigContent = 'x'.repeat(256 * 1024 + 1);
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'per-repo' },
      [
        {
          name: 'project_plan_api',
          filename: 'api-plan.md',
          content: bigContent,
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/256 KB/i);
    expect(data.error).toContain('api');
  });

  it('accepts project plan at exactly 256KB', async () => {
    const boundary = 'EXACTCAP';
    const exactContent = 'x'.repeat(256 * 1024);
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'per-repo' },
      [
        {
          name: 'project_plan_api',
          filename: 'api-plan.md',
          content: exactContent,
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
  });

  it('rejects uploaded workspace plan exceeding 256KB with 400', async () => {
    const boundary = 'WSOVERCAP';
    const bigContent = `${'x'.repeat(256 * 1024 + 1)}`;
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'existing' },
      [
        {
          name: 'workspace_plan_file',
          filename: 'workspace-plan.json',
          content: bigContent,
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/256 KB/i);
  });

  // ── workspace_plan server-side path fallback ────────────────────────

  it('accepts workspace_plan string field as server-side path', async () => {
    const planPath = join(tmpDir, 'my-workspace-plan.json');
    writeFileSync(planPath, '{"projects":{"api":{}}}');

    const boundary = 'PATHSTR';
    const body = buildMultipart(
      {
        workspace_name: 'plan-test',
        prompt: 'test',
        plan_mode: 'existing',
        workspace_plan: planPath,
      },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);

    expect(manifest.workspace_plan_path).toBe(planPath);
  });

  it('rejects nonexistent workspace_plan path with 400', async () => {
    const boundary = 'BADPATH';
    const body = buildMultipart(
      {
        workspace_name: 'plan-test',
        prompt: 'test',
        plan_mode: 'existing',
        workspace_plan: '/nonexistent/workspace-plan.json',
      },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/not found/i);
  });

  it('workspace_plan_file upload takes precedence over string path', async () => {
    const planPath = join(tmpDir, 'server-side-plan.json');
    writeFileSync(planPath, '{"from":"server-path"}');

    const boundary = 'PRECEDE';
    const body = buildMultipart(
      {
        workspace_name: 'plan-test',
        prompt: 'test',
        plan_mode: 'existing',
        workspace_plan: planPath,
      },
      [
        {
          name: 'workspace_plan_file',
          filename: 'uploaded-plan.json',
          content: '{"from":"uploaded"}',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const dir = wsRunDirFromResponse(wsRunsDir, data.workspace_id);

    // Should use the uploaded file, not the path
    const content = readFileSync(join(dir, 'workspace-plan.json'), 'utf8');
    expect(content).toBe('{"from":"uploaded"}');

    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    expect(manifest.workspace_plan_path).toBe(join(dir, 'workspace-plan.json'));
  });

  // ── manifest fields ─────────────────────────────────────────────────

  it('persists plan_mode on the manifest', async () => {
    const boundary = 'MODE';
    const body = buildMultipart(
      {
        workspace_name: 'plan-test',
        prompt: 'test',
        plan_mode: 'independent',
      },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    expect(manifest.plan_mode).toBe('independent');
  });

  it('defaults plan_mode to master when not provided', async () => {
    const boundary = 'DEFAULT';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test' },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    expect(manifest.plan_mode).toBe('master');
  });

  it('sets project_plans to null when no project plans uploaded', async () => {
    const boundary = 'NOPLAN';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'master' },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    expect(manifest.project_plans).toBeNull();
    expect(manifest.workspace_plan_path).toBeNull();
  });

  it('master mode ignores stray uploaded plan files (no mode divergence)', async () => {
    const boundary = 'MASTERSTRAY';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'master' },
      [
        {
          name: 'workspace_plan_file',
          filename: 'workspace-plan.json',
          content: '{"projects":{}}',
        },
        {
          name: 'project_plan_api',
          filename: 'api-plan.md',
          content: '# API Plan',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    // master mode must not carry plan inputs through — otherwise the Python CLI
    // would infer 'existing'/'per-repo' from the flags while the manifest (and
    // plan-mode badge) still claimed 'master'.
    expect(manifest.plan_mode).toBe('master');
    expect(manifest.workspace_plan_path).toBeNull();
    expect(manifest.project_plans).toBeNull();
  });

  // ── _resolvePlanStrategy validation ────────────────────────────────

  it('existing mode without workspace plan returns 400', async () => {
    const boundary = 'NOEXIST';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'existing' },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/existing.*plan/i);
  });

  it('per-repo mode without any project plans returns 400', async () => {
    const boundary = 'NOPERREPO';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'per-repo' },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/per-repo.*plan/i);
  });

  it('per-repo mode with unknown project name returns 422', async () => {
    const boundary = 'UNKNOWNPROJ';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'per-repo' },
      [
        {
          name: 'project_plan_nonexistent',
          filename: 'plan.md',
          content: '# Plan',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/nonexistent/);
  });

  // ── skip_planning per mode ─────────────────────────────────────────

  it('independent mode sets skip_planning to true', async () => {
    const boundary = 'INDEP';
    const body = buildMultipart(
      {
        workspace_name: 'plan-test',
        prompt: 'test',
        plan_mode: 'independent',
      },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    expect(manifest.skip_planning).toBe(true);
  });

  it('master mode sets skip_planning to false', async () => {
    const boundary = 'MASTER';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'master' },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    expect(manifest.skip_planning).toBe(false);
  });

  it('existing mode sets skip_planning to false', async () => {
    const planPath = join(tmpDir, 'existing-plan.json');
    writeFileSync(planPath, '{"projects":{}}');

    const boundary = 'EXISTSKIP';
    const body = buildMultipart(
      {
        workspace_name: 'plan-test',
        prompt: 'test',
        plan_mode: 'existing',
        workspace_plan: planPath,
      },
      [],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    expect(manifest.skip_planning).toBe(false);
  });

  it('per-repo mode sets skip_planning to false', async () => {
    const boundary = 'PERREPOSKIP';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'per-repo' },
      [
        {
          name: 'project_plan_api',
          filename: 'api-plan.md',
          content: '# API Plan',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const manifest = readManifestFromResponse(wsRunsDir, data.workspace_id);
    expect(manifest.skip_planning).toBe(false);
  });

  it('per-repo with mix of known and unknown projects returns 422 for unknown', async () => {
    const boundary = 'MIXPROJ';
    const body = buildMultipart(
      { workspace_name: 'plan-test', prompt: 'test', plan_mode: 'per-repo' },
      [
        {
          name: 'project_plan_api',
          filename: 'api-plan.md',
          content: '# API Plan',
        },
        {
          name: 'project_plan_unknown',
          filename: 'unknown-plan.md',
          content: '# Unknown Plan',
        },
      ],
      boundary,
    );

    const res = await fetch(`${base}/api/workspace-runs`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/unknown/i);
  });
});
