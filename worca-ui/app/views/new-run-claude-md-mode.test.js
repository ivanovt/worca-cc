/**
 * Tests: new-run.js claudeMdMode dropdown — passthrough sentinel, resolve helper,
 * and conditional submit body inclusion.
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

const ICON_MOCKS = {
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
};

async function setupModule() {
  vi.resetModules();
  vi.doMock('lit-html', () => ({ html: () => null, nothing: null }));
  vi.doMock('lit-html/directives/unsafe-html.js', () => ({
    unsafeHTML: () => null,
  }));
  vi.doMock('lit-html/directives/ref.js', () => ({ ref: () => null }));
  vi.doMock('../utils/icons.js', () => ICON_MOCKS);
  vi.doMock('./sidebar.js', () => ({ projectStatus: () => 'idle' }));
  vi.doMock('./settings.js', () => ({
    getDefaults: () => ({ msize: 1, mloops: 1 }),
  }));
  vi.doMock('../utils/status-badge.js', () => ({
    statusDotClass: () => 'status-pending',
  }));
  vi.doMock('../utils/help-links.js', () => ({ helpFor: () => null }));

  return import('./new-run.js');
}

describe('new-run — claudeMdMode module state', () => {
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    await setupModule();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('exports claudeMdMode as null by default', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState();
    expect(mod.claudeMdMode).toBeNull();
  });

  it('resetNewRunState() respects explicit claudeMdMode override', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({ claudeMdMode: 'project' });
    expect(mod.claudeMdMode).toBe('project');
  });

  it('resetNewRunState() defaults claudeMdMode to null when not specified', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({ claudeMdMode: 'project' });
    mod.resetNewRunState();
    expect(mod.claudeMdMode).toBeNull();
  });
});

describe('new-run — resolveEffectiveClaudeMdMode helper', () => {
  let origFetch;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    await setupModule();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns template config.claude_md_mode when template selected', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({
      selectedTemplate: 'tmpl-cmd',
      templates: [
        {
          id: 'tmpl-cmd',
          config: { claude_md_mode: 'project' },
        },
      ],
      projectLevelClaudeMdMode: null,
    });

    expect(mod.resolveEffectiveClaudeMdMode()).toBe('project');
  });

  it('falls back to project-level setting when template has no claude_md_mode', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({
      selectedTemplate: 'default',
      templates: [],
      projectLevelClaudeMdMode: 'project+local',
    });

    expect(mod.resolveEffectiveClaudeMdMode()).toBe('project+local');
  });

  it('returns "all" when neither template nor project has claude_md_mode', async () => {
    const mod = await import('./new-run.js');
    mod.resetNewRunState({
      selectedTemplate: 'default',
      templates: [],
      projectLevelClaudeMdMode: null,
    });

    expect(mod.resolveEffectiveClaudeMdMode()).toBe('all');
  });
});

describe('new-run — claudeMdMode in submit body', () => {
  let origFetch;
  let docStub;
  let submitNewRun, resetNewRunState;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    docStub = createDocStub();
    globalThis.document = docStub;

    const mod = await setupModule();
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

  it('omits claudeMdMode from POST body when null (passthrough)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ claudeMdMode: null });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    expect(getBody().claudeMdMode).toBeUndefined();
  });

  it('omits claudeMdMode from POST body by default (fresh state is null)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState();

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    expect(getBody().claudeMdMode).toBeUndefined();
  });

  it('includes claudeMdMode="project" in POST body when set', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ claudeMdMode: 'project' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    expect(getBody().claudeMdMode).toBe('project');
  });

  it('includes claudeMdMode="project+local" in POST body when set', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ claudeMdMode: 'project+local' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    expect(getBody().claudeMdMode).toBe('project+local');
  });

  it('includes claudeMdMode="none" in POST body when set', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ claudeMdMode: 'none' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    expect(getBody().claudeMdMode).toBe('none');
  });

  it('includes claudeMdMode="all" in POST body when explicitly set', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ claudeMdMode: 'all' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    expect(getBody().claudeMdMode).toBe('all');
  });

  it('reads claudeMdMode from DOM select when present', async () => {
    const getBody = mockFetch();
    setupDOM();
    docStub._set('new-run-claude-md-mode', 'project');
    resetNewRunState({ claudeMdMode: null });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    expect(getBody().claudeMdMode).toBe('project');
  });

  it('reads empty string from DOM select as null (passthrough)', async () => {
    const getBody = mockFetch();
    setupDOM();
    docStub._set('new-run-claude-md-mode', '');
    resetNewRunState({ claudeMdMode: null });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    expect(getBody().claudeMdMode).toBeUndefined();
  });
});
