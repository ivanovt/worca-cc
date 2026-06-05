// @vitest-environment jsdom

import { render } from 'lit-html';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetAccessStateForTests,
  _setControlsForTests,
  runFileAccessView,
} from './run-file-access.js';

function mount(templateResult) {
  const el = document.createElement('div');
  render(templateResult, el);
  return el;
}

const MINIMAL_RUN = { id: 'run-1', status: 'completed' };
const MINIMAL_SETTINGS = {};

function makeModel(overrides = {}) {
  return {
    enabled: true,
    columns: [
      {
        key: 'plan:1',
        stage: 'plan',
        iteration: 1,
        bead_id: null,
        agent: 'planner',
      },
      {
        key: 'implement:1:w-001',
        stage: 'implement',
        iteration: 1,
        bead_id: 'w-001',
        agent: 'implementer',
      },
    ],
    tree: [
      {
        type: 'dir',
        path: 'src',
        name: 'src',
        children: [
          {
            type: 'file',
            path: 'src/runner.py',
            name: 'runner.py',
            tracked: true,
            category: 'write',
            cells: {
              'plan:1': { read: 2 },
              'implement:1:w-001': { write: 3, read: 1 },
            },
            totals: { read: 3, write: 3 },
          },
          {
            type: 'file',
            path: 'src/util.py',
            name: 'util.py',
            tracked: true,
            category: 'read',
            cells: { 'plan:1': { read: 1 } },
            totals: { read: 1, write: 0 },
          },
          {
            type: 'file',
            path: 'src/new_file.py',
            name: 'new_file.py',
            tracked: true,
            category: 'write',
            cells: { 'implement:1:w-001': { write: 2 } },
            totals: { read: 0, write: 2 },
          },
        ],
        cells: {
          'plan:1': { read: 3 },
          'implement:1:w-001': { write: 3, read: 1 },
        },
        totals: { read: 4, write: 3 },
      },
    ],
    searches: [
      {
        colKey: 'implement:1:w-001',
        stage: 'implement',
        iteration: 1,
        tool: 'Grep',
        pattern: 'def run',
        scope: 'src',
        result_count: 5,
        broad: false,
        zero_hit: false,
        filter: null,
      },
    ],
    summary: {
      files_touched: 2,
      distinct_read: 2,
      total_read: 4,
      distinct_write: 1,
      total_write: 3,
      searches: 1,
      grep: 1,
      glob: 0,
      zero_result: 0,
      root_scoped: 0,
      leakage_pct_max: 0,
      oracle: 'ok',
    },
    ...overrides,
  };
}

