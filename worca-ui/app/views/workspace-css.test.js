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
    // Only match `var(--name)` usages so BEM-style modifier suffixes
    // in selectors (e.g. `.template-card--clickable`) aren't picked up
    // as CSS custom properties.
    const customProps = Array.from(
      dagSection.matchAll(/var\((--[a-z][\w-]*)/g),
      (m) => m[1],
    );
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
      // Used by the .template-card inert-hover override below the DAG
      // section — re-states the base .run-card background so the
      // clickable lift effect is suppressed when no edit handler is wired.
      '--surface',
      // Used by the editor's `.editor-tab-group` rule to colour the
      // active-tab indicator. Shoelace exposes its design tokens as
      // `--sl-color-*`; we tap into the primary 600 swatch as a
      // fallback when our own `--accent` isn't set.
      '--sl-color-primary-600',
      // Used by the editor's `.editor-field-pill--invalid` rule (ID
      // collision warning border). Shoelace warning swatch with a
      // hex fallback so themes without Shoelace still render the
      // amber edge.
      '--sl-color-warning-600',
      // Used by the W-061 help-mode prototype (right-edge "Help" tab +
      // per-surface .help-badge): Shoelace's neutral and primary scales
      // are tapped for the muted-idle / primary-active treatment and
      // for dark-mode contrast. Each var has a hex fallback in the
      // CSS rules so themes without Shoelace still render.
      '--sl-color-neutral-0',
      '--sl-color-neutral-100',
      '--sl-color-neutral-200',
      '--sl-color-neutral-300',
      '--sl-color-neutral-400',
      '--sl-color-neutral-700',
      '--sl-color-primary-50',
      '--sl-color-primary-500',
      '--sl-color-primary-700',
      // Used by the overlays tab (pipelines-editor-overlays) — spacing,
      // border-radius, color, and typography tokens from Shoelace.
      '--sl-spacing-x-small',
      '--sl-spacing-small',
      '--sl-spacing-medium',
      '--sl-border-radius-medium',
      '--sl-color-neutral-500',
      '--sl-color-neutral-600',
      '--sl-font-size-small',
      '--sl-font-size-x-small',
      '--sl-font-weight-semibold',
      // File Access view (access-treetable, heatmap, scope-dot, searches)
      // added after DAG rules — these are legitimate access-view tokens.
      '--text-muted',
      '--fa-file-col-width',
      '--fa-cell-width',
      '--fa-cell-height',
      '--depth',
      '--heat',
      // File Access drawer panels (file-history / cell-detail overlays)
      // use --shadow-lg for the drawer drop shadow and --accent-hover for
      // the timeline link hover state.
      '--shadow-lg',
      '--accent-hover',
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
