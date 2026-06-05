// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  _createPrClickHandler,
  _prCreationState,
  prApprovalPanelView,
  prDeferredSectionView,
  runBeadsSectionView,
  runDetailView,
} from './run-detail.js';

function renderToString(template) {
  if (!template) return '';
  if (typeof template === 'string') return template;
  if (template._$litDirective$ && template.values)
    return template.values[0] || '';
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
      else if (v?._$litDirective$ && v?.values) result += v.values[0] || '';
    }
  });
  return result;
}

describe('runBeadsSectionView - blocked state', () => {
  it('shows warning variant badge for a blocked bead', () => {
    const beads = [
      {
        id: 'worca-cc-abc',
        title: 'Some task',
        status: 'open',
        priority: 2,
        blocked_by: ['worca-cc-dep1'],
        depends_on: [],
      },
    ];
    const out = renderToString(runBeadsSectionView(beads));
    expect(out).toContain('warning');
  });

  it('shows primary variant badge for an in_progress bead that is not blocked', () => {
    const beads = [
      {
        id: 'worca-cc-xyz',
        title: 'Active task',
        status: 'in_progress',
        priority: 2,
        blocked_by: [],
        depends_on: [],
      },
    ];
    const out = renderToString(runBeadsSectionView(beads));
    expect(out).toContain('primary');
  });

  it('shows explicit blocked badge when blocked_by is non-empty', () => {
    const beads = [
      {
        id: 'worca-cc-abc',
        title: 'Blocked task',
        status: 'open',
        priority: 2,
        blocked_by: ['worca-cc-dep1'],
        depends_on: [],
      },
    ];
    const out = renderToString(runBeadsSectionView(beads));
    expect(out).toContain('blocked');
  });

  it('does not show blocked badge when blocked_by is empty', () => {
    const beads = [
      {
        id: 'worca-cc-xyz',
        title: 'Normal task',
        status: 'open',
        priority: 2,
        blocked_by: [],
        depends_on: [],
      },
    ];
    const out = renderToString(runBeadsSectionView(beads));
    // Only "open" badge text, no "blocked" badge text
    const blockedCount = (out.match(/\bblocked\b/g) || []).length;
    expect(blockedCount).toBe(0);
  });
});

describe('runBeadsSectionView - loading and error states', () => {
  it('renders the panel with no spinner before the 150ms gate', () => {
    const out = renderToString(
      runBeadsSectionView(undefined, { loaded: false, showSpinner: false }),
    );
    expect(out).toContain('run-beads-panel');
    expect(out).toContain('Beads');
    expect(out).not.toContain('run-beads-loading');
  });

  it('shows the loading spinner once the 150ms gate fires', () => {
    const out = renderToString(
      runBeadsSectionView(undefined, { loaded: false, showSpinner: true }),
    );
    expect(out).toContain('run-beads-loading');
  });

  it('shows an error state (not "no beads") when the query failed', () => {
    const out = renderToString(runBeadsSectionView(null, { loaded: true }));
    expect(out).toContain("Couldn't load Beads issues");
    expect(out).not.toContain('No linked Beads issues');
  });

  it('shows "No linked Beads issues" when loaded with an empty array', () => {
    const out = renderToString(runBeadsSectionView([], { loaded: true }));
    expect(out).toContain('No linked Beads issues');
  });
});

