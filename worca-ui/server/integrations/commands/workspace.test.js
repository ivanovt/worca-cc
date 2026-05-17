import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceHandlers } from './workspace.js';

// ---------------------------------------------------------------------------
// Fakes (mirror commands/fleet.test.js shape)
// ---------------------------------------------------------------------------

function makeContext(initial = {}) {
  let state = { ...initial };
  return {
    get: vi.fn(() => ({ ...state })),
    set: vi.fn((_key, patch) => {
      state = { ...state, ...patch };
    }),
    _state: () => state,
  };
}

function makeClient(routes) {
  return {
    get: vi.fn(
      async (path) => routes.get?.[path] ?? { status: 404, data: null },
    ),
    post: vi.fn(
      async (path) => routes.post?.[path] ?? { status: 404, data: null },
    ),
    delete: vi.fn(
      async (path) => routes.delete?.[path] ?? { status: 404, data: null },
    ),
  };
}

const WS_A = {
  workspace_id: 'ws_202605120900_aaaaaaaa',
  workspace_name: 'my-platform',
  status: 'running',
  halt_reason: null,
  children_count: 2,
  children: [
    { project: 'shared-lib', run_id: 'run-a1', status: 'completed', tier: 0 },
    { project: 'backend', run_id: 'run-b1', status: 'running', tier: 1 },
  ],
  dag: {
    tiers: [
      { tier: 0, projects: ['shared-lib'], status: 'completed' },
      { tier: 1, projects: ['backend'], status: 'running' },
    ],
    dependency_graph: { 'shared-lib': [], backend: ['shared-lib'] },
  },
  work_request: { title: 'Add auth across services' },
  created_at: '2026-05-12T09:00:00.000Z',
};

const WS_B = {
  workspace_id: 'ws_202605120930_bbbbbbbb',
  workspace_name: 'my-platform',
  status: 'completed',
  halt_reason: null,
  children_count: 1,
  children: [
    {
      project: 'shared-lib',
      run_id: 'run-g1',
      status: 'completed',
      tier: 0,
      pr_number: 42,
      pr_url: 'https://github.com/org/shared-lib/pull/42',
      nwo: 'org/shared-lib',
    },
  ],
  dag: { tiers: [{ tier: 0, projects: ['shared-lib'], status: 'completed' }] },
  umbrella_issue: {
    url: 'https://github.com/org/platform/issues/99',
  },
  work_request: { title: 'Bump deps' },
  created_at: '2026-05-12T09:30:00.000Z',
};

// ---------------------------------------------------------------------------
// /workspaces — list
// ---------------------------------------------------------------------------

describe('/workspaces', () => {
  it('lists only active workspaces', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs': {
          status: 200,
          data: { ok: true, workspace_runs: [WS_A, WS_B] },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspaces('user:1', []);
    expect(out).toContain('ws_202605120900_aaaaaaaa');
    expect(out).not.toContain('ws_202605120930_bbbbbbbb'); // completed → not active
    expect(out).toContain('my-platform');
  });

  it('reports when no active workspaces exist', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs': {
          status: 200,
          data: { ok: true, workspace_runs: [WS_B] },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspaces('user:1', []);
    expect(out).toContain('No active workspaces');
  });

  it('treats planning/integration_testing/resuming/paused as active', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs': {
          status: 200,
          data: {
            ok: true,
            workspace_runs: [
              { ...WS_A, status: 'planning' },
              { ...WS_B, workspace_id: 'ws_ip', status: 'integration_testing' },
              { ...WS_B, workspace_id: 'ws_re', status: 'resuming' },
              { ...WS_B, workspace_id: 'ws_pa', status: 'paused' },
              { ...WS_B, workspace_id: 'ws_done', status: 'completed' },
            ],
          },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspaces('user:1', []);
    expect(out).toContain('ws_202605120900_aaaaaaaa');
    expect(out).toContain('ws_ip');
    expect(out).toContain('ws_re');
    expect(out).toContain('ws_pa');
    expect(out).not.toContain('ws_done');
  });
});

// ---------------------------------------------------------------------------
// /workspace [id|last]
// ---------------------------------------------------------------------------

