import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  iconSvg,
} from '../utils/icons.js';

// Module-level state for collapse/expand (mirrors run-timeline.js zoom state pattern)
const _collapsedStages = new Map(); // stage → boolean
const _collapsedDirs = new Set(); // dir path

// Module-level state for interactive controls
let _heatmap = false;
let _showReads = true;
let _showWrites = true;
let _showSearches = true;
let _pathFilter = '';
let _sortMode = 'tree'; // 'tree' | 'most-read' | 'most-written' | 'churn'
let _groupSearchesByStage = false;

// Drawer state — null = closed; { type: 'file'|'cell', filePath, colKey } = open
let _openDrawer = null; // { type, filePath, colKey? }

// Rerender callback — set from options on each render call so click handlers
// can trigger a re-render without main.js coupling.
let _rerenderFn = () => {};

function _rerender() {
  _rerenderFn();
}

export function _resetAccessStateForTests() {
  _collapsedStages.clear();
  _collapsedDirs.clear();
  _heatmap = false;
  _showReads = true;
  _showWrites = true;
  _showSearches = true;
  _pathFilter = '';
  _sortMode = 'tree';
  _groupSearchesByStage = false;
  _openDrawer = null;
  _rerenderFn = () => {};
}

export function _setControlsForTests({
  heatmap,
  showReads,
  showWrites,
  showSearches,
  pathFilter,
  sortMode,
  groupByStage,
} = {}) {
  if (heatmap !== undefined) _heatmap = heatmap;
  if (showReads !== undefined) _showReads = showReads;
  if (showWrites !== undefined) _showWrites = showWrites;
  if (showSearches !== undefined) _showSearches = showSearches;
  if (pathFilter !== undefined) _pathFilter = pathFilter;
  if (sortMode !== undefined) _sortMode = sortMode;
  if (groupByStage !== undefined) _groupSearchesByStage = groupByStage;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function runFileAccessView(_run, _settings, options = {}) {
  const { model, onBack, onOpenTimeline, onRerender } = options;
  _rerenderFn = onRerender || (() => {});

  if (!model) {
    return html`<div class="run-file-access">
      <div class="access-loading">Loading file access data…</div>
    </div>`;
  }

  if (!model.enabled) {
    return html`<div class="run-file-access">
      ${_backButton(onBack)}
      <div class="access-empty-state">
        <p>No file access data available for this run.</p>
        <p class="access-empty-hint">File access telemetry requires worca ≥ W-064 with
          <code>worca.telemetry.file_access.enabled: true</code>.</p>
      </div>
    </div>`;
  }

  const { columns = [], tree = [], searches = [], summary = {} } = model;

  // Group columns by stage
  const stageGroups = _buildStageGroups(columns);

  return html`<div class="run-file-access">
    ${_backButton(onBack)}
    ${_kpiStrip(summary)}
    ${_controlsBar()}
    ${_treetable(tree, columns, stageGroups, searches)}
    ${_showSearches ? _searchesLane(searches) : nothing}
    ${_captureStrip(summary)}
    ${_drawerOverlay(model, columns, onOpenTimeline)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Back button
// ---------------------------------------------------------------------------

function _backButton(onBack) {
  if (!onBack) return nothing;
  return html`<button class="access-back-btn" type="button" @click=${onBack}>
    ← Back
  </button>`;
}

// ---------------------------------------------------------------------------
// Controls bar
// ---------------------------------------------------------------------------

function _controlsBar() {
  return html`<div class="access-controls">
    <button
      class="access-heatmap-toggle${_heatmap ? ' access-heatmap-toggle--active' : ''}"
      type="button"
      title="Toggle heatmap shading by op-count density"
      @click=${() => {
        _heatmap = !_heatmap;
        _rerender();
      }}
    >⊞ Heatmap</button>

    <div class="access-chips">
      <button
        class="access-chip access-chip--reads${_showReads ? ' access-chip--active' : ''}"
        type="button"
        @click=${() => {
          _showReads = !_showReads;
          _rerender();
        }}
      ><span aria-hidden="true">▣</span> Reads</button>
      <button
        class="access-chip access-chip--writes${_showWrites ? ' access-chip--active' : ''}"
        type="button"
        @click=${() => {
          _showWrites = !_showWrites;
          _rerender();
        }}
      ><span aria-hidden="true">▣</span> Writes</button>
      <button
        class="access-chip access-chip--searches${_showSearches ? ' access-chip--active' : ''}"
        type="button"
        @click=${() => {
          _showSearches = !_showSearches;
          _rerender();
        }}
      ><span aria-hidden="true">▣</span> Searches</button>
    </div>

    <input
      class="access-path-filter"
      type="text"
      aria-label="Filter paths by glob"
      placeholder="Filter paths (glob)…"
      .value=${_pathFilter}
      @input=${(e) => {
        _pathFilter = e.target.value;
        _rerender();
      }}
    />

    <select
      class="access-sort-select"
      aria-label="Sort files"
      .value=${_sortMode}
      @change=${(e) => {
        _sortMode = e.target.value;
        _rerender();
      }}
    >
      <option value="tree">Tree</option>
      <option value="most-read">Most read</option>
      <option value="most-written">Most written</option>
      <option value="churn">Churn</option>
    </select>
  </div>`;
}

// ---------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------

function _kpiStrip(summary) {
  const broadAmber = (summary.root_scoped || 0) > 0;
  const zeroAmber = (summary.zero_result || 0) > 0;
  const leakAmber = (summary.leakage_pct_max || 0) > 0;
  const oracleAmber = summary.oracle === 'degraded';
  const captureAmber = leakAmber || oracleAmber;

  return html`<div class="access-kpi-strip">
    ${_kpiCard('Files touched', summary.files_touched ?? 0, false)}
    ${_kpiCard(
      'Read',
      html`${summary.distinct_read ?? 0} files · ${summary.total_read ?? 0} ops`,
      false,
    )}
    ${_kpiCard(
      'Written',
      html`${summary.distinct_write ?? 0} files · ${summary.total_write ?? 0} ops`,
      false,
    )}
    ${_kpiCard(
      'Searches',
      html`${summary.searches ?? 0} (${summary.zero_result ?? 0} zero-hit)`,
      zeroAmber,
    )}
    ${_kpiCard('Broad scans', summary.root_scoped ?? 0, broadAmber)}
    ${_kpiCard(
      'Capture',
      html`${(summary.leakage_pct_max ?? 0).toFixed(1)}% leak · ${summary.oracle === 'degraded' ? html`<span class="access-oracle-degraded">${unsafeHTML(iconSvg(AlertTriangle, 12))} degraded</span>` : 'ok'}`,
      captureAmber,
    )}
  </div>`;
}

function _kpiCard(label, value, amber) {
  return html`<div class="access-kpi-card${amber ? ' access-kpi-card--amber' : ''}">
    <span class="access-kpi-label">${label}</span>
    <span class="access-kpi-value">${value}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Treetable
// ---------------------------------------------------------------------------

function _buildStageGroups(columns) {
  const groups = new Map();
  for (const col of columns) {
    if (!groups.has(col.stage)) groups.set(col.stage, []);
    groups.get(col.stage).push(col);
  }
  return groups;
}

function _computeMaxOps(tree) {
  let max = 1;
  function visit(node) {
    if (node.type === 'file' && node.cells) {
      for (const cell of Object.values(node.cells)) {
        const ops = (cell.read || 0) + (cell.write || 0);
        if (ops > max) max = ops;
      }
    }
    if (node.children) node.children.forEach(visit);
  }
  tree.forEach(visit);
  return max;
}

function _matchGlob(path, pattern) {
  if (!pattern) return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp(regexStr).test(path);
  } catch {
    return path.includes(pattern);
  }
}

function _shouldShowFile(node) {
  if (node.category === 'read' && !_showReads) return false;
  if ((node.category === 'write' || node.category === 'leaked') && !_showWrites)
    return false;
  if (_pathFilter && !_matchGlob(node.path, _pathFilter)) return false;
  return true;
}

function _filterTree(nodes) {
  const result = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (_shouldShowFile(node)) result.push(node);
    } else {
      const children = _filterTree(node.children || []);
      if (children.length > 0) result.push({ ...node, children });
    }
  }
  return result;
}

