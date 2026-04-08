import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf-8');

describe('bead tooltip CSS styles', () => {
  describe('.bead-tooltip-content', () => {
    it('exists with max-width and padding', () => {
      const match = css.match(/\.bead-tooltip-content\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('max-width:');
      expect(block).toContain('padding:');
    });

    it('has max-width of 320px', () => {
      const match = css.match(/\.bead-tooltip-content\s*\{([^}]+)\}/);
      expect(match[1]).toContain('320px');
    });
  });

  describe('.bead-tooltip-title', () => {
    it('has bold font-weight', () => {
      const match = css.match(/\.bead-tooltip-title\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('font-weight:');
    });

    it('truncates overflow text', () => {
      const match = css.match(/\.bead-tooltip-title\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('overflow: hidden');
      expect(block).toContain('text-overflow: ellipsis');
      expect(block).toContain('white-space: nowrap');
    });
  });

  describe('.bead-tooltip-meta', () => {
    it('exists with font-size styling', () => {
      const match = css.match(/\.bead-tooltip-meta\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('font-size:');
    });

    it('uses muted color', () => {
      const match = css.match(/\.bead-tooltip-meta\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('color:');
    });
  });

  describe('.bead-tooltip-excerpt', () => {
    it('exists with font-size and muted color', () => {
      const match = css.match(/\.bead-tooltip-excerpt\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('font-size:');
      expect(block).toContain('color:');
    });

    it('handles overflow', () => {
      const match = css.match(/\.bead-tooltip-excerpt\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('overflow: hidden');
    });
  });

  describe('.bead-tooltip-deps', () => {
    it('exists with flex layout', () => {
      const match = css.match(/\.bead-tooltip-deps\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('display: flex');
      expect(block).toContain('gap:');
    });

    it('allows wrapping', () => {
      const match = css.match(/\.bead-tooltip-deps\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('flex-wrap: wrap');
    });
  });
});
