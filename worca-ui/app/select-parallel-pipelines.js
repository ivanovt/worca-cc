let _lastRuns = null;
let _lastResult = null;

export function selectParallelPipelines(state) {
  const runs = state.runs;
  if (runs === _lastRuns) return _lastResult;
  _lastRuns = runs;
  const result = {};
  for (const run of Object.values(runs || {})) {
    if (!run.is_worktree_run) continue;
    const id = run.run_id || run.id;
    result[id] = {
      run_id: id,
      title: run.work_request?.title ?? null,
      status: run.pipeline_status,
      stage: run.stage ?? null,
      started_at: run.started_at ?? null,
      worktree_path: run.worktree_worca_dir
        ? run.worktree_worca_dir.replace(/[\\/]\.worca$/, '')
        : null,
      pid: run.pid ?? null,
    };
  }
  _lastResult = result;
  return result;
}
