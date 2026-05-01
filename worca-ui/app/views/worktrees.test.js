import { describe, expect, it } from 'vitest';
import { worktreesView } from './worktrees.js';

function renderToString(template) {
  if (!template) return '';
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (typeof v === 'number') result += String(v);
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
      // booleans, functions, directives — skip
    }
  });
  return result;
}

const completedWorktree = {
  run_id: 'run-abc',
  title: 'Feature: Add auth',
  branch: 'feature/auth',
  worktree_path: '/tmp/worktrees/run-abc',
  disk_bytes: 1_200_000_000,
  age_seconds: 3600,
  status: 'completed',
  removable: true,
  fleet_id: null,
  workspace_id: null,
  group_type: null,
  group_status: null,
  resumable: false,
};

const runningWorktree = {
  run_id: 'run-xyz',
  title: 'Feature: Fix bug',
  branch: 'fix/bug-123',
  worktree_path: '/tmp/worktrees/run-xyz',
  disk_bytes: 500_000_000,
  age_seconds: 600,
  status: 'running',
  removable: false,
  fleet_id: null,
  workspace_id: null,
  group_type: null,
  group_status: null,
  resumable: false,
};

const failedWorktree = {
  run_id: 'run-fail',
  title: 'Feature: Refactor DB',
  branch: 'refactor/db',
  worktree_path: '/tmp/worktrees/run-fail',
  disk_bytes: 800_000_000,
  age_seconds: 7200,
  status: 'failed',
  removable: true,
  fleet_id: null,
  workspace_id: null,
  group_type: null,
  group_status: null,
  resumable: true,
};

const fleetWorktree = {
  run_id: 'run-fleet',
  title: 'Fleet task',
  branch: 'feature/fleet-branch',
  worktree_path: '/tmp/worktrees/run-fleet',
  disk_bytes: 300_000_000,
  age_seconds: 1800,
  status: 'paused',
  removable: true,
  fleet_id: 'f_abc123',
  workspace_id: null,
  group_type: 'fleet',
  group_status: null,
  resumable: true,
};

const workspaceWorktree = {
  run_id: 'run-ws',
  title: 'Workspace task',
  branch: 'feature/ws-branch',
  worktree_path: '/tmp/worktrees/run-ws',
  disk_bytes: 400_000_000,
  age_seconds: 900,
  status: 'completed',
  removable: true,
  fleet_id: null,
  workspace_id: 'ws_xyz789',
  group_type: 'workspace',
  group_status: null,
  resumable: false,
};

describe('worktreesView - empty state', () => {
  it('shows empty state message when no worktrees', () => {
    const output = renderToString(worktreesView([]));
    expect(output).toContain('No worktrees yet');
  });

  it('shows start-a-run hint in empty state', () => {
    const output = renderToString(worktreesView([]));
    expect(output).toContain('Start a run to create one');
  });

  it('does not show table when empty', () => {
    const output = renderToString(worktreesView([]));
    expect(output).not.toContain('worktrees-table');
  });
});

describe('worktreesView - renders rows from worktrees data', () => {
  it('renders a row for each worktree', () => {
    const output = renderToString(
      worktreesView([completedWorktree, runningWorktree]),
    );
    expect(output).toContain('Feature: Add auth');
    expect(output).toContain('Feature: Fix bug');
  });

  it('renders the branch in the row', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).toContain('feature/auth');
  });

  it('renders the worktree path in the row', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).toContain('/tmp/worktrees/run-abc');
  });

  it('renders formatted disk usage in GB', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).toContain('1.2 GB');
  });

  it('renders status badge class for completed', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).toContain('status-badge-completed');
  });

  it('renders status badge class for running', () => {
    const output = renderToString(worktreesView([runningWorktree]));
    expect(output).toContain('status-badge-running');
  });

  it('renders Open and Cleanup action buttons', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).toContain('btn-open-run');
    expect(output).toContain('btn-cleanup');
  });
});

