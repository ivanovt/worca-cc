// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _ensurePlanItersFetched,
  _ensureRunPlanFetched,
} from './run-detail.js';

let nextId = 0;
function makeRun() {
  return {
    id: `plan-cache-${++nextId}`,
    project: 'proj',
    worktree_path: '/tmp/wt',
    stages: { plan: { status: 'completed' } },
  };
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// _ensureRunPlanFetched (plan text)
// ---------------------------------------------------------------------------
describe('plan text cache (_ensureRunPlanFetched)', () => {
  it('does not cache on 404 — re-fetches on next call', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    });
    const run = makeRun();
    const rerender = vi.fn();

    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(rerender).toHaveBeenCalled();

    globalThis.fetch.mockClear();
    rerender.mockClear();
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    });

    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches successfully after a prior 404', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    });
    const run = makeRun();
    const rerender = vi.fn();

    _ensureRunPlanFetched(run, null, rerender);
    await flush();

    globalThis.fetch.mockClear();
    rerender.mockClear();
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('# My Plan'),
    });

    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(rerender).toHaveBeenCalled();

    // Now it should be cached — no more fetches
    globalThis.fetch.mockClear();
    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('caches on success — does NOT re-fetch on next call', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('# Plan'),
    });
    const run = makeRun();
    const rerender = vi.fn();

    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch.mockClear();
    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not cache on network error — re-fetches on next call', async () => {
    globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const run = makeRun();
    const rerender = vi.fn();

    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch.mockClear();
    globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    _ensureRunPlanFetched(run, null, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// _ensurePlanItersFetched (plan iterations)
// ---------------------------------------------------------------------------
describe('plan iterations cache (_ensurePlanItersFetched)', () => {
  it('does not cache on 404 — re-fetches on next call', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
    const run = makeRun();
    const rerender = vi.fn();

    _ensurePlanItersFetched(run, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch.mockClear();
    rerender.mockClear();
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });

    _ensurePlanItersFetched(run, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches successfully after a prior 404', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
    const run = makeRun();
    const rerender = vi.fn();

    _ensurePlanItersFetched(run, rerender);
    await flush();

    globalThis.fetch.mockClear();
    rerender.mockClear();
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ iterations: [{ n: 1, file: 'plan-001.md' }] }),
    });

    _ensurePlanItersFetched(run, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Now cached
    globalThis.fetch.mockClear();
    _ensurePlanItersFetched(run, rerender);
    await flush();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('caches on success — does NOT re-fetch on next call', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ iterations: [{ n: 1, file: 'plan-001.md' }] }),
    });
    const run = makeRun();
    const rerender = vi.fn();

    _ensurePlanItersFetched(run, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch.mockClear();
    _ensurePlanItersFetched(run, rerender);
    await flush();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not cache on network error — re-fetches on next call', async () => {
    globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const run = makeRun();
    const rerender = vi.fn();

    _ensurePlanItersFetched(run, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch.mockClear();
    globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    _ensurePlanItersFetched(run, rerender);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
