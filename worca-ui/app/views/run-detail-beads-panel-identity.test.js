/**
 * Pins GH issue #180: the Beads <sl-details> panel must keep its element
 * identity (and open state) across beads.length === 0 ↔ > 0 transitions.
 *
 * Pre-fix, runBeadsSectionView returned two distinct html`` templates for
 * the empty and non-empty cases. lit-html tears down the DOM on a template
 * swap, so the new <sl-details> mounted without ?open and the user's open
 * panel collapsed on every transient bd contention blip.
 *
 * @vitest-environment jsdom
 */

import { render } from 'lit-html';
import { describe, expect, it } from 'vitest';
import { runBeadsSectionView } from './run-detail.js';

function makeBeads(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `worca-cc-${i}`,
    title: `Bead ${i}`,
    status: 'open',
    priority: 2,
    blocked_by: [],
    depends_on: [],
  }));
}

describe('runBeadsSectionView - sl-details identity across empty flip', () => {
  it('reuses the same <sl-details> node when beads goes 18 -> 0 -> 18', () => {
    const container = document.createElement('div');

    render(runBeadsSectionView(makeBeads(18)), container);
    const firstDetails = container.querySelector('sl-details');
    expect(firstDetails).toBeTruthy();

    // Simulate the user opening the panel (real <sl-details> would handle
    // the property; in jsdom it's a plain custom element, so we set the
    // attribute directly — the test cares about node identity, not
    // shoelace's internal state machine).
    firstDetails.setAttribute('open', '');

    render(runBeadsSectionView([]), container);
    const emptyDetails = container.querySelector('sl-details');
    expect(emptyDetails).toBe(firstDetails);

    render(runBeadsSectionView(makeBeads(18)), container);
    const finalDetails = container.querySelector('sl-details');
    expect(finalDetails).toBe(firstDetails);
    expect(finalDetails.hasAttribute('open')).toBe(true);
  });

  it('renders empty-state message only when beads is empty', () => {
    const container = document.createElement('div');

    render(runBeadsSectionView(makeBeads(3)), container);
    expect(container.querySelector('.run-beads-empty')).toBeNull();
    expect(container.querySelector('.run-beads-list')).toBeTruthy();
    expect(container.querySelector('sl-badge')).toBeTruthy();

    render(runBeadsSectionView([]), container);
    expect(container.querySelector('.run-beads-empty')).toBeTruthy();
    expect(container.querySelector('.run-beads-list')).toBeNull();
    // The count badge should be hidden when empty.
    const summary = container.querySelector('.run-beads-header');
    expect(summary.querySelector('sl-badge')).toBeNull();
  });
});
