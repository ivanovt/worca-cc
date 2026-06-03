/**
 * L1 — source-resolution check for the HELP_LINKS registry.
 *
 * Catches the failure modes the live L2 check (scripts/check-help-links-live.py)
 * can't catch at PR time:
 *   - Typo'd slug that doesn't exist on disk.
 *   - Doc page deleted without removing the helpId.
 *   - Anchor (`#section`) sneaking into a slug (anchors silently break on
 *     heading renames; only page-level slugs survive a refactor).
 *   - Empty title (tooltip + aria-label would render blank).
 *   - helpUrl / helpFor contract violations (unknown id, canonical URL shape).
 *
 * Does NOT catch: doc page exists but is thin / wrong / outdated. That's a
 * docs-quality issue, not a sync issue.
 *
 * Lives in worca-ui/app/utils/ so vitest picks it up via the existing
 * worca-ui/vitest.config.js test glob.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_LINKS, helpFor, helpUrl } from './help-links.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Walk up: app/utils/ -> app/ -> worca-ui/ -> worca-cc/
const REPO_ROOT = resolve(__dirname, '../../..');
const DOCS_ROOT = resolve(REPO_ROOT, 'docs-site/src/content/docs');

describe('help-links L1 — every slug resolves to a docs page', () => {
  for (const [id, entry] of Object.entries(HELP_LINKS)) {
    it(`${id} → ${entry.slug} resolves to a .md or .mdx file`, () => {
      const md = resolve(DOCS_ROOT, `${entry.slug}.md`);
      const mdx = resolve(DOCS_ROOT, `${entry.slug}.mdx`);
      const ok = existsSync(md) || existsSync(mdx);
      expect(
        ok,
        `Expected ${entry.slug}.md or ${entry.slug}.mdx to exist under ${DOCS_ROOT}`,
      ).toBe(true);
    });

    it(`${id} slug has no anchor fragment`, () => {
      expect(
        entry.slug,
        `Anchors silently break on heading renames; ${id} should use a page-level slug.`,
      ).not.toContain('#');
    });

    it(`${id} has a non-empty title`, () => {
      expect(entry.title).toBeTypeOf('string');
      expect(entry.title.trim().length, `${id} title is blank`).toBeGreaterThan(
        0,
      );
    });
  }
});

describe('help-links — helpUrl contract', () => {
  it('returns null for an unknown id', () => {
    expect(helpUrl('this-id-does-not-exist')).toBe(null);
  });

  it('returns a canonical URL ending in /<slug>/ for a known id', () => {
    const url = helpUrl('crg');
    expect(url).not.toBe(null);
    expect(url.endsWith('/advanced/code-review-graph/')).toBe(true);
  });

  it('honours the default DOCS_BASE when WORCA_DOCS_BASE is unset', () => {
    // The module's typeof guard means a process without WORCA_DOCS_BASE
    // defined as a global falls through to the production default.
    expect(helpUrl('crg')).toBe(
      'https://docs.worca.dev/advanced/code-review-graph/',
    );
  });
});

describe('help-links — helpFor contract', () => {
  it('returns null and warns for an unknown id (soft-fail)', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const result = helpFor('this-id-does-not-exist');
      expect(result).toBe(null);
      expect(warnings.some((w) => w.includes('this-id-does-not-exist'))).toBe(
        true,
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('returns a lit-html template result for a known id', () => {
    const tpl = helpFor('crg');
    expect(tpl).not.toBe(null);
    // lit-html TemplateResult shape: { strings, values, _$litType$ }.
    expect(tpl).toHaveProperty('_$litType$');
    expect(tpl).toHaveProperty('strings');
    expect(Array.isArray(tpl.strings)).toBe(true);
    // Strings should mention the target URL + the anchor's a11y wiring.
    const joined = tpl.strings.join('');
    expect(joined).toContain('class="help-badge"');
    expect(joined).toContain('target="_blank"');
    expect(joined).toContain('rel="noopener noreferrer"');
    expect(joined).toContain('aria-label="Open help:');
  });
});
