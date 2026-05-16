import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetWorkspaceDetailState,
  workspaceDetailView,
} from './workspace-detail.js';

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
    }
  });
  return result;
}

const BASE_WORKSPACE = {
  workspace_id: 'ws_202605150900_abc12345',
  workspace_id_short: 'abc12345',
  name: 'auth-migration',
  status: 'running',
  halt_reason: null,
  created_at: '2026-05-15T09:00:00.000Z',
  updated_at: '2026-05-15T09:30:00.000Z',
  work_request: {
    title: 'Migrate auth to v2',
    description: 'Coordinated migration across backend, lib, and frontend.',
  },
  dag: {
    projects: [
      { name: 'shared-lib', depends_on: [], status: 'completed', tier: 0 },
      {
        name: 'backend',
        depends_on: ['shared-lib'],
        status: 'running',
        tier: 1,
      },
      {
        name: 'frontend',
        depends_on: ['backend', 'shared-lib'],
        status: 'pending',
        tier: 2,
      },
    ],
  },
  tiers: [
    { tier: 0, status: 'completed', repos: ['shared-lib'] },
    { tier: 1, status: 'running', repos: ['backend'] },
    { tier: 2, status: 'pending', repos: ['frontend'] },
  ],
  workspace_plan:
    '## Plan\n\n1. Update shared-lib types\n2. Add backend endpoint\n3. Wire frontend',
  context_artifacts: {
    'shared-lib→backend':
      '### shared-lib changes\n\n- Added `AuthToken` type export',
    'shared-lib→frontend':
      '### shared-lib changes\n\n- Added `AuthToken` type export',
  },
  integration: {
    enabled: true,
    command: 'npm run test:integration',
    cwd: '/repos',
    status: null,
  },
  children: [
    {
      project_path: '/repos/shared-lib',
      run_id: 'run-sl-1',
      repo_name: 'shared-lib',
      status: 'completed',
      pr_url: 'https://github.com/org/shared-lib/pull/10',
      pr_number: 10,
      pr_status: 'open',
      dep_annotations: [
        { type: 'blocks', target: 'org/backend#5' },
        { type: 'blocks', target: 'org/frontend#20' },
      ],
      stages: {
        planner: { iterations: [{ cost_usd: 0.05 }] },
        implementer: { iterations: [{ cost_usd: 0.12 }] },
      },
    },
    {
      project_path: '/repos/backend',
      run_id: 'run-be-1',
      repo_name: 'backend',
      status: 'running',
      pr_url: null,
      pr_number: null,
      pr_status: null,
      dep_annotations: [
        { type: 'depends_on', target: 'org/shared-lib#10' },
        { type: 'blocks', target: 'org/frontend#20' },
      ],
      stages: {
        planner: { iterations: [{ cost_usd: 0.04 }] },
      },
    },
    {
      project_path: '/repos/frontend',
      run_id: 'run-fe-1',
      repo_name: 'frontend',
      status: 'pending',
      pr_url: null,
      pr_number: null,
      pr_status: null,
      dep_annotations: [
        { type: 'depends_on', target: 'org/shared-lib#10' },
        { type: 'depends_on', target: 'org/backend#5' },
      ],
      stages: {},
    },
  ],
  master_planner_cost: { cost_usd: 0.08 },
  umbrella_issue_url: 'https://github.com/org/meta/issues/99',
  workspace_json_name: 'auth-migration',
  circuit_breaker: null,
};

// ─── loading / missing / empty states ────────────────────────────────────────

describe('workspaceDetailView — null workspace', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('renders loading state when workspace is null and not flagged missing', () => {
    const out = renderToString(workspaceDetailView(null, {}));
    expect(out).toContain('workspace-detail-loading');
    expect(out).not.toContain('workspace-detail-empty');
  });

  it('renders empty state when workspace is missing (404)', () => {
    const out = renderToString(
      workspaceDetailView(null, {
        missing: true,
        workspaceId: 'ws_202605150900_deadbeef',
      }),
    );
    expect(out).toContain('workspace-detail-empty');
    expect(out).toContain('Workspace not found');
    expect(out).not.toContain('workspace-detail-loading');
  });

  it('empty state includes the workspace id when provided', () => {
    const out = renderToString(
      workspaceDetailView(null, {
        missing: true,
        workspaceId: 'ws_202605150900_deadbeef',
      }),
    );
    expect(out).toContain('ws_202605150900_deadbeef');
  });

  it('empty state links back to history', () => {
    const out = renderToString(workspaceDetailView(null, { missing: true }));
    expect(out).toContain('#/history');
  });
});

