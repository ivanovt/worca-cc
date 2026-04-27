import { describe, expect, it } from 'vitest';
import { selectParallelPipelines } from './select-parallel-pipelines.js';

describe('selectParallelPipelines', () => {
  it('returns empty object when state has no runs', () => {
    expect(selectParallelPipelines({ runs: {} })).toEqual({});
  });

  it('returns empty object when no worktree runs exist', () => {
    const state = {
      runs: {
        'run-root': {
          run_id: 'run-root',
          pipeline_status: 'running',
          is_worktree_run: false,
        },
        'run-root-2': {
          run_id: 'run-root-2',
          pipeline_status: 'completed',
        },
      },
    };
    expect(selectParallelPipelines(state)).toEqual({});
  });

  it('filters to only is_worktree_run===true entries', () => {
    const state = {
      runs: {
        'run-root': { run_id: 'run-root', pipeline_status: 'running' },
        'run-wt-1': {
          run_id: 'run-wt-1',
          is_worktree_run: true,
          pipeline_status: 'running',
          work_request: { title: 'Worktree Task' },
          stage: 'implement',
          started_at: '2026-04-26T10:00:00Z',
          worktree_worca_dir: '/path/to/wt/.worca',
          pid: 12345,
        },
      },
    };
    const result = selectParallelPipelines(state);
    expect(Object.keys(result)).toEqual(['run-wt-1']);
    expect('run-root' in result).toBe(false);
  });

  it('maps fields to pipelineCardView contract', () => {
    const state = {
      runs: {
        'run-wt-2': {
          run_id: 'run-wt-2',
          is_worktree_run: true,
          pipeline_status: 'paused',
          work_request: { title: 'My Feature' },
          stage: 'test',
          started_at: '2026-04-26T11:00:00Z',
          worktree_worca_dir: '/projects/myrepo/.worca',
          pid: 42000,
        },
      },
    };
    const result = selectParallelPipelines(state);
    expect(result['run-wt-2']).toEqual({
      run_id: 'run-wt-2',
      title: 'My Feature',
      status: 'paused',
      stage: 'test',
      started_at: '2026-04-26T11:00:00Z',
      worktree_path: '/projects/myrepo',
      pid: 42000,
    });
  });

  it('derives worktree_path by stripping /.worca suffix', () => {
    const state = {
      runs: {
        'run-wt-3': {
          run_id: 'run-wt-3',
          is_worktree_run: true,
          pipeline_status: 'running',
          worktree_worca_dir: '/worktrees/feature-branch/.worca',
        },
      },
    };
    const result = selectParallelPipelines(state);
    expect(result['run-wt-3'].worktree_path).toBe('/worktrees/feature-branch');
  });

  it('uses null for worktree_path when worktree_worca_dir is absent', () => {
    const state = {
      runs: {
        'run-wt-4': {
          run_id: 'run-wt-4',
          is_worktree_run: true,
          pipeline_status: 'running',
        },
      },
    };
    const result = selectParallelPipelines(state);
    expect(result['run-wt-4'].worktree_path).toBeNull();
  });

  it('memoizes: returns same reference when state.runs is unchanged', () => {
    const runs = {
      'run-wt-5': {
        run_id: 'run-wt-5',
        is_worktree_run: true,
        pipeline_status: 'running',
        worktree_worca_dir: '/wt/foo/.worca',
      },
    };
    const state = { runs };
    const r1 = selectParallelPipelines(state);
    const r2 = selectParallelPipelines(state);
    expect(r1).toBe(r2);
  });

  it('recomputes when state.runs reference changes', () => {
    const runs1 = {
      'run-wt-6': {
        run_id: 'run-wt-6',
        is_worktree_run: true,
        pipeline_status: 'running',
      },
    };
    const runs2 = {
      'run-wt-6': {
        run_id: 'run-wt-6',
        is_worktree_run: true,
        pipeline_status: 'completed',
      },
    };
    const r1 = selectParallelPipelines({ runs: runs1 });
    const r2 = selectParallelPipelines({ runs: runs2 });
    expect(r1).not.toBe(r2);
    expect(r2['run-wt-6'].status).toBe('completed');
  });

  it('uses run.id as fallback when run_id is absent', () => {
    const state = {
      runs: {
        'hash-abc': {
          id: 'hash-abc',
          is_worktree_run: true,
          pipeline_status: 'running',
          worktree_worca_dir: '/wt/bar/.worca',
        },
      },
    };
    const result = selectParallelPipelines(state);
    expect(Object.keys(result)).toContain('hash-abc');
    expect(result['hash-abc'].run_id).toBe('hash-abc');
  });
});
