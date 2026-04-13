/**
 * Tests for Add Project dialog workspace scan + checkbox list.
 * Plan cases 21-25.
 * @vitest-environment jsdom
 */

import { render } from 'lit-html';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _test, addProjectDialogView } from './add-project-dialog.js';

function renderToContainer(template) {
  const container = document.createElement('div');
  render(template, container);
  return container;
}

const baseState = { addProjectDialogOpen: true, projects: [] };
const makeCallbacks = () => ({
  onProjectAdd: vi.fn(),
  onClose: vi.fn(),
  rerender: vi.fn(),
});

beforeEach(() => {
  _test.dialogMode = 'workspace';
  _test.scannedFolders = [];
  _test.selectedFolders = new Set();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('case 21 — path change triggers scan', () => {
  it('calls POST /api/scan-directory after debounce fires', () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, subfolders: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    const pathEl = container.querySelector('#add-project-path');

    pathEl.value = '/workspace/projects';
    pathEl.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));

    // Before debounce: fetch not yet called
    expect(fetchMock).not.toHaveBeenCalled();

    // Advance past 300ms debounce
    vi.advanceTimersByTime(350);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/scan-directory',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/workspace/projects' }),
      }),
    );
  });

  it('does not trigger scan for non-absolute path', () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    const pathEl = container.querySelector('#add-project-path');

    pathEl.value = 'relative/path';
    pathEl.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
    vi.advanceTimersByTime(350);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('case 22 — scan results render checkbox list', () => {
  it('renders one sl-checkbox per scanned folder', () => {
    _test.scannedFolders = [
      { name: 'auth-service', path: '/ws/auth-service' },
      { name: 'web-app', path: '/ws/web-app' },
      { name: 'api-gateway', path: '/ws/api-gateway' },
    ];
    _test.selectedFolders = new Set([0, 1, 2]);

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    const checkboxes = container.querySelectorAll('sl-checkbox');
    expect(checkboxes.length).toBe(3);
  });

  it('renders checkboxes inside #workspace-scan-area', () => {
    _test.scannedFolders = [
      { name: 'alpha', path: '/ws/alpha' },
      { name: 'beta', path: '/ws/beta' },
    ];

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    const scanArea = container.querySelector('#workspace-scan-area');
    expect(scanArea).not.toBeNull();
    expect(scanArea.querySelectorAll('sl-checkbox').length).toBe(2);
  });

  it('shows select-all and select-none links when results present', () => {
    _test.scannedFolders = [{ name: 'foo', path: '/ws/foo' }];

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#select-all-link')).not.toBeNull();
    expect(container.querySelector('#select-none-link')).not.toBeNull();
  });
});

describe('case 23 — already-registered paths shown disabled', () => {
  it('disables checkbox for a path that is already registered', () => {
    const stateWithProjects = {
      addProjectDialogOpen: true,
      projects: [{ name: 'existing', path: '/ws/existing' }],
    };
    _test.scannedFolders = [
      { name: 'existing', path: '/ws/existing' },
      { name: 'new-project', path: '/ws/new-project' },
    ];

    const container = renderToContainer(
      addProjectDialogView(stateWithProjects, makeCallbacks()),
    );
    const checkboxes = container.querySelectorAll('sl-checkbox');
    expect(checkboxes.length).toBe(2);
    // existing path → disabled
    expect(checkboxes[0].hasAttribute('disabled')).toBe(true);
    // new path → not disabled
    expect(checkboxes[1].hasAttribute('disabled')).toBe(false);
  });

  it('shows "(already registered)" label for disabled entries', () => {
    const stateWithProjects = {
      addProjectDialogOpen: true,
      projects: [{ name: 'existing', path: '/ws/existing' }],
    };
    _test.scannedFolders = [{ name: 'existing', path: '/ws/existing' }];

    const container = renderToContainer(
      addProjectDialogView(stateWithProjects, makeCallbacks()),
    );
    expect(container.textContent).toContain('already registered');
  });

  it('auto-selects non-registered entries and skips registered ones', () => {
    const stateWithProjects = {
      addProjectDialogOpen: true,
      projects: [{ name: 'existing', path: '/ws/existing' }],
    };
    _test.scannedFolders = [
      { name: 'existing', path: '/ws/existing' }, // index 0 — registered
      { name: 'new-one', path: '/ws/new-one' }, // index 1 — selectable
    ];
    _test.selectedFolders = new Set([1]); // simulate auto-select of non-registered

    const container = renderToContainer(
      addProjectDialogView(stateWithProjects, makeCallbacks()),
    );
    const checkboxes = container.querySelectorAll('sl-checkbox');
    // Disabled checkbox should not have checked attribute
    expect(checkboxes[0].hasAttribute('disabled')).toBe(true);
    // Non-disabled checkbox should reflect selection (index 1 is selected)
    expect(checkboxes[1].hasAttribute('checked')).toBe(true);
  });
});

describe('case 24 — select all / select none toggles', () => {
  it('select-all marks all selectable indices in selectedFolders', () => {
    _test.scannedFolders = [
      { name: 'alpha', path: '/ws/alpha' },
      { name: 'beta', path: '/ws/beta' },
      { name: 'gamma', path: '/ws/gamma' },
    ];
    _test.selectedFolders = new Set(); // start with none selected

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    const selectAllLink = container.querySelector('#select-all-link');
    expect(selectAllLink).not.toBeNull();

    selectAllLink.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    const selected = _test.selectedFolders;
    expect(selected.size).toBe(3);
    expect(selected.has(0)).toBe(true);
    expect(selected.has(1)).toBe(true);
    expect(selected.has(2)).toBe(true);
  });

  it('select-none clears all selections from selectedFolders', () => {
    _test.scannedFolders = [
      { name: 'alpha', path: '/ws/alpha' },
      { name: 'beta', path: '/ws/beta' },
    ];
    _test.selectedFolders = new Set([0, 1]); // start with all selected

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    const selectNoneLink = container.querySelector('#select-none-link');
    expect(selectNoneLink).not.toBeNull();

    selectNoneLink.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    const selected = _test.selectedFolders;
    expect(selected.size).toBe(0);
  });

  it('select-all skips already-registered folders', () => {
    const stateWithProjects = {
      addProjectDialogOpen: true,
      projects: [{ name: 'existing', path: '/ws/existing' }],
    };
    _test.scannedFolders = [
      { name: 'existing', path: '/ws/existing' }, // index 0 — registered, skipped
      { name: 'new-one', path: '/ws/new-one' }, // index 1 — selectable
    ];
    _test.selectedFolders = new Set();

    const container = renderToContainer(
      addProjectDialogView(stateWithProjects, makeCallbacks()),
    );
    container
      .querySelector('#select-all-link')
      .dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );

    const selected = _test.selectedFolders;
    expect(selected.has(0)).toBe(false); // registered — must not be selected
    expect(selected.has(1)).toBe(true);
  });
});

