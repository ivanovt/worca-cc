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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./process-manager.js', () => {
  class ProcessManager {
    constructor(opts = {}) {
      this.worcaDir = opts.worcaDir;
      this.projectRoot = opts.projectRoot;
    }
    startPipeline() {
      return Promise.resolve({ pid: 1 });
    }
    stopPipeline() {
      return {};
    }
    pausePipeline() {
      return { paused: true };
    }
    getRunningPid() {
      return null;
    }
    reconcileStatus() {
      return false;
    }
    restartStage() {}
    deleteRun() {
      return { deleted: true };
    }
  }
  return { ProcessManager };
});

const { createApp } = await import('./app.js');

function startServer(worcaDir) {
  const app = createApp({ worcaDir });
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

function writePipelineEntry(worcaDir, runId, data) {
  const dir = join(worcaDir, 'multi', 'pipelines.d');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(data), 'utf8');
}

function writeWorktreeStatus(worktreePath, pipelineStatus) {
  const runDir = join(worktreePath, '.worca', 'runs', 'inner-run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'status.json'),
    JSON.stringify({ pipeline_status: pipelineStatus }),
    'utf8',
  );
}

// ─── GET /api/worktrees ──────────────────────────────────────────────────────

describe('GET /api/worktrees', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wt-routes-get-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET_empty: returns empty list when pipelines.d/ does not exist', async () => {
    const res = await fetch(`${base}/api/worktrees`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.worktrees).toEqual([]);
  });

  it('GET_enriched: returns entry with fleet_id, workspace_id, group_type, group_status, resumable', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-fleet-'));
    writeWorktreeStatus(worktreePath, 'failed');
    writePipelineEntry(tmpDir, 'run-abc', {
      run_id: 'run-abc',
      title: 'My feature',
      branch: 'feature/foo',
      worktree_path: worktreePath,
      fleet_id: 'fleet-001',
      workspace_id: null,
      group_type: 'fleet',
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
    });

    try {
      const res = await fetch(`${base}/api/worktrees`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.worktrees).toHaveLength(1);

      const wt = data.worktrees[0];
      expect(wt.run_id).toBe('run-abc');
      expect(wt.title).toBe('My feature');
      expect(wt.branch).toBe('feature/foo');
      expect(wt.worktree_path).toBe(worktreePath);
      expect(wt.status).toBe('failed');
      expect(wt.resumable).toBe(true);
      expect(wt.removable).toBe(true);
      expect(wt.fleet_id).toBe('fleet-001');
      expect(wt.workspace_id).toBeNull();
      expect(wt.group_type).toBe('fleet');
      expect(wt.group_status).toBeNull();
      expect(typeof wt.disk_bytes).toBe('number');
      expect(wt.disk_bytes).toBeGreaterThanOrEqual(0);
      expect(typeof wt.age_seconds).toBe('number');
      expect(wt.age_seconds).toBeGreaterThan(0);
      // started_at is needed by the client to sort newest-first.
      expect(typeof wt.started_at).toBe('string');
      expect(wt.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('GET_resumable_false: completed run has resumable=false', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-done-'));
    writeWorktreeStatus(worktreePath, 'completed');
    writePipelineEntry(tmpDir, 'run-done', {
      run_id: 'run-done',
      worktree_path: worktreePath,
    });

    try {
      const res = await fetch(`${base}/api/worktrees`);
      const data = await res.json();
      const wt = data.worktrees.find((w) => w.run_id === 'run-done');
      expect(wt).toBeDefined();
      expect(wt.resumable).toBe(false);
      expect(wt.removable).toBe(true);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('GET_resumable_true_paused: paused run has resumable=true', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-paused-'));
    writeWorktreeStatus(worktreePath, 'paused');
    writePipelineEntry(tmpDir, 'run-paused', {
      run_id: 'run-paused',
      worktree_path: worktreePath,
    });

    try {
      const res = await fetch(`${base}/api/worktrees`);
      const data = await res.json();
      const wt = data.worktrees.find((w) => w.run_id === 'run-paused');
      expect(wt.resumable).toBe(true);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('GET_running_not_removable: running run has removable=false', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-run-'));
    writeWorktreeStatus(worktreePath, 'running');
    writePipelineEntry(tmpDir, 'run-live', {
      run_id: 'run-live',
      worktree_path: worktreePath,
    });

    try {
      const res = await fetch(`${base}/api/worktrees`);
      const data = await res.json();
      const wt = data.worktrees.find((w) => w.run_id === 'run-live');
      expect(wt.removable).toBe(false);
      expect(wt.resumable).toBe(false);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('GET_skips_entries_without_worktree_path: ignores registry entries lacking worktree_path', async () => {
    writePipelineEntry(tmpDir, 'run-no-wt', {
      run_id: 'run-no-wt',
      title: 'Root pipeline (no worktree)',
    });

    const res = await fetch(`${base}/api/worktrees`);
    const data = await res.json();
    expect(data.worktrees).toHaveLength(0);
  });
});

// ─── DELETE /api/worktrees/:run_id ───────────────────────────────────────────

describe('DELETE /api/worktrees/:run_id', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wt-routes-del-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DELETE_409_running: returns 409 for a running worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-409-'));
    writeWorktreeStatus(worktreePath, 'running');
    writePipelineEntry(tmpDir, 'run-running', {
      run_id: 'run-running',
      worktree_path: worktreePath,
    });

    try {
      const res = await fetch(`${base}/api/worktrees/run-running`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.code).toBe('running');
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('DELETE_412_resumable_no_force: returns 412 for a resumable run without ?force=1', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-412-'));
    writeWorktreeStatus(worktreePath, 'failed');
    writePipelineEntry(tmpDir, 'run-failed', {
      run_id: 'run-failed',
      worktree_path: worktreePath,
    });

    try {
      const res = await fetch(`${base}/api/worktrees/run-failed`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(412);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.code).toBe('resumable_or_grouped');
      expect(data.resumable).toBe(true);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('DELETE_412_fleet_member_no_force: returns 412 for a fleet member without ?force=1', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-fleet-412-'));
    writeWorktreeStatus(worktreePath, 'completed');
    writePipelineEntry(tmpDir, 'run-fleet', {
      run_id: 'run-fleet',
      worktree_path: worktreePath,
      fleet_id: 'fleet-xyz',
      group_type: 'fleet',
    });

    try {
      const res = await fetch(`${base}/api/worktrees/run-fleet`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(412);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.code).toBe('resumable_or_grouped');
      expect(data.fleet_id).toBe('fleet-xyz');
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('DELETE_removes_completed: removes registry entry for a completed run (WorktreeSource.remove equivalent)', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-completed-'));
    writeWorktreeStatus(worktreePath, 'completed');
    writePipelineEntry(tmpDir, 'run-completed', {
      run_id: 'run-completed',
      worktree_path: worktreePath,
    });

    const regFile = join(tmpDir, 'multi', 'pipelines.d', 'run-completed.json');
    expect(existsSync(regFile)).toBe(true);

    const res = await fetch(`${base}/api/worktrees/run-completed`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.run_id).toBe('run-completed');

    // Registry entry must be gone (WorktreeSource.remove equivalent)
    expect(existsSync(regFile)).toBe(false);
  });

  it('DELETE_with_force_removes_resumable: ?force=1 allows removal of resumable run', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-force-'));
    writeWorktreeStatus(worktreePath, 'paused');
    writePipelineEntry(tmpDir, 'run-paused', {
      run_id: 'run-paused',
      worktree_path: worktreePath,
    });

    try {
      const res = await fetch(`${base}/api/worktrees/run-paused?force=1`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('DELETE_404_not_found: returns 404 for unknown run_id', async () => {
    const res = await fetch(`${base}/api/worktrees/no-such-run`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('DELETE_400_invalid_run_id: returns 400 for invalid run_id format', async () => {
    const res = await fetch(`${base}/api/worktrees/bad%20id!`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });
});
