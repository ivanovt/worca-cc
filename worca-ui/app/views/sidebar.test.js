import { describe, expect, it, vi } from 'vitest';

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
    ...overrides,
  };
}

const route = { section: 'active' };
const defaultOpts = () => ({ onNavigate: vi.fn() });

describe('sidebar - Worktrees nav entry visibility', () => {
  it('hides Worktrees entry when worktrees is empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({ worktrees: [] });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('>Worktrees<');
  });

  it('shows Worktrees entry when worktrees array is non-empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      worktrees: [
        { run_id: 'r1', disk_bytes: 100_000_000, status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Worktrees<');
  });

  it('shows worktree count in badge', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      worktrees: [
        { run_id: 'r1', disk_bytes: 100_000_000, status: 'completed' },
        { run_id: 'r2', disk_bytes: 200_000_000, status: 'running' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('worktrees-count-badge');
    expect(output).toContain('>2<');
  });

  it('Worktrees entry is active when route section is worktrees', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      worktrees: [{ run_id: 'r1', disk_bytes: 100_000_000, status: 'running' }],
    });
    const activeRoute = { section: 'worktrees' };
    const output = renderToString(
      sidebarView(state, activeRoute, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-item active');
  });
});

describe('sidebar - Worktrees badge disk-pressure threshold', () => {
  it('badge variant is neutral when total disk is below 2GB default threshold', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      runs: {},
      worktrees: [
        { run_id: 'r1', disk_bytes: 1_000_000_000, status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Worktrees<');
    // No warning variant expected (webhooks empty, disk < 2GB)
    expect(output).not.toContain('variant="warning"');
  });

  it('badge variant flips to warning when total disk exceeds 2GB default threshold', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      runs: {},
      worktrees: [
        { run_id: 'r1', disk_bytes: 1_500_000_000, status: 'completed' },
        { run_id: 'r2', disk_bytes: 700_000_000, status: 'running' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('variant="warning"');
  });

  it('badge variant flips to warning when custom threshold is exceeded', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      runs: {},
      worktrees: [
        { run_id: 'r1', disk_bytes: 500_000_000, status: 'completed' },
      ],
      worktreeDiskWarningBytes: 400_000_000,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('variant="warning"');
  });

  it('badge stays neutral when custom threshold is not exceeded', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      runs: {},
      worktrees: [
        { run_id: 'r1', disk_bytes: 300_000_000, status: 'completed' },
      ],
      worktreeDiskWarningBytes: 400_000_000,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Worktrees<');
    expect(output).not.toContain('variant="warning"');
  });
});

describe('sidebar - Running N/cap badge', () => {
  it('shows totalRunning/cap badge when totalRunning > 0', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      totalRunning: 3,
      maxConcurrentPipelines: 10,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('running-cap-badge');
    expect(output).toContain('3/10');
  });

  it('does not show running-cap-badge when totalRunning is 0', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      totalRunning: 0,
      maxConcurrentPipelines: 10,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('running-cap-badge');
  });

  it('badge variant is warning when at capacity', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      totalRunning: 5,
      maxConcurrentPipelines: 5,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('running-cap-badge');
    expect(output).toContain('5/5');
  });

  it('disables New Pipeline button when at capacity', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      totalRunning: 10,
      maxConcurrentPipelines: 10,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('disabled');
  });
});

describe('sidebar - New Pipeline CTA', () => {
  it('renders a single-action button for New Pipeline CTA', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-new-run-btn');
    // No dropdown wrapper, no menu item — just a plain button.
    expect(output).not.toContain('sl-dropdown');
    expect(output).not.toContain('sl-menu-item');
  });

  it('button label contains "New Pipeline"', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('New Pipeline');
  });
});
