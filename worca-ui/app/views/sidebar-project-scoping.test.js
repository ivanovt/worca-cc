/**
 * Tests for sidebar entries that are scoped to a single project — they must
 * be hidden in All Projects mode (currentProjectId === null) since they
 * would otherwise hit un-scoped server endpoints and load ambient/global data
 * under a misleading "Project …" label.
 */

import { describe, expect, it, vi } from 'vitest';

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
    ...overrides,
  };
}

describe('sidebar Project Settings scoping', () => {
  it('hides Project Settings in All Projects mode (currentProjectId null)', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: null,
    });
    const route = { section: 'active' };
    const result = sidebarView(state, route, 'open', { onNavigate: vi.fn() });

    const templateStr = JSON.stringify(result.values);
    expect(templateStr).not.toContain('Project Settings');
  });

  it('shows Project Settings when a project is selected', async () => {
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: 'proj-a',
    });
    const route = { section: 'active' };
    const result = sidebarView(state, route, 'open', { onNavigate: vi.fn() });

    const templateStr = JSON.stringify(result.values);
    expect(templateStr).toContain('Project Settings');
  });

  it('shows Project Settings in single-project mode (auto-selected sole project)', async () => {
    // In single-project mode main.js auto-sets currentProjectId to the only
    // project, so the entry must still appear.
    const { sidebarView } = await import('./sidebar.js');
    const state = makeState({
      projects: [{ name: 'only-one' }],
      currentProjectId: 'only-one',
    });
    const route = { section: 'active' };
    const result = sidebarView(state, route, 'open', { onNavigate: vi.fn() });

    const templateStr = JSON.stringify(result.values);
    expect(templateStr).toContain('Project Settings');
  });
});