describe('worktreesView - disk summary', () => {
  it('shows total disk usage across all worktrees', () => {
    // 1.2 GB + 0.5 GB = 1.7 GB
    const output = renderToString(
      worktreesView([completedWorktree, runningWorktree]),
    );
    expect(output).toContain('1.7 GB');
    expect(output).toContain('Total disk');
  });

  it('shows cleanable disk for completed worktrees only', () => {
    const output = renderToString(
      worktreesView([completedWorktree, runningWorktree]),
    );
    expect(output).toContain('Cleanable');
    expect(output).toContain('1.2 GB');
  });

  it('shows resumable line when resumable worktrees exist', () => {
    const output = renderToString(
      worktreesView([completedWorktree, failedWorktree]),
    );
    expect(output).toContain('Held by resumable');
  });

  it('does not show resumable line when no resumable worktrees', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).not.toContain('Held by resumable');
  });

  it('renders a warning alert when total exceeds 2 GB', () => {
    // Two 1.2 GB worktrees → 2.4 GB total
    const big = {
      ...completedWorktree,
      run_id: 'r2',
      disk_bytes: 1_200_000_000,
    };
    const output = renderToString(worktreesView([completedWorktree, big]));
    expect(output).toContain('worktrees-disk-alert');
    expect(output).toContain('disk usage is high');
  });
});

describe('worktreesView - cleanup button disabled when running', () => {
  it('adds btn-cleanup-disabled class when status is running', () => {
    const output = renderToString(worktreesView([runningWorktree]));
    expect(output).toContain('btn-cleanup-disabled');
  });

  it('does not add btn-cleanup-disabled class when status is completed', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).not.toContain('btn-cleanup-disabled');
  });

  it('does not add btn-cleanup-disabled class when status is failed', () => {
    const output = renderToString(worktreesView([failedWorktree]));
    expect(output).not.toContain('btn-cleanup-disabled');
  });

  it('does not add btn-cleanup-disabled class when status is paused', () => {
    const output = renderToString(worktreesView([fleetWorktree]));
    expect(output).not.toContain('btn-cleanup-disabled');
  });
});

describe('worktreesView - filter input narrows rows', () => {
  it('shows all rows when filter is empty', () => {
    const worktrees = [completedWorktree, runningWorktree, failedWorktree];
    const output = renderToString(worktreesView(worktrees, { filter: '' }));
    expect(output).toContain('Feature: Add auth');
    expect(output).toContain('Feature: Fix bug');
    expect(output).toContain('Feature: Refactor DB');
  });

  it('shows only matching rows when filter matches title', () => {
    const output = renderToString(
      worktreesView([completedWorktree, runningWorktree], { filter: 'auth' }),
    );
    expect(output).toContain('Feature: Add auth');
    expect(output).not.toContain('Feature: Fix bug');
  });

  it('shows only matching rows when filter matches branch', () => {
    const output = renderToString(
      worktreesView([completedWorktree, runningWorktree], {
        filter: 'bug-123',
      }),
    );
    expect(output).toContain('Feature: Fix bug');
    expect(output).not.toContain('Feature: Add auth');
  });

  it('filter is case-insensitive', () => {
    const output = renderToString(
      worktreesView([completedWorktree], { filter: 'AUTH' }),
    );
    expect(output).toContain('Feature: Add auth');
  });

  it('shows filter input in toolbar', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).toContain('worktrees-filter');
  });
});

describe('worktreesView - group label', () => {
  it('omits the group meta item for standalone worktrees', () => {
    // The card no longer renders a "Group: —" line for standalone worktrees;
    // the meta item is just left out.
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).not.toContain('Group:');
  });

  it('shows fleet ID in the group meta item for fleet worktrees', () => {
    const output = renderToString(worktreesView([fleetWorktree]));
    expect(output).toContain('Group:');
    expect(output).toContain('fleet:f_abc123');
  });

  it('shows workspace ID in the group meta item for workspace worktrees', () => {
    const output = renderToString(worktreesView([workspaceWorktree]));
    expect(output).toContain('Group:');
    expect(output).toContain('workspace:ws_xyz789');
  });
});

