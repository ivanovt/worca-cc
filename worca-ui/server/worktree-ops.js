/**
 * Shared worktree operations — single owner of `git worktree remove` shell-out.
 */

import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Remove a worktree and its registry entry.
 * Mirrors WorktreeSource.remove from src/worca/cli/cleanup.py:
 *   1. Attempt `git worktree remove --force <path>` from the project root
 *   2. On failure (e.g. non-worktree temp dir in tests), fall back to rm (async)
 *   3. Run `git worktree prune` so git's metadata (`.git/worktrees/<id>/`)
 *      drops the entry even when the directory was removed manually
 *      (skipped when skipPrune is true — caller is responsible for pruning later)
 *   4. Delete the registry file
 */
export async function removeWorktree(
  worcaDir,
  runId,
  { skipPrune = false } = {},
) {
  const regFile = join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`);
  const projectRoot = join(worcaDir, '..');
  let worktreePath = null;

  if (existsSync(regFile)) {
    try {
      const content = await readFile(regFile, 'utf8');
      const reg = JSON.parse(content);
      worktreePath = reg.worktree_path || null;
    } catch {
      /* ignore */
    }
  }

  if (worktreePath && existsSync(worktreePath)) {
    try {
      await execFileAsync(
        'git',
        ['worktree', 'remove', '--force', worktreePath],
        {
          cwd: projectRoot,
          stdio: 'pipe',
          timeout: 30_000,
        },
      );
    } catch {
      let isRealDir = false;
      try {
        const st = lstatSync(worktreePath);
        isRealDir = st.isDirectory() && !st.isSymbolicLink();
      } catch {
        /* ignore */
      }
      if (isRealDir) {
        // maxRetries handles transient ENOTEMPTY/EBUSY/EPERM on macOS when a
        // background process (Spotlight, language servers, npm install
        // finishing) touches a deep node_modules subtree between the
        // recursive walk's readdir and the final rmdir. Without retries,
        // a single race surfaces "ENOTEMPTY: directory not empty, rmdir
        // .../node_modules/lucide/dist" to the user.
        await rm(worktreePath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      }
    }
  }

  if (!skipPrune) {
    try {
      await execFileAsync('git', ['worktree', 'prune'], {
        cwd: projectRoot,
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch {
      /* non-fatal */
    }
  }

  if (existsSync(regFile)) {
    await unlink(regFile);
  }
}

/**
 * Run `git worktree prune` once for the project at worcaDir.
 * Use after a batch of removeWorktree({ skipPrune: true }) calls.
 */
export async function pruneWorktrees(worcaDir) {
  const projectRoot = join(worcaDir, '..');
  try {
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    /* non-fatal */
  }
}
