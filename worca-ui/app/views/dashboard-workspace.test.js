import { describe, expect, it } from 'vitest';
import { dashboardView } from './dashboard.js';

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

// ─── Workspace fixtures ──────────────────────────────────────────────────────

const runningWorkspace = {
  workspace_id: 'ws_202601011200_abc12345',
  workspace_name: 'mono-migration',
  status: 'running',
  halt_reason: null,
  group_type: 'workspace',
  dag: {
    tiers: [
      { tier: 0, repos: ['shared-lib'], status: 'completed' },
      { tier: 1, repos: ['backend'], status: 'completed' },
      { tier: 2, repos: ['frontend', 'admin-app'], status: 'running' },
    ],
  },
  children: [
    { repo: 'shared-lib', run_id: 'ws-r1', status: 'completed', tier: 0 },
    { repo: 'backend', run_id: 'ws-r2', status: 'completed', tier: 1 },
    { repo: 'frontend', run_id: 'ws-r3', status: 'running', tier: 2 },
    { repo: 'admin-app', run_id: 'ws-r4', status: 'running', tier: 2 },
  ],
  integration_test: null,
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-01T10:05:00Z',
  last_activity_at: '2026-04-01T10:05:00Z',
};

const completedWorkspace = {
  workspace_id: 'ws_202601011200_def67890',
  workspace_name: 'api-upgrade',
  status: 'completed',
  halt_reason: null,
  group_type: 'workspace',
  dag: {
    tiers: [
      { tier: 0, repos: ['types'], status: 'completed' },
      { tier: 1, repos: ['api'], status: 'completed' },
    ],
  },
  children: [
    { repo: 'types', run_id: 'ws-c1', status: 'completed', tier: 0 },
    { repo: 'api', run_id: 'ws-c2', status: 'completed', tier: 1 },
  ],
  integration_test: { status: 'passed', exit_code: 0 },
  created_at: '2026-03-01T10:00:00Z',
  updated_at: '2026-03-01T10:30:00Z',
  last_activity_at: '2026-03-01T10:30:00Z',
};

const failedWorkspace = {
  workspace_id: 'ws_202601011200_fail0001',
  workspace_name: 'broken-migration',
  status: 'failed',
  halt_reason: null,
  group_type: 'workspace',
  dag: {
    tiers: [
      { tier: 0, repos: ['lib-a'], status: 'completed' },
      { tier: 1, repos: ['service-b'], status: 'failed' },
    ],
  },
  children: [
    { repo: 'lib-a', run_id: 'ws-f1', status: 'completed', tier: 0 },
    { repo: 'service-b', run_id: 'ws-f2', status: 'failed', tier: 1 },
  ],
  integration_test: null,
  created_at: '2026-03-15T10:00:00Z',
  updated_at: '2026-03-15T10:20:00Z',
  last_activity_at: '2026-03-15T10:20:00Z',
};

const planningWorkspace = {
  workspace_id: 'ws_202601011200_plan0001',
  workspace_name: 'planning-ws',
  status: 'planning',
  halt_reason: null,
  group_type: 'workspace',
  dag: { tiers: [] },
  children: [],
  integration_test: null,
  created_at: '2026-04-02T10:00:00Z',
  updated_at: '2026-04-02T10:00:00Z',
  last_activity_at: '2026-04-02T10:00:00Z',
};

// ─── Workspace card rendering in Active Runs ─────────────────────────────────

describe('dashboardView - workspace rendering', () => {
  it('renders a workspace card for entries in state.workspaces', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('workspace-card');
    expect(output).toContain(
      `data-workspace-id="${runningWorkspace.workspace_id}"`,
    );
  });

  it('renders workspace name as card title', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('mono-migration');
  });

  it('renders a running workspace in the Active Runs section', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Active Runs');
    expect(output).toContain('workspace-card');
    expect(output).not.toContain('No active pipelines');
  });

  it('renders a planning workspace in the Active Runs section', () => {
    const state = { runs: {}, workspaces: [planningWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Active Runs');
    expect(output).toContain('workspace-card');
    expect(output).not.toContain('No active pipelines');
  });

  it('does not render workspace cards when state.workspaces is empty', () => {
    const state = { runs: {}, workspaces: [] };
    const output = renderToString(dashboardView(state));
    expect(output).not.toContain('workspace-card');
  });

  it('does not render workspace cards when state.workspaces is absent', () => {
    const state = { runs: {} };
    const output = renderToString(dashboardView(state));
    expect(output).not.toContain('workspace-card');
  });
});

