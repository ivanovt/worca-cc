/**
 * Tests for workspace REST endpoints (W-047 §10.10).
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
import {
  createWorkspaceRouter,
  deriveWorkspaceStatus,
  effectiveWorkspaceStatus,
} from './workspace-routes.js';

const VALID_WS_ID = 'ws_202605120809_abcdef01';

function writeManifest(wsRunsDir, wsId, manifest) {
  const pointerDir = wsRunsDir;
  mkdirSync(pointerDir, { recursive: true });
  const pointer = {
    workspace_root: manifest.workspace_root,
    workspace_id: wsId,
  };
  writeFileSync(join(pointerDir, `${wsId}.json`), JSON.stringify(pointer));

  const runDir = join(
    manifest.workspace_root,
    '.worca',
    'workspace-runs',
    wsId,
  );
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'workspace-manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
}

function writeWorkspaceJson(root, workspace) {
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify(workspace, null, 2),
  );
}

function baseWorkspace(overrides = {}) {
  return {
    name: 'my-workspace',
    projects: [
      { name: 'api', path: 'api', depends_on: [] },
      { name: 'web', path: 'web', depends_on: ['api'] },
    ],
    ...overrides,
  };
}

function baseManifest(wsRoot, overrides = {}) {
  return {
    workspace_id: VALID_WS_ID,
    workspace_name: 'my-workspace',
    workspace_root: wsRoot,
    created_at: '2026-05-12T08:09:00.000Z',
    work_request: {
      title: 'Test workspace',
      description: 'test prompt',
      source: null,
    },
    guide: null,
    branch_template: 'workspace/{slug}/{repo}',
    max_parallel: 5,
    skip_integration: false,
    skip_planning: false,
    status: 'running',
    halt_reason: null,
    dag: {
      tiers: [
        { tier: 0, projects: ['api'], status: 'running' },
        { tier: 1, projects: ['web'], status: 'pending' },
      ],
    },
    children: [],
    integration_test: { status: 'pending', exit_code: null, log_path: null },
    ...overrides,
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

describe('Workspace Routes', () => {
  let tmpDir;
  let wsRunsDir;
  let workspacesDir;
  let wsRoot;
  let server;
  let base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ws-routes-test-'));
    wsRunsDir = join(tmpDir, 'workspace-runs');
    workspacesDir = join(tmpDir, 'workspaces.d');
    wsRoot = join(tmpDir, 'workspace-root');
    mkdirSync(wsRoot, { recursive: true });
    mkdirSync(join(wsRoot, 'api'), { recursive: true });
    mkdirSync(join(wsRoot, 'web'), { recursive: true });
    ({ server, base } = await createTestServer({
      workspaceRunsDir: wsRunsDir,
      workspacesDir,
    }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── POST /api/workspaces/scan ──────────────────────────────────────────

  describe('POST /api/workspaces/scan', () => {
    it('returns 400 when parent_path is missing', async () => {
      const res = await fetch(`${base}/api/workspaces/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.ok).toBe(false);
    });

    it('returns 400 when parent_path does not exist', async () => {
      const res = await fetch(`${base}/api/workspaces/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_path: '/nonexistent/path' }),
      });
      expect(res.status).toBe(400);
    });

    it('discovers repos in a valid parent directory', async () => {
      const parent = join(tmpDir, 'scan-parent');
      mkdirSync(parent);
      mkdirSync(join(parent, 'repo-a', '.git'), { recursive: true });
      mkdirSync(join(parent, 'repo-b', '.git'), { recursive: true });
      mkdirSync(join(parent, 'not-a-repo'));

      const res = await fetch(`${base}/api/workspaces/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_path: parent }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.projects).toHaveLength(2);
      const names = data.projects.map((r) => r.name).sort();
      expect(names).toEqual(['repo-a', 'repo-b']);
    });
  });

  // ─── POST /api/workspaces ─────────────────────────────────────────────

  describe('POST /api/workspaces', () => {
    it('returns 400 when name is missing', async () => {
      const res = await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_path: wsRoot, projects: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 422 when repos create a cycle', async () => {
      const res = await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'cyclic',
          parent_path: wsRoot,
          projects: [
            { name: 'a', path: 'api', depends_on: ['b'] },
            { name: 'b', path: 'web', depends_on: ['a'] },
          ],
        }),
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/cycle/i);
    });

    it('creates workspace.json and returns ok', async () => {
      const res = await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'my-workspace',
          parent_path: wsRoot,
          projects: [
            { name: 'api', path: 'api', depends_on: [] },
            { name: 'web', path: 'web', depends_on: ['api'] },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.ok).toBe(true);

      expect(existsSync(join(wsRoot, 'workspace.json'))).toBe(true);
    });

    it('registers workspace in workspaces.d', async () => {
      const res = await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'my-workspace',
          parent_path: wsRoot,
          projects: [{ name: 'api', path: 'api', depends_on: [] }],
        }),
      });
      expect(res.status).toBe(201);

      expect(existsSync(join(workspacesDir, 'my-workspace.json'))).toBe(true);
      const reg = JSON.parse(
        readFileSync(join(workspacesDir, 'my-workspace.json'), 'utf8'),
      );
      expect(reg.name).toBe('my-workspace');
      expect(reg.path).toBe(wsRoot);
    });
  });

  // ─── GET /api/workspaces ──────────────────────────────────────────────

  describe('GET /api/workspaces', () => {
    it('returns empty list when workspaces.d does not exist', async () => {
      const res = await fetch(`${base}/api/workspaces`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.workspaces).toEqual([]);
    });

    it('returns registered workspaces', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());

      const res = await fetch(`${base}/api/workspaces`);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.workspaces).toHaveLength(1);
      expect(data.workspaces[0].name).toBe('my-workspace');
    });
  });

  // ─── GET /api/workspaces/:name ────────────────────────────────────────

  describe('GET /api/workspaces/:name', () => {
    it('returns 404 for unknown workspace', async () => {
      const res = await fetch(`${base}/api/workspaces/nonexistent`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.ok).toBe(false);
    });

    it('returns workspace definition and repos', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());

      const res = await fetch(`${base}/api/workspaces/my-workspace`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.workspace.name).toBe('my-workspace');
      expect(data.workspace.projects).toHaveLength(2);
    });
  });

  // ─── PUT /api/workspaces/:name ────────────────────────────────────────

  describe('PUT /api/workspaces/:name', () => {
    it('returns 404 for unknown workspace', async () => {
      const res = await fetch(`${base}/api/workspaces/nonexistent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseWorkspace()),
      });
      expect(res.status).toBe(404);
    });

    it('returns 422 when updated repos create a cycle', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());

      const res = await fetch(`${base}/api/workspaces/my-workspace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseWorkspace(),
          projects: [
            { name: 'api', path: 'api', depends_on: ['web'] },
            { name: 'web', path: 'web', depends_on: ['api'] },
          ],
        }),
      });
      expect(res.status).toBe(422);
    });

    it('updates workspace.json when valid', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());

      const updated = baseWorkspace({
        projects: [{ name: 'api', path: 'api', depends_on: [] }],
      });
      const res = await fetch(`${base}/api/workspaces/my-workspace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      const saved = JSON.parse(
        readFileSync(join(wsRoot, 'workspace.json'), 'utf8'),
      );
      expect(saved.projects).toHaveLength(1);
    });

    it('returns 409 when active workspace runs exist', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());
      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'running' }),
      );

      const res = await fetch(`${base}/api/workspaces/my-workspace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseWorkspace()),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/active/i);
    });
  });

  describe('DELETE /api/workspaces/:name', () => {
    it('returns 404 for unknown workspace', async () => {
      const res = await fetch(`${base}/api/workspaces/nonexistent`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 when active workspace runs reference the workspace', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());
      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'running' }),
      );

      const res = await fetch(`${base}/api/workspaces/my-workspace`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/active/i);
    });

    it('removes registration and workspace.json on success', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());

      const res = await fetch(`${base}/api/workspaces/my-workspace`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      // Both files should be gone.
      expect(existsSync(join(workspacesDir, 'my-workspace.json'))).toBe(false);
      expect(existsSync(join(wsRoot, 'workspace.json'))).toBe(false);
    });

    it('succeeds when workspace.json is already missing (only registration left)', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      // No workspace.json on disk this time.

      const res = await fetch(`${base}/api/workspaces/my-workspace`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(existsSync(join(workspacesDir, 'my-workspace.json'))).toBe(false);
    });
  });

  // ─── POST /api/workspace-runs/validate-gh-auth ────────────────────────

  describe('POST /api/workspace-runs/validate-gh-auth', () => {
    it('returns 400 when workspace_name is missing', async () => {
      const res = await fetch(`${base}/api/workspace-runs/validate-gh-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns ok with empty missing_orgs by default', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());

      const validateGhAuth = vi.fn().mockResolvedValue([]);
      await stopServer(server);
      ({ server, base } = await createTestServer({
        workspaceRunsDir: wsRunsDir,
        workspacesDir,
        validateGhAuth,
      }));

      const res = await fetch(`${base}/api/workspace-runs/validate-gh-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_name: 'my-workspace' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.missing_orgs).toEqual([]);
    });
  });

  // ─── POST /api/workspace-runs/validate-base ───────────────────────────

  describe('POST /api/workspace-runs/validate-base', () => {
    it('returns 400 when workspace_name is missing', async () => {
      const res = await fetch(`${base}/api/workspace-runs/validate-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_branch: 'main' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when base_branch is missing', async () => {
      const res = await fetch(`${base}/api/workspace-runs/validate-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_name: 'my-workspace' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns missing_in repos where branch does not exist', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());

      const validateBaseBranch = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      await stopServer(server);
      ({ server, base } = await createTestServer({
        workspaceRunsDir: wsRunsDir,
        workspacesDir,
        validateBaseBranch,
      }));

      const res = await fetch(`${base}/api/workspace-runs/validate-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_name: 'my-workspace',
          base_branch: 'main',
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.missing_in).toHaveLength(1);
    });
  });

  // ─── POST /api/workspace-runs (JSON) ──────────────────────────────────

  describe('POST /api/workspace-runs (JSON)', () => {
    it('returns 400 when neither prompt nor source is provided', async () => {
      const res = await fetch(`${base}/api/workspace-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_name: 'my-workspace' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when workspace_name is missing', async () => {
      const res = await fetch(`${base}/api/workspace-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'do stuff' }),
      });
      expect(res.status).toBe(400);
    });

    it('creates workspace run and returns workspace_id', async () => {
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(
        join(workspacesDir, 'my-workspace.json'),
        JSON.stringify({ name: 'my-workspace', path: wsRoot }),
      );
      writeWorkspaceJson(wsRoot, baseWorkspace());

      const dispatchWorkspace = vi.fn();
      await stopServer(server);
      ({ server, base } = await createTestServer({
        workspaceRunsDir: wsRunsDir,
        workspacesDir,
        dispatchWorkspace,
      }));

      const res = await fetch(`${base}/api/workspace-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_name: 'my-workspace',
          prompt: 'apply migration',
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.workspace_id).toMatch(/^ws_\d{12}_[0-9a-f]+$/);
      expect(dispatchWorkspace).toHaveBeenCalledTimes(1);
    });
  });

  // ─── GET /api/workspace-runs ──────────────────────────────────────────

  describe('GET /api/workspace-runs', () => {
    it('returns empty list when directory does not exist', async () => {
      const res = await fetch(`${base}/api/workspace-runs`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.workspace_runs).toEqual([]);
    });

    it('returns workspace run summaries from pointer files', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));

      const res = await fetch(`${base}/api/workspace-runs`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.workspace_runs).toHaveLength(1);
      expect(data.workspace_runs[0].workspace_id).toBe(VALID_WS_ID);
    });
  });

  // ─── GET /api/workspace-runs/:id ──────────────────────────────────────

  describe('GET /api/workspace-runs/:id', () => {
    it('returns 400 for invalid workspace ID format', async () => {
      const res = await fetch(`${base}/api/workspace-runs/not-a-valid-ws-id`);
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown workspace run', async () => {
      const res = await fetch(`${base}/api/workspace-runs/${VALID_WS_ID}`);
      expect(res.status).toBe(404);
    });

    it('returns manifest and enriched children for known workspace run', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));

      const res = await fetch(`${base}/api/workspace-runs/${VALID_WS_ID}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.manifest.workspace_id).toBe(VALID_WS_ID);
      expect(data.manifest.dag).toBeDefined();
    });

    it('includes cost_usd in response', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));

      const res = await fetch(`${base}/api/workspace-runs/${VALID_WS_ID}`);
      const data = await res.json();
      expect(data).toHaveProperty('cost_usd');
    });
  });

  // ─── DELETE /api/workspace-runs/:id ───────────────────────────────────

  describe('DELETE /api/workspace-runs/:id', () => {
    it('returns 404 for unknown workspace run', async () => {
      const res = await fetch(`${base}/api/workspace-runs/${VALID_WS_ID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('halts a running workspace and stamps manifest', async () => {
      const haltWorkspace = vi.fn().mockReturnValue(true);
      await stopServer(server);
      ({ server, base } = await createTestServer({
        workspaceRunsDir: wsRunsDir,
        workspacesDir,
        haltWorkspace,
      }));

      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));

      const res = await fetch(`${base}/api/workspace-runs/${VALID_WS_ID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    it('returns 412 for cleanup without force on resumable state', async () => {
      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'halted', halt_reason: 'user' }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}?cleanup=1`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(412);
    });

    it('allows cleanup with force=1 on halted workspace', async () => {
      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'halted', halt_reason: 'user' }),
      );

      const runCleanup = vi.fn().mockResolvedValue({});
      await stopServer(server);
      ({ server, base } = await createTestServer({
        workspaceRunsDir: wsRunsDir,
        workspacesDir,
        runCleanup,
      }));

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}?cleanup=1&force=1`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  });

  // ─── POST /api/workspace-runs/:id/resume ──────────────────────────────

  describe('POST /api/workspace-runs/:id/resume', () => {
    it('returns 404 for unknown workspace run', async () => {
      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/resume`,
        { method: 'POST' },
      );
      expect(res.status).toBe(404);
    });

    it('returns 409 when workspace is already running', async () => {
      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'running' }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/resume`,
        { method: 'POST' },
      );
      expect(res.status).toBe(409);
    });

    it('resumes a halted workspace run', async () => {
      const dispatchWorkspace = vi.fn();
      await stopServer(server);
      ({ server, base } = await createTestServer({
        workspaceRunsDir: wsRunsDir,
        workspacesDir,
        dispatchWorkspace,
      }));

      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'halted', halt_reason: 'user' }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/resume`,
        { method: 'POST' },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  });

  // ─── POST /api/workspace-runs/:id/relaunch ────────────────────────────

  describe('POST /api/workspace-runs/:id/relaunch', () => {
    it('returns 404 for unknown workspace run', async () => {
      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/relaunch`,
        { method: 'POST' },
      );
      expect(res.status).toBe(404);
    });

    it('creates a new workspace run from an existing one', async () => {
      const dispatchWorkspace = vi.fn();
      await stopServer(server);
      ({ server, base } = await createTestServer({
        workspaceRunsDir: wsRunsDir,
        workspacesDir,
        dispatchWorkspace,
      }));

      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'completed' }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/relaunch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'updated prompt' }),
        },
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.new_workspace_id).toMatch(/^ws_\d{12}_[0-9a-f]+$/);
      expect(data.new_workspace_id).not.toBe(VALID_WS_ID);
    });
  });

  // ─── POST /api/workspace-runs/:id/re-run-integration ──────────────────

  describe('POST /api/workspace-runs/:id/re-run-integration', () => {
    it('returns 404 for unknown workspace run', async () => {
      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/re-run-integration`,
        { method: 'POST' },
      );
      expect(res.status).toBe(404);
    });

    it('re-runs integration test on an integration_failed workspace', async () => {
      const runIntegrationTest = vi
        .fn()
        .mockResolvedValue({ status: 'passed', exit_code: 0, log_path: null });
      await stopServer(server);
      ({ server, base } = await createTestServer({
        workspaceRunsDir: wsRunsDir,
        workspacesDir,
        runIntegrationTest,
      }));

      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, {
          status: 'integration_failed',
          integration_test: { status: 'failed', exit_code: 1, log_path: null },
        }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/re-run-integration`,
        { method: 'POST' },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  });

  // ─── GET /api/workspace-runs/:id/plan ─────────────────────────────────

  describe('GET /api/workspace-runs/:id/plan', () => {
    it('returns 404 for unknown workspace run', async () => {
      const res = await fetch(`${base}/api/workspace-runs/${VALID_WS_ID}/plan`);
      expect(res.status).toBe(404);
    });

    it('returns plan markdown when workspace-plan.md exists', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));
      const runDir = join(wsRoot, '.worca', 'workspace-runs', VALID_WS_ID);
      writeFileSync(join(runDir, 'workspace-plan.md'), '# Plan\n\nSummary');

      const res = await fetch(`${base}/api/workspace-runs/${VALID_WS_ID}/plan`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('# Plan');
    });

    it('returns plan JSON when Accept header requests JSON', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));
      const runDir = join(wsRoot, '.worca', 'workspace-runs', VALID_WS_ID);
      writeFileSync(
        join(runDir, 'workspace-plan.json'),
        JSON.stringify({ summary: 'test plan' }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/plan`,
        { headers: { Accept: 'application/json' } },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.summary).toBe('test plan');
    });
  });

  // ─── PUT /api/workspace-runs/:id/plan ─────────────────────────────────

  describe('PUT /api/workspace-runs/:id/plan', () => {
    it('returns 404 for unknown workspace run', async () => {
      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/plan`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan_json: { summary: 'x' } }),
        },
      );
      expect(res.status).toBe(404);
    });

    it('returns 409 when workspace status is not editable', async () => {
      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'running' }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/plan`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan_json: { summary: 'x' } }),
        },
      );
      expect(res.status).toBe(409);
    });

    it('saves plan JSON when status is planning', async () => {
      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, { status: 'planning' }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/plan`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plan_json: {
              summary: 'edited plan',
              projects: [
                {
                  name: 'api',
                  description: 'API changes',
                  acceptance_criteria: ['test'],
                },
              ],
              integration_expectations: [],
            },
          }),
        },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      const runDir = join(wsRoot, '.worca', 'workspace-runs', VALID_WS_ID);
      const saved = JSON.parse(
        readFileSync(join(runDir, 'workspace-plan.json'), 'utf8'),
      );
      expect(saved.summary).toBe('edited plan');
    });
  });

  // ─── GET /api/workspace-runs/:id/guide ────────────────────────────────

  describe('GET /api/workspace-runs/:id/guide', () => {
    it('returns 404 when no guide attached', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/guide`,
      );
      expect(res.status).toBe(404);
    });

    it('returns concatenated guide content', async () => {
      const guidePath = join(tmpDir, 'guide.md');
      writeFileSync(guidePath, '# Migration Guide\n\nStep 1...');

      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, {
          guide: {
            paths: [guidePath],
            bytes: 30,
            filenames: ['guide.md'],
          },
        }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/guide`,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Migration Guide');
    });

    it('returns 404 with guide_not_retrievable when file is missing', async () => {
      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, {
          guide: {
            paths: ['/nonexistent/guide.md'],
            bytes: 0,
            filenames: ['guide.md'],
          },
        }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/guide`,
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('guide_not_retrievable');
    });
  });

  // ─── GET /api/workspace-runs/:id/integration-log ──────────────────────

  describe('GET /api/workspace-runs/:id/integration-log', () => {
    it('returns 404 when no integration log exists', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/integration-log`,
      );
      expect(res.status).toBe(404);
    });

    it('returns integration test log as text', async () => {
      const logPath = join(tmpDir, 'integration.log');
      writeFileSync(logPath, 'PASS: all tests passed');

      writeManifest(
        wsRunsDir,
        VALID_WS_ID,
        baseManifest(wsRoot, {
          integration_test: {
            status: 'passed',
            exit_code: 0,
            log_path: logPath,
          },
        }),
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/integration-log`,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('PASS');
      expect(res.headers.get('content-type')).toContain('text/plain');
    });
  });

  // ─── GET /api/workspace-runs/:id/context/:repo ────────────────────────

  describe('GET /api/workspace-runs/:id/context/:repo', () => {
    it('returns 404 when no context artifact exists', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/context/api`,
      );
      expect(res.status).toBe(404);
    });

    it('returns context artifact markdown', async () => {
      writeManifest(wsRunsDir, VALID_WS_ID, baseManifest(wsRoot));
      const runDir = join(wsRoot, '.worca', 'workspace-runs', VALID_WS_ID);
      const contextDir = join(runDir, 'context');
      mkdirSync(contextDir, { recursive: true });
      writeFileSync(
        join(contextDir, 'api-diff.md'),
        '# Context for api\n\nDiff summary...',
      );

      const res = await fetch(
        `${base}/api/workspace-runs/${VALID_WS_ID}/context/api`,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Context for api');
    });
  });
});

// ─── status derivation (parity with fleet) ──────────────────────────────

describe('deriveWorkspaceStatus', () => {
  it('returns "running" for empty list (children not yet dispatched)', () => {
    expect(deriveWorkspaceStatus([])).toBe('running');
  });

  it('returns "running" when any child is in flight', () => {
    expect(deriveWorkspaceStatus(['running', 'completed'])).toBe('running');
    expect(deriveWorkspaceStatus(['paused', 'completed'])).toBe('running');
    expect(deriveWorkspaceStatus(['resuming', 'completed'])).toBe('running');
  });

  it('returns "completed" only when every child is completed', () => {
    expect(deriveWorkspaceStatus(['completed', 'completed', 'completed'])).toBe(
      'completed',
    );
  });

  it('returns "failed" when any child failed and none are running', () => {
    expect(deriveWorkspaceStatus(['completed', 'failed', 'completed'])).toBe(
      'failed',
    );
    expect(
      deriveWorkspaceStatus(['completed', 'setup_failed', 'completed']),
    ).toBe('failed');
    expect(
      deriveWorkspaceStatus(['completed', 'unrecoverable', 'completed']),
    ).toBe('failed');
  });

  it('returns "failed" when any child is blocked and none running', () => {
    // blocked children are terminal (an upstream dep failed) → workspace
    // can't be "completed" while one is blocked
    expect(deriveWorkspaceStatus(['completed', 'blocked', 'completed'])).toBe(
      'failed',
    );
  });

  it('treats interrupted / cancelled as terminal-but-not-failure', () => {
    // all terminal, no completed and no failed → not 'completed' but
    // not 'failed' either; falls through to 'failed' in our model since
    // the workspace can't have succeeded
    expect(
      deriveWorkspaceStatus(['interrupted', 'completed', 'completed']),
    ).toBe('failed');
  });

  it('returns "running" when some children are pending (not yet dispatched)', () => {
    // empty/unknown status counts as not-yet-dispatched → still running
    expect(deriveWorkspaceStatus(['completed', 'pending'])).toBe('running');
  });
});

describe('effectiveWorkspaceStatus', () => {
  it('preserves sticky `planning` regardless of child state', () => {
    expect(
      effectiveWorkspaceStatus({ status: 'planning' }, ['running']),
    ).toEqual({ status: 'planning', halt_reason: null });
  });

  it('preserves sticky `integration_testing` regardless of child state', () => {
    expect(
      effectiveWorkspaceStatus({ status: 'integration_testing' }, [
        'completed',
        'completed',
      ]),
    ).toEqual({ status: 'integration_testing', halt_reason: null });
  });

  it('re-derives `completed` when a child polls as running', () => {
    // Unlike fleet, workspace `completed` is NOT sticky — the orchestrator's
    // fire-and-forget launcher pattern means it routinely marks children
    // completed before they actually finish. The live child registry is
    // the source of truth.
    expect(
      effectiveWorkspaceStatus({ status: 'completed' }, ['running']),
    ).toEqual({ status: 'running', halt_reason: null });
  });

  it('re-derives `failed` when a child polls as running', () => {
    expect(effectiveWorkspaceStatus({ status: 'failed' }, ['running'])).toEqual(
      { status: 'running', halt_reason: null },
    );
  });

  it('keeps `completed` when all children are genuinely completed', () => {
    expect(
      effectiveWorkspaceStatus({ status: 'completed' }, [
        'completed',
        'completed',
        'completed',
      ]),
    ).toEqual({ status: 'completed', halt_reason: null });
  });

  it('preserves sticky `integration_failed`', () => {
    expect(
      effectiveWorkspaceStatus({ status: 'integration_failed' }, ['completed']),
    ).toEqual({ status: 'integration_failed', halt_reason: null });
  });

  it('preserves sticky `halted` with halt_reason', () => {
    expect(
      effectiveWorkspaceStatus(
        { status: 'halted', halt_reason: 'circuit_breaker' },
        ['running'],
      ),
    ).toEqual({ status: 'halted', halt_reason: 'circuit_breaker' });
  });

  it('preserves sticky `paused`', () => {
    expect(effectiveWorkspaceStatus({ status: 'paused' }, ['running'])).toEqual(
      { status: 'paused', halt_reason: null },
    );
  });

  it('re-derives only when current status is `running`', () => {
    expect(
      effectiveWorkspaceStatus({ status: 'running' }, [
        'completed',
        'completed',
        'completed',
      ]),
    ).toEqual({ status: 'completed', halt_reason: null });
    expect(
      effectiveWorkspaceStatus({ status: 'running' }, ['running']),
    ).toEqual({ status: 'running', halt_reason: null });
    expect(
      effectiveWorkspaceStatus({ status: 'running' }, ['failed', 'completed']),
    ).toEqual({ status: 'failed', halt_reason: null });
  });

  it('treats missing manifest.status as `running`', () => {
    expect(effectiveWorkspaceStatus({}, ['completed', 'completed'])).toEqual({
      status: 'completed',
      halt_reason: null,
    });
  });
});
