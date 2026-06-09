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
import {
  applyModelLockToggle,
  formBufferToConfig,
  getEditorState,
  loadTemplate,
} from './pipelines-editor.js';

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

  it('populates modelTierMap with all tiers so the dropdown surfaces built-in/user aliases too', async () => {
    // Repro of: editing a project template whose project only defines
    // `glm-ds` showed just `glm-ds` (project) + whatever aliases the
    // template already referenced. Built-in aliases (`opus`, `haiku`)
    // were missing because the dropdown read only `worca.models`.
    // Fix: union `Object.keys(editorState.modelTierMap)` into options.
    // This test pins the tier-map populate path; the union itself is
    // exercised live via the rendered editor.
    mockFetchByUrl({
      '/effective-settings': {
        worca: { models: { 'glm-ds': { id: 'opus' } } },
      },
      '/templates/project/feature-glm-ds': TEMPLATE_BODY,
      '/projects/test-proj/models': {
        ok: true,
        models: [
          { alias: 'glm-ds', tier: 'project' },
          { alias: 'opus', tier: 'builtin' },
          { alias: 'sonnet', tier: 'builtin' },
          { alias: 'haiku', tier: 'builtin' },
        ],
      },
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    // All four aliases reachable for the dropdown union.
    expect(Object.keys(st.modelTierMap).sort()).toEqual([
      'glm-ds',
      'haiku',
      'opus',
      'sonnet',
    ]);
    expect(st.modelTierMap['glm-ds']).toBe('project');
    expect(st.modelTierMap.opus).toBe('builtin');
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

describe('pipelines-editor — per-tier model refs and lock toggle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeTemplatBody = (model) => ({
    ok: true,
    template: {
      id: 'feature-glm-ds',
      name: 'Feature (GLM-DS)',
      description: '',
      tags: [],
      params: {},
      config: { agents: { planner: { model } } },
    },
  });

  it('bare glm-ds with both user+project entries: PROJECT row selected, lock OFF, saves back glm-ds', async () => {
    mockFetchByUrl({
      '/effective-settings': {
        worca: { models: { 'glm-ds': { id: 'opus' } } },
      },
      '/templates/project/feature-glm-ds': makeTemplatBody('glm-ds'),
      '/projects/test-proj/models': {
        ok: true,
        models: [
          { alias: 'glm-ds', tier: 'user' },
          { alias: 'glm-ds', tier: 'project' },
        ],
      },
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    // Bare ref → lock is OFF
    expect(st.formBuffer.agents.planner._model_pin_locked).toBe(false);
    // Project wins over user in tierMap (highest priority)
    expect(st.modelTierMap['glm-ds']).toBe('project');
    // Both rows are preserved (no priority collapse)
    expect(st.modelTierRows.filter((r) => r.alias === 'glm-ds')).toHaveLength(
      2,
    );
    // Serialises back to bare alias (lock is OFF)
    const config = formBufferToConfig(st.formBuffer);
    expect(config.agents.planner.model).toBe('glm-ds');
  });

  it('user:glm-ds present: USER row selected, lock ON, saves back user:glm-ds', async () => {
    mockFetchByUrl({
      '/effective-settings': {
        worca: { models: { 'glm-ds': { id: 'opus' } } },
      },
      '/templates/project/feature-glm-ds': makeTemplatBody('user:glm-ds'),
      '/projects/test-proj/models': {
        ok: true,
        models: [
          { alias: 'glm-ds', tier: 'user' },
          { alias: 'glm-ds', tier: 'project' },
        ],
      },
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    // Pinned ref → lock is ON
    expect(st.formBuffer.agents.planner._model_pin_locked).toBe(true);
    expect(st.formBuffer.agents.planner.model).toBe('user:glm-ds');
    // Serialises back preserving the tier prefix
    const config = formBufferToConfig(st.formBuffer);
    expect(config.agents.planner.model).toBe('user:glm-ds');
  });

  it('user:glm-ds absent from user tier: warning in validationIssues, value preserved', async () => {
    mockFetchByUrl({
      '/effective-settings': { worca: { models: {} } },
      '/templates/project/feature-glm-ds': makeTemplatBody('user:glm-ds'),
      '/projects/test-proj/models': {
        ok: true,
        // Only project tier — no user-tier glm-ds
        models: [{ alias: 'glm-ds', tier: 'project' }],
      },
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    // Value preserved verbatim
    expect(st.formBuffer.agents.planner.model).toBe('user:glm-ds');
    // Warning surfaced
    const warnings = st.validationIssues.filter(
      (i) => i.severity === 'warning',
    );
    expect(warnings.some((w) => w.message.includes('user:glm-ds'))).toBe(true);
  });

  it('lock OFF→ON on a PROJECT row: agent.model becomes project:glm-ds', async () => {
    mockFetchByUrl({
      '/effective-settings': {
        worca: { models: { 'glm-ds': { id: 'opus' } } },
      },
      '/templates/project/feature-glm-ds': makeTemplatBody('glm-ds'),
      '/projects/test-proj/models': {
        ok: true,
        models: [{ alias: 'glm-ds', tier: 'project' }],
      },
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    expect(st.formBuffer.agents.planner._model_pin_locked).toBe(false);
    expect(st.formBuffer.agents.planner.model).toBe('glm-ds');

    applyModelLockToggle('planner');

    expect(st.formBuffer.agents.planner._model_pin_locked).toBe(true);
    expect(st.formBuffer.agents.planner.model).toBe('project:glm-ds');
  });

  it('lock ON→OFF: agent.model becomes bare glm-ds', async () => {
    mockFetchByUrl({
      '/effective-settings': { worca: { models: {} } },
      '/templates/project/feature-glm-ds': makeTemplatBody('user:glm-ds'),
      '/projects/test-proj/models': {
        ok: true,
        models: [{ alias: 'glm-ds', tier: 'user' }],
      },
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    expect(st.formBuffer.agents.planner._model_pin_locked).toBe(true);

    applyModelLockToggle('planner');

    expect(st.formBuffer.agents.planner._model_pin_locked).toBe(false);
    expect(st.formBuffer.agents.planner.model).toBe('glm-ds');
  });

  it('regression: dropdown enumerates both user and project glm-ds rows (no priority collapse)', async () => {
    mockFetchByUrl({
      '/effective-settings': {
        worca: { models: { 'glm-ds': { id: 'opus' } } },
      },
      '/templates/project/feature-glm-ds': makeTemplatBody('glm-ds'),
      '/projects/test-proj/models': {
        ok: true,
        models: [
          { alias: 'glm-ds', tier: 'user' },
          { alias: 'glm-ds', tier: 'project' },
          { alias: 'opus', tier: 'builtin' },
        ],
      },
    });

    await loadTemplate('project', 'feature-glm-ds', 'test-proj');

    const st = getEditorState();
    const glmDsRows = st.modelTierRows.filter((r) => r.alias === 'glm-ds');
    expect(glmDsRows).toHaveLength(2);
    expect(glmDsRows.map((r) => r.tier).sort()).toEqual(['project', 'user']);
  });
});
