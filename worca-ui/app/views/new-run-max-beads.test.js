/**
 * Tests: new-run.js Max Beads dropdown — seed from template, reseed on switch,
 * and maxBeads always present in submit body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lit-html', () => ({ html: () => null, nothing: null }));
vi.mock('lit-html/directives/unsafe-html.js', () => ({
  unsafeHTML: () => null,
}));
vi.mock('../utils/icons.js', () => ({
  iconSvg: () => '',
  FileText: 'FileText',
  Circle: 'Circle',
  CircleAlert: 'CircleAlert',
  CircleCheck: 'CircleCheck',
  CircleSlash: 'CircleSlash',
  Loader: 'Loader',
  Pause: 'Pause',
}));

function createDocStub() {
  const elements = {};
  return {
    getElementById: vi.fn((id) => elements[id] || null),
    _set(id, value) {
      elements[id] = { value, id };
    },
    _clear() {
      for (const k of Object.keys(elements)) delete elements[k];
    },
  };
}

describe('new-run — maxBeads seeding from template', () => {
  let origFetch;
  let newRunView, resetNewRunState;

  beforeEach(async () => {
    origFetch = globalThis.fetch;

    vi.resetModules();
    vi.doMock('lit-html', () => ({ html: () => null, nothing: null }));
    vi.doMock('lit-html/directives/unsafe-html.js', () => ({
      unsafeHTML: () => null,
    }));
    vi.doMock('../utils/icons.js', () => ({
      iconSvg: () => '',
      FileText: 'FileText',
      Circle: 'Circle',
      CircleAlert: 'CircleAlert',
      CircleCheck: 'CircleCheck',
      CircleSlash: 'CircleSlash',
      Loader: 'Loader',
      Pause: 'Pause',
    }));
    vi.doMock('./settings.js', () => ({
      getDefaults: () => ({ msize: 1, mloops: 1 }),
    }));

    const mod = await import('./new-run.js');
    newRunView = mod.newRunView;
    resetNewRunState = mod.resetNewRunState;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('seeds maxBeads from template.config.agents.coordinator.max_beads on template fetch', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/templates')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              templates: [
                {
                  id: 'fast-track',
                  name: 'Fast Track',
                  tier: 'builtin',
                  config: { agents: { coordinator: { max_beads: 3 } } },
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, branches: [] }),
      });
    });

    resetNewRunState({ selectedTemplate: 'fast-track' });
    newRunView({ currentProjectId: 'proj-abc' }, { rerender: vi.fn() });

    await new Promise((r) => setTimeout(r, 100));

    const mod = await import('./new-run.js');
    expect(mod.maxBeads).toBe(3);
  });

  it('seeds maxBeads to 0 when template has no max_beads config', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/templates')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              templates: [
                {
                  id: 'plain',
                  name: 'Plain',
                  tier: 'builtin',
                  config: {},
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, branches: [] }),
      });
    });

    resetNewRunState({ selectedTemplate: 'plain', maxBeads: 5 });
    newRunView({ currentProjectId: 'proj-abc' }, { rerender: vi.fn() });

    await new Promise((r) => setTimeout(r, 100));

    const mod = await import('./new-run.js');
    expect(mod.maxBeads).toBe(0);
  });

  it('reseeds maxBeads when template is switched', async () => {
    const templates = [
      {
        id: 'tmpl-a',
        name: 'A',
        tier: 'builtin',
        config: { agents: { coordinator: { max_beads: 4 } } },
      },
      {
        id: 'tmpl-b',
        name: 'B',
        tier: 'builtin',
        config: { agents: { coordinator: { max_beads: 7 } } },
      },
    ];

    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/templates')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, templates }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, branches: [] }),
      });
    });

    resetNewRunState({ selectedTemplate: 'tmpl-a' });
    newRunView({ currentProjectId: 'proj-abc' }, { rerender: vi.fn() });
    await new Promise((r) => setTimeout(r, 100));

    let mod = await import('./new-run.js');
    expect(mod.maxBeads).toBe(4);

    // Switch template — simulate sl-change event on the select
    const rerender = vi.fn();
    newRunView({ currentProjectId: 'proj-abc' }, { rerender });
    // Directly call seedMaxBeadsFromTemplate for the new template
    mod = await import('./new-run.js');
    mod.seedMaxBeadsFromTemplate('tmpl-b');

    expect(mod.maxBeads).toBe(7);
  });
});

describe('new-run — maxBeads in submit body', () => {
  let origFetch;
  let submitNewRun, resetNewRunState;
  let docStub;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    docStub = createDocStub();
    globalThis.document = docStub;

    vi.resetModules();
    vi.doMock('lit-html', () => ({ html: () => null, nothing: null }));
    vi.doMock('lit-html/directives/unsafe-html.js', () => ({
      unsafeHTML: () => null,
    }));
    vi.doMock('../utils/icons.js', () => ({
      iconSvg: () => '',
      FileText: 'FileText',
      Circle: 'Circle',
      CircleAlert: 'CircleAlert',
      CircleCheck: 'CircleCheck',
      CircleSlash: 'CircleSlash',
      Loader: 'Loader',
      Pause: 'Pause',
    }));
    vi.doMock('./settings.js', () => ({
      getDefaults: () => ({ msize: 1, mloops: 1 }),
    }));

    const mod = await import('./new-run.js');
    submitNewRun = mod.submitNewRun;
    resetNewRunState = mod.resetNewRunState;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function setupDOM({ prompt = 'test prompt' } = {}) {
    docStub._clear();
    if (prompt) docStub._set('new-run-prompt', prompt);
    docStub._set('new-run-msize', '1');
    docStub._set('new-run-mloops', '1');
  }

  function mockFetch() {
    let capturedBody;
    globalThis.fetch = vi.fn().mockImplementation((_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, pid: 123 }),
      });
    });
    return () => capturedBody;
  }

  it('includes maxBeads=5 in POST body when set', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ maxBeads: 5 });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBe(5);
  });

  it('includes maxBeads=0 in POST body when set to 0 (Auto)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ maxBeads: 0 });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBe(0);
  });

  it('includes maxBeads=0 in POST body by default (fresh state)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState();

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBe(0);
  });
});
