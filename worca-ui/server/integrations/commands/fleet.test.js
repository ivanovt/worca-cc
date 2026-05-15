import { describe, expect, it, vi } from 'vitest';
import { createFleetHandlers } from './fleet.js';

// ---------------------------------------------------------------------------
// Fakes
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

const FLEET_A = {
  fleet_id: 'f_202605120900_aaaaaaaa',
  fleet_id_short: 'aaaaaaaa',
  status: 'running',
  halt_reason: null,
  children_count: 2,
  children: [
    { project_path: '/r/alpha', run_id: 'run-a1', status: 'running' },
    { project_path: '/r/beta', run_id: 'run-b1', status: 'completed' },
  ],
  work_request: { title: 'Migrate auth' },
  created_at: '2026-05-12T09:00:00.000Z',
};

const FLEET_B = {
  fleet_id: 'f_202605120930_bbbbbbbb',
  fleet_id_short: 'bbbbbbbb',
  status: 'completed',
  halt_reason: null,
  children_count: 1,
  children: [
    { project_path: '/r/gamma', run_id: 'run-g1', status: 'completed' },
  ],
  work_request: { title: 'Bump deps' },
  created_at: '2026-05-12T09:30:00.000Z',
};

// ---------------------------------------------------------------------------
// /fleets — list
// ---------------------------------------------------------------------------

describe('/fleets', () => {
  it('lists only active fleets', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs': {
          status: 200,
          data: { ok: true, fleets: [FLEET_A, FLEET_B] },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers.fleets('user:1', []);
    expect(out).toContain('f_202605120900_aaaaaaaa');
    expect(out).not.toContain('f_202605120930_bbbbbbbb'); // completed → not active
    expect(out).toContain('Migrate auth');
  });

  it('reports when no active fleets exist', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs': {
          status: 200,
          data: { ok: true, fleets: [FLEET_B] },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers.fleets('user:1', []);
    expect(out).toContain('No active fleets');
  });
});

// ---------------------------------------------------------------------------
// /fleet [id|last]
// ---------------------------------------------------------------------------

describe('/fleet status', () => {
  it('shows the most recent fleet when no arg is given', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs': {
          status: 200,
          data: { ok: true, fleets: [FLEET_A, FLEET_B] },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers.fleet('user:1', []);
    // FLEET_B is newer (created 09:30) — it should be picked.
    expect(out).toContain('f_202605120930_bbbbbbbb');
  });

  it('resolves "last" to most recent', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs': {
          status: 200,
          data: { ok: true, fleets: [FLEET_A, FLEET_B] },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers.fleet('user:1', ['last']);
    expect(out).toContain('f_202605120930_bbbbbbbb');
  });

  it('resolves a full fleet id', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers.fleet('user:1', ['f_202605120900_aaaaaaaa']);
    expect(out).toContain('Migrate auth');
    expect(out).toContain('running');
  });

  it('resolves a short suffix to a unique fleet', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs': {
          status: 200,
          data: { ok: true, fleets: [FLEET_A, FLEET_B] },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers.fleet('user:1', ['aaaaaaaa']);
    expect(out).toContain('f_202605120900_aaaaaaaa');
  });

  it('reports not-found for unknown id', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs': { status: 200, data: { ok: true, fleets: [] } },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers.fleet('user:1', ['nope']);
    expect(out.toLowerCase()).toContain('no fleet');
  });
});

// ---------------------------------------------------------------------------
// /fleet-children
// ---------------------------------------------------------------------------

describe('/fleet-children', () => {
  it('renders per-child status table', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-children']('user:1', [
      'f_202605120900_aaaaaaaa',
    ]);
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).toContain('run-a1');
    expect(out).toContain('run-b1');
  });
});

// ---------------------------------------------------------------------------
// /fleet-halt
// ---------------------------------------------------------------------------