describe('worktreesView - resume-aware confirmation dialog', () => {
  it('shows cleanup dialog when dialogItem is set', () => {
    const output = renderToString(
      worktreesView([completedWorktree], { dialogItem: completedWorktree }),
    );
    expect(output).toContain('worktrees-dialog-cleanup');
  });

  it('does not show cleanup dialog when dialogItem is null', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).not.toContain('worktrees-dialog-cleanup');
  });

  it('shows resume checkbox when dialogItem is resumable', () => {
    const output = renderToString(
      worktreesView([failedWorktree], { dialogItem: failedWorktree }),
    );
    expect(output).toContain('cleanup-resume-checkbox');
    expect(output).toContain('I understand resume will be unavailable');
  });

  it('does not show resume checkbox when dialogItem is not resumable', () => {
    const output = renderToString(
      worktreesView([completedWorktree], { dialogItem: completedWorktree }),
    );
    expect(output).not.toContain('cleanup-resume-checkbox');
  });

  it('shows group warning when dialogItem is part of a fleet', () => {
    const output = renderToString(
      worktreesView([fleetWorktree], { dialogItem: fleetWorktree }),
    );
    expect(output).toContain('group-warning');
    expect(output).toContain('fleet:f_abc123');
  });

  it('shows group warning when dialogItem is part of a workspace', () => {
    const wt = { ...workspaceWorktree, resumable: true };
    const output = renderToString(worktreesView([wt], { dialogItem: wt }));
    expect(output).toContain('group-warning');
    expect(output).toContain('workspace:ws_xyz789');
  });

  it('does not show group warning for standalone worktrees', () => {
    const output = renderToString(
      worktreesView([completedWorktree], { dialogItem: completedWorktree }),
    );
    expect(output).not.toContain('group-warning');
  });

  it('confirm button has disabled class when checkbox required but not checked', () => {
    const output = renderToString(
      worktreesView([failedWorktree], {
        dialogItem: failedWorktree,
        dialogCheckbox: false,
      }),
    );
    expect(output).toContain('btn-cleanup-confirm-disabled');
  });

  it('confirm button does not have disabled class when checkbox is checked', () => {
    const output = renderToString(
      worktreesView([failedWorktree], {
        dialogItem: failedWorktree,
        dialogCheckbox: true,
      }),
    );
    expect(output).not.toContain('btn-cleanup-confirm-disabled');
  });

  it('confirm button does not have disabled class for completed non-grouped worktree', () => {
    const output = renderToString(
      worktreesView([completedWorktree], { dialogItem: completedWorktree }),
    );
    expect(output).not.toContain('btn-cleanup-confirm-disabled');
  });
});

describe('worktreesView - bulk cleanup', () => {
  it('shows bulk dialog content when dialogBulk is true', () => {
    const output = renderToString(
      worktreesView([completedWorktree, runningWorktree], { dialogBulk: true }),
    );
    expect(output).toContain('worktrees-dialog-bulk');
  });

  it('lists per-group impact in bulk dialog — standalone and workspace', () => {
    const output = renderToString(
      worktreesView([completedWorktree, workspaceWorktree], {
        dialogBulk: true,
      }),
    );
    expect(output).toContain('1 standalone');
    expect(output).toContain('workspace');
  });

  it('shows count of completed worktrees in bulk dialog', () => {
    const second = { ...completedWorktree, run_id: 'run-abc2' };
    const output = renderToString(
      worktreesView([completedWorktree, runningWorktree, second], {
        dialogBulk: true,
      }),
    );
    expect(output).toContain('2 completed');
  });

  it('shows Cleanup all completed button when completed worktrees exist', () => {
    const output = renderToString(
      worktreesView([completedWorktree, runningWorktree]),
    );
    expect(output).toContain('btn-bulk-cleanup');
    expect(output).toContain('Cleanup all completed');
  });

  it('does not show Cleanup all completed button when no completed worktrees', () => {
    const output = renderToString(worktreesView([runningWorktree]));
    expect(output).not.toContain('btn-bulk-cleanup');
  });
});
