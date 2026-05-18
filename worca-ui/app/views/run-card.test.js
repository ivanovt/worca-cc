import { describe, expect, it } from 'vitest';
import { runCardView } from './run-card.js';

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
      // unsafeHTML directives / functions — skip
    }
  });
  return result;
}

describe('runCardView - status class on card', () => {
  it('adds status-running class when pipeline_status is running', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('status-running');
  });

  it('adds status-paused class when pipeline_status is paused', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('status-paused');
  });

  it('adds status-completed class when pipeline_status is completed', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('status-completed');
  });

  it('adds status-failed class when pipeline_status is failed', () => {
    const run = {
      id: '1',
      pipeline_status: 'failed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('status-failed');
  });

  it('falls back to status-running for active run without pipeline_status', () => {
    const run = { id: '1', active: true, started_at: '2026-01-01T00:00:00Z' };
    const output = renderToString(runCardView(run));
    expect(output).toContain('status-running');
  });

  it('falls back to status-completed for inactive run without pipeline_status', () => {
    const run = {
      id: '1',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('status-completed');
  });
});

describe('runCardView - status icon tooltip', () => {
  it('shows tooltip on status icon when status_changed_at is set', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      status_changed_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('title=');
  });

  it('shows tooltip with completed_at for completed runs', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('title=');
  });

  it('shows tooltip for running runs using started_at', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('title=');
  });

  it('does not show title attribute when no time reference available', () => {
    const run = { id: '1', pipeline_status: 'pending', active: false };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('title=');
  });
});

describe('runCardView - quick-action buttons', () => {
  it('shows pause button with btn-quick-pause when running and onPause provided', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onPause: () => {} }));
    expect(output).toContain('btn-quick-pause');
  });

  it('shows resume button with btn-quick-resume when paused and onResume provided', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onResume: () => {} }));
    expect(output).toContain('btn-quick-resume');
  });

  it('shows resume button when failed and onResume provided', () => {
    const run = {
      id: '1',
      pipeline_status: 'failed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onResume: () => {} }));
    expect(output).toContain('btn-quick-resume');
  });

  it('does not show pause button when running but no onPause', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('btn-quick-pause');
  });

  it('does not show pause button when paused even with onPause', () => {
    const run = { id: '1', pipeline_status: 'paused', active: false };
    const output = renderToString(runCardView(run, { onPause: () => {} }));
    expect(output).not.toContain('btn-quick-pause');
  });

  it('does not show resume button when running even with onResume', () => {
    const run = { id: '1', pipeline_status: 'running', active: true };
    const output = renderToString(runCardView(run, { onResume: () => {} }));
    expect(output).not.toContain('btn-quick-resume');
  });
});

describe('runCardView - border-left via statusClass on card div', () => {
  it('run-card div includes status class for CSS border-left targeting', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    // The class "run-card status-running" on the outer div enables border-left via CSS
    expect(output).toMatch(/class="run-card\s+status-running"/);
  });

  it('paused run card has status-paused on outer div', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).toMatch(/class="run-card\s+status-paused"/);
  });
});

describe('runCardView - archive/unarchive buttons', () => {
  it('shows archive button when onArchive provided and run is paused and not archived', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onArchive: () => {} }));
    expect(output).toContain('btn-quick-archive');
    expect(output).toContain('Archive');
  });

  it('shows archive button when onArchive provided and run is failed and not archived', () => {
    const run = {
      id: '1',
      pipeline_status: 'failed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onArchive: () => {} }));
    expect(output).toContain('btn-quick-archive');
  });

  it('does not show archive button when run is already archived', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      archived: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onArchive: () => {} }));
    expect(output).not.toContain('btn-quick-archive');
  });

  it('does not show archive button when run is running', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onArchive: () => {} }));
    expect(output).not.toContain('btn-quick-archive');
  });

  it('shows archive button when run is completed and not active', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
    };
    const output = renderToString(runCardView(run, { onArchive: () => {} }));
    expect(output).toContain('btn-quick-archive');
  });

  it('does not show archive button when no onArchive callback', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('btn-quick-archive');
  });

  it('shows unarchive button when onUnarchive provided and run is archived', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      archived: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onUnarchive: () => {} }));
    expect(output).toContain('btn-quick-archive');
    expect(output).toContain('Unarchive');
  });

  it('does not show unarchive button for paused run (not in unarchive allowed states)', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      archived: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onUnarchive: () => {} }));
    expect(output).not.toContain('Unarchive');
  });

  it('does not show unarchive button when run is not archived', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onUnarchive: () => {} }));
    expect(output).not.toContain('Unarchive');
  });

  it('does not show unarchive button when no onUnarchive callback', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      archived: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('Unarchive');
  });
});

