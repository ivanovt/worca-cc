import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assignEventsToIterations,
  readDispatchEventsFromJsonl,
} from './dispatch-events-aggregator.js';
import {
  assignGraphQueryCountsToIterations,
  readGraphQueryEventsFromJsonl,
} from './graph-query-aggregator.js';
import { readPipelineOverlay } from './run-dir-resolver.js';
import { safeWatch } from './safe-watch.js';

/**
 * Enrich a status object from events.jsonl in the same run directory:
 *  - dispatch events → `dispatch_events` per iteration (skills/subagents badges)
 *  - graph-query events → live graphify_invocations / crg_invocations /
 *    crg_tool_counts for the still-running iteration (graphify/CRG badges),
 *    without clobbering the runner's authoritative completion-time counts.
 * No-op when events.jsonl is missing (e.g. a run started before the emit was
 * wired, or one with no dispatches / graph queries).
 */
function enrichWithDispatchEvents(status, runDir) {
  if (!status?.stages) return status;
  const eventsPath = join(runDir, 'events.jsonl');
  const dispatchEvents = readDispatchEventsFromJsonl(eventsPath);
  if (dispatchEvents.length > 0) {
    status.stages = assignEventsToIterations(dispatchEvents, status.stages);
  }
  const graphEvents = readGraphQueryEventsFromJsonl(eventsPath);
  if (graphEvents.length > 0) {
    status.stages = assignGraphQueryCountsToIterations(
      graphEvents,
      status.stages,
    );
  }
  return status;
}

