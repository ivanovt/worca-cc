/**
 * Reactive state store for worca-ui.
 *
 * Note: The W-032 plan specified a separate `state-accessors.js` module (Task 1.6)
 * for safe accessor functions with fallback to the old flat shape. The accessor
 * logic was folded directly into this module since the store API (getState,
 * setState, setRun, appendLog, clearLog) already provides a clean boundary and
 * a separate file added indirection without benefit.
 */

const LOG_CAP = 5000;
export const MAX_ARCHIVED_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const RUN_GRACE_MS = 5000;

/** Returns true if an archived run's archived_at is older than MAX_ARCHIVED_AGE_MS. */
export function isArchivedRunExpired(run, now) {
  if (!run.archived_at) return false;
  return (
    (now || Date.now()) - new Date(run.archived_at).getTime() >
    MAX_ARCHIVED_AGE_MS
  );
}

export function createStore(initial = {}) {
  let state = {
    activeRunId: initial.activeRunId ?? null,
    projectName: initial.projectName ?? '',
    currentProjectId: initial.currentProjectId ?? null,
    projects: initial.projects ?? [],
    runs: initial.runs ?? {},
    archivedRuns: initial.archivedRuns ?? {},
    logLines: initial.logLines ?? [],
    preferences: {
      theme: initial.preferences?.theme ?? 'light',
      sidebarCollapsed: initial.preferences?.sidebarCollapsed ?? false,
      notifications: initial.preferences?.notifications ?? null,
    },
    beads: initial.beads ?? { issues: [], dbExists: false, loading: false },
    webhookInbox: initial.webhookInbox ?? {
      events: [],
      controlAction: 'continue',
    },
    runsLoaded: initial.runsLoaded ?? false,
    addProjectDialogOpen: initial.addProjectDialogOpen ?? false,
    worktrees: initial.worktrees ?? [],
    worktreesLoaded: initial.worktreesLoaded ?? false,
    fleets: initial.fleets ?? [],
    // Loaded flags let the sidebar distinguish "loading from server" from
    // "loaded and empty" — without this, both render an empty array and
    // the sidebar can't show a spinner during the first hydration.
    fleetsLoaded: initial.fleetsLoaded ?? false,
    // `workspaces` are definitions ({ name, path, repos }) used by the
    // launcher dropdown; `workspaceRuns` are pipeline executions
    // ({ workspace_id, status, ... }) counted by the sidebar badge. They were
    // accidentally collapsed onto the same key in W-047, breaking the
    // launcher when sidebar code mutated state.workspaces with run shape.
    workspaces: initial.workspaces ?? [],
    workspaceRuns: initial.workspaceRuns ?? [],
    workspaceRunsLoaded: initial.workspaceRunsLoaded ?? false,
    worktreeDiskWarningBytes: initial.worktreeDiskWarningBytes ?? 2_000_000_000,
    classifierModel: initial.classifierModel ?? 'haiku',
    cleanupPolicy: initial.cleanupPolicy ?? 'never',
    maxConcurrentPipelines: initial.maxConcurrentPipelines ?? 10,
    totalRunning: initial.totalRunning ?? 0,
  };

  const subs = new Set();

  function emit() {
    for (const fn of Array.from(subs)) {
      try {
        fn(state);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    getState() {
      return state;
    },

    setState(patch) {
      const next = {
        ...state,
        ...patch,
        preferences: { ...state.preferences, ...(patch.preferences || {}) },
      };
      if (
        next.activeRunId === state.activeRunId &&
        next.projectName === state.projectName &&
        next.currentProjectId === state.currentProjectId &&
        next.projects === state.projects &&
        next.runs === state.runs &&
        next.archivedRuns === state.archivedRuns &&
        next.logLines === state.logLines &&
        next.preferences.theme === state.preferences.theme &&
        next.preferences.sidebarCollapsed ===
          state.preferences.sidebarCollapsed &&
        next.preferences.notifications === state.preferences.notifications &&
        next.beads === state.beads &&
        next.webhookInbox === state.webhookInbox &&
        next.addProjectDialogOpen === state.addProjectDialogOpen &&
        next.worktrees === state.worktrees &&
        next.fleets === state.fleets &&
        next.fleetsLoaded === state.fleetsLoaded &&
        next.workspaces === state.workspaces &&
        next.workspaceRuns === state.workspaceRuns &&
        next.workspaceRunsLoaded === state.workspaceRunsLoaded &&
        next.runsLoaded === state.runsLoaded &&
        next.worktreeDiskWarningBytes === state.worktreeDiskWarningBytes &&
        next.classifierModel === state.classifierModel &&
        next.cleanupPolicy === state.cleanupPolicy &&
        next.maxConcurrentPipelines === state.maxConcurrentPipelines &&
        next.totalRunning === state.totalRunning &&
        next.templates === state.templates &&
        next.templatesLoaded === state.templatesLoaded &&
        next.templatesError === state.templatesError
      )
        return;
      state = next;
      emit();
    },

    setRun(runId, data) {
      if (data.archived === true) {
        const archivedRuns = { ...state.archivedRuns, [runId]: data };
        if (runId in state.runs) {
          const runs = { ...state.runs };
          delete runs[runId];
          state = { ...state, runs, archivedRuns };
        } else {
          state = { ...state, archivedRuns };
        }
      } else {
        // Stamp _addedAt on first appearance so setRunsBulk can protect
        // recently-added runs from stale bulk overwrites.
        const isNew = !(runId in state.runs) && !(runId in state.archivedRuns);
        const entry = isNew ? { ...data, _addedAt: Date.now() } : data;
        const runs = { ...state.runs, [runId]: entry };
        if (runId in state.archivedRuns) {
          const archivedRuns = { ...state.archivedRuns };
          delete archivedRuns[runId];
          state = { ...state, runs, archivedRuns };
        } else {
          state = { ...state, runs };
        }
      }
      emit();
    },

    setRunsBulk(runArray) {
      const runs = {};
      const archivedRuns = {};
      const now = Date.now();
      for (const run of runArray) {
        if (run.archived === true) {
          if (isArchivedRunExpired(run, now)) continue;
          archivedRuns[run.id] = run;
        } else {
          runs[run.id] = run;
        }
      }
      // Preserve active runs added within the grace period that the
      // server hasn't discovered yet (status files not written yet).
      for (const [id, run] of Object.entries(state.runs)) {
        if (
          run._addedAt &&
          now - run._addedAt < RUN_GRACE_MS &&
          !(id in runs)
        ) {
          runs[id] = run;
        }
      }
      state = { ...state, runs, archivedRuns, runsLoaded: true };
      emit();
    },

    /** Centralized ID lookup across both runs and archivedRuns. */
    getRunById(id) {
      return state.runs[id] ?? state.archivedRuns[id];
    },
    // Log lines feed the xterm terminals directly (writeLogLine /
    // writeLiveLogLine in the WS handlers), not the lit-html tree — the only
    // lit-html consumer is the Log History stage-dropdown fallback. So append
    // is a pure buffer mutation and deliberately does NOT emit(): the WS
    // handlers schedule a single coalesced rerender after a batch. Emitting per
    // line turned a backfill of N lines into N full synchronous app re-renders.
    appendLog(entry) {
      const logLines = [...state.logLines, entry];
      if (logLines.length > LOG_CAP)
        logLines.splice(0, logLines.length - LOG_CAP);
      state = { ...state, logLines };
    },

    // Batch variant for the log-bulk backfill: append all entries with a single
    // array build (avoids the O(n^2) per-line spread) and, like appendLog, does
    // not emit — the handler triggers one coalesced rerender afterwards.
    appendLogs(entries) {
      if (!entries || entries.length === 0) return;
      const logLines = state.logLines.concat(entries);
      if (logLines.length > LOG_CAP)
        logLines.splice(0, logLines.length - LOG_CAP);
      state = { ...state, logLines };
    },

    clearLog() {
      state = { ...state, logLines: [] };
      emit();
    },

    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
