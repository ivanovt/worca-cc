import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFleetRouter } from './fleet-routes.js';

const VALID_FLEET_ID = 'f_202605120809_abcdef01';

function writeManifest(fleetRunsDir, manifest) {
  mkdirSync(fleetRunsDir, { recursive: true });
  writeFileSync(
    join(fleetRunsDir, `${manifest.fleet_id}.json`),
    JSON.stringify(manifest, null, 2),
  );
}

function baseManifest(overrides = {}) {
  return {
    fleet_id: VALID_FLEET_ID,
    fleet_id_short: 'abcdef01',
    created_at: '2026-05-12T08:09:00.000Z',
    work_request: {
      title: 'Test fleet',
      description: 'test prompt',
      source: null,
    },
    guide: null,
    plan: { mode: 'none', path: null },
    head_template: 'migration/{slug}/{project}',
    base_branch: null,
    max_parallel: 5,
    fleet_failure_threshold: 0.3,
    status: 'running',
    halt_reason: null,
    children: [],
    ...overrides,
  };
}

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

describe('Fleet Routes', () => {
  let tmpDir;
  let fleetRunsDir;
  let server;
  let base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-routes-test-'));
    fleetRunsDir = join(tmpDir, 'fleet-runs');
    ({ server, base } = await createTestServer({ fleetRunsDir }));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── GET /api/fleet-runs ──────────────────────────────────────────────────

  describe('GET /api/fleet-runs', () => {
    it('returns empty list when directory does not exist', async () => {
      const res = await fetch(`${base}/api/fleet-runs`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.fleets).toEqual([]);
    });

    it('returns summaries of existing fleet manifests', async () => {
      writeManifest(fleetRunsDir, baseManifest({ status: 'running' }));
      const res = await fetch(`${base}/api/fleet-runs`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.fleets).toHaveLength(1);
      const summary = data.fleets[0];
      expect(summary.fleet_id).toBe(VALID_FLEET_ID);
      expect(summary.status).toBe('running');
      expect(summary.children_count).toBe(0);
    });

    it('includes halt_reason in summary', async () => {
      writeManifest(
        fleetRunsDir,
        baseManifest({ status: 'halted', halt_reason: 'circuit_breaker' }),
      );
      const res = await fetch(`${base}/api/fleet-runs`);
      const data = await res.json();
      expect(data.fleets[0].halt_reason).toBe('circuit_breaker');
    });

    it('ignores malformed JSON files', async () => {
      mkdirSync(fleetRunsDir, { recursive: true });
      writeFileSync(join(fleetRunsDir, 'bad.json'), 'not json');
      writeManifest(fleetRunsDir, baseManifest());
      const res = await fetch(`${base}/api/fleet-runs`);
      const data = await res.json();
      expect(data.fleets).toHaveLength(1);
    });
  });

  // ─── GET /api/fleet-runs/:id ──────────────────────────────────────────────

  describe('GET /api/fleet-runs/:id', () => {
    it('returns 400 for invalid fleet ID format', async () => {
      const res = await fetch(`${base}/api/fleet-runs/not-a-valid-fleet-id`);
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown fleet', async () => {
      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.ok).toBe(false);
    });

    it('returns enriched manifest for known fleet', async () => {
      writeManifest(fleetRunsDir, baseManifest());
      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.fleet.fleet_id).toBe(VALID_FLEET_ID);
      expect(data.fleet.status).toBe('running');
    });

    it('enriches children with resolved status from pipelines.d/', async () => {
      const projDir = join(tmpDir, 'proj');
      const pipelinesDir = join(projDir, '.worca', 'multi', 'pipelines.d');
      mkdirSync(pipelinesDir, { recursive: true });
      writeFileSync(
        join(pipelinesDir, 'run-001.json'),
        JSON.stringify({ status: 'completed' }),
      );

      writeManifest(
        fleetRunsDir,
        baseManifest({
          children: [
            {
              run_id: 'run-001',
              project_path: projDir,
              project_slug: 'proj',
              head_branch: 'migration/v2/proj',
            },
          ],
        }),
      );

      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}`);
      const data = await res.json();
      expect(data.fleet.children[0].status).toBe('completed');
    });
  });

  // ─── Reverse lookup: discover children from registry ─────────────────────
  //
  // The dispatcher's older path initialized `children: []` and never
  // updated the manifest, leaving the fleet detail page showing "0
  // projects / $0" even though child runs existed on disk with
  // `fleet_id` set. The router now scans every registered project's
  // pipelines.d/ for matching entries and includes them in the response.

  describe('reverse-lookup of fleet children from registry', () => {
    function writeProjectEntry(prefsDirArg, name, path) {
      const dir = join(prefsDirArg, 'projects.d');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${name}.json`),
        JSON.stringify({ name, path }, null, 2),
      );
    }

    function writeRegistryEntry(projDir, runId, payload) {
      const dir = join(projDir, '.worca', 'multi', 'pipelines.d');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${runId}.json`),
        JSON.stringify({ run_id: runId, ...payload }),
      );
    }

    let prefsDir;
    let prefsServer;
    let prefsBase;

    beforeEach(async () => {
      prefsDir = join(tmpDir, 'prefs');
      ({ server: prefsServer, base: prefsBase } = await createTestServer({
        fleetRunsDir,
        prefsDir,
      }));
    });

    afterEach(async () => {
      if (prefsServer) await stopServer(prefsServer);
    });

    it('GET /api/fleet-runs reverse-discovers children when manifest is empty', async () => {
      const projA = join(tmpDir, 'proj-a');
      const projB = join(tmpDir, 'proj-b');
      writeProjectEntry(prefsDir, 'proj-a', projA);
      writeProjectEntry(prefsDir, 'proj-b', projB);
      writeRegistryEntry(projA, 'run-aaa', {
        fleet_id: VALID_FLEET_ID,
        status: 'running',
      });
      writeRegistryEntry(projB, 'run-bbb', {
        fleet_id: VALID_FLEET_ID,
        status: 'failed',
      });
      writeManifest(fleetRunsDir, baseManifest({ children: [] }));

      const res = await fetch(`${prefsBase}/api/fleet-runs`);
      const data = await res.json();
      expect(data.fleets).toHaveLength(1);
      expect(data.fleets[0].children_count).toBe(2);
      const runIds = data.fleets[0].children.map((c) => c.run_id).sort();
      expect(runIds).toEqual(['run-aaa', 'run-bbb']);
    });

    it('GET /api/fleet-runs/:id reverse-discovers and enriches status', async () => {
      const projA = join(tmpDir, 'proj-a');
      writeProjectEntry(prefsDir, 'proj-a', projA);
      writeRegistryEntry(projA, 'run-aaa', {
        fleet_id: VALID_FLEET_ID,
        status: 'completed',
      });
      writeManifest(fleetRunsDir, baseManifest({ children: [] }));

      const res = await fetch(`${prefsBase}/api/fleet-runs/${VALID_FLEET_ID}`);
      const data = await res.json();
      expect(data.fleet.children).toHaveLength(1);
      expect(data.fleet.children[0].run_id).toBe('run-aaa');
      expect(data.fleet.children[0].status).toBe('completed');
    });

    it('ignores registry entries that reference a different fleet_id', async () => {
      const projA = join(tmpDir, 'proj-a');
      writeProjectEntry(prefsDir, 'proj-a', projA);
      writeRegistryEntry(projA, 'run-aaa', {
        fleet_id: VALID_FLEET_ID,
        status: 'running',
      });
      writeRegistryEntry(projA, 'run-ccc', {
        fleet_id: 'f_999999999999_zzzzzzzz',
        status: 'running',
      });
      writeRegistryEntry(projA, 'run-ddd', { status: 'running' });
      writeManifest(fleetRunsDir, baseManifest({ children: [] }));

      const res = await fetch(`${prefsBase}/api/fleet-runs/${VALID_FLEET_ID}`);
      const data = await res.json();
      expect(data.fleet.children).toHaveLength(1);
      expect(data.fleet.children[0].run_id).toBe('run-aaa');
    });

    it('does not duplicate when manifest already lists the same (project_path, run_id)', async () => {
      const projA = join(tmpDir, 'proj-a');
      writeProjectEntry(prefsDir, 'proj-a', projA);
      writeRegistryEntry(projA, 'run-aaa', {
        fleet_id: VALID_FLEET_ID,
        status: 'running',
      });
      writeManifest(
        fleetRunsDir,
        baseManifest({
          children: [{ project_path: projA, run_id: 'run-aaa' }],
        }),
      );

      const res = await fetch(`${prefsBase}/api/fleet-runs/${VALID_FLEET_ID}`);
      const data = await res.json();
      expect(data.fleet.children).toHaveLength(1);
    });

    it('aggregates cost_usd across reverse-discovered children', async () => {
      const projA = join(tmpDir, 'proj-a');
      writeProjectEntry(prefsDir, 'proj-a', projA);
      writeRegistryEntry(projA, 'run-aaa', {
        fleet_id: VALID_FLEET_ID,
        status: 'running',
        stages: {
          planner: { iterations: [{ cost_usd: 0.15 }, { cost_usd: 0.07 }] },
        },
      });
      writeManifest(fleetRunsDir, baseManifest({ children: [] }));

      const res = await fetch(`${prefsBase}/api/fleet-runs`);
      const data = await res.json();
      expect(data.fleets[0].cost_usd).toBeCloseTo(0.22, 5);
    });
  });

  // ─── POST /api/fleet-runs/validate-base ──────────────────────────────────

  describe('POST /api/fleet-runs/validate-base', () => {
    it('returns 400 when base_branch is missing', async () => {
      const res = await fetch(`${base}/api/fleet-runs/validate-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: ['/proj'] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when projects is empty', async () => {
      const res = await fetch(`${base}/api/fleet-runs/validate-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: [], base_branch: 'main' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns ok with empty missing_in when all projects have the branch', async () => {
      const validateBaseBranch = vi.fn().mockResolvedValue(true);
      await stopServer(server);
      ({ server, base } = await createTestServer({
        fleetRunsDir,
        validateBaseBranch,
      }));

      const res = await fetch(`${base}/api/fleet-runs/validate-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projects: ['/proj1', '/proj2'],
          base_branch: 'main',
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.missing_in).toEqual([]);
    });

    it('returns missing_in list when some projects lack the branch', async () => {
      const validateBaseBranch = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      await stopServer(server);
      ({ server, base } = await createTestServer({
        fleetRunsDir,
        validateBaseBranch,
      }));

      const res = await fetch(`${base}/api/fleet-runs/validate-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projects: ['/proj1', '/proj2'],
          base_branch: 'feature',
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.missing_in).toEqual(['/proj2']);
    });
  });

  // ─── POST /api/fleet-runs ─────────────────────────────────────────────────

  describe('POST /api/fleet-runs (JSON)', () => {
    it('returns 400 when neither prompt nor source is provided', async () => {
      const res = await fetch(`${base}/api/fleet-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: ['/proj'] }),
      });
      expect(res.status).toBe(400);
    });

    it('creates fleet and returns fleet_id and manifest_path', async () => {
      const dispatched = [];
      const dispatchFleet = vi.fn(async (args) => dispatched.push(args));
      await stopServer(server);
      ({ server, base } = await createTestServer({
        fleetRunsDir,
        dispatchFleet,
      }));

      const res = await fetch(`${base}/api/fleet-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: ['/proj1'], prompt: 'run tests' }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.fleet_id).toMatch(/^f_\d{12}_[0-9a-f]+$/);
      expect(data.manifest_path).toContain(data.fleet_id);
      expect(dispatched).toHaveLength(1);
    });

    it('writes manifest to fleetRunsDir with correct fields', async () => {
      const dispatchFleet = vi.fn();
      await stopServer(server);
      ({ server, base } = await createTestServer({
        fleetRunsDir,
        dispatchFleet,
      }));

      const res = await fetch(`${base}/api/fleet-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projects: ['/proj1', '/proj2'],
          prompt: 'apply migration',
          base_branch: 'main',
          head_template: 'migration/{project}',
        }),
      });
      const data = await res.json();
      expect(existsSync(join(fleetRunsDir, `${data.fleet_id}.json`))).toBe(
        true,
      );
    });

    it('marks manifest status as failed when dispatch throws', async () => {
      const dispatchFleet = vi
        .fn()
        .mockRejectedValue(new Error('spawn failed'));
      await stopServer(server);
      ({ server, base } = await createTestServer({
        fleetRunsDir,
        dispatchFleet,
      }));

      const res = await fetch(`${base}/api/fleet-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: ['/proj1'], prompt: 'test' }),
      });
      expect(res.status).toBe(500);
    });
  });

  // ─── DELETE /api/fleet-runs/:id ───────────────────────────────────────────

  describe('DELETE /api/fleet-runs/:id', () => {
    it('returns 404 for unknown fleet', async () => {
      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('halts a running fleet and returns halted_count', async () => {
      writeManifest(fleetRunsDir, baseManifest({ status: 'running' }));
      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data).toHaveProperty('halted_count');
    });

    it('plain DELETE on halted fleet is idempotent (200, no-op)', async () => {
      writeManifest(fleetRunsDir, baseManifest({ status: 'halted' }));
      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.already_halted).toBe(true);
      expect(data.halted_count).toBe(0);
    });

    it('plain DELETE on failed fleet is idempotent (200, no-op)', async () => {
      writeManifest(fleetRunsDir, baseManifest({ status: 'failed' }));
      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.already_halted).toBe(true);
    });

    it('returns 412 on cleanup of halted fleet without ?force=1', async () => {
      // The 412 gate is scoped to ?cleanup=1 (resume-loss warning).
      writeManifest(fleetRunsDir, baseManifest({ status: 'halted' }));
      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}?cleanup=1`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(412);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.current_status).toBe('halted');
    });

    it('returns 412 on cleanup of failed fleet without ?force=1', async () => {
      writeManifest(fleetRunsDir, baseManifest({ status: 'failed' }));
      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}?cleanup=1`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(412);
    });

    it('cleanup succeeds on halted fleet when ?force=1 is set', async () => {
      const runCleanup = vi
        .fn()
        .mockResolvedValue({ cleaned_worktrees: 0, freed_bytes: 0 });
      await stopServer(server);
      ({ server, base } = await createTestServer({ fleetRunsDir, runCleanup }));
      writeManifest(fleetRunsDir, baseManifest({ status: 'halted' }));
      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}?cleanup=1&force=1`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
    });

    it('invokes runCleanup when ?cleanup=1 is set', async () => {
      const runCleanup = vi
        .fn()
        .mockResolvedValue({ cleaned_worktrees: 2, freed_bytes: 1024 });
      await stopServer(server);
      ({ server, base } = await createTestServer({ fleetRunsDir, runCleanup }));
      writeManifest(fleetRunsDir, baseManifest({ status: 'running' }));

      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}?cleanup=1`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(runCleanup).toHaveBeenCalledWith(VALID_FLEET_ID);
      expect(data.cleaned_worktrees).toBe(2);
    });

    it('updates manifest halt_reason to "user" on halt', async () => {
      const { readFileSync } = await import('node:fs');
      writeManifest(fleetRunsDir, baseManifest({ status: 'running' }));
      await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}`, {
        method: 'DELETE',
      });
      const manifest = JSON.parse(
        readFileSync(join(fleetRunsDir, `${VALID_FLEET_ID}.json`), 'utf8'),
      );
      expect(manifest.status).toBe('halted');
      expect(manifest.halt_reason).toBe('user');
    });
  });

  // ─── POST /api/fleet-runs/:id/resume ─────────────────────────────────────

  describe('POST /api/fleet-runs/:id/resume', () => {
    it('returns 404 for unknown fleet', async () => {
      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}/resume`,
        { method: 'POST' },
      );
      expect(res.status).toBe(404);
    });

    it('returns 409 when fleet is already running', async () => {
      writeManifest(fleetRunsDir, baseManifest({ status: 'running' }));
      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}/resume`,
        { method: 'POST' },
      );
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.ok).toBe(false);
    });

    it('returns 410 when a child worktree has been cleaned', async () => {
      // Child has run_id but no registry entry → was cleaned
      writeManifest(
        fleetRunsDir,
        baseManifest({
          status: 'halted',
          children: [
            {
              run_id: 'run-cleaned-001',
              project_path: join(tmpDir, 'proj-cleaned'),
              project_slug: 'proj-cleaned',
            },
          ],
        }),
      );

      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}/resume`,
        { method: 'POST' },
      );
      expect(res.status).toBe(410);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.cleaned_run_ids).toContain('run-cleaned-001');
    });

    it('resumes halted fleet when children have registry entries', async () => {
      const projDir = join(tmpDir, 'proj-resumed');
      const pipelinesDir = join(projDir, '.worca', 'multi', 'pipelines.d');
      mkdirSync(pipelinesDir, { recursive: true });
      writeFileSync(
        join(pipelinesDir, 'run-alive-001.json'),
        JSON.stringify({ status: 'failed' }),
      );

      const dispatchFleet = vi.fn().mockResolvedValue({ relaunched_count: 1 });
      await stopServer(server);
      ({ server, base } = await createTestServer({
        fleetRunsDir,
        dispatchFleet,
      }));

      writeManifest(
        fleetRunsDir,
        baseManifest({
          status: 'halted',
          children: [
            {
              run_id: 'run-alive-001',
              project_path: projDir,
              project_slug: 'proj-resumed',
            },
          ],
        }),
      );

      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}/resume`,
        { method: 'POST' },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.relaunched_count).toBe(1);
      expect(dispatchFleet).toHaveBeenCalledWith(
        expect.objectContaining({ fleet_id: VALID_FLEET_ID, resume: true }),
      );
    });
  });

  // ─── POST /api/fleet-runs/:id/relaunch ───────────────────────────────────

  describe('POST /api/fleet-runs/:id/relaunch', () => {
    it('returns 404 for unknown fleet', async () => {
      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}/relaunch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      expect(res.status).toBe(404);
    });

    it('creates a new fleet derived from existing manifest', async () => {
      const dispatchFleet = vi.fn().mockResolvedValue({});
      await stopServer(server);
      ({ server, base } = await createTestServer({
        fleetRunsDir,
        dispatchFleet,
      }));
      writeManifest(
        fleetRunsDir,
        baseManifest({ status: 'completed', children: [] }),
      );

      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}/relaunch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.new_fleet_id).toMatch(/^f_\d{12}_[0-9a-f]+$/);
      expect(data.new_fleet_id).not.toBe(VALID_FLEET_ID);
    });

    it('applies prompt override to new fleet', async () => {
      const dispatchFleet = vi.fn().mockResolvedValue({});
      await stopServer(server);
      ({ server, base } = await createTestServer({
        fleetRunsDir,
        dispatchFleet,
      }));
      writeManifest(fleetRunsDir, baseManifest({ status: 'completed' }));

      const res = await fetch(
        `${base}/api/fleet-runs/${VALID_FLEET_ID}/relaunch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'updated prompt' }),
        },
      );
      const data = await res.json();
      const { readFileSync } = await import('node:fs');
      const newManifest = JSON.parse(
        readFileSync(join(fleetRunsDir, `${data.new_fleet_id}.json`), 'utf8'),
      );
      expect(newManifest.work_request.description).toBe('updated prompt');
    });
  });

  // ─── GET /api/fleet-runs/:id/guide ───────────────────────────────────────

  describe('GET /api/fleet-runs/:id/guide', () => {
    it('returns 404 for unknown fleet', async () => {
      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}/guide`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when fleet has no guide', async () => {
      writeManifest(fleetRunsDir, baseManifest({ guide: null }));
      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}/guide`);
      expect(res.status).toBe(404);
    });

    it('returns 404 with guide_not_retrievable when CLI path is unreadable', async () => {
      writeManifest(
        fleetRunsDir,
        baseManifest({
          guide: {
            paths: ['/nonexistent/machine/spec.md'],
            bytes: 100,
            filenames: ['spec.md'],
            uploaded: false,
          },
        }),
      );

      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}/guide`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('guide_not_retrievable');
      expect(data.hint).toBeTruthy();
    });

    it('returns concatenated guide content as text/markdown', async () => {
      const guideDir = join(fleetRunsDir, VALID_FLEET_ID, 'guides');
      mkdirSync(guideDir, { recursive: true });
      const guidePath = join(guideDir, 'spec.md');
      writeFileSync(guidePath, '# Migration Guide\n\nDo this.');

      writeManifest(
        fleetRunsDir,
        baseManifest({
          guide: {
            paths: [guidePath],
            bytes: 30,
            filenames: ['spec.md'],
            uploaded: true,
          },
        }),
      );

      const res = await fetch(`${base}/api/fleet-runs/${VALID_FLEET_ID}/guide`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/markdown');
      const text = await res.text();
      expect(text).toContain('# Migration Guide');
    });
  });
});
