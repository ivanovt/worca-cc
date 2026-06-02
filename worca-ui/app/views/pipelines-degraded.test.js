/**
 * Tests: pipelines view in degraded mode.
 *
 * When the worca-cc CLI is missing or older than @worca/ui's minimum,
 * the Pipelines view stays usable for read paths but disables every
 * write action (Edit, Duplicate, Set Default, Delete, Create, Import).
 * The banner explains what to do. Export keeps working because it's a
 * pure filesystem read.
 *
 * @vitest-environment jsdom
 */

import { render } from 'lit-html';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pipelinesView } from './pipelines.js';

function mount(state, options = {}) {
  const container = document.createElement('div');
  render(pipelinesView(state, options), container);
  return container;
}

function snapshotHandlers() {
  const calls = [];
  return {
    calls,
    onCreate: () => calls.push('create'),
    onEdit: (id) => calls.push(`edit:${id}`),
    onDuplicate: (id) => calls.push(`duplicate:${id}`),
    onSetDefault: (id) => calls.push(`set-default:${id}`),
    onDelete: (id) => calls.push(`delete:${id}`),
    onExport: (id) => calls.push(`export:${id}`),
  };
}

const SAMPLE_TEMPLATES = [
  {
    id: 'minimal',
    name: 'Minimal Pipeline',
    description: 'Built-in minimal',
    effectiveTier: 'builtin',
    shadows: [],
    builtin: true,
  },
  {
    id: 'my-tpl',
    name: 'My Project Tpl',
    description: 'project-tier',
    effectiveTier: 'project',
    shadows: ['builtin'],
    builtin: false,
  },
];

const DEGRADED_STATUS = {
  ok: false,
  installed: '0.46.0',
  minimum: '0.47.0',
  message: 'worca-cc 0.46.0 found, minimum 0.47.0 required',
};

const HEALTHY_STATUS = {
  ok: true,
  installed: '0.47.0',
  minimum: '0.47.0',
  message: 'worca-cc 0.47.0 — compatible',
};

describe('pipelinesView — degraded mode', () => {
  let container;
  beforeEach(() => {
    container = null;
  });
  afterEach(() => {
    container = null;
  });

  it('renders the warning banner when worcaCliStatus.ok is false', () => {
    container = mount(
      {
        templates: SAMPLE_TEMPLATES,
        templatesLoaded: true,
        worcaCliStatus: DEGRADED_STATUS,
      },
      snapshotHandlers(),
    );
    const banner = container.querySelector('.pipelines-cli-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/Editing is disabled/);
    expect(banner.textContent).toContain('0.47.0');
    expect(banner.textContent).toContain('0.46.0');
  });

  it('hides the banner when worcaCliStatus.ok is true', () => {
    container = mount(
      {
        templates: SAMPLE_TEMPLATES,
        templatesLoaded: true,
        worcaCliStatus: HEALTHY_STATUS,
      },
      snapshotHandlers(),
    );
    expect(container.querySelector('.pipelines-cli-banner')).toBeNull();
  });

  it('hides the banner while the probe is still loading (status === null)', () => {
    // Avoids the banner flashing in for a frame before /api/worca-cli responds.
    container = mount(
      {
        templates: SAMPLE_TEMPLATES,
        templatesLoaded: true,
        worcaCliStatus: null,
      },
      snapshotHandlers(),
    );
    expect(container.querySelector('.pipelines-cli-banner')).toBeNull();
  });

  it('disables Edit / Duplicate / Set Default / Delete buttons in degraded mode', () => {
    const handlers = snapshotHandlers();
    container = mount(
      {
        templates: SAMPLE_TEMPLATES,
        templatesLoaded: true,
        worcaCliStatus: DEGRADED_STATUS,
      },
      handlers,
    );
    const cards = container.querySelectorAll('.template-card');
    expect(cards.length).toBe(2);
    // Every write-action button on every card carries the "Upgrade worca-cc"
    // tooltip and must be `disabled`. Iterating the cross product is more
    // robust than chasing per-card text matches and locks the contract in
    // one assertion.
    const upgradeBtns = container.querySelectorAll(
      'button[title^="Upgrade worca-cc"]',
    );
    expect(upgradeBtns.length).toBeGreaterThanOrEqual(4); // Edit/Duplicate + SetDefault + Delete cover the two cards
    for (const btn of upgradeBtns) {
      expect(btn.disabled).toBe(true);
    }
    // Click handlers must not fire on disabled buttons (lit/DOM still
    // dispatches click, but the onX = null guards in the view fall through).
    for (const btn of upgradeBtns) {
      btn.click();
    }
    expect(handlers.calls).toEqual([]);
  });

  it('keeps the Export button enabled in degraded mode (read-only path)', () => {
    container = mount(
      {
        templates: SAMPLE_TEMPLATES,
        templatesLoaded: true,
        worcaCliStatus: DEGRADED_STATUS,
      },
      snapshotHandlers(),
    );
    const cards = container.querySelectorAll('.template-card');
    for (const card of cards) {
      const exportBtn = card.querySelector('button[title*="Export"]');
      expect(exportBtn).not.toBeNull();
      expect(exportBtn.disabled).toBe(false);
    }
  });

  it('keeps Edit / Duplicate / etc. enabled when the CLI is healthy', () => {
    container = mount(
      {
        templates: SAMPLE_TEMPLATES,
        templatesLoaded: true,
        worcaCliStatus: HEALTHY_STATUS,
      },
      snapshotHandlers(),
    );
    const cards = container.querySelectorAll('.template-card');
    const projectCard = Array.from(cards).find((c) =>
      c.textContent.includes('My Project Tpl'),
    );
    const editBtn = projectCard.querySelector('button[title*="Edit"]');
    expect(editBtn.disabled).toBe(false);
  });

  it('disables the empty-state Create / Import buttons in degraded mode', () => {
    container = mount(
      {
        templates: [],
        templatesLoaded: true,
        worcaCliStatus: DEGRADED_STATUS,
      },
      snapshotHandlers(),
    );
    const empty = container.querySelector('.empty-state.pipelines-empty');
    expect(empty).not.toBeNull();
    const buttons = empty.querySelectorAll('sl-button');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const btn of buttons) {
      // sl-button reflects `disabled` as a boolean attribute
      expect(btn.hasAttribute('disabled')).toBe(true);
    }
  });

  it('renders the special "worca CLI not found" wording when installed is null', () => {
    container = mount(
      {
        templates: SAMPLE_TEMPLATES,
        templatesLoaded: true,
        worcaCliStatus: {
          ok: false,
          installed: null,
          minimum: '0.47.0',
          message: 'worca CLI not found',
        },
      },
      snapshotHandlers(),
    );
    const banner = container.querySelector('.pipelines-cli-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/worca CLI not found/);
  });
});
