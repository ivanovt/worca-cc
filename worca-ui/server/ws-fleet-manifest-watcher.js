/**
 * Fleet manifest watcher — monitors ~/.worca/fleet-runs/<fleet_id>.json for changes.
 * Emits fleet-update WS events when a fleet manifest is written (§13.5).
 */

import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effectiveFleetStatus } from './fleet-routes.js';

const FLEET_DEBOUNCE_MS = 200;
const DEFAULT_FLEET_RUNS_DIR = join(homedir(), '.worca', 'fleet-runs');

const FAILURE_STATES = new Set(['failed', 'setup_failed', 'unrecoverable']);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function resolveChildStatus(child) {
  const { project_path, run_id } = child;
  if (!project_path || !run_id) return 'running';
  const registryPath = join(
    project_path,
    '.worca',
    'multi',
    'pipelines.d',
    `${run_id}.json`,
  );
  const entry = readJson(registryPath);
  return entry?.status ?? 'running';
}

/**
 * @param {{ broadcaster: { broadcast: Function }, fleetRunsDir?: string }} deps
 */
export function createFleetManifestWatcher({
  broadcaster,
  fleetRunsDir = DEFAULT_FLEET_RUNS_DIR,
}) {
  let fsWatcher = null;
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const debounceTimers = new Map();

  function broadcastFleetUpdate(fleetId, manifestPath) {
    const manifest = readJson(manifestPath);
    if (!manifest) return;

    const rawChildren = Array.isArray(manifest.children)
      ? manifest.children
      : [];
    const children = rawChildren.map((child) => ({
      run_id: child.run_id,
      project_path: child.project_path,
      status: resolveChildStatus(child),
    }));

    const completed_children = children.filter(
      (c) => c.status === 'completed',
    ).length;
    const failed_children = children.filter((c) =>
      FAILURE_STATES.has(c.status),
    ).length;

    // Derive the effective status (same rules as REST) instead of broadcasting
    // raw manifest.status — otherwise cards stay "running" forever, because
    // run_fleet.py never writes a terminal status after it exits. Pure
    // function: persists nothing, so we don't trigger a watch→write→watch loop.
    const { status, halt_reason } = effectiveFleetStatus(
      manifest,
      children.map((c) => c.status),
    );

    broadcaster.broadcast('fleet-update', {
      fleet_id: fleetId,
      status,
      halt_reason,
      completed_children,
      failed_children,
      children,
    });
  }

  function scheduleUpdate(fleetId, manifestPath) {
    const existing = debounceTimers.get(fleetId);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      fleetId,
      setTimeout(() => {
        debounceTimers.delete(fleetId);
        broadcastFleetUpdate(fleetId, manifestPath);
      }, FLEET_DEBOUNCE_MS),
    );
  }

  try {
    if (existsSync(fleetRunsDir)) {
      fsWatcher = watch(
        fleetRunsDir,
        { persistent: false },
        (_event, filename) => {
          if (!filename?.endsWith('.json')) return;
          const fleetId = filename.slice(0, -5);
          scheduleUpdate(fleetId, join(fleetRunsDir, filename));
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

  return { destroy };
}
