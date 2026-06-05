/**
 * Tests for new-run project picker section:
 * - CSS classes: .new-run-project-section, .project-readonly, .project-change-link
 * - Status dots in sl-option items using statusDotClass + projectStatus
 * - selectedProject/projectEditable state, effectiveProjectId, Change link,
 *   @sl-change cache invalidation, localStorage seeding
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lit-html', () => {
  function html(strings, ...values) {
    return { strings: Array.from(strings), values };
  }
  return { html, nothing: Symbol('nothing') };
});
vi.mock('lit-html/directives/unsafe-html.js', () => ({
  unsafeHTML: (s) => s,
}));
vi.mock('../utils/icons.js', () => ({
  iconSvg: () => '<svg></svg>',
  FileText: 'FileText',
  Circle: 'Circle',
  CircleAlert: 'CircleAlert',
  CircleCheck: 'CircleCheck',
  CircleSlash: 'CircleSlash',
  Loader: 'Loader',
  Pause: 'Pause',
}));

function renderToString(tpl) {
  if (tpl == null || typeof tpl === 'symbol') return '';
  if (typeof tpl === 'string' || typeof tpl === 'number') return String(tpl);
  if (Array.isArray(tpl)) return tpl.map(renderToString).join('');
  if (tpl && typeof tpl === 'object' && 'strings' in tpl) {
    const { strings, values } = tpl;
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) out += renderToString(values[i]);
    }
    return out;
  }
  return String(tpl);
}

describe('new-run project picker', () => {
  let newRunView;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('lit-html', () => {
      function html(strings, ...values) {
        return { strings: Array.from(strings), values };
      }
      return { html, nothing: Symbol('nothing') };
    });
    vi.doMock('lit-html/directives/unsafe-html.js', () => ({
      unsafeHTML: (s) => s,
    }));
    vi.doMock('../utils/icons.js', () => ({
      iconSvg: () => '<svg></svg>',
      FileText: 'FileText',
      Circle: 'Circle',
      CircleAlert: 'CircleAlert',
      CircleCheck: 'CircleCheck',
      CircleSlash: 'CircleSlash',
      Loader: 'Loader',
      Pause: 'Pause',
    }));

    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    );

    const mod = await import('./new-run.js');
    newRunView = mod.newRunView;
  });

  function makeState(overrides = {}) {
    return {
      runs: {},
      currentProjectId: null,
      projects: [],
      maxConcurrentPipelines: 10,
      totalRunning: 0,
      ...overrides,
    };
  }

  it('hides project section when projects list is empty (single-project mode)', () => {
    const state = makeState({ projects: [] });
    const result = newRunView(state, { rerender: vi.fn() });
    const html = renderToString(result);
    expect(html).not.toContain('new-run-project-section');
  });

  it('renders project section in multi-project mode', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: null,
    });
    const result = newRunView(state, { rerender: vi.fn() });
    const html = renderToString(result);
    expect(html).toContain('new-run-project-section');
  });

  it('renders read-only project name when currentProjectId is set', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: 'proj-a',
    });
    const result = newRunView(state, { rerender: vi.fn() });
    const html = renderToString(result);
    expect(html).toContain('project-readonly');
    expect(html).toContain('proj-a');
    expect(html).toContain('project-change-link');
  });

  it('renders editable sl-select when currentProjectId is null (All Projects mode)', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: null,
    });
    const result = newRunView(state, { rerender: vi.fn() });
    const html = renderToString(result);
    expect(html).toContain('new-run-project-section');
    expect(html).not.toContain('project-readonly');
  });

  it('renders status dots in project sl-option items', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: null,
      runs: {
        r1: { active: true, pipeline_status: 'running', project: 'proj-a' },
      },
    });
    const result = newRunView(state, { rerender: vi.fn() });
    const html = renderToString(result);
    expect(html).toContain('project-status-dot');
    expect(html).toContain('project-option-label');
  });

  it('applies correct dot class based on project status', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
      runs: {
        r1: { active: true, pipeline_status: 'running', project: 'proj-a' },
      },
    });
    const result = newRunView(state, { rerender: vi.fn() });
    const html = renderToString(result);
    expect(html).toContain('project-status-running');
  });

  it('applies idle dot class when project has no runs', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
      runs: {},
    });
    const result = newRunView(state, { rerender: vi.fn() });
    const html = renderToString(result);
    expect(html).toContain('project-status-idle');
  });

  it('renders hint text below the project field', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
    });
    const result = newRunView(state, { rerender: vi.fn() });
    const html = renderToString(result);
    expect(html).toContain('.claude/worca/');
  });
});

describe('new-run project picker — state and interactions', () => {
  let newRunView, resetNewRunState, getEffectiveProjectId;
  let localStorageStore;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('lit-html', () => {
      function html(strings, ...values) {
        return { strings: Array.from(strings), values };
      }
      return { html, nothing: Symbol('nothing') };
    });
    vi.doMock('lit-html/directives/unsafe-html.js', () => ({
      unsafeHTML: (s) => s,
    }));
    vi.doMock('../utils/icons.js', () => ({
      iconSvg: () => '<svg></svg>',
      FileText: 'FileText',
      Circle: 'Circle',
      CircleAlert: 'CircleAlert',
      CircleCheck: 'CircleCheck',
      CircleSlash: 'CircleSlash',
      Loader: 'Loader',
      Pause: 'Pause',
    }));

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

    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ ok: true, branches: [], templates: [], files: [] }),
      }),
    );

    const mod = await import('./new-run.js');
    newRunView = mod.newRunView;
    resetNewRunState = mod.resetNewRunState;
    getEffectiveProjectId = mod.getEffectiveProjectId;
  });

  afterEach(() => {
    delete globalThis.localStorage;
  });

  function makeState(overrides = {}) {
    return {
      runs: {},
      currentProjectId: null,
      projects: [],
      maxConcurrentPipelines: 10,
      totalRunning: 0,
      ...overrides,
    };
  }

  it('exports getEffectiveProjectId function', () => {
    expect(typeof getEffectiveProjectId).toBe('function');
  });

  it('effectiveProjectId returns currentProjectId when set and not editable', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }],
      currentProjectId: 'proj-a',
    });
    resetNewRunState();
    newRunView(state, { rerender: vi.fn() });
    expect(getEffectiveProjectId(state)).toBe('proj-a');
  });

  it('effectiveProjectId returns selectedProject when user picks from dropdown', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: null,
    });
    resetNewRunState({ selectedProject: 'proj-b' });
    expect(getEffectiveProjectId(state)).toBe('proj-b');
  });

  it('effectiveProjectId returns null when no project selected in All Projects mode', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
    });
    resetNewRunState();
    expect(getEffectiveProjectId(state)).toBe(null);
  });

  it('seeds selectedProject from localStorage when currentProjectId is null', () => {
    localStorageStore['worca.lastLaunchedProject'] = 'proj-b';
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: null,
    });
    resetNewRunState();
    newRunView(state, { rerender: vi.fn() });
    expect(getEffectiveProjectId(state)).toBe('proj-b');
  });

  it('does not seed from localStorage if stored project is not in state.projects', () => {
    localStorageStore['worca.lastLaunchedProject'] = 'removed-proj';
    const state = makeState({
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
    });
    resetNewRunState();
    newRunView(state, { rerender: vi.fn() });
    expect(getEffectiveProjectId(state)).toBe(null);
  });

  it('Change link switches to editable mode (renders sl-select instead of readonly)', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: 'proj-a',
    });
    resetNewRunState({ projectEditable: true });
    const result = newRunView(state, { rerender: vi.fn() });
    const out = renderToString(result);
    expect(out).not.toContain('project-readonly');
    expect(out).toContain('new-run-project');
  });

  it('renders sl-select with value set to selectedProject', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: null,
    });
    resetNewRunState({ selectedProject: 'proj-b' });
    const result = newRunView(state, { rerender: vi.fn() });
    const out = renderToString(result);
    expect(out).toContain('proj-b');
  });

  it('invalidates caches when project changes via @sl-change', async () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
      currentProjectId: null,
    });
    resetNewRunState({ selectedProject: 'proj-a' });
    const rerender = vi.fn();
    newRunView(state, { rerender });

    await new Promise((r) => setTimeout(r, 20));
    const callCount = globalThis.fetch.mock.calls.length;

    resetNewRunState({ selectedProject: 'proj-b' });
    newRunView(state, { rerender });

    await new Promise((r) => setTimeout(r, 20));
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(callCount);
  });

  it('resetNewRunState accepts selectedProject override', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
    });
    resetNewRunState({ selectedProject: 'proj-a' });
    expect(getEffectiveProjectId(state)).toBe('proj-a');
  });

  it('resetNewRunState clears selectedProject and projectEditable by default', () => {
    const state = makeState({
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
    });
    resetNewRunState({ selectedProject: 'proj-a', projectEditable: true });
    resetNewRunState();
    expect(getEffectiveProjectId(state)).toBe(null);
  });
});

describe('new-run source type dropdown', () => {
  let newRunView;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('lit-html', () => {
      function html(strings, ...values) {
        return { strings: Array.from(strings), values };
      }
      return { html, nothing: Symbol('nothing') };
    });
    vi.doMock('lit-html/directives/unsafe-html.js', () => ({
      unsafeHTML: (s) => s,
    }));
    vi.doMock('../utils/icons.js', () => ({
      iconSvg: () => '<svg></svg>',
      FileText: 'FileText',
      Circle: 'Circle',
      CircleAlert: 'CircleAlert',
      CircleCheck: 'CircleCheck',
      CircleSlash: 'CircleSlash',
      Loader: 'Loader',
      Pause: 'Pause',
    }));
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    );
    const mod = await import('./new-run.js');
    newRunView = mod.newRunView;
  });

  function makeState() {
    return {
      runs: {},
      currentProjectId: 'p1',
      projects: [{ name: 'p1' }],
      maxConcurrentPipelines: 10,
      totalRunning: 0,
    };
  }

  // The value="none" source type means "no external source — use the prompt".
  // Its label must read "Prompt" (not the misleading "None"), since the run
  // still submits the typed prompt. value stays 'none' (internal wiring).
  it('labels the value="none" source option "Prompt"', () => {
    const html = renderToString(newRunView(makeState(), { rerender: vi.fn() }));
    expect(html).toContain('<sl-option value="none">Prompt</sl-option>');
  });

  it('no longer labels the default source option "None"', () => {
    const html = renderToString(newRunView(makeState(), { rerender: vi.fn() }));
    expect(html).not.toContain('<sl-option value="none">None</sl-option>');
  });

  it('keeps the other source options unchanged', () => {
    const html = renderToString(newRunView(makeState(), { rerender: vi.fn() }));
    expect(html).toContain(
      '<sl-option value="source">GitHub Issue</sl-option>',
    );
    expect(html).toContain('<sl-option value="spec">Spec File</sl-option>');
    expect(html).toContain('<sl-option value="pr">GitHub PR</sl-option>');
  });
});