describe('runCardView - duration for active run with completed stages', () => {
  it('shows a duration greater than the last stage end when active run has been running longer', () => {
    // Use relative dates so the test doesn't rot over time
    const now = Date.now();
    const startedAt = new Date(now - 35 * 60 * 1000).toISOString(); // 35 min ago
    const stageEnd = new Date(now - 30 * 60 * 1000).toISOString(); // completed 30 min ago (5m into run)
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: startedAt,
      stages: {
        coordinate: { status: 'completed', completed_at: stageEnd },
      },
    };
    const output = renderToString(runCardView(run));
    // Duration should show elapsed-to-now (~35m), not stage-based span (~5m)
    expect(output).toContain('35m');
  });

  it('uses elapsed-to-now for duration when run is active regardless of stage completion', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
      stages: {
        coordinate: {
          status: 'completed',
          completed_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(), // completed 8 min ago
        },
      },
    };
    const output = renderToString(runCardView(run));
    // Should contain "10m" not "2m" (duration from start to now, not from start to stage-end)
    expect(output).toContain('10m');
  });
});

describe('runCardView - stop button via actionAllowed', () => {
  it('shows stop button when running and onStop provided', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onStop: () => {} }));
    expect(output).toContain('btn-quick-stop');
    expect(output).toContain('Stop');
  });

  it('does not show stop button when paused (actionAllowed=false)', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onStop: () => {} }));
    expect(output).not.toContain('btn-quick-stop');
  });

  it('does not show stop button when no onStop callback', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('btn-quick-stop');
  });
});

describe('runCardView - cancel button via actionAllowed', () => {
  it('shows cancel button when paused and onCancel provided', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onCancel: () => {} }));
    expect(output).toContain('btn-quick-cancel');
    expect(output).toContain('Cancel');
  });

  it('shows cancel button when running and onCancel provided', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onCancel: () => {} }));
    expect(output).toContain('btn-quick-cancel');
  });

  it('shows cancel button when failed and onCancel provided', () => {
    const run = {
      id: '1',
      pipeline_status: 'failed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onCancel: () => {} }));
    expect(output).toContain('btn-quick-cancel');
  });

  it('does not show cancel button when completed (actionAllowed=false)', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onCancel: () => {} }));
    expect(output).not.toContain('btn-quick-cancel');
  });

  it('does not show cancel button when cancelled (actionAllowed=false)', () => {
    const run = {
      id: '1',
      pipeline_status: 'cancelled',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run, { onCancel: () => {} }));
    expect(output).not.toContain('btn-quick-cancel');
  });

  it('does not show cancel button when no onCancel callback', () => {
    const run = {
      id: '1',
      pipeline_status: 'paused',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('btn-quick-cancel');
  });
});

describe('runCardView - worktree indicator icon', () => {
  it('renders folder-symlink icon when is_worktree_run is true', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      is_worktree_run: true,
      worktree_path: '/tmp/worktrees/run-abc',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('folder-symlink');
  });

  it('includes worktree path in title attribute on icon', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
      is_worktree_run: true,
      worktree_path: '/tmp/worktrees/run-abc',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('Isolated worktree at /tmp/worktrees/run-abc');
  });

  it('does not render folder-symlink icon when is_worktree_run is false', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      is_worktree_run: false,
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('folder-symlink');
  });

  it('does not render folder-symlink icon when is_worktree_run is absent', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('folder-symlink');
  });
});

describe('runCardView - Finished timestamp visibility', () => {
  it('shows elapsed time from started_at to now for active run without completed_at', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('5m');
  });

  it('does not show a Finished timestamp for active runs', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    };
    const output = renderToString(runCardView(run));
    // endTime is null for active runs — formatTimestamp(null) returns 'N/A', not a real date
    const finishedMatch = output.match(
      /Finished:<\/span>\s*<span[^>]*>([^<]+)<\/span>/,
    );
    expect(finishedMatch).not.toBeNull();
    expect(finishedMatch[1].trim()).toBe('N/A');
  });

  it('shows Finished timestamp for completed runs', () => {
    const completedAt = '2026-04-10T12:30:00Z';
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-04-10T12:00:00Z',
      completed_at: completedAt,
    };
    const output = renderToString(runCardView(run));
    // formatTimestamp returns a formatted date string (not 'N/A') for a real completed_at
    const finishedMatch = output.match(
      /Finished:<\/span>\s*<span[^>]*>([^<]+)<\/span>/,
    );
    expect(finishedMatch).not.toBeNull();
    expect(finishedMatch[1].trim()).not.toBe('N/A');
    expect(finishedMatch[1].trim()).toContain('2026');
  });
});

