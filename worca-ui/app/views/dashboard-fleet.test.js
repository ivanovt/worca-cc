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

const fleetRun1 = {
  id: 'fleet-r1',
  fleet_id: 'f_abc',
  group_type: 'fleet',
  pipeline_status: 'running',
  active: true,
  started_at: '2026-04-01T10:00:00Z',
  work_request: { title: 'Migrate all repos' },
  stages: {},
};

const fleetRun2 = {
  id: 'fleet-r2',
  fleet_id: 'f_abc',
  group_type: 'fleet',
  pipeline_status: 'running',
  active: true,
  started_at: '2026-04-01T10:01:00Z',
  work_request: { title: 'Migrate all repos' },
  stages: {},
};

const standaloneRun = {
  id: 'solo-r3',
  pipeline_status: 'running',
  active: true,
  started_at: '2026-04-01T09:00:00Z',
  work_request: { title: 'Solo Task' },
  stages: {},
};

// ─── Fleet grouping in Active Runs ───────────────────────────────────────────

describe('dashboardView - fleet grouping', () => {
  it('renders fleet-group container for fleet runs', () => {
    const state = { runs: { 'fleet-r1': fleetRun1, 'fleet-r2': fleetRun2 } };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-group');
    expect(output).toContain('data-fleet-id="f_abc"');
  });

  it('renders standalone run as regular run-card (not inside fleet-group)', () => {
    const state = {
      runs: {
        'fleet-r1': fleetRun1,
        'fleet-r2': fleetRun2,
        'solo-r3': standaloneRun,
      },
    };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-group');
    expect(output).toContain('Solo Task');
    // At least one run-card exists for solo task
    expect(output).toContain('run-card');
  });

  it('renders fleet header title from work_request.title', () => {
    const state = { runs: { 'fleet-r1': fleetRun1, 'fleet-r2': fleetRun2 } };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Migrate all repos');
    expect(output).toContain('fleet-title');
  });

  it('renders fleet-progress showing N/M completed', () => {
    const state = { runs: { 'fleet-r1': fleetRun1, 'fleet-r2': fleetRun2 } };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-progress');
    // Both running, 0 completed out of 2
    expect(output).toContain('0/2 completed');
  });

  it('renders fleet-progress-bar', () => {
    const state = { runs: { 'fleet-r1': fleetRun1, 'fleet-r2': fleetRun2 } };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-progress-bar');
  });

  it('renders fleet-status-badge', () => {
    const state = { runs: { 'fleet-r1': fleetRun1, 'fleet-r2': fleetRun2 } };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('fleet-status-badge');
  });

  it('renders child run cards inside fleet-children when expanded', () => {
    const state = { runs: { 'fleet-r1': fleetRun1, 'fleet-r2': fleetRun2 } };
    const output = renderToString(dashboardView(state));
    // Fleet runs are running → default expanded
    expect(output).toContain('fleet-children');
  });

  it('groups only runs with group_type fleet — workspace runs stay standalone', () => {
    const workspaceRun = {
      id: 'ws-r1',
      fleet_id: 'f_abc',
      group_type: 'workspace',
      pipeline_status: 'running',
      active: true,
      started_at: '2026-04-01T10:00:00Z',
      work_request: { title: 'Workspace Task' },
      stages: {},
    };
    const state = { runs: { 'ws-r1': workspaceRun } };
    const output = renderToString(dashboardView(state));
    // workspace run must NOT be wrapped in fleet-group
    expect(output).not.toContain('fleet-group');
  });

  it('does not render fleet-group when no fleet runs present', () => {
    const state = { runs: { 'solo-r3': standaloneRun } };
    const output = renderToString(dashboardView(state));
    expect(output).not.toContain('fleet-group');
  });
});

// ─── Fleet grouping with mixed status ─────────────────────────────────────────

describe('dashboardView - fleet grouping across sections', () => {
  it('groups completed fleet children under fleet header in Recent Completed', () => {
    const completedFleet1 = {
      id: 'fc1',
      fleet_id: 'f_xyz',
      group_type: 'fleet',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-04-01T10:00:00Z',
      work_request: { title: 'Fleet Complete Task' },
      stages: {},
    };
    const completedFleet2 = {
      id: 'fc2',
      fleet_id: 'f_xyz',
      group_type: 'fleet',
      pipeline_status: 'completed',
      active: false,
      started_at: '2026-04-01T10:01:00Z',
      work_request: { title: 'Fleet Complete Task' },
      stages: {},
    };
    const state = { runs: { fc1: completedFleet1, fc2: completedFleet2 } };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Completed');
    expect(output).toContain('fleet-group');
    expect(output).toContain('data-fleet-id="f_xyz"');
  });

  it('groups failed fleet children under fleet header in Recent Failures', () => {
    const failedFleet1 = {
      id: 'ff1',
      fleet_id: 'f_fail',
      group_type: 'fleet',
      pipeline_status: 'failed',
      active: false,
      started_at: '2026-04-01T10:00:00Z',
      work_request: { title: 'Fleet Fail Task' },
      stages: {},
    };
    const failedFleet2 = {
      id: 'ff2',
      fleet_id: 'f_fail',
      group_type: 'fleet',
      pipeline_status: 'failed',
      active: false,
      started_at: '2026-04-01T10:01:00Z',
      work_request: { title: 'Fleet Fail Task' },
      stages: {},
    };
    const state = { runs: { ff1: failedFleet1, ff2: failedFleet2 } };
    const output = renderToString(dashboardView(state));
    expect(output).toContain('Recent Failures');
    expect(output).toContain('fleet-group');
    expect(output).toContain('data-fleet-id="f_fail"');
  });
});
