/**
 * File-access aggregator — reads pipeline.iteration.access events from a
 * run's events.jsonl and folds payloads into the row/column model used by
 * the Access Map view.
 *
 * Output shape:
 *   { enabled: false }                          — no access events (pre-W-064 run)
 *   { enabled: true, columns, tree, searches, summary }
 *
 * Columns: stage-ordered (STAGE_ORDER), then ascending iteration, then
 * bead_id (nulls first, then lexicographic).
 *
 * Tree: union of reads∪writes paths, hierarchical dir/file nodes. Dir rows
 * carry server-side rollups so the browser never recomputes aggregates.
 *
 * Searches: flat list of per-event search records with broad/zero_hit flags.
 *
 * Summary: global aggregates. oracle:"degraded" if ANY event was degraded.
 *
 * Pattern: mirrors dispatch-events-aggregator.js.
 */

import { existsSync, readFileSync } from 'node:fs';
import { STAGE_ORDER } from '../app/utils/stage-order.js';

const ACCESS_EVENT_TYPE = 'pipeline.iteration.access';

/**
 * Build the Access Map model from a run's events.jsonl.
 *
 * @param {string} eventsPath — absolute path to events.jsonl
 * @returns {{ enabled: false } | { enabled: true, columns, tree, searches, summary }}
 */
export function buildFileAccessModel(eventsPath) {
  if (!eventsPath || !existsSync(eventsPath)) return { enabled: false };

  let content;
  try {
    content = readFileSync(eventsPath, 'utf8');
  } catch {
    return { enabled: false };
  }

  // Parse and filter to access events only.
  const accessPayloads = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.event_type !== ACCESS_EVENT_TYPE) continue;
    if (!e.payload) continue;
    accessPayloads.push(e.payload);
  }

  if (accessPayloads.length === 0) return { enabled: false };

  // ------------------------------------------------------------------
  // 1. Build columns (deduplicated, sorted)
  // ------------------------------------------------------------------
  const colMap = new Map();
  for (const p of accessPayloads) {
    const key = colKey(p.stage, p.iteration, p.bead_id);
    if (!colMap.has(key)) {
      colMap.set(key, {
        key,
        stage: p.stage,
        iteration: p.iteration,
        bead_id: p.bead_id ?? null,
        agent: p.agent,
      });
    }
  }

  const columns = [...colMap.values()].sort(compareColumns);

  // ------------------------------------------------------------------
  // 2. Fold payloads into per-file data and searches
  // ------------------------------------------------------------------
  // fileData: path → { cells: { colKey: { read?, write? } }, tracked }
  const fileData = new Map();

  const searches = [];
  let oracleDegraded = false;

  const summary = {
    files_touched: 0,
    distinct_read: 0,
    total_read: 0,
    distinct_write: 0,
    total_write: 0,
    searches: 0,
    grep: 0,
    glob: 0,
    zero_result: 0,
    root_scoped: 0,
    leakage_pct_max: 0,
    oracle: 'ok',
  };

  for (const p of accessPayloads) {
    const ck = colKey(p.stage, p.iteration, p.bead_id);
    const fa = p.file_access || {};

    for (const [path, count] of Object.entries(fa.reads || {})) {
      const fd = ensureFile(fileData, path);
      if (!fd.cells[ck]) fd.cells[ck] = {};
      fd.cells[ck].read = (fd.cells[ck].read || 0) + count;
    }

    for (const [path, count] of Object.entries(fa.writes || {})) {
      const fd = ensureFile(fileData, path);
      if (!fd.cells[ck]) fd.cells[ck] = {};
      fd.cells[ck].write = (fd.cells[ck].write || 0) + count;
    }

    for (const s of fa.searches || []) {
      const isBroad = s.scope === '.' || s.scope === '';
      searches.push({
        colKey: ck,
        stage: p.stage,
        iteration: p.iteration,
        tool: s.tool,
        pattern: s.pattern,
        scope: s.scope,
        result_count: s.result_count,
        broad: isBroad,
        zero_hit: s.result_count === 0,
        filter: s.filter ?? null,
      });
    }

    const cap = fa.capture || {};
    if (cap.oracle === 'degraded') oracleDegraded = true;
    if (cap.leakage_pct != null && cap.leakage_pct > summary.leakage_pct_max) {
      summary.leakage_pct_max = cap.leakage_pct;
    }

    summary.searches += (fa.searches || []).length;
    for (const s of fa.searches || []) {
      if (s.tool === 'Grep') summary.grep++;
      if (s.tool === 'Glob') summary.glob++;
      if (s.result_count === 0) summary.zero_result++;
      if (s.scope === '.' || s.scope === '') summary.root_scoped++;
    }
  }

  // Compute global file-level aggregates from the folded fileData.
  for (const fd of fileData.values()) {
    let fileRead = 0;
    let fileWrite = 0;
    for (const cell of Object.values(fd.cells)) {
      fileRead += cell.read || 0;
      fileWrite += cell.write || 0;
    }
    if (fileRead > 0) {
      summary.distinct_read++;
      summary.total_read += fileRead;
    }
    if (fileWrite > 0) {
      summary.distinct_write++;
      summary.total_write += fileWrite;
    }
  }

  summary.files_touched = fileData.size;
  if (oracleDegraded) summary.oracle = 'degraded';

  // ------------------------------------------------------------------
  // 3. Build hierarchical tree with server-side dir rollups
  // ------------------------------------------------------------------
  const tree = buildTree(fileData);

  return { enabled: true, columns, tree, searches, summary };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function colKey(stage, iteration, beadId) {
  return beadId ? `${stage}:${iteration}:${beadId}` : `${stage}:${iteration}`;
}