// ─── Workspace tier rendering ────────────────────────────────────────────────

describe('dashboardView - workspace tier grouping', () => {
  it('renders tier labels for each tier in the DAG', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('tier-label');
    expect(output).toContain('Tier 0');
    expect(output).toContain('Tier 1');
    expect(output).toContain('Tier 2');
  });

  it('renders children grouped under their tier', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    // shared-lib is tier 0
    const sharedLibIdx = output.indexOf('shared-lib');
    const tier0Idx = output.indexOf('Tier 0');
    const tier1Idx = output.indexOf('Tier 1');
    expect(sharedLibIdx).toBeGreaterThan(tier0Idx);
    expect(sharedLibIdx).toBeLessThan(tier1Idx);
  });

  it('renders tier status badge per tier', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    // Each tier row should have a status indicator
    expect(output).toContain('tier-status');
  });

  it('renders child repo names with their status', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('shared-lib');
    expect(output).toContain('backend');
    expect(output).toContain('frontend');
    expect(output).toContain('admin-app');
  });

  it('renders workspace progress summary in header', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    // Should show tier progress (e.g., "tier 2 of 3") and child completion
    expect(output).toContain('2/4');
  });
});

// ─── Integration test pseudo-tier ────────────────────────────────────────────

describe('dashboardView - workspace integration test row', () => {
  it('renders integration test row when integration_test is configured', () => {
    const state = { runs: {}, workspaces: [completedWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('integration-test-row');
    expect(output).toContain('Integration test');
  });

  it('renders integration test status badge', () => {
    const state = { runs: {}, workspaces: [completedWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('passed');
  });

  it('does not render integration test row when not configured', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).not.toContain('integration-test-row');
  });

  it('renders pending integration test when tiers are still running', () => {
    const ws = {
      ...runningWorkspace,
      integration_test: { status: 'pending' },
    };
    const state = { runs: {}, workspaces: [ws] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('integration-test-row');
    expect(output).toContain('pending');
  });

  it('renders failed integration test status', () => {
    const ws = {
      ...completedWorkspace,
      workspace_id: 'ws_202601011200_intfail1',
      status: 'integration_failed',
      integration_test: { status: 'failed', exit_code: 1 },
    };
    const state = { runs: {}, workspaces: [ws] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('integration-test-row');
    expect(output).toContain('failed');
  });
});

// ─── Blocked children tooltips ───────────────────────────────────────────────

describe('dashboardView - workspace blocked children', () => {
  it('renders a blocked tooltip for blocked children', () => {
    const ws = {
      ...runningWorkspace,
      workspace_id: 'ws_202601011200_blk00001',
      status: 'running',
      dag: {
        tiers: [
          { tier: 0, repos: ['lib-core'], status: 'failed' },
          { tier: 1, repos: ['web-app'], status: 'blocked' },
        ],
      },
      children: [
        { repo: 'lib-core', run_id: 'br1', status: 'failed', tier: 0 },
        { repo: 'web-app', run_id: 'br2', status: 'blocked', tier: 1 },
      ],
    };
    const state = { runs: {}, workspaces: [ws] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('blocked');
    expect(output).toContain('title=');
    // Tooltip should reference the dependency that failed
    expect(output).toContain('lib-core');
  });
});

// ─── Workspace card placement across dashboard sections ──────────────────────

describe('dashboardView - workspace card section placement', () => {
  it('renders a completed workspace in Recent Completed', () => {
    const state = { runs: {}, workspaces: [completedWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Completed');
    expect(output).toContain('workspace-card');
    expect(output).toContain('No active pipelines');
  });

  it('renders a failed workspace in Recent Failures', () => {
    const state = { runs: {}, workspaces: [failedWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Failures');
    expect(output).toContain('workspace-card');
  });

  it('routes a user-halted workspace to the Paused section', () => {
    const haltedWs = {
      ...runningWorkspace,
      workspace_id: 'ws_202601011200_uh000001',
      status: 'halted',
      halt_reason: 'user',
    };
    const state = { runs: {}, workspaces: [haltedWs] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Paused');
    expect(output).toContain('workspace-card');
    expect(output).toContain('No active pipelines');
  });

  it('routes a circuit-breaker halted workspace to the Failures section', () => {
    const cbHalted = {
      ...runningWorkspace,
      workspace_id: 'ws_202601011200_cb000001',
      status: 'halted',
      halt_reason: 'circuit_breaker',
    };
    const state = { runs: {}, workspaces: [cbHalted] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Failures');
    expect(output).toContain('workspace-card');
  });

  it('renders an integration_failed workspace in Recent Failures', () => {
    const intFailedWs = {
      ...completedWorkspace,
      workspace_id: 'ws_202601011200_if000001',
      status: 'integration_failed',
      integration_test: { status: 'failed', exit_code: 1 },
    };
    const state = { runs: {}, workspaces: [intFailedWs] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Failures');
    expect(output).toContain('workspace-card');
  });

  it('renders integration_testing workspace in Active Runs', () => {
    const intTestingWs = {
      ...completedWorkspace,
      workspace_id: 'ws_202601011200_it000001',
      status: 'integration_testing',
      integration_test: { status: 'running' },
    };
    const state = { runs: {}, workspaces: [intTestingWs] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Active Runs');
    expect(output).not.toContain('No active pipelines');
    expect(output).toContain('workspace-card');
  });
});

// ─── Mixed rendering ─────────────────────────────────────────────────────────

describe('dashboardView - mixed fleet/workspace/standalone rendering', () => {
  const fleet = {
    fleet_id: 'f_mix',
    fleet_id_short: 'mix',
    work_request: { title: 'Fleet task' },
    status: 'running',
    halt_reason: null,
    children: [{ project_path: '/repos/a', run_id: 'fm1', status: 'running' }],
    created_at: '2026-04-01T10:00:00Z',
    updated_at: '2026-04-01T10:01:00Z',
    last_activity_at: '2026-04-01T10:01:00Z',
    cost_usd: 0,
  };

  const standalone = {
    id: 'solo-1',
    pipeline_status: 'running',
    active: true,
    started_at: '2026-04-01T09:00:00Z',
    work_request: { title: 'Solo task' },
  };

  it('renders fleet cards, workspace cards, and standalone cards together', () => {
    const state = {
      runs: { 'solo-1': standalone },
      fleets: [fleet],
      workspaces: [runningWorkspace],
    };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-card');
    expect(output).toContain('workspace-card');
    expect(output).toContain('run-card');
    expect(output).toContain('Solo task');
  });

  it('workspace child run_ids do not appear as standalone run cards', () => {
    const wsChildRun = {
      id: 'ws-r1',
      workspace_id: runningWorkspace.workspace_id,
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-04-01T10:00:00Z',
      work_request: { title: 'WS child standalone' },
    };
    const state = {
      runs: { 'ws-r1': wsChildRun },
      workspaces: [runningWorkspace],
    };
    const output = renderToString(dashboardView(state));
    // The workspace card represents these runs — no standalone duplicate
    expect(output).not.toContain('WS child standalone');
  });
});

// ─── Workspace navigation ────────────────────────────────────────────────────

describe('dashboardView - workspace card navigation', () => {
  it('workspace card has data-workspace-id for click navigation', () => {
    const state = { runs: {}, workspaces: [runningWorkspace] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain(
      `data-workspace-id="${runningWorkspace.workspace_id}"`,
    );
  });
});
