import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf-8');

// `.run-template` shares its rule body with .run-project / .run-branch /
// .run-worktree (single multi-selector block), so the regex matches a
// selector list that contains `.run-template` somewhere — not just a
// standalone block. Same intent: verify the row gets the shared flex
// layout + 13px font-size.
const TEMPLATE_BLOCK_RE =
  /(?:[.a-zA-Z0-9_,\s-]*\.run-template[^{]*)\{([^}]+)\}/;

describe('.run-template CSS styles', () => {
  it('has .run-template with flex layout like .run-branch', () => {
    const match = css.match(TEMPLATE_BLOCK_RE);
    expect(match).not.toBeNull();
    const block = match[1];
    expect(block).toContain('display: flex');
    expect(block).toContain('align-items: center');
    expect(block).toContain('gap:');
  });

  it('has .run-template with 13px font-size', () => {
    const match = css.match(TEMPLATE_BLOCK_RE);
    expect(match).not.toBeNull();
    expect(match[1]).toContain('font-size: 13px');
  });
});

describe('new-run pipeline section sl-select styling', () => {
  it('has .new-run-section sl-select with full width', () => {
    expect(css).toMatch(/\.new-run-section\s+sl-select\s*\{[^}]*width:\s*100%/);
  });
});

describe('read-only editor Prompts-tab exemption', () => {
  // The built-in (read-only) editor bleaches + pointer-locks every tab panel.
  // The Prompts tab is a read-only viewer that must stay scrollable and
  // full-contrast, so it (and its nested per-stage sub-tab panels) is exempt.
  const EXEMPT_RE =
    /\.editor-content--readonly\s+sl-tab-panel\[name="prompts"\][^{]*\{([^}]+)\}/;

  it('re-enables pointer-events and resets opacity on the Prompts panel', () => {
    const match = css.match(EXEMPT_RE);
    expect(match).not.toBeNull();
    const block = match[1];
    expect(block).toContain('pointer-events: auto');
    expect(block).toContain('opacity: 1');
  });

  it('covers nested per-stage sub-tab panels (not just the outer panel)', () => {
    // The nested `sl-tab-panel`s would otherwise re-match the base
    // pointer-events:none rule, re-breaking inner scroll.
    expect(css).toMatch(
      /\.editor-content--readonly\s+sl-tab-panel\[name="prompts"\]\s+sl-tab-panel/,
    );
  });

  it('resets cursor inside the Prompts panel', () => {
    expect(css).toMatch(
      /\.editor-content--readonly\s+sl-tab-panel\[name="prompts"\]\s+\*\s*\{[^}]*cursor:\s*auto/,
    );
  });
});
