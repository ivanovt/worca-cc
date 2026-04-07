import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn() };
});

const { execFileSync } = await import('node:child_process');
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
  it('returns [] when bd fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('bd not found');
    });
    expect(listIssues(DB)).toEqual([]);
  });

  it('returns transformed issues without deps', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([
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
      ]),
    );
    const issues = listIssues(DB);
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

  it('returns correct depends_on and blocked_by from bd show', () => {
    // First call: bd list
    execFileSync.mockReturnValueOnce(
      JSON.stringify([
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
      ]),
    );
    // Second call: bd show for issues with deps
    execFileSync.mockReturnValueOnce(
      JSON.stringify([
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
      ]),
    );
    const issues = listIssues(DB);
    const issueB = issues.find((i) => i.id === '2');
    expect(issueB.depends_on).toEqual(['1']);
    expect(issueB.blocked_by).toEqual(['1']);
  });

  it('closed dependency yields empty blocked_by', () => {
    execFileSync.mockReturnValueOnce(
      JSON.stringify([
        {
          id: '2',
          title: 'B',
          status: 'open',
          priority: 2,
          created_at: '',
          dependency_count: 1,
        },
      ]),
    );
    execFileSync.mockReturnValueOnce(
      JSON.stringify([
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
      ]),
    );
    const issues = listIssues(DB);
    expect(issues[0].depends_on).toEqual(['1']);
    expect(issues[0].blocked_by).toEqual([]);
  });

  it('bd list returns empty array', () => {
    execFileSync.mockReturnValue(JSON.stringify([]));
    expect(listIssues(DB)).toEqual([]);
  });
});

describe('getIssue', () => {
  it('returns null when bd fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(getIssue(DB, '999')).toBeNull();
  });

  it('returns null when bd returns empty array', () => {
    execFileSync.mockReturnValue(JSON.stringify([]));
    expect(getIssue(DB, '999')).toBeNull();
  });

  it('returns correct issue with depends_on and blocked_by', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([
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
      ]),
    );
    const issue = getIssue(DB, '2');
    expect(issue.title).toBe('Main');
    expect(issue.body).toBe('main body');
    expect(issue.depends_on).toEqual(['1']);
    expect(issue.blocked_by).toEqual(['1']);
  });

  it('closed dependency: blocked_by is empty', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([
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
      ]),
    );
    const issue = getIssue(DB, '2');
    expect(issue.depends_on).toEqual(['1']);
    expect(issue.blocked_by).toEqual([]);
  });

  it('tombstone dependency: blocked_by is empty', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([
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
      ]),
    );
    const issue = getIssue(DB, '2');
    expect(issue.blocked_by).toEqual([]);
  });
});

describe('listIssuesByLabel', () => {
  it('returns issues matching the given label', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([
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
      ]),
    );
    const issues = listIssuesByLabel(DB, 'run:run-1');
    expect(issues.length).toBe(2);
    expect(issues.map((i) => i.title).sort()).toEqual(['A', 'B']);
    // Verify --label-any and --all flags were passed
    const args = execFileSync.mock.calls[0][1];
    expect(args).toContain('--label-any');
    expect(args).toContain('run:run-1');
    expect(args).toContain('--all');
  });

  it('returns [] when bd returns empty', () => {
    execFileSync.mockReturnValue(JSON.stringify([]));
    expect(listIssuesByLabel(DB, 'run:run-999')).toEqual([]);
  });

  it('returns [] when bd fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('fail');
    });
    expect(listIssuesByLabel(DB, 'run:run-1')).toEqual([]);
  });
});

describe('listUnlinkedIssues', () => {
  it('returns only issues without run: labels', () => {
    // First call: bd list
    execFileSync.mockReturnValueOnce(
      JSON.stringify([
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
      ]),
    );
    // Second call: bd show (to get labels)
    execFileSync.mockReturnValueOnce(
      JSON.stringify([
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
      ]),
    );
    const issues = listUnlinkedIssues(DB);
    expect(issues.length).toBe(2);
    expect(issues.map((i) => i.title).sort()).toEqual([
      'Other label',
      'Unlinked',
    ]);
  });

  it('returns [] when bd list returns empty', () => {
    execFileSync.mockReturnValue(JSON.stringify([]));
    expect(listUnlinkedIssues(DB)).toEqual([]);
  });

  it('returns [] when bd fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('fail');
    });
    expect(listUnlinkedIssues(DB)).toEqual([]);
  });
});

describe('countIssuesByRunLabel', () => {
  it('returns counts keyed by run ID (prefix stripped)', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([
        { label: 'run:run-1', count: 5 },
        { label: 'run:run-2', count: 3 },
        { label: 'component:auth', count: 2 },
      ]),
    );
    expect(countIssuesByRunLabel(DB)).toEqual({
      'run-1': 5,
      'run-2': 3,
    });
  });

  it('returns {} when bd fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('fail');
    });
    expect(countIssuesByRunLabel(DB)).toEqual({});
  });

  it('returns {} when no run labels exist', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([{ label: 'component:auth', count: 2 }]),
    );
    expect(countIssuesByRunLabel(DB)).toEqual({});
  });
});

describe('listDistinctRunLabels', () => {
  it('returns only run: labels', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([
        { label: 'run:run-1', count: 5 },
        { label: 'run:run-2', count: 3 },
        { label: 'component:auth', count: 2 },
      ]),
    );
    expect(listDistinctRunLabels(DB).sort()).toEqual([
      'run:run-1',
      'run:run-2',
    ]);
  });

  it('returns [] when no run labels exist', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([{ label: 'component:auth', count: 2 }]),
    );
    expect(listDistinctRunLabels(DB)).toEqual([]);
  });

  it('returns [] when bd fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('fail');
    });
    expect(listDistinctRunLabels(DB)).toEqual([]);
  });
});
