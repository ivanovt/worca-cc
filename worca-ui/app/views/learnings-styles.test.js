import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf-8');

describe('learnings + skipped CSS styles', () => {
  describe('.learnings-section', () => {
    it('exists with same margin as .run-beads-section', () => {
      const match = css.match(/\.learnings-section\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('margin:');
    });
  });

  describe('sl-details.learnings-panel', () => {
    it('has ::part(base) styled like run-beads-panel', () => {
      const match = css.match(
        /sl-details\.learnings-panel::part\(base\)\s*\{([^}]+)\}/,
      );
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('border:');
      expect(block).toContain('border-radius:');
      expect(block).toContain('background:');
    });

    it('has ::part(header) with padding', () => {
      const match = css.match(
        /sl-details\.learnings-panel::part\(header\)\s*\{([^}]+)\}/,
      );
      expect(match).not.toBeNull();
      expect(match[1]).toContain('padding:');
    });

    it('has ::part(content) with padding', () => {
      const match = css.match(
        /sl-details\.learnings-panel::part\(content\)\s*\{([^}]+)\}/,
      );
      expect(match).not.toBeNull();
      expect(match[1]).toContain('padding:');
    });
  });

  describe('.learnings-header', () => {
    it('uses flex layout with gap', () => {
      const match = css.match(/\.learnings-header\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('display: flex');
      expect(block).toContain('align-items: center');
      expect(block).toContain('gap:');
    });
  });

  describe('skipped status', () => {
    it('has .status-skipped with muted color and opacity', () => {
      const match = css.match(/\.status-skipped\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('color: var(--muted)');
      expect(block).toContain('opacity:');
    });

    it('has .stage-node.status-skipped .stage-icon with dashed border', () => {
      const match = css.match(
        /\.stage-node\.status-skipped\s+\.stage-icon\s*\{([^}]+)\}/,
      );
      expect(match).not.toBeNull();
      expect(match[1]).toContain('border-style: dashed');
    });
  });

  describe('.learnings-table', () => {
    it('uses grid layout with gap and border-radius', () => {
      const match = css.match(/\.learnings-table\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('display: grid');
      expect(block).toContain('gap:');
      expect(block).toContain('border-radius:');
      expect(block).toContain('overflow: hidden');
    });
  });

  describe('.learnings-table-header', () => {
    it('uses grid with 5-column template', () => {
      const match = css.match(/\.learnings-table-header\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('display: grid');
      expect(block).toContain('grid-template-columns:');
      expect(block).toContain('font-weight: 600');
    });
  });

  describe('.learnings-table-row', () => {
    it('uses grid with matching column template', () => {
      const match = css.match(/\.learnings-table-row\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('display: grid');
      expect(block).toContain('grid-template-columns:');
      expect(block).toContain('padding:');
    });
  });

  describe('.learnings-summary-strip', () => {
    it('exists with flex layout', () => {
      const match = css.match(/\.learnings-summary-strip\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('display: flex');
      expect(block).toContain('gap:');
    });
  });

  describe('.learnings-evidence', () => {
    it('has styling for evidence text', () => {
      const match = css.match(/\.learnings-evidence\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('font-size:');
      expect(block).toContain('color:');
    });
  });

  describe('.learnings-category', () => {
    it('has styling for category labels', () => {
      const match = css.match(/\.learnings-category\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('font-size:');
    });
  });

  describe('learnings icon and count', () => {
    it('has .learnings-icon styled like .run-beads-icon', () => {
      const match = css.match(/\.learnings-icon\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('color:');
    });

    it('has .learnings-title styled like .run-beads-title', () => {
      const match = css.match(/\.learnings-title\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('font-weight: 600');
    });

    it('has .learnings-count styled like .run-beads-count', () => {
      const match = css.match(/\.learnings-count\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('background:');
      expect(match[1]).toContain('border-radius:');
    });
  });

  describe('.learnings-empty', () => {
    it('has muted styling like .run-beads-empty', () => {
      const match = css.match(/\.learnings-empty\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('color: var(--muted)');
    });
  });

  describe('.learnings-table-title', () => {
    it('has heading styling', () => {
      const match = css.match(/\.learnings-table-title\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('font-size:');
      expect(match[1]).toContain('font-weight:');
    });
  });

  describe('.learnings-in-progress', () => {
    it('has flex layout with gap', () => {
      const match = css.match(/\.learnings-in-progress\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      const block = match[1];
      expect(block).toContain('display: flex');
      expect(block).toContain('gap:');
    });
  });

  describe('.learnings-error', () => {
    it('has flex layout', () => {
      const match = css.match(/\.learnings-error\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('display: flex');
    });
  });

  describe('.learnings-rerun', () => {
    it('has right-aligned text', () => {
      const match = css.match(/\.learnings-rerun\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('text-align: right');
    });
  });
});
