/**
 * Tests: clickable template cards in the Pipelines view.
 *
 * The Edit button was removed in favor of whole-card clickability.
 * Project/user cards: click → onEdit. Built-in cards: click → onDuplicate
 * (the canonical "shadow & edit" path). Action buttons inside the card
 * must stop propagation so they don't double-fire as a card click.
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
    onRename: (id, scope) => calls.push(`rename:${id}:${scope}`),
  };
}

const TEMPLATES = [
  {
    id: 'minimal',
    name: 'Minimal Pipeline',
    description: 'Built-in minimal',
    tier: 'builtin',
    builtin: true,
  },
  {
    id: 'my-tpl',
    name: 'My Project Tpl',
    description: 'project-tier',
    tier: 'project',
    builtin: false,
  },
];

const HEALTHY = {
  ok: true,
  installed: '0.47.0',
  minimum: '0.47.0',
  message: 'compatible',
};

describe('pipelinesView — clickable cards', () => {
  let container;
  beforeEach(() => {
    container = null;
  });
  afterEach(() => {
    container = null;
  });

  function cardForId(root, id) {
    return Array.from(root.querySelectorAll('.template-card')).find((c) =>
      c.querySelector('.run-card-title')?.textContent?.includes(id),
    );
  }

  it('project/user card click invokes onEdit with the template id', () => {
    const handlers = snapshotHandlers();
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      handlers,
    );
    const card = cardForId(container, 'My Project Tpl');
    expect(card).toBeDefined();
    card.click();
    expect(handlers.calls).toEqual(['edit:my-tpl']);
  });

  it('built-in card click invokes onDuplicate (canonical shadow & edit)', () => {
    const handlers = snapshotHandlers();
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      handlers,
    );
    const card = cardForId(container, 'Minimal Pipeline');
    expect(card).toBeDefined();
    card.click();
    expect(handlers.calls).toEqual(['duplicate:minimal']);
  });

  it('Edit button is no longer rendered on any card', () => {
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      snapshotHandlers(),
    );
    // No button anywhere in the grid should be labelled "Edit".
    const buttons = container.querySelectorAll('.template-card button');
    for (const btn of buttons) {
      const label = (btn.textContent || '').trim();
      expect(label.startsWith('Edit')).toBe(false);
    }
  });

  it('keeps the Duplicate button on built-in cards as an explicit affordance', () => {
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      snapshotHandlers(),
    );
    const card = cardForId(container, 'Minimal Pipeline');
    const dupBtn = Array.from(card.querySelectorAll('button')).find((b) =>
      (b.textContent || '').includes('Duplicate'),
    );
    expect(dupBtn).toBeDefined();
  });

  it('Rename action fires onRename with (id, scope) and only on project/user cards', () => {
    const handlers = snapshotHandlers();
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      handlers,
    );
    // Built-in cards have no Rename button (immutable tier).
    const builtinCard = cardForId(container, 'Minimal Pipeline');
    expect(builtinCard.querySelector('button[title*="Rename"]')).toBeNull();
    // Project card has a Rename button — click it.
    const projectCard = cardForId(container, 'My Project Tpl');
    const renameBtn = projectCard.querySelector('button[title*="Rename"]');
    expect(renameBtn).not.toBeNull();
    renameBtn.click();
    expect(handlers.calls).toEqual(['rename:my-tpl:project']);
  });

  it('Set Default is hidden on user-tier cards', () => {
    // Set Default writes worca.default_template (a project-level
    // setting); pointing it at a user template makes no sense.
    container = mount(
      {
        templates: [
          {
            id: 'my-user-tpl',
            name: 'My User Tpl',
            description: '',
            tier: 'user',
            shadows: [],
            builtin: false,
          },
        ],
        templatesLoaded: true,
        worcaCliStatus: HEALTHY,
      },
      snapshotHandlers(),
    );
    const card = cardForId(container, 'My User Tpl');
    expect(card.querySelector('button[title*="Set as default"]')).toBeNull();
  });

  it('Set Default / Export / Delete clicks do not also fire a card click', () => {
    // Action buttons stop propagation; otherwise every click on Delete
    // would also navigate the user into the editor.
    const handlers = snapshotHandlers();
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      handlers,
    );
    const card = cardForId(container, 'My Project Tpl');
    for (const btn of card.querySelectorAll('button')) {
      btn.click();
    }
    // The card click handler must NOT have fired alongside any button.
    expect(handlers.calls.filter((c) => c === 'edit:my-tpl')).toEqual([]);
    // And each button must have fired exactly its own action.
    expect(handlers.calls).toContain('set-default:my-tpl');
    expect(handlers.calls).toContain('export:my-tpl');
    expect(handlers.calls).toContain('delete:my-tpl');
  });

  it('marks clickable cards with role=button, tabindex=0 and the modifier class', () => {
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      snapshotHandlers(),
    );
    for (const card of container.querySelectorAll('.template-card')) {
      expect(card.classList.contains('template-card--clickable')).toBe(true);
      expect(card.getAttribute('role')).toBe('button');
      expect(card.getAttribute('tabindex')).toBe('0');
      expect(card.getAttribute('aria-disabled')).toBeNull();
    }
  });

  it('Enter key on a focused card triggers the same action as click', () => {
    const handlers = snapshotHandlers();
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      handlers,
    );
    const card = cardForId(container, 'My Project Tpl');
    // dispatchEvent + KeyboardEvent so the @keydown handler runs.
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(handlers.calls).toEqual(['edit:my-tpl']);
  });

  it('Space key on a focused card triggers the same action as click', () => {
    const handlers = snapshotHandlers();
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      handlers,
    );
    const card = cardForId(container, 'My Project Tpl');
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
    );
    expect(handlers.calls).toEqual(['edit:my-tpl']);
  });

  it('other keys (Tab, arrows) do NOT activate the card', () => {
    const handlers = snapshotHandlers();
    container = mount(
      { templates: TEMPLATES, templatesLoaded: true, worcaCliStatus: HEALTHY },
      handlers,
    );
    const card = cardForId(container, 'My Project Tpl');
    for (const key of ['Tab', 'ArrowDown', 'ArrowUp', 'Escape']) {
      card.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    expect(handlers.calls).toEqual([]);
  });
});
