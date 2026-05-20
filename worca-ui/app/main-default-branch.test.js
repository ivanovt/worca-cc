/**
 * Tests the per-response shape mappers that fetchAllProjectRuns and
 * fetchWorktrees in main.js delegate to. We import the real module — not a
 * local copy — and also stub `fetch` to exercise the full mapper-through-
 * promise path end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mapProjectRunsResponse,
  mapWorktreesResponse,
} from './utils/run-mappers.js';

describe('mapProjectRunsResponse', () => {
  it('attaches _default_branch from API response to each run', () => {
    const data = {
      runs: [
        { id: 'run-1', branch: 'main' },
        { id: 'run-2', branch: 'main' },
      ],
      default_branch: 'main',
      settings: null,
    };

    const result = mapProjectRunsResponse(data, 'my-project');

    expect(result.runs[0]._default_branch).toBe('main');
    expect(result.runs[1]._default_branch).toBe('main');
    expect(result.projectName).toBe('my-project');
  });

  it('sets _default_branch to null when API omits default_branch', () => {
    const result = mapProjectRunsResponse(
      { runs: [{ id: 'run-1' }] },
      'my-project',
    );
    expect(result.runs[0]._default_branch).toBeNull();
  });

  it('preserves existing run fields alongside _default_branch', () => {
    const data = {
      runs: [
        { id: 'run-1', head_branch: 'feat/x', pipeline_status: 'running' },
      ],
      default_branch: 'main',
    };
    const result = mapProjectRunsResponse(data, 'proj');
    expect(result.runs[0]).toMatchObject({
      id: 'run-1',
      head_branch: 'feat/x',
      pipeline_status: 'running',
      project: 'proj',
      _default_branch: 'main',
    });
  });

  it('stamps project name on run when run.project is missing', () => {
    const result = mapProjectRunsResponse(
      { runs: [{ id: 'run-1' }], default_branch: 'develop' },
      'repo-a',
    );
    expect(result.runs[0].project).toBe('repo-a');
    expect(result.runs[0]._default_branch).toBe('develop');
  });

  it('keeps run.project if already set', () => {
    const result = mapProjectRunsResponse(
      { runs: [{ id: 'run-1', project: 'original' }], default_branch: 'main' },
      'fallback',
    );
    expect(result.runs[0].project).toBe('original');
  });

  it('handles a missing runs array safely', () => {
    const result = mapProjectRunsResponse({ default_branch: 'main' }, 'proj');
    expect(result.runs).toEqual([]);
    expect(result.projectName).toBe('proj');
  });

  it('handles a null payload safely', () => {
    const result = mapProjectRunsResponse(null, 'proj');
    expect(result.runs).toEqual([]);
    expect(result.settings).toBeNull();
    expect(result.projectName).toBe('proj');
  });
});

describe('mapWorktreesResponse', () => {
  it('attaches _default_branch from API response to each worktree', () => {
    const result = mapWorktreesResponse(
      {
        worktrees: [
          { run_id: 'wt-1', branch: 'feat/a' },
          { run_id: 'wt-2', branch: 'feat/b' },
        ],
        default_branch: 'main',
      },
      'my-project',
    );
    expect(result[0]._default_branch).toBe('main');
    expect(result[1]._default_branch).toBe('main');
  });

  it('sets _default_branch to null when API omits default_branch', () => {
    const result = mapWorktreesResponse(
      { worktrees: [{ run_id: 'wt-1' }] },
      'my-project',
    );
    expect(result[0]._default_branch).toBeNull();
  });

  it('preserves existing worktree fields alongside _default_branch', () => {
    const result = mapWorktreesResponse(
      {
        worktrees: [{ run_id: 'wt-1', branch: 'feat/x', status: 'running' }],
        default_branch: 'develop',
      },
      'proj',
    );
    expect(result[0]).toMatchObject({
      run_id: 'wt-1',
      branch: 'feat/x',
      status: 'running',
      project: 'proj',
      _default_branch: 'develop',
    });
  });

  it('stamps project name on every worktree', () => {
    const result = mapWorktreesResponse(
      {
        worktrees: [{ run_id: 'wt-1' }, { run_id: 'wt-2' }],
        default_branch: 'main',
      },
      'repo-b',
    );
    for (const wt of result) {
      expect(wt.project).toBe('repo-b');
      expect(wt._default_branch).toBe('main');
    }
  });

  it('handles a missing worktrees array safely', () => {
    expect(mapWorktreesResponse({}, 'proj')).toEqual([]);
  });

  it('handles a null payload safely', () => {
    expect(mapWorktreesResponse(null, 'proj')).toEqual([]);
  });
});

describe('fetch round-trip: /api/projects/:id/runs', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('produces mapped runs end-to-end with _default_branch attached', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        runs: [{ id: 'r1' }, { id: 'r2', project: 'override' }],
        default_branch: 'main',
        settings: { foo: 1 },
      }),
    });

    const fetchAndMap = (projectName) =>
      globalThis
        .fetch(`/api/projects/${projectName}/runs`)
        .then((r) => r.json())
        .then((data) => mapProjectRunsResponse(data, projectName));

    const result = await fetchAndMap('demo');

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/projects/demo/runs');
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toMatchObject({
      id: 'r1',
      project: 'demo',
      _default_branch: 'main',
    });
    expect(result.runs[1]).toMatchObject({
      id: 'r2',
      project: 'override',
      _default_branch: 'main',
    });
    expect(result.settings).toEqual({ foo: 1 });
  });
});

describe('fetch round-trip: /api/projects/:id/worktrees', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('produces mapped worktrees end-to-end with _default_branch attached', async () => {
    globalThis.fetch.mockResolvedValue({
      json: async () => ({
        worktrees: [{ run_id: 'wt-1', branch: 'feat/a' }],
        default_branch: 'develop',
      }),
    });

    const fetchAndMap = (projectName) =>
      globalThis
        .fetch(`/api/projects/${projectName}/worktrees`)
        .then((r) => r.json())
        .then((data) => mapWorktreesResponse(data, projectName));

    const result = await fetchAndMap('repo-x');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/projects/repo-x/worktrees',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      run_id: 'wt-1',
      branch: 'feat/a',
      project: 'repo-x',
      _default_branch: 'develop',
    });
  });
});
