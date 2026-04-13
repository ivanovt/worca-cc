/**
 * Tests for Add Project dialog workspace batch submit flow.
 * Plan cases 26-30.
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
  _test.dialogError = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('case 26 — submit calls batch endpoint', () => {
  it('POSTs to /api/projects/batch with selected entries', async () => {
    _test.scannedFolders = [
      { name: 'auth-service', path: '/ws/auth-service' },
      { name: 'web-app', path: '/ws/web-app' },
    ];
    _test.selectedFolders = new Set([0, 1]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            ok: true,
            projects: [
              { name: 'auth-service', path: '/ws/auth-service' },
              { name: 'web-app', path: '/ws/web-app' },
            ],
          }),
      })
      // stub follow-up worca-status calls
      .mockResolvedValue({
        json: () => Promise.resolve({ ok: false }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const callbacks = makeCallbacks();
    const container = renderToContainer(
      addProjectDialogView(baseState, callbacks),
    );

    const submitBtn = container.querySelector('#submit-btn');
    submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // wait for microtask queue to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projects: [
            { name: 'auth-service', path: '/ws/auth-service' },
            { name: 'web-app', path: '/ws/web-app' },
          ],
        }),
      }),
    );
  });

  it('calls onProjectAdd with the returned projects array on success', async () => {
    _test.scannedFolders = [{ name: 'my-svc', path: '/ws/my-svc' }];
    _test.selectedFolders = new Set([0]);

    const returnedProjects = [{ name: 'my-svc', path: '/ws/my-svc' }];
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        json: () => Promise.resolve({ ok: true, projects: returnedProjects }),
      }),
    );

    const callbacks = makeCallbacks();
    const container = renderToContainer(
      addProjectDialogView(baseState, callbacks),
    );

    container
      .querySelector('#submit-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));

    expect(callbacks.onProjectAdd).toHaveBeenCalledWith(returnedProjects);
  });
});

describe('case 27 — submit button shows count', () => {
  it('button reads "Add 2 Projects" when 2 of 4 folders selected', () => {
    _test.scannedFolders = [
      { name: 'alpha', path: '/ws/alpha' },
      { name: 'beta', path: '/ws/beta' },
      { name: 'gamma', path: '/ws/gamma' },
      { name: 'delta', path: '/ws/delta' },
    ];
    _test.selectedFolders = new Set([0, 1]);

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );

    const submitBtn = container.querySelector('#submit-btn');
    expect(submitBtn.textContent.trim()).toBe('Add 2 Projects');
  });

  it('button reads "Add 1 Project" (singular) when exactly 1 selected', () => {
    _test.scannedFolders = [{ name: 'alpha', path: '/ws/alpha' }];
    _test.selectedFolders = new Set([0]);

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );

    const submitBtn = container.querySelector('#submit-btn');
    expect(submitBtn.textContent.trim()).toBe('Add 1 Project');
  });

  it('button reads "Add Project" in single mode', () => {
    _test.dialogMode = 'single';

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );

    const submitBtn = container.querySelector('#submit-btn');
    expect(submitBtn.textContent.trim()).toBe('Add Project');
  });
});

describe('case 28 — submit disabled when none selected', () => {
  it('disables submit button when no folders are selected', () => {
    _test.scannedFolders = [{ name: 'alpha', path: '/ws/alpha' }];
    _test.selectedFolders = new Set();

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );

    expect(
      container.querySelector('#submit-btn').hasAttribute('disabled'),
    ).toBe(true);
  });

  it('submit is enabled when at least one folder is selected', () => {
    _test.scannedFolders = [{ name: 'alpha', path: '/ws/alpha' }];
    _test.selectedFolders = new Set([0]);

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );

    expect(
      container.querySelector('#submit-btn').hasAttribute('disabled'),
    ).toBe(false);
  });

  it('disables submit while scan is in progress', () => {
    _test.scannedFolders = [{ name: 'alpha', path: '/ws/alpha' }];
    _test.selectedFolders = new Set([0]);
    _test.scanning = true;

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );

    expect(
      container.querySelector('#submit-btn').hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('case 30 — submit error shown in dialog', () => {
  it('sets dialogError and does not call onProjectAdd when server returns 400', async () => {
    _test.scannedFolders = [{ name: 'auth', path: '/ws/auth' }];
    _test.selectedFolders = new Set([0]);

    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        json: () =>
          Promise.resolve({ ok: false, error: 'Batch failed: duplicate name' }),
      }),
    );

    const callbacks = makeCallbacks();
    const container = renderToContainer(
      addProjectDialogView(baseState, callbacks),
    );

    container
      .querySelector('#submit-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));

    expect(_test.dialogError).toBe('Batch failed: duplicate name');
    expect(callbacks.onProjectAdd).not.toHaveBeenCalled();
  });

  it('preserves selections when batch submit fails', async () => {
    _test.scannedFolders = [
      { name: 'svc-a', path: '/ws/svc-a' },
      { name: 'svc-b', path: '/ws/svc-b' },
    ];
    _test.selectedFolders = new Set([0, 1]);

    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        json: () => Promise.resolve({ ok: false, error: 'Server error' }),
      }),
    );

    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );

    container
      .querySelector('#submit-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));

    expect(_test.selectedFolders.size).toBe(2);
  });

  it('shows network error message when fetch rejects', async () => {
    _test.scannedFolders = [{ name: 'svc-a', path: '/ws/svc-a' }];
    _test.selectedFolders = new Set([0]);

    vi.stubGlobal('fetch', () => Promise.reject(new Error('Network failure')));

    const callbacks = makeCallbacks();
    const container = renderToContainer(
      addProjectDialogView(baseState, callbacks),
    );

    container
      .querySelector('#submit-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));

    expect(_test.dialogError).toBe('Network failure');
    expect(callbacks.onProjectAdd).not.toHaveBeenCalled();
  });
});
