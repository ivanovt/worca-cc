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