export function createRunId(status) {
  // Prefer run_id from status (new per-run format)
  if (status.run_id) return status.run_id;
  // Legacy: hash-based ID
  const key = `${status.started_at}:${status.work_request?.title || ''}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function isTerminal(status) {
  if (status.completed_at) return true;
  if (!status.stages) return false;
  const values = Object.values(status.stages);
  return (
    values.length > 0 &&
    values.every(
      (s) =>
        s.status === 'completed' ||
        s.status === 'error' ||
        s.status === 'interrupted',
    )
  );
}

const _discoverRunsCache = new Map(); // worcaDir → { ts, runs }
// TTL defaults to 0 under vitest (NODE_ENV=test) so the cache is a no-op in
// tests — they build fixture dirs from Date.now() and a shared path could
// otherwise serve a stale cached scan across tests. Production uses 1500ms;
// _setDiscoverRunsTtlForTest lets the dedicated cache test exercise real TTL.
let _discoverRunsTtlMs = process.env.NODE_ENV === 'test' ? 0 : 1500;

/** Test hook: override the discoverRuns cache TTL in ms. */
export function _setDiscoverRunsTtlForTest(ms) {
  _discoverRunsTtlMs = ms;
}

/**
 * Cached wrapper around the run-discovery scan. The scan reads + JSON-parses
 * every run's status.json across runs/, results/, and pipelines.d/ worktree
 * overlays — hundreds of ms on a large project. Whole-list callers (list-runs,
 * REST /runs) hit this; a short TTL collapses repeated calls in a burst into a
 * single scan. Per-run handlers use findRun() instead. Live status changes
 * still reach clients via the statusWatcher broadcast, so TTL-window staleness
 * here is invisible in the UI.
 */
export function discoverRuns(worcaDir) {
  const cached = _discoverRunsCache.get(worcaDir);
  if (cached && Date.now() - cached.ts < _discoverRunsTtlMs) {
    return cached.runs;
  }
  const runs = _discoverRunsUncached(worcaDir);
  _discoverRunsCache.set(worcaDir, { ts: Date.now(), runs });
  return runs;
}

/** Clear the discoverRuns TTL cache (tests, or explicit invalidation). */
export function clearDiscoverRunsCache() {
  _discoverRunsCache.clear();
}

/**
 * Resolve a SINGLE run by id without scanning every run on disk — the O(1)
 * counterpart to discoverRuns().find(r => r.id === runId), for hot WS handlers
 * (subscribe-run, get-agent-prompt) that need exactly one run. Mirrors
 * discoverRuns' per-source shaping: dispatch-event enrichment for runs/ and
 * worktree sources (not results/), plus the worktree registry fields. The
 * findRun-vs-discoverRuns parity test keeps the two aligned.
 *
 * Falls back to a (TTL-cached) discoverRuns scan for legacy layouts where the
 * on-disk name doesn't equal the computed id (flat `.worca/status.json`, hashed
 * legacy ids), so it never resolves fewer runs than discoverRuns().find().
 *
 * @returns {object|null} a run record shaped like a discoverRuns entry, or null
 */
export function findRun(worcaDir, runId) {
  if (!worcaDir || !runId) return null;

  // 1. Local active: runs/<id>/status.json (enriched)
  const localRunDir = join(worcaDir, 'runs', runId);
  if (existsSync(join(localRunDir, 'status.json'))) {
    return _shapeRunFromFile(join(localRunDir, 'status.json'), {
      enrich: true,
      runDir: localRunDir,
    });
  }

  // 2. Local archived dir: results/<id>/status.json (not enriched)
  const resultsDirStatus = join(worcaDir, 'results', runId, 'status.json');
  if (existsSync(resultsDirStatus)) {
    return _shapeRunFromFile(resultsDirStatus, { enrich: false });
  }

  // 2b. Legacy archived file: results/<id>.json (not enriched)
  const legacyFile = join(worcaDir, 'results', `${runId}.json`);
  if (existsSync(legacyFile)) {
    return _shapeRunFromFile(legacyFile, {
      enrich: false,
      requireStartedAt: true,
    });
  }

  // 3. Worktree overlay: pipelines.d/<id>.json → <worktree>/.worca/runs/<id>
  const reg = readPipelineOverlay(worcaDir, runId);
  if (reg?.worktree_path) {
    const wtRunDir = join(reg.worktree_path, '.worca', 'runs', runId);
    if (existsSync(join(wtRunDir, 'status.json'))) {
      return _shapeRunFromFile(join(wtRunDir, 'status.json'), {
        enrich: true,
        runDir: wtRunDir,
        worktreeReg: reg,
      });
    }
  }

  // Fallback for legacy layouts where the on-disk name != the computed id
  // (flat .worca/status.json, hashed legacy ids). Rare — pay one (TTL-cached)
  // full scan rather than regress correctness vs discoverRuns().find().
  return discoverRuns(worcaDir).find((r) => r.id === runId) || null;
}

function _shapeRunFromFile(
  statusPath,
  {
    enrich = false,
    runDir = null,
    worktreeReg = null,
    requireStartedAt = false,
  } = {},
) {
  try {
    let status = JSON.parse(readFileSync(statusPath, 'utf8'));
    if (requireStartedAt && !status.started_at) return null;
    if (enrich && runDir) status = enrichWithDispatchEvents(status, runDir);
    const id = createRunId(status);
    const active = !isTerminal(status) && status.pipeline_status === 'running';
    const base = {
      id,
      active,
      ...status,
      source_type: status.source_type ?? null,
      source_ref: status.source_ref ?? null,
    };
    if (worktreeReg) {
      return {
        ...base,
        worktree_worca_dir: join(worktreeReg.worktree_path, '.worca'),
        is_worktree_run: true,
        head_branch: worktreeReg.branch || null,
        fleet_id: worktreeReg.fleet_id || null,
        workspace_id: worktreeReg.workspace_id || null,
        group_type: worktreeReg.group_type || null,
        target_branch: worktreeReg.target_branch || null,
      };
    }
    return base;
  } catch {
    return null;
  }
}

function _discoverRunsUncached(worcaDir) {
  const runs = [];
  const seenIds = new Set();

  // 1. Scan .worca/runs/ for runs
  const runsDir = join(worcaDir, 'runs');
  if (existsSync(runsDir)) {
    for (const entry of readdirSync(runsDir)) {
      const runDir = join(runsDir, entry);
      const statusPath = join(runDir, 'status.json');
      if (!existsSync(statusPath)) continue;
      try {
        let status = JSON.parse(readFileSync(statusPath, 'utf8'));
        status = enrichWithDispatchEvents(status, runDir);
        const id = createRunId(status);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const active =
          !isTerminal(status) && status.pipeline_status === 'running';
        runs.push({
          id,
          active,
          ...status,
          source_type: status.source_type ?? null,
          source_ref: status.source_ref ?? null,
        });
      } catch {
        /* ignore */
      }
    }
  }

  // 2. Legacy: flat .worca/status.json
  const statusPath = join(worcaDir, 'status.json');
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, 'utf8'));
      const id = createRunId(status);
      if (!seenIds.has(id)) {
        const active =
          !isTerminal(status) && status.pipeline_status === 'running';
        runs.push({
          id,
          active,
          ...status,
          source_type: status.source_type ?? null,
          source_ref: status.source_ref ?? null,
        });
        seenIds.add(id);
      }
    } catch {
      /* ignore malformed */
    }
  }

  // 3. Results: handle both dir format (results/{id}/status.json) and file format (results/{id}.json)
  const resultsDir = join(worcaDir, 'results');
  if (existsSync(resultsDir)) {
    for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
      try {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          // Legacy file format
          const data = JSON.parse(
            readFileSync(join(resultsDir, entry.name), 'utf8'),
          );
          if (data.started_at) {
            const id = createRunId(data);
            if (!seenIds.has(id)) {
              seenIds.add(id);
              const active =
                !isTerminal(data) && data.pipeline_status === 'running';
              runs.push({
                id,
                active,
                ...data,
                source_type: data.source_type ?? null,
                source_ref: data.source_ref ?? null,
              });
            }
          }
        } else if (entry.isDirectory()) {
          // New dir format
          const sp = join(resultsDir, entry.name, 'status.json');
          if (existsSync(sp)) {
            const data = JSON.parse(readFileSync(sp, 'utf8'));
            const id = createRunId(data);
            if (!seenIds.has(id)) {
              seenIds.add(id);
              const active =
                !isTerminal(data) && data.pipeline_status === 'running';
              runs.push({
                id,
                active,
                ...data,
                source_type: data.source_type ?? null,
                source_ref: data.source_ref ?? null,
              });
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 4. Fan out across pipelines.d/ registry entries (worktree runs)
  const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
  if (existsSync(pipelinesDir)) {
    for (const entry of readdirSync(pipelinesDir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const reg = JSON.parse(readFileSync(join(pipelinesDir, entry), 'utf8'));
        if (!reg.worktree_path) continue;
        const wtRunsDir = join(reg.worktree_path, '.worca', 'runs');
        if (!existsSync(wtRunsDir)) continue;
        for (const runEntry of readdirSync(wtRunsDir)) {
          const sp = join(wtRunsDir, runEntry, 'status.json');
          if (!existsSync(sp)) continue;
          try {
            let status = JSON.parse(readFileSync(sp, 'utf8'));
            status = enrichWithDispatchEvents(
              status,
              join(wtRunsDir, runEntry),
            );
            const id = createRunId(status);
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const active =
              !isTerminal(status) && status.pipeline_status === 'running';
            runs.push({
              id,
              active,
              ...status,
              source_type: status.source_type ?? null,
              source_ref: status.source_ref ?? null,
              worktree_worca_dir: join(reg.worktree_path, '.worca'),
              is_worktree_run: true,
              head_branch: reg.branch || null,
              fleet_id: reg.fleet_id || null,
              workspace_id: reg.workspace_id || null,
              group_type: reg.group_type || null,
              target_branch: reg.target_branch || null,
            });
          } catch {
            /* ignore malformed status */
          }
        }
      } catch {
        /* ignore malformed registry entry */
      }
    }
  }

  return runs;
}

/**
 * Async version of discoverRuns — avoids blocking the event loop.
 * Used by the status watcher's debounced refresh.
 */
export async function discoverRunsAsync(worcaDir) {
  const runs = [];
  const seenIds = new Set();

  // 1. Scan .worca/runs/
  const runsDir = join(worcaDir, 'runs');
  try {
    const entries = await readdir(runsDir);
    const readPromises = entries.map(async (entry) => {
      try {
        const runDir = join(runsDir, entry);
        const statusPath = join(runDir, 'status.json');
        const status = JSON.parse(await readFile(statusPath, 'utf8'));
        return { status, runDir };
      } catch {
        return null;
      }
    });
    for (const result of await Promise.all(readPromises)) {
      if (!result) continue;
      const status = enrichWithDispatchEvents(result.status, result.runDir);
      const id = createRunId(status);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const active =
        !isTerminal(status) && status.pipeline_status === 'running';
      runs.push({
        id,
        active,
        ...status,
        source_type: status.source_type ?? null,
        source_ref: status.source_ref ?? null,
      });
    }
  } catch {
    /* ignore */
  }

  // 2. Legacy flat status.json
  try {
    const status = JSON.parse(
      await readFile(join(worcaDir, 'status.json'), 'utf8'),
    );
    const id = createRunId(status);
    if (!seenIds.has(id)) {
      const active =
        !isTerminal(status) && status.pipeline_status === 'running';
      runs.push({
        id,
        active,
        ...status,
        source_type: status.source_type ?? null,
        source_ref: status.source_ref ?? null,
      });
      seenIds.add(id);
    }
  } catch {
    /* ignore */
  }

  // 3. Results
  const resultsDir = join(worcaDir, 'results');
  try {
    const entries = await readdir(resultsDir, { withFileTypes: true });
    const readPromises = entries.map(async (entry) => {
      try {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          return JSON.parse(
            await readFile(join(resultsDir, entry.name), 'utf8'),
          );
        }
        if (entry.isDirectory()) {
          const sp = join(resultsDir, entry.name, 'status.json');
          return JSON.parse(await readFile(sp, 'utf8'));
        }
      } catch {
        /* ignore */
      }
      return null;
    });
    for (const data of await Promise.all(readPromises)) {
      if (!data || !data.started_at) continue;
      const id = createRunId(data);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        const active = !isTerminal(data) && data.pipeline_status === 'running';
        runs.push({
          id,
          active,
          ...data,
          source_type: data.source_type ?? null,
          source_ref: data.source_ref ?? null,
        });
      }
    }
  } catch {
    /* ignore */
  }

  // 4. Fan out across pipelines.d/ registry entries (worktree runs)
  const pipelinesDirAsync = join(worcaDir, 'multi', 'pipelines.d');
  try {
    const regEntries = await readdir(pipelinesDirAsync);
    const wtReadPromises = regEntries
      .filter((e) => e.endsWith('.json'))
      .map(async (e) => {
        try {
          const reg = JSON.parse(
            await readFile(join(pipelinesDirAsync, e), 'utf8'),
          );
          if (!reg.worktree_path) return [];
          const wtRunsDir = join(reg.worktree_path, '.worca', 'runs');
          let runEntries;
          try {
            runEntries = await readdir(wtRunsDir);
          } catch {
            return [];
          }
          const results = [];
          for (const runEntry of runEntries) {
            try {
              const sp = join(wtRunsDir, runEntry, 'status.json');
              let status = JSON.parse(await readFile(sp, 'utf8'));
              status = enrichWithDispatchEvents(
                status,
                join(wtRunsDir, runEntry),
              );
              results.push({ status, reg });
            } catch {
              /* ignore */
            }
          }
          return results;
        } catch {
          return [];
        }
      });
    const wtResults = (await Promise.all(wtReadPromises)).flat();
    for (const { status, reg } of wtResults) {
      const id = createRunId(status);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const active =
        !isTerminal(status) && status.pipeline_status === 'running';
      runs.push({
        id,
        active,
        ...status,
        source_type: status.source_type ?? null,
        source_ref: status.source_ref ?? null,
        worktree_worca_dir: join(reg.worktree_path, '.worca'),
        is_worktree_run: true,
        head_branch: reg.branch || null,
        fleet_id: reg.fleet_id || null,
        workspace_id: reg.workspace_id || null,
        group_type: reg.group_type || null,
        target_branch: reg.target_branch || null,
      });
    }
  } catch {
    /* ignore */
  }

  return runs;
}

/**
 * Watch {runDir}/events.jsonl for new lines (byte-offset tracking).
 * Handles file creation if the file doesn't exist yet.
 * Calls callback(event) for each parsed JSON line; skips malformed lines.
 *
 * @param {string} runDir - Run directory that may contain events.jsonl
 * @param {(event: object) => void} callback
 * @returns {{ close: () => void }}
 */
export function watchEvents(runDir, callback) {
  const eventsPath = join(runDir, 'events.jsonl');
  let byteOffset = 0;
  let fileWatcher = null;
  let dirWatcher = null;
  let closed = false;

  function processNewContent() {
    if (closed) return;
    try {
      if (!existsSync(eventsPath)) return;
      const buf = readFileSync(eventsPath);
      if (buf.length <= byteOffset) return;
      const newContent = buf.slice(byteOffset).toString('utf8');
      byteOffset = buf.length;
      for (const line of newContent.split('\n')) {
        if (!line.trim()) continue;
        try {
          callback(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* ignore read errors */
    }
  }

  function startFileWatcher() {
    if (closed || fileWatcher) return;
    try {
      fileWatcher = safeWatch(eventsPath, (eventType) => {
        if (eventType === 'change') {
          processNewContent();
        } else if (eventType === 'rename') {
          // File deleted or recreated — reset and retry
          if (fileWatcher) {
            try {
              fileWatcher.close();
            } catch {
              /* ignore */
            }
            fileWatcher = null;
          }
          setTimeout(() => {
            if (!closed && existsSync(eventsPath)) {
              startFileWatcher();
              processNewContent();
            }
          }, 100);
        }
      });
    } catch {
      /* ignore — file may have been deleted */
    }
  }

  if (existsSync(eventsPath)) {
    // Start from current end of file (tail only new content)
    try {
      byteOffset = readFileSync(eventsPath).length;
    } catch {
      /* ignore */
    }
    startFileWatcher();
  }

  // Watch the run directory so we detect events.jsonl being created
  if (existsSync(runDir)) {
    try {
      dirWatcher = safeWatch(
        runDir,
        { recursive: false },
        (_eventType, filename) => {
          if (
            filename === 'events.jsonl' &&
            existsSync(eventsPath) &&
            !fileWatcher
          ) {
            byteOffset = 0; // Newly created — read from the beginning
            startFileWatcher();
            processNewContent();
          }
        },
      );
    } catch {
      /* ignore */
    }
  }

  return {
    close() {
      closed = true;
      if (fileWatcher) {
        try {
          fileWatcher.close();
        } catch {
          /* ignore */
        }
        fileWatcher = null;
      }
      if (dirWatcher) {
        try {
          dirWatcher.close();
        } catch {
          /* ignore */
        }
        dirWatcher = null;
      }
    },
  };
}
