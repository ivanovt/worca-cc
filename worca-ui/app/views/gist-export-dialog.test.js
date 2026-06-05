/**
 * Tests for the gist-export dialog view (Export (gist) flow).
 *
 * Covers the three states driven by `state.gistDialog`:
 * - loading: spinner present, field shows "generating…", copy button disabled
 * - done: URL shown in the read-only field, copy button enabled
 * - error: error message shown, no copy button, Close button present
 *
 * Uses real lit-html rendered into a jsdom container (same harness as
 * pipelines-card-export.test.js) so we can query the live DOM.
 *
 * @vitest-environment jsdom
 */

import { render } from 'lit-html';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gistExportDialogView } from './gist-export-dialog.js';

function mount(state, options = {}) {
  const container = document.createElement('div');
  render(gistExportDialogView(state, options), container);
  return container;
}

function urlField(root) {
  return root.querySelector('.gist-export-url-field');
}

function copyBtn(root) {
  return root.querySelector('.gist-export-copy-btn');
}

function closeBtn(root) {
  return root.querySelector('.gist-export-close-btn');
}

describe('gistExportDialogView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when the dialog is closed', () => {
    const container = mount({ gistDialog: { open: false } });
    expect(container.querySelector('sl-dialog')).toBeNull();
  });

  it('renders nothing when gistDialog is absent', () => {
    const container = mount({});
    expect(container.querySelector('sl-dialog')).toBeNull();
  });

  describe('loading state', () => {
    const state = {
      gistDialog: {
        open: true,
        status: 'loading',
        url: null,
        error: null,
        templateName: 'my-tpl',
        copied: false,
      },
    };

    it('shows the spinner while generating', () => {
      const container = mount(state);
      expect(container.querySelector('sl-spinner')).not.toBeNull();
    });

    it('shows the "generating…" placeholder in the URL field', () => {
      const container = mount(state);
      expect(urlField(container)?.getAttribute('value')).toBe('generating…');
    });

    it('disables the copy button', () => {
      const container = mount(state);
      const btn = copyBtn(container);
      expect(btn).not.toBeNull();
      expect(btn.hasAttribute('disabled')).toBe(true);
    });

    it('renders a working Close button during loading', () => {
      const onClose = vi.fn();
      const container = mount(state, { onClose });
      const btn = closeBtn(container);
      expect(btn).not.toBeNull();
      btn.dispatchEvent(new Event('click'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('done state', () => {
    const URL = 'https://gist.github.com/user/abc123';
    const state = {
      gistDialog: {
        open: true,
        status: 'done',
        url: URL,
        error: null,
        templateName: 'my-tpl',
        copied: false,
      },
    };

    it('shows the gist URL in the read-only field', () => {
      const container = mount(state);
      const field = urlField(container);
      expect(field?.getAttribute('value')).toBe(URL);
      expect(field?.hasAttribute('readonly')).toBe(true);
    });

    it('drops the spinner once the URL is ready', () => {
      const container = mount(state);
      expect(container.querySelector('sl-spinner')).toBeNull();
    });

    it('enables the copy button', () => {
      const container = mount(state);
      const btn = copyBtn(container);
      expect(btn).not.toBeNull();
      expect(btn.hasAttribute('disabled')).toBe(false);
    });

    it('invokes onCopy with the URL when the copy button is clicked', () => {
      const onCopy = vi.fn();
      const container = mount(state, { onCopy });
      copyBtn(container).dispatchEvent(new Event('click'));
      expect(onCopy).toHaveBeenCalledWith(URL);
    });

    it('shows "Copied" feedback label when copied is true', () => {
      const container = mount({
        gistDialog: { ...state.gistDialog, copied: true },
      });
      const btn = copyBtn(container);
      // The copy button is an sl-button with a slotted icon + visible text
      // label (sl-icon-button ignores slotted Lucide SVGs, so it rendered
      // invisible) — assert on the rendered text.
      expect(btn.textContent).toContain('Copied');
      expect(btn.classList.contains('is-copied')).toBe(true);
    });
  });

  describe('error state', () => {
    const state = {
      gistDialog: {
        open: true,
        status: 'error',
        url: null,
        error: 'GitHub CLI (gh) is not available on the server',
        templateName: 'my-tpl',
        copied: false,
      },
    };

    it('shows the error message in place of the URL', () => {
      const container = mount(state);
      expect(urlField(container)?.getAttribute('value')).toBe(
        'GitHub CLI (gh) is not available on the server',
      );
    });

    it('does not render a copy button on error', () => {
      const container = mount(state);
      expect(copyBtn(container)).toBeNull();
    });

    it('still renders a working Close button', () => {
      const onClose = vi.fn();
      const container = mount(state, { onClose });
      const btn = closeBtn(container);
      expect(btn).not.toBeNull();
      btn.dispatchEvent(new Event('click'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