function _collectFiles(nodes) {
  const files = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (_shouldShowFile(node)) files.push(node);
    } else if (node.children) {
      files.push(..._collectFiles(node.children));
    }
  }
  return files;
}

function _sortFiles(files) {
  const sorted = [...files];
  if (_sortMode === 'most-read') {
    sorted.sort((a, b) => (b.totals?.read || 0) - (a.totals?.read || 0));
  } else if (_sortMode === 'most-written') {
    sorted.sort((a, b) => (b.totals?.write || 0) - (a.totals?.write || 0));
  } else if (_sortMode === 'churn') {
    sorted.sort((a, b) => {
      const aOps = (a.totals?.read || 0) + (a.totals?.write || 0);
      const bOps = (b.totals?.read || 0) + (b.totals?.write || 0);
      return bOps - aOps;
    });
  }
  return sorted;
}

function _treetable(tree, columns, stageGroups, searches) {
  const maxOps = _heatmap ? _computeMaxOps(tree) : 0;
  const scopePaths = _buildScopePaths(searches);

  let bodyContent;
  if (_sortMode === 'tree') {
    const filtered = _filterTree(tree);
    bodyContent = filtered.map((node) =>
      _treeNode(node, columns, 0, maxOps, scopePaths),
    );
  } else {
    const files = _sortFiles(_collectFiles(tree));
    bodyContent = files.map((node) => _fileRow(node, columns, 0, maxOps));
  }

  return html`<div class="access-treetable${_heatmap ? ' access-treetable--heatmap' : ''}" role="treegrid" aria-label="File access map">
    ${_tableHeader(columns, stageGroups)}
    <div class="access-table-body">${bodyContent}</div>
  </div>`;
}

