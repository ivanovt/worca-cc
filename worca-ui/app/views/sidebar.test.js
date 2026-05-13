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
  it('shows Worktrees entry with no badge when loaded and empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({ worktrees: [], worktreesLoaded: true });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Worktrees<');
    expect(output).not.toContain('worktrees-count-badge');
    expect(output).not.toContain('sidebar-worktrees-loading');
  });

  it('shows Worktrees entry when worktrees array is non-empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      worktrees: [
        { run_id: 'r1', disk_bytes: 100_000_000, status: 'completed' },
      ],
      worktreesLoaded: true,
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
      worktreesLoaded: true,
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
      worktreesLoaded: true,
    });
    const activeRoute = { section: 'worktrees' };
    const output = renderToString(
      sidebarView(state, activeRoute, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-item active');
  });
});

describe('sidebar - loading spinners', () => {
  it('shows spinner for Running/History when runs not yet loaded', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      runsLoaded: false,
      worktreesLoaded: true,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-running-loading');
    expect(output).toContain('sidebar-history-loading');
    expect(output).not.toContain('sidebar-worktrees-loading');
  });

  it('shows spinner for Worktrees when worktrees not yet loaded', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      runsLoaded: true,
      worktreesLoaded: false,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('sidebar-running-loading');
    expect(output).not.toContain('sidebar-history-loading');
    expect(output).toContain('sidebar-worktrees-loading');
  });

  it('shows no spinners once everything is loaded', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      runsLoaded: true,
      worktreesLoaded: true,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('sidebar-loading');
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
      worktreesLoaded: true,
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
      worktreesLoaded: true,
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
      worktreesLoaded: true,
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
      worktreesLoaded: true,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Worktrees<');
    expect(output).not.toContain('variant="warning"');
  });
});

describe('sidebar - New Pipeline button capacity gating', () => {
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

describe('sidebar - New Pipeline CTA (dropdown)', () => {
  it('CTA renders as sl-dropdown wrapper (not a plain button)', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sl-dropdown');
    expect(output).toContain('sidebar-new-run-btn');
  });

  it('dropdown contains sl-menu with New Pipeline and New Fleet items', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sl-menu');
    expect(output).toContain('sl-menu-item');
    expect(output).toContain('>New Pipeline<');
    expect(output).toContain('>New Fleet<');
  });

  it('New Pipeline menu item is present', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('New Pipeline');
  });

  it('New Fleet menu item routes to fleet-runs/new via class marker', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('menu-item-new-fleet');
    expect(output).toContain('menu-item-new-pipeline');
  });
});

describe('sidebar - Fleets nav entry', () => {
  it('Fleets entry hidden when state.fleets is absent', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('>Fleets<');
  });

  it('Fleets entry hidden when state.fleets is empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({ fleets: [] });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('>Fleets<');
  });

  it('Fleets entry visible when fleets array is non-empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      fleets: [{ fleet_id: 'f1', status: 'completed' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Fleets<');
  });

  it('Fleets badge counts running + halted (the attention set)', async () => {
    // Terminal fleets (completed/failed) don't add to the count.
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      fleets: [
        { fleet_id: 'f1', status: 'running' },
        { fleet_id: 'f2', status: 'running' },
        { fleet_id: 'f3', status: 'halted' },
        { fleet_id: 'f4', status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('fleets-count-badge');
    // 2 running + 1 halted = 3, completed excluded
    expect(output).toContain('>3<');
  });

  it('Fleets badge variant is neutral when only running fleets exist', async () => {
    // Sidebar count badges follow the History/Worktrees convention: neutral
    // grey by default, escalates only on the "needs attention" trigger.
    // Running fleets are normal active work — no escalation.
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      fleets: [
        { fleet_id: 'f1', status: 'running' },
        { fleet_id: 'f2', status: 'running' },
        { fleet_id: 'f3', status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('class="fleets-count-badge"');
    expect(output).toContain('variant="neutral"');
    expect(output).not.toContain('variant="warning"');
    expect(output).not.toContain(
      'variant="primary" pill class="fleets-count-badge"',
    );
  });

  it('Fleets badge variant flips to warning when any fleet is halted', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      fleets: [
        { fleet_id: 'f1', status: 'halted' },
        // a completed fleet is terminal and excluded from the badge count,
        // but its presence must not change the variant logic
        { fleet_id: 'f2', status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('fleets-count-badge');
    expect(output).toContain('variant="warning"');
    // halted = 1 fleet that needs attention
    expect(output).toContain('>1<');
  });

  it('Fleets badge hidden when only terminal fleets exist', async () => {
    // The entry itself is shown (any fleet exists) but the count badge is
    // not — neither running nor halted needs operator action.
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      fleets: [
        { fleet_id: 'f1', status: 'completed' },
        { fleet_id: 'f2', status: 'failed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Fleets<');
    expect(output).not.toContain('fleets-count-badge');
  });

  it('Fleets entry is active when route section is fleet-runs', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      fleets: [{ fleet_id: 'f1', status: 'running' }],
    });
    const fleetsRoute = { section: 'fleet-runs' };
    const output = renderToString(
      sidebarView(state, fleetsRoute, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-item active');
  });
});