describe('/workspace status', () => {
  it('shows the most recent workspace when no arg is given', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs': {
          status: 200,
          data: { ok: true, workspace_runs: [WS_A, WS_B] },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspace('user:1', []);
    // WS_B is newer (09:30) — it should be picked.
    expect(out).toContain('ws_202605120930_bbbbbbbb');
  });

  it('resolves "last" to most recent', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs': {
          status: 200,
          data: { ok: true, workspace_runs: [WS_A, WS_B] },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspace('user:1', ['last']);
    expect(out).toContain('ws_202605120930_bbbbbbbb');
  });

  it('resolves a full workspace id', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, manifest: WS_A, cost_usd: 1.23 },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspace('user:1', [
      'ws_202605120900_aaaaaaaa',
    ]);
    expect(out).toContain('my-platform');
    expect(out).toContain('running');
    expect(out).toContain('$1.23');
  });

  it('resolves a short suffix to a unique workspace', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs': {
          status: 200,
          data: { ok: true, workspace_runs: [WS_A, WS_B] },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspace('user:1', ['aaaaaaaa']);
    expect(out).toContain('ws_202605120900_aaaaaaaa');
  });

  it('reports not-found for unknown id', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs': {
          status: 200,
          data: { ok: true, workspace_runs: [] },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspace('user:1', ['nope']);
    expect(out.toLowerCase()).toContain('no workspace');
  });

  it('reports disambiguation when short suffix matches multiple', async () => {
    const chatContext = makeContext();
    const extra = { ...WS_A, workspace_id: 'ws_202605120945_aaaaaaaa' };
    const restClient = makeClient({
      get: {
        '/api/workspace-runs': {
          status: 200,
          data: { ok: true, workspace_runs: [WS_A, extra] },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers.workspace('user:1', ['aaaaaaaa']);
    expect(out).toContain('Multiple workspaces');
  });
});

// ---------------------------------------------------------------------------
// /workspace-projects
// ---------------------------------------------------------------------------

describe('/workspace-projects', () => {
  it('renders per-project status table with tier annotation', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, manifest: WS_A },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers['workspace-projects']('user:1', [
      'ws_202605120900_aaaaaaaa',
    ]);
    expect(out).toContain('shared-lib');
    expect(out).toContain('backend');
    expect(out).toContain('tier 0');
    expect(out).toContain('tier 1');
    expect(out).toContain('run-a1');
  });
});

// ---------------------------------------------------------------------------
// /workspace-tiers
// ---------------------------------------------------------------------------

describe('/workspace-tiers', () => {
  it('renders tier-by-tier DAG with per-project status', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, manifest: WS_A },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers['workspace-tiers']('user:1', [
      'ws_202605120900_aaaaaaaa',
    ]);
    expect(out).toContain('Tier 0');
    expect(out).toContain('Tier 1');
    expect(out).toContain('shared-lib');
    expect(out).toContain('backend');
  });
});

// ---------------------------------------------------------------------------
// /workspace-halt
// ---------------------------------------------------------------------------

describe('/workspace-halt', () => {
  it('issues DELETE and reports success', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, manifest: WS_A },
        },
      },
      delete: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers['workspace-halt']('user:1', [
      'ws_202605120900_aaaaaaaa',
    ]);
    expect(restClient.delete).toHaveBeenCalledWith(
      '/api/workspace-runs/ws_202605120900_aaaaaaaa',
    );
    expect(out).toContain('Halted');
  });

  it('reports failure when REST returns an error', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, manifest: WS_A },
        },
      },
      delete: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 500,
          data: null,
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers['workspace-halt']('user:1', [
      'ws_202605120900_aaaaaaaa',
    ]);
    expect(out).toContain('Failed to halt');
  });
});

// ---------------------------------------------------------------------------
// /workspace-resume
// ---------------------------------------------------------------------------

describe('/workspace-resume', () => {
  it('hits the /resume endpoint', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, manifest: WS_A },
        },
      },
      post: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa/resume': {
          status: 200,
          data: { ok: true },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers['workspace-resume']('user:1', [
      'ws_202605120900_aaaaaaaa',
    ]);
    expect(restClient.post).toHaveBeenCalledWith(
      '/api/workspace-runs/ws_202605120900_aaaaaaaa/resume',
    );
    expect(out).toContain('Resumed');
  });
});

// ---------------------------------------------------------------------------
// /workspace-prs
// ---------------------------------------------------------------------------

describe('/workspace-prs', () => {
  it('lists per-project PRs + umbrella issue', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs/ws_202605120930_bbbbbbbb': {
          status: 200,
          data: { ok: true, manifest: WS_B },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers['workspace-prs']('user:1', [
      'ws_202605120930_bbbbbbbb',
    ]);
    expect(out).toContain('shared-lib');
    expect(out).toContain('org/shared-lib#42');
    expect(out).toContain('Umbrella');
    expect(out).toContain('issues/99');
  });

  it('reports no-PRs gracefully', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/workspace-runs/ws_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, manifest: WS_A },
        },
      },
    });
    const handlers = createWorkspaceHandlers({ chatContext, restClient });
    const out = await handlers['workspace-prs']('user:1', [
      'ws_202605120900_aaaaaaaa',
    ]);
    expect(out).toContain('no PRs');
  });
});
