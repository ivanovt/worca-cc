/**
 * Tests: new-run.js template selector (Pipeline section).
 * TDD: written before implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lit-html', () => ({ html: () => null, nothing: null }));
vi.mock('lit-html/directives/unsafe-html.js', () => ({
  unsafeHTML: () => null,
}));
vi.mock('../utils/icons.js', () => ({
  iconSvg: () => '',
  FileText: 'FileText',
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

describe('new-run — template module state and submit', () => {
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

  it('does NOT include template in POST body when default is selected (fresh state)', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState(); // selectedTemplate defaults to 'default'

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.template).toBeUndefined();
  });

  it('includes template in POST body when a specific template is selected', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ selectedTemplate: 'my-template' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.template).toBe('my-template');
  });

  it('includes template when a fast-track template is selected', async () => {
    const getBody = mockFetch();
    setupDOM();
    resetNewRunState({ selectedTemplate: 'fast-track' });

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.template).toBe('fast-track');
  });

  it('does NOT include template when resetNewRunState called with no selectedTemplate', async () => {
    const getBody = mockFetch();
    setupDOM();
    // First set a specific template
    resetNewRunState({ selectedTemplate: 'some-template' });
    // Reset back to default (simulate form reset)
    resetNewRunState();

    await submitNewRun({ rerender: vi.fn(), onStarted: vi.fn() });

    const body = getBody();
    expect(body.template).toBeUndefined();
  });
});

describe('new-run — fetchTemplates via newRunView', () => {
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

  it('calls GET /api/projects/:id/templates when rendering with a projectId', async () => {
    const fetchedUrls = [];
    globalThis.fetch = vi.fn((url) => {
      fetchedUrls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, templates: [], branches: [] }),
      });
    });

    resetNewRunState();
    newRunView({ currentProjectId: 'proj-abc' }, { rerender: vi.fn() });

    await new Promise((r) => setTimeout(r, 20));

    expect(
      fetchedUrls.some((u) => u.includes('/api/projects/proj-abc/templates')),
    ).toBe(true);
  });

  it('calls GET /api/templates (no projectId) in global mode', async () => {
    const fetchedUrls = [];
    globalThis.fetch = vi.fn((url) => {
      fetchedUrls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, templates: [], branches: [] }),
      });
    });

    resetNewRunState();
    newRunView({ currentProjectId: null }, { rerender: vi.fn() });

    await new Promise((r) => setTimeout(r, 20));

    expect(fetchedUrls.some((u) => u.includes('/api/templates'))).toBe(true);
  });
});
