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
    tier: 'builtin',
    shadows: [],
    builtin: true,
  },
  {
    id: 'my-tpl',
    name: 'My Project Tpl',
    description: 'project-tier',
    tier: 'project',
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
    // The Edit button was removed in favor of clickable cards, and
    // Rename was removed because the editor's inline Name/ID fields
    // do the same job. Duplicate renders on every tier; the rest
    // (Set Default, Delete) are project-only. All must be `disabled`.
    const upgradeBtns = container.querySelectorAll(
      'button[title^="Upgrade worca-cc"]',
    );
    // 1 (builtin Duplicate)
    // + 3 (project Duplicate + Set Default + Delete)
    // = 4.
    expect(upgradeBtns.length).toBe(4);
    for (const btn of upgradeBtns) {
      expect(btn.disabled).toBe(true);
    }
    // Click handlers must not fire on disabled buttons.
    for (const btn of upgradeBtns) {
      btn.click();
    }
    expect(handlers.calls).toEqual([]);
  });

  it('cards are inert (no role/tabindex, no clickable class) in degraded mode', () => {
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
    for (const card of cards) {
      expect(card.classList.contains('template-card--clickable')).toBe(false);
      expect(card.getAttribute('role')).not.toBe('button');
      expect(card.getAttribute('tabindex')).toBeNull();
      expect(card.getAttribute('aria-disabled')).toBe('true');
      // And a click on the card body must NOT navigate to the editor.
      card.click();
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

  it('cards are clickable + write buttons enabled when the CLI is healthy', () => {
    // Edit moved from a button to whole-card click; surviving write
    // actions on a project card are Set Default and Delete. All must be
    // enabled (i.e. carry their healthy-state tooltip, not the upgrade
    // tooltip) and the card itself must be marked clickable.
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
    expect(projectCard).toBeDefined();
    expect(projectCard.classList.contains('template-card--clickable')).toBe(
      true,
    );
    expect(projectCard.getAttribute('role')).toBe('button');
    expect(
      container.querySelector('button[title^="Upgrade worca-cc"]'),
    ).toBeNull();
  });

  it('renders an empty placeholder for every tier when no templates exist', () => {
    // The old "no templates anywhere" full-page empty state was
    // removed in favour of per-tier placeholders so the page structure
    // stays consistent. Create / Import affordances live in the page
    // chrome (main.js) now — they're tested at the chrome layer.
    container = mount(
      {
        templates: [],
        templatesLoaded: true,
        worcaCliStatus: DEGRADED_STATUS,
      },
      snapshotHandlers(),
    );
    const empties = container.querySelectorAll('.tier-section-empty');
    expect(empties.length).toBe(3);
    // The legacy global empty-state must not render anymore.
    expect(container.querySelector('.empty-state.pipelines-empty')).toBeNull();
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
