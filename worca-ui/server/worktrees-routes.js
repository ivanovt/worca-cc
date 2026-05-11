/**
 * REST routes for worktree management.
 *
 * GET  /worktrees          — list worktree entries enriched with disk/age/group data
 * DELETE /worktrees/:run_id — remove a worktree (409 if running, 412 if resumable/grouped without ?force=1)
 * POST /worktrees/cleanup  — batch remove (always returns 200 with `{ok, results, failed_count}`)
 *
 * Expects req.project.worcaDir to be set by projectResolver middleware.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 * Sum file sizes under a directory tree. Cross-platform: prior `du -sb`
 * relied on GNU coreutils and silently returned 0 on macOS / BSD du,
 * which is why the Worktrees view always showed "0 B".
 *
 * Skips symlinks (don't follow into other trees) and is bounded by
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
        stack.push(child);
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

async function _listWorktrees(worcaDir) {
  const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
  if (!existsSync(pipelinesDir)) return [];

  const entries = [];
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

    // Prefer actual status.json; fall back to registry field
    let status = reg.status || 'unknown';
    if (worktreeExists) {
      const actual = _readWorktreeStatus(worktreePath);
      if (actual) status = actual;
    }

    let ageSeconds = 0;
    if (reg.started_at) {
      const started = new Date(reg.started_at).getTime();
      if (!Number.isNaN(started)) {
        ageSeconds = Math.max(0, Math.floor((Date.now() - started) / 1_000));
      }
    }

    let diskInfo = { bytes: 0, truncated: false };
    if (worktreeExists) {
      diskInfo = await _getDiskBytes(worktreePath);
    }

    entries.push({
      run_id: reg.run_id || '',
      title: reg.title || '',
      branch: reg.branch || '',
      worktree_path: worktreePath,
      disk_bytes: diskInfo.bytes,
      truncated: diskInfo.truncated,
      age_seconds: ageSeconds,
      // started_at lets the client sort with the same sortByStartDesc helper
      // used by run-list, keeping ordering consistent across views.
      started_at: reg.started_at || null,
      status,
      removable: status !== 'running',
      fleet_id: reg.fleet_id || null,
      workspace_id: reg.workspace_id || null,
      group_type: reg.group_type || null,
      group_status: null, // populated by W-040 / W-047
      resumable: RESUMABLE_STATUSES.has(status),
    });
  }
  return entries;
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
      res.json({ ok: true, worktrees });
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
  // Batch worktree removal. Always responds with HTTP 200 and a JSON body of
  // shape `{ ok, results, failed_count }`, where `ok` is the AND of per-id
  // outcomes and `failed_count` is the number of entries with `ok: false`.
  // Per-entry errors carry a `code` field (`running`, `resumable_or_grouped`)
  // when actionable. Clients must inspect `results[]` — a single bad id never
  // aborts the batch, and partial failures are not signalled via HTTP status.
  router.post('/cleanup', async (req, res) => {
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

    const tasks = run_ids.map((run_id) => ({
      run_id,
      fn: async () => {
        const regFile = join(
          worcaDir,
          'multi',
          'pipelines.d',
          `${run_id}.json`,
        );
        if (!existsSync(regFile)) {
          return {
            run_id,
            ok: false,
            error: `Worktree "${run_id}" not found`,
          };
        }

        let reg;
        try {
          reg = JSON.parse(readFileSync(regFile, 'utf8'));
        } catch {
          return {
            run_id,
            ok: false,
            error: 'Failed to read registry entry',
          };
        }

        let status = reg.status || 'unknown';
        if (reg.worktree_path && existsSync(reg.worktree_path)) {
          const actual = _readWorktreeStatus(reg.worktree_path);
          if (actual) status = actual;
        }

        if (status === 'running') {
          return {
            run_id,
            ok: false,
            error: 'Cannot remove a running worktree',
            code: 'running',
          };
        }

        const isResumable = RESUMABLE_STATUSES.has(status);
        const isGrouped = !!(reg.fleet_id || reg.workspace_id);
        if (!force && (isResumable || isGrouped)) {
          return {
            run_id,
            ok: false,
            error:
              'Removing this worktree prevents resuming the run. Pass force=true to confirm.',
            code: 'resumable_or_grouped',
          };
        }

        try {
          await removeWorktree(worcaDir, run_id, { skipPrune: true });
          if (reg.worktree_path) _diskCache.delete(reg.worktree_path);
          return { run_id, ok: true };
        } catch (err) {
          return { run_id, ok: false, error: err.message };
        }
      },
    }));

    let results;
    try {
      results = await runWithConcurrencyLimit(tasks, CLEANUP_CONCURRENCY);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }

    try {
      await pruneWorktrees(worcaDir);
    } catch {
      /* non-fatal */
    }

    const failed_count = results.reduce((n, r) => (r.ok ? n : n + 1), 0);
    res.json({ ok: failed_count === 0, failed_count, results });
  });

  return router;
}
