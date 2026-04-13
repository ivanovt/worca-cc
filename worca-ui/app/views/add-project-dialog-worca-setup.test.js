/**
 * Tests for the batch worca setup dialog with inline progress.
 * Plan cases 33-36.
 * @vitest-environment jsdom
 */

import { render } from 'lit-html';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _test,
  batchWorcaSetupDialogTemplate,
  offerBatchWorcaSetupForTest,
} from './add-project-dialog.js';

function renderToContainer(template) {
  const container = document.createElement('div');
  render(template, container);
  return container;
}

const makeRerender = () => vi.fn();

beforeEach(() => {
  _test.batchSetupOpen = false;
  _test.batchSetupItems = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('case 33 — status fetch renders checkboxes with correct labels', () => {
  it('renders 3 rows — not-installed checked, outdated checked, current unchecked', async () => {
    const fetchMock = vi
      .fn()
      // worca-status calls
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            ok: true,
            installed: false,
            version: null,
            outdated: false,
          }),
      })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            ok: true,
            installed: true,
            version: '0.5.2',
            outdated: true,
          }),
      })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            ok: true,
            installed: true,
            version: '0.6.0',
            outdated: false,
          }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const projects = [
      { name: 'auth', path: '/ws/auth' },
      { name: 'web', path: '/ws/web' },
      { name: 'utils', path: '/ws/utils' },
    ];

    const rerender = makeRerender();
    offerBatchWorcaSetupForTest(projects, rerender);

    // Wait for all fetch promises to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(_test.batchSetupOpen).toBe(true);

    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    const checkboxes = container.querySelectorAll('sl-checkbox');
    expect(checkboxes.length).toBe(3);

    // First two (not-installed, outdated) should be pre-checked
    expect(checkboxes[0].hasAttribute('checked')).toBe(true);
    expect(checkboxes[1].hasAttribute('checked')).toBe(true);
    // Last (current) should NOT be pre-checked
    expect(checkboxes[2].hasAttribute('checked')).toBe(false);

    const text = container.textContent;
    expect(text).toMatch(/not installed/i);
    expect(text).toMatch(/outdated/i);
    expect(text).toMatch(/current/i);
  });

  it('shows version in status label for outdated project', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          installed: true,
          version: '0.5.2',
          outdated: true,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const rerender = makeRerender();
    offerBatchWorcaSetupForTest([{ name: 'svc', path: '/ws/svc' }], rerender);
    await new Promise((r) => setTimeout(r, 0));

    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    expect(container.textContent).toContain('0.5.2');
  });

  it('shows version in status label for current project', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          installed: true,
          version: '0.6.0',
          outdated: false,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const rerender = makeRerender();
    offerBatchWorcaSetupForTest([{ name: 'svc', path: '/ws/svc' }], rerender);
    await new Promise((r) => setTimeout(r, 0));

    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    expect(container.textContent).toContain('0.6.0');
    expect(container.textContent).toMatch(/current/i);
  });
});

describe('case 34 — confirm triggers sequential worca-setup calls', () => {
  it('calls POST /worca-setup for each checked project', async () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'auth', statusLabel: 'not installed', checked: true },
      { name: 'web', statusLabel: 'outdated — v0.5.2', checked: true },
      { name: 'utils', statusLabel: 'v0.6.0 — current', checked: false },
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-confirm-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));

    // Only the 2 checked projects should have setup calls
    const setupCalls = fetchMock.mock.calls.filter(([url]) =>
      url.includes('/worca-setup'),
    );
    expect(setupCalls).toHaveLength(2);
    expect(setupCalls[0][0]).toBe('/api/projects/auth/worca-setup');
    expect(setupCalls[1][0]).toBe('/api/projects/web/worca-setup');
  });

  it('calls setup with POST method', async () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'svc', statusLabel: 'not installed', checked: true },
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-confirm-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/svc/worca-setup',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not call setup for unchecked projects', async () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'checked-svc', statusLabel: 'not installed', checked: true },
      {
        name: 'unchecked-svc',
        statusLabel: 'v0.6.0 — current',
        checked: false,
      },
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-confirm-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));

    const calls = fetchMock.mock.calls.map(([url]) => url);
    expect(calls).toContain('/api/projects/checked-svc/worca-setup');
    expect(calls).not.toContain('/api/projects/unchecked-svc/worca-setup');
  });
});

