import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRemoveWorktree = vi.fn();
const mockPruneWorktrees = vi.fn();

vi.mock('./worktree-ops.js', () => ({
  removeWorktree: (...args) => mockRemoveWorktree(...args),
  pruneWorktrees: (...args) => mockPruneWorktrees(...args),
}));

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
const { _walkDirSize } = await import('./worktrees-routes.js');

// Default mock behaviour: mirror the registry-file deletion that real removeWorktree does.
// Tests that need different behaviour override mockImplementation inline.
beforeEach(() => {
  mockRemoveWorktree.mockImplementation(async (worcaDir, runId) => {
    const regPath = join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`);
    try {
      unlinkSync(regPath);
    } catch {
      /* ignore */
    }
  });
  mockPruneWorktrees.mockResolvedValue(undefined);
});

afterEach(() => {
  mockRemoveWorktree.mockReset();
  mockPruneWorktrees.mockReset();
});

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

// ─── POST /api/worktrees/cleanup ─────────────────────────────────────────────

describe('POST /api/worktrees/cleanup', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wt-routes-cleanup-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST_cleanup_parallelises_prune_once: runs ≤4 concurrent removes and prunes exactly once', async () => {
    for (let i = 1; i <= 6; i++) {
      writePipelineEntry(tmpDir, `run-bulk-${i}`, {
        run_id: `run-bulk-${i}`,
        worktree_path: `/nonexistent/fake-${i}`,
        status: 'completed',
      });
    }

    let concurrent = 0;
    let maxConcurrent = 0;

    mockRemoveWorktree.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
    });

    const res = await fetch(`${base}/api/worktrees/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        run_ids: [
          'run-bulk-1',
          'run-bulk-2',
          'run-bulk-3',
          'run-bulk-4',
          'run-bulk-5',
          'run-bulk-6',
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(6);
    expect(data.results.every((r) => r.ok)).toBe(true);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
    expect(mockPruneWorktrees).toHaveBeenCalledTimes(1);
  });

  it('POST_cleanup_per_id_success_failure: returns per-id error for missing/running, ok for completed', async () => {
    const worktreeRunning = mkdtempSync(join(tmpdir(), 'wt-cleanup-running-'));
    writeWorktreeStatus(worktreeRunning, 'running');
    writePipelineEntry(tmpDir, 'run-running-c', {
      run_id: 'run-running-c',
      worktree_path: worktreeRunning,
    });
    writePipelineEntry(tmpDir, 'run-ok-c', {
      run_id: 'run-ok-c',
      worktree_path: '/nonexistent/ok',
      status: 'completed',
    });

    try {
      const res = await fetch(`${base}/api/worktrees/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_ids: ['run-missing-c', 'run-running-c', 'run-ok-c'],
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toHaveLength(3);

      const missing = data.results.find((r) => r.run_id === 'run-missing-c');
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatch(/not found/i);

      const running = data.results.find((r) => r.run_id === 'run-running-c');
      expect(running.ok).toBe(false);
      expect(running.code).toBe('running');

      const ok = data.results.find((r) => r.run_id === 'run-ok-c');
      expect(ok.ok).toBe(true);
    } finally {
      rmSync(worktreeRunning, { recursive: true, force: true });
    }
  });

  it('POST_cleanup_force_removes_grouped_completed: force=true bypasses 412 and removes fleet member', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-fleet-cleanup-'));
    writeWorktreeStatus(worktreePath, 'completed');
    writePipelineEntry(tmpDir, 'run-fleet-c', {
      run_id: 'run-fleet-c',
      worktree_path: worktreePath,
      fleet_id: 'fleet-xyz',
      group_type: 'fleet',
      status: 'completed',
    });

    const regFile = join(tmpDir, 'multi', 'pipelines.d', 'run-fleet-c.json');
    expect(existsSync(regFile)).toBe(true);

    try {
      const res = await fetch(`${base}/api/worktrees/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_ids: ['run-fleet-c'], force: true }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.results[0].run_id).toBe('run-fleet-c');
      expect(data.results[0].ok).toBe(true);
      expect(existsSync(regFile)).toBe(false);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('DELETE_cache_evicted_on_delete: stale disk cache is cleared after single DELETE', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'wt-cache-evict-'));
    writeWorktreeStatus(worktreePath, 'completed');
    const bigFilePath = join(worktreePath, 'bigfile.bin');
    writeFileSync(bigFilePath, 'x'.repeat(1_000_000));
    writePipelineEntry(tmpDir, 'run-cache-evict', {
      run_id: 'run-cache-evict',
      worktree_path: worktreePath,
      status: 'completed',
    });

    try {
      // Populate the cache via GET
      const res1 = await fetch(`${base}/api/worktrees`);
      const data1 = await res1.json();
      const wt1 = data1.worktrees.find((w) => w.run_id === 'run-cache-evict');
      expect(wt1).toBeDefined();
      expect(wt1.disk_bytes).toBeGreaterThanOrEqual(1_000_000);

      // Remove the big file so a fresh walk would return a much smaller number
      unlinkSync(bigFilePath);

      // DELETE — should evict the cache entry for worktreePath
      const delRes = await fetch(`${base}/api/worktrees/run-cache-evict`, {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);

      // Re-register the same worktree path under a new run_id
      writePipelineEntry(tmpDir, 'run-cache-evict-2', {
        run_id: 'run-cache-evict-2',
        worktree_path: worktreePath,
        status: 'completed',
      });

      // GET again — must do a fresh walk (not return stale cached bytes)
      const res2 = await fetch(`${base}/api/worktrees`);
      const data2 = await res2.json();
      const wt2 = data2.worktrees.find((w) => w.run_id === 'run-cache-evict-2');
      expect(wt2).toBeDefined();
      expect(wt2.disk_bytes).toBeLessThan(1_000_000);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});

// ─── Async disk walker ────────────────────────────────────────────────────────

describe('_walkDirSize (async walker)', () => {
  it('WALKER_accurate_bytes: returns accurate bytes and truncated=false for normal trees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-walker-bytes-'));
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(10_000));
    writeFileSync(join(dir, 'b.bin'), Buffer.alloc(20_000));
    try {
      const result = await _walkDirSize(dir);
      expect(result.bytes).toBeGreaterThanOrEqual(30_000);
      expect(result.truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WALKER_truncated: reports truncated=true when entry count exceeds cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-walker-trunc-'));
    // Create 6 files so that walking with cap=5 triggers truncation
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, `f${i}.txt`), 'x');
    }
    try {
      const result = await _walkDirSize(dir, 5);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
