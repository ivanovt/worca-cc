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

    it('has max-width of 540px', () => {
      const match = css.match(/\.bead-tooltip-content\s*\{([^}]+)\}/);
      expect(match[1]).toContain('540px');
    });
  });

  describe('.bead-tooltip-title', () => {
    it('has bold font-weight', () => {
      const match = css.match(/\.bead-tooltip-title\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('font-weight:');
    });
  });

  describe('.bead-tooltip-header', () => {
    it('exists with flex layout', () => {
      const match = css.match(/\.bead-tooltip-header\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('display: flex');
    });

    it('uses column direction to stack ID above badges', () => {
      const match = css.match(/\.bead-tooltip-header\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('flex-direction: column');
    });
  });

  describe('.bead-tooltip-badges', () => {
    it('uses flex-wrap so badges wrap at narrow widths', () => {
      const match = css.match(/\.bead-tooltip-badges\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('flex-wrap: wrap');
    });
  });

  describe('.bead-tooltip-label', () => {
    it('exists with uppercase styling', () => {
      const match = css.match(/\.bead-tooltip-label\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('text-transform: uppercase');
    });
  });

  describe('.bead-tooltip-excerpt', () => {
    it('exists with font-size', () => {
      const match = css.match(/\.bead-tooltip-excerpt\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('font-size:');
    });

    it('uses normal whitespace for rendered markdown', () => {
      const match = css.match(/\.bead-tooltip-excerpt\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('white-space: normal');
    });
  });

  describe('.bead-tooltip-separator', () => {
    it('exists with border-top', () => {
      const match = css.match(/\.bead-tooltip-separator\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('border-top:');
    });
  });

  describe('.bead-tooltip-copy', () => {
    it('exists with cursor pointer', () => {
      const match = css.match(/\.bead-tooltip-copy\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('cursor: pointer');
    });
  });

  describe('.graph-tooltip-trigger', () => {
    it('exists with absolute positioning', () => {
      const match = css.match(/\.graph-tooltip-trigger\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('position: absolute');
    });
  });
});
