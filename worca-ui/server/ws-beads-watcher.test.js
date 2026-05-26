import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Verify that the debounce constant is at least 500ms so WAL writes are
// visible to subsequent bd list subprocess calls before the broadcast fires.
describe('ws-beads-watcher debounce', () => {
  it('uses a debounce of at least 500ms for WAL timing', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ws-beads-watcher.js'),
      'utf8',
    );
    const match = src.match(/BEADS_DEBOUNCE_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(500);
  });
});

describe('scheduleBeadsRefresh broadcast payload', () => {
  let createBeadsWatcher;
  let mockListIssuesShallow;
  let mockEnrichIssuesWithDeps;
  let mockCountIssuesByRunLabel;
  let watchCallback;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    mockListIssuesShallow = vi.fn().mockResolvedValue([
      { id: '1', title: 'A', status: 'closed', priority: 2, updated_at: '2026-01-01' },
      { id: '2', title: 'B', status: 'open', priority: 1, updated_at: '2026-01-02' },
    ]);
    mockEnrichIssuesWithDeps = vi.fn().mockResolvedValue([
      { id: '1', title: 'A', status: 'closed' },
      { id: '2', title: 'B', status: 'open' },
    ]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({
      'run-1': { total: 5, done: 2 },
      'run-2': { total: 3, done: 3 },
    });

    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: mockListIssuesShallow,
      enrichIssuesWithDeps: mockEnrichIssuesWithDeps,
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      watch: vi.fn((_path, cb) => {
        watchCallback = cb;
        return { close: vi.fn() };
      }),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
    }));

    const mod = await import('./ws-beads-watcher.js');
    createBeadsWatcher = mod.createBeadsWatcher;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('includes counts map in beads-update broadcast', async () => {
    const broadcasts = [];
    const broadcaster = {
      broadcast: (event, payload, projId) => {
        broadcasts.push({ event, payload, projId });
      },
    };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'proj-1',
    });

    // Trigger a file change on beads.db
    watchCallback('change', 'beads.db');

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(600);

    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].event).toBe('beads-update');
    expect(broadcasts[0].payload).toHaveProperty('counts');
    expect(broadcasts[0].payload.counts).toEqual({
      'run-1': { total: 5, done: 2 },
      'run-2': { total: 3, done: 3 },
    });
    expect(broadcasts[0].payload.issues).toEqual([
      { id: '1', title: 'A', status: 'closed' },
      { id: '2', title: 'B', status: 'open' },
    ]);
    expect(broadcasts[0].payload.dbExists).toBe(true);
  });

  it('includes empty counts when countIssuesByRunLabel fails', async () => {
    mockCountIssuesByRunLabel.mockRejectedValueOnce(new Error('bd fail'));
    // Ensure fingerprint changes so enrichment proceeds
    mockListIssuesShallow.mockResolvedValueOnce([
      { id: '1', title: 'A', status: 'closed', priority: 2, updated_at: '2026-01-01-fail' },
    ]);

    const broadcasts = [];
    const broadcaster = {
      broadcast: (event, payload) => {
        broadcasts.push({ event, payload });
      },
    };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
    });

    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);

    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].payload.counts).toEqual({});
    expect(broadcasts[0].payload.issues).toEqual([
      { id: '1', title: 'A', status: 'closed' },
      { id: '2', title: 'B', status: 'open' },
    ]);
  });
});

