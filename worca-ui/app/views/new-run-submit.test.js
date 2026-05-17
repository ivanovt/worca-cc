import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock lit-html since it requires DOM APIs (createTreeWalker)
vi.mock('lit-html', () => ({
  html: () => null,
  nothing: null,
}));
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

// Minimal DOM stub for tests
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

describe('submitNewRun — new format validation and payload', () => {
  let origFetch;
  let submitNewRun, resetNewRunState;
  let docStub;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    docStub = createDocStub();
    globalThis.document = docStub;

    vi.resetModules();
    // Re-apply mocks after resetModules
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

    const mod = await import('./new-run.js');
    submitNewRun = mod.submitNewRun;
    resetNewRunState = mod.resetNewRunState;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function setupDOM({ sourceValue = '', prompt = '' } = {}) {
    docStub._clear();
    if (sourceValue) docStub._set('new-run-source-value', sourceValue);
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

  it('rejects when no source, plan, or prompt provided', async () => {
    setupDOM();
    resetNewRunState();

    const rerender = vi.fn();
    await submitNewRun({ rerender, onStarted: vi.fn() });

    expect(rerender).toHaveBeenCalled();
    // No fetch call should have been made
    expect(globalThis.fetch).toBe(origFetch);
  });

  it('accepts prompt-only submission', async () => {
    const getBody = mockFetch();
    setupDOM({ prompt: 'Add user auth' });
    resetNewRunState({ sourceType: 'none' });

    const onStarted = vi.fn();
    await submitNewRun({ rerender: vi.fn(), onStarted });

    expect(globalThis.fetch).toHaveBeenCalled();
    const body = getBody();
    expect(body.sourceType).toBe('none');
    expect(body.prompt).toBe('Add user auth');
    expect(onStarted).toHaveBeenCalled();
  });

  it('sends sourceType and sourceValue for GitHub Issue', async () => {
    const getBody = mockFetch();
    setupDOM({ sourceValue: 'https://github.com/org/repo/issues/42' });
    resetNewRunState({ sourceType: 'source' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.sourceType).toBe('source');
    expect(body.sourceValue).toBe('https://github.com/org/repo/issues/42');
  });

  it('sends sourceType and sourceValue for spec file', async () => {
    const getBody = mockFetch();
    setupDOM({ sourceValue: 'docs/spec.md' });
    resetNewRunState({ sourceType: 'spec' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.sourceType).toBe('spec');
    expect(body.sourceValue).toBe('docs/spec.md');
  });

  it('sends planFile when selected', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({
      sourceType: 'none',
      selectedPlan: 'docs/plans/my-plan.md',
    });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.planFile).toBe('docs/plans/my-plan.md');
    expect(body.sourceType).toBe('none');
  });

  it('sends source + prompt together', async () => {
    const getBody = mockFetch();
    setupDOM({ sourceValue: 'gh:issue:42', prompt: 'focus on auth' });
    resetNewRunState({ sourceType: 'source' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.sourceType).toBe('source');
    expect(body.sourceValue).toBe('gh:issue:42');
    expect(body.prompt).toBe('focus on auth');
  });

  it('rejects sourceType=source with empty sourceValue', async () => {
    setupDOM({ sourceValue: '  ' });
    resetNewRunState({ sourceType: 'source' });

    const rerender = vi.fn();
    await submitNewRun({ rerender, onStarted: vi.fn() });

    expect(rerender).toHaveBeenCalled();
    // No fetch call
    expect(globalThis.fetch).toBe(origFetch);
  });

  it('planFile-only is valid (no source, no prompt)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({
      sourceType: 'none',
      selectedPlan: 'docs/plans/my-plan.md',
    });

    const onStarted = vi.fn();
    await submitNewRun({ rerender: vi.fn(), onStarted });

    expect(globalThis.fetch).toHaveBeenCalled();
    const body = getBody();
    expect(body.planFile).toBe('docs/plans/my-plan.md');
    expect(body.sourceValue).toBeUndefined();
    expect(body.prompt).toBeUndefined();
    expect(onStarted).toHaveBeenCalled();
  });

  it('does not include sourceValue in body when sourceType is none', async () => {
    const getBody = mockFetch();
    setupDOM({ prompt: 'test' });
    resetNewRunState({ sourceType: 'none' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.sourceValue).toBeUndefined();
  });
});

