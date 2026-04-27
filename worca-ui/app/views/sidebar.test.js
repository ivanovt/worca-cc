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
    settings: {},
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
      settings: { 'worca.ui.worktree_disk_warning_bytes': 400_000_000 },
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
      settings: { 'worca.ui.worktree_disk_warning_bytes': 400_000_000 },
    });
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('>Worktrees<');
    expect(output).not.toContain('variant="warning"');
  });
});

describe('sidebar - New Pipeline CTA as sl-dropdown', () => {
  it('renders sl-dropdown for New Pipeline CTA', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('sl-dropdown');
  });

  it('dropdown contains New Pipeline menu item', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState();
    const output = renderToString(
      sidebarView(state, route, 'open', defaultOpts()),
    );
    expect(output).toContain('New Pipeline');
    expect(output).toContain('sl-menu-item');
  });
});