describe('payload dedup', () => {
  let createBeadsWatcher;
  let mockListIssuesShallow;
  let mockEnrichIssuesWithDeps;
  let mockCountIssuesByRunLabel;
  let watchCallback;
  let shallowCallCount;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    shallowCallCount = 0;
    mockListIssuesShallow = vi.fn(() => {
      shallowCallCount++;
      return Promise.resolve([
        { id: '1', title: 'A', status: 'closed', priority: 2, updated_at: `t${shallowCallCount}` },
      ]);
    });
    mockEnrichIssuesWithDeps = vi
      .fn()
      .mockResolvedValue([{ id: '1', title: 'A', status: 'closed' }]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({
      'run-1': { total: 2, done: 1 },
    });

    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: mockListIssuesShallow,
      enrichIssuesWithDeps: mockEnrichIssuesWithDeps,
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      watch: vi.fn((_path, cb) => {
        watchCallback = cb;
        return { close: vi.fn() };
      }),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: 100, size: 4096 })),
    }));

    const mod = await import('./ws-beads-watcher.js');
    createBeadsWatcher = mod.createBeadsWatcher;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('suppresses broadcast when payload is unchanged', async () => {
    const broadcasts = [];
    const broadcaster = {
      broadcast: (_event, payload) => broadcasts.push(payload),
    };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // First change — should broadcast
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcasts.length).toBe(1);

    // Second change — identical payload — should NOT broadcast
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcasts.length).toBe(1);
  });

  it('broadcasts when payload changes between events', async () => {
    const broadcasts = [];
    const broadcaster = {
      broadcast: (_event, payload) => broadcasts.push(payload),
    };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // First change
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcasts.length).toBe(1);

    // Mutate the data so payload differs
    mockEnrichIssuesWithDeps.mockResolvedValue([
      { id: '1', title: 'A', status: 'closed' },
      { id: '3', title: 'C', status: 'open' },
    ]);

    // Second change — different payload — should broadcast
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcasts.length).toBe(2);
  });

  it('broadcasts the first event with no prior state', async () => {
    const broadcasts = [];
    const broadcaster = {
      broadcast: (_event, payload) => broadcasts.push(payload),
    };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // Very first change — no prior payload exists — must broadcast
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);

    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].issues).toEqual([
      { id: '1', title: 'A', status: 'closed' },
    ]);
  });
});

describe('getLatestCounts', () => {
  let createBeadsWatcher;
  let mockListIssuesShallow;
  let mockEnrichIssuesWithDeps;
  let mockCountIssuesByRunLabel;
  let watchCallback;
  let shallowCallCount;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    shallowCallCount = 0;
    mockListIssuesShallow = vi.fn(() => {
      shallowCallCount++;
      return Promise.resolve([
        { id: '1', title: 'A', status: 'open', priority: 2, updated_at: `t${shallowCallCount}` },
      ]);
    });
    mockEnrichIssuesWithDeps = vi
      .fn()
      .mockResolvedValue([{ id: '1', title: 'A', status: 'open' }]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({
      'run-1': { total: 4, done: 1 },
    });

    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: mockListIssuesShallow,
      enrichIssuesWithDeps: mockEnrichIssuesWithDeps,
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      watch: vi.fn((_path, cb) => {
        watchCallback = cb;
        return { close: vi.fn() };
      }),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: 100, size: 4096 })),
    }));

    const mod = await import('./ws-beads-watcher.js');
    createBeadsWatcher = mod.createBeadsWatcher;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns empty object before any refresh', () => {
    const watcher = createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster: { broadcast: vi.fn() },
    });

    expect(watcher.getLatestCounts()).toEqual({});
  });

  it('returns cached counts after a refresh', async () => {
    const watcher = createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster: { broadcast: vi.fn() },
    });

    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);

    expect(watcher.getLatestCounts()).toEqual({
      'run-1': { total: 4, done: 1 },
    });
  });

  it('updates cached counts on subsequent refreshes', async () => {
    const watcher = createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster: { broadcast: vi.fn() },
    });

    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);

    mockCountIssuesByRunLabel.mockResolvedValue({
      'run-1': { total: 4, done: 3 },
    });
    mockEnrichIssuesWithDeps.mockResolvedValue([{ id: '2', title: 'B', status: 'open' }]);

    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);

    expect(watcher.getLatestCounts()).toEqual({
      'run-1': { total: 4, done: 3 },
    });
  });
});

