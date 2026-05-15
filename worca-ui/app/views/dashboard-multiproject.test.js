/**
 * Tests for multi-project dashboard features.
 * @vitest-environment jsdom
 */

import { render } from 'lit-html';
import { describe, expect, it, vi } from 'vitest';
import { dashboardView } from './dashboard.js';

function renderToContainer(template) {
  const container = document.createElement('div');
  render(template, container);
  return container;
}

function makeState(overrides = {}) {
  return {
    runs: {},
    projects: [],
    currentProjectId: null,
    ...overrides,
  };
}

describe('single-project dashboard', () => {
  it('renders identically to before', () => {
    const state = makeState({
      projects: [{ name: 'default', path: '/app' }],
      currentProjectId: 'default',
      runs: {
        'run-1': {
          id: 'run-1',
          active: true,
          pipeline_status: 'running',
          stages: {},
        },
      },
    });
    const container = renderToContainer(
      dashboardView(state, { onSelectRun: vi.fn(), onNavigate: vi.fn() }),
    );
    // Should have dashboard stats but no project cards
    expect(container.querySelector('.dashboard-stats')).not.toBeNull();
    expect(container.querySelector('.project-cards')).toBeNull();
  });
});

describe('multi-project dashboard', () => {
  // Project cards were removed in favor of the sidebar's project dropdown,
  // which is always-on and provides the same switching affordance without
  // the unreliable run-to-project attribution the cards depended on.
  const projects = [
    { name: 'alpha', path: '/alpha' },
    { name: 'beta', path: '/beta' },
  ];

  it('does not render project cards in global mode (no project selected)', () => {
    const state = makeState({
      projects,
      currentProjectId: null,
      runs: {},
    });
    const container = renderToContainer(
      dashboardView(state, { onSelectRun: vi.fn(), onNavigate: vi.fn() }),
    );
    expect(container.querySelector('.project-cards')).toBeNull();
    expect(container.querySelector('.project-card')).toBeNull();
  });

  it('does not render project cards when a project is selected', () => {
    const state = makeState({
      projects,
      currentProjectId: 'alpha',
      runs: {},
    });
    const container = renderToContainer(
      dashboardView(state, { onSelectRun: vi.fn(), onNavigate: vi.fn() }),
    );
    expect(container.querySelector('.project-cards')).toBeNull();
  });
});
