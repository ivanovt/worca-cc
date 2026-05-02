/**
 * Shared worktree operations — single owner of `git worktree remove` shell-out.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Remove a worktree and its registry entry.
 * Mirrors WorktreeSource.remove from src/worca/cli/cleanup.py:
 *   1. Attempt `git worktree remove --force <path>` from the project root
 *   2. On failure (e.g. non-worktree temp dir in tests), fall back to rmSync
 *   3. Run `git worktree prune` so git's metadata (`.git/worktrees/<id>/`)
 *      drops the entry even when the directory was removed manually
 *   4. Delete the registry file
 */
export function removeWorktree(worcaDir, runId) {
  const regFile = join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`);
  const projectRoot = join(worcaDir, '..');
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
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch {
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

  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    /* non-fatal */
  }

  if (existsSync(regFile)) {
    unlinkSync(regFile);
  }
}