describe('resolveBeadsCounts', () => {
  let resolveBeadsCounts;
  let mockCountIssuesByRunLabel;
  let mockExistsSync;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    mockCountIssuesByRunLabel = vi
      .fn()
      .mockResolvedValue({ 'run-1': { total: 4, done: 1 } });
    mockExistsSync = vi.fn(() => true);

    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: vi.fn().mockResolvedValue([]),
      enrichIssuesWithDeps: vi.fn().mockResolvedValue([]),
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));

    vi.doMock('node:fs', () => ({
      existsSync: mockExistsSync,
      watch: vi.fn(() => ({ close: vi.fn() })),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: 100, size: 4096 })),
    }));

    const mod = await import('./ws-beads-watcher.js');
    resolveBeadsCounts = mod.resolveBeadsCounts;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const POLLING_WSET = { projectId: 'p1', worcaDir: '/fake/p1/.claude/worca' };

  it('returns {} for a missing wset', async () => {
    expect(await resolveBeadsCounts(undefined)).toEqual({});
    expect(mockCountIssuesByRunLabel).not.toHaveBeenCalled();
  });

  it('returns the live watcher cache without a DB read when non-empty', async () => {
    const wset = {
      ...POLLING_WSET,
      beadsWatcher: {
        getLatestCounts: () => ({ 'run-x': { total: 2, done: 2 } }),
      },
    };
    expect(await resolveBeadsCounts(wset)).toEqual({
      'run-x': { total: 2, done: 2 },
    });
    expect(mockCountIssuesByRunLabel).not.toHaveBeenCalled();
  });

  it('falls back to a DB read when there is no beadsWatcher (TIER_POLLING)', async () => {
    expect(await resolveBeadsCounts(POLLING_WSET)).toEqual({
      'run-1': { total: 4, done: 1 },
    });
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(1);
  });

  it('falls back to a DB read when the live cache is empty', async () => {
    const wset = {
      ...POLLING_WSET,
      beadsWatcher: { getLatestCounts: () => ({}) },
    };
    expect(await resolveBeadsCounts(wset)).toEqual({
      'run-1': { total: 4, done: 1 },
    });
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(1);
  });

  it('TTL-caches the fallback (no second DB read within the window)', async () => {
    await resolveBeadsCounts(POLLING_WSET);
    await resolveBeadsCounts(POLLING_WSET);
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(1);
  });

  it('re-reads the DB after the TTL expires', async () => {
    await resolveBeadsCounts(POLLING_WSET);
    await vi.advanceTimersByTimeAsync(30001);
    await resolveBeadsCounts(POLLING_WSET);
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent in-flight reads', async () => {
    const [a, b] = await Promise.all([
      resolveBeadsCounts(POLLING_WSET),
      resolveBeadsCounts(POLLING_WSET),
    ]);
    expect(a).toEqual({ 'run-1': { total: 4, done: 1 } });
    expect(b).toEqual({ 'run-1': { total: 4, done: 1 } });
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(1);
  });

  it('returns {} when the beads DB does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    expect(await resolveBeadsCounts(POLLING_WSET)).toEqual({});
    expect(mockCountIssuesByRunLabel).not.toHaveBeenCalled();
  });
});

describe('refresh in-flight guard', () => {
  let createBeadsWatcher;
  let mockListIssuesShallow;
  let mockEnrichIssuesWithDeps;
  let mockCountIssuesByRunLabel;
  let watchCallback;
  let inFlight;
  let maxInFlight;
  let resolvers;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    inFlight = 0;
    maxInFlight = 0;
    resolvers = [];
    let callCount = 0;
    mockListIssuesShallow = vi.fn(
      () =>
        new Promise((res) => {
          callCount++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight--;
            res([{ id: '1', title: 'A', status: 'open', priority: 2, updated_at: `t${callCount}` }]);
          });
        }),
    );
    mockEnrichIssuesWithDeps = vi
      .fn()
      .mockResolvedValue([{ id: '1', title: 'A', status: 'open' }]);
    mockCountIssuesByRunLabel = vi
      .fn()
      .mockResolvedValue({ 'run-1': { total: 1, done: 0 } });

    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: mockListIssuesShallow,
      enrichIssuesWithDeps: mockEnrichIssuesWithDeps,
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      watch: vi.fn((_path, cb) => {
        watchCallback = cb;
        return { close: vi.fn() };
      }),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: 100, size: 4096 })),
    }));

    const mod = await import('./ws-beads-watcher.js');
    createBeadsWatcher = mod.createBeadsWatcher;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never overlaps refreshes; coalesces mid-flight events into one trailing pass', async () => {
    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster: { broadcast: vi.fn() },
      projectId: 'p1',
    });

    // Change #1 → first refresh starts and hangs on listIssues.
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(mockListIssuesShallow).toHaveBeenCalledTimes(1);
    expect(inFlight).toBe(1);

    // Changes #2 and #3 arrive WHILE refresh #1 is in flight → guarded: no
    // overlapping computation, just a coalesced pending flag.
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(mockListIssuesShallow).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    // Finish refresh #1 → exactly one trailing (coalesced) refresh runs.
    resolvers[0]();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(mockListIssuesShallow).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);

    // Finish the trailing refresh → nothing else pending.
    resolvers[1]();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(mockListIssuesShallow).toHaveBeenCalledTimes(2);
  });
});

