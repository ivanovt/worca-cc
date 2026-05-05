/**
 * Worktree-blind callsite test for the get-agent-prompt handler.
 *
 * Must FAIL before Phase 2 fix: handler builds all resolved-file candidates
 * from proj.worcaDir, ignoring run.worktree_worca_dir even when
 * run.is_worktree_run === true.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageRouter } from '../ws-message-router.js';

function makeTmpDir() {
  const d = join(
    tmpdir(),
    `worca-agentprompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function mockWatcherSet(worcaDir) {
  return {
    get worcaDir() {
      return worcaDir;
    },
    get settingsPath() {
      return join(worcaDir, 'settings.json');
    },
    get projectRoot() {
      return worcaDir;
    },
    statusWatcher: {
      scheduleRefresh: vi.fn(),
      lastPipelineStatus: new Map(),
      resolveLatestRunDir: vi.fn(() => worcaDir),
      currentActiveRunId: vi.fn(() => null),
    },
    logWatcher: {
      watchLogFile: vi.fn(),
      watchAllLogFiles: vi.fn(),
      sendArchivedLogs: vi.fn(),
      resolveLogsBaseDir: vi.fn(() => worcaDir),
      clearLogWatchers: vi.fn(),
    },
    beadsWatcher: {
      getBeadsDbPath: vi.fn(() => join(worcaDir, 'beads.db')),
    },
    eventWatcher: {
      readEventsFromFile: vi.fn(() => []),
      subscribeEvents: vi.fn(),
      maybeCloseEventWatcher: vi.fn(),
    },
  };
}

function mockClientManager() {
  const subsMap = new Map();
  return {
    ensureSubs(ws) {
      if (!subsMap.has(ws)) subsMap.set(ws, {});
      return subsMap.get(ws);
    },
    getSubs(ws) {
      return subsMap.get(ws) || null;
    },
    setProtocol(ws, protocol, projectId) {
      const s = this.ensureSubs(ws);
      s.protocolVersion = protocol;
      s.projectId = projectId;
    },
  };
}

describe('get-agent-prompt worktree-blind callsite', () => {
  let projDir, wtDir;

  const RUN_ID = 'run-wt-prompt-001';

  beforeEach(() => {
    projDir = makeTmpDir();
    wtDir = makeTmpDir();

    // Worktree run structure: status.json + resolved prompt file
    const wtRunDir = join(wtDir, '.worca', 'runs', RUN_ID);
    mkdirSync(join(wtRunDir, 'agents', 'resolved'), { recursive: true });

    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: RUN_ID,
        pipeline_status: 'running',
        stages: {
          plan: {
            agent: 'planner',
            iterations: [{ number: 1, prompt: 'Build a feature' }],
          },
        },
      }),
      'utf8',
    );

    // Resolved prompt only in worktree — NOT in projDir/runs/
    writeFileSync(
      join(wtRunDir, 'agents', 'resolved', 'plan-planner-iter-1.md'),
      'RESOLVED PROMPT FOR WORKTREE',
      'utf8',
    );

    // Register run in parent project's pipelines.d/
    const pipelinesDir = join(projDir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${RUN_ID}.json`),
      JSON.stringify({ run_id: RUN_ID, worktree_path: wtDir }),
      'utf8',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projDir, { recursive: true, force: true });
    rmSync(wtDir, { recursive: true, force: true });
  });

  it('resolves file from worktree_worca_dir when is_worktree_run===true', async () => {
    const ws0 = mockWatcherSet(projDir);
    const watcherSets = new Map([['default', ws0]]);

    const router = createMessageRouter({
      watcherSets,
      getDefaultWs: () => ws0,
      prefsPath: join(projDir, 'prefs.json'),
      webhookInbox: null,
      clientManager: mockClientManager(),
      broadcaster: { broadcast: vi.fn(), broadcastToSubscribers: vi.fn() },
    });

    const mockWs = { send: vi.fn(), isAlive: true };

    await router.handleMessage(
      mockWs,
      JSON.stringify({
        id: 'req-agent-prompt',
        type: 'get-agent-prompt',
        payload: { runId: RUN_ID, stage: 'plan' },
      }),
    );

    expect(mockWs.send).toHaveBeenCalled();
    const response = JSON.parse(mockWs.send.mock.calls[0][0]);

    // FAILS with current code: handler probes proj.worcaDir/runs/<id>/agents/resolved/...
    // The file only exists at wtDir/.worca/runs/<id>/agents/resolved/...
    // so agentInstructions is null instead of the expected content.
    expect(response.ok).toBe(true);
    expect(response.payload.agentInstructions).toBe(
      'RESOLVED PROMPT FOR WORKTREE',
    );
  });
});
