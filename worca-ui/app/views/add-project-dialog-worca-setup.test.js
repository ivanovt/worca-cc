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

/**
 * Build a fetch mock that routes by URL.
 *  - /api/versions           → returns { activeWorcaCc: '0.6.0' } by default
 *  - /worca-status           → returns entries from `statuses` in order
 *  - anything else (setup)   → returns { ok: true }
 */
function makeFetchMock({
  statuses = [],
  versions = { activeWorcaCc: '0.6.0' },
} = {}) {
  let idx = 0;
  return vi.fn().mockImplementation((url) => {
    if (url === '/api/versions') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(versions),
      });
    }
    if (typeof url === 'string' && url.includes('/worca-status')) {
      const payload = statuses[idx] || {
        ok: false,
        installed: false,
        version: null,
      };
      idx += 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  });
}

beforeEach(() => {
  _test.batchSetupOpen = false;
  _test.batchSetupItems = [];
  _test.batchSetupCompleted = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('case 33 — status fetch renders checkboxes with version badges', () => {
  it('renders 3 rows — all pre-checked regardless of install status', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        statuses: [
          { ok: true, installed: false, version: null },
          { ok: true, installed: true, version: '0.5.2' },
          { ok: true, installed: true, version: '0.6.0' },
        ],
      }),
    );

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

    // All three should be pre-checked — the user just picked these projects,
    // so default intent is to set up worca on all of them. Badges differentiate
    // current vs outdated visually.
    expect(checkboxes[0].hasAttribute('checked')).toBe(true);
    expect(checkboxes[1].hasAttribute('checked')).toBe(true);
    expect(checkboxes[2].hasAttribute('checked')).toBe(true);

    const text = container.textContent;
    expect(text).toMatch(/not installed/i);
    expect(text).toContain('0.5.2');
    expect(text).toContain('0.6.0');
  });

  it('uses warning badge for behind version, success for current', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        statuses: [
          { ok: true, installed: true, version: '0.5.2' },
          { ok: true, installed: true, version: '0.6.0' },
        ],
      }),
    );

    const rerender = makeRerender();
    offerBatchWorcaSetupForTest(
      [
        { name: 'behind', path: '/ws/behind' },
        { name: 'current', path: '/ws/current' },
      ],
      rerender,
    );
    await new Promise((r) => setTimeout(r, 0));

    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    const badges = container.querySelectorAll('sl-badge');
    expect(badges.length).toBe(2);
    expect(badges[0].getAttribute('variant')).toBe('warning');
    expect(badges[1].getAttribute('variant')).toBe('success');
  });

  it('uses warning badge when installed but version is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        statuses: [{ ok: true, installed: true, version: null }],
      }),
    );

    const rerender = makeRerender();
    offerBatchWorcaSetupForTest([{ name: 'svc', path: '/ws/svc' }], rerender);
    await new Promise((r) => setTimeout(r, 0));

    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );
    const badge = container.querySelector('sl-badge');
    expect(badge.getAttribute('variant')).toBe('warning');
    expect(badge.textContent).toContain('unknown');
    // Should be pre-checked (unknown version is treated as needing install)
    expect(container.querySelector('sl-checkbox').hasAttribute('checked')).toBe(
      true,
    );
  });
});

describe('case 34 — confirm triggers sequential worca-setup calls', () => {
  it('calls POST /worca-setup for each checked project', async () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'auth', installed: false, version: null, checked: true },
      { name: 'web', installed: true, version: '0.5.2', checked: true },
      { name: 'utils', installed: true, version: '0.6.0', checked: false },
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
      { name: 'svc', installed: false, version: null, checked: true },
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
      {
        name: 'checked-svc',
        installed: false,
        version: null,
        checked: true,
      },
      {
        name: 'unchecked-svc',
        installed: true,
        version: '0.6.0',
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
      { name: 'auth', installed: false, version: null, checked: true },
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
      { name: 'svc', installed: false, version: null, checked: true },
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
      { name: 'svc', installed: false, version: null, checked: true },
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

  it('invokes onClose callback after the dialog is dismissed', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        statuses: [{ ok: true, installed: false, version: null }],
      }),
    );

    const rerender = makeRerender();
    const onClose = vi.fn();
    offerBatchWorcaSetupForTest(
      [{ name: 'svc', path: '/ws/svc' }],
      rerender,
      onClose,
    );
    await new Promise((r) => setTimeout(r, 0));

    const container = renderToContainer(
      batchWorcaSetupDialogTemplate(rerender),
    );

    container
      .querySelector('#batch-setup-skip-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('case 36 — setup progress shown inline', () => {
  it('shows spinner (pending) after confirm click and before fetch resolves', () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'auth', installed: false, version: null, checked: true },
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
      { name: 'auth', installed: false, version: null, checked: true },
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
      { name: 'svc', installed: false, version: null, checked: true },
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
      { name: 'first', installed: false, version: null, checked: true },
      { name: 'second', installed: false, version: null, checked: true },
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

  it('replaces checkboxes with spinner and disables confirm button while installing', () => {
    _test.batchSetupOpen = true;
    _test.batchSetupItems = [
      { name: 'svc', installed: false, version: null, checked: true },
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
    // During install, rows no longer expose an sl-checkbox — spinner replaces it
    expect(installingContainer.querySelector('sl-checkbox')).toBeNull();
    expect(installingContainer.querySelector('sl-spinner')).not.toBeNull();
  });
});
