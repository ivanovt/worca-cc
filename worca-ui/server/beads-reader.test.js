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
  getIssue,
  listDistinctRunLabels,
  listIssues,
  listIssuesByLabel,
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

describe('listIssues', () => {
  it('returns [] when bd fails', async () => {
    mockBdError();
    expect(await listIssues(DB)).toEqual([]);
  });

  it('returns transformed issues without deps', async () => {
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
    // Second call: bd show for issues with deps
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

  it('returns [] when bd fails', async () => {
    mockBdError('fail');
    expect(await listIssuesByLabel(DB, 'run:run-1')).toEqual([]);
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