describe('runDetailView - endTime for active runs', () => {
  const startedAt = '2026-04-10T10:00:00Z';
  const stageEnd = '2026-04-10T10:05:43Z';

  function render(template) {
    return renderToString(template?.overview ?? template);
  }

  it('does not show Finished label for an active run even if a stage has completed', () => {
    const run = {
      id: 'r1',
      active: true,
      started_at: startedAt,
      stages: {
        coordinate: { status: 'completed', completed_at: stageEnd },
      },
    };
    const out = render(runDetailView(run));
    expect(out).not.toContain('Finished:');
  });

  it('shows Finished label for a completed run', () => {
    const run = {
      id: 'r2',
      active: false,
      started_at: startedAt,
      completed_at: '2026-04-10T11:00:00Z',
      stages: {
        coordinate: { status: 'completed', completed_at: stageEnd },
      },
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Finished:');
  });

  it('does not show Finished for an inactive run with no completed_at but a finished stage', () => {
    // Inactive run with no completed_at should still show stage-based end time
    const run = {
      id: 'r3',
      active: false,
      started_at: startedAt,
      stages: {
        coordinate: { status: 'completed', completed_at: stageEnd },
      },
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Finished:');
  });
});

describe('runDetailView - worktree metadata row', () => {
  function render(template) {
    return renderToString(template?.overview ?? template);
  }

  it('shows Worktree row with path when is_worktree_run is true', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      completed_at: '2026-04-10T11:00:00Z',
      is_worktree_run: true,
      worktree_path: '/tmp/worktrees/run-xyz',
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Worktree:');
    expect(out).toContain('/tmp/worktrees/run-xyz');
  });

  it('shows sl-copy-button in Worktree row', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      is_worktree_run: true,
      worktree_path: '/tmp/worktrees/run-xyz',
    };
    const out = render(runDetailView(run));
    expect(out).toContain('sl-copy-button');
  });

  it('does not show Worktree row when is_worktree_run is false', () => {
    const run = {
      id: 'r2',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      completed_at: '2026-04-10T11:00:00Z',
      is_worktree_run: false,
      worktree_path: '/tmp/worktrees/run-xyz',
    };
    const out = render(runDetailView(run));
    expect(out).not.toContain('Worktree:');
  });

  it('does not show Worktree row when is_worktree_run is absent', () => {
    const run = {
      id: 'r3',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      completed_at: '2026-04-10T11:00:00Z',
    };
    const out = render(runDetailView(run));
    expect(out).not.toContain('Worktree:');
  });
});

describe('runDetailView - guide conflicts panel', () => {
  function render(template) {
    return renderToString(template?.overview ?? template);
  }

  it('renders guide conflicts panel when guide_conflicts is non-empty', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      completed_at: '2026-04-10T11:00:00Z',
      guide_conflicts: [
        {
          stage: 'plan',
          message: 'Description asks for X but guide forbids it',
          source: 'description',
        },
      ],
    };
    const out = render(runDetailView(run));
    expect(out).toContain('guide-conflicts-panel');
    expect(out).toContain('Guide Conflicts');
  });

  it('lists each conflict with stage, message, and source', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      guide_conflicts: [
        {
          stage: 'plan',
          message: 'Uses REST but guide mandates gRPC',
          source: 'description',
        },
        {
          stage: 'review',
          message: 'Plan diverges from guide on auth',
          source: 'plan',
        },
      ],
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Uses REST but guide mandates gRPC');
    expect(out).toContain('Plan diverges from guide on auth');
    expect(out).toContain('>plan<');
    expect(out).toContain('>review<');
  });

  it('shows source badge for each conflict', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      guide_conflicts: [
        { stage: 'plan', message: 'Conflict', source: 'description' },
      ],
    };
    const out = render(runDetailView(run));
    expect(out).toContain('description');
  });

  it('renders View source button per conflict', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      guide_conflicts: [
        { stage: 'review', message: 'Conflict', source: 'plan' },
      ],
    };
    const out = render(runDetailView(run));
    expect(out).toContain('View source');
  });

  it('does not render guide conflicts panel when guide_conflicts is empty', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      guide_conflicts: [],
    };
    const out = render(runDetailView(run));
    expect(out).not.toContain('guide-conflicts-panel');
  });

  it('does not render guide conflicts panel when guide_conflicts is absent', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
    };
    const out = render(runDetailView(run));
    expect(out).not.toContain('guide-conflicts-panel');
  });

  it('shows conflict count in panel header badge', () => {
    const run = {
      id: 'r1',
      active: false,
      started_at: '2026-04-10T10:00:00Z',
      guide_conflicts: [
        { stage: 'plan', message: 'A', source: 'description' },
        { stage: 'review', message: 'B', source: 'plan' },
        { stage: 'test', message: 'C', source: 'plan' },
      ],
    };
    const out = render(runDetailView(run));
    expect(out).toMatch(/warning[^>]*>3</);
  });
});

