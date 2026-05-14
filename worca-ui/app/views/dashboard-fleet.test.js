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

// Fleet records as they arrive in `state.fleets` (server payload shape
// from GET /api/fleet-runs). The dashboard now consumes `state.fleets`
// directly — same source as the /#/fleet-runs list view and the fleet
// detail page — so both pages render the *same* fleet card from the
// *same* data. No more client-side grouping by `run.fleet_id`.
const runningFleet = {
  fleet_id: 'f_abc',
  fleet_id_short: 'abc',
  work_request: { title: 'Migrate all repos' },
  status: 'running',
  halt_reason: null,
  children_count: 2,
  children: [
    { project_path: '/repos/a', run_id: 'fleet-r1', status: 'running' },
    { project_path: '/repos/b', run_id: 'fleet-r2', status: 'running' },
  ],
  head_template: 'migration/{slug}/{project}',
  base_branch: 'main',
  plan: { mode: 'none' },
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-01T10:01:00Z',
  last_activity_at: '2026-04-01T10:01:00Z',
  cost_usd: 0,
};

const completedFleet = {
  fleet_id: 'f_xyz',
  fleet_id_short: 'xyz',
  work_request: { title: 'Fleet Complete Task' },
  status: 'completed',
  halt_reason: null,
  children_count: 2,
  children: [
    { project_path: '/repos/a', run_id: 'fc1', status: 'completed' },
    { project_path: '/repos/b', run_id: 'fc2', status: 'completed' },
  ],
  head_template: 'migration/{slug}/{project}',
  base_branch: 'main',
  plan: { mode: 'none' },
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-01T10:01:00Z',
  last_activity_at: '2026-04-01T10:01:00Z',
  cost_usd: 0,
};

const failedFleet = {
  fleet_id: 'f_fail',
  fleet_id_short: 'fail',
  work_request: { title: 'Fleet Fail Task' },
  status: 'failed',
  halt_reason: null,
  children_count: 2,
  children: [
    { project_path: '/repos/a', run_id: 'ff1', status: 'failed' },
    { project_path: '/repos/b', run_id: 'ff2', status: 'failed' },
  ],
  head_template: 'migration/{slug}/{project}',
  base_branch: 'main',
  plan: { mode: 'none' },
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-01T10:01:00Z',
  last_activity_at: '2026-04-01T10:01:00Z',
  cost_usd: 0,
};

const standaloneRun = {
  id: 'solo-r3',
  pipeline_status: 'running',
  active: true,
  started_at: '2026-04-01T09:00:00Z',
  work_request: { title: 'Solo Task' },
  stages: {},
};

// ─── Fleet rendering in Active Runs (sourced from state.fleets) ─────────────

