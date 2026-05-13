/**
 * REST routes for worktree management.
 *
 * GET  /worktrees          — list worktree entries enriched with disk/age/group data
 * DELETE /worktrees/:run_id — remove a worktree (409 if running, 412 if resumable/grouped without ?force=1)
 * POST /worktrees/cleanup  — batch remove (always returns 200 with `{ok, results, failed_count}`)
 *
 * Expects req.project.worcaDir to be set by projectResolver middleware.
 *
 * NOTE on disk semantics: `disk_bytes` reflects project files only — vendored
 * and derived directories listed in WALK_SKIP_DIRS (node_modules, .git, .venv,
 * dist, build, .next, etc.) are skipped during the walk. This answers "how
 * much project disk would I free?" rather than raw on-disk bytes, and makes
 * cold first loads ~10× faster on node_modules-heavy worktrees. The route
 * surfaces `disk_walk_skip_dirs` in the GET response so clients can document
 * the discrepancy with `du -sh`.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { pruneWorktrees, removeWorktree } from './worktree-ops.js';

const CLEANUP_CONCURRENCY = 4;

/**
 * Run an array of `{run_id, fn}` tasks with bounded concurrency.
 * Tasks are expected to return a result object — but if one throws,
 * the limiter converts the throw into an attributable failure result
 * so a single bad task can't halt the rest of the batch.
 */
async function runWithConcurrencyLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      const { run_id, fn } = tasks[idx];
      try {
        results[idx] = await fn();
      } catch (err) {
        results[idx] = {
          run_id,
          ok: false,
          error: err?.message || String(err),
        };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return results;
}

const RESUMABLE_STATUSES = new Set(['failed', 'paused', 'cancelled']);

// Disk usage cache — keyed by worktree path, expires after 30 s
const _diskCache = new Map();
const DISK_CACHE_TTL_MS = 30_000;

/**
 * Directory names skipped during the disk walk. These are vendored or derived
 * trees that dominate file count without changing the user's mental model of
 * "project disk". Excluding them drops the walked file count by ~10–20× on
 * typical worktrees and keeps `disk_bytes` focused on the project's own
 * source files — closing the gap between "raw on-disk bytes" and "bytes I
 * would actually free by cleaning up this worktree".
 */
export const WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
]);

/**
 * Sum file sizes under a directory tree. Cross-platform: prior `du -sb`
 * relied on GNU coreutils and silently returned 0 on macOS / BSD du,
 * which is why the Worktrees view always showed "0 B".
 *
 * Skips symlinks (don't follow into other trees), skips directory names in
 * WALK_SKIP_DIRS (node_modules, .git, build/cache dirs), and is bounded by
 * MAX_WALK_FILES so a runaway directory can't hang the request.
 * Override the cap with WORCA_DISK_WALK_MAX (positive integer); the
 * raised default of 1M handles node_modules-heavy worktrees, but very
 * large monorepos may still want a higher ceiling.
 * Errors on individual entries are swallowed so a transiently-locked
 * file doesn't poison the whole sum.
 */
function _resolveWalkCap() {
  const raw = process.env.WORCA_DISK_WALK_MAX;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1_000_000;
}
const MAX_WALK_FILES = _resolveWalkCap();
export async function walkDirSize(rootPath, maxFiles = MAX_WALK_FILES) {
  let bytes = 0;
  let count = 0;
  const stack = [rootPath];
  while (stack.length > 0 && count < maxFiles) {
    const cur = stack.pop();
    let dir;
    try {
      dir = await fsp.opendir(cur);
    } catch {
      continue;
    }
    for await (const e of dir) {
      count++;
      if (count >= maxFiles) break;
      const child = join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(e.name)) stack.push(child);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(child);
          bytes += st.size;
        } catch {
          /* ignore — file vanished mid-walk */
        }
      }
    }
  }
  return { bytes, truncated: count >= maxFiles };
}

async function _getDiskBytes(worktreePath) {
  const now = Date.now();
  const hit = _diskCache.get(worktreePath);
  if (hit && hit.expiry > now)
    return { bytes: hit.bytes, truncated: hit.truncated };

  let result = { bytes: 0, truncated: false };
  try {
    result = await walkDirSize(worktreePath);
  } catch {
    result = { bytes: 0, truncated: false };
  }
  _diskCache.set(worktreePath, {
    bytes: result.bytes,
    truncated: result.truncated,
    expiry: now + DISK_CACHE_TTL_MS,
  });
  return result;
}

