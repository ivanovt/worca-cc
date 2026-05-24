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
  let mockListIssues;
  let mockCountIssuesByRunLabel;
  let watchCallback;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    mockListIssues = vi.fn().mockResolvedValue([
      { id: '1', title: 'A', status: 'closed' },
      { id: '2', title: 'B', status: 'open' },
    ]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({
      'run-1': { total: 5, done: 2 },
      'run-2': { total: 3, done: 3 },
    });

    vi.doMock('./beads-reader.js', () => ({
      listIssues: mockListIssues,
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
  let mockListIssues;
  let mockCountIssuesByRunLabel;
  let watchCallback;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    mockListIssues = vi
      .fn()
      .mockResolvedValue([{ id: '1', title: 'A', status: 'closed' }]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({
      'run-1': { total: 2, done: 1 },
    });

    vi.doMock('./beads-reader.js', () => ({
      listIssues: mockListIssues,
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
    mockListIssues.mockResolvedValue([
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
  let mockListIssues;
  let mockCountIssuesByRunLabel;
  let watchCallback;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    mockListIssues = vi
      .fn()
      .mockResolvedValue([{ id: '1', title: 'A', status: 'open' }]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({
      'run-1': { total: 4, done: 1 },
    });

    vi.doMock('./beads-reader.js', () => ({
      listIssues: mockListIssues,
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
    mockListIssues.mockResolvedValue([{ id: '2', title: 'B', status: 'open' }]);

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
      listIssues: vi.fn().mockResolvedValue([]),
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
    await vi.advanceTimersByTimeAsync(5001);
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

describe('WAL self-read suppression', () => {
  let createBeadsWatcher;
  let mockListIssues;
  let mockCountIssuesByRunLabel;
  let watchCallback;
  let watchFileCallback;
  let mockStatSync;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    mockListIssues = vi
      .fn()
      .mockResolvedValue([{ id: '1', title: 'A', status: 'closed' }]);
    mockCountIssuesByRunLabel = vi.fn().mockResolvedValue({});

    vi.doMock('./beads-reader.js', () => ({
      listIssues: mockListIssues,
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
    mockListIssues.mockResolvedValue([{ id: '1', title: 'A', status: 'open' }]);

    // WAL event with a DIFFERENT stat than what the watcher recorded
    const externalStat = { mtimeMs: 2000, size: 16384 };
    watchFileCallback(externalStat, { mtimeMs: 1000, size: 8192 });

    await vi.advanceTimersByTimeAsync(600);
    // Should broadcast — this WAL change was external
    expect(broadcasts.length).toBe(2);
  });
});