describe('prApprovalPanelView', () => {
  function render(template) {
    return renderToString(template);
  }

  const pausedRunAwaitingApproval = {
    id: 'run-1',
    pipeline_status: 'paused',
    milestones: { pr_approved: false },
    stages: {},
  };

  describe('render conditions', () => {
    it('renders approval panel when pr_approved===false and pipeline_status===paused', () => {
      const out = render(prApprovalPanelView(pausedRunAwaitingApproval));
      expect(out).toContain('pr-approval-panel');
      expect(out).toContain('PR creation paused');
      expect(out).toContain('Approve');
      expect(out).toContain('Reject');
    });

    it('does not render when pr_approved is true', () => {
      const run = {
        ...pausedRunAwaitingApproval,
        milestones: { pr_approved: true },
      };
      const out = render(prApprovalPanelView(run));
      expect(out).not.toContain('pr-approval-panel');
    });

    it('does not render when pr_approved is undefined', () => {
      const run = {
        ...pausedRunAwaitingApproval,
        milestones: {},
      };
      const out = render(prApprovalPanelView(run));
      expect(out).not.toContain('pr-approval-panel');
    });

    it('does not render when milestones is absent', () => {
      const run = {
        id: 'run-1',
        pipeline_status: 'paused',
        stages: {},
      };
      const out = render(prApprovalPanelView(run));
      expect(out).not.toContain('pr-approval-panel');
    });

    it('does not render when pipeline_status is not paused', () => {
      const run = {
        ...pausedRunAwaitingApproval,
        pipeline_status: 'running',
      };
      const out = render(prApprovalPanelView(run));
      expect(out).not.toContain('pr-approval-panel');
    });

    it('does not render for terminal pipeline_status (completed)', () => {
      const run = {
        ...pausedRunAwaitingApproval,
        pipeline_status: 'completed',
      };
      const out = render(prApprovalPanelView(run));
      expect(out).not.toContain('pr-approval-panel');
    });

    it('does not render for terminal pipeline_status (failed)', () => {
      const run = {
        ...pausedRunAwaitingApproval,
        pipeline_status: 'failed',
      };
      const out = render(prApprovalPanelView(run));
      expect(out).not.toContain('pr-approval-panel');
    });

    it('does not render when run is null', () => {
      const out = render(prApprovalPanelView(null));
      expect(out).not.toContain('pr-approval-panel');
    });
  });

  describe('approve button', () => {
    it('renders success variant approve button', () => {
      const out = render(prApprovalPanelView(pausedRunAwaitingApproval));
      expect(out).toContain('variant="success"');
      expect(out).toContain('Approve');
      expect(out).toContain('create PR');
    });

    it('renders danger outline reject button', () => {
      const out = render(prApprovalPanelView(pausedRunAwaitingApproval));
      expect(out).toContain('variant="danger"');
      expect(out).toContain('outline');
      expect(out).toContain('Reject');
    });
  });

  describe('approve POST handler', () => {
    it('calls onApprove with run id when approve button clicked', () => {
      const onApprove = vi.fn();
      const result = prApprovalPanelView(pausedRunAwaitingApproval, {
        onApprove,
      });
      const out = render(result);
      expect(out).toContain('pr-approve-btn');
    });

    it('calls onReject with run id when reject button clicked', () => {
      const onReject = vi.fn();
      const result = prApprovalPanelView(pausedRunAwaitingApproval, {
        onReject,
      });
      const out = render(result);
      expect(out).toContain('pr-reject-btn');
    });
  });
});

