import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf-8');

describe('CSS status color variables', () => {
  it('--status-in-progress uses blue (#3b82f6) for active work', () => {
    const match = css.match(/--status-in-progress:\s*([^;]+);/);
    expect(match).not.toBeNull();
    expect(match[1].trim()).toBe('#3b82f6');
  });

  it('--status-blocked uses amber (#f59e0b) for waiting/blocked state', () => {
    const match = css.match(/--status-blocked:\s*([^;]+);/);
    expect(match).not.toBeNull();
    expect(match[1].trim()).toBe('#f59e0b');
  });

  it('.beads-kanban-card--in_progress uses border-color: var(--status-in-progress)', () => {
    const match = css.match(/\.beads-kanban-card--in_progress\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toContain('border-color: var(--status-in-progress)');
  });

  it('.beads-graph-edge--blocking uses stroke: var(--status-blocked) for amber blocking edges', () => {
    const match = css.match(/\.beads-graph-edge--blocking\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toContain('stroke: var(--status-blocked)');
    expect(match[1]).not.toContain('var(--status-in-progress)');
  });
});