describe('runFileAccessView', () => {
  beforeEach(() => {
    _resetAccessStateForTests();
  });

  // --- Loading / empty states ---

  it('shows loading indicator when model is null', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: null }),
    );
    expect(el.textContent).toMatch(/loading/i);
  });

  it('shows disabled empty-state when model.enabled is false', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: { enabled: false },
      }),
    );
    expect(el.textContent).toMatch(/no file access data/i);
  });

  // --- KPI strip ---

  it('renders KPI strip with files-touched stat', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const strip = el.querySelector('.access-kpi-strip');
    expect(strip).not.toBeNull();
    expect(strip.textContent).toContain('2'); // files_touched
  });

  it('renders read and write distinct counts in KPI strip', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const strip = el.querySelector('.access-kpi-strip');
    expect(strip.textContent).toContain('2'); // distinct_read
    expect(strip.textContent).toContain('1'); // distinct_write
  });

  it('renders search count in KPI strip', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const strip = el.querySelector('.access-kpi-strip');
    expect(strip.textContent).toContain('1'); // searches
  });

  it('marks broad-scans KPI amber when root_scoped > 0', () => {
    const model = makeModel({
      summary: { ...makeModel().summary, root_scoped: 3 },
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const strip = el.querySelector('.access-kpi-strip');
    const amberCards = strip.querySelectorAll('.access-kpi-card--amber');
    expect(amberCards.length).toBeGreaterThan(0);
  });

  it('marks zero-hit KPI amber when zero_result > 0', () => {
    const model = makeModel({
      summary: { ...makeModel().summary, zero_result: 2 },
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const strip = el.querySelector('.access-kpi-strip');
    const amberCards = strip.querySelectorAll('.access-kpi-card--amber');
    expect(amberCards.length).toBeGreaterThan(0);
  });

  it('marks capture KPI amber when leakage_pct_max > 0', () => {
    const model = makeModel({
      summary: { ...makeModel().summary, leakage_pct_max: 1.5 },
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const strip = el.querySelector('.access-kpi-strip');
    const amberCards = strip.querySelectorAll('.access-kpi-card--amber');
    expect(amberCards.length).toBeGreaterThan(0);
  });

  it('marks oracle KPI amber when oracle is degraded', () => {
    const model = makeModel({
      summary: { ...makeModel().summary, oracle: 'degraded' },
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const strip = el.querySelector('.access-kpi-strip');
    const amberCards = strip.querySelectorAll('.access-kpi-card--amber');
    expect(amberCards.length).toBeGreaterThan(0);
  });

  it('does not show amber KPI cards when all counts are 0 and oracle is ok', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const strip = el.querySelector('.access-kpi-strip');
    const amberCards = strip.querySelectorAll('.access-kpi-card--amber');
    expect(amberCards.length).toBe(0);
  });

  // --- Treetable structure ---

  it('renders the treetable container', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-treetable')).not.toBeNull();
  });

  it('renders column headers for each column', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const headers = el.querySelectorAll('.access-col-header');
    // 2 columns + sticky file col + Σ col
    expect(headers.length).toBeGreaterThanOrEqual(2);
  });

  it('renders stage group header for plan stage', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const headers = el.querySelectorAll('.access-stage-group-header');
    const stageNames = [...headers].map((h) =>
      h.querySelector('.access-stage-name')?.textContent?.trim(),
    );
    expect(stageNames).toContain('plan');
    expect(stageNames).toContain('implement');
  });

  it('renders dir rows and file rows', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-row--dir')).not.toBeNull();
    expect(el.querySelector('.access-row--file')).not.toBeNull();
  });

  it('renders file name in the sticky first column', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const fileRows = el.querySelectorAll('.access-row--file');
    const names = [...fileRows].map((r) =>
      r.querySelector('.access-file-name')?.textContent?.trim(),
    );
    expect(names).toContain('runner.py');
    expect(names).toContain('util.py');
  });

  // --- Cell badges ---

  it('renders R badge for read-only cells', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const readBadges = el.querySelectorAll('.access-badge--read');
    expect(readBadges.length).toBeGreaterThan(0);
  });

  it('renders W badge for write cells', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const writeBadges = el.querySelectorAll('.access-badge--write');
    expect(writeBadges.length).toBeGreaterThan(0);
  });

  it('renders separate read and write pills when a cell has both', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // runner.py's implement:1:w-001 cell has read:1 + write:3 → two pills, no
    // combined RW badge.
    const runnerRow = [...el.querySelectorAll('.access-row--file')].find(
      (r) =>
        r.querySelector('.access-file-name')?.textContent?.trim() ===
        'runner.py',
    );
    expect(runnerRow).toBeTruthy();
    expect(runnerRow.querySelector('.access-badge--read')).not.toBeNull();
    expect(runnerRow.querySelector('.access-badge--write')).not.toBeNull();
    expect(el.querySelector('.access-badge--rw')).toBeNull();
  });

  it('renders dot for untouched cells', () => {
    // util.py has no cell in implement:1:w-001 → should have a dot/untouched marker
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const dots = el.querySelectorAll('.access-cell--empty');
    expect(dots.length).toBeGreaterThan(0);
  });

  it('shows the numeric op count inside pills (including the exact count)', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // runner.py plan:1 read=2 → a read pill whose text is "2".
    const readTexts = [...el.querySelectorAll('.access-badge--read')].map((b) =>
      b.textContent.trim(),
    );
    expect(readTexts).toContain('2');
    // runner.py implement:1:w-001 write=3 → a write pill whose text is "3".
    const writeTexts = [...el.querySelectorAll('.access-badge--write')].map(
      (b) => b.textContent.trim(),
    );
    expect(writeTexts).toContain('3');
  });

  // --- File category colors ---

  it('applies write color class to files with writes', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const writeColoredNames = el.querySelectorAll('.access-file-name--write');
    expect(writeColoredNames.length).toBeGreaterThan(0);
  });

  it('applies read color class to read-only files', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const readColoredNames = el.querySelectorAll('.access-file-name--read');
    expect(readColoredNames.length).toBeGreaterThan(0);
  });

  it('applies leaked color class to leaked files', () => {
    const model = makeModel();
    model.tree[0].children.push({
      type: 'file',
      path: 'src/leaked.py',
      name: 'leaked.py',
      tracked: false,
      category: 'leaked',
      cells: { 'implement:1:w-001': { write: 1 } },
      totals: { read: 0, write: 1 },
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const leakedNames = el.querySelectorAll('.access-file-name--leaked');
    expect(leakedNames.length).toBeGreaterThan(0);
  });

  it('renders ✎ decoration for tracked files', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // runner.py is tracked:true and has writes → should show ✎
    const tracked = el.querySelectorAll('.access-tracked-icon');
    expect(tracked.length).toBeGreaterThan(0);
  });

  // --- Σ column ---

  it('renders per-file totals in the Σ column', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const sigmaCells = el.querySelectorAll('.access-cell--sigma');
    expect(sigmaCells.length).toBeGreaterThan(0);
    // runner.py totals: read:3 write:3 → should show both
    const sigmaTexts = [...sigmaCells].map((c) => c.textContent);
    expect(sigmaTexts.some((t) => t.includes('3'))).toBe(true);
  });

  it('renders a Σ column header', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const sigmaHeader = el.querySelector('.access-sigma-header');
    expect(sigmaHeader).not.toBeNull();
  });

  // --- Stage group collapse/expand ---

  it('stage groups start expanded by default', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // All individual column headers visible → no collapsed class on groups
    const collapsed = el.querySelectorAll(
      '.access-stage-group-header--collapsed',
    );
    expect(collapsed.length).toBe(0);
  });

  it('clicking stage group header toggles collapsed state', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const groupHeader = el.querySelector('.access-stage-group-header');
    expect(groupHeader).not.toBeNull();
    groupHeader.click();
    // After click, re-render: re-mount with collapsed state visible
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const collapsed = el.querySelectorAll(
      '.access-stage-group-header--collapsed',
    );
    expect(collapsed.length).toBeGreaterThan(0);
  });

  it('re-expanding a collapsed stage group removes collapsed class', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const groupHeader = el.querySelector('.access-stage-group-header');
    // collapse
    groupHeader.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    // expand
    el.querySelector('.access-stage-group-header').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const collapsed = el.querySelectorAll(
      '.access-stage-group-header--collapsed',
    );
    expect(collapsed.length).toBe(0);
  });

  // --- Searches lane ---

  it('renders the searches lane', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-searches')).not.toBeNull();
  });

  it('renders a search row for each search entry', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-search-row');
    expect(rows.length).toBe(1);
  });

  it('renders the search pattern in the search row', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-searches').textContent).toContain(
      'def run',
    );
  });

  it('renders broad badge for broad searches', () => {
    const model = makeModel({
      searches: [
        {
          colKey: 'implement:1:w-001',
          stage: 'implement',
          iteration: 1,
          tool: 'Grep',
          pattern: 'class',
          scope: '.',
          result_count: 10,
          broad: true,
          zero_hit: false,
          filter: null,
        },
      ],
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const broadBadges = el.querySelectorAll('.access-badge--broad');
    expect(broadBadges.length).toBeGreaterThan(0);
  });

  it('renders zero-hit badge for zero-result searches', () => {
    const model = makeModel({
      searches: [
        {
          colKey: 'plan:1',
          stage: 'plan',
          iteration: 1,
          tool: 'Glob',
          pattern: '*.nonexistent',
          scope: 'src',
          result_count: 0,
          broad: false,
          zero_hit: true,
          filter: null,
        },
      ],
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const zeroBadges = el.querySelectorAll('.access-badge--zero-hit');
    expect(zeroBadges.length).toBeGreaterThan(0);
  });

  // --- Capture integrity strip ---

  it('renders the capture-integrity strip', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-capture-strip')).not.toBeNull();
  });

  it('shows degraded banner when oracle is degraded', () => {
    const model = makeModel({
      summary: { ...makeModel().summary, oracle: 'degraded' },
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const strip = el.querySelector('.access-capture-strip');
    expect(strip.classList.contains('access-capture-strip--degraded')).toBe(
      true,
    );
  });

  it('shows leakage_pct_max in capture strip', () => {
    const model = makeModel({
      summary: { ...makeModel().summary, leakage_pct_max: 2.5 },
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const strip = el.querySelector('.access-capture-strip');
    expect(strip.textContent).toContain('2.5');
  });

  // --- Dir row expand/collapse ---

  it('dir rows start expanded by default', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const collapsed = el.querySelectorAll('.access-row--dir-collapsed');
    expect(collapsed.length).toBe(0);
  });

  it('clicking a dir row toggle folds its children out of the DOM', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // src starts expanded → its file rows are present.
    expect(el.querySelectorAll('.access-row--file').length).toBeGreaterThan(0);
    const dirToggle = el.querySelector('.access-dir-toggle');
    expect(dirToggle).not.toBeNull();
    dirToggle.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    // Children are removed; the dir row stays, now marked collapsed (with its
    // server-side rollup totals still shown).
    expect(el.querySelectorAll('.access-row--file').length).toBe(0);
    expect(el.querySelector('.access-row--dir-collapsed')).not.toBeNull();
  });

  // --- Back navigation ---

  it('renders no in-view back button (relies on the shared header arrow)', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeModel(),
      }),
    );
    expect(el.querySelector('.access-back-btn')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P2b: Interactive controls — heatmap, category chips, filter, sort
// ---------------------------------------------------------------------------

describe('Interactive controls', () => {
  beforeEach(() => {
    _resetAccessStateForTests();
  });

  // --- Controls toolbar ---

  it('renders the controls toolbar', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-controls')).not.toBeNull();
  });

  it('renders heatmap toggle button', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-heatmap-toggle')).not.toBeNull();
  });

  it('renders category chips for reads and writes', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-chip--reads')).not.toBeNull();
    expect(el.querySelector('.access-chip--writes')).not.toBeNull();
    // Searches is no longer a chip — the searches lane is always shown.
    expect(el.querySelector('.access-chip--searches')).toBeNull();
  });

  it('renders path filter input', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-path-filter')).not.toBeNull();
  });

  it('renders sort select with tree/most-read/most-written/churn options', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const select = el.querySelector('.access-sort-select');
    expect(select).not.toBeNull();
    const values = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(values).toContain('tree');
    expect(values).toContain('most-read');
    expect(values).toContain('most-written');
    expect(values).toContain('churn');
  });

  // --- Heatmap ---

  it('treetable has the heatmap class by default', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-treetable--heatmap')).not.toBeNull();
  });

  it('clicking heatmap toggle removes the heatmap class (default on)', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    el.querySelector('.access-heatmap-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    expect(el.querySelector('.access-treetable--heatmap')).toBeNull();
  });

  it('clicking heatmap toggle twice restores the heatmap-on state', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    el.querySelector('.access-heatmap-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    el.querySelector('.access-heatmap-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    expect(el.querySelector('.access-treetable--heatmap')).not.toBeNull();
  });

  it('heatmap toggle has active class when heatmap is on', () => {
    _setControlsForTests({ heatmap: true });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const btn = el.querySelector('.access-heatmap-toggle');
    expect(btn.classList.contains('access-heatmap-toggle--active')).toBe(true);
  });

  it('non-empty cells have --heat CSS variable when heatmap is active', () => {
    _setControlsForTests({ heatmap: true });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const nonEmpty = el.querySelectorAll(
      '.access-cell:not(.access-cell--empty):not(.access-cell--file):not(.access-cell--sigma)',
    );
    const hasHeat = [...nonEmpty].some((c) =>
      c.getAttribute('style')?.includes('--heat'),
    );
    expect(hasHeat).toBe(true);
  });

  // --- Category chips ---

  it('reads and writes chips are active by default', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(
      el
        .querySelector('.access-chip--reads')
        .classList.contains('access-chip--active'),
    ).toBe(true);
    expect(
      el
        .querySelector('.access-chip--writes')
        .classList.contains('access-chip--active'),
    ).toBe(true);
  });

  it('clicking reads chip hides read-only file rows', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    el.querySelector('.access-chip--reads').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const paths = [...el.querySelectorAll('.access-row--file')].map((r) =>
      r.getAttribute('data-path'),
    );
    // util.py has category='read' → should not be present
    expect(paths).not.toContain('src/util.py');
    // runner.py has category='write' → still present
    expect(paths).toContain('src/runner.py');
  });

  it('clicking reads chip removes active class', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    el.querySelector('.access-chip--reads').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    expect(
      el
        .querySelector('.access-chip--reads')
        .classList.contains('access-chip--active'),
    ).toBe(false);
  });

  it('clicking writes chip hides write file rows', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    el.querySelector('.access-chip--writes').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const paths = [...el.querySelectorAll('.access-row--file')].map((r) =>
      r.getAttribute('data-path'),
    );
    // runner.py and new_file.py have category='write' → hidden
    expect(paths).not.toContain('src/runner.py');
    expect(paths).not.toContain('src/new_file.py');
    // util.py has category='read' → still present
    expect(paths).toContain('src/util.py');
  });

  it('always renders the searches lane (no Searches toggle)', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-chip--searches')).toBeNull();
    expect(el.querySelector('.access-searches')).not.toBeNull();
  });

  // --- Path filter ---

  it('path filter shows all files when empty', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    expect(rows.length).toBe(3);
  });

  it('path filter hides non-matching file rows (tree mode)', () => {
    _setControlsForTests({ pathFilter: 'src/runner.py' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const paths = [...el.querySelectorAll('.access-row--file')].map((r) =>
      r.getAttribute('data-path'),
    );
    expect(paths).toContain('src/runner.py');
    expect(paths).not.toContain('src/util.py');
    expect(paths).not.toContain('src/new_file.py');
  });

  it('glob * pattern matches multiple files', () => {
    _setControlsForTests({ pathFilter: 'src/*.py' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    // All three .py files are under src/ → all should match
    expect(rows.length).toBe(3);
  });

  it('non-matching glob filter shows no file rows', () => {
    _setControlsForTests({ pathFilter: 'tests/*.py' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    expect(rows.length).toBe(0);
  });

  it('path filter removes empty parent dirs in tree mode', () => {
    // Filter to only runner.py → src dir still shows (has 1 match)
    // If we filter to nonexistent path → src dir should not appear
    _setControlsForTests({ pathFilter: 'tests/*.py' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const dirRows = el.querySelectorAll('.access-row--dir');
    expect(dirRows.length).toBe(0);
  });

  // --- Sort modes ---

  it('tree sort is default (sort select value = tree)', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const select = el.querySelector('.access-sort-select');
    expect(select.value).toBe('tree');
  });

  it('tree sort shows dir rows', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelectorAll('.access-row--dir').length).toBeGreaterThan(0);
  });

  it('most-read sort shows flat list (no dir rows)', () => {
    _setControlsForTests({ sortMode: 'most-read' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelectorAll('.access-row--dir').length).toBe(0);
  });

  it('most-read sort places highest-read file first', () => {
    _setControlsForTests({ sortMode: 'most-read' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const paths = [...el.querySelectorAll('.access-row--file')].map((r) =>
      r.getAttribute('data-path'),
    );
    // runner.py totals.read=3 is highest
    expect(paths[0]).toBe('src/runner.py');
  });

  it('most-written sort places highest-write file first', () => {
    _setControlsForTests({ sortMode: 'most-written' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const paths = [...el.querySelectorAll('.access-row--file')].map((r) =>
      r.getAttribute('data-path'),
    );
    // runner.py totals.write=3 is highest
    expect(paths[0]).toBe('src/runner.py');
  });

  it('churn sort places highest total-ops file first', () => {
    _setControlsForTests({ sortMode: 'churn' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const paths = [...el.querySelectorAll('.access-row--file')].map((r) =>
      r.getAttribute('data-path'),
    );
    // runner.py: read:3 + write:3 = 6 (highest)
    expect(paths[0]).toBe('src/runner.py');
  });

  it('most-written sort shows all 3 files', () => {
    _setControlsForTests({ sortMode: 'most-written' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelectorAll('.access-row--file').length).toBe(3);
  });

  it('churn sort shows all 3 files', () => {
    _setControlsForTests({ sortMode: 'churn' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelectorAll('.access-row--file').length).toBe(3);
  });

  it('switching sort back to tree restores dir rows', () => {
    _setControlsForTests({ sortMode: 'most-read' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelectorAll('.access-row--dir').length).toBe(0);
    _setControlsForTests({ sortMode: 'tree' });
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    expect(el.querySelectorAll('.access-row--dir').length).toBeGreaterThan(0);
  });

  // --- Combined filter + sort ---

  it('path filter applies in non-tree sort mode', () => {
    _setControlsForTests({
      sortMode: 'most-read',
      pathFilter: 'src/runner.py',
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const paths = [...el.querySelectorAll('.access-row--file')].map((r) =>
      r.getAttribute('data-path'),
    );
    expect(paths).toEqual(['src/runner.py']);
  });

  it('category filter applies in non-tree sort mode', () => {
    _setControlsForTests({ sortMode: 'most-read', showReads: false });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const paths = [...el.querySelectorAll('.access-row--file')].map((r) =>
      r.getAttribute('data-path'),
    );
    expect(paths).not.toContain('src/util.py');
  });
});

// ---------------------------------------------------------------------------
// P3c: File-row and cell drawers with Timeline cross-link
// ---------------------------------------------------------------------------

describe('File-row drawer', () => {
  beforeEach(() => {
    _resetAccessStateForTests();
  });

  it('file rows have a clickable name that opens the file drawer', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const fileNameBtn = el.querySelector(
      '.access-row--file .access-file-name-btn',
    );
    expect(fileNameBtn).not.toBeNull();
  });

  it('file drawer is not open by default', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const drawer = el.querySelector('.access-file-drawer');
    // drawer element should not be present (or open attr absent) before click
    const isOpen = drawer ? drawer.hasAttribute('open') : false;
    expect(isOpen).toBe(false);
  });

  it('clicking file name button opens the file-history drawer', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const fileNameBtn = el.querySelector(
      '.access-row--file .access-file-name-btn',
    );
    fileNameBtn.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-file-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer.hasAttribute('open')).toBe(true);
  });

  it('file drawer shows the file path in the drawer label', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // Click runner.py's name btn (first file row)
    const rows = el.querySelectorAll('.access-row--file');
    const runnerRow = [...rows].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    runnerRow.querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-file-drawer');
    expect(drawer.textContent).toContain('src/runner.py');
  });

  it('file drawer lists each (stage, iteration, bead) that accessed the file', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    const runnerRow = [...rows].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    runnerRow.querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const historyItems = el.querySelectorAll('.access-file-history-item');
    // runner.py has entries in plan:1 and implement:1:w-001
    expect(historyItems.length).toBe(2);
  });

  it('file history items show stage name', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    const runnerRow = [...rows].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    runnerRow.querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const text = el.querySelector('.access-file-drawer').textContent;
    expect(text).toContain('plan');
    expect(text).toContain('implement');
  });

  it('file history items show read and write counts', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    const runnerRow = [...rows].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    runnerRow.querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    // runner.py plan:1 read:2, implement:1:w-001 write:3 read:1
    const items = el.querySelectorAll('.access-file-history-item');
    const texts = [...items].map((i) => i.textContent);
    expect(texts.some((t) => t.includes('2'))).toBe(true); // read count from plan
    expect(texts.some((t) => t.includes('3'))).toBe(true); // write count from implement
  });

  it('file drawer contains "Open in Timeline" link when run has a section', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeModel(),
        section: 'runs',
        onOpenTimeline: () => {},
      }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    rows[0].querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeModel(),
        section: 'runs',
        onOpenTimeline: () => {},
      }),
      el,
    );
    const links = el.querySelectorAll('.access-timeline-link');
    expect(links.length).toBeGreaterThan(0);
  });

  it('"Open in Timeline" links contain the expected text', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeModel(),
        section: 'runs',
        onOpenTimeline: () => {},
      }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    rows[0].querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeModel(),
        section: 'runs',
        onOpenTimeline: () => {},
      }),
      el,
    );
    const link = el.querySelector('.access-timeline-link');
    expect(link.textContent).toMatch(/open in timeline/i);
  });

  it('drawer close button closes the file drawer', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    rows[0].querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const closeBtn = el.querySelector('.access-drawer-close');
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-file-drawer');
    const isOpen = drawer ? drawer.hasAttribute('open') : false;
    expect(isOpen).toBe(false);
  });

  it('opening another file drawer closes the previous one', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const rows = el.querySelectorAll('.access-row--file');
    // Open runner.py drawer
    rows[0].querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    // Open util.py drawer
    const utilRow = [...el.querySelectorAll('.access-row--file')].find(
      (r) => r.getAttribute('data-path') === 'src/util.py',
    );
    utilRow.querySelector('.access-file-name-btn').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    // Only one drawer should be open, and it should contain util.py
    const openDrawers = el.querySelectorAll('.access-file-drawer[open]');
    expect(openDrawers.length).toBe(1);
    expect(openDrawers[0].textContent).toContain('src/util.py');
  });
});

