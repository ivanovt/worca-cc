/**
 * Shape mappers for /api/projects/:id/runs and /api/projects/:id/worktrees
 * responses. Used by fetchAllProjectRuns / fetchWorktrees in main.js and
 * exercised directly from tests so the two paths can't drift.
 */

export function mapProjectRunsResponse(data, projectName) {
  const defaultBranch = data?.default_branch || null;
  return {
    runs: (data?.runs || []).map((run) => ({
      ...run,
      project: run.project || projectName,
      _default_branch: defaultBranch,
    })),
    settings: data?.settings || null,
    projectName,
  };
}

export function mapWorktreesResponse(data, projectName) {
  const defaultBranch = data?.default_branch || null;
  return (data?.worktrees || []).map((w) => ({
    ...w,
    project: projectName,
    _default_branch: defaultBranch,
  }));
}
