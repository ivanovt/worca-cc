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

describe('sidebar - New Pipeline CTA (split button)', () => {
  // Pattern A from the W-040 UX discussion: split-button with primary
  // "New Pipeline" + chevron dropdown for the multi-project alternatives.

  it('renders the primary "New Pipeline" button alongside a chevron dropdown', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-new-run-split');
    expect(output).toContain('sidebar-new-run-btn-primary');
    expect(output).toContain('sidebar-new-run-btn-chevron');
    expect(output).toContain('>New Pipeline<');
  });

  it('chevron dropdown exposes New Fleet as a menu item', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sl-dropdown');
    expect(output).toContain('sl-menu');
    expect(output).toContain('menu-item-new-fleet');
    expect(output).toContain('New Fleet');
  });

  it('primary "New Pipeline" button stays clickable in global mode with no project selected', async () => {
    // The primary half is no longer gated on project context — it always
    // navigates to /new-run, and the launcher view handles the "pick a
    // project" prompt for global-mode-multi. Only capacity disables it.
    // We can't reliably assert on the ?disabled boolean binding via the
    // renderToString string form (lit-html's ?attr= literal stays in the
    // source); the user-visible signal we *can* check is the project-gate
    // tooltip — if the gate is gone the tooltip text shouldn't render.
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      currentProjectId: null,
      projects: [
        { name: 'a', path: '/a' },
        { name: 'b', path: '/b' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-new-run-btn-primary');
    expect(output).not.toContain('Select a project first');
  });

  it('chevron is always rendered in global mode (Fleet creation needs no project)', async () => {
    // The chevron must be present regardless of project context so users
    // can reach Fleet creation from the sidebar. We can't reliably assert
    // on the boolean disabled state via renderToString (lit-html's
    // ?attr= syntax doesn't evaluate to a DOM attribute in the string
    // form), so we settle for presence — the actual disabled-on-capacity
    // gating is exercised in the existing atCapacity tests.
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      currentProjectId: null,
      projects: [
        { name: 'a', path: '/a' },
        { name: 'b', path: '/b' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-new-run-btn-chevron');
    expect(output).toContain('menu-item-new-fleet');
  });
});

describe('sidebar - Fleets nav entry', () => {
  // The Fleets entry is always-shown for UX consistency with its peer list
  // entries (Running, History, Worktrees) — the empty-state experience is
  // owned by the /fleet-runs view, not by hiding the navigation.
  it('Fleets entry visible when state.fleets is absent', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Fleets<');
  });

  it('Fleets entry visible when state.fleets is empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({ fleets: [] });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Fleets<');
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

  it('Fleets badge hidden when no running/halted fleets exist', async () => {
    // Empty / terminal-only fleet sets produce no badge — the entry stays
    // visible but stays quiet (matches Worktrees/History when at zero).
    const { sidebarView } = await import('./sidebar.js');
    const stateEmpty = makeState({ fleets: [] });
    const out1 = renderToString(
      sidebarView(stateEmpty, route, 'open', defaultOpts()),
    );
    expect(out1).not.toContain('fleets-count-badge');

    const stateTerminal = makeState({
      fleets: [{ fleet_id: 'f1', status: 'completed' }],
    });
    const out2 = renderToString(
      sidebarView(stateTerminal, route, 'open', defaultOpts()),
    );
    expect(out2).not.toContain('fleets-count-badge');
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

describe('sidebar - Workspaces nav entry', () => {
  it('Workspaces entry always visible when state.workspaces is absent', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
  });

  it('Workspaces entry always visible when state.workspaces is empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({ workspaceRuns: [] });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
  });

  it('Workspaces entry visible when workspaces array is non-empty', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'completed' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
  });

  it('Workspaces entry is a flat sibling under Pipeline (not nested under Multi-Repo)', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'running' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('Multi-Repo');
    expect(output).toContain('>Workspaces<');
  });

  it('Workspaces badge hidden when no active/halted/integration_failed workspaces exist', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'completed' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
    expect(output).not.toContain('workspaces-count-badge');
  });

  it('Workspaces badge counts active workspaces (running + planning + integration_testing)', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'running' },
        { workspace_id: 'w2', status: 'planning' },
        { workspace_id: 'w3', status: 'integration_testing' },
        { workspace_id: 'w4', status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('>3<');
  });

  it('Workspaces badge variant is neutral when only active workspaces exist (matches Fleets)', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'running' },
        { workspace_id: 'w2', status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="neutral"');
  });

  it('Workspaces badge variant flips to warning when any workspace is halted', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'running' },
        { workspace_id: 'w2', status: 'halted' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="warning"');
  });

  it('Workspaces badge variant flips to warning when any workspace is integration_failed', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'planning' },
        { workspace_id: 'w2', status: 'integration_failed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="warning"');
  });

  it('Workspaces badge includes halted + integration_failed in the attention count', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'running' },
        { workspace_id: 'w2', status: 'halted' },
        { workspace_id: 'w3', status: 'integration_failed' },
        { workspace_id: 'w4', status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('workspaces-count-badge');
    // 1 running + 1 halted + 1 integration_failed = 3 attention items
    expect(output).toContain('>3<');
  });

  it('Workspaces badge hidden when only terminal workspaces exist', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'completed' },
        { workspace_id: 'w2', status: 'failed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
    expect(output).not.toContain('workspaces-count-badge');
  });

  it('Workspaces entry is active when route section is workspace-runs', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'running' }],
    });
    const wsRoute = { section: 'workspace-runs' };
    const output = renderToString(
      sidebarView(state, wsRoute, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-item active');
  });

  it('Workspaces entry excludes archived workspaces from badge', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      workspaceRuns: [
        { workspace_id: 'w1', status: 'running', archived: true },
        { workspace_id: 'w2', status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
    expect(output).not.toContain('workspaces-count-badge');
  });
});

describe('sidebar - New Workspace in dropdown', () => {
  it('chevron dropdown includes New Workspace menu item', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('menu-item-new-workspace');
    expect(output).toContain('New Workspace');
  });
});
