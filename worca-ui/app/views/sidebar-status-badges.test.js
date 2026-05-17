import { describe, expect, it, vi } from 'vitest';
import { projectStatus, sidebarView } from './sidebar.js';

describe('projectStatus', () => {
  it('returns idle when no runs exist', () => {
    expect(projectStatus('proj-1', {})).toBe('idle');
  });

  it('returns running when any run has pipeline_status running', () => {
    const runs = {
      r1: { pipeline_status: 'running', active: true },
    };
    expect(projectStatus('proj-1', runs)).toBe('running');
  });

  it('returns error when any run has pipeline_status failed', () => {
    const runs = {
      r1: { pipeline_status: 'failed', active: false },
    };
    expect(projectStatus('proj-1', runs)).toBe('error');
  });

  it('returns error when any run has pipeline_status error', () => {
    const runs = {
      r1: { pipeline_status: 'error', active: false },
    };
    expect(projectStatus('proj-1', runs)).toBe('error');
  });

  it('returns paused when any run has pipeline_status paused', () => {
    const runs = {
      r1: { pipeline_status: 'paused', active: false },
    };
    expect(projectStatus('proj-1', runs)).toBe('paused');
  });

  it('returns paused when any run has pipeline_status approval_needed', () => {
    const runs = {
      r1: { pipeline_status: 'approval_needed', active: false },
    };
    expect(projectStatus('proj-1', runs)).toBe('paused');
  });

  it('running takes priority over error and paused', () => {
    const runs = {
      r1: { pipeline_status: 'failed', active: false },
      r2: { pipeline_status: 'paused', active: false },
      r3: { pipeline_status: 'running', active: true },
    };
    expect(projectStatus('proj-1', runs)).toBe('running');
  });

  it('error takes priority over paused', () => {
    const runs = {
      r1: { pipeline_status: 'paused', active: false },
      r2: { pipeline_status: 'failed', active: false },
    };
    expect(projectStatus('proj-1', runs)).toBe('error');
  });

  it('returns idle for completed runs only', () => {
    const runs = {
      r1: { pipeline_status: 'completed', active: false },
      r2: { pipeline_status: 'completed', active: false },
    };
    expect(projectStatus('proj-1', runs)).toBe('idle');
  });

  it('filters by projectId when project field is set on runs', () => {
    const runs = {
      r1: { pipeline_status: 'running', active: true, project: 'proj-1' },
      r2: { pipeline_status: 'completed', active: false, project: 'proj-2' },
    };
    // proj-2 only has a completed run, so it should be idle
    expect(projectStatus('proj-2', runs)).toBe('idle');
    // proj-1 has a running run, so it should be running
    expect(projectStatus('proj-1', runs)).toBe('running');
  });

  // workspace statuses (W-047 §10.7)
  it('returns running when any run has pipeline_status planning', () => {
    const runs = { r1: { pipeline_status: 'planning', active: true } };
    expect(projectStatus('proj-1', runs)).toBe('running');
  });

  it('returns running when any run has pipeline_status integration_testing', () => {
    const runs = {
      r1: { pipeline_status: 'integration_testing', active: true },
    };
    expect(projectStatus('proj-1', runs)).toBe('running');
  });

  it('returns error when any run has pipeline_status integration_failed', () => {
    const runs = {
      r1: { pipeline_status: 'integration_failed', active: false },
    };
    expect(projectStatus('proj-1', runs)).toBe('error');
  });

  it('returns paused when any run has pipeline_status blocked', () => {
    const runs = { r1: { pipeline_status: 'blocked', active: false } };
    expect(projectStatus('proj-1', runs)).toBe('paused');
  });
});

describe('workspace sidebar badge variant logic', () => {
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

  function makeState(overrides = {}) {
    return {
      runs: {},
      preferences: {
        theme: 'light',
        sidebarCollapsed: false,
        notifications: null,
      },
      projectName: 'test-project',
      currentProjectId: null,
      projects: [],
      beads: { issues: [], dbExists: false },
      webhookInbox: { events: [] },
      worktrees: [],
      worktreeDiskWarningBytes: 2_000_000_000,
      // Fleet / workspace badges render only once their data is loaded.
      // Default both flags to true here so badge-variant assertions
      // exercise the populated branch (a spinner replaces the badge
      // otherwise).
      fleetsLoaded: true,
      workspaceRunsLoaded: true,
      ...overrides,
    };
  }

  const route = { section: 'active' };
  const defaultOpts = () => ({ onNavigate: vi.fn() });

  it('workspace badge is primary (blue) for planning workspaces', async () => {
    // planning is an orchestrator in-flight phase → matches the
    // Running sidebar row's "active" colour.
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'planning' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="primary"');
  });

  it('workspace badge is primary (blue) for integration_testing workspaces', async () => {
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'integration_testing' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="primary"');
  });

  it('workspace badge is primary (blue) for running workspaces', async () => {
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'running' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="primary"');
  });

  it('workspace badge is neutral when all workspaces are completed', async () => {
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'completed' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="neutral"');
  });

  it('workspace badge flips to warning when any workspace is integration_failed', async () => {
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'running' },
        { workspace_id: 'w2', status: 'integration_failed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="warning"');
  });

  it('workspace badge flips to warning when any workspace is halted', async () => {
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'planning' },
        { workspace_id: 'w2', status: 'halted' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="warning"');
  });

  it('blocked workspace counts toward badge total but does not trigger warning', async () => {
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'blocked' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="neutral"');
    expect(output).toContain('>1<');
  });
});