describe('Cell drawer', () => {
  beforeEach(() => {
    _resetAccessStateForTests();
  });

  it('non-empty cells are clickable (have click handler class)', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const clickableCells = el.querySelectorAll('.access-cell--clickable');
    expect(clickableCells.length).toBeGreaterThan(0);
  });

  it('empty cells are not clickable', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const emptyCells = el.querySelectorAll('.access-cell--empty');
    for (const cell of emptyCells) {
      expect(cell.classList.contains('access-cell--clickable')).toBe(false);
    }
  });

  it('cell drawer is not open by default', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const drawer = el.querySelector('.access-cell-drawer');
    const isOpen = drawer ? drawer.hasAttribute('open') : false;
    expect(isOpen).toBe(false);
  });

  it('clicking a non-empty cell opens the cell drawer', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const cell = el.querySelector('.access-cell--clickable');
    cell.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-cell-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer.hasAttribute('open')).toBe(true);
  });

  it('cell drawer shows the file path', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // Click the first non-empty cell in runner.py row
    const runnerRow = [...el.querySelectorAll('.access-row--file')].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    runnerRow.querySelector('.access-cell--clickable').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-cell-drawer');
    expect(drawer.textContent).toContain('src/runner.py');
  });

  it('cell drawer shows read count', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // runner.py, plan:1 → read:2
    const runnerRow = [...el.querySelectorAll('.access-row--file')].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    // Find the plan:1 cell (first non-empty cell)
    const planCell = runnerRow.querySelector(
      '[data-col-key="plan:1"].access-cell--clickable',
    );
    planCell.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-cell-drawer');
    expect(drawer.textContent).toContain('2'); // read:2
  });

  it('cell drawer shows agent name', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const runnerRow = [...el.querySelectorAll('.access-row--file')].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    const planCell = runnerRow.querySelector(
      '[data-col-key="plan:1"].access-cell--clickable',
    );
    planCell.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-cell-drawer');
    expect(drawer.textContent).toContain('planner');
  });

  it('cell drawer shows stage name', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const runnerRow = [...el.querySelectorAll('.access-row--file')].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    const planCell = runnerRow.querySelector(
      '[data-col-key="plan:1"].access-cell--clickable',
    );
    planCell.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-cell-drawer');
    expect(drawer.textContent).toContain('plan');
  });

  it('cell drawer shows write count for write cells', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const runnerRow = [...el.querySelectorAll('.access-row--file')].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    // implement:1:w-001 has write:3 read:1
    const implCell = runnerRow.querySelector(
      '[data-col-key="implement:1:w-001"].access-cell--clickable',
    );
    implCell.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-cell-drawer');
    expect(drawer.textContent).toContain('3'); // write:3
  });

  it('cell drawer shows bead_id when present', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const runnerRow = [...el.querySelectorAll('.access-row--file')].find(
      (r) => r.getAttribute('data-path') === 'src/runner.py',
    );
    const implCell = runnerRow.querySelector(
      '[data-col-key="implement:1:w-001"].access-cell--clickable',
    );
    implCell.click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const drawer = el.querySelector('.access-cell-drawer');
    expect(drawer.textContent).toContain('w-001');
  });

  it('cell drawer has a close button', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    el.querySelector('.access-cell--clickable').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    expect(
      el.querySelector('.access-cell-drawer .access-drawer-close'),
    ).not.toBeNull();
  });

  it('closing the cell drawer hides it', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    el.querySelector('.access-cell--clickable').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    el.querySelector('.access-cell-drawer .access-drawer-close').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const isOpen =
      el.querySelector('.access-cell-drawer')?.hasAttribute('open') ?? false;
    expect(isOpen).toBe(false);
  });

  it('cell drawer has "Open in Timeline" link when onOpenTimeline provided', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeModel(),
        section: 'runs',
        onOpenTimeline: () => {},
      }),
    );
    el.querySelector('.access-cell--clickable').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeModel(),
        section: 'runs',
        onOpenTimeline: () => {},
      }),
      el,
    );
    const link = el.querySelector('.access-cell-drawer .access-timeline-link');
    expect(link).not.toBeNull();
    expect(link.textContent).toMatch(/open in timeline/i);
  });
});

