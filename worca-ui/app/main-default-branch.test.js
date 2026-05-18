/**
 * Tests for propagating _default_branch from API responses onto run/worktree
 * objects in fetchAllProjectRuns and fetchWorktrees.
 */
import { describe, expect, it } from 'vitest';

/**
 * Mirrors the per-project mapping logic inside fetchAllProjectRuns.
 * Extracts default_branch from the API response and attaches it as
 * _default_branch on each run object.
 */
function mapProjectRunsResponse(data, projectName) {
  const defaultBranch = data.default_branch || null;
  return {
    runs: (data.runs || []).map((run) => ({
      ...run,
      project: run.project || projectName,
      _default_branch: defaultBranch,
    })),
    settings: data.settings || null,
    projectName,
  };
}

/**
 * Mirrors the per-project mapping logic inside fetchWorktrees.
 * Extracts default_branch from the API response and attaches it as
 * _default_branch on each worktree object.
 */
function mapWorktreesResponse(data, projectName) {
  const defaultBranch = data.default_branch || null;
  return (data.worktrees || []).map((w) => ({
    ...w,
    project: projectName,
    _default_branch: defaultBranch,
  }));
}

describe('fetchAllProjectRuns: _default_branch propagation', () => {
  it('attaches _default_branch from API response to each run', () => {
    const data = {
      runs: [
        { id: 'run-1', branch: 'master' },
        { id: 'run-2', branch: 'master' },
      ],
      default_branch: 'master',
      settings: null,
    };

    const result = mapProjectRunsResponse(data, 'my-project');

    expect(result.runs[0]._default_branch).toBe('master');
    expect(result.runs[1]._default_branch).toBe('master');
  });

  it('sets _default_branch to null when API omits default_branch', () => {
    const data = {
      runs: [{ id: 'run-1' }],
    };

    const result = mapProjectRunsResponse(data, 'my-project');

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
    const data = {
      runs: [{ id: 'run-1' }],
      default_branch: 'develop',
    };

    const result = mapProjectRunsResponse(data, 'repo-a');

    expect(result.runs[0].project).toBe('repo-a');
    expect(result.runs[0]._default_branch).toBe('develop');
  });

  it('keeps run.project if already set', () => {
    const data = {
      runs: [{ id: 'run-1', project: 'original' }],
      default_branch: 'main',
    };

    const result = mapProjectRunsResponse(data, 'fallback');

    expect(result.runs[0].project).toBe('original');
  });
});

describe('fetchWorktrees: _default_branch propagation', () => {
  it('attaches _default_branch from API response to each worktree', () => {
    const data = {
      worktrees: [
        { run_id: 'wt-1', branch: 'feat/a' },
        { run_id: 'wt-2', branch: 'feat/b' },
      ],
      default_branch: 'main',
    };

    const result = mapWorktreesResponse(data, 'my-project');

    expect(result[0]._default_branch).toBe('main');
    expect(result[1]._default_branch).toBe('main');
  });

  it('sets _default_branch to null when API omits default_branch', () => {
    const data = {
      worktrees: [{ run_id: 'wt-1' }],
    };

    const result = mapWorktreesResponse(data, 'my-project');

    expect(result[0]._default_branch).toBeNull();
  });

  it('preserves existing worktree fields alongside _default_branch', () => {
    const data = {
      worktrees: [{ run_id: 'wt-1', branch: 'feat/x', status: 'running' }],
      default_branch: 'develop',
    };

    const result = mapWorktreesResponse(data, 'proj');

    expect(result[0]).toMatchObject({
      run_id: 'wt-1',
      branch: 'feat/x',
      status: 'running',
      project: 'proj',
      _default_branch: 'develop',
    });
  });

  it('stamps project name on every worktree', () => {
    const data = {
      worktrees: [{ run_id: 'wt-1' }, { run_id: 'wt-2' }],
      default_branch: 'master',
    };

    const result = mapWorktreesResponse(data, 'repo-b');

    for (const wt of result) {
      expect(wt.project).toBe('repo-b');
      expect(wt._default_branch).toBe('master');
    }
  });
});