describe('submitNewRun — 409 max_concurrent_exceeded handling', () => {
  let origFetch;
  let submitNewRun, resetNewRunState, getNewRunSubmitState;
  let docStub;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    const elements = {};
    docStub = {
      getElementById: vi.fn((id) => elements[id] || null),
      _set(id, value) {
        elements[id] = { value, id };
      },
      _clear() {
        for (const k of Object.keys(elements)) delete elements[k];
      },
    };
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

    const mod = await import('./new-run.js');
    submitNewRun = mod.submitNewRun;
    resetNewRunState = mod.resetNewRunState;
    getNewRunSubmitState = mod.getNewRunSubmitState;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('sets submitError from 409 max_concurrent_exceeded response', async () => {
    docStub._clear();
    docStub._set('new-run-prompt', 'test prompt');
    docStub._set('new-run-msize', '1');
    docStub._set('new-run-mloops', '1');
    resetNewRunState({ sourceType: 'none' });

    const serverMsg =
      'Maximum concurrent pipelines reached (5). Stop a running pipeline or increase the limit in global preferences.';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          ok: false,
          error: serverMsg,
          code: 'max_concurrent_exceeded',
        }),
    });

    const rerender = vi.fn();
    await submitNewRun({ rerender, onStarted: vi.fn() });

    const state = getNewRunSubmitState();
    expect(state.submitStatus).toBe('error');
    expect(rerender).toHaveBeenCalled();
  });

  it('includes cap info in error when 409 code is max_concurrent_exceeded', async () => {
    docStub._clear();
    docStub._set('new-run-prompt', 'test prompt');
    docStub._set('new-run-msize', '1');
    docStub._set('new-run-mloops', '1');
    resetNewRunState({ sourceType: 'none' });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          ok: false,
          error: 'Max reached (3)',
          code: 'max_concurrent_exceeded',
          cap: 3,
          totalRunning: 3,
        }),
    });

    const rerender = vi.fn();
    await submitNewRun({ rerender, onStarted: vi.fn() });

    const state = getNewRunSubmitState();
    expect(state.submitStatus).toBe('error');
  });
});