describe('runCardView - guide conflict icon', () => {
  it('shows exclamation-triangle icon when guide_conflicts is non-empty', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      guide_conflicts: [
        {
          stage: 'plan',
          message: 'Description asks for X but guide forbids it',
          source: 'description',
        },
      ],
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('exclamation-triangle');
  });

  it('shows conflict count in tooltip', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      guide_conflicts: [
        { stage: 'plan', message: 'Conflict A', source: 'description' },
        { stage: 'review', message: 'Conflict B', source: 'plan' },
      ],
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('Guide conflicts flagged (2)');
  });

  it('does not show conflict icon when guide_conflicts is empty', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      guide_conflicts: [],
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('exclamation-triangle');
  });

  it('does not show conflict icon when guide_conflicts is absent', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(runCardView(run));
    expect(output).not.toContain('exclamation-triangle');
  });

  it('applies conflict-icon class for styling', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      guide_conflicts: [
        { stage: 'test', message: 'Guide says prod-like env', source: 'plan' },
      ],
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('conflict-icon');
  });
});

describe('runCardView - source/target branch display', () => {
  it('shows Source Branch with head_branch when available', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      head_branch: 'worca/feat-xyz-20260518',
      branch: 'master',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('Source Branch:');
    expect(output).toContain('worca/feat-xyz-20260518');
    expect(output).not.toContain('>master<');
  });

  it('falls back to run.branch when head_branch is absent', () => {
    const run = {
      id: '1',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
      branch: 'main',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('Source Branch:');
    expect(output).toContain('main');
  });

  it('shows Target Branch when target_branch differs from _default_branch', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      head_branch: 'worca/feat-xyz',
      target_branch: 'develop',
      _default_branch: 'master',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('Target Branch:');
    expect(output).toContain('develop');
  });

  it('hides Target Branch when target_branch equals _default_branch', () => {
    const run = {
      id: '1',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      head_branch: 'worca/feat-xyz',
      target_branch: 'master',
      _default_branch: 'master',
    };
    const output = renderToString(runCardView(run));
    expect(output).toContain('Source Branch:');
    expect(output).not.toContain('Target Branch:');
  });
});

describe('runCardView - beads badge', () => {
  const baseRun = {
    id: '1',
    pipeline_status: 'completed',
    active: false,
    started_at: '2026-01-01T00:00:00Z',
  };

  it('omits badge when beadsCount is 0 / undefined', () => {
    const output = renderToString(runCardView(baseRun));
    expect(output).not.toContain('Beads</sl-badge>');
    expect(output).not.toContain('beads</sl-badge>');
  });

  it('renders "<done>/<total> Beads" for the {total, done} object shape', () => {
    const output = renderToString(
      runCardView(baseRun, { beadsCount: { total: 5, done: 2 } }),
    );
    expect(output).toContain('2/5 Beads');
  });

  it('uses primary variant when work is in progress (done < total)', () => {
    const output = renderToString(
      runCardView(baseRun, { beadsCount: { total: 5, done: 2 } }),
    );
    // The badge for stages is the only place "primary" appears in this card —
    // but to be specific, look at the beads badge surrounding text.
    expect(output).toMatch(/variant="primary"[^>]*>2\/5 Beads/);
  });

  it('uses success variant when all beads are done (done === total)', () => {
    const output = renderToString(
      runCardView(baseRun, { beadsCount: { total: 4, done: 4 } }),
    );
    expect(output).toMatch(/variant="success"[^>]*>4\/4 Beads/);
  });

  it('legacy number shape renders as "0/<n> Beads" with primary variant', () => {
    // Backwards-compat: a plain number means "we know the total, not the
    // done count" — render it as 0/N in primary so the user sees the total
    // and knows it's still in progress.
    const output = renderToString(runCardView(baseRun, { beadsCount: 3 }));
    expect(output).toMatch(/variant="primary"[^>]*>0\/3 Beads/);
  });
});
