/**
 * Workspace manifest watcher — monitors ~/.worca/workspace-runs/ for pointer
 * file changes, reads the actual manifest, and broadcasts workspace-update,
 * workspace-tier-update, and guide-conflict WS events.
 *
 * Separate from fleet-update per W-040 §13.5 — never multiplexed.
 */

import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WS_DEBOUNCE_MS = 200;
const DEFAULT_WS_RUNS_DIR = join(homedir(), '.worca', 'workspace-runs');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readManifestFromPointer(wsRunsDir, wsId) {
  const pointer = readJson(join(wsRunsDir, `${wsId}.json`));
  if (!pointer?.workspace_root) return null;
  const manifestPath = join(
    pointer.workspace_root,
    '.worca',
    'workspace-runs',
    wsId,
    'workspace-manifest.json',
  );
  return readJson(manifestPath);
}

/**
 * @param {{ broadcaster: { broadcast: Function }, workspaceRunsDir?: string }} deps
 */
export function createWorkspaceManifestWatcher({
  broadcaster,
  workspaceRunsDir = DEFAULT_WS_RUNS_DIR,
}) {
  let fsWatcher = null;
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const debounceTimers = new Map();

  function broadcastWorkspaceUpdate(wsId) {
    const manifest = readManifestFromPointer(workspaceRunsDir, wsId);
    if (!manifest) return;

    const children = Array.isArray(manifest.children) ? manifest.children : [];
    const dag = manifest.dag ?? { tiers: [] };

    broadcaster.broadcast('workspace-update', {
      workspace_id: wsId,
      workspace_name: manifest.workspace_name ?? null,
      status: manifest.status ?? 'running',
      halt_reason: manifest.halt_reason ?? null,
      dag,
      children: children.map((c) => ({
        repo: c.repo,
        run_id: c.run_id,
        status: c.status,
        tier: c.tier,
      })),
      integration_test: manifest.integration_test ?? null,
    });

    const tiers = dag.tiers ?? [];
    for (const tier of tiers) {
      broadcaster.broadcast('workspace-tier-update', {
        workspace_id: wsId,
        tier: tier.tier,
        repos: tier.repos,
        status: tier.status,
      });
    }

    const conflicts = manifest.guide_conflicts;
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      broadcaster.broadcast('guide-conflict', {
        workspace_id: wsId,
        conflicts,
      });
    }
  }

  function scheduleUpdate(wsId) {
    const existing = debounceTimers.get(wsId);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      wsId,
      setTimeout(() => {
        debounceTimers.delete(wsId);
        broadcastWorkspaceUpdate(wsId);
      }, WS_DEBOUNCE_MS),
    );
  }

  try {
    if (existsSync(workspaceRunsDir)) {
      fsWatcher = watch(
        workspaceRunsDir,
        { persistent: false },
        (_event, filename) => {
          if (!filename?.endsWith('.json')) return;
          const wsId = filename.slice(0, -5);
          scheduleUpdate(wsId);
        },
      );
    }
  } catch {
    // fs.watch unsupported or dir unavailable — skip silently
  }

  function destroy() {
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {
        /* ignore */
      }
      fsWatcher = null;
    }
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
  }

  return {
    destroy,
    _broadcastForTest: broadcastWorkspaceUpdate,
  };
}