// ─── header strip ────────────────────────────────────────────────────────────

describe('workspaceDetailView — header strip', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('renders the workspace name in the overview', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('auth-migration');
  });

  it('embeds workspace_id on the overview wrapper', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain(`data-workspace-id="${BASE_WORKSPACE.workspace_id}"`);
  });

  it('renders the workspace ID label + chip', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('>Workspace ID:<');
    // Reuses the shared `.fleet-id-chip` styling so the workspace and
    // fleet hero pages display the id identically.
    expect(out).toContain('fleet-id-chip');
  });

  it('renders tier progress', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('>Tiers:<');
    expect(out).toContain('1 / 3');
  });

  it('renders timing meta (Started / Duration)', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('>Started:<');
    expect(out).toContain('>Duration:<');
  });

  it('renders cost on the overview strip', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('>Cost:<');
  });

  it('renders edit workspace.json link', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('edit-workspace-json');
    expect(out).toContain('#/workspaces/auth-migration/edit');
  });

  it('does not render the breadcrumb (sidebar nav is the breadcrumb — matches fleet/run detail)', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).not.toContain('workspace-breadcrumb');
  });
});

// ─── DAG panel ───────────────────────────────────────────────────────────────

describe('workspaceDetailView — DAG panel', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('renders the DAG visualization section', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('workspace-dag-panel');
  });

  it('embeds SVG container from dagGraphView', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('workspace-dag-svg');
  });

  it('passes dag data into the dag panel', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('Dependency Graph');
    expect(out).toContain('workspace-dag-panel');
  });

  it('does not render DAG panel when dag is null', () => {
    const ws = { ...BASE_WORKSPACE, dag: null };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).not.toContain('workspace-dag-panel');
  });
});

// ─── workspace plan panel ────────────────────────────────────────────────────

describe('workspaceDetailView — workspace plan panel', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('renders the workspace plan section', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('workspace-plan-panel');
    expect(out).toContain('Workspace Plan');
  });

  it('mounts the View plan dialog with a markdown-body container', () => {
    // The plan content lives inside an sl-dialog body rendered via the
    // unsafeHTML directive (after passing through marked). The test
    // string-renderer doesn't dive into directives, so we assert on the
    // wrapper classes that signal the modal is wired correctly; the
    // actual rendered markdown is covered by Playwright verification.
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('plan-edit-dialog');
    expect(out).toContain('markdown-body');
    expect(out).toContain('btn-view-plan');
  });

  it('hides edit plan button when status is running', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).not.toContain('btn-edit-plan');
  });

  it('shows edit plan button when status is halted', () => {
    const ws = { ...BASE_WORKSPACE, status: 'halted' };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('btn-edit-plan');
  });

  it('shows edit plan button when status is failed', () => {
    const ws = { ...BASE_WORKSPACE, status: 'failed' };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('btn-edit-plan');
  });

  it('shows edit plan button when status is integration_failed', () => {
    const ws = { ...BASE_WORKSPACE, status: 'integration_failed' };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('btn-edit-plan');
  });

  it('renders edit plan dialog', () => {
    const ws = { ...BASE_WORKSPACE, status: 'halted' };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('plan-edit-dialog');
  });

  it('shows "No plan" hint when workspace_plan is empty', () => {
    const ws = { ...BASE_WORKSPACE, workspace_plan: null };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('No workspace plan');
  });
});

// ─── context artifacts panel ─────────────────────────────────────────────────

describe('workspaceDetailView — context artifacts panel', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('renders context artifacts section', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('context-artifacts-panel');
    expect(out).toContain('Context Artifacts');
  });

  it('renders one tab per dependency edge', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('shared-lib');
    expect(out).toContain('backend');
  });

  it('hides context artifacts section when none exist', () => {
    const ws = { ...BASE_WORKSPACE, context_artifacts: {} };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).not.toContain('context-artifacts-panel');
  });

  it('hides context artifacts section when null', () => {
    const ws = { ...BASE_WORKSPACE, context_artifacts: null };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).not.toContain('context-artifacts-panel');
  });
});

// ─── cost (inline in hero + standalone aggregate-cost panel) ──────────────

