import { describe, expect, it, vi } from 'vitest';
import { sidebarView } from './sidebar.js';

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
    // Default Fleets / Workspaces to "loaded" so badge assertions don't
    // see a spinner. Individual tests still override either flag to
    // exercise the spinner branch explicitly.
    fleetsLoaded: true,
    workspaceRunsLoaded: true,
    ...overrides,
  };
}

const route = { section: 'active' };
const defaultOpts = () => ({ onNavigate: vi.fn() });

describe('sidebar - Worktrees nav entry visibility', () => {
  it('shows Worktrees entry with no badge when loaded and empty', async () => {
    const state = makeState({ worktrees: [], worktreesLoaded: true });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Worktrees<');
    expect(output).not.toContain('worktrees-count-badge');
    expect(output).not.toContain('sidebar-worktrees-loading');
  });

  it('shows Worktrees entry when worktrees array is non-empty', async () => {
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

  it('shows spinner for Fleets when fleets not yet loaded', async () => {
    const state = makeState({
      runsLoaded: true,
      worktreesLoaded: true,
      fleetsLoaded: false,
      workspaceRunsLoaded: true,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-fleets-loading');
    expect(output).not.toContain('sidebar-workspaces-loading');
  });

  it('shows spinner for Workspaces when workspace runs not yet loaded', async () => {
    const state = makeState({
      runsLoaded: true,
      worktreesLoaded: true,
      fleetsLoaded: true,
      workspaceRunsLoaded: false,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-workspaces-loading');
    expect(output).not.toContain('sidebar-fleets-loading');
  });

  it('shows no spinners once everything is loaded', async () => {
    const state = makeState({
      runsLoaded: true,
      worktreesLoaded: true,
      fleetsLoaded: true,
      workspaceRunsLoaded: true,
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('sidebar-loading');
  });
});

describe('sidebar - Worktrees badge disk-pressure threshold', () => {
  it('badge variant is neutral when total disk is below 2GB default threshold', async () => {
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
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-new-run-split');
    expect(output).toContain('sidebar-new-run-btn-primary');
    expect(output).toContain('sidebar-new-run-btn-chevron');
    expect(output).toContain('>Run Pipeline<');
  });

  it('chevron dropdown exposes New Fleet as a menu item', async () => {
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sl-dropdown');
    expect(output).toContain('sl-menu');
    expect(output).toContain('menu-item-new-fleet');
    expect(output).toContain('Run Fleet');
  });

  it('primary "New Pipeline" button stays clickable in global mode with no project selected', async () => {
    // The primary half is no longer gated on project context — it always
    // navigates to /new-run, and the launcher view handles the "pick a
    // project" prompt for global-mode-multi. Only capacity disables it.
    // We can't reliably assert on the ?disabled boolean binding via the
    // renderToString string form (lit-html's ?attr= literal stays in the
    // source); the user-visible signal we *can* check is the project-gate
    // tooltip — if the gate is gone the tooltip text shouldn't render.
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
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Fleets<');
  });

  it('Fleets entry visible when state.fleets is empty', async () => {
    const state = makeState({ fleets: [] });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Fleets<');
  });

  it('Fleets entry visible when fleets array is non-empty', async () => {
    const state = makeState({
      fleets: [{ fleet_id: 'f1', status: 'completed' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Fleets<');
  });

  it('Fleets badge hidden only when zero live fleets', async () => {
    // After moving to the total-count convention, terminal-only fleets
    // still get a badge (they're live). The badge hides only when there
    // are literally no live fleets.
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
    expect(out2).toContain('fleets-count-badge');
    expect(out2).toContain('>1<');

    const stateArchived = makeState({
      fleets: [{ fleet_id: 'f1', status: 'completed', archived: true }],
    });
    const out3 = renderToString(
      sidebarView(stateArchived, route, 'open', defaultOpts()),
    );
    // Archived fleets are filtered out, so the live count drops to zero.
    expect(out3).not.toContain('fleets-count-badge');
  });

  it('Fleets badge counts ALL live fleets (matches History / Worktrees)', async () => {
    // History/Worktrees show a total count; Fleets does the same for
    // parity. Archived fleets are excluded; everything else (running,
    // halted, completed, failed) counts.
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
    // 4 live fleets, none archived
    expect(output).toContain('>4<');
  });

  it('Fleets badge variant is primary (blue) when any fleet is running', async () => {
    // Three-tier escalation: warning (halted) > primary (running) > neutral.
    // Matches the Running sidebar row's "active = primary" convention so
    // running fleets aren't visually indistinguishable from idle ones.
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
    expect(output).toContain('variant="primary"');
    expect(output).not.toContain('variant="warning"');
  });

  it('Fleets badge warning beats primary when halted + running coexist', async () => {
    const state = makeState({
      fleets: [
        { fleet_id: 'f1', status: 'running' },
        { fleet_id: 'f2', status: 'halted' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('fleets-count-badge');
    expect(output).toContain('variant="warning"');
    expect(output).not.toContain('variant="primary"');
  });

  it('Fleets badge variant flips to warning when any fleet is halted', async () => {
    const state = makeState({
      fleets: [
        { fleet_id: 'f1', status: 'halted' },
        { fleet_id: 'f2', status: 'completed' },
      ],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('fleets-count-badge');
    expect(output).toContain('variant="warning"');
    // 2 live fleets total (1 halted + 1 completed) — total count, not
    // attention-only.
    expect(output).toContain('>2<');
  });

  it('Fleets badge is shown for terminal-only fleets (total count)', async () => {
    // Always-show-total convention: even when nothing needs attention,
    // the count is visible (neutral). Hides only when zero live fleets.
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
    expect(output).toContain('fleets-count-badge');
    expect(output).toContain('variant="neutral"');
    expect(output).toContain('>2<');
  });

  it('Fleets entry is active when route section is fleet-runs', async () => {
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
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
  });

  it('Workspaces entry always visible when state.workspaces is empty', async () => {
    const state = makeState({ workspaceRuns: [] });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
  });

  it('Workspaces entry visible when workspaces array is non-empty', async () => {
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'completed' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
  });

  it('Workspaces entry is a flat sibling under Pipeline (not nested under Multi-Repo)', async () => {
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'running' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).not.toContain('Multi-Repo');
    expect(output).toContain('>Workspaces<');
  });

  it('Workspaces badge stays visible for terminal workspaces (total count, no attention)', async () => {
    // After moving to the total-count convention, completed workspaces
    // still get counted — the badge stays visible with a neutral
    // variant. Hides only when there are literally no live runs.
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'completed' }],
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Workspaces<');
    expect(output).toContain('workspaces-count-badge');
    expect(output).toContain('variant="neutral"');
    expect(output).toContain('>1<');
  });

  it('Workspaces badge counts ALL live workspace runs (matches History / Worktrees / Fleets)', async () => {
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
    // 4 live workspaces (none archived) — total count, not attention-only
    expect(output).toContain('>4<');
  });

  it('Workspaces badge variant is primary (blue) when any workspace is running', async () => {
    // Three-tier escalation: warning > primary > neutral. A running
    // workspace flips the badge blue so it's visually distinguishable
    // from an all-completed sidebar count.
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
    expect(output).toContain('variant="primary"');
  });

  it('Workspaces badge variant flips to warning when any workspace is halted', async () => {
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

  it('Workspaces badge totals every live run regardless of attention state', async () => {
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
    // 4 live workspaces — all non-archived ones count toward the badge
    expect(output).toContain('>4<');
    // Variant escalates to warning because of halted + integration_failed
    expect(output).toContain('variant="warning"');
  });

  it('Workspaces badge shown even when only terminal workspaces exist', async () => {
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
    expect(output).toContain('workspaces-count-badge');
    // failed counts as attention → warning variant
    expect(output).toContain('variant="warning"');
    expect(output).toContain('>2<');
  });

  it('Workspaces entry is active when route section is workspace-runs', async () => {
    const state = makeState({
      workspaceRuns: [{ workspace_id: 'w1', status: 'running' }],
    });
    const wsRoute = { section: 'workspace-runs' };
    const output = renderToString(
      sidebarView(state, wsRoute, 'open', defaultOpts()),
    );
    expect(output).toContain('sidebar-item active');
  });

  it('Workspaces entry excludes archived workspaces from badge total', async () => {
    // Archived workspaces shouldn't contribute to the count. Here the
    // only live run is completed → badge shows 1, neutral variant.
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
    expect(output).toContain('workspaces-count-badge');
    // Only w2 (non-archived) contributes
    expect(output).toContain('>1<');
    expect(output).toContain('variant="neutral"');
  });
});

describe('sidebar - New Workspace in dropdown', () => {
  it('chevron dropdown includes New Workspace menu item', async () => {
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('menu-item-new-workspace');
    expect(output).toContain('Run Workspace');
  });
});
