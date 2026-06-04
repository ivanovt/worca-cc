/**
 * Tests for zip bundle support in the import dialog (main.js).
 *
 * Phase 5 of W-064: zip file-picker + binary POST.
 *
 * Uses source-text inspection to verify structural contracts without
 * importing main.js (which has browser-side side effects and DOM deps).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, 'main.js'), 'utf8');

function extractFnBody(source, fnName) {
  const marker = `function ${fnName}(`;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  let i = source.indexOf('{', start);
  if (i === -1) return null;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) break;
  }
  return source.slice(start, i + 1);
}

describe('_onImportFileChange: zip sniff', () => {
  const fnBody = extractFnBody(src, '_onImportFileChange');

  it('reads magic bytes from file head', () => {
    expect(fnBody).toContain('arrayBuffer');
    expect(fnBody).toContain('Uint8Array');
  });

  it('detects ZIP magic bytes (PK header)', () => {
    expect(fnBody).toContain('0x50');
    expect(fnBody).toContain('0x4b');
  });

  it('sniffs by extension fallback (.zip filename routed even without magic)', () => {
    // Must check filename extension as a fallback path
    expect(fnBody).toMatch(/\.zip/i);
    // Must set _kind so downstream code knows it's a zip
    expect(fnBody).toContain('_kind');
  });

  it('sets parsed._kind to zip for zip files', () => {
    expect(fnBody).toContain("_kind: 'zip'");
  });
});

describe('import dialog template: zip hint', () => {
  const fnBody = extractFnBody(src, '_templateActionDialogTemplate');

  it('accept attribute includes .zip', () => {
    expect(fnBody).toContain('.zip');
  });

  it('renders "Bundle contains prompt overlays" hint for zip files', () => {
    expect(fnBody).toContain('prompt overlays');
  });

  it('gates zip hint on _kind check', () => {
    expect(fnBody).toContain('_kind');
  });
});

describe('_confirmTemplateActionDialog: zip POST shape', () => {
  const fnBody = extractFnBody(src, '_confirmTemplateActionDialog');

  it('sends raw binary body with Content-Type application/zip for zip files', () => {
    expect(fnBody).toContain('application/zip');
  });

  it('sends JSON body with bundle key for non-zip files', () => {
    expect(fnBody).toContain('JSON.stringify');
    expect(fnBody).toContain('bundle:');
  });

  it('routes zip vs JSON based on _kind field', () => {
    expect(fnBody).toContain('_kind');
  });

  it('passes dst_tier as query param for zip POST', () => {
    expect(fnBody).toContain('dst_tier');
  });
});