describe('case 25 — path change aborts previous scan', () => {
  it('aborts the first in-flight fetch when path changes again', () => {
    vi.useFakeTimers();

    const signals = [];
    vi.stubGlobal('fetch', (_url, opts) => {
      if (opts?.signal) signals.push(opts.signal);
      return new Promise(() => {}); // never resolves — keeps scan "in-flight"
    });

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    const pathEl = container.querySelector('#add-project-path');

    // First path change → debounce fires → scan1 starts
    pathEl.value = '/path/one';
    pathEl.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
    vi.advanceTimersByTime(350);

    expect(signals).toHaveLength(1);
    const firstSignal = signals[0];
    expect(firstSignal.aborted).toBe(false);

    // Second path change → debounce fires → scan2 starts, scan1 aborted
    pathEl.value = '/path/two';
    pathEl.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
    vi.advanceTimersByTime(350);

    expect(firstSignal.aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(false);
  });

  it('path changes within debounce window do not start multiple fetches', () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, subfolders: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    const pathEl = container.querySelector('#add-project-path');

    // Rapid successive inputs within 300ms window
    pathEl.value = '/path/a';
    pathEl.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
    vi.advanceTimersByTime(100);

    pathEl.value = '/path/b';
    pathEl.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
    vi.advanceTimersByTime(100);

    pathEl.value = '/path/c';
    pathEl.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));
    vi.advanceTimersByTime(350);

    // Only the last input's debounce fires
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/scan-directory',
      expect.objectContaining({ body: JSON.stringify({ path: '/path/c' }) }),
    );
  });
});