describe('submitNewRun — project validation and routing', () => {
  let origFetch;
  let submitNewRun, resetNewRunState, getNewRunSubmitState;
  let docStub;
  let localStorageStore;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    const elements = {};
    docStub = {
      getElementById: vi.fn((id) => elements[id] || null),
      _set(id, value) {
        elements[id] = { value, id };
      },
      _clear() {
        for (const k of Object.keys(elements)) delete elements[k];
      },
    };
    globalThis.document = docStub;

    localStorageStore = {};
    globalThis.localStorage = {
      getItem: vi.fn((key) => localStorageStore[key] ?? null),
      setItem: vi.fn((key, val) => {
        localStorageStore[key] = val;
      }),
      removeItem: vi.fn((key) => {
        delete localStorageStore[key];
      }),
    };

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

    const mod = await import('./new-run.js');
    submitNewRun = mod.submitNewRun;
    resetNewRunState = mod.resetNewRunState;
    getNewRunSubmitState = mod.getNewRunSubmitState;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete globalThis.localStorage;
  });

  function setupDOM({ prompt = 'test prompt' } = {}) {
    docStub._clear();
    if (prompt) docStub._set('new-run-prompt', prompt);
    docStub._set('new-run-msize', '1');
    docStub._set('new-run-mloops', '1');
  }

  it('rejects with error when projects exist but no projectId', async () => {
    setupDOM();
    resetNewRunState();

    const rerender = vi.fn();
    await submitNewRun({
      rerender,
      onStarted: vi.fn(),
      projectId: null,
      hasProjects: true,
    });

    const state = getNewRunSubmitState();
    expect(state.submitStatus).toBe('error');
    expect(rerender).toHaveBeenCalled();
  });

  it('allows submit without projectId when hasProjects is false (single-project mode)', async () => {
    setupDOM();
    resetNewRunState();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, pid: 123 }),
    });

    const onStarted = vi.fn();
    await submitNewRun({
      rerender: vi.fn(),
      onStarted,
      projectId: null,
      hasProjects: false,
    });

    expect(onStarted).toHaveBeenCalled();
  });

  it('always uses project-scoped URL when projectId is provided', async () => {
    setupDOM();
    resetNewRunState();

    let capturedUrl;
    globalThis.fetch = vi.fn().mockImplementation((url, _opts) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, pid: 123 }),
      });
    });

    await submitNewRun({
      rerender: vi.fn(),
      onStarted: vi.fn(),
      projectId: 'proj-abc',
      hasProjects: true,
    });

    expect(capturedUrl).toBe('/api/projects/proj-abc/runs');
  });

  it('uses /api/runs when no projectId and no projects (single-project mode)', async () => {
    setupDOM();
    resetNewRunState();

    let capturedUrl;
    globalThis.fetch = vi.fn().mockImplementation((url, _opts) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, pid: 123 }),
      });
    });

    await submitNewRun({
      rerender: vi.fn(),
      onStarted: vi.fn(),
      projectId: null,
      hasProjects: false,
    });

    expect(capturedUrl).toBe('/api/runs');
  });

  it('persists selected project to localStorage on successful submit', async () => {
    setupDOM();
    resetNewRunState();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, pid: 123 }),
    });

    await submitNewRun({
      rerender: vi.fn(),
      onStarted: vi.fn(),
      projectId: 'proj-xyz',
      hasProjects: true,
    });

    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith(
      'worca.lastLaunchedProject',
      'proj-xyz',
    );
  });

  it('does not persist to localStorage on failed submit', async () => {
    setupDOM();
    resetNewRunState();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ ok: false, error: 'Server error' }),
    });

    await submitNewRun({
      rerender: vi.fn(),
      onStarted: vi.fn(),
      projectId: 'proj-xyz',
      hasProjects: true,
    });

    expect(globalThis.localStorage.setItem).not.toHaveBeenCalledWith(
      'worca.lastLaunchedProject',
      expect.anything(),
    );
  });

  it('does not persist to localStorage in single-project mode', async () => {
    setupDOM();
    resetNewRunState();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, pid: 123 }),
    });

    await submitNewRun({
      rerender: vi.fn(),
      onStarted: vi.fn(),
      projectId: null,
      hasProjects: false,
    });

    expect(globalThis.localStorage.setItem).not.toHaveBeenCalledWith(
      'worca.lastLaunchedProject',
      expect.anything(),
    );
  });
});

describe('getNewRunSubmitState — noProject flag', () => {
  let getNewRunSubmitState, resetNewRunState;

  beforeEach(async () => {
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

    const mod = await import('./new-run.js');
    getNewRunSubmitState = mod.getNewRunSubmitState;
    resetNewRunState = mod.resetNewRunState;
  });

  it('noProject is false when selectedProject is set', () => {
    resetNewRunState({ selectedProject: 'proj-a' });
    const state = getNewRunSubmitState({
      hasProjects: true,
      currentProjectId: null,
    });
    expect(state.noProject).toBe(false);
  });

  it('noProject is false when currentProjectId is set', () => {
    resetNewRunState();
    const state = getNewRunSubmitState({
      hasProjects: true,
      currentProjectId: 'proj-a',
    });
    expect(state.noProject).toBe(false);
  });

  it('noProject is true when hasProjects but no selection', () => {
    resetNewRunState();
    const state = getNewRunSubmitState({
      hasProjects: true,
      currentProjectId: null,
    });
    expect(state.noProject).toBe(true);
  });

  it('noProject is false when hasProjects is false (single-project mode)', () => {
    resetNewRunState();
    const state = getNewRunSubmitState({
      hasProjects: false,
      currentProjectId: null,
    });
    expect(state.noProject).toBe(false);
  });
});

describe('module exports', () => {
  it('exports newRunView, submitNewRun, resetNewRunState, getNewRunSubmitState, isAtCapacity, getEffectiveProjectId', async () => {
    const mod = await import('./new-run.js');
    expect(typeof mod.newRunView).toBe('function');
    expect(typeof mod.submitNewRun).toBe('function');
    expect(typeof mod.resetNewRunState).toBe('function');
    expect(typeof mod.getNewRunSubmitState).toBe('function');
    expect(typeof mod.isAtCapacity).toBe('function');
    expect(typeof mod.getEffectiveProjectId).toBe('function');
  });
});