function _buildScopePaths(searches) {
  const paths = new Set();
  for (const s of searches || []) {
    if (s.scope && s.scope !== '.' && s.scope !== '') paths.add(s.scope);
  }
  return paths;
}

function _tableHeader(_columns, stageGroups) {
  // Stage group row + column header row
  const stageGroupCells = [];
  const colHeaderCells = [
    html`<div class="access-col-header access-col-file-header" role="columnheader">File</div>`,
  ];

  for (const [stage, cols] of stageGroups) {
    const collapsed = _collapsedStages.get(stage) || false;
    stageGroupCells.push(html`<div
      class="access-stage-group${collapsed ? ' access-stage-group--collapsed' : ''}"
      data-stage=${stage}
    >
      <button
        class="access-stage-group-header"
        type="button"
        aria-expanded=${!collapsed}
        aria-label="${collapsed ? 'Expand' : 'Collapse'} ${stage}"
        @click=${() => {
          _collapsedStages.set(stage, !collapsed);
          _rerender();
        }}
      >
        <span aria-hidden="true">${unsafeHTML(iconSvg(collapsed ? ChevronRight : ChevronDown, 12))}</span>
        ${stage}
        ${collapsed ? html`<span class="access-stage-agg">(${cols.length})</span>` : nothing}
      </button>
      ${
        collapsed
          ? nothing
          : cols.map(
              (col) =>
                html`<div class="access-col-header" data-col-key=${col.key}>
                ${
                  col.bead_id
                    ? html`<span class="access-col-bead">${col.bead_id}</span>`
                    : html`<span class="access-col-iter">iter ${col.iteration}</span>`
                }
              </div>`,
            )
      }
    </div>`);

    if (!collapsed) {
      for (const col of cols) {
        colHeaderCells.push(
          html`<div class="access-col-header" role="columnheader" data-col-key=${col.key}>
            ${col.agent}
          </div>`,
        );
      }
    } else {
      colHeaderCells.push(
        html`<div class="access-col-header access-col-header--collapsed" role="columnheader" data-stage=${stage}>
          Σ ${stage}
        </div>`,
      );
    }
  }

  colHeaderCells.push(
    html`<div class="access-col-header access-sigma-header" role="columnheader">Σ</div>`,
  );

  return html`<div class="access-table-header">
    <div class="access-stage-groups">${stageGroupCells}</div>
    <div class="access-col-headers">${colHeaderCells}</div>
  </div>`;
}

function _treeNode(node, columns, depth, maxOps, scopePaths) {
  if (node.type === 'dir') {
    return _dirRow(node, columns, depth, maxOps, scopePaths);
  }
  return _fileRow(node, columns, depth, maxOps);
}

