import { describe, expect, it, vi } from 'vitest';
import { createMessageRouter } from './ws-message-router.js';

vi.mock('./file-access-aggregator.js', () => ({
  buildFileAccessModel: vi.fn(),
}));

vi.mock('./run-dir-resolver.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveRunDir: vi.fn() };
});

import { buildFileAccessModel } from './file-access-aggregator.js';
import { resolveRunDir } from './run-dir-resolver.js';

function mockWatcherSet(projectId, worcaDir = `/mock/${projectId}/.worca`) {
  return {
    projectId,
    get worcaDir() {
      return worcaDir;
    },
    get settingsPath() {
      return `/mock/${projectId}/.claude/settings.json`;
    },
    get projectRoot() {
      return `/mock/${projectId}`;
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
      getBeadsDbPath: vi.fn(() => `${worcaDir}/beads.db`),
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

function makeWs() {
  return { send: vi.fn(), isAlive: true };
}

function setup() {
  const watcherSets = new Map();
  const wset = mockWatcherSet('default', '/mock/default/.worca');
  watcherSets.set('default', wset);
  const clientManager = mockClientManager();
  const broadcaster = { broadcast: vi.fn(), broadcastToSubscribers: vi.fn() };
  const router = createMessageRouter({
    watcherSets,
    getDefaultWs: () => wset,
    prefsPath: '/mock/prefs.json',
    webhookInbox: null,
    clientManager,
    broadcaster,
  });
  return { router, wset };
}

describe('ws-message-router get-file-access', () => {
  it('returns bad_request when runId is missing', async () => {
    const { router } = setup();
    const ws = makeWs();

    await router.handleMessage(
      ws,
      JSON.stringify({ id: 'req-1', type: 'get-file-access', payload: {} }),
    );

    const response = JSON.parse(ws.send.mock.calls[0][0]);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('bad_request');
  });

  it('returns bad_request when runId is not a string', async () => {
    const { router } = setup();
    const ws = makeWs();

    await router.handleMessage(
      ws,
      JSON.stringify({
        id: 'req-2',
        type: 'get-file-access',
        payload: { runId: 42 },
      }),
    );

    const response = JSON.parse(ws.send.mock.calls[0][0]);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('bad_request');
  });

  it('calls buildFileAccessModel with null eventsPath when run dir not found', async () => {
    const { router } = setup();
    const ws = makeWs();

    resolveRunDir.mockReturnValue(null);
    buildFileAccessModel.mockReturnValue({
      enabled: false,
      columns: [],
      tree: [],
      searches: [],
      summary: {},
    });

    await router.handleMessage(
      ws,
      JSON.stringify({
        id: 'req-3',
        type: 'get-file-access',
        payload: { runId: 'run-abc' },
      }),
    );

    expect(buildFileAccessModel).toHaveBeenCalledWith(null);
    const response = JSON.parse(ws.send.mock.calls[0][0]);
    expect(response.ok).toBe(true);
    expect(response.payload.runId).toBe('run-abc');
    expect(response.payload.enabled).toBe(false);
  });

  it('calls buildFileAccessModel with eventsPath when run dir exists', async () => {
    const { router } = setup();
    const ws = makeWs();

    resolveRunDir.mockReturnValue('/mock/default/.worca/runs/run-xyz');
    const model = {
      enabled: true,
      columns: [
        {
          key: 'plan:1',
          stage: 'plan',
          iteration: 1,
          bead_id: null,
          agent: 'planner',
        },
      ],
      tree: [],
      searches: [],
      summary: { distinct_files: 1, total_reads: 3, total_writes: 0 },
    };
    buildFileAccessModel.mockReturnValue(model);

    await router.handleMessage(
      ws,
      JSON.stringify({
        id: 'req-4',
        type: 'get-file-access',
        payload: { runId: 'run-xyz' },
      }),
    );

    expect(resolveRunDir).toHaveBeenCalledWith(
      '/mock/default/.worca',
      'run-xyz',
    );
    expect(buildFileAccessModel).toHaveBeenCalledWith(
      '/mock/default/.worca/runs/run-xyz/events.jsonl',
    );

    const response = JSON.parse(ws.send.mock.calls[0][0]);
    expect(response.ok).toBe(true);
    expect(response.payload.runId).toBe('run-xyz');
    expect(response.payload.enabled).toBe(true);
    expect(response.payload.columns).toHaveLength(1);
    expect(response.payload.summary.distinct_files).toBe(1);
  });

  it('spreads model fields into the response at the top level', async () => {
    const { router } = setup();
    const ws = makeWs();

    resolveRunDir.mockReturnValue('/mock/default/.worca/runs/run-spread');
    buildFileAccessModel.mockReturnValue({
      enabled: true,
      columns: [],
      tree: [{ type: 'dir', path: 'src', name: 'src', children: [] }],
      searches: [],
      summary: {},
    });

    await router.handleMessage(
      ws,
      JSON.stringify({
        id: 'req-5',
        type: 'get-file-access',
        payload: { runId: 'run-spread' },
      }),
    );

    const response = JSON.parse(ws.send.mock.calls[0][0]);
    expect(response.payload.runId).toBe('run-spread');
    expect(response.payload.tree).toHaveLength(1);
    expect(response.payload.tree[0].path).toBe('src');
  });
});
