import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

function clearStalePid(statusPath, status) {
  try {
    const patched = {
      ...status,
      pipeline_status: 'error',
      error: 'Stale PID: process no longer running',
    };
    writeFileSync(statusPath, `${JSON.stringify(patched, null, 2)}\n`);
  } catch {
    // best-effort
  }
}

/**
 * Count running pipelines across all registered projects.
 * Walks ~/.worca/projects.d/, checks each project's .worca/runs/ for
 * status.json entries with pipeline_status=running, and verifies PID liveness.
 * Prunes stale PIDs (dead processes still marked as running).
 */
export function countRunningPipelinesAcrossProjects(prefsDir) {
  const projectsDir = join(prefsDir, 'projects.d');
  if (!existsSync(projectsDir)) return 0;

  let entries;
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return 0;
  }

  let count = 0;

  for (const file of entries) {
    if (!file.endsWith('.json')) continue;

    let project;
    try {
      project = JSON.parse(readFileSync(join(projectsDir, file), 'utf-8'));
    } catch {
      continue;
    }

    if (!project || typeof project.path !== 'string') continue;

    const runsDir = join(project.path, '.worca', 'runs');
    if (!existsSync(runsDir)) continue;

    let runEntries;
    try {
      runEntries = readdirSync(runsDir);
    } catch {
      continue;
    }

    for (const runEntry of runEntries) {
      const statusPath = join(runsDir, runEntry, 'status.json');
      if (!existsSync(statusPath)) continue;

      let status;
      try {
        status = JSON.parse(readFileSync(statusPath, 'utf-8'));
      } catch {
        continue;
      }

      if (status.pipeline_status !== 'running') continue;
      if (!status.pid) continue;

      if (isPidAlive(status.pid)) {
        count++;
      } else {
        clearStalePid(statusPath, status);
      }
    }
  }

  return count;
}
