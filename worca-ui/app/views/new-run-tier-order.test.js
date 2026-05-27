/**
 * Tests: new-run.js template tier ordering in dropdown.
 * Tier groups must render USER → PROJECT → WORCA (resolution precedence).
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

describe('new-run — template tier order', () => {
  let newRunView, resetNewRunState;

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
    vi.doMock('./settings.js', () => ({
      getDefaults: () => ({ msize: 1, mloops: 1 }),
    }));

    const mod = await import('./new-run.js');
    newRunView = mod.newRunView;
    resetNewRunState = mod.resetNewRunState;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders tier groups in USER → PROJECT → WORCA order', async () => {
    const templates = [
      { id: 'w-tpl', name: 'Worca Tpl', tier: 'worca' },
      { id: 'p-tpl', name: 'Project Tpl', tier: 'project' },
      { id: 'u-tpl', name: 'User Tpl', tier: 'user' },
    ];

    globalThis.fetch = vi.fn((_url) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            templates,
            branches: [],
          }),
      }),
    );

    resetNewRunState();
    const _tpl = newRunView(
      { currentProjectId: 'proj-1' },
      { rerender: vi.fn() },
    );

    await new Promise((r) => setTimeout(r, 30));

    const tpl2 = newRunView(
      { currentProjectId: 'proj-1' },
      { rerender: vi.fn() },
    );

    const html = renderToString(tpl2);

    const userIdx = html.indexOf('template-group-label">USER');
    const projectIdx = html.indexOf('template-group-label">PROJECT');
    const worcaIdx = html.indexOf('template-group-label">WORCA');

    expect(userIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeGreaterThan(-1);
    expect(worcaIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(worcaIdx);
  });

  it('hint text lists tiers in user, project, worca order', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, templates: [], branches: [] }),
      }),
    );

    resetNewRunState();
    const tpl = newRunView(
      { currentProjectId: 'proj-1' },
      { rerender: vi.fn() },
    );
    const html = renderToString(tpl);

    expect(html).toContain('Groups: user, project, worca');
  });
});
