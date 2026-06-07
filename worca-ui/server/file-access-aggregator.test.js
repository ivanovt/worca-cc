import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFileAccessModel } from './file-access-aggregator.js';

let root;

beforeEach(() => {
  root = join(
    tmpdir(),
    `worca-file-access-agg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJsonl(path, entries) {
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

function makeAccessEvent(stage, iteration, beadId, fileAccess) {
  return {
    event_type: 'pipeline.iteration.access',
    payload: {
      run_id: 'test-run',
      stage,
      agent: stage === 'implement' ? 'implementer' : stage,
      iteration,
      bead_id: beadId,
      file_access: fileAccess,
    },
  };
}

function defaultCapture() {
  return { hook_writes: 0, git_writes: 0, leakage_pct: 0.0, oracle: 'ok' };
}

// ---------------------------------------------------------------------------
// enabled / empty-state
// ---------------------------------------------------------------------------

describe('buildFileAccessModel — empty-state', () => {
  it('returns {enabled:false} when events.jsonl does not exist', () => {
    expect(buildFileAccessModel(join(root, 'missing.jsonl'))).toEqual({
      enabled: false,
    });
  });

  it('returns {enabled:false} when no pipeline.iteration.access events present', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      { event_type: 'pipeline.run.started', payload: { run_id: 'x' } },
    ]);
    expect(buildFileAccessModel(path)).toEqual({ enabled: false });
  });

  it('returns enabled:true with all top-level keys when access events present', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, 'w-064-a', {
        reads: { 'src/runner.py': 2 },
        writes: {},
        searches: [],
        totals: {
          distinct_read: 1,
          total_read: 2,
          distinct_write: 0,
          total_write: 0,
          grep: 0,
          glob: 0,
          zero_result: 0,
          root_scoped: 0,
        },
        capture: defaultCapture(),
      }),
    ]);
    const result = buildFileAccessModel(path);
    expect(result.enabled).toBe(true);
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.tree)).toBe(true);
    expect(Array.isArray(result.searches)).toBe(true);
    expect(result.summary).toBeDefined();
  });

  it('skips malformed JSON lines silently', () => {
    const path = join(root, 'events.jsonl');
    writeFileSync(
      path,
      `{not valid json}\n${JSON.stringify(
        makeAccessEvent('plan', 1, null, {
          reads: { 'docs/spec.md': 1 },
          writes: {},
          searches: [],
          totals: {},
          capture: defaultCapture(),
        }),
      )}\n`,
    );
    const result = buildFileAccessModel(path);
    expect(result.enabled).toBe(true);
    expect(result.columns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// columns
// ---------------------------------------------------------------------------

describe('columns', () => {
  it('orders columns by canonical stage order', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('test', 1, null, {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('plan', 1, null, {
        reads: { 'b.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('implement', 1, null, {
        reads: { 'c.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { columns } = buildFileAccessModel(path);
    expect(columns.map((c) => c.stage)).toEqual(['plan', 'implement', 'test']);
  });

  it('within a stage, orders by iteration then bead_id (nulls first)', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 2, 'w-b', {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('implement', 1, 'w-b', {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('implement', 1, null, {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('implement', 1, 'w-a', {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { columns } = buildFileAccessModel(path);
    expect(columns.map((c) => c.key)).toEqual([
      'implement:1',
      'implement:1:w-a',
      'implement:1:w-b',
      'implement:2:w-b',
    ]);
  });

  it('deduplicates columns for the same stage/iteration/bead', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('plan', 1, null, {
        reads: { 'b.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { columns } = buildFileAccessModel(path);
    expect(columns).toHaveLength(1);
    expect(columns[0].key).toBe('plan:1');
  });

  it('column key omits bead_id segment when bead_id is null', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { columns } = buildFileAccessModel(path);
    expect(columns[0].key).toBe('plan:1');
    expect(columns[0].bead_id).toBeNull();
  });

  it('column includes agent field', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, 'w-a', {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { columns } = buildFileAccessModel(path);
    expect(columns[0].agent).toBe('implementer');
    expect(columns[0].stage).toBe('implement');
    expect(columns[0].iteration).toBe(1);
    expect(columns[0].bead_id).toBe('w-a');
  });
});

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

describe('tree', () => {
  function allPaths(nodes) {
    const out = [];
    for (const n of nodes) {
      out.push(n.path);
      if (n.children) out.push(...allPaths(n.children));
    }
    return out;
  }

  it('contains both reads and writes paths in the tree', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'src/runner.py': 2, 'docs/spec.md': 1 },
        writes: { 'src/output.py': 1 },
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const paths = allPaths(tree);
    expect(paths).toContain('src');
    expect(paths).toContain('src/runner.py');
    expect(paths).toContain('src/output.py');
    expect(paths).toContain('docs');
    expect(paths).toContain('docs/spec.md');
  });

  it('file category is write when writes > 0', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: {},
        writes: { 'src/foo.py': 3 },
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const srcDir = tree.find((n) => n.path === 'src');
    const file = srcDir.children.find((n) => n.name === 'foo.py');
    expect(file.category).toBe('write');
  });

  it('file category is read when only reads recorded', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'docs/plan.md': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const docsDir = tree.find((n) => n.path === 'docs');
    const file = docsDir.children.find((n) => n.name === 'plan.md');
    expect(file.category).toBe('read');
  });

  it('file tracked is true (git-respelled writes are already filtered by Python)', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: {},
        writes: { 'src/bar.py': 2 },
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const file = tree
      .find((n) => n.path === 'src')
      .children.find((n) => n.name === 'bar.py');
    expect(file.tracked).toBe(true);
  });

  it('dir rows carry rolled-up child totals (read + write)', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'src/a.py': 2, 'src/b.py': 3 },
        writes: { 'src/c.py': 5 },
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const srcDir = tree.find((n) => n.path === 'src');
    expect(srcDir.totals.read).toBe(5); // 2 + 3
    expect(srcDir.totals.write).toBe(5);
  });

  it('dir cells are union of child cells (summed per colKey)', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'src/a.py': 2, 'src/b.py': 3 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const srcDir = tree.find((n) => n.path === 'src');
    expect(srcDir.cells['plan:1'].read).toBe(5);
  });

  it('file cells keyed by column key with read and write counts', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, 'w-a', {
        reads: { 'src/x.py': 4 },
        writes: { 'src/x.py': 1 },
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const file = tree
      .find((n) => n.path === 'src')
      .children.find((n) => n.name === 'x.py');
    expect(file.cells['implement:1:w-a'].read).toBe(4);
    expect(file.cells['implement:1:w-a'].write).toBe(1);
  });

  it('merges same path across multiple events into one file node', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'src/shared.py': 2 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('test', 1, null, {
        reads: { 'src/shared.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const srcDir = tree.find((n) => n.path === 'src');
    const files = srcDir.children.filter((n) => n.name === 'shared.py');
    expect(files).toHaveLength(1);
    expect(files[0].totals.read).toBe(3);
  });

  it('handles root-level files (no directory component)', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'README.md': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { tree } = buildFileAccessModel(path);
    const file = tree.find((n) => n.path === 'README.md');
    expect(file).toBeDefined();
    expect(file.type).toBe('file');
  });
});

// ---------------------------------------------------------------------------
// searches
// ---------------------------------------------------------------------------

describe('searches', () => {
  it('includes searches with all expected fields', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, 'w-a', {
        reads: {},
        writes: {},
        searches: [
          {
            tool: 'Grep',
            pattern: 'def run',
            scope: 'src',
            result_count: 5,
            filter: null,
          },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { searches } = buildFileAccessModel(path);
    expect(searches).toHaveLength(1);
    expect(searches[0].colKey).toBe('implement:1:w-a');
    expect(searches[0].stage).toBe('implement');
    expect(searches[0].iteration).toBe(1);
    expect(searches[0].tool).toBe('Grep');
    expect(searches[0].pattern).toBe('def run');
    expect(searches[0].scope).toBe('src');
    expect(searches[0].result_count).toBe(5);
    expect(searches[0].broad).toBe(false);
    expect(searches[0].zero_hit).toBe(false);
    expect(searches[0].filter).toBeNull();
  });

  it('broad is true when scope is "."', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: {},
        writes: {},
        searches: [
          { tool: 'Glob', pattern: '**/*.py', scope: '.', result_count: 10 },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { searches } = buildFileAccessModel(path);
    expect(searches[0].broad).toBe(true);
    expect(searches[0].zero_hit).toBe(false);
  });

  it('broad is true when scope is empty string', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: {},
        writes: {},
        searches: [
          { tool: 'Grep', pattern: 'TODO', scope: '', result_count: 3 },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { searches } = buildFileAccessModel(path);
    expect(searches[0].broad).toBe(true);
  });

  it('zero_hit is true when result_count is 0', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('test', 1, null, {
        reads: {},
        writes: {},
        searches: [
          { tool: 'Grep', pattern: 'missing', scope: 'src', result_count: 0 },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { searches } = buildFileAccessModel(path);
    expect(searches[0].zero_hit).toBe(true);
  });

  it('collects searches from multiple events', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: {},
        writes: {},
        searches: [
          { tool: 'Grep', pattern: 'foo', scope: 'src', result_count: 2 },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('test', 1, null, {
        reads: {},
        writes: {},
        searches: [
          { tool: 'Glob', pattern: '*.py', scope: '.', result_count: 5 },
          { tool: 'Grep', pattern: 'bar', scope: 'tests', result_count: 0 },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { searches } = buildFileAccessModel(path);
    expect(searches).toHaveLength(3);
    const colKeys = searches.map((s) => s.colKey);
    expect(colKeys.filter((k) => k === 'implement:1')).toHaveLength(1);
    expect(colKeys.filter((k) => k === 'test:1')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

describe('summary', () => {
  it('oracle is degraded when any event has capture.oracle === "degraded"', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: {
          hook_writes: 0,
          git_writes: 0,
          leakage_pct: 0.0,
          oracle: 'ok',
        },
      }),
      makeAccessEvent('implement', 1, null, {
        reads: { 'b.py': 2 },
        writes: {},
        searches: [],
        totals: {},
        capture: {
          hook_writes: 0,
          git_writes: 0,
          leakage_pct: 0.0,
          oracle: 'degraded',
        },
      }),
    ]);
    const { summary } = buildFileAccessModel(path);
    expect(summary.oracle).toBe('degraded');
  });

  it('oracle is ok when no events are degraded', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { summary } = buildFileAccessModel(path);
    expect(summary.oracle).toBe('ok');
  });

  it('files_touched counts distinct file paths across all events', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'src/a.py': 1, 'src/b.py': 2 },
        writes: { 'src/c.py': 1 },
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('test', 1, null, {
        reads: { 'src/a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { summary } = buildFileAccessModel(path);
    expect(summary.files_touched).toBe(3); // a.py, b.py, c.py (a.py deduplicated)
  });

  it('distinct_read counts files with any read across all events', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'src/a.py': 2, 'src/b.py': 1 },
        writes: { 'src/c.py': 1 },
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { summary } = buildFileAccessModel(path);
    expect(summary.distinct_read).toBe(2);
    expect(summary.distinct_write).toBe(1);
  });

  it('total_read and total_write sum across all files and events', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'src/a.py': 2, 'src/b.py': 3 },
        writes: { 'src/c.py': 5 },
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('test', 1, null, {
        reads: { 'src/a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { summary } = buildFileAccessModel(path);
    expect(summary.total_read).toBe(6); // 2+3+1
    expect(summary.total_write).toBe(5);
  });

  it('searches count is total search entries across all events', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('implement', 1, null, {
        reads: {},
        writes: {},
        searches: [
          { tool: 'Grep', pattern: 'a', scope: 'src', result_count: 1 },
          { tool: 'Glob', pattern: '*.py', scope: '.', result_count: 5 },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
      makeAccessEvent('test', 1, null, {
        reads: {},
        writes: {},
        searches: [
          { tool: 'Grep', pattern: 'b', scope: 'tests', result_count: 0 },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { summary } = buildFileAccessModel(path);
    expect(summary.searches).toBe(3);
    expect(summary.grep).toBe(2);
    expect(summary.glob).toBe(1);
    expect(summary.zero_result).toBe(1);
    expect(summary.root_scoped).toBe(1);
  });

  it('leakage_pct_max is the maximum across all events', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: {
          hook_writes: 1,
          git_writes: 1,
          leakage_pct: 1.5,
          oracle: 'ok',
        },
      }),
      makeAccessEvent('implement', 1, null, {
        reads: { 'b.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: {
          hook_writes: 1,
          git_writes: 1,
          leakage_pct: 3.2,
          oracle: 'ok',
        },
      }),
    ]);
    const { summary } = buildFileAccessModel(path);
    expect(summary.leakage_pct_max).toBe(3.2);
  });
});

describe('graphQueries', () => {
  it('folds graph_queries with engine/op/query and summary counts', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: {},
        writes: {},
        searches: [],
        graph_queries: [
          { engine: 'graphify', op: 'query', query: 'what depends on X?' },
          { engine: 'crg', op: 'get_impact_radius', query: '{"symbol":"X"}' },
        ],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { graphQueries, summary } = buildFileAccessModel(path);
    expect(graphQueries).toHaveLength(2);
    expect(graphQueries[0]).toMatchObject({
      colKey: 'plan:1',
      stage: 'plan',
      iteration: 1,
      engine: 'graphify',
      op: 'query',
      query: 'what depends on X?',
    });
    expect(graphQueries[1].engine).toBe('crg');
    expect(summary.graph_queries).toBe(2);
    expect(summary.graphify).toBe(1);
    expect(summary.crg).toBe(1);
  });

  it('defaults to an empty list and zero counts when no graph queries present', () => {
    const path = join(root, 'events.jsonl');
    writeJsonl(path, [
      makeAccessEvent('plan', 1, null, {
        reads: { 'a.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);
    const { graphQueries, summary } = buildFileAccessModel(path);
    expect(graphQueries).toEqual([]);
    expect(summary.graph_queries).toBe(0);
  });
});

// ─── live fragment folding (in-progress iterations) ──────────────────────────

describe('buildFileAccessModel — live fragment folding', () => {
  // Build a run dir at <root>/.worca/runs/<id> so repoRoot (3 levels up) === root.
  function makeRunDir(id = 'live-run') {
    const runDir = join(root, '.worca', 'runs', id);
    mkdirSync(join(runDir, 'access'), { recursive: true });
    return runDir;
  }

  function writeFragment(runDir, name, records) {
    writeJsonl(join(runDir, 'access', name), records);
  }

  it('folds an in-progress iteration live from its fragment (no completion event)', () => {
    const runDir = makeRunDir();
    const eventsPath = join(runDir, 'events.jsonl');
    // events.jsonl exists but carries no iteration.access event yet.
    writeJsonl(eventsPath, [
      { event_type: 'pipeline.run.started', payload: {} },
    ]);
    writeFragment(runDir, 'plan-1.jsonl', [
      {
        ts: 't1',
        tool: 'mcp__code-review-graph__query_graph_tool',
        op: 'graph_query',
        engine: 'crg',
        graph_op: 'query_graph_tool',
        query: 'arch',
      },
      {
        ts: 't2',
        tool: 'Bash',
        op: 'graph_query',
        engine: 'graphify',
        graph_op: 'query',
        query: 'overview',
      },
      {
        ts: 't3',
        tool: 'Read',
        op: 'read',
        path: `${root}/docs/architecture.md`,
      },
    ]);

    const m = buildFileAccessModel(eventsPath, runDir);
    expect(m.enabled).toBe(true);
    expect(m.columns).toHaveLength(1);
    expect(m.columns[0]).toMatchObject({
      stage: 'plan',
      iteration: 1,
      live: true,
    });
    expect(m.summary.crg).toBe(1);
    expect(m.summary.graphify).toBe(1);
    expect(m.graphQueries).toHaveLength(2);
    // Read path is relativised against repoRoot (live stand-in for respelling).
    expect(m.summary.distinct_read).toBe(1);
    const flatFiles = JSON.stringify(m.tree);
    expect(flatFiles).toContain('architecture.md');
    expect(flatFiles).not.toContain(root); // absolute prefix stripped
  });

  it('does NOT double-count: a completed column wins over its fragment', () => {
    const runDir = makeRunDir('dedupe-run');
    const eventsPath = join(runDir, 'events.jsonl');
    // Completion event for plan:1 with 3 CRG queries (authoritative).
    writeJsonl(eventsPath, [
      makeAccessEvent('plan', 1, null, {
        reads: {},
        writes: {},
        searches: [],
        graph_queries: [
          { engine: 'crg', op: 'query_graph_tool', query: 'a' },
          { engine: 'crg', op: 'query_graph_tool', query: 'b' },
          { engine: 'crg', op: 'query_graph_tool', query: 'c' },
        ],
        capture: defaultCapture(),
      }),
    ]);
    // A leftover fragment for the same column must be ignored.
    writeFragment(runDir, 'plan-1.jsonl', [
      {
        ts: 't1',
        tool: 'x',
        op: 'graph_query',
        engine: 'crg',
        graph_op: 'query_graph_tool',
        query: 'stale',
      },
    ]);

    const m = buildFileAccessModel(eventsPath, runDir);
    expect(m.columns).toHaveLength(1);
    expect(m.columns[0].live).toBe(false); // completion column, not live
    expect(m.summary.crg).toBe(3); // event's 3, not 3+1
  });

  it('mixes completed event columns with the live in-flight column', () => {
    const runDir = makeRunDir('mixed-run');
    const eventsPath = join(runDir, 'events.jsonl');
    writeJsonl(eventsPath, [
      makeAccessEvent('plan', 1, null, {
        reads: {},
        writes: {},
        searches: [],
        graph_queries: [{ engine: 'crg', op: 'q', query: 'x' }],
        capture: defaultCapture(),
      }),
    ]);
    // implement:1 is still running — only a fragment exists.
    writeFragment(runDir, 'implement-1.jsonl', [
      { ts: 't1', tool: 'Write', op: 'write', path: `${root}/src/new.py` },
    ]);

    const m = buildFileAccessModel(eventsPath, runDir);
    const cols = m.columns.map((c) => `${c.stage}:${c.iteration}:${c.live}`);
    expect(cols).toContain('plan:1:false');
    expect(cols).toContain('implement:1:true');
    expect(m.summary.distinct_write).toBe(1);
  });

  it('recovers repo-relative tail for absolute paths from a sibling clone (worktree)', () => {
    // Build a worktree-style layout: <project>/.worktrees/<id>/.worca/runs/<run>
    // The fragment records absolute paths under the project itself — outside
    // the worktree root — to mimic the case where an agent uses absolute paths
    // pointing at the main checkout rather than its worktree.
    const project = join(
      tmpdir(),
      `worca-fake-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const wt = join(project, '.worktrees', 'pipeline-x');
    const runDir = join(wt, '.worca', 'runs', 'live');
    mkdirSync(join(runDir, 'access'), { recursive: true });

    const eventsPath = join(runDir, 'events.jsonl');
    writeJsonl(eventsPath, [
      { event_type: 'pipeline.run.started', payload: {} },
    ]);
    writeFragment(runDir, 'plan-1.jsonl', [
      // Note: the path lives under <project>/worca-ui/..., NOT under <wt>/...
      {
        ts: 't1',
        tool: 'Read',
        op: 'read',
        path: `${project}/worca-ui/app/views/new-run.js`,
      },
      { ts: 't2', tool: 'Write', op: 'write', path: `${project}/src/foo.py` },
    ]);

    const m = buildFileAccessModel(eventsPath, runDir);
    expect(m.enabled).toBe(true);
    expect(m.summary.distinct_read).toBe(1);
    expect(m.summary.distinct_write).toBe(1);

    // The tree must contain the repo-relative tails, not the absolute prefix.
    const flat = JSON.stringify(m.tree);
    expect(flat).toContain('worca-ui/app/views');
    expect(flat).toContain('new-run.js');
    expect(flat).toContain('foo.py');
    // The absolute prefix (everything up to and including the project basename)
    // must be stripped out.
    expect(flat).not.toContain(project);

    rmSync(project, { recursive: true, force: true });
  });

  it('collapses single-child directory chains into one synthetic node', () => {
    // Single file deep under a chain of single-child dirs. Without the
    // collapse this would render as 4 nested dir rows hiding the file name.
    const runDir = makeRunDir('collapse-run');
    const eventsPath = join(runDir, 'events.jsonl');
    writeJsonl(eventsPath, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'a/b/c/d/leaf.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);

    const { tree } = buildFileAccessModel(eventsPath);
    // The top level should be a single dir whose name joins the collapsed
    // chain ("a/b/c/d"); its only child is the leaf file.
    expect(tree).toHaveLength(1);
    const top = tree[0];
    expect(top.type).toBe('dir');
    expect(top.name).toBe('a/b/c/d');
    expect(top.path).toBe('a/b/c/d');
    expect(top.children).toHaveLength(1);
    expect(top.children[0].type).toBe('file');
    expect(top.children[0].name).toBe('leaf.py');
  });

  it('does NOT collapse when a dir has more than one child', () => {
    const runDir = makeRunDir('nocollapse-run');
    const eventsPath = join(runDir, 'events.jsonl');
    writeJsonl(eventsPath, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'src/a.py': 1, 'src/b.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);

    const { tree } = buildFileAccessModel(eventsPath);
    expect(tree).toHaveLength(1);
    const src = tree[0];
    expect(src.name).toBe('src');
    expect(src.path).toBe('src');
    expect(src.children).toHaveLength(2);
  });

  it('preserves leaf file paths through a collapse (drawer lookups still work)', () => {
    // The collapsed dir's `path` must be the deepest dir's path so that the
    // file's `path` field (e.g. `a/b/c/d/leaf.py`) still resolves under it,
    // and the per-file drawer keyed on the file path keeps working.
    const runDir = makeRunDir('collapse-paths');
    const eventsPath = join(runDir, 'events.jsonl');
    writeJsonl(eventsPath, [
      makeAccessEvent('implement', 1, null, {
        reads: { 'a/b/leaf.py': 1 },
        writes: {},
        searches: [],
        totals: {},
        capture: defaultCapture(),
      }),
    ]);

    const { tree } = buildFileAccessModel(eventsPath);
    expect(tree[0].path).toBe('a/b');
    expect(tree[0].children[0].path).toBe('a/b/leaf.py');
  });

  it('is unchanged (event-only) when runDir is omitted', () => {
    const runDir = makeRunDir('noarg-run');
    const eventsPath = join(runDir, 'events.jsonl');
    writeJsonl(eventsPath, [
      { event_type: 'pipeline.run.started', payload: {} },
    ]);
    writeFragment(runDir, 'plan-1.jsonl', [
      {
        ts: 't1',
        tool: 'x',
        op: 'graph_query',
        engine: 'crg',
        graph_op: 'q',
        query: 'y',
      },
    ]);
    // No runDir → no live folding → no access events → disabled.
    expect(buildFileAccessModel(eventsPath).enabled).toBe(false);
    // With runDir → live folding kicks in.
    expect(buildFileAccessModel(eventsPath, runDir).enabled).toBe(true);
  });
});
