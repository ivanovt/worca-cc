/**
 * Help-mode state machine — PROTOTYPE (W-061, prototype/W-061-help-mode-toggle).
 *
 * Owns:
 *   - The body.help-mode-active class that gates badge visibility.
 *   - The `?` keyboard shortcut (Shift+/ on US keyboards) that toggles it.
 *   - The Escape keybinding that closes help mode.
 *
 * The right-edge tab (help-edge-tab.js) and the main.js bootstrap both call
 * toggle()/setActive()/isActive(). Subscribers (the edge tab's aria-pressed
 * state, any future help-mode indicator) listen via subscribe().
 *
 * Why a tiny module instead of inlining into main.js:
 *   - main.js is already ~5k lines; cross-cutting UI state with a defined
 *     contract is the kind of thing a separate module makes testable.
 *   - The edge tab needs to read state on every render — having a single
 *     authoritative getter avoids the "two booleans drift" bug.
 */

let _active = false;
const _listeners = new Set();

/** @returns {boolean} */
export function isActive() {
  return _active;
}

/**
 * Force state. Idempotent — no-ops if already in the target state.
 * @param {boolean} next
 */
export function setActive(next) {
  const v = Boolean(next);
  if (v === _active) return;
  _active = v;
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('help-mode-active', _active);
  }
  for (const cb of _listeners) {
    try {
      cb(_active);
    } catch (err) {
      // Don't let one bad listener break the rest.
      if (typeof console !== 'undefined')
        console.error('help-mode listener threw', err);
    }
  }
}

/** Flip active ↔ inactive. */
export function toggle() {
  setActive(!_active);
}

/**
 * Subscribe to active-state changes. Returns an unsubscribe fn.
 * @param {(active: boolean) => void} cb
 * @returns {() => void}
 */
export function subscribe(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/**
 * Should the `?` keypress be swallowed for help-mode toggling, or is the
 * user typing into an input/textarea/contentEditable? Mirrors GitHub's
 * shortcut-guard convention.
 */
function _isTypingContext(target) {
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  // Shoelace inputs delegate focus to a shadow-DOM <input>; the event's
  // composedPath() target is the host element, which is sl-input /
  // sl-textarea. Check the tag explicitly.
  if (
    tag.startsWith('sl-') &&
    (tag.includes('input') || tag.includes('textarea'))
  ) {
    return true;
  }
  return false;
}

let _bound = false;

/**
 * Wire up global keybindings. Idempotent — safe to call from main.js
 * bootstrap. Returns the keydown handler so tests can detach it.
 */
export function bindKeyboard() {
  if (_bound || typeof window === 'undefined') return null;
  _bound = true;
  const handler = (e) => {
    // Skip if user is typing in a field.
    if (_isTypingContext(e.target)) return;
    // Skip if any modifier other than Shift is held (Shift is required
    // for `?` on US keyboards; Ctrl/Meta/Alt + ? is left alone for the
    // browser).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '?') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape' && _active) {
      e.preventDefault();
      setActive(false);
    }
  };
  window.addEventListener('keydown', handler);
  return handler;
}

// Test seam — never call from production code.
export function _resetForTests() {
  _active = false;
  _listeners.clear();
  _bound = false;
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.remove('help-mode-active');
  }
}
