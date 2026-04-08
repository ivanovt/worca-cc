import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf-8');

describe('.run-template CSS styles', () => {
  it('has .run-template with flex layout like .run-branch', () => {
    const match = css.match(/\.run-template\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    const block = match[1];
    expect(block).toContain('display: flex');
    expect(block).toContain('align-items: center');
    expect(block).toContain('gap:');
  });

  it('has .run-template with 13px font-size', () => {
    const match = css.match(/\.run-template\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toContain('font-size: 13px');
  });
});

describe('new-run pipeline section sl-select styling', () => {
  it('has .new-run-section sl-select with full width', () => {
    expect(css).toMatch(/\.new-run-section\s+sl-select\s*\{[^}]*width:\s*100%/);
  });
});
