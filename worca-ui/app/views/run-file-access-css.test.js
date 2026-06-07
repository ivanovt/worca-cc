// Verify styles.css contains the File Access (access-*) CSS rules for the
// treetable, badges, heatmap, category colors, KPI strip, and captures strip.
// These are content tests — they check that the CSS is present, not computed styles.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

describe('File Access CSS rules present in styles.css', () => {
  // ── Outer container ────────────────────────────────────────────────────────
  it('defines .run-file-access outer container', () => {
    expect(css).toContain('.run-file-access');
  });

  // ── KPI strip ─────────────────────────────────────────────────────────────
  it('defines .access-kpi-strip', () => {
    expect(css).toContain('.access-kpi-strip');
  });

  it('defines .access-kpi-card', () => {
    expect(css).toContain('.access-kpi-card');
  });

  it('defines .access-kpi-card--amber amber modifier', () => {
    expect(css).toContain('.access-kpi-card--amber');
  });

  it('defines .access-kpi-label and .access-kpi-value', () => {
    expect(css).toContain('.access-kpi-label');
    expect(css).toContain('.access-kpi-value');
  });

  // ── Controls bar ──────────────────────────────────────────────────────────
  it('defines .access-controls', () => {
    expect(css).toContain('.access-controls');
  });

  it('defines .access-heatmap-toggle and --active modifier', () => {
    expect(css).toContain('.access-heatmap-toggle');
    expect(css).toContain('.access-heatmap-toggle--active');
  });

  it('defines .access-chip and category chip modifiers', () => {
    expect(css).toContain('.access-chip');
    expect(css).toContain('.access-chip--reads');
    expect(css).toContain('.access-chip--writes');
    expect(css).toContain('.access-chip--active');
  });

  it('defines .access-path-filter and .access-sort-select', () => {
    expect(css).toContain('.access-path-filter');
    expect(css).toContain('.access-sort-select');
  });

  // ── Treetable container ────────────────────────────────────────────────────
  it('defines .access-treetable', () => {
    expect(css).toContain('.access-treetable');
  });

  it('defines .access-treetable--heatmap modifier', () => {
    expect(css).toContain('.access-treetable--heatmap');
  });

  // ── Sticky header ──────────────────────────────────────────────────────────
  it('defines .access-table-header as sticky', () => {
    expect(css).toMatch(/\.access-table-header\s*\{[^}]*position\s*:\s*sticky/);
  });

  it('defines .access-col-file-header as sticky left', () => {
    expect(css).toMatch(
      /\.access-col-file-header\s*\{[^}]*position\s*:\s*sticky/,
    );
    expect(css).toMatch(/\.access-col-file-header\s*\{[^}]*left\s*:\s*0/);
  });

  it('defines .access-stage-groups as a grid using the shared --fa-grid template', () => {
    expect(css).toMatch(
      /\.access-stage-groups\s*\{[^}]*grid-template-columns:\s*var\(--fa-grid\)/,
    );
  });

  it('defines .access-stage-group-header', () => {
    expect(css).toContain('.access-stage-group-header');
  });

  it('defines .access-col-header', () => {
    expect(css).toContain('.access-col-header');
  });

  it('defines .access-col-header--collapsed', () => {
    expect(css).toContain('.access-col-header--collapsed');
  });

  it('defines .access-sigma-header', () => {
    expect(css).toContain('.access-sigma-header');
  });

  // ── Row layout ────────────────────────────────────────────────────────────
  it('defines .access-row, .access-row--dir, .access-row--file', () => {
    expect(css).toContain('.access-row');
    expect(css).toContain('.access-row--dir');
    expect(css).toContain('.access-row--file');
  });

  it('lays out .access-row on the shared --fa-grid template (so cells align with headers)', () => {
    expect(css).toMatch(
      /\.access-row\s*\{[^}]*grid-template-columns:\s*var\(--fa-grid\)/,
    );
  });

  // ── Cells ─────────────────────────────────────────────────────────────────
  it('defines .access-cell--file as sticky left', () => {
    expect(css).toMatch(/\.access-cell--file\s*\{[^}]*position\s*:\s*sticky/);
    expect(css).toMatch(/\.access-cell--file\s*\{[^}]*left\s*:\s*0/);
  });

  it('indents child rows by one full chevron+folder prefix per depth (44px)', () => {
    // The per-depth indent must equal the chevron+folder prefix on a dir row
    // (chevron 18 + gap 6 + icon 14 + gap 6 = 44), so a child file's name and
    // a nested dir's text both land at the x-position of the parent's text.
    expect(css).toMatch(
      /\.access-cell--file\s*\{[^}]*padding-left\s*:\s*calc\(\s*8px\s*\+\s*var\(\s*--depth[^)]*\)\s*\*\s*44px\s*\)/,
    );
  });

  it('defines .access-col-file-resizer drag handle for the File column', () => {
    expect(css).toContain('.access-col-file-resizer');
    expect(css).toMatch(
      /\.access-col-file-resizer\s*\{[^}]*position\s*:\s*absolute/,
    );
    expect(css).toMatch(
      /\.access-col-file-resizer\s*\{[^}]*cursor\s*:\s*col-resize/,
    );
  });

  it('defines body-level cursor lock for an in-progress file-column resize', () => {
    // While dragging, JS adds .access-col-file-resizing to <body> so the
    // col-resize cursor stays visible even when the pointer leaves the
    // narrow handle hit area.
    expect(css).toContain('.access-col-file-resizing');
    expect(css).toMatch(
      /\.access-col-file-resizing[^}]*cursor\s*:\s*col-resize/,
    );
  });

  it('defines .access-cell--empty', () => {
    expect(css).toContain('.access-cell--empty');
  });

  it('defines .access-cell--sigma', () => {
    expect(css).toContain('.access-cell--sigma');
  });

  // ── Heatmap shading ───────────────────────────────────────────────────────
  it('defines heatmap shading via --heat CSS variable', () => {
    expect(css).toContain('--heat');
  });

  // ── File name category colors ─────────────────────────────────────────────
  it('defines .access-file-name--read in blue', () => {
    expect(css).toContain('.access-file-name--read');
    // blue color
    expect(css).toMatch(
      /\.access-file-name--read\s*\{[^}]*color\s*:\s*#3b82f6/,
    );
  });

  it('defines .access-file-name--write in green', () => {
    expect(css).toContain('.access-file-name--write');
    expect(css).toMatch(
      /\.access-file-name--write\s*\{[^}]*color\s*:\s*#22c55e/,
    );
  });

  it('defines .access-file-name--leaked in amber', () => {
    expect(css).toContain('.access-file-name--leaked');
    expect(css).toMatch(
      /\.access-file-name--leaked\s*\{[^}]*color\s*:\s*#f59e0b/,
    );
  });

  it('defines .access-tracked-icon (git-tracked decoration)', () => {
    expect(css).toContain('.access-tracked-icon');
  });

  // ── Operation badges ──────────────────────────────────────────────────────
  it('defines .access-badge base style', () => {
    expect(css).toContain('.access-badge');
  });

  it('defines .access-badge--read in blue', () => {
    expect(css).toContain('.access-badge--read');
  });

  it('defines .access-badge--write in green', () => {
    expect(css).toContain('.access-badge--write');
  });

  it('defines .access-badge--rw', () => {
    expect(css).toContain('.access-badge--rw');
  });

  it('defines .access-badge--broad and .access-badge--zero-hit in amber/red', () => {
    expect(css).toContain('.access-badge--broad');
    expect(css).toContain('.access-badge--zero-hit');
  });

  it('defines .access-op-count superscript', () => {
    expect(css).toContain('.access-op-count');
  });

  // ── Sigma column ──────────────────────────────────────────────────────────
  it('defines .access-sigma-read in blue and .access-sigma-write in green', () => {
    expect(css).toContain('.access-sigma-read');
    expect(css).toContain('.access-sigma-write');
  });

  // ── Searches lane ─────────────────────────────────────────────────────────
  it('defines .access-searches and .access-searches-table', () => {
    expect(css).toContain('.access-searches');
    expect(css).toContain('.access-searches-table');
  });

  it('defines .access-search-pattern', () => {
    expect(css).toContain('.access-search-pattern');
  });

  // ── Capture strip ─────────────────────────────────────────────────────────
  it('defines .access-capture-strip and --degraded modifier', () => {
    expect(css).toContain('.access-capture-strip');
    expect(css).toContain('.access-capture-strip--degraded');
  });
});
