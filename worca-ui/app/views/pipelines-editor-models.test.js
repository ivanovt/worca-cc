/**
 * Tests: the Pipelines editor loads the project's worca.models so the per-agent
 * Model dropdown can offer custom aliases.
 *
 * worca.models is a cross-template, project-owned key — it never lives in the
 * template config. The editor must fetch it from the project settings into
 * editorState.settings; otherwise the Model dropdown falls back to the built-in
 * defaults only and a template referencing a custom alias (e.g. "glm-ds")
 * renders a blank select while validation false-warns "not defined in
 * worca.models". This covers the data-loading half of that fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEditorState, loadTemplate } from './pipelines-editor.js';

function mockFetchByUrl(map) {
  globalThis.fetch = vi.fn((url) => {
    for (const [frag, body] of Object.entries(map)) {
      if (typeof url === 'string' && url.includes(frag)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        });
      }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });
}

const TEMPLATE_BODY = {
  ok: true,
  template: {
    id: 'feature-glm-ds',
    name: 'Feature (GLM-DS)',
    description: '',
    tags: [],
    params: {},
    config: { agents: { planner: { model: 'glm-ds' } } },
  },
};

describe('pipelines-editor — project worca.models loading', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads effective worca.models into editorState.settings on loadTemplate', async () => {
    mockFetchByUrl({
      // effective-settings endpoint layers user-global ~/.worca/settings.json
      // over project settings.json so user-scope aliases land in the picker too
      '/effective-settings': {
        worca: { models: { 'glm-ds': { id: 'opus' } } },
      },
      '/templates/project/feature-glm-ds': TEMPLATE_BODY,
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    expect(st.settings.worca.models).toBeTruthy();
    expect(st.settings.worca.models['glm-ds']).toEqual({ id: 'opus' });
  });

  it('requests the effective-settings endpoint for the active project', async () => {
    mockFetchByUrl({
      '/effective-settings': { worca: { models: {} } },
      '/templates/project/feature-glm-ds': TEMPLATE_BODY,
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const calledSettings = globalThis.fetch.mock.calls.some(([url]) =>
      String(url).includes('/api/projects/test-proj/effective-settings'),
    );
    expect(calledSettings).toBe(true);
  });

  it('falls back to empty settings when the settings fetch fails', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('/settings')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(TEMPLATE_BODY),
      });
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    // Default empty settings shape — dropdown will use built-in defaults.
    expect(st.settings.worca).toEqual({});
  });
});
