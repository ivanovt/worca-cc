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

describe('worktreesView - sort order', () => {
  it('renders newest worktrees first based on started_at', () => {
    // Three worktrees with explicit timestamps, given to the view in oldest-
    // first order (server's readdirSync default). The view must reorder so
    // the newest one appears first in the rendered output.
    const oldest = {
      ...completedWorktree,
      run_id: 'r-old',
      title: 'OLDEST CARD',
      started_at: '2026-04-30T10:00:00.000Z',
    };
    const middle = {
      ...completedWorktree,
      run_id: 'r-mid',
      title: 'MIDDLE CARD',
      started_at: '2026-04-30T11:00:00.000Z',
    };
    const newest = {
      ...completedWorktree,
      run_id: 'r-new',
      title: 'NEWEST CARD',
      started_at: '2026-04-30T12:00:00.000Z',
    };

    const output = renderToString(worktreesView([oldest, middle, newest]));
    const newIdx = output.indexOf('NEWEST CARD');
    const midIdx = output.indexOf('MIDDLE CARD');
    const oldIdx = output.indexOf('OLDEST CARD');
    expect(newIdx).toBeGreaterThan(-1);
    expect(midIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldIdx);
  });

  it('sorting tolerates missing started_at (entries fall to the end)', () => {
    const dated = {
      ...completedWorktree,
      run_id: 'r-dated',
      title: 'WITH TIMESTAMP',
      started_at: '2026-04-30T12:00:00.000Z',
    };
    const undated = {
      ...completedWorktree,
      run_id: 'r-undated',
      title: 'NO TIMESTAMP',
      started_at: null,
    };
    const output = renderToString(worktreesView([undated, dated]));
    const datedIdx = output.indexOf('WITH TIMESTAMP');
    const undatedIdx = output.indexOf('NO TIMESTAMP');
    expect(datedIdx).toBeLessThan(undatedIdx);
  });
});

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

  it('renders the Cleanup action button (card itself is the click target)', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    // No standalone "Open" button — clicking the card body navigates,
    // matching run-card behaviour.
    expect(output).not.toContain('btn-open-run');
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

  it('renders a warning alert when total exceeds default 2 GB', () => {
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

  it('uses custom diskWarningBytes option for threshold', () => {
    const wt = {
      ...completedWorktree,
      disk_bytes: 600_000_000,
    };
    const output = renderToString(
      worktreesView([wt], { diskWarningBytes: 500_000_000 }),
    );
    expect(output).toContain('worktrees-disk-alert');
    expect(output).toContain('disk usage is high');
  });

  it('does not show warning when below custom diskWarningBytes', () => {
    const wt = {
      ...completedWorktree,
      disk_bytes: 400_000_000,
    };
    const output = renderToString(
      worktreesView([wt], { diskWarningBytes: 500_000_000 }),
    );
    expect(output).not.toContain('worktrees-disk-alert');
  });

  it('shows disk caveat inline on the normal summary line', () => {
    // In the non-warning path the caveat is folded into the summary line
    // as a "Note:" meta-label/value pair (not a separate caveat div).
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).toContain('worktrees-summary');
    expect(output).toContain('>Note:<');
    expect(output).toContain(
      'Excludes node_modules, .git, and build/cache dirs',
    );
    expect(output).not.toContain('worktrees-disk-caveat');
  });

  it('shows disk caveat in warning-banner path', () => {
    const big = {
      ...completedWorktree,
      run_id: 'r2',
      disk_bytes: 1_200_000_000,
    };
    const output = renderToString(worktreesView([completedWorktree, big]));
    expect(output).toContain('worktrees-disk-alert');
    expect(output).toContain('worktrees-disk-caveat');
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

describe('worktreesView - cleanup_state rendering', () => {
  const cleaningWorktree = {
    run_id: 'r-cleaning',
    title: 'Mid-cleanup',
    branch: 'cleanup',
    worktree_path: '/p/x',
    disk_bytes: 1_000_000,
    age_seconds: 60,
    started_at: '2026-05-01T00:00:00Z',
    status: 'completed',
    cleanup_state: 'cleaning',
  };
  const pendingWorktree = {
    ...cleaningWorktree,
    run_id: 'r-pending',
    cleanup_state: 'pending',
  };
  const erroredWorktree = {
    ...cleaningWorktree,
    run_id: 'r-error',
    cleanup_state: null,
    cleanup_error: 'permission denied',
  };

  it('disables Cleanup button while cleanup_state is set', () => {
    const output = renderToString(worktreesView([cleaningWorktree]));
    expect(output).toContain('btn-cleanup-disabled');
  });

  it('disables Cleanup button while cleanup_state is pending', () => {
    const output = renderToString(worktreesView([pendingWorktree]));
    expect(output).toContain('btn-cleanup-disabled');
  });

  it('shows the worktree-card-cleaning class on the card', () => {
    const output = renderToString(worktreesView([cleaningWorktree]));
    expect(output).toContain('worktree-card-cleaning');
  });

  it('renders cleanup error banner when cleanup_error is set', () => {
    const output = renderToString(worktreesView([erroredWorktree]));
    expect(output).toContain('worktree-card-cleanup-error');
    expect(output).toContain('permission denied');
  });

  it('does not show cleaning class or disable button when cleanup_state is null', () => {
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).not.toContain('worktree-card-cleaning');
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
    const output = renderToString(worktreesView([completedWorktree]));
    expect(output).not.toContain('Fleet:');
    expect(output).not.toContain('Workspace:');
  });

  it('renders a Fleet: meta item linking to the fleet detail page', () => {
    const output = renderToString(worktreesView([fleetWorktree]));
    expect(output).toContain('Fleet:');
    expect(output).toContain('f_abc123');
    expect(output).toContain('href="#/fleet-runs/f_abc123"');
  });

  it('renders a Workspace: meta item linking to the workspace detail page', () => {
    const output = renderToString(worktreesView([workspaceWorktree]));
    expect(output).toContain('Workspace:');
    expect(output).toContain('ws_xyz789');
    expect(output).toContain('href="#/workspace-runs/ws_xyz789"');
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
    expect(output).toContain('fleet');
    expect(output).toContain('f_abc123');
  });

  it('shows group warning when dialogItem is part of a workspace', () => {
    const wt = { ...workspaceWorktree, resumable: true };
    const output = renderToString(worktreesView([wt], { dialogItem: wt }));
    expect(output).toContain('group-warning');
    expect(output).toContain('workspace');
    expect(output).toContain('ws_xyz789');
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

  it('bulk dialog shows grouped caveat when grouped completed are included', () => {
    const groupedCompleted = {
      ...completedWorktree,
      run_id: 'run-grouped-c',
      fleet_id: 'f_abc',
      group_type: 'fleet',
    };
    const output = renderToString(
      worktreesView([completedWorktree, groupedCompleted], {
        dialogBulk: true,
      }),
    );
    expect(output).toContain('grouped');
    expect(output).toContain('resume will be unavailable');
  });

  it('bulk dialog grouped caveat is absent when no grouped completed worktrees', () => {
    const output = renderToString(
      worktreesView([completedWorktree], { dialogBulk: true }),
    );
    // completedWorktree has no group_type — no caveat
    expect(output).not.toContain('resume will be unavailable');
  });
});

describe('worktreesView - truncated disk display', () => {
  it('shows >= prefix for card disk value when truncated flag is set', () => {
    const truncatedWt = {
      ...completedWorktree,
      disk_bytes: 100_000_000,
      truncated: true,
    };
    const output = renderToString(worktreesView([truncatedWt]));
    expect(output).toContain('≥ 100.0 MB');
  });

  it('does not show >= prefix when truncated flag is absent', () => {
    const normalWt = { ...completedWorktree, disk_bytes: 100_000_000 };
    const output = renderToString(worktreesView([normalWt]));
    expect(output).toContain('100.0 MB');
    expect(output).not.toContain('≥');
  });

  it('does not show >= prefix when truncated is false', () => {
    const normalWt = {
      ...completedWorktree,
      disk_bytes: 100_000_000,
      truncated: false,
    };
    const output = renderToString(worktreesView([normalWt]));
    expect(output).not.toContain('≥');
  });
});