function _dirRow(node, columns, depth, maxOps, scopePaths) {
  const collapsed = _collapsedDirs.has(node.path);
  const isScope = scopePaths?.has(node.path);

  return html`
    <div
      class="access-row access-row--dir${collapsed ? ' access-row--dir-collapsed' : ''}"
      role="row"
      data-path=${node.path}
      style="--depth:${depth}"
    >
      <div class="access-cell access-cell--file" role="rowheader">
        <button
          class="access-dir-toggle"
          type="button"
          aria-expanded=${!collapsed}
          aria-label="${collapsed ? 'Expand' : 'Collapse'} ${node.name}"
          @click=${() => {
            if (collapsed) _collapsedDirs.delete(node.path);
            else _collapsedDirs.add(node.path);
            _rerender();
          }}
        >
          <span aria-hidden="true">${unsafeHTML(iconSvg(collapsed ? ChevronRight : ChevronDown, 12))}</span>
        </button>
        <span aria-hidden="true">${unsafeHTML(iconSvg(FolderOpen, 14))}</span>
        <span class="access-file-name">${node.name}</span>
        ${isScope ? html`<span class="access-scope-dot" title="search scope" aria-label="search scope"></span>` : nothing}
      </div>
      ${_rowCells(node.cells, columns, maxOps)}
      ${_sigmaCell(node.totals)}
    </div>
    ${(node.children || []).map(
      (
        child,
      ) => html`<div class="access-children${collapsed ? ' access-row--hidden' : ''}">
        ${_treeNode(child, columns, depth + 1, maxOps, scopePaths)}
      </div>`,
    )}
  `;
}

function _fileRow(node, columns, depth, maxOps) {
  const categoryClass = `access-file-name--${node.category}`;
  const showTracked = node.tracked && (node.totals?.write || 0) > 0;

  return html`<div
    class="access-row access-row--file"
    role="row"
    data-path=${node.path}
    style="--depth:${depth}"
  >
    <div class="access-cell access-cell--file" role="rowheader">
      <button
        class="access-file-name-btn access-file-name ${categoryClass}"
        type="button"
        title="Show file access history"
        @click=${() => {
          _openDrawer =
            _openDrawer?.type === 'file' && _openDrawer.filePath === node.path
              ? null
              : { type: 'file', filePath: node.path };
          _rerender();
        }}
      >${node.name}</button>
      ${
        showTracked
          ? html`<span class="access-tracked-icon" title="git-tracked" aria-label="git-tracked">✎</span>`
          : nothing
      }
    </div>
    ${_rowCells(node.cells, columns, maxOps, node.path)}
    ${_sigmaCell(node.totals)}
  </div>`;
}

function _rowCells(cells, columns, maxOps, filePath) {
  return columns.map((col) => {
    const cell = cells?.[col.key];
    if (!cell || (!cell.read && !cell.write)) {
      return html`<div class="access-cell access-cell--empty" role="gridcell" data-col-key=${col.key}>·</div>`;
    }
    const ops = (cell.read || 0) + (cell.write || 0);
    const heatStyle =
      maxOps > 0 ? `--heat:${(ops / maxOps).toFixed(3)}` : nothing;
    const clickable = filePath != null;
    const _openCellDrawer = clickable
      ? () => {
          _openDrawer =
            _openDrawer?.type === 'cell' &&
            _openDrawer.filePath === filePath &&
            _openDrawer.colKey === col.key
              ? null
              : { type: 'cell', filePath, colKey: col.key, col, cell };
          _rerender();
        }
      : nothing;
    return html`<div
      class="access-cell${clickable ? ' access-cell--clickable' : ''}"
      role="gridcell"
      data-col-key=${col.key}
      style=${heatStyle}
      tabindex=${clickable ? '0' : nothing}
      aria-label=${clickable ? `${col.agent || col.stage} — ${col.key}` : nothing}
      @click=${_openCellDrawer}
      @keydown=${
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                _openCellDrawer();
              }
            }
          : nothing
      }
    >${_cellBadge(cell)}</div>`;
  });
}

