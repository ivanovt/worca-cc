/**
 * Status file watcher — monitors status.json and runs/ directory for changes.
 * Owns refresh scheduling, lastPipelineStatus tracking, and the status/runsDirWatcher FSWatchers.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeWatch } from './safe-watch.js';
import { readSettings } from './settings-reader.js';
import { discoverRunsAsync } from './watcher.js';

const REFRESH_DEBOUNCE_MS = 75;
const WORKTREE_WATCHER_THRESHOLD = 50;
const WORKTREE_POLL_MS = 30_000;
// Display-layer: broadest set — any status that means "stop watching this run".
// Differs from runner/resume (which exclude 'failed' to keep it resumable) and
// cleanup ({completed, failed}). Here we add 'error' so the UI also stops polling
// pipelines that crashed before reaching a clean terminal state.
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'error',
  'interrupted',
]);

/**
 * Resolve the latest active run directory for a given worca base dir.
 * Scans runs/<runId>/pipeline.pid for live processes via process.kill(pid, 0).
 * Returns the run dir of the latest live run (by run ID), or worcaDir as fallback.
 *
 * @param {string} worcaDir
 * @returns {string}
 */
export function resolveLatestRunDir(worcaDir) {
  // Collect (runId → runDir) for all live runs from local runs/ and worktree pipelines.d/
  const liveRuns = new Map();

  const runsDir = join(worcaDir, 'runs');
  if (existsSync(runsDir)) {
    try {
      for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pidPath = join(runsDir, entry.name, 'pipeline.pid');
        if (!existsSync(pidPath)) continue;
        try {
          const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
          if (!Number.isNaN(pid) && pid > 0) {
            process.kill(pid, 0); // throws if dead
            liveRuns.set(entry.name, join(runsDir, entry.name));
          }
        } catch {
          /* dead process or invalid PID */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Also scan pipelines.d/ for worktree PIDs (worktree runs never appear in runs/)
  const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
  if (existsSync(pipelinesDir)) {
    try {
      for (const entry of readdirSync(pipelinesDir)) {
        if (!entry.endsWith('.json')) continue;
        const runId = entry.slice(0, -5);
        try {
          const reg = JSON.parse(
            readFileSync(join(pipelinesDir, entry), 'utf8'),
          );
          if (!reg.worktree_path) continue;
          const wtRunDir = join(reg.worktree_path, '.worca', 'runs', runId);
          const pidPath = join(wtRunDir, 'pipeline.pid');
          if (!existsSync(pidPath)) continue;
          const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
          if (!Number.isNaN(pid) && pid > 0) {
            process.kill(pid, 0); // throws if dead
            liveRuns.set(runId, wtRunDir);
          }
        } catch {
          /* dead process or invalid PID */
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (liveRuns.size === 0) return worcaDir; // legacy fallback

  // Return the runDir of the latest (alphabetically largest) live run ID
  let latestId = null;
  for (const id of liveRuns.keys()) {
    if (!latestId || id > latestId) latestId = id;
  }
  return liveRuns.get(latestId);
}

/**
 * @param {{
 *   worcaDir: string,
 *   settingsPath: string,
 *   broadcaster: { broadcast: Function, broadcastToSubscribers: Function },
 *   getSubs: Function,
 *   wss: import('ws').WebSocketServer,
 *   onActiveRunChange?: () => void,
 *   projectId?: string
 * }} deps
 */
export function createStatusWatcher({
  worcaDir,
  settingsPath,
  broadcaster,
  getSubs,
  wss,
  onActiveRunChange,
  projectId,
}) {
  let REFRESH_TIMER = null;
  const lastPipelineStatus = new Map();
  let statusWatcher = null;
  let watchedRunDir = null;
  let activeRunWatcher = null;
  let runsDirWatcher = null;
  let pipelinesDirWatcher = null;
  const worktreeRunWatchers = new Map(); // Map<run_id, FSWatcher>
  let worktreePollingInterval = null;

  function currentActiveRunId() {
    if (!watchedRunDir) return null;
    return watchedRunDir.split('/').pop() || null;
  }

  function _resolveLatestRunDir() {
    return resolveLatestRunDir(worcaDir);
  }

  function reconcileWorktreeWatchers() {
    const pipelinesDirPath = join(worcaDir, 'multi', 'pipelines.d');
    if (!existsSync(pipelinesDirPath)) {
      for (const w of worktreeRunWatchers.values()) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      worktreeRunWatchers.clear();
      if (worktreePollingInterval) {
        clearInterval(worktreePollingInterval);
        worktreePollingInterval = null;
      }
      return;
    }

    // Read all non-terminal entries from pipelines.d/
    const activeEntries = new Map(); // run_id -> reg
    try {
      for (const entry of readdirSync(pipelinesDirPath)) {
        if (!entry.endsWith('.json')) continue;
        try {
          const reg = JSON.parse(
            readFileSync(join(pipelinesDirPath, entry), 'utf8'),
          );
          if (
            reg.run_id &&
            reg.worktree_path &&
            !TERMINAL_STATUSES.has(reg.status)
          ) {
            activeEntries.set(reg.run_id, reg);
          }
        } catch {
          /* ignore malformed */
        }
      }
    } catch {
      /* ignore */
    }

    // >50 concurrent worktrees: fall back to periodic polling
    if (activeEntries.size > WORKTREE_WATCHER_THRESHOLD) {
      for (const w of worktreeRunWatchers.values()) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      worktreeRunWatchers.clear();
      if (!worktreePollingInterval) {
        worktreePollingInterval = setInterval(
          () => scheduleRefresh(),
          WORKTREE_POLL_MS,
        );
      }
      return;
    }

    // Below threshold: stop polling if it was running
    if (worktreePollingInterval) {
      clearInterval(worktreePollingInterval);
      worktreePollingInterval = null;
    }

    // Remove watchers for entries no longer active
    for (const [runId, w] of worktreeRunWatchers) {
      if (!activeEntries.has(runId)) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
        worktreeRunWatchers.delete(runId);
      }
    }

    // Add watchers for new active entries
    for (const [runId, reg] of activeEntries) {
      if (worktreeRunWatchers.has(runId)) continue;
      const wtRunsDir = join(reg.worktree_path, '.worca', 'runs');
      if (!existsSync(wtRunsDir)) continue;
      try {
        const w = safeWatch(
          wtRunsDir,
          { recursive: true },
          (_eventType, filename) => {
            if (!filename || filename.endsWith('status.json')) {
              scheduleRefresh();
            }
          },
        );
        worktreeRunWatchers.set(runId, w);
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleRefresh() {
    if (REFRESH_TIMER) clearTimeout(REFRESH_TIMER);
    REFRESH_TIMER = setTimeout(async () => {
      REFRESH_TIMER = null;
      let settings = {};
      try {
        settings = readSettings(settingsPath);
      } catch {
        /* ignore */
      }
      try {
        // enrich:true — run-snapshot broadcasts below feed the detailed run
        // view's live update, which renders dispatch_events / graph-query counts
        // for the still-running iteration (issue #296 keeps the list path lean,
        // not this one).
        const runs = await discoverRunsAsync(worcaDir, { enrich: true });
        reconcileWorktreeWatchers();
        const subscribedIds = new Set();
        for (const ws of wss.clients) {
          const s = getSubs(ws);
          if (s?.runId) subscribedIds.add(s.runId);
        }
        // Evict stale entries from lastPipelineStatus (fix #18)
        const activeRunIds = new Set(runs.map((r) => r.id));
        for (const id of lastPipelineStatus.keys()) {
          if (!activeRunIds.has(id)) lastPipelineStatus.delete(id);
        }

        for (const run of runs) {
          if (subscribedIds.has(run.id)) {
            broadcaster.broadcastToSubscribers(run.id, 'run-snapshot', run);
          }
          const currStatus = run.pipeline_status;
          if (currStatus !== undefined) {
            const prevStatus = lastPipelineStatus.get(run.id);
            if (prevStatus !== undefined && prevStatus !== currStatus) {
              if (currStatus === 'paused') {
                broadcaster.broadcastToSubscribers(run.id, 'pipeline-paused', {
                  runId: run.id,
                  pipeline_status: currStatus,
                });
              } else if (
                currStatus === 'running' &&
                (prevStatus === 'paused' || prevStatus === 'resuming')
              ) {
                broadcaster.broadcastToSubscribers(run.id, 'pipeline-resumed', {
                  runId: run.id,
                  pipeline_status: currStatus,
                });
              }
            }
            lastPipelineStatus.set(run.id, currStatus);
          }
        }
        broadcaster.broadcast('runs-list', { runs, settings }, projectId);
      } catch {
        /* ignore */
      }
    }, REFRESH_DEBOUNCE_MS);
  }

  function setupStatusWatcher() {
    if (statusWatcher) {
      statusWatcher.close();
      statusWatcher = null;
    }
    const runDir = _resolveLatestRunDir();
    if (watchedRunDir !== null && runDir !== watchedRunDir) {
      if (onActiveRunChange) onActiveRunChange();
    }
    watchedRunDir = runDir;

    function tryWatch() {
      if (statusWatcher) return;
      try {
        const statusFile = join(runDir, 'status.json');
        if (existsSync(statusFile)) {
          // Watch the file directly — on macOS, kqueue directory watchers
          // don't fire for in-place content modifications of existing files.
          // Watching the file itself ensures we detect status.json writes.
          //
          // IMPORTANT: On macOS kqueue, atomic writes (write-to-temp +
          // rename-over) replace the inode.  After one 'rename' event the
          // watcher goes dead because it tracked the old inode.  We
          // re-establish the watcher on the new file after a short delay.
          statusWatcher = safeWatch(statusFile, (eventType) => {
            scheduleRefresh();
            if (eventType === 'rename') {
              // File replaced (atomic write) — re-watch the new inode
              try {
                statusWatcher.close();
              } catch {
                /* ignore */
              }
              statusWatcher = null;
              setTimeout(() => tryWatch(), 50);
            }
          });
        } else if (existsSync(runDir)) {
          // status.json doesn't exist yet — watch the directory for its creation,
          // then switch to watching the file once it appears.
          statusWatcher = safeWatch(
            runDir,
            { recursive: false },
            (_eventType, filename) => {
              if (!filename || filename === 'status.json') {
                const statusPath = join(runDir, 'status.json');
                if (existsSync(statusPath)) {
                  // status.json appeared — switch to file-level watch
                  statusWatcher.close();
                  statusWatcher = null;
                  tryWatch();
                }
                scheduleRefresh();
              }
            },
          );
        } else {
          setTimeout(() => {
            if (_resolveLatestRunDir() === runDir) tryWatch();
          }, 500);
        }
      } catch {
        /* ignore */
      }
    }

    tryWatch();
  }

  // Initialize status watcher
  setupStatusWatcher();

  // Watch worcaDir for legacy status.json changes
  try {
    if (existsSync(worcaDir)) {
      activeRunWatcher = safeWatch(
        worcaDir,
        { recursive: false },
        (_eventType, filename) => {
          if (!filename || filename === 'status.json') {
            const newRunDir = _resolveLatestRunDir();
            if (newRunDir !== watchedRunDir) {
              setupStatusWatcher();
            }
            scheduleRefresh();
          }
        },
      );
    }
  } catch {
    /* ignore */
  }

  // Watch .worca/runs/ for status changes in ANY run (concurrent pipelines)
  const runsDir = join(worcaDir, 'runs');
  try {
    if (existsSync(runsDir)) {
      runsDirWatcher = safeWatch(
        runsDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename || filename.endsWith('status.json')) {
            scheduleRefresh();
          }
        },
      );
    }
  } catch {
    /* ignore */
  }

  // Watch .worca/multi/pipelines.d/ for pipeline additions/removals.
  // Create the directory eagerly so the watcher fires even on first worktree run.
  const pipelinesDirPath = join(worcaDir, 'multi', 'pipelines.d');
  try {
    mkdirSync(pipelinesDirPath, { recursive: true });
    pipelinesDirWatcher = safeWatch(
      pipelinesDirPath,
      { recursive: false },
      (_eventType, filename) => {
        if (!filename || filename.endsWith('.json')) {
          scheduleRefresh();
        }
      },
    );
  } catch {
    /* ignore */
  }

  function getWatchedRunDir() {
    return watchedRunDir;
  }

  function destroy() {
    if (statusWatcher) statusWatcher.close();
    if (activeRunWatcher) activeRunWatcher.close();
    if (runsDirWatcher) runsDirWatcher.close();
    if (pipelinesDirWatcher) pipelinesDirWatcher.close();
    for (const w of worktreeRunWatchers.values()) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    worktreeRunWatchers.clear();
    if (worktreePollingInterval) {
      clearInterval(worktreePollingInterval);
      worktreePollingInterval = null;
    }
  }

  return {
    scheduleRefresh,
    currentActiveRunId,
    resolveLatestRunDir: _resolveLatestRunDir,
    getWatchedRunDir,
    lastPipelineStatus,
    destroy,
  };
}
