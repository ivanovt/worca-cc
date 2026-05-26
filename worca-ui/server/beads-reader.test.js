import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    promisify:
      (fn) =>
      (...args) =>
        new Promise((resolve, reject) => {
          fn(...args, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn() };
});

const { execFile } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const {
  dbExists,
  extractEffortFromLabels,
  getIssue,
  listDistinctRunLabels,
  listIssues,
  listIssuesByLabel,
  listIssuesShallow,
  listUnlinkedIssues,
  countIssuesByRunLabel,
} = await import('./beads-reader.js');

const DB = '/fake/beads.db';

function mockBdResult(value) {
  execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(null, JSON.stringify(value), '');
  });
}

function mockBdError(msg = 'bd not found') {
  execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(new Error(msg), '', '');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dbExists', () => {
  it('returns false for non-existent path', () => {
    existsSync.mockReturnValue(false);
    expect(dbExists('/tmp/nonexistent/beads.db')).toBe(false);
  });

  it('returns true when the db file exists', () => {
    existsSync.mockReturnValue(true);
    expect(dbExists(DB)).toBe(true);
  });
});

describe('listIssuesShallow', () => {
  it('returns raw issues from bd list without enrichment', async () => {
    mockBdResult([
      {
        id: '1',
        title: 'A',
        status: 'open',
        priority: 2,
        updated_at: '2026-01-01',
      },
      {
        id: '2',
        title: 'B',
        status: 'closed',
        priority: 1,
        updated_at: '2026-01-02',
      },
    ]);
    const issues = await listIssuesShallow(DB);
    expect(issues).toEqual([
      {
        id: '1',
        title: 'A',
        status: 'open',
        priority: 2,
        updated_at: '2026-01-01',
      },
      {
        id: '2',
        title: 'B',
        status: 'closed',
        priority: 1,
        updated_at: '2026-01-02',
      },
    ]);
    expect(execFile).toHaveBeenCalledTimes(1);
    const args = execFile.mock.calls[0][1];
    expect(args).toContain('list');
    expect(args).toContain('--limit');
    expect(args).toContain('0');
  });

  it('returns [] when bd fails', async () => {
    mockBdError('bd not found');
    expect(await listIssuesShallow(DB)).toEqual([]);
  });

  it('returns [] when bd list returns empty', async () => {
    mockBdResult([]);
    expect(await listIssuesShallow(DB)).toEqual([]);
  });
});