function _cellBadge(cell) {
  const r = cell.read || 0;
  const w = cell.write || 0;

  if (r > 0 && w > 0) {
    return html`<span class="access-badge access-badge--rw">
      <span class="access-badge-label">RW</span>
      ${r + w > 2 ? html`<sup class="access-op-count">${r + w}</sup>` : nothing}
    </span>`;
  }
  if (w > 0) {
    return html`<span class="access-badge access-badge--write">
      <span class="access-badge-label">W</span>
      ${w > 1 ? html`<sup class="access-op-count">${w}</sup>` : nothing}
    </span>`;
  }
  return html`<span class="access-badge access-badge--read">
    <span class="access-badge-label">R</span>
    ${r > 1 ? html`<sup class="access-op-count">${r}</sup>` : nothing}
  </span>`;
}

function _sigmaCell(totals) {
  const r = totals?.read ?? 0;
  const w = totals?.write ?? 0;
  return html`<div class="access-cell access-cell--sigma" role="gridcell">
    ${r > 0 ? html`<span class="access-sigma-read">${r}R</span>` : nothing}
    ${w > 0 ? html`<span class="access-sigma-write">${w}W</span>` : nothing}
    ${r === 0 && w === 0 ? html`<span>·</span>` : nothing}
  </div>`;
}

// ---------------------------------------------------------------------------
// Searches lane
// ---------------------------------------------------------------------------

function _searchesLane(searches) {
  return html`<div class="access-searches">
    <div class="access-searches-header">
      <h3 class="access-searches-title">Searches</h3>
      <button
        class="access-searches-group-toggle${_groupSearchesByStage ? ' access-searches-group-toggle--active' : ''}"
        type="button"
        title="Group searches by stage"
        @click=${() => {
          _groupSearchesByStage = !_groupSearchesByStage;
          _rerender();
        }}
      >Group by stage</button>
    </div>
    ${
      searches.length === 0
        ? html`<p class="access-searches-empty">No searches recorded.</p>`
        : _groupSearchesByStage
          ? _searchesGrouped(searches)
          : _searchesTable(searches)
    }
  </div>`;
}

function _searchesTable(searches) {
  return html`<table class="access-searches-table">
    <thead>
      <tr>
        <th>Stage</th>
        <th>Tool</th>
        <th>Pattern</th>
        <th>Scope</th>
        <th>Hits</th>
        <th>Flags</th>
      </tr>
    </thead>
    <tbody>
      ${searches.map(_searchRow)}
    </tbody>
  </table>`;
}

function _searchesGrouped(searches) {
  // Group by stage, preserving encounter order
  const groups = new Map();
  for (const s of searches) {
    if (!groups.has(s.stage)) groups.set(s.stage, []);
    groups.get(s.stage).push(s);
  }
  return html`<div class="access-searches-groups">
    ${[...groups.entries()].map(
      ([stage, rows]) => html`<div class="access-searches-stage-group">
        <div class="access-searches-stage-header">${stage}</div>
        <table class="access-searches-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Tool</th>
              <th>Pattern</th>
              <th>Scope</th>
              <th>Hits</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(_searchRow)}
          </tbody>
        </table>
      </div>`,
    )}
  </div>`;
}