function ensureFile(fileData, path) {
  if (!fileData.has(path)) {
    fileData.set(path, { cells: {}, tracked: true });
  }
  return fileData.get(path);
}

function compareColumns(a, b) {
  const ai = STAGE_ORDER.indexOf(a.stage);
  const bi = STAGE_ORDER.indexOf(b.stage);
  const stageA = ai === -1 ? 999 : ai;
  const stageB = bi === -1 ? 999 : bi;
  if (stageA !== stageB) return stageA - stageB;
  if (a.iteration !== b.iteration) return a.iteration - b.iteration;
  // nulls first
  if (a.bead_id === null && b.bead_id !== null) return -1;
  if (a.bead_id !== null && b.bead_id === null) return 1;
  if (a.bead_id === b.bead_id) return 0;
  return a.bead_id < b.bead_id ? -1 : 1;
}

/**
 * Build a hierarchical dir/file tree from the flat fileData map.
 * Dir nodes carry rolled-up totals and cells aggregated from children.
 *
 * @param {Map<string, {cells, tracked}>} fileData
 * @returns {Array<TreeNode>}
 */
function buildTree(fileData) {
  // Root sentinel — not emitted, just holds top-level children.
  const root = {
    children: new Map(),
    cells: {},
    totals: { read: 0, write: 0 },
  };

  for (const [path, fd] of fileData) {
    const parts = path.split('/');
    let node = root;

    // Walk/create intermediate dir nodes.
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.children.has(name)) {
        const dirPath = parts.slice(0, i + 1).join('/');
        node.children.set(name, {
          type: 'dir',
          path: dirPath,
          name,
          children: new Map(),
          cells: {},
          totals: { read: 0, write: 0 },
        });
      }
      node = node.children.get(name);
    }

    // Place the file leaf.
    const fileName = parts[parts.length - 1];
    const fileTotals = { read: 0, write: 0 };
    for (const cell of Object.values(fd.cells)) {
      fileTotals.read += cell.read || 0;
      fileTotals.write += cell.write || 0;
    }
    const category =
      fileTotals.write > 0 ? (fd.tracked ? 'write' : 'leaked') : 'read';

    node.children.set(fileName, {
      type: 'file',
      path,
      name: fileName,
      tracked: fd.tracked,
      category,
      cells: fd.cells,
      totals: fileTotals,
    });
  }

  // Rollup dir totals and cells bottom-up, then serialise to arrays.
  rollupDir(root);
  return [...root.children.values()].map(serializeNode);
}

function rollupDir(node) {
  if (node.type === 'file') return;
  for (const child of node.children.values()) {
    rollupDir(child);
    node.totals.read += child.totals.read;
    node.totals.write += child.totals.write;
    for (const [ck, cell] of Object.entries(child.cells)) {
      if (!node.cells[ck]) node.cells[ck] = {};
      node.cells[ck].read = (node.cells[ck].read || 0) + (cell.read || 0);
      node.cells[ck].write = (node.cells[ck].write || 0) + (cell.write || 0);
    }
  }
}

function serializeNode(node) {
  if (node.type === 'file') return node;
  return {
    type: 'dir',
    path: node.path,
    name: node.name,
    children: [...node.children.values()].map(serializeNode),
    cells: node.cells,
    totals: node.totals,
  };
}
