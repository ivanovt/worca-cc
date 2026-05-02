/**
 * Resolve a runId to its on-disk run directory and status file path.
 *
 * Worktree runs live under `<worktree_path>/.worca/runs/<runId>/`, but they
 * are registered in the parent project's `<worcaDir>/multi/pipelines.d/<runId>.json`.
 * Callers that only know the parent worcaDir + runId need this overlay to
 * find the actual run files. Local (non-worktree) runs continue to live in
 * `<worcaDir>/runs/<runId>/` or `<worcaDir>/results/<runId>/`.
 *
 * Resolution order:
 *   1. `<worcaDir>/runs/<runId>/`       (local active)
 *   2. `<worcaDir>/results/<runId>/`    (local archived)
 *   3. `<worcaDir>/multi/pipelines.d/<runId>.json` → `<worktree_path>/.worca/runs/<runId>/`
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve a runId to its on-disk run directory.
 * @param {string} worcaDir - the parent project's .worca directory
 * @param {string} runId
 * @returns {string|null} absolute path to the run dir, or null if not found
 */
export function resolveRunDir(worcaDir, runId) {
  if (!worcaDir || !runId) return null;

  const localRunDir = join(worcaDir, 'runs', runId);
  if (existsSync(localRunDir)) return localRunDir;

  const localResultsDir = join(worcaDir, 'results', runId);
  if (existsSync(localResultsDir)) return localResultsDir;

  const overlay = readPipelineOverlay(worcaDir, runId);
  if (overlay) {
    const wtRunDir = join(overlay.worktree_path, '.worca', 'runs', runId);
    if (existsSync(wtRunDir)) return wtRunDir;
  }

  return null;
}

/**
 * Resolve a runId to its status.json path.
 * @param {string} worcaDir
 * @param {string} runId
 * @returns {string|null} absolute path to status.json, or null
 */
export function findRunStatusPath(worcaDir, runId) {
  const runDir = resolveRunDir(worcaDir, runId);
  if (runDir) {
    const sp = join(runDir, 'status.json');
    if (existsSync(sp)) return sp;
  }

  // Legacy file format: results/<id>.json
  const legacyPath = join(worcaDir, 'results', `${runId}.json`);
  if (existsSync(legacyPath)) return legacyPath;

  return null;
}

/**
 * Read the worktree overlay for a runId, if registered.
 * @param {string} worcaDir
 * @param {string} runId
 * @returns {{ run_id: string, worktree_path: string, pid?: number } | null}
 */
export function readPipelineOverlay(worcaDir, runId) {
  const regPath = join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`);
  if (!existsSync(regPath)) return null;
  try {
    const data = JSON.parse(readFileSync(regPath, 'utf8'));
    if (!data || typeof data.worktree_path !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}