describe('case 35 — skip closes dialog without setup calls', () => {
  it('skip button closes the dialog without making setup calls', () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'auth', statusLabel: 'not installed', checked: true },
    ];

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-skip-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(_test.batchSetupOpen).toBe(false);
  });

  it('skip resets all batch setup state', () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'svc', statusLabel: 'not installed', checked: true },
    ];

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-skip-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(_test.batchSetupOpen).toBe(false);
    expect(_test.batchSetupItems).toHaveLength(0);
    expect(_test.batchSetupProgress.size).toBe(0);
    expect(rerender).toHaveBeenCalled();
  });

  it('renders nothing after skip', () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'svc', statusLabel: 'not installed', checked: true },
    ];

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-skip-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const afterContainer = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    expect(afterContainer.querySelector('#batch-setup-dialog')).toBeNull();
  });
});

describe('case 36 — setup progress shown inline', () => {
  it('shows spinner (pending) after confirm click and before fetch resolves', () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'auth', statusLabel: 'not installed', checked: true },
    ];

    // fetch never resolves during this test
    vi.stubGlobal('fetch', () => new Promise(() => {}));

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-confirm-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // handleInstall runs sync up to the first await fetch(...)
    // At this point progress should be 'pending'
    expect(_test.batchSetupProgress.get('auth')?.state).toBe('pending');

    const pendingContainer = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    expect(pendingContainer.querySelector('sl-spinner')).not.toBeNull();
  });

  it('shows checkmark (started) after fetch resolves successfully', async () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'auth', statusLabel: 'not installed', checked: true },
    ];

    let resolveFetch;
    const controlled = new Promise((r) => {
      resolveFetch = r;
    });
    vi.stubGlobal('fetch', () => controlled);

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-confirm-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Pending state before resolve
    expect(_test.batchSetupProgress.get('auth')?.state).toBe('pending');

    // Resolve the fetch
    resolveFetch({ ok: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(_test.batchSetupProgress.get('auth')?.state).toBe('started');

    const startedContainer = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    expect(startedContainer.textContent).toContain('✓');
    expect(startedContainer.querySelector('sl-spinner')).toBeNull();
  });

  it('shows error marker when fetch rejects', async () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'svc', statusLabel: 'not installed', checked: true },
    ];

    vi.stubGlobal('fetch', () =>
      Promise.reject(new Error('Connection refused')),
    );

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-confirm-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));

    expect(_test.batchSetupProgress.get('svc')?.state).toBe('failed');
    expect(_test.batchSetupProgress.get('svc')?.error).toBe(
      'Connection refused',
    );

    const failedContainer = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    expect(failedContainer.textContent).toContain('✗');
    expect(failedContainer.textContent).toContain('Connection refused');
  });

  it('installs projects sequentially — second starts after first resolves', async () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'first', statusLabel: 'not installed', checked: true },
      { name: 'second', statusLabel: 'not installed', checked: true },
    ];

    const resolvers = [];
    vi.stubGlobal('fetch', () => new Promise((r) => resolvers.push(r)));

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-confirm-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Only one fetch call made (sequential — first project)
    expect(resolvers).toHaveLength(1);
    expect(_test.batchSetupProgress.get('first')?.state).toBe('pending');
    expect(_test.batchSetupProgress.get('second')?.state).toBe('pending');

    // Resolve first
    resolvers[0]({ ok: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(_test.batchSetupProgress.get('first')?.state).toBe('started');
    // Second fetch now started
    expect(resolvers).toHaveLength(2);

    // Resolve second
    resolvers[1]({ ok: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(_test.batchSetupProgress.get('second')?.state).toBe('started');
  });

  it('disables checkboxes and confirm button while installing', () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'svc', statusLabel: 'not installed', checked: true },
    ];

    vi.stubGlobal('fetch', () => new Promise(() => {}));

    const rerender = makeRerender();
    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-confirm-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const installingContainer = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    expect(
      installingContainer
        .querySelector('#batch-setup-confirm-btn')
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      installingContainer.querySelector('sl-checkbox').hasAttribute('disabled'),
    ).toBe(true);
  });
});