describe('runDetailView - source/target branch display', () => {
  function render(template) {
    return renderToString(template?.overview ?? template);
  }

  it('shows Source Branch with head_branch when available', () => {
    const run = {
      id: 'r-branch-1',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      head_branch: 'worca/feat-xyz-20260518',
      branch: 'master',
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Source Branch:');
    expect(out).toContain('worca/feat-xyz-20260518');
    expect(out).not.toContain('>master<');
  });

  it('falls back to run.branch when head_branch is absent', () => {
    const run = {
      id: 'r-branch-2',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
      branch: 'develop',
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Source Branch:');
    expect(out).toContain('develop');
  });

  it('shows Target Branch when target_branch differs from _default_branch', () => {
    const run = {
      id: 'r-branch-3',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      head_branch: 'worca/feat-xyz',
      target_branch: 'develop',
      _default_branch: 'main',
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Target Branch:');
    expect(out).toContain('develop');
  });

  it('hides Target Branch when target_branch equals _default_branch', () => {
    const run = {
      id: 'r-branch-3b',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      head_branch: 'worca/feat-xyz',
      target_branch: 'main',
      _default_branch: 'main',
    };
    const out = render(runDetailView(run));
    expect(out).not.toContain('Target Branch:');
  });

  it('shows Target Branch when _default_branch is unknown (null)', () => {
    const run = {
      id: 'r-branch-3c',
      active: true,
      started_at: '2026-01-01T00:00:00Z',
      head_branch: 'worca/feat-xyz',
      target_branch: 'main',
      _default_branch: null,
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Target Branch:');
    expect(out).toContain('main');
  });

  it('attaches PR link to the Source Branch row', () => {
    const run = {
      id: 'r-branch-4',
      active: false,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
      head_branch: 'worca/feat-xyz',
      pr: { url: 'https://github.com/org/repo/pull/42' },
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Source Branch:');
    expect(out).toContain('run-pr-link');
    expect(out).toContain('https://github.com/org/repo/pull/42');
  });
});

// ─── agent prompt section ─────────────────────────────────────────────────────

describe('runDetailView — agent prompt markdown rendering', () => {
  function render(result) {
    return renderToString(result?.stages ?? result);
  }

  it('renders agent instructions as markdown, not inside <pre>', () => {
    const run = {
      stages: {
        planner: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
      },
    };
    const options = {
      promptCache: {
        planner: {
          agentInstructions: '## Role\n\nYou are a planner.',
          userPrompt: null,
        },
      },
    };
    const out = render(runDetailView(run, {}, options));
    expect(out).toContain('markdown-body');
    expect(out).not.toContain('<pre class="agent-prompt-content">');
  });

  it('renders user message as markdown, not inside <pre>', () => {
    const run = {
      stages: {
        planner: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
      },
    };
    const options = {
      promptCache: {
        planner: {
          agentInstructions: null,
          userPrompt: '**Important**: do this task.',
        },
      },
    };
    const out = render(runDetailView(run, {}, options));
    expect(out).toContain('markdown-body');
    expect(out).not.toContain('<pre class="agent-prompt-content">');
  });
});

// ─── prDeferredSectionView ────────────────────────────────────────────────────

describe('prDeferredSectionView - idle state', () => {
  function render(template) {
    return renderToString(template);
  }

  const deferredRun = {
    id: 'run-deferred-1',
    pr_deferred: true,
  };

  it('shows warning-variant deferred badge when pr_deferred and no pr_url', () => {
    const out = render(prDeferredSectionView(deferredRun));
    expect(out).toContain('pr-deferred-badge');
    expect(out).toContain('warning');
    expect(out).toContain('deferred');
  });

  it('shows Create PR button with action-btn primary classes', () => {
    const out = render(prDeferredSectionView(deferredRun));
    expect(out).toContain('action-btn');
    expect(out).toContain('action-btn--primary');
    expect(out).toContain('Create PR');
  });

  it('returns empty when pr_url is set on run.pr.url', () => {
    const run = {
      ...deferredRun,
      pr: { url: 'https://github.com/org/repo/pull/1' },
    };
    const out = render(prDeferredSectionView(run));
    expect(out).not.toContain('pr-deferred-badge');
    expect(out).not.toContain('Create PR');
  });

  it('returns empty when pr_url is set on run.pr_url', () => {
    const run = {
      ...deferredRun,
      pr_url: 'https://github.com/org/repo/pull/2',
    };
    const out = render(prDeferredSectionView(run));
    expect(out).not.toContain('pr-deferred-badge');
  });

  it('returns empty when pr_deferred is false', () => {
    const run = { id: 'run-not-deferred', pr_deferred: false };
    const out = render(prDeferredSectionView(run));
    expect(out).not.toContain('pr-deferred-badge');
    expect(out).not.toContain('Create PR');
  });

  it('returns empty when pr_deferred is absent', () => {
    const run = { id: 'run-no-deferred' };
    const out = render(prDeferredSectionView(run));
    expect(out).not.toContain('pr-deferred-badge');
  });
});

describe('prDeferredSectionView - after a successful create (stale run)', () => {
  function render(template) {
    return renderToString(template);
  }

  it('hides the Create PR button once created client-side, even with a stale run', () => {
    const run = { id: 'run-created-1', pr_deferred: true };
    _prCreationState.set(run.id, {
      inFlight: false,
      error: null,
      created: true,
      createdPrUrl: 'https://github.com/org/repo/pull/7',
    });
    const out = render(prDeferredSectionView(run));
    // The button must NOT come back — repeat clicks would open a duplicate PR.
    expect(out).not.toContain('Create PR');
    expect(out).toContain('PR created');
    expect(out).toContain('https://github.com/org/repo/pull/7');
    expect(out).toContain('View PR');
    _prCreationState.delete(run.id);
  });

  it('hides the button when created even if the PR url could not be parsed', () => {
    const run = { id: 'run-created-2', pr_deferred: true };
    _prCreationState.set(run.id, {
      inFlight: false,
      error: null,
      created: true,
      createdPrUrl: '',
    });
    const out = render(prDeferredSectionView(run));
    expect(out).not.toContain('Create PR');
    expect(out).toContain('PR created');
    _prCreationState.delete(run.id);
  });

  it('server-refreshed pr_url takes over and the section steps aside', () => {
    const run = {
      id: 'run-created-3',
      pr_deferred: true,
      pr_url: 'https://github.com/org/repo/pull/8',
    };
    _prCreationState.set(run.id, { inFlight: false, created: true });
    const out = render(prDeferredSectionView(run));
    // Authoritative pr_url present → whole section returns nothing.
    expect(out).not.toContain('PR created');
    expect(out).not.toContain('Create PR');
    _prCreationState.delete(run.id);
  });

  it('click handler marks created on a successful POST', async () => {
    const run = { id: 'run-created-4', pr_deferred: true };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ pr_url: 'https://github.com/org/repo/pull/9' }),
    });
    const handler = _createPrClickHandler(run, () => {}, {});
    await handler();
    const state = _prCreationState.get(run.id);
    expect(state.created).toBe(true);
    expect(state.inFlight).toBe(false);
    expect(state.createdPrUrl).toBe('https://github.com/org/repo/pull/9');
    fetchSpy.mockRestore();
    _prCreationState.delete(run.id);
  });
});

describe('prDeferredSectionView - in_progress state', () => {
  function render(template) {
    return renderToString(template);
  }

  it('shows disabled Creating PR button when pr_creation.state is in_progress', () => {
    const run = {
      id: 'run-inprogress-1',
      pr_deferred: true,
      pr_creation: { state: 'in_progress', started_at: '2026-06-04T10:00:00Z' },
    };
    const out = render(prDeferredSectionView(run));
    expect(out).toContain('Creating PR');
    expect(out).toContain('disabled');
  });

  it('still shows deferred badge in in_progress state', () => {
    const run = {
      id: 'run-inprogress-2',
      pr_deferred: true,
      pr_creation: { state: 'in_progress', started_at: '2026-06-04T10:00:00Z' },
    };
    const out = render(prDeferredSectionView(run));
    expect(out).toContain('pr-deferred-badge');
    expect(out).toContain('warning');
  });
});

describe('prDeferredSectionView - failed state', () => {
  function render(template) {
    return renderToString(template);
  }

  it('shows Retry button when pr_creation.state is failed', () => {
    const run = {
      id: 'run-failed-1',
      pr_deferred: true,
      pr_creation: { state: 'failed', error: 'gh: command not found' },
    };
    const out = render(prDeferredSectionView(run));
    expect(out).toContain('Retry');
    expect(out).toContain('action-btn--primary');
  });

  it('shows error message when pr_creation.state is failed', () => {
    const run = {
      id: 'run-failed-2',
      pr_deferred: true,
      pr_creation: { state: 'failed', error: 'gh: command not found' },
    };
    const out = render(prDeferredSectionView(run));
    expect(out).toContain('gh: command not found');
    expect(out).toContain('pr-deferred-error');
  });

  it('still shows deferred badge in failed state', () => {
    const run = {
      id: 'run-failed-3',
      pr_deferred: true,
      pr_creation: { state: 'failed', error: 'some error' },
    };
    const out = render(prDeferredSectionView(run));
    expect(out).toContain('pr-deferred-badge');
    expect(out).toContain('warning');
  });
});