describe('workspaceDetailView — cost (inline + panel)', () => {
  // After the fleet-detail alignment, cost shows in TWO places: the hero
  // meta strip (next to Started / Duration) AND a dedicated AGGREGATE
  // COST panel at the bottom — matches fleet-detail exactly.
  beforeEach(() => resetWorkspaceDetailState());

  it('renders the standalone aggregate-cost panel (matches fleet)', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('workspace-aggregate-cost');
  });

  it('shows total cost in the hero meta strip', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('>Cost:<');
    // shared-lib: 0.05+0.12=0.17, backend: 0.04, frontend: 0, master: 0.08 → 0.29
    expect(out).toContain('$0.29');
  });

  it('shows zero cost when no stages', () => {
    const ws = {
      ...BASE_WORKSPACE,
      children: [],
      master_planner_cost: null,
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('$0.00');
  });

  it('formats sub-cent cost with 4 decimal places', () => {
    const ws = {
      ...BASE_WORKSPACE,
      children: [
        {
          ...BASE_WORKSPACE.children[0],
          stages: { planner: { iterations: [{ cost_usd: 0.001 }] } },
        },
      ],
      master_planner_cost: null,
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('$0.0010');
  });
});

// ─── integration test panel ──────────────────────────────────────────────────

describe('workspaceDetailView — integration test panel', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('renders integration test section when integration is enabled', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('integration-test-panel');
    expect(out).toContain('Integration Test');
  });

  it('shows the integration command', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('npm run test:integration');
  });

  it('hides integration section when not configured', () => {
    const ws = {
      ...BASE_WORKSPACE,
      integration: { enabled: false },
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).not.toContain('integration-test-panel');
  });

  it('hides integration section when integration is null', () => {
    const ws = { ...BASE_WORKSPACE, integration: null };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).not.toContain('integration-test-panel');
  });

  it('shows re-run button when status is integration_failed', () => {
    const ws = {
      ...BASE_WORKSPACE,
      status: 'integration_failed',
      integration: { ...BASE_WORKSPACE.integration, status: 'failed' },
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('btn-rerun-integration');
  });

  it('shows re-run button when status is completed', () => {
    const ws = {
      ...BASE_WORKSPACE,
      status: 'completed',
      integration: { ...BASE_WORKSPACE.integration, status: 'passed' },
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('btn-rerun-integration');
  });

  it('hides re-run button when status is running', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).not.toContain('btn-rerun-integration');
  });
});

// ─── PR table ────────────────────────────────────────────────────────────────

describe('workspaceDetailView — Repos section (replaces PR table)', () => {
  // The previous 4-column PR table was replaced with the same Repos
  // listing fleet-detail uses for "Projects" — each child renders as a
  // rich runCardView (or a placeholder when the matching Run object
  // hasn't loaded yet). PR URLs / dependency annotations move into the
  // run card itself, so they're no longer tested as table cells here.
  beforeEach(() => resetWorkspaceDetailState());

  it('renders the Repos section with per-child cards', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('workspace-children-section');
    expect(out).toContain('Repos');
  });

  it('headline reflects the child count', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    // 3 children in BASE_WORKSPACE
    expect(out).toMatch(/Repos\s*·\s*3 repos/);
  });

  it('renders one row per child repo (by name)', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('shared-lib');
    expect(out).toContain('backend');
    expect(out).toContain('frontend');
  });

  it('shows "Copy all PR URLs" button when every child has a PR URL', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('btn-copy-all-pr-urls');
  });

  it('hides "Copy all PR URLs" button when no children have PRs', () => {
    const ws = {
      ...BASE_WORKSPACE,
      children: BASE_WORKSPACE.children.map((c) => ({
        ...c,
        pr_url: null,
      })),
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).not.toContain('btn-copy-all-pr-urls');
  });

  it('shows umbrella issue link when present', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('umbrella-issue-link');
    expect(out).toContain('https://github.com/org/meta/issues/99');
  });

  it('hides umbrella issue link when not present', () => {
    const ws = { ...BASE_WORKSPACE, umbrella_issue_url: null };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).not.toContain('umbrella-issue-link');
  });

  it('renders a placeholder card for children with no matching Run', () => {
    // BASE_WORKSPACE has no runsById passed, so every child falls to the
    // placeholder branch — exercises the missing-run path.
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('fleet-child-card-placeholder');
  });
});

// ─── actions moved to page-header bar ────────────────────────────────────────