function _searchRow(s) {
  return html`<tr class="access-search-row" data-col-key=${s.colKey}>
    <td>${s.stage}:${s.iteration}</td>
    <td>${s.tool}</td>
    <td class="access-search-pattern">${s.pattern}</td>
    <td>${s.scope || '—'}</td>
    <td>${s.result_count}</td>
    <td>
      ${
        s.broad
          ? html`<span class="access-badge access-badge--broad">broad</span>`
          : nothing
      }
      ${
        s.zero_hit
          ? html`<span class="access-badge access-badge--zero-hit">0 hits</span>`
          : nothing
      }
    </td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// Drawers — file-history drawer and cell-scoped drawer
// ---------------------------------------------------------------------------

function _drawerOverlay(model, columns, onOpenTimeline) {
  if (!_openDrawer) return nothing;

  if (_openDrawer.type === 'file') {
    return _fileDrawer(_openDrawer.filePath, model, columns, onOpenTimeline);
  }
  if (_openDrawer.type === 'cell') {
    return _cellDrawer(_openDrawer, model, columns, onOpenTimeline);
  }
  return nothing;
}

function _findFileNode(tree, filePath) {
  for (const node of tree) {
    if (node.type === 'file' && node.path === filePath) return node;
    if (node.children) {
      const found = _findFileNode(node.children, filePath);
      if (found) return found;
    }
  }
  return null;
}

function _timelineLink(colKey, onOpenTimeline) {
  if (!onOpenTimeline) return nothing;
  return html`<button
    class="access-timeline-link"
    type="button"
    title="Open this iteration in Timeline"
    @click=${() => onOpenTimeline({ colKey })}
  >Open in Timeline ↗</button>`;
}

function _fileDrawer(filePath, model, columns, onOpenTimeline) {
  const fileNode = _findFileNode(model.tree || [], filePath);
  const cells = fileNode?.cells || {};

  // Build chronological history: one entry per column that has a non-empty cell
  const history = columns
    .filter((col) => {
      const c = cells[col.key];
      return c && (c.read || c.write);
    })
    .map((col) => ({ col, cell: cells[col.key] }));

  const _closeDrawer = () => {
    _openDrawer = null;
    _rerender();
  };
  return html`<div class="access-file-drawer" open
    @keydown=${(e) => {
      if (e.key === 'Escape') _closeDrawer();
    }}
  >
    <div class="access-drawer-header">
      <span class="access-drawer-title">${filePath}</span>
      <button
        class="access-drawer-close"
        type="button"
        aria-label="Close"
        autofocus
        @click=${_closeDrawer}
      >✕</button>
    </div>
    <div class="access-drawer-body">
      <p class="access-drawer-section-label">File access history</p>
      ${
        history.length === 0
          ? html`<p class="access-drawer-empty">No access recorded.</p>`
          : html`<ul class="access-file-history-list">
            ${history.map(
              ({ col, cell }) => html`<li class="access-file-history-item">
              <span class="access-history-stage">${col.stage}</span>
              <span class="access-history-iter">iter ${col.iteration}</span>
              ${col.bead_id ? html`<span class="access-history-bead">${col.bead_id}</span>` : nothing}
              <span class="access-history-agent">${col.agent}</span>
              ${cell.read ? html`<span class="access-history-read">${cell.read}R</span>` : nothing}
              ${cell.write ? html`<span class="access-history-write">${cell.write}W</span>` : nothing}
              ${_timelineLink(col.key, onOpenTimeline)}
            </li>`,
            )}
          </ul>`
      }
    </div>
  </div>`;
}

function _cellDrawer(drawerState, _model, _columns, onOpenTimeline) {
  const { filePath, col, cell } = drawerState;
  const r = cell?.read || 0;
  const w = cell?.write || 0;

  const _closeDrawer = () => {
    _openDrawer = null;
    _rerender();
  };
  return html`<div class="access-cell-drawer" open
    @keydown=${(e) => {
      if (e.key === 'Escape') _closeDrawer();
    }}
  >
    <div class="access-drawer-header">
      <span class="access-drawer-title">${filePath} — ${col.stage}</span>
      <button
        class="access-drawer-close"
        type="button"
        aria-label="Close"
        autofocus
        @click=${_closeDrawer}
      >✕</button>
    </div>
    <div class="access-drawer-body">
      <dl class="access-cell-detail">
        <dt>File</dt><dd>${filePath}</dd>
        <dt>Stage</dt><dd>${col.stage}</dd>
        <dt>Iteration</dt><dd>${col.iteration}</dd>
        ${col.bead_id ? html`<dt>Bead</dt><dd>${col.bead_id}</dd>` : nothing}
        <dt>Agent</dt><dd>${col.agent}</dd>
        ${r > 0 ? html`<dt>Reads</dt><dd>${r}</dd>` : nothing}
        ${w > 0 ? html`<dt>Writes</dt><dd>${w}</dd>` : nothing}
      </dl>
      ${_timelineLink(col.key, onOpenTimeline)}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Capture-integrity strip
// ---------------------------------------------------------------------------

function _captureStrip(summary) {
  const degraded = summary.oracle === 'degraded';
  const leakage = summary.leakage_pct_max ?? 0;

  return html`<div class="access-capture-strip${degraded ? ' access-capture-strip--degraded' : ''}">
    <span class="access-capture-label">Capture integrity</span>
    <span class="access-capture-leakage">Leakage: ${leakage.toFixed(1)}%</span>
    ${
      degraded
        ? html`<span class="access-capture-oracle">
          ${unsafeHTML(iconSvg(AlertTriangle, 14))}
          Path canonicalization degraded — counts approximate
        </span>`
        : html`<span class="access-capture-oracle">Oracle: ok</span>`
    }
  </div>`;
}
