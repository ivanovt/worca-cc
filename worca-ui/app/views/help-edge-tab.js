/**
 * Help edge tab — PROTOTYPE (W-061, prototype/W-061-help-mode-toggle).
 *
 * The persistent right-edge affordance that activates "help mode" — when
 * pressed, every UI element that registered via `helpFor(id)` reveals a
 * glowing badge linking to the relevant doc page.
 *
 * Visual: vertically rotated label "Help (?)" anchored to the middle of the
 * right edge of the viewport, distinguishable from chat-widget conventions
 * (we use the lucide CircleHelp icon + an explicit "?" keyboard hint to make
 * the docs intent legible).
 *
 * Mounted once at bootstrap by main.js into a fixed-position root outside
 * the app's lit-html render container, so route changes don't unmount it
 * and the toggle state lives across navigation.
 */

import { html, render } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { isActive, subscribe, toggle } from '../utils/help-mode.js';
import { CircleHelp, iconSvg } from '../utils/icons.js';

/**
 * Render the edge tab into the given root. Returns an unsubscribe function
 * that disconnects the help-mode listener (tests; never called in prod).
 *
 * The view re-renders only when help-mode state flips, not on every app
 * re-render — keeps it cheap and decoupled from the main render loop.
 */
export function mountHelpEdgeTab(root) {
  if (!root) return () => {};

  function _render() {
    const active = isActive();
    render(
      html`
        <button
          type="button"
          class="help-edge-tab ${active ? 'help-edge-tab--active' : ''}"
          aria-pressed=${active ? 'true' : 'false'}
          aria-label=${active ? 'Close docs mode' : 'Open docs mode (shortcut: ?)'}
          title=${active ? 'Close docs mode (Esc)' : 'Show doc badges (?)'}
          @click=${() => toggle()}
        >
          <span class="help-edge-tab__inner">
            <span class="help-edge-tab__icon">${unsafeHTML(iconSvg(CircleHelp, 20))}</span>
            <span class="help-edge-tab__label">Docs</span>
          </span>
        </button>
      `,
      root,
    );
  }

  _render();
  return subscribe(_render);
}
