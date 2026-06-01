import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '../styles.css'), 'utf8');

describe('workspace CSS — tier styling', () => {
  it('defines .tier-label', () => {
    expect(css).toMatch(/\.tier-label\s*\{/);
  });

  it('tier-label uses small font', () => {
    const block = extractBlock(css, '.tier-label');
    expect(block).toMatch(/font-size:\s*1[12]px/);
  });

  it('tier-label uses muted color', () => {
    const block = extractBlock(css, '.tier-label');
    expect(block).toMatch(/color:\s*var\(--muted\)/);
  });

  it('defines .workspace-tier-row', () => {
    expect(css).toMatch(/\.workspace-tier-row\s*\{/);
  });

  it('workspace-tier-row uses flexbox', () => {
    const block = extractBlock(css, '.workspace-tier-row');
    expect(block).toMatch(/display:\s*flex/);
  });

  it('defines .workspace-card-tiers', () => {
    expect(css).toMatch(/\.workspace-card-tiers\s*\{/);
  });

  it('defines .tier-children', () => {
    expect(css).toMatch(/\.tier-children\s*\{/);
  });

  it('defines .tier-child', () => {
    expect(css).toMatch(/\.tier-child\s*\{/);
  });

  it('defines .tier-status', () => {
    expect(css).toMatch(/\.tier-status\s*\{/);
  });
});

describe('workspace CSS — DAG styling', () => {
  it('defines .dag-preview', () => {
    expect(css).toMatch(/\.dag-preview\s*\{/);
  });

  it('dag-preview has overflow-x auto', () => {
    const block = extractBlock(css, '.dag-preview');
    expect(block).toMatch(/overflow-x:\s*auto/);
  });

  it('defines .dag-graph-node rect styling', () => {
    expect(css).toMatch(/\.dag-graph-node\s+rect\s*\{/);
  });

  it('dag-graph-node rect uses rounded corners via rx', () => {
    const block = extractBlock(css, '.dag-graph-node rect');
    expect(block).toMatch(/rx:\s*6/);
  });

  it('defines .dag-graph-node text styling', () => {
    expect(css).toMatch(/\.dag-graph-node\s+text\s*\{/);
  });

  it('dag-graph-node text uses sans font', () => {
    const block = extractBlock(css, '.dag-graph-node text');
    expect(block).toMatch(/font-family:\s*var\(--sl-font-sans\)/);
  });

  it('defines .dag-graph-edge styling', () => {
    expect(css).toMatch(/\.dag-graph-edge\s*\{/);
  });

  it('dag-graph-edge has fill none and stroke-width', () => {
    const block = extractBlock(css, '.dag-graph-edge');
    expect(block).toMatch(/fill:\s*none/);
    expect(block).toMatch(/stroke-width/);
  });

  it('defines status-specific node fills using --status-* vars', () => {
    expect(css).toMatch(
      /\.dag-graph-node--status-running\s+rect\s*\{[^}]*var\(--status-running\)/,
    );
    expect(css).toMatch(
      /\.dag-graph-node--status-completed\s+rect\s*\{[^}]*var\(--status-completed\)/,
    );
    expect(css).toMatch(
      /\.dag-graph-node--status-failed\s+rect\s*\{[^}]*var\(--status-failed\)/,
    );
    expect(css).toMatch(
      /\.dag-graph-node--status-pending\s+rect\s*\{[^}]*var\(--status-pending\)/,
    );
    expect(css).toMatch(
      /\.dag-graph-node--status-paused\s+rect\s*\{[^}]*var\(--status-paused\)/,
    );
    expect(css).toMatch(
      /\.dag-graph-node--status-blocked\s+rect\s*\{[^}]*var\(--status-blocked\)/,
    );
  });

  it('does not introduce new CSS variables', () => {
    const dagSection = css.slice(css.indexOf('.dag-graph-node'));
    const customProps = dagSection.match(/--[a-z][\w-]*/g) || [];
    const allowed = new Set([
      '--status-pending',
      '--status-running',
      '--status-completed',
      '--status-failed',
      '--status-paused',
      '--status-blocked',
      '--status-skipped',
      '--status-interrupted',
      '--status-cancelled',
      '--status-in-progress',
      '--status-error',
      '--border',
      '--bg',
      '--fg',
      '--muted',
      '--sl-font-sans',
      '--radius',
      '--shadow-sm',
      '--bg-secondary',
      '--bg-tertiary',
      '--border-subtle',
      '--accent',
      '--transition-fast',
      '--status-planning',
      '--status-integration-testing',
      '--status-integration-failed',
      '--fg-muted',
      '--fg-active',
      '--radius-lg',
      '--sl-font-mono',
      '--json',
      '--disabled',
      '--changed',
      '--builtin',
      '--current',
    ]);
    for (const prop of customProps) {
      expect(allowed.has(prop)).toBe(true);
    }
  });

  it('defines .workspace-dag-panel', () => {
    expect(css).toMatch(/\.workspace-dag-panel\s*\{/);
  });

  it('defines .workspace-dag-svg', () => {
    expect(css).toMatch(/\.workspace-dag-svg\s*\{/);
  });
});

describe('workspace CSS — conflict icon', () => {
  it('defines .conflict-icon styling', () => {
    expect(css).toMatch(/\.conflict-icon\s*\{/);
  });

  it('conflict-icon uses a --status-* color variable', () => {
    const block = extractBlock(css, '.conflict-icon');
    expect(block).toMatch(/color:\s*var\(--status-/);
  });

  it('conflict-icon uses warning/error-family color', () => {
    const block = extractBlock(css, '.conflict-icon');
    expect(block).toMatch(
      /var\(--status-(paused|blocked|failed|error|interrupted)\)/,
    );
  });
});

function extractBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const match = css.match(re);
  return match ? match[1] : '';
}