/**
 * Read pipeline_status from a worktree's status.json files.
 * Checks .worca/runs/ (W-048 layout) then flat .worca/status.json (legacy).
 * Returns null if no status file is found.
 */
function _readWorktreeStatus(worktreePath) {
  const runsDir = join(worktreePath, '.worca', 'runs');
  if (existsSync(runsDir)) {
    for (const entry of readdirSync(runsDir)) {
      const sp = join(runsDir, entry, 'status.json');
      if (!existsSync(sp)) continue;
      try {
        const data = JSON.parse(readFileSync(sp, 'utf8'));
        if (data.pipeline_status) return data.pipeline_status;
      } catch {
        /* ignore malformed */
      }
    }
  }

  const flat = join(worktreePath, '.worca', 'status.json');
  if (existsSync(flat)) {
    try {
      const data = JSON.parse(readFileSync(flat, 'utf8'));
      if (data.pipeline_status) return data.pipeline_status;
    } catch {
      /* ignore malformed */
    }
  }

  return null;
}

/**
 * Run a pre-validated cleanup batch in the background. Each task stamps
 * `cleanup_state: 'cleaning'`, calls `removeWorktree` (which deletes the
 * registry entry on success), and on failure stamps `cleanup_error` while
 * clearing `cleanup_state` so the UI can render the error and let the user
 * retry. Concurrency is bounded by `CLEANUP_CONCURRENCY`.
 */
async function _runCleanupBatch(worcaDir, accepted) {
  const tasks = accepted.map(({ run_id, reg }) => ({
    run_id,
    fn: async () => {
      _patchRegistry(worcaDir, run_id, { cleanup_state: 'cleaning' });
      try {
        await removeWorktree(worcaDir, run_id, { skipPrune: true });
        if (reg.worktree_path) _diskCache.delete(reg.worktree_path);
        return { run_id, ok: true };
      } catch (err) {
        _patchRegistry(worcaDir, run_id, {
          cleanup_state: undefined,
          cleanup_error: err?.message || String(err),
        });
        return { run_id, ok: false, error: err?.message || String(err) };
      }
    },
  }));

  try {
    await runWithConcurrencyLimit(tasks, CLEANUP_CONCURRENCY);
  } catch {
    /* per-task failures already persisted into the registry */
  }

  try {
    await pruneWorktrees(worcaDir);
  } catch {
    /* non-fatal */
  }
}

/**
 * Atomically patch fields on a pipelines.d/<run>.json entry.
 * Set a field to `undefined` to delete it. Returns `false` if the file is
 * gone (the worktree was already cleaned up) or unreadable.
 *
 * Note: write is not strictly atomic — for a single-writer-per-id model
 * (the cleanup background task owns its registry entry for the lifetime
 * of the cleanup), read-modify-write is fine. A multi-writer scenario
 * would need rename-into-place; we don't have that here.
 */