describe('workspaceDetailView — body has no action affordances', () => {
  // Resume / Cleanup / Re-run buttons + their confirm dialogs were moved
  // to the page-header bar (driven by main.js' contentHeaderView for
  // workspace-runs/:id), parallel to the fleet detail page. The body no
  // longer carries any of them — these negative assertions lock that in
  // so the duplication can't reappear by accident.
  beforeEach(() => resetWorkspaceDetailState());

  for (const status of [
    'running',
    'planning',
    'integration_testing',
    'completed',
    'failed',
    'integration_failed',
    'halted',
  ]) {
    it(`emits no in-body action buttons for status="${status}"`, () => {
      const ws = { ...BASE_WORKSPACE, status };
      const out = renderToString(workspaceDetailView(ws, {}));
      expect(out).not.toContain('workspace-actions');
      expect(out).not.toContain('class="btn-halt"');
      expect(out).not.toContain('class="btn-resume"');
      expect(out).not.toContain('class="btn-cleanup"');
      // `btn-rerun` is a substring of `btn-rerun-integration` (the
      // integration-test panel's button, which stays in the body), so
      // anchor to the exact workspace re-run class.
      expect(out).not.toContain('class="btn-rerun"');
      expect(out).not.toContain('halt-confirm-dialog');
      expect(out).not.toContain('cleanup-confirm-dialog');
    });
  }
});

// ─── circuit breaker + user halt alerts ──────────────────────────────────────

describe('workspaceDetailView — halt alerts', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('shows circuit breaker alert when halted by circuit breaker', () => {
    const ws = {
      ...BASE_WORKSPACE,
      status: 'halted',
      halt_reason: 'circuit_breaker',
      circuit_breaker: {
        unstarted_count: 2,
        trip_reason: 'failure_threshold exceeded',
      },
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('workspace-circuit-breaker-alert');
    expect(out).toContain('Circuit breaker tripped');
  });

  it('shows user halt alert when halted by user', () => {
    const ws = {
      ...BASE_WORKSPACE,
      status: 'halted',
      halt_reason: 'user',
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('workspace-user-halt-alert');
    expect(out).toContain('Halted by operator');
  });

  it('does not show halt alerts when running', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).not.toContain('workspace-circuit-breaker-alert');
    expect(out).not.toContain('workspace-user-halt-alert');
  });
});

// ─── guide conflicts aggregate ──────────────────────────────────────────────

describe('workspaceDetailView — guide conflicts aggregate', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('shows aggregated conflict count in header when children have guide_conflicts', () => {
    const ws = {
      ...BASE_WORKSPACE,
      children: [
        {
          ...BASE_WORKSPACE.children[0],
          guide_conflicts: [
            { stage: 'plan', message: 'Conflict A', source: 'description' },
          ],
        },
        {
          ...BASE_WORKSPACE.children[1],
          guide_conflicts: [
            { stage: 'review', message: 'Conflict B', source: 'plan' },
            { stage: 'test', message: 'Conflict C', source: 'plan' },
          ],
        },
        BASE_WORKSPACE.children[2],
      ],
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('guide-conflicts-aggregate');
    expect(out).toContain('3 guide conflicts across children');
  });

  it('does not show conflict aggregate when no children have guide_conflicts', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).not.toContain('guide-conflicts-aggregate');
  });

  it('does not show conflict aggregate when all guide_conflicts arrays are empty', () => {
    const ws = {
      ...BASE_WORKSPACE,
      children: BASE_WORKSPACE.children.map((c) => ({
        ...c,
        guide_conflicts: [],
      })),
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).not.toContain('guide-conflicts-aggregate');
  });

  it('groups conflicts by repo name', () => {
    const ws = {
      ...BASE_WORKSPACE,
      children: [
        {
          ...BASE_WORKSPACE.children[0],
          guide_conflicts: [
            { stage: 'plan', message: 'Conflict A', source: 'description' },
          ],
        },
        {
          ...BASE_WORKSPACE.children[1],
          guide_conflicts: [
            { stage: 'review', message: 'Conflict B', source: 'plan' },
          ],
        },
        BASE_WORKSPACE.children[2],
      ],
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('shared-lib');
    expect(out).toContain('backend');
  });

  it('shows singular text for 1 conflict', () => {
    const ws = {
      ...BASE_WORKSPACE,
      children: [
        {
          ...BASE_WORKSPACE.children[0],
          guide_conflicts: [
            { stage: 'plan', message: 'Conflict A', source: 'description' },
          ],
        },
        BASE_WORKSPACE.children[1],
        BASE_WORKSPACE.children[2],
      ],
    };
    const out = renderToString(workspaceDetailView(ws, {}));
    expect(out).toContain('1 guide conflict across children');
  });
});

// ─── work request section ────────────────────────────────────────────────────

describe('workspaceDetailView — work request', () => {
  beforeEach(() => resetWorkspaceDetailState());

  it('renders work request section', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('Work Request');
    expect(out).toContain('workspace-wr-title');
  });

  it('shows work request title', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain('Migrate auth to v2');
  });

  it('shows work request description', () => {
    const out = renderToString(workspaceDetailView(BASE_WORKSPACE, {}));
    expect(out).toContain(
      'Coordinated migration across backend, lib, and frontend.',
    );
  });
});
