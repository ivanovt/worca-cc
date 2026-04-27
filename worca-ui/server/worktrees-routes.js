/**
 * REST routes for worktree management.
 *
 * GET  /worktrees          — list worktree entries enriched with disk/age/group data
 * DELETE /worktrees/:run_id — remove a worktree (409 if running, 412 if resumable/grouped without ?force=1)
 *
 * Expects req.project.worcaDir to be set by projectResolver middleware.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';

const RESUMABLE_STATUSES = new Set(['failed', 'paused', 'cancelled']);

// Disk usage cache — keyed by worktree path, expires after 30 s
const _diskCache = new Map();
const DISK_CACHE_TTL_MS = 30_000;

function _getDiskBytes(worktreePath) {
  const now = Date.now();
  const hit = _diskCache.get(worktreePath);
  if (hit && hit.expiry > now) return hit.bytes;

  let bytes = 0;
  try {
    const out = execFileSync('du', ['-sb', worktreePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    bytes = parseInt(out.split('\t')[0], 10) || 0;
  } catch {
    bytes = 0;
  }
  _diskCache.set(worktreePath, { bytes, expiry: now + DISK_CACHE_TTL_MS });
  return bytes;
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

function _listWorktrees(worcaDir) {
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

    entries.push({
      run_id: reg.run_id || '',
      title: reg.title || '',
      branch: reg.branch || '',
      worktree_path: worktreePath,
      disk_bytes: worktreeExists ? _getDiskBytes(worktreePath) : 0,
      age_seconds: ageSeconds,
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

/**
 * Remove a worktree and its registry entry.
 * Mirrors WorktreeSource.remove from src/worca/cli/cleanup.py:
 *   1. Attempt `git worktree remove --force <path>`
 *   2. On failure (e.g. non-worktree temp dir in tests), fall back to rmSync
 *   3. Delete the registry file
 */
function _removeWorktree(worcaDir, runId) {
  const regFile = join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`);
  let worktreePath = null;

  if (existsSync(regFile)) {
    try {
      const reg = JSON.parse(readFileSync(regFile, 'utf8'));
      worktreePath = reg.worktree_path || null;
    } catch {
      /* ignore */
    }
  }

  if (worktreePath && existsSync(worktreePath)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch {
      // Path is not a registered git worktree — brute-force remove.
      // Refuse to follow symlinks: rmSync on a symlink to a real directory
      // would delete the link itself (good), but we don't want to risk a
      // user-symlinked path here being mistaken for a worktree we own.
      let isRealDir = false;
      try {
        const st = lstatSync(worktreePath);
        isRealDir = st.isDirectory() && !st.isSymbolicLink();
      } catch {
        /* ignore */
      }
      if (isRealDir) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }
  }

  if (existsSync(regFile)) {
    unlinkSync(regFile);
  }
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
  router.get('/', (req, res) => {
    const worcaDir = req.project?.worcaDir;
    if (!worcaDir) {
      return res
        .status(501)
        .json({ ok: false, error: 'worcaDir not configured' });
    }
    try {
      const worktrees = _listWorktrees(worcaDir);
      res.json({ ok: true, worktrees });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // DELETE /worktrees/:run_id
  router.delete('/:run_id', (req, res) => {
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

      _removeWorktree(worcaDir, run_id);
      res.json({ ok: true, run_id });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