function _patchRegistry(worcaDir, runId, patch) {
  const regFile = join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`);
  if (!existsSync(regFile)) return false;
  let reg;
  try {
    reg = JSON.parse(readFileSync(regFile, 'utf8'));
  } catch {
    return false;
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete reg[k];
    else reg[k] = v;
  }
  try {
    writeFileSync(regFile, JSON.stringify(reg, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function _isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

async function _listWorktrees(worcaDir) {
  const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
  if (!existsSync(pipelinesDir)) return [];

  // Phase 1: cheap synchronous metadata (registry parse, status read).
  // Phase 2: disk walks in parallel — without this, 13 worktrees serialize
  // ~3s of awaits even when most results would have been disk-cache hits.
  const metas = [];
  for (const file of readdirSync(pipelinesDir)) {
    if (!file.endsWith('.json')) continue;

    let reg;
    try {
      reg = JSON.parse(readFileSync(join(pipelinesDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!reg.worktree_path) continue;

    const worktreePath = reg.worktree_path;
    const worktreeExists = existsSync(worktreePath);

    let status = reg.status || 'unknown';
    if (worktreeExists) {
      const actual = _readWorktreeStatus(worktreePath);
      if (actual) status = actual;
    }

    // Stale-registry reconciliation: a child can die before ever writing
    // status.json (e.g. fleet halt right after dispatch, preflight crash,
    // SIGKILL). In that case the worktree exists but .worca/runs/ doesn't,
    // _readWorktreeStatus returns null, and we'd fall back to reg.status
    // which may still say "running" with a dead pid. Treat that as
    // "interrupted" and patch the registry so this only happens once.
    //
    // Only reconcile when reg.pid is present — a missing pid means the
    // entry is either from a non-standard registration path (e.g. test
    // fixtures) or pre-dates the pid-on-registration contract, so we
    // can't make liveness claims about it.
    if (
      status === 'running' &&
      typeof reg.pid === 'number' &&
      !_isPidAlive(reg.pid)
    ) {
      status = 'interrupted';
      _patchRegistry(worcaDir, reg.run_id, {
        status: 'interrupted',
        interrupted_reason: 'stale_pid',
      });
    }

    let ageSeconds = 0;
    if (reg.started_at) {
      const started = new Date(reg.started_at).getTime();
      if (!Number.isNaN(started)) {
        ageSeconds = Math.max(0, Math.floor((Date.now() - started) / 1_000));
      }
    }

    metas.push({
      reg,
      worktreePath,
      worktreeExists,
      status,
      ageSeconds,
      cleanup_state: reg.cleanup_state || null,
      cleanup_error: reg.cleanup_error || null,
    });
  }

  const disks = await Promise.all(
    metas.map((m) =>
      m.worktreeExists
        ? _getDiskBytes(m.worktreePath)
        : Promise.resolve({ bytes: 0, truncated: false }),
    ),
  );

  return metas.map((m, i) => ({
    run_id: m.reg.run_id || '',
    title: m.reg.title || '',
    branch: m.reg.branch || '',
    worktree_path: m.worktreePath,
    disk_bytes: disks[i].bytes,
    truncated: disks[i].truncated,
    age_seconds: m.ageSeconds,
    started_at: m.reg.started_at || null,
    status: m.status,
    removable: m.status !== 'running',
    fleet_id: m.reg.fleet_id || null,
    workspace_id: m.reg.workspace_id || null,
    group_type: m.reg.group_type || null,
    group_status: null,
    resumable: RESUMABLE_STATUSES.has(m.status),
    cleanup_state: m.cleanup_state,
    cleanup_error: m.cleanup_error,
  }));
}

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;
function _validateRunId(runId) {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length <= 128 &&
    RUN_ID_RE.test(runId)
  );
}

/**
 * Create the worktrees REST router.
 * Mount with: router.use('/worktrees', requireWorcaDir, createWorktreesRouter())
 */
export function createWorktreesRouter() {
  const router = Router({ mergeParams: true });

  // GET /worktrees
  router.get('/', async (req, res) => {
    const worcaDir = req.project?.worcaDir;
    if (!worcaDir) {
      return res
        .status(501)
        .json({ ok: false, error: 'worcaDir not configured' });
    }
    try {
      const worktrees = await _listWorktrees(worcaDir);
      res.json({
        ok: true,
        worktrees,
        // Documents the semantics shift in `disk_bytes` (project files only).
        // Clients can render this as a caveat next to disk totals.
        disk_walk_skip_dirs: [...WALK_SKIP_DIRS],
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // DELETE /worktrees/:run_id
  router.delete('/:run_id', async (req, res) => {
    const worcaDir = req.project?.worcaDir;
    if (!worcaDir) {
      return res
        .status(501)
        .json({ ok: false, error: 'worcaDir not configured' });
    }

    const { run_id } = req.params;
    if (!_validateRunId(run_id)) {
      return res.status(400).json({ ok: false, error: 'Invalid run ID' });
    }

    const force = req.query.force === '1';

    try {
      const regFile = join(worcaDir, 'multi', 'pipelines.d', `${run_id}.json`);
      if (!existsSync(regFile)) {
        return res
          .status(404)
          .json({ ok: false, error: `Worktree "${run_id}" not found` });
      }

      let reg;
      try {
        reg = JSON.parse(readFileSync(regFile, 'utf8'));
      } catch {
        return res
          .status(500)
          .json({ ok: false, error: 'Failed to read registry entry' });
      }

      // Derive actual pipeline status
      let status = reg.status || 'unknown';
      if (reg.worktree_path && existsSync(reg.worktree_path)) {
        const actual = _readWorktreeStatus(reg.worktree_path);
        if (actual) status = actual;
      }

      // 409 — cannot remove a running worktree
      if (status === 'running') {
        return res.status(409).json({
          ok: false,
          error: 'Cannot remove a running worktree',
          code: 'running',
        });
      }

      // 412 — resumable or grouped run requires ?force=1 confirmation
      const isResumable = RESUMABLE_STATUSES.has(status);
      const isGrouped = !!(reg.fleet_id || reg.workspace_id);
      if (!force && (isResumable || isGrouped)) {
        return res.status(412).json({
          ok: false,
          error:
            'Removing this worktree prevents resuming the run. Use ?force=1 to confirm.',
          code: 'resumable_or_grouped',
          resumable: isResumable,
          fleet_id: reg.fleet_id || null,
          workspace_id: reg.workspace_id || null,
        });
      }

      await removeWorktree(worcaDir, run_id);
      if (reg.worktree_path) _diskCache.delete(reg.worktree_path);
      res.json({ ok: true, run_id });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /worktrees/cleanup
  //
  // Batch worktree removal — async. Synchronously validates each id and
  // stamps `cleanup_state: 'pending'` on the registry entries that pass
  // pre-flight checks, then returns 202. The actual removal happens in
  // the background with bounded concurrency. Clients poll GET /worktrees
  // and observe `cleanup_state` per entry; on success the entry vanishes,
  // on failure `cleanup_error` is set and `cleanup_state` is cleared.
  //
  // Response shape `{ ok, accepted, rejected }` where `rejected[]` carries
  // entries that failed pre-flight (running, resumable without force, etc).
  // A single bad id never blocks the rest of the batch; this stays
  // compatible with the legacy synchronous shape's promise that partial
  // failures are not signalled via HTTP status.
  router.post('/cleanup', (req, res) => {
    const worcaDir = req.project?.worcaDir;
    if (!worcaDir) {
      return res
        .status(501)
        .json({ ok: false, error: 'worcaDir not configured' });
    }

    const { run_ids, force = false } = req.body || {};
    if (!Array.isArray(run_ids) || run_ids.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'run_ids must be a non-empty array' });
    }
    for (const id of run_ids) {
      if (!_validateRunId(id)) {
        return res
          .status(400)
          .json({ ok: false, error: `Invalid run ID: ${id}` });
      }
    }

    // Pre-flight: read each registry entry, decide pending vs reject. We do
    // this synchronously so the HTTP response can carry the rejection list
    // — clients shouldn't have to poll to learn that a 'running' worktree
    // was refused.
    const accepted = [];
    const rejected = [];
    for (const run_id of run_ids) {
      const regFile = join(worcaDir, 'multi', 'pipelines.d', `${run_id}.json`);
      if (!existsSync(regFile)) {
        rejected.push({
          run_id,
          ok: false,
          error: `Worktree "${run_id}" not found`,
        });
        continue;
      }
      let reg;
      try {
        reg = JSON.parse(readFileSync(regFile, 'utf8'));
      } catch {
        rejected.push({
          run_id,
          ok: false,
          error: 'Failed to read registry entry',
        });
        continue;
      }

      let status = reg.status || 'unknown';
      if (reg.worktree_path && existsSync(reg.worktree_path)) {
        const actual = _readWorktreeStatus(reg.worktree_path);
        if (actual) status = actual;
      }

      if (status === 'running') {
        rejected.push({
          run_id,
          ok: false,
          error: 'Cannot remove a running worktree',
          code: 'running',
        });
        continue;
      }

      const isResumable = RESUMABLE_STATUSES.has(status);
      const isGrouped = !!(reg.fleet_id || reg.workspace_id);
      if (!force && (isResumable || isGrouped)) {
        rejected.push({
          run_id,
          ok: false,
          error:
            'Removing this worktree prevents resuming the run. Pass force=true to confirm.',
          code: 'resumable_or_grouped',
        });
        continue;
      }

      // Stamp pending so a reload mid-cleanup shows the same state.
      _patchRegistry(worcaDir, run_id, {
        cleanup_state: 'pending',
        cleanup_error: undefined,
      });
      accepted.push({ run_id, reg });
    }

    // Respond immediately — the client polls GET /worktrees to observe progress.
    res.status(202).json({
      ok: rejected.length === 0,
      accepted: accepted.map((a) => a.run_id),
      rejected,
    });

    // Fire-and-forget background removal. Errors are persisted into the
    // registry so the client can render them; nothing here is awaited by
    // the HTTP request.
    void _runCleanupBatch(worcaDir, accepted);
  });

  return router;
}
