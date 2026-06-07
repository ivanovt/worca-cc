/**
 * Tests: new-run.js Max Beads dropdown — passthrough sentinel, seed from
 * project/template, reseed on switch, and conditional submit body inclusion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('new-run — maxBeads passthrough sentinel', () => {
  let origFetch;

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
      Play: 'Play',
      Square: 'Square',
      Home: 'Home',
      Settings: 'Settings',
      GitBranch: 'GitBranch',
      ChevronDown: 'ChevronDown',
      ChevronRight: 'ChevronRight',
      X: 'X',
      Plus: 'Plus',
      GitMerge: 'GitMerge',
      AlertTriangle: 'AlertTriangle',
      Shield: 'Shield',
      Activity: 'Activity',
      Clock: 'Clock',
      CheckCircle: 'CheckCircle',
      Info: 'Info',
      Zap: 'Zap',
    }));
    vi.doMock('./sidebar.js', () => ({
      projectStatus: () => 'idle',
    }));
    vi.doMock('./settings.js', () => ({
      getDefaults: () => ({ msize: 1, mloops: 1 }),
    }));
    vi.doMock('../utils/status-badge.js', () => ({
      statusDotClass: () => 'status-pending',
    }));
    vi.doMock('../utils/help-links.js', () => ({
      helpFor: () => null,
    }));

    await import('./new-run.js');
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('imports export null and projectLevelMaxBeads as module-level variables', async () => {
    const mod = await import('./new-run.js');
    // After resetNewRunState() default, both should be null
    expect(mod.maxBeads).toBeNull();
    expect(mod.projectLevelMaxBeads).toBeNull();
  });

  it('resetNewRunState() respects explicit maxBeads override', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({ maxBeads: 3 });
    expect(mod.maxBeads).toBe(3);
  });

  it('resetNewRunState() defaults maxBeads to null when not specified', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({ someOtherKey: 'value' });
    expect(mod.maxBeads).toBeNull();
  });
});

describe('new-run — project-level maxBeads caching', () => {
  let origFetch;

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
      Play: 'Play',
      Square: 'Square',
      Home: 'Home',
      Settings: 'Settings',
      GitBranch: 'GitBranch',
      ChevronDown: 'ChevronDown',
      ChevronRight: 'ChevronRight',
      X: 'X',
      Plus: 'Plus',
      GitMerge: 'GitMerge',
      AlertTriangle: 'AlertTriangle',
      Shield: 'Shield',
      Activity: 'Activity',
      Clock: 'Clock',
      CheckCircle: 'CheckCircle',
      Info: 'Info',
      Zap: 'Zap',
    }));
    vi.doMock('./sidebar.js', () => ({
      projectStatus: () => 'idle',
    }));
    vi.doMock('./settings.js', () => ({
      getDefaults: () => ({ msize: 1, mloops: 1 }),
    }));
    vi.doMock('../utils/status-badge.js', () => ({
      statusDotClass: () => 'status-pending',
    }));
    vi.doMock('../utils/help-links.js', () => ({
      helpFor: () => null,
    }));

    await import('./new-run.js');
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('caches projectLevelMaxBeads from /settings response', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/settings')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              worca: {
                agents: { coordinator: { max_beads: 5 } },
              },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, branches: [] }),
      });
    });

    const mod = await import('./new-run.js');
    mod.resetNewRunState({ selectedTemplate: 'default' });

    // Trigger fetch
    await mod.fetchDefaultTemplate('proj-abc');

    expect(mod.projectLevelMaxBeads).toBe(5);
  });

  it('caches null when project has no coordinator.max_beads config', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/settings')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              worca: {
                agents: {},
              },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, branches: [] }),
      });
    });

    const mod = await import('./new-run.js');
    mod.resetNewRunState({ selectedTemplate: 'default' });
    await mod.fetchDefaultTemplate('proj-abc');

    expect(mod.projectLevelMaxBeads).toBeNull();
  });

  it('resets projectLevelMaxBeads cache on project switch', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/settings')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              worca: {
                agents: { coordinator: { max_beads: 7 } },
              },
            }),
        });
      }
      if (url.includes('/branches')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, branches: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, templates: [] }),
      });
    });

    const mod = await import('./new-run.js');
    mod.resetNewRunState({ selectedTemplate: 'default' });
    await mod.fetchDefaultTemplate('proj-abc');
    expect(mod.projectLevelMaxBeads).toBe(7);

    // Reset state via resetNewRunState, which resets the cache
    mod.resetNewRunState({ selectedTemplate: 'default' });

    // After reset, both should be back to null
    expect(mod.projectLevelMaxBeads).toBeNull();
    expect(mod.maxBeads).toBeNull();
  });
});

describe('new-run — resolveEffectiveMaxBeads helper', () => {
  let origFetch;

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
      Play: 'Play',
      Square: 'Square',
      Home: 'Home',
      Settings: 'Settings',
      GitBranch: 'GitBranch',
      ChevronDown: 'ChevronDown',
      ChevronRight: 'ChevronRight',
      X: 'X',
      Plus: 'Plus',
      GitMerge: 'GitMerge',
      AlertTriangle: 'AlertTriangle',
      Shield: 'Shield',
      Activity: 'Activity',
      Clock: 'Clock',
      CheckCircle: 'CheckCircle',
      Info: 'Info',
      Zap: 'Zap',
    }));
    vi.doMock('./sidebar.js', () => ({
      projectStatus: () => 'idle',
    }));
    vi.doMock('./settings.js', () => ({
      getDefaults: () => ({ msize: 1, mloops: 1 }),
    }));
    vi.doMock('../utils/status-badge.js', () => ({
      statusDotClass: () => 'status-pending',
    }));
    vi.doMock('../utils/help-links.js', () => ({
      helpFor: () => null,
    }));

    await import('./new-run.js');
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('resolves template max_beads when selected', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({
      selectedTemplate: 'tmpl-with-beads',
      templates: [
        {
          id: 'tmpl-with-beads',
          config: { agents: { coordinator: { max_beads: 3 } } },
        },
      ],
    });

    const result = mod.resolveEffectiveMaxBeads();
    expect(result).toBe(3);
  });

  it('resolves project-level max_beads when no template selected', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({
      selectedTemplate: 'default',
      projectLevelMaxBeads: 5,
    });

    const result = mod.resolveEffectiveMaxBeads();
    expect(result).toBe(5);
  });

  it('returns null when neither template nor project has max_beads', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({
      selectedTemplate: 'default',
      projectLevelMaxBeads: null,
    });

    const result = mod.resolveEffectiveMaxBeads();
    expect(result).toBeNull();
  });

  it('returns null when template has no max_beads config', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({
      selectedTemplate: 'tmpl-no-beads',
      templates: [{ id: 'tmpl-no-beads', config: {} }],
    });

    const result = mod.resolveEffectiveMaxBeads();
    expect(result).toBeNull();
  });
});

describe('new-run — maxBeads seeding from template', () => {
  let origFetch;
  let newRunView;

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
      Play: 'Play',
      Square: 'Square',
      Home: 'Home',
      Settings: 'Settings',
      GitBranch: 'GitBranch',
      ChevronDown: 'ChevronDown',
      ChevronRight: 'ChevronRight',
      X: 'X',
      Plus: 'Plus',
      GitMerge: 'GitMerge',
      AlertTriangle: 'AlertTriangle',
      Shield: 'Shield',
      Activity: 'Activity',
      Clock: 'Clock',
      CheckCircle: 'CheckCircle',
      Info: 'Info',
      Zap: 'Zap',
    }));
    vi.doMock('./sidebar.js', () => ({
      projectStatus: () => 'idle',
    }));
    vi.doMock('./settings.js', () => ({
      getDefaults: () => ({ msize: 1, mloops: 1 }),
    }));
    vi.doMock('../utils/status-badge.js', () => ({
      statusDotClass: () => 'status-pending',
    }));
    vi.doMock('../utils/help-links.js', () => ({
      helpFor: () => null,
    }));

    const mod = await import('./new-run.js');
    newRunView = mod.newRunView;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('seeds maxBeads to null when template has no max_beads config', async () => {
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

    const mod = await import('./new-run.js');
    mod.resetNewRunState({ selectedTemplate: 'plain', maxBeads: 5 });
    newRunView({ currentProjectId: 'proj-abc' }, { rerender: vi.fn() });

    await new Promise((r) => setTimeout(r, 100));

    const newMod = await import('./new-run.js');
    expect(newMod.maxBeads).toBeNull();
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

    const mod = await import('./new-run.js');
    mod.resetNewRunState({ selectedTemplate: 'tmpl-a' });
    newRunView({ currentProjectId: 'proj-abc' }, { rerender: vi.fn() });
    await new Promise((r) => setTimeout(r, 100));

    let newMod = await import('./new-run.js');
    expect(newMod.maxBeads).toBe(4);

    // Switch template — simulate sl-change event on the select
    const rerender = vi.fn();
    newRunView({ currentProjectId: 'proj-abc' }, { rerender });
    // Directly call seedMaxBeadsFromTemplate for the new template
    newMod = await import('./new-run.js');
    newMod.seedMaxBeadsFromTemplate('tmpl-b');

    expect(newMod.maxBeads).toBe(7);
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
      Play: 'Play',
      Square: 'Square',
      Home: 'Home',
      Settings: 'Settings',
      GitBranch: 'GitBranch',
      ChevronDown: 'ChevronDown',
      ChevronRight: 'ChevronRight',
      X: 'X',
      Plus: 'Plus',
      GitMerge: 'GitMerge',
      AlertTriangle: 'AlertTriangle',
      Shield: 'Shield',
      Activity: 'Activity',
      Clock: 'Clock',
      CheckCircle: 'CheckCircle',
      Info: 'Info',
      Zap: 'Zap',
    }));
    vi.doMock('./sidebar.js', () => ({
      projectStatus: () => 'idle',
    }));
    vi.doMock('./settings.js', () => ({
      getDefaults: () => ({ msize: 1, mloops: 1 }),
    }));
    vi.doMock('../utils/status-badge.js', () => ({
      statusDotClass: () => 'status-pending',
    }));
    vi.doMock('../utils/help-links.js', () => ({
      helpFor: () => null,
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

  it('omits maxBeads from POST body when null (passthrough)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ maxBeads: null });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBeUndefined();
  });

  it('omits maxBeads from POST body by default (fresh state is null)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState();

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBeUndefined();
  });

  it('includes maxBeads=5 in POST body when set', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ maxBeads: 5 });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBe(5);
  });

  it('includes maxBeads=0 in POST body when explicitly set to 0 (Auto)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ maxBeads: 0 });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBe(0);
  });

  it('reads maxBeads from DOM select when present and module state is null', async () => {
    const getBody = mockFetch();
    setupDOM();
    docStub._set('new-run-max-beads', '3'); // DOM says 3

    // Module state is null (passthrough) but DOM select has explicit value
    resetNewRunState({ maxBeads: null });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBe(3);
  });

  it('reads empty string from DOM select as null (passthrough)', async () => {
    const getBody = mockFetch();
    setupDOM();
    docStub._set('new-run-max-beads', ''); // DOM says passthrough (empty string)

    resetNewRunState({ maxBeads: null });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.maxBeads).toBeUndefined();
  });
});