// ---------------------------------------------------------------------------
// P3a: Searches lane — group-by-stage toggle + violet scope-dot overlay
// ---------------------------------------------------------------------------

describe('Searches lane - group-by-stage', () => {
  beforeEach(() => {
    _resetAccessStateForTests();
  });

  function makeMultiStageModel() {
    return makeModel({
      searches: [
        {
          colKey: 'plan:1',
          stage: 'plan',
          iteration: 1,
          tool: 'Glob',
          pattern: '*.py',
          scope: 'src',
          result_count: 5,
          broad: false,
          zero_hit: false,
          filter: null,
        },
        {
          colKey: 'implement:1:w-001',
          stage: 'implement',
          iteration: 1,
          tool: 'Grep',
          pattern: 'def run',
          scope: 'src',
          result_count: 3,
          broad: false,
          zero_hit: false,
          filter: null,
        },
        {
          colKey: 'implement:1:w-001',
          stage: 'implement',
          iteration: 1,
          tool: 'Grep',
          pattern: 'import',
          scope: '.',
          result_count: 0,
          broad: true,
          zero_hit: true,
          filter: null,
        },
      ],
    });
  }

  it('renders a group-by-stage toggle button in the searches section', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    expect(el.querySelector('.access-searches-group-toggle')).not.toBeNull();
  });

  it('group-by-stage toggle starts inactive (flat list)', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const toggle = el.querySelector('.access-searches-group-toggle');
    expect(
      toggle.classList.contains('access-searches-group-toggle--active'),
    ).toBe(false);
  });

  it('clicking group-by-stage toggle activates it', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    el.querySelector('.access-searches-group-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
      el,
    );
    const toggle = el.querySelector('.access-searches-group-toggle');
    expect(
      toggle.classList.contains('access-searches-group-toggle--active'),
    ).toBe(true);
  });

  it('when grouped, renders stage group headers', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
    );
    el.querySelector('.access-searches-group-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
      el,
    );
    const headers = el.querySelectorAll('.access-searches-stage-header');
    expect(headers.length).toBeGreaterThan(0);
  });

  it('grouped stage headers contain the stage name', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
    );
    el.querySelector('.access-searches-group-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
      el,
    );
    const headers = el.querySelectorAll('.access-searches-stage-header');
    const text = [...headers].map((h) => h.textContent.trim());
    expect(text.some((t) => t.includes('plan'))).toBe(true);
    expect(text.some((t) => t.includes('implement'))).toBe(true);
  });

  it('search rows still render under stage groups when grouped', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
    );
    el.querySelector('.access-searches-group-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
      el,
    );
    const rows = el.querySelectorAll('.access-search-row');
    expect(rows.length).toBe(3);
  });

  it('grouped rows for implement stage contain both implement searches', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
    );
    el.querySelector('.access-searches-group-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
      el,
    );
    // implement has 2 searches: 'def run' and 'import'
    const patterns = [...el.querySelectorAll('.access-search-pattern')].map(
      (td) => td.textContent.trim(),
    );
    expect(patterns).toContain('def run');
    expect(patterns).toContain('import');
  });

  it('clicking group-by-stage toggle again reverts to flat list', () => {
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
    );
    el.querySelector('.access-searches-group-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
      el,
    );
    el.querySelector('.access-searches-group-toggle').click();
    render(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
      el,
    );
    // No stage headers in flat mode
    const headers = el.querySelectorAll('.access-searches-stage-header');
    expect(headers.length).toBe(0);
  });

  it('_setControlsForTests groupByStage sets grouped state', () => {
    _setControlsForTests({ groupByStage: true });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, {
        model: makeMultiStageModel(),
      }),
    );
    const toggle = el.querySelector('.access-searches-group-toggle');
    expect(
      toggle.classList.contains('access-searches-group-toggle--active'),
    ).toBe(true);
  });
});