describe('/fleet-halt', () => {
  it('issues DELETE and reports success', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
      delete: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, halted_count: 2 },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-halt']('user:1', [
      'f_202605120900_aaaaaaaa',
    ]);
    expect(restClient.delete).toHaveBeenCalledWith(
      '/api/fleet-runs/f_202605120900_aaaaaaaa',
    );
    expect(out).toContain('Halted');
  });

  it('reports failure when REST returns an error', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
      delete: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': { status: 500, data: null },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-halt']('user:1', [
      'f_202605120900_aaaaaaaa',
    ]);
    expect(out).toContain('Failed to halt');
  });
});

// ---------------------------------------------------------------------------
// /fleet-stop — confirmation flow
// ---------------------------------------------------------------------------

describe('/fleet-stop confirmation', () => {
  it('first call returns a confirmation prompt and does NOT hit the REST stop endpoint', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
      post: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa/stop': {
          status: 200,
          data: { ok: true, stopped_count: 2 },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-stop']('user:1', [
      'f_202605120900_aaaaaaaa',
    ]);
    expect(out).toContain('Confirm');
    expect(out).toContain('YES');
    expect(restClient.post).not.toHaveBeenCalled();
    // Context records pending stop.
    expect(chatContext._state().pending_fleet_stop?.fleet_id).toBe(
      'f_202605120900_aaaaaaaa',
    );
  });

  it('YES after token executes the stop', async () => {
    const chatContext = makeContext({
      pending_fleet_stop: {
        fleet_id: 'f_202605120900_aaaaaaaa',
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      },
    });
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
      post: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa/stop': {
          status: 200,
          data: { ok: true, stopped_count: 2 },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-stop']('user:1', [
      'f_202605120900_aaaaaaaa',
      'YES',
    ]);
    expect(restClient.post).toHaveBeenCalledWith(
      '/api/fleet-runs/f_202605120900_aaaaaaaa/stop',
    );
    expect(out).toContain('Stopped');
    expect(chatContext._state().pending_fleet_stop).toBeNull();
  });

  it('--force bypasses the confirmation flow', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
      post: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa/stop': {
          status: 200,
          data: { ok: true, stopped_count: 2 },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-stop']('user:1', [
      'f_202605120900_aaaaaaaa',
      '--force',
    ]);
    expect(restClient.post).toHaveBeenCalled();
    expect(out).toContain('Stopped');
  });

  it('YES with expired token re-prompts instead of stopping', async () => {
    const chatContext = makeContext({
      pending_fleet_stop: {
        fleet_id: 'f_202605120900_aaaaaaaa',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
      post: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa/stop': {
          status: 200,
          data: { ok: true, stopped_count: 2 },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-stop']('user:1', [
      'f_202605120900_aaaaaaaa',
      'YES',
    ]);
    expect(out.toLowerCase()).toContain('expired');
    expect(restClient.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /fleet-pause, /fleet-resume
// ---------------------------------------------------------------------------

describe('/fleet-pause', () => {
  it('hits the /pause endpoint', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
      post: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa/pause': {
          status: 200,
          data: { ok: true, paused_count: 2 },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-pause']('user:1', [
      'f_202605120900_aaaaaaaa',
    ]);
    expect(restClient.post).toHaveBeenCalledWith(
      '/api/fleet-runs/f_202605120900_aaaaaaaa/pause',
    );
    expect(out).toContain('Paused');
  });
});

describe('/fleet-resume', () => {
  it('hits the /resume endpoint', async () => {
    const chatContext = makeContext();
    const restClient = makeClient({
      get: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa': {
          status: 200,
          data: { ok: true, fleet: FLEET_A },
        },
      },
      post: {
        '/api/fleet-runs/f_202605120900_aaaaaaaa/resume': {
          status: 200,
          data: {
            ok: true,
            continued_count: 1,
            redispatched_count: 1,
          },
        },
      },
    });
    const handlers = createFleetHandlers({ chatContext, restClient });
    const out = await handlers['fleet-resume']('user:1', [
      'f_202605120900_aaaaaaaa',
    ]);
    expect(restClient.post).toHaveBeenCalledWith(
      '/api/fleet-runs/f_202605120900_aaaaaaaa/resume',
    );
    expect(out).toContain('Resumed');
  });
});