describe('listIssues', () => {
  it('returns [] when bd fails', async () => {
    mockBdError();
    expect(await listIssues(DB)).toEqual([]);
  });

  it('returns transformed issues without deps', async () => {
    // bd list
    mockBdResult([
      {
        id: '1',
        title: 'Open',
        description: 'body text',
        status: 'open',
        priority: 2,
        created_at: '2026-01-01',
        dependency_count: 0,
        dependent_count: 0,
      },
    ]);
    // bd show (enrichWithDeps always calls it)
    mockBdResult([
      {
        id: '1',
        title: 'Open',
        description: 'body text',
        status: 'open',
        priority: 2,
        created_at: '2026-01-01',
        labels: [],
        dependencies: [],
      },
    ]);
    const issues = await listIssues(DB);
    expect(issues).toEqual([
      {
        id: '1',
        title: 'Open',
        body: 'body text',
        status: 'open',
        priority: 2,
        created_at: '2026-01-01',
        external_ref: null,
        depends_on: [],
        blocked_by: [],
        effort: null,
      },
    ]);
  });

  it('returns correct depends_on and blocked_by from bd show', async () => {
    // First call: bd list
    mockBdResult([
      {
        id: '1',
        title: 'Dep',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
      {
        id: '2',
        title: 'B',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 1,
      },
    ]);
    // Second call: bd show for all issues
    mockBdResult([
      {
        id: '1',
        title: 'Dep',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: [],
        dependencies: [],
      },
      {
        id: '2',
        title: 'B',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: [],
        dependencies: [
          {
            id: '1',
            title: 'Dep',
            status: 'open',
            dependency_type: 'blocks',
          },
        ],
      },
    ]);
    const issues = await listIssues(DB);
    const issueB = issues.find((i) => i.id === '2');
    expect(issueB.depends_on).toEqual(['1']);
    expect(issueB.blocked_by).toEqual(['1']);
  });

  it('closed dependency yields empty blocked_by', async () => {
    mockBdResult([
      {
        id: '2',
        title: 'B',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 1,
      },
    ]);
    mockBdResult([
      {
        id: '2',
        title: 'B',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        dependencies: [
          {
            id: '1',
            title: 'Closed dep',
            status: 'closed',
            dependency_type: 'blocks',
          },
        ],
      },
    ]);
    const issues = await listIssues(DB);
    expect(issues[0].depends_on).toEqual(['1']);
    expect(issues[0].blocked_by).toEqual([]);
  });

  it('bd list returns empty array', async () => {
    mockBdResult([]);
    expect(await listIssues(DB)).toEqual([]);
  });
});

describe('getIssue', () => {
  it('returns null when bd fails', async () => {
    mockBdError('not found');
    expect(await getIssue(DB, '999')).toBeNull();
  });

  it('returns null when bd returns empty array', async () => {
    mockBdResult([]);
    expect(await getIssue(DB, '999')).toBeNull();
  });

  it('returns correct issue with depends_on and blocked_by', async () => {
    mockBdResult([
      {
        id: '2',
        title: 'Main',
        description: 'main body',
        status: 'open',
        priority: 2,
        created_at: '',
        dependencies: [
          {
            id: '1',
            title: 'Dep',
            status: 'open',
            dependency_type: 'blocks',
          },
        ],
      },
    ]);
    const issue = await getIssue(DB, '2');
    expect(issue.title).toBe('Main');
    expect(issue.body).toBe('main body');
    expect(issue.depends_on).toEqual(['1']);
    expect(issue.blocked_by).toEqual(['1']);
  });

  it('closed dependency: blocked_by is empty', async () => {
    mockBdResult([
      {
        id: '2',
        title: 'Main',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        dependencies: [
          {
            id: '1',
            title: 'Closed',
            status: 'closed',
            dependency_type: 'blocks',
          },
        ],
      },
    ]);
    const issue = await getIssue(DB, '2');
    expect(issue.depends_on).toEqual(['1']);
    expect(issue.blocked_by).toEqual([]);
  });

  it('tombstone dependency: blocked_by is empty', async () => {
    mockBdResult([
      {
        id: '2',
        title: 'Main',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        dependencies: [
          {
            id: '1',
            title: 'Gone',
            status: 'tombstone',
            dependency_type: 'blocks',
          },
        ],
      },
    ]);
    const issue = await getIssue(DB, '2');
    expect(issue.blocked_by).toEqual([]);
  });
});

describe('listIssuesByLabel', () => {
  it('returns issues matching the given label', async () => {
    // bd list
    mockBdResult([
      {
        id: '1',
        title: 'A',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
      {
        id: '2',
        title: 'B',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
    ]);
    // bd show (enrichWithDeps always calls it)
    mockBdResult([
      {
        id: '1',
        title: 'A',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: [],
        dependencies: [],
      },
      {
        id: '2',
        title: 'B',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: [],
        dependencies: [],
      },
    ]);
    const issues = await listIssuesByLabel(DB, 'run:run-1');
    expect(issues.length).toBe(2);
    expect(issues.map((i) => i.title).sort()).toEqual(['A', 'B']);
    // Verify --label-any and --all flags were passed
    const args = execFile.mock.calls[0][1];
    expect(args).toContain('--label-any');
    expect(args).toContain('run:run-1');
    expect(args).toContain('--all');
  });

  it('returns [] when bd returns empty', async () => {
    mockBdResult([]);
    expect(await listIssuesByLabel(DB, 'run:run-999')).toEqual([]);
  });

  it('retries once on failure and returns the second attempt result', async () => {
    // First attempt: bd list fails.
    mockBdError('SIGTERM');
    // Second attempt: bd list succeeds.
    mockBdResult([
      { id: '1', title: 'A', status: 'open', priority: 2, dependency_count: 0 },
    ]);
    // bd show (enrichWithDeps always calls it)
    mockBdResult([
      {
        id: '1',
        title: 'A',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: [],
        dependencies: [],
      },
    ]);
    const issues = await listIssuesByLabel(DB, 'run:run-1');
    expect(issues.length).toBe(1);
    expect(issues[0].title).toBe('A');
  });

  it('throws when both attempts fail (no longer masquerades as empty)', async () => {
    // Both attempts fail — must propagate so the WS handler can surface
    // beads_unavailable instead of pretending the run has no beads. See
    // GH issue #180.
    mockBdError('SIGTERM');
    mockBdError('SIGTERM');
    await expect(listIssuesByLabel(DB, 'run:run-1')).rejects.toThrow('SIGTERM');
  });
});

describe('listUnlinkedIssues', () => {
  it('returns only issues without run: labels', async () => {
    // First call: bd list
    mockBdResult([
      {
        id: '1',
        title: 'Linked',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
      {
        id: '2',
        title: 'Unlinked',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
      {
        id: '3',
        title: 'Other label',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
    ]);
    // Second call: bd show (to get labels)
    mockBdResult([
      {
        id: '1',
        title: 'Linked',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: ['run:run-1'],
      },
      {
        id: '2',
        title: 'Unlinked',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
      },
      {
        id: '3',
        title: 'Other label',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: ['component:auth'],
      },
    ]);
    const issues = await listUnlinkedIssues(DB);
    expect(issues.length).toBe(2);
    expect(issues.map((i) => i.title).sort()).toEqual([
      'Other label',
      'Unlinked',
    ]);
  });

  it('returns [] when bd list returns empty', async () => {
    mockBdResult([]);
    expect(await listUnlinkedIssues(DB)).toEqual([]);
  });

  it('returns [] when bd fails', async () => {
    mockBdError('fail');
    expect(await listUnlinkedIssues(DB)).toEqual([]);
  });
});

describe('countIssuesByRunLabel', () => {
  // 3-call pattern: bd label list-all → bd list --all → bd show <ids>,
  // then group by run labels in JS.
  it('returns total + done per run, with done=closed-status count', async () => {
    // Call 1: bd label list-all → totals per label
    mockBdResult([
      { label: 'run:run-1', count: 5 },
      { label: 'run:run-2', count: 3 },
      { label: 'component:auth', count: 2 },
    ]);
    // Call 2: bd list --all --limit 0 → all issues
    mockBdResult([
      { id: 1, status: 'closed' },
      { id: 2, status: 'closed' },
      { id: 3, status: 'in_progress' },
      { id: 4, status: 'open' },
      { id: 5, status: 'open' },
      { id: 6, status: 'closed' },
      { id: 7, status: 'closed' },
      { id: 8, status: 'closed' },
      { id: 9, status: 'open' },
      { id: 10, status: 'closed' },
    ]);
    // Call 3: bd show <all ids> → issues with labels
    mockBdResult([
      { id: 1, status: 'closed', labels: ['run:run-1'] },
      { id: 2, status: 'closed', labels: ['run:run-1'] },
      { id: 3, status: 'in_progress', labels: ['run:run-1'] },
      { id: 4, status: 'open', labels: ['run:run-1'] },
      { id: 5, status: 'open', labels: ['run:run-1'] },
      { id: 6, status: 'closed', labels: ['run:run-2'] },
      { id: 7, status: 'closed', labels: ['run:run-2'] },
      { id: 8, status: 'closed', labels: ['run:run-2'] },
      { id: 9, status: 'open', labels: ['component:auth'] },
      { id: 10, status: 'closed', labels: ['component:auth'] },
    ]);
    expect(await countIssuesByRunLabel(DB)).toEqual({
      'run-1': { total: 5, done: 2 },
      'run-2': { total: 3, done: 3 },
    });
  });

  it('returns {} when bd fails on the label-list call', async () => {
    mockBdError('fail');
    expect(await countIssuesByRunLabel(DB)).toEqual({});
  });

  it('returns {} when no run labels exist', async () => {
    mockBdResult([{ label: 'component:auth', count: 2 }]);
    expect(await countIssuesByRunLabel(DB)).toEqual({});
  });

  it('bd list failure leaves done=0 but preserves total', async () => {
    mockBdResult([{ label: 'run:run-x', count: 4 }]);
    mockBdError('list failed');
    expect(await countIssuesByRunLabel(DB)).toEqual({
      'run-x': { total: 4, done: 0 },
    });
  });

  it('bd show failure leaves done=0 but preserves total', async () => {
    mockBdResult([{ label: 'run:run-x', count: 4 }]);
    mockBdResult([
      { id: 1, status: 'closed' },
      { id: 2, status: 'open' },
    ]);
    mockBdError('show failed');
    expect(await countIssuesByRunLabel(DB)).toEqual({
      'run-x': { total: 4, done: 0 },
    });
  });

  it('skips bd show when bd list returns no issues', async () => {
    mockBdResult([{ label: 'run:run-x', count: 0 }]);
    mockBdResult([]);
    // No third mock — bd show should not be called
    expect(await countIssuesByRunLabel(DB)).toEqual({
      'run-x': { total: 0, done: 0 },
    });
  });
});

describe('listDistinctRunLabels', () => {
  it('returns only run: labels', async () => {
    mockBdResult([
      { label: 'run:run-1', count: 5 },
      { label: 'run:run-2', count: 3 },
      { label: 'component:auth', count: 2 },
    ]);
    expect((await listDistinctRunLabels(DB)).sort()).toEqual([
      'run:run-1',
      'run:run-2',
    ]);
  });

  it('returns [] when no run labels exist', async () => {
    mockBdResult([{ label: 'component:auth', count: 2 }]);
    expect(await listDistinctRunLabels(DB)).toEqual([]);
  });

  it('returns [] when bd fails', async () => {
    mockBdError('fail');
    expect(await listDistinctRunLabels(DB)).toEqual([]);
  });
});

// Regression: a SIGTERM'd `bd show` rejection in enrichWithDeps used to
// escape these functions' try/catch (because the inner `enrichWithDeps(...)`
// promise was returned without await). The unhandled rejection then
// propagated to the WS handler and crashed Node. Both functions now
// `return await` so the catch covers the full chain.
describe('enrichWithDeps rejection handling', () => {
  it('listIssues returns [] when bd show (deps) rejects', async () => {
    mockBdResult([
      { id: '1', title: 'A', status: 'open', priority: 2, dependency_count: 1 },
    ]);
    mockBdError('SIGTERM');
    expect(await listIssues(DB)).toEqual([]);
  });

  it('listIssuesByLabel throws when bd show (deps) rejects on both attempts', async () => {
    // First attempt: bd list ok, bd show (deps) rejects.
    mockBdResult([
      { id: '1', title: 'A', status: 'open', priority: 2, dependency_count: 1 },
    ]);
    mockBdError('SIGTERM');
    // Retry: same failure mode.
    mockBdResult([
      { id: '1', title: 'A', status: 'open', priority: 2, dependency_count: 1 },
    ]);
    mockBdError('SIGTERM');
    await expect(listIssuesByLabel(DB, 'run:foo')).rejects.toThrow('SIGTERM');
  });
});

describe('countIssuesByRunLabel observability', () => {
  it('logs a warning when bd list/show fails so stale 0/N is debuggable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockBdResult([{ label: 'run:abc', count: 4 }]);
    mockBdError('SIGTERM');
    const result = await countIssuesByRunLabel(DB);
    expect(result).toEqual({ abc: { total: 4, done: 0 } });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/countIssuesByRunLabel/);
    warn.mockRestore();
  });
});

describe('extractEffortFromLabels', () => {
  it('returns null for undefined labels', () => {
    expect(extractEffortFromLabels(undefined)).toBeNull();
  });

  it('returns null for empty labels', () => {
    expect(extractEffortFromLabels([])).toBeNull();
  });

  it('returns null when no worca-effort label present', () => {
    expect(extractEffortFromLabels(['run:abc', 'component:auth'])).toBeNull();
  });

  it('extracts effort level from worca-effort label', () => {
    expect(extractEffortFromLabels(['run:abc', 'worca-effort:high'])).toBe(
      'high',
    );
  });

  it('handles all valid effort levels', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(extractEffortFromLabels([`worca-effort:${level}`])).toBe(level);
    }
  });
});

describe('effort field in output', () => {
  it('getIssue includes effort from worca-effort label', async () => {
    mockBdResult([
      {
        id: '1',
        title: 'A',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: ['worca-effort:high'],
        dependencies: [],
      },
    ]);
    const issue = await getIssue(DB, '1');
    expect(issue.effort).toBe('high');
  });

  it('getIssue effort is null when no worca-effort label', async () => {
    mockBdResult([
      {
        id: '1',
        title: 'A',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: ['run:abc'],
        dependencies: [],
      },
    ]);
    const issue = await getIssue(DB, '1');
    expect(issue.effort).toBeNull();
  });

  it('listIssues includes effort via enrichWithDeps bd show', async () => {
    // bd list
    mockBdResult([
      {
        id: '1',
        title: 'A',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
    ]);
    // bd show (enrichWithDeps always calls it now)
    mockBdResult([
      {
        id: '1',
        title: 'A',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: ['worca-effort:medium'],
        dependencies: [],
      },
    ]);
    const issues = await listIssues(DB);
    expect(issues[0].effort).toBe('medium');
  });

  it('listUnlinkedIssues includes effort from bd show labels', async () => {
    // bd list
    mockBdResult([
      {
        id: '1',
        title: 'A',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
    ]);
    // bd show
    mockBdResult([
      {
        id: '1',
        title: 'A',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: ['worca-effort:low'],
        dependencies: [],
      },
    ]);
    const issues = await listUnlinkedIssues(DB);
    expect(issues[0].effort).toBe('low');
  });

  it('enrichWithDeps calls bd show even when no issues have deps', async () => {
    // bd list — no issues have dependency_count > 0
    mockBdResult([
      {
        id: '1',
        title: 'A',
        status: 'open',
        priority: 2,
        created_at: '',
        dependency_count: 0,
      },
    ]);
    // bd show (always called now)
    mockBdResult([
      {
        id: '1',
        title: 'A',
        description: '',
        status: 'open',
        priority: 2,
        created_at: '',
        labels: ['worca-effort:high'],
        dependencies: [],
      },
    ]);
    await listIssues(DB);
    expect(execFile).toHaveBeenCalledTimes(2);
    const showArgs = execFile.mock.calls[1][1];
    expect(showArgs).toContain('show');
    expect(showArgs).toContain('1');
  });
});
