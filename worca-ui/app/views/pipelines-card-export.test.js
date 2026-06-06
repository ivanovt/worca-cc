/**
 * Tests: export action and gist guard for template cards (W-064 Phase 6).
 *
 * Covers:
 * - "Export (gist)" button visible when has_overlays: false
 * - "Export (gist)" button hidden + overlay note shown when has_overlays: true
 * - Export button label is "Export (json)" / "Export (zip)" per has_overlays
 * - exportTemplate uses response.blob() for both zip and JSON responses
 * - exportTemplate parses filename from Content-Disposition header
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'lit-html';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportTemplate, pipelinesView } from './pipelines.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, 'pipelines.js'), 'utf8');

function mount(state, options = {}) {
  const container = document.createElement('div');
  render(pipelinesView(state, options), container);
  return container;
}

function cardForId(root, id) {
  return Array.from(root.querySelectorAll('.template-card')).find(
    (c) => c.querySelector('.template-card-id')?.textContent?.trim() === id,
  );
}

const HEALTHY = {
  ok: true,
  installed: '0.47.0',
  minimum: '0.47.0',
  message: 'compatible',
};

const TPL_NO_OVERLAYS = {
  id: 'simple-tpl',
  name: 'Simple Template',
  description: 'no overlays',
  tier: 'project',
  builtin: false,
  has_overlays: false,
};

const TPL_WITH_OVERLAYS = {
  id: 'overlay-tpl',
  name: 'Overlay Template',
  description: 'has overlays',
  tier: 'project',
  builtin: false,
  has_overlays: true,
};

const baseHandlers = {
  onEdit: () => {},
  onDuplicate: () => {},
  onDelete: () => {},
  onExport: () => {},
  onGist: () => {},
};

describe('pipelinesView — gist guard (has_overlays)', () => {
  let container;

  afterEach(() => {
    container = null;
  });

  it('shows "Export (gist)" button when has_overlays is false', () => {
    container = mount(
      {
        templates: [TPL_NO_OVERLAYS],
        templatesLoaded: true,
        worcaCliStatus: HEALTHY,
      },
      baseHandlers,
    );
    const card = cardForId(container, 'simple-tpl');
    expect(card).toBeDefined();
    const gistBtn = Array.from(card.querySelectorAll('button')).find((b) =>
      (b.textContent || '').includes('Export (gist)'),
    );
    expect(gistBtn).toBeDefined();
  });

  it('hides "Export (gist)" button when has_overlays is true', () => {
    container = mount(
      {
        templates: [TPL_WITH_OVERLAYS],
        templatesLoaded: true,
        worcaCliStatus: HEALTHY,
      },
      baseHandlers,
    );
    const card = cardForId(container, 'overlay-tpl');
    expect(card).toBeDefined();
    const gistBtn = Array.from(card.querySelectorAll('button')).find((b) =>
      (b.textContent || '').includes('Export (gist)'),
    );
    expect(gistBtn).toBeUndefined();
  });

  // The bundle-download button now has a static "Export" label — the
  // standalone/delta mode (and resulting zip-vs-json format) is chosen in the
  // export dialog, not baked into the card label.
  it('labels the bundle button "Export" regardless of has_overlays', () => {
    for (const tpl of [TPL_NO_OVERLAYS, TPL_WITH_OVERLAYS]) {
      container = mount(
        { templates: [tpl], templatesLoaded: true, worcaCliStatus: HEALTHY },
        baseHandlers,
      );
      const card = cardForId(container, tpl.id);
      expect(card).toBeDefined();
      const exportBtn = card.querySelector(
        'button[title="Export template bundle"]',
      );
      expect(exportBtn).not.toBeNull();
      expect((exportBtn.textContent || '').trim()).toBe('Export');
      // No stale dynamic "(json)"/"(zip)" suffix on the bundle button.
      expect(exportBtn.textContent).not.toContain('(json)');
      expect(exportBtn.textContent).not.toContain('(zip)');
    }
  });

  it('does not show the legacy overlay note when has_overlays is true', () => {
    // The "must be shared as a downloaded .zip file" note was removed — the
    // dynamic "Export (zip)" label already conveys the format, and no gist
    // button renders for overlay templates.
    container = mount(
      {
        templates: [TPL_WITH_OVERLAYS],
        templatesLoaded: true,
        worcaCliStatus: HEALTHY,
      },
      baseHandlers,
    );
    const card = cardForId(container, 'overlay-tpl');
    expect(card).toBeDefined();
    expect(card.textContent).not.toContain(
      'Templates with prompt overlays must be shared as a downloaded .zip file',
    );
  });

  it('does not show overlay note when has_overlays is false', () => {
    container = mount(
      {
        templates: [TPL_NO_OVERLAYS],
        templatesLoaded: true,
        worcaCliStatus: HEALTHY,
      },
      baseHandlers,
    );
    const card = cardForId(container, 'simple-tpl');
    expect(card).toBeDefined();
    expect(card.textContent).not.toContain('prompt overlays');
  });
});

describe('exportTemplate — blob download path', () => {
  it('uses response.blob() instead of response.json() for download', () => {
    // Extract the exportTemplate function body from source text.
    // This verifies the structural contract without browser fetch side-effects.
    const marker = 'export async function exportTemplate(';
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}') depth--;
      if (depth === 0) break;
    }
    const body = src.slice(start, i + 1);
    // Must use blob(), not json() for the download
    expect(body).toContain('response.blob()');
    expect(body).not.toContain('response.json()');
  });

  it('reads filename from Content-Disposition header', () => {
    const marker = 'export async function exportTemplate(';
    const start = src.indexOf(marker);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}') depth--;
      if (depth === 0) break;
    }
    const body = src.slice(start, i + 1);
    expect(body).toContain('Content-Disposition');
  });

  it('triggers browser download using a blob URL', async () => {
    const mockBlob = new Blob(['fake zip content'], {
      type: 'application/zip',
    });
    const mockHeaders = new Headers({
      'Content-Disposition': 'attachment; filename="my-tpl-bundle.zip"',
      'Content-Type': 'application/zip',
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(mockBlob),
      headers: mockHeaders,
    });

    const createdUrls = [];
    const revokedUrls = [];
    global.URL.createObjectURL = vi.fn((_b) => {
      const u = `blob:fake/${createdUrls.length}`;
      createdUrls.push(u);
      return u;
    });
    global.URL.revokeObjectURL = vi.fn((u) => revokedUrls.push(u));

    const clickedLinks = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        vi.spyOn(el, 'click').mockImplementation(() =>
          clickedLinks.push(el.download),
        );
      }
      return el;
    });

    const result = await exportTemplate(null, 'my-tpl', 'project', 'My Tpl');

    expect(result.success).toBe(true);
    expect(result.filename).toBe('my-tpl-bundle.zip');
    expect(createdUrls.length).toBeGreaterThan(0);
    expect(clickedLinks).toContain('my-tpl-bundle.zip');

    vi.restoreAllMocks();
  });

  it('falls back to default filename when Content-Disposition is absent', async () => {
    const mockBlob = new Blob(['{"ok":true}'], { type: 'application/json' });
    const mockHeaders = new Headers({ 'Content-Type': 'application/json' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(mockBlob),
      headers: mockHeaders,
    });

    global.URL.createObjectURL = vi.fn(() => 'blob:fake/1');
    global.URL.revokeObjectURL = vi.fn();

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        vi.spyOn(el, 'click').mockImplementation(() => {});
      }
      return el;
    });

    const result = await exportTemplate(null, 'cfg-tpl', 'project', 'Cfg Tpl');

    expect(result.success).toBe(true);
    // Fallback filename uses templateName or templateId
    expect(result.filename).toMatch(/cfg-tpl|Cfg Tpl/);

    vi.restoreAllMocks();
  });

  it('requests standalone mode by default, delta when asked', async () => {
    const mockBlob = new Blob(['x'], { type: 'application/zip' });
    const headers = new Headers({
      'Content-Disposition': 'attachment; filename="t-bundle.zip"',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(mockBlob),
      headers,
    });
    global.fetch = fetchMock;
    global.URL.createObjectURL = vi.fn(() => 'blob:fake');
    global.URL.revokeObjectURL = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') vi.spyOn(el, 'click').mockImplementation(() => {});
      return el;
    });

    await exportTemplate('proj', 't', 'project', 'T');
    expect(fetchMock.mock.calls[0][0]).toContain('?mode=standalone');

    await exportTemplate('proj', 't', 'project', 'T', 'delta');
    expect(fetchMock.mock.calls[1][0]).toContain('?mode=delta');

    // An unknown mode normalises to standalone.
    await exportTemplate('proj', 't', 'project', 'T', 'bogus');
    expect(fetchMock.mock.calls[2][0]).toContain('?mode=standalone');

    vi.restoreAllMocks();
  });
});