describe('dashboardView - fleet rendering', () => {
  it('renders a fleet card for each entry in state.fleets', () => {
    const state = { runs: {}, fleets: [runningFleet] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-card');
    expect(output).toContain('data-fleet-id="f_abc"');
    // Legacy fleet-group wrapper must not render — runs that belong to a
    // known fleet are NOT also rendered as standalone pipeline cards.
    expect(output).not.toContain('class="fleet-group');
  });

  it('renders standalone runs as regular run-cards alongside fleet cards', () => {
    const state = {
      runs: { 'solo-r3': standaloneRun },
      fleets: [runningFleet],
    };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-card');
    expect(output).toContain('Solo Task');
    expect(output).toContain('run-card');
  });

  it('does NOT render fleet-children as standalone run-cards when the fleet is known', () => {
    // The fleet card represents these runs via the children strip; listing
    // them again as standalone cards would be double-rendering.
    const childRun = {
      id: 'fleet-r1',
      fleet_id: 'f_abc',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-04-01T10:00:00Z',
      work_request: { title: 'Child run' },
      stages: {},
    };
    const state = {
      runs: { 'fleet-r1': childRun },
      fleets: [runningFleet],
    };
    const output = renderToString(dashboardView(state));
    expect(output).not.toContain('>Child run<');
  });

  it('uses work_request.title as the fleet-card title', () => {
    const state = { runs: {}, fleets: [runningFleet] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Migrate all repos');
    expect(output).toContain('fleet-card-title');
  });

  it('renders the fleet-card status badge', () => {
    const state = { runs: {}, fleets: [runningFleet] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-card-status-badge');
  });

  it('renders the "Projects:" row with one name badge per child', () => {
    // The segmented progress bar + "N/M completed" text were removed —
    // the Projects row now carries up to 3 neutral name badges (plus a
    // "+N more" chip when there are more than 3).
    const state = { runs: {}, fleets: [runningFleet] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-card-progress');
    const badgeCount = (output.match(/fleet-card-project-badge/g) || []).length;
    expect(badgeCount).toBe(2); // runningFleet has 2 children
  });

  it('does not render a fleet card when state.fleets is empty', () => {
    const state = { runs: { 'solo-r3': standaloneRun }, fleets: [] };
    const output = renderToString(dashboardView(state));
    expect(output).not.toContain('fleet-card');
  });
});

// ─── Fleet card placement across dashboard sections ───────────────────────────

describe('dashboardView - fleet card across sections', () => {
  it('renders a completed fleet card in Recent Completed', () => {
    const state = { runs: {}, fleets: [completedFleet] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Completed');
    expect(output).toContain('fleet-card');
    expect(output).toContain('data-fleet-id="f_xyz"');
  });

  it('renders a failed fleet card in Recent Failures', () => {
    const state = { runs: {}, fleets: [failedFleet] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Failures');
    expect(output).toContain('fleet-card');
    expect(output).toContain('data-fleet-id="f_fail"');
  });

  // Halted fleets used to land in Active because the manifest treats them
  // as "resumable, not terminal." But nothing is *running* in a halted
  // fleet, so Active misled. Now the dashboard routes by `halt_reason`:
  // user-halted → Paused (you stopped it, you can resume), every other
  // halt → Failures (auto-stopped because something went wrong).

  it('routes a user-halted fleet to the Paused section', () => {
    const userHalted = {
      ...runningFleet,
      fleet_id: 'f_user_halt',
      status: 'halted',
      halt_reason: 'user',
    };
    const state = { runs: {}, fleets: [userHalted] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Paused');
    expect(output).toContain('data-fleet-id="f_user_halt"');
    // The Active section must show its empty state — the halted fleet
    // belongs to Paused, not Active.
    expect(output).toContain('No active pipelines');
  });

  it('routes a circuit-breaker halted fleet to the Failures section', () => {
    const cbHalted = {
      ...runningFleet,
      fleet_id: 'f_cb_halt',
      status: 'halted',
      halt_reason: 'circuit_breaker',
    };
    const state = { runs: {}, fleets: [cbHalted] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Failures');
    expect(output).toContain('data-fleet-id="f_cb_halt"');
    expect(output).toContain('No active pipelines');
  });

  it('routes a targets-not-ready halted fleet to the Failures section', () => {
    const tnrHalted = {
      ...runningFleet,
      fleet_id: 'f_tnr_halt',
      status: 'halted',
      halt_reason: 'targets_not_ready',
    };
    const state = { runs: {}, fleets: [tnrHalted] };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Failures');
    expect(output).toContain('data-fleet-id="f_tnr_halt"');
  });

  it('does not show the Active section as containing halted fleets', () => {
    const a = {
      ...runningFleet,
      fleet_id: 'f_a',
      status: 'halted',
      halt_reason: 'user',
    };
    const b = {
      ...runningFleet,
      fleet_id: 'f_b',
      status: 'halted',
      halt_reason: 'circuit_breaker',
    };
    const state = { runs: {}, fleets: [a, b] };
    const output = renderToString(dashboardView(state));
    // No active fleets/runs at all → empty-state shows under Active.
    expect(output).toContain('No active pipelines');
  });
});
