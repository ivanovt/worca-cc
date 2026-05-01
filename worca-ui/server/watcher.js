import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assignEventsToIterations,
  readDispatchEventsFromJsonl,
} from './dispatch-events-aggregator.js';

/**
 * Enrich a status object with dispatch events read from events.jsonl in the
 * same run directory. Mutates `status.stages` by adding `dispatch_events` to
 * matching iterations. No-op when events.jsonl is missing (e.g. a run that
 * started before the emit was wired, or a run with no dispatches).
 */
function enrichWithDispatchEvents(status, runDir) {
  if (!status?.stages) return status;
  const eventsPath = join(runDir, 'events.jsonl');
  const events = readDispatchEventsFromJsonl(eventsPath);
  if (events.length === 0) return status;
  status.stages = assignEventsToIterations(events, status.stages);
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

export function discoverRuns(worcaDir) {
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
        runs.push({ id, active, ...status });
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
        runs.push({ id, active, ...status });
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
              runs.push({ id, active, ...data });
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
              runs.push({ id, active, ...data });
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
              worktree_worca_dir: join(reg.worktree_path, '.worca'),
              is_worktree_run: true,
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
      runs.push({ id, active, ...status });
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
      runs.push({ id, active, ...status });
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
        runs.push({ id, active, ...data });
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
        worktree_worca_dir: join(reg.worktree_path, '.worca'),
        is_worktree_run: true,
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
      fileWatcher = watch(eventsPath, (eventType) => {
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
      dirWatcher = watch(
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
