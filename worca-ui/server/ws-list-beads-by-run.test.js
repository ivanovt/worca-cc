/**
 * Tests for list-beads-by-run handler diagnostic logging.
 * TDD: written first, should initially fail until console.log is added.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockListIssuesByLabel = vi.fn();
const mockBeadsDbExists = vi.fn();

vi.mock('./beads-reader.js', () => ({
  dbExists: (...args) => mockBeadsDbExists(...args),
  listIssuesByLabel: (...args) => mockListIssuesByLabel(...args),
  countIssuesByRunLabel: vi.fn(),
  getIssue: vi.fn(),
  listDistinctRunLabels: vi.fn(),
  listIssues: vi.fn(),
  listUnlinkedIssues: vi.fn(),
}));

const { createMessageRouter } = await import('./ws-message-router.js');

function mockWatcherSet(projectId = 'default') {
  return {
    projectId,
    get worcaDir() {
      return `/mock/${projectId}/.worca`;
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
      resolveActiveRunDir: vi.fn(() => `/mock/${projectId}/.worca`),
      currentActiveRunId: vi.fn(() => null),
    },
    logWatcher: {
      watchLogFile: vi.fn(),
      watchAllLogFiles: vi.fn(),
      sendArchivedLogs: vi.fn(),
      resolveLogsBaseDir: vi.fn(() => `/mock/${projectId}/.worca`),
      clearLogWatchers: vi.fn(),
    },
    beadsWatcher: {
      getBeadsDbPath: vi.fn(() => `/mock/${projectId}/beads.db`),
    },
    eventWatcher: {
      readEventsFromFile: vi.fn(() => []),
      subscribeEvents: vi.fn(),
      maybeCloseEventWatcher: vi.fn(),
    },
  };
}

function makeRouter() {
  const wset = mockWatcherSet('default');
  const watcherSets = new Map([['default', wset]]);
  const clientManager = {
    ensureSubs(ws) {
      if (!this._map) this._map = new Map();
      if (!this._map.has(ws)) this._map.set(ws, {});
      return this._map.get(ws);
    },
    getSubs(ws) {
      if (!this._map) return null;
      return this._map.get(ws) || null;
    },
    setProtocol(ws, protocol, projectId) {
      const s = this.ensureSubs(ws);
      s.protocolVersion = protocol;
      s.projectId = projectId;
    },
  };
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

function makeWs() {
  return { send: vi.fn(), isAlive: true };
}

describe('list-beads-by-run diagnostic logging', () => {
  let consoleSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockBeadsDbExists.mockReturnValue(true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('logs runId, issue count, and per-issue statuses after listIssuesByLabel', async () => {
    const issues = [
      { id: 1, status: 'in_progress', title: 'bead A' },
      { id: 2, status: 'open', title: 'bead B' },
      { id: 3, status: 'closed', title: 'bead C' },
    ];
    mockListIssuesByLabel.mockResolvedValue(issues);

    const { router } = makeRouter();
    const ws = makeWs();

    await router.handleMessage(
      ws,
      JSON.stringify({
        id: 'req-1',
        type: 'list-beads-by-run',
        payload: { runId: '20260409-065330-698-fb28' },
      }),
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      '[list-beads-by-run] runId=%s count=%d statuses=%o',
      '20260409-065330-698-fb28',
      3,
      ['in_progress', 'open', 'closed'],
    );
  });

  it('logs zero count and empty statuses when no issues found', async () => {
    mockListIssuesByLabel.mockResolvedValue([]);

    const { router } = makeRouter();
    const ws = makeWs();

    await router.handleMessage(
      ws,
      JSON.stringify({
        id: 'req-2',
        type: 'list-beads-by-run',
        payload: { runId: 'run-empty' },
      }),
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      '[list-beads-by-run] runId=%s count=%d statuses=%o',
      'run-empty',
      0,
      [],
    );
  });
});