describe('peekBeadsCounts (non-blocking)', () => {
  let peekBeadsCounts;
  let mockCountIssuesByRunLabel;
  let mockExistsSync;
  let resolveCount;

  beforeEach(async () => {
    vi.resetModules();

    mockExistsSync = vi.fn(() => true);
    // A controllable promise so we can assert peek returns BEFORE the bd read
    // resolves (i.e. it never awaits the cold query).
    resolveCount = undefined;
    mockCountIssuesByRunLabel = vi.fn(
      () =>
        new Promise((res) => {
          resolveCount = res;
        }),
    );

    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: vi.fn().mockResolvedValue([]),
      enrichIssuesWithDeps: vi.fn().mockResolvedValue([]),
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));

    vi.doMock('node:fs', () => ({
      existsSync: mockExistsSync,
      watch: vi.fn(() => ({ close: vi.fn() })),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: 100, size: 4096 })),
    }));

    const mod = await import('./ws-beads-watcher.js');
    peekBeadsCounts = mod.peekBeadsCounts;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const WSET = { projectId: 'p1', worcaDir: '/fake/p1/.claude/worca' };

  it('returns {} for a missing wset without a DB read', () => {
    expect(peekBeadsCounts(undefined)).toEqual({});
    expect(mockCountIssuesByRunLabel).not.toHaveBeenCalled();
  });

  it('returns the live watcher cache synchronously without a DB read', () => {
    const wset = {
      ...WSET,
      beadsWatcher: {
        getLatestCounts: () => ({ 'run-x': { total: 2, done: 2 } }),
      },
    };
    expect(peekBeadsCounts(wset)).toEqual({ 'run-x': { total: 2, done: 2 } });
    expect(mockCountIssuesByRunLabel).not.toHaveBeenCalled();
  });

  it('returns {} immediately on a cold cache but warms it in the background', async () => {
    // Synchronous {} even though the bd read is still pending.
    expect(peekBeadsCounts(WSET)).toEqual({});
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(1);

    // Resolve the background read and let the microtask settle.
    resolveCount({ 'run-1': { total: 4, done: 1 } });
    await new Promise((r) => setTimeout(r, 0));

    // Now warm: a second peek returns cached counts, no new read.
    expect(peekBeadsCounts(WSET)).toEqual({ 'run-1': { total: 4, done: 1 } });
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent cold peeks (one background read)', () => {
    peekBeadsCounts(WSET);
    peekBeadsCounts(WSET);
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(1);
  });

  it('returns {} and skips the read when the beads DB does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(peekBeadsCounts(WSET)).toEqual({});
    expect(mockCountIssuesByRunLabel).not.toHaveBeenCalled();
  });
});

