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
 * GraphQueries: flat list of per-event knowledge-graph queries (graphify / CRG)
 * with engine, op, target, and zero_hit flags. Empty unless the run used a
 * graph engine.
 *
 * Summary: global aggregates. oracle:"degraded" if ANY event was degraded.
 *
 * Pattern: mirrors dispatch-events-aggregator.js.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STAGE_ORDER } from '../app/utils/stage-order.js';

const ACCESS_EVENT_TYPE = 'pipeline.iteration.access';

// Access fragment filename: `<stage>-<iter>.jsonl` or `<stage>-<iter>-<bead>.jsonl`.
// Stage keys never contain a hyphen (plan, coordinate, implement, plan_review…);
// iteration is digits; bead ids may contain hyphens, so they soak up the rest.
const FRAGMENT_NAME_RE = /^([a-z_]+)-(\d+)(?:-(.+))?\.jsonl$/;

/**
 * Build the Access Map model from a run's events.jsonl.
 *
 * The completed iterations come from `pipeline.iteration.access` events (the
 * runner's authoritative completion-time aggregation). When `runDir` is given,
 * the still-running iteration is folded in LIVE by reading its on-disk access
 * fragment directly — so the map, searches and graph-queries populate during
 * the stage instead of only at completion. A live column is never double-counted
 * once its completion event lands (the completion payload wins by colKey), and
 * capture-integrity (leakage/oracle) stays pending for live columns since it's
 * only computable from the finished iteration.
 *
 * @param {string} eventsPath — absolute path to events.jsonl
 * @param {string|null} runDir — run directory (enables live fragment folding)
 * @returns {{ enabled: false } | { enabled: true, columns, tree, searches, summary }}
 */
export function buildFileAccessModel(eventsPath, runDir = null) {
  // Parse completion-time access events (authoritative for finished iterations).
  const accessPayloads = [];
  if (eventsPath && existsSync(eventsPath)) {
    let content = '';
    try {
      content = readFileSync(eventsPath, 'utf8');
    } catch {
      content = '';
    }
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
  }

  // Fold the still-running iteration's fragment(s) in live — skipping any
  // column that already has an authoritative completion event.
  const completedCols = new Set(
    accessPayloads.map((p) => colKey(p.stage, p.iteration, p.bead_id)),
  );
  const livePayloads = runDir
    ? readLiveFragmentPayloads(runDir, completedCols)
    : [];
  accessPayloads.push(...livePayloads);

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
        live: !!p._live,
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
  const graphQueries = [];
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
    graph_queries: 0,
    graphify: 0,
    crg: 0,
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

    // Knowledge-graph queries (graphify / CRG) — structural/semantic lookups
    // recorded alongside the lexical searches above. We only surface fields we
    // can reliably capture from both engines: the engine, the op (graphify
    // subcommand / CRG MCP tool name), and the verbatim query/args. Result
    // counts and a separate "target" are op-dependent and not reliably
    // available, so they are intentionally not collected.
    for (const g of fa.graph_queries || []) {
      graphQueries.push({
        colKey: ck,
        stage: p.stage,
        iteration: p.iteration,
        engine: g.engine,
        op: g.op,
        query: g.query,
      });
      summary.graph_queries++;
      if (g.engine === 'graphify') summary.graphify++;
      if (g.engine === 'crg') summary.crg++;
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

  return { enabled: true, columns, tree, searches, graphQueries, summary };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function colKey(stage, iteration, beadId) {
  return beadId ? `${stage}:${iteration}:${beadId}` : `${stage}:${iteration}`;
}

/**
 * Read access fragments under runDir/access/ and synthesise per-iteration
 * payloads (same shape as a pipeline.iteration.access event's payload) for the
 * still-running iterations — i.e. any fragment whose column has no completion
 * event yet. Mirrors the Python aggregation in file_access_aggregation.py,
 * minus the GitPathOracle respelling (paths are repo-root-relativised here as a
 * live approximation; the completion event respells authoritatively).
 *
 * @param {string} runDir
 * @param {Set<string>} completedCols — colKeys that already have a completion event
 * @returns {Array<object>} synthetic access payloads with `_live: true`
 */
function readLiveFragmentPayloads(runDir, completedCols) {
  const accessDir = join(runDir, 'access');
  if (!existsSync(accessDir)) return [];
  // runDir is `<repoRoot>/.worca/runs/<id>` → repoRoot is three levels up.
  const repoRoot = resolve(runDir, '..', '..', '..');

  let files;
  try {
    files = readdirSync(accessDir);
  } catch {
    return [];
  }

  const payloads = [];
  for (const fname of files) {
    const m = FRAGMENT_NAME_RE.exec(fname);
    if (!m) continue;
    const stage = m[1];
    const iteration = Number(m[2]);
    const bead_id = m[3] || null;
    if (completedCols.has(colKey(stage, iteration, bead_id))) continue;

    let records;
    try {
      records = readFileSync(join(accessDir, fname), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      continue;
    }
    if (records.length === 0) continue;

    payloads.push({
      stage,
      iteration,
      bead_id,
      agent: null,
      _live: true,
      file_access: fragmentRecordsToFileAccess(records, repoRoot),
    });
  }
  return payloads;
}

/**
 * Fold raw access-fragment records into the `file_access` shape the model
 * builder consumes. Capture is left empty — leakage/oracle are only computable
 * from the finished iteration, so they stay pending for a live column.
 */
function fragmentRecordsToFileAccess(records, repoRoot) {
  const reads = {};
  const writes = {};
  const searches = [];
  const graph_queries = [];

  for (const r of records) {
    switch (r.op) {
      case 'read': {
        const p = canonicalizePath(r.path, repoRoot);
        if (p) reads[p] = (reads[p] || 0) + 1;
        break;
      }
      case 'write': {
        const p = canonicalizePath(r.path, repoRoot);
        if (p) writes[p] = (writes[p] || 0) + 1;
        break;
      }
      case 'search': {
        let scope = r.scope || '';
        if (!scope || scope === '.') scope = '.';
        const entry = {
          tool: r.tool,
          pattern: (r.pattern || '').slice(0, 200),
          scope,
          result_count: r.result_count ?? 0,
        };
        if ('filter' in r) entry.filter = r.filter;
        searches.push(entry);
        break;
      }
      case 'graph_query': {
        if (r.engine === 'graphify' || r.engine === 'crg') {
          graph_queries.push({
            engine: r.engine,
            op: r.graph_op || '',
            query: (r.query || '').slice(0, 200),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return { reads, writes, searches, graph_queries, capture: {} };
}

/**
 * Relativise an absolute fragment path against the repo root (a live stand-in
 * for the Python GitPathOracle respelling). Paths already relative, or outside
 * the repo, are returned unchanged; the repo root itself maps to null.
 */
function canonicalizePath(rawPath, repoRoot) {
  if (!rawPath) return null;
  if (repoRoot && rawPath.startsWith(`${repoRoot}/`)) {
    return rawPath.slice(repoRoot.length + 1);
  }
  if (rawPath === repoRoot) return null;
  return rawPath;
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
