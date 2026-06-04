/**
 * Tests: export action and gist guard for template cards (W-064 Phase 6).
 *
 * Covers:
 * - "Copy gist URL" button visible when has_overlays: false
 * - "Copy gist URL" button hidden + overlay note shown when has_overlays: true
 * - exportTemplate uses response.blob() for both zip and JSON responses
 * - exportTemplate parses filename from Content-Disposition header
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'lit-html';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('shows "Copy gist URL" button when has_overlays is false', () => {
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
      (b.textContent || '').includes('Copy gist URL'),
    );
    expect(gistBtn).toBeDefined();
  });

  it('hides "Copy gist URL" button when has_overlays is true', () => {
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
      (b.textContent || '').includes('Copy gist URL'),
    );
    expect(gistBtn).toBeUndefined();
  });

  it('shows overlay note when has_overlays is true', () => {
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
    expect(card.textContent).toContain(
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
    global.URL.createObjectURL = vi.fn((b) => {
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
});