describe('Searches lane - violet scope-dot overlay', () => {
  beforeEach(() => {
    _resetAccessStateForTests();
  });

  it('renders scope-dot on dir whose path matches a search scope', () => {
    // default model has search with scope='src', tree has dir path='src'
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    const srcDir = el.querySelector('[data-path="src"]');
    expect(srcDir).not.toBeNull();
    expect(srcDir.querySelector('.access-scope-dot')).not.toBeNull();
  });

  it('does not render scope-dot on dir with no matching scope', () => {
    const model = makeModel({
      tree: [
        {
          type: 'dir',
          path: 'docs',
          name: 'docs',
          children: [
            {
              type: 'file',
              path: 'docs/readme.md',
              name: 'readme.md',
              tracked: false,
              category: 'read',
              cells: { 'plan:1': { read: 1 } },
              totals: { read: 1, write: 0 },
            },
          ],
          cells: { 'plan:1': { read: 1 } },
          totals: { read: 1, write: 0 },
        },
      ],
      // search scope is 'src', not 'docs'
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const docsDir = el.querySelector('[data-path="docs"]');
    expect(docsDir).not.toBeNull();
    expect(docsDir.querySelector('.access-scope-dot')).toBeNull();
  });

  it('scope-dot is not rendered in flat sort modes (no dir rows)', () => {
    _setControlsForTests({ sortMode: 'most-read' });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model: makeModel() }),
    );
    // No dir rows in flat mode → no scope-dots
    const scopeDots = el.querySelectorAll('.access-scope-dot');
    expect(scopeDots.length).toBe(0);
  });

  it('scope-dot renders when scope exactly matches a dir path', () => {
    const model = makeModel({
      searches: [
        {
          colKey: 'plan:1',
          stage: 'plan',
          iteration: 1,
          tool: 'Glob',
          pattern: '*.py',
          scope: 'src',
          result_count: 3,
          broad: false,
          zero_hit: false,
          filter: null,
        },
      ],
    });
    const el = mount(
      runFileAccessView(MINIMAL_RUN, MINIMAL_SETTINGS, { model }),
    );
    const srcDir = el.querySelector('[data-path="src"]');
    expect(srcDir.querySelector('.access-scope-dot')).not.toBeNull();
  });
});