describe('list fingerprint bail', () => {
  let createBeadsWatcher;
  let mockListIssuesShallow;
  let mockEnrichIssuesWithDeps;
  let mockCountIssuesByRunLabel;
  let watchCallback;
  let mockStatSync;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    mockListIssuesShallow = vi.fn().mockResolvedValue([
      { id: '1', title: 'A', status: 'open', priority: 2, updated_at: '2026-01-01' },
      { id: '2', title: 'B', status: 'closed', priority: 1, updated_at: '2026-01-02' },
    ]);
    mockEnrichIssuesWithDeps = vi.fn().mockResolvedValue([
      { id: '1', title: 'A', status: 'open' },
      { id: '2', title: 'B', status: 'closed' },
    ]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({});
    mockStatSync = vi.fn(() => ({ mtimeMs: 1000, size: 8192 }));

    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: mockListIssuesShallow,
      enrichIssuesWithDeps: mockEnrichIssuesWithDeps,
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      watch: vi.fn((_path, cb) => {
        watchCallback = cb;
        return { close: vi.fn() };
      }),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
      statSync: mockStatSync,
    }));

    const mod = await import('./ws-beads-watcher.js');
    createBeadsWatcher = mod.createBeadsWatcher;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips enrichment when list fingerprint is unchanged', async () => {
    const broadcaster = { broadcast: vi.fn() };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // First refresh — full pipeline
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(mockListIssuesShallow).toHaveBeenCalledTimes(1);
    expect(mockEnrichIssuesWithDeps).toHaveBeenCalledTimes(1);
    expect(broadcaster.broadcast).toHaveBeenCalledTimes(1);

    // Second refresh — same shallow list → bail before enrichment
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(mockListIssuesShallow).toHaveBeenCalledTimes(2);
    expect(mockEnrichIssuesWithDeps).toHaveBeenCalledTimes(1); // NOT called again
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(1); // NOT called again
  });

  it('proceeds with enrichment when list fingerprint changes', async () => {
    const broadcaster = { broadcast: vi.fn() };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // First refresh
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(mockEnrichIssuesWithDeps).toHaveBeenCalledTimes(1);

    // Shallow list changes
    mockListIssuesShallow.mockResolvedValue([
      { id: '1', title: 'A', status: 'closed', priority: 2, updated_at: '2026-01-01' },
      { id: '2', title: 'B', status: 'closed', priority: 1, updated_at: '2026-01-02' },
    ]);

    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(mockEnrichIssuesWithDeps).toHaveBeenCalledTimes(2); // called again
    expect(mockCountIssuesByRunLabel).toHaveBeenCalledTimes(2);
  });

  it('records WAL stat on fingerprint bail', async () => {
    const broadcaster = { broadcast: vi.fn() };
    let watchFileCallback;

    vi.resetModules();
    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: mockListIssuesShallow,
      enrichIssuesWithDeps: mockEnrichIssuesWithDeps,
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      watch: vi.fn((_path, cb) => {
        watchCallback = cb;
        return { close: vi.fn() };
      }),
      watchFile: vi.fn((_path, _opts, cb) => {
        watchFileCallback = cb;
      }),
      unwatchFile: vi.fn(),
      statSync: mockStatSync,
    }));
    const mod = await import('./ws-beads-watcher.js');

    mod.createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // First refresh
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);

    // Second refresh — fingerprint bail, but WAL stat {1000, 8192} should still be recorded
    mockStatSync.mockReturnValue({ mtimeMs: 2000, size: 12288 });
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(mockEnrichIssuesWithDeps).toHaveBeenCalledTimes(1); // bailed

    // WAL poll with the stat from the bailed refresh's own read — should be suppressed
    watchFileCallback(
      { mtimeMs: 2000, size: 12288 },
      { mtimeMs: 1000, size: 8192 },
    );
    await vi.advanceTimersByTimeAsync(600);
    // If WAL stat was recorded during bail, this self-read is suppressed
    expect(mockListIssuesShallow).toHaveBeenCalledTimes(2); // no 3rd call
  });
});

describe('WAL self-read suppression', () => {
  let createBeadsWatcher;
  let mockListIssuesShallow;
  let mockEnrichIssuesWithDeps;
  let mockCountIssuesByRunLabel;
  let watchCallback;
  let watchFileCallback;
  let mockStatSync;
  let shallowCallCount;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    shallowCallCount = 0;
    mockListIssuesShallow = vi.fn(() => {
      shallowCallCount++;
      return Promise.resolve([
        { id: '1', title: 'A', status: 'closed', priority: 2, updated_at: `t${shallowCallCount}` },
      ]);
    });
    mockEnrichIssuesWithDeps = vi
      .fn()
      .mockResolvedValue([{ id: '1', title: 'A', status: 'closed' }]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({});

    vi.doMock('./beads-reader.js', () => ({
      listIssuesShallow: mockListIssuesShallow,
      enrichIssuesWithDeps: mockEnrichIssuesWithDeps,
      countIssuesByRunLabel: mockCountIssuesByRunLabel,
    }));

    mockStatSync = vi.fn(() => ({ mtimeMs: 1000, size: 8192 }));

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      watch: vi.fn((_path, cb) => {
        watchCallback = cb;
        return { close: vi.fn() };
      }),
      watchFile: vi.fn((_path, _opts, cb) => {
        watchFileCallback = cb;
      }),
      unwatchFile: vi.fn(),
      statSync: mockStatSync,
    }));

    const mod = await import('./ws-beads-watcher.js');
    createBeadsWatcher = mod.createBeadsWatcher;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ignores WAL event matching self-read signature', async () => {
    const broadcasts = [];
    const broadcaster = {
      broadcast: (_event, payload) => broadcasts.push(payload),
    };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // Trigger an initial refresh so the watcher records post-read WAL stat
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcasts.length).toBe(1);

    // statSync returns the same signature the watcher recorded after its own read
    // so a WAL event with this stat should be suppressed
    const selfStat = { mtimeMs: 1000, size: 8192 };
    watchFileCallback(selfStat, { mtimeMs: 900, size: 4096 });

    await vi.advanceTimersByTimeAsync(600);
    // No new broadcast — the WAL change was from our own read
    expect(broadcasts.length).toBe(1);
  });

  it('records WAL stat after refresh even when payload is unchanged', async () => {
    const broadcasts = [];
    const broadcaster = {
      broadcast: (_event, payload) => broadcasts.push(payload),
    };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // First refresh — broadcasts and records WAL stat {1000, 8192}
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcasts.length).toBe(1);

    // Second refresh triggered by an external WAL change (different stat).
    // Payload is identical → no broadcast, but WAL stat MUST still be recorded.
    mockStatSync.mockReturnValue({ mtimeMs: 2000, size: 12288 });
    const externalStat = { mtimeMs: 1500, size: 10000 };
    watchFileCallback(externalStat, { mtimeMs: 1000, size: 8192 });
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcasts.length).toBe(1); // no broadcast (payload unchanged)

    // Now a WAL poll fires with the stat from the second refresh's own read.
    // If the watcher recorded it, this should be suppressed as a self-read.
    watchFileCallback(
      { mtimeMs: 2000, size: 12288 },
      { mtimeMs: 1500, size: 10000 },
    );
    await vi.advanceTimersByTimeAsync(600);
    // Must still be 1 — the self-read guard should have caught it
    expect(broadcasts.length).toBe(1);
    expect(mockListIssuesShallow).toHaveBeenCalledTimes(2); // only the 2 real refreshes
  });

  it('processes WAL event with different signature', async () => {
    const broadcasts = [];
    const broadcaster = {
      broadcast: (_event, payload) => broadcasts.push(payload),
    };

    createBeadsWatcher({
      worcaDir: '/fake/project/.claude/worca',
      broadcaster,
      projectId: 'p1',
    });

    // Trigger initial refresh
    watchCallback('change', 'beads.db');
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcasts.length).toBe(1);

    // Mutate data so payload dedup doesn't suppress
    mockEnrichIssuesWithDeps.mockResolvedValue([{ id: '1', title: 'A', status: 'open' }]);

    // WAL event with a DIFFERENT stat than what the watcher recorded
    const externalStat = { mtimeMs: 2000, size: 16384 };
    watchFileCallback(externalStat, { mtimeMs: 1000, size: 8192 });

    await vi.advanceTimersByTimeAsync(600);
    // Should broadcast — this WAL change was external
    expect(broadcasts.length).toBe(2);
  });
});
