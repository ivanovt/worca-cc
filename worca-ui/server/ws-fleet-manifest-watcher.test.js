import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('createFleetManifestWatcher', () => {
  let createFleetManifestWatcher;
  let mockWatch;
  let watchCallback;
  let mockExistsSync;
  let mockReadFileSync;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    watchCallback = null;
    const closeFn = vi.fn();
    mockWatch = vi.fn((_path, _opts, cb) => {
      watchCallback = cb;
      return { close: closeFn };
    });
    mockExistsSync = vi.fn(() => true);
    mockReadFileSync = vi.fn();

    vi.doMock('node:fs', () => ({
      existsSync: mockExistsSync,
      watch: mockWatch,
      readFileSync: mockReadFileSync,
    }));

    const mod = await import('./ws-fleet-manifest-watcher.js');
    createFleetManifestWatcher = mod.createFleetManifestWatcher;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('watches the fleet-runs directory with persistent:false', () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });

    expect(mockWatch).toHaveBeenCalledWith(
      fleetRunsDir,
      expect.objectContaining({ persistent: false }),
      expect.any(Function),
    );
  });

  it('does not watch when fleet-runs dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const broadcaster = { broadcast: vi.fn() };

    createFleetManifestWatcher({ broadcaster, fleetRunsDir: '/nonexistent' });

    expect(mockWatch).not.toHaveBeenCalled();
  });

  it('ignores non-JSON filenames', async () => {
    const broadcaster = { broadcast: vi.fn() };
    createFleetManifestWatcher({
      broadcaster,
      fleetRunsDir: '/tmp/test-fleet-runs',
    });

    watchCallback('change', 'some-file.txt');
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it('ignores null filename', async () => {
    const broadcaster = { broadcast: vi.fn() };
    createFleetManifestWatcher({
      broadcaster,
      fleetRunsDir: '/tmp/test-fleet-runs',
    });

    watchCallback('change', null);
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts fleet-update with correct payload on JSON file change', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';
    const fleetId = 'f_202605120809_abc123';
    const manifest = {
      fleet_id: fleetId,
      status: 'running',
      halt_reason: null,
      children: [
        { run_id: 'run-1', project_path: '/proj1' },
        { run_id: 'run-2', project_path: '/proj2' },
      ],
    };

    mockReadFileSync.mockImplementation((path) => {
      if (path.endsWith(`${fleetId}.json`)) return JSON.stringify(manifest);
      if (path.includes('run-1'))
        return JSON.stringify({ status: 'completed' });
      if (path.includes('run-2')) return JSON.stringify({ status: 'running' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });
    watchCallback('change', `${fleetId}.json`);
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'fleet-update',
      expect.objectContaining({
        fleet_id: fleetId,
        status: 'running',
        halt_reason: null,
        completed_children: 1,
        failed_children: 0,
        children: [
          { run_id: 'run-1', project_path: '/proj1', status: 'completed' },
          { run_id: 'run-2', project_path: '/proj2', status: 'running' },
        ],
      }),
    );
  });

  it('counts failed and setup_failed children as failed', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';
    const fleetId = 'f_fail_test';
    const manifest = {
      fleet_id: fleetId,
      status: 'failed',
      halt_reason: null,
      children: [
        { run_id: 'run-a', project_path: '/projA' },
        { run_id: 'run-b', project_path: '/projB' },
        { run_id: 'run-c', project_path: '/projC' },
      ],
    };

    mockReadFileSync.mockImplementation((path) => {
      if (path.endsWith(`${fleetId}.json`)) return JSON.stringify(manifest);
      if (path.includes('run-a'))
        return JSON.stringify({ status: 'completed' });
      if (path.includes('run-b')) return JSON.stringify({ status: 'failed' });
      if (path.includes('run-c'))
        return JSON.stringify({ status: 'setup_failed' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });
    watchCallback('change', `${fleetId}.json`);
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'fleet-update',
      expect.objectContaining({
        completed_children: 1,
        failed_children: 2,
      }),
    );
  });

  // Regression: previously the watcher broadcast manifest.status verbatim,
  // so fleets whose children had all finished still showed 'running' over
  // WebSocket until a REST GET reconciled. The watcher now passes the live
  // child statuses through effectiveFleetStatus().
  it('broadcasts effective status, not raw manifest.status', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';
    const fleetId = 'f_202605120809_eff0001';
    // Manifest still says running (run_fleet.py never wrote terminal), but
    // every child is completed → effective status should be 'completed'.
    const manifest = {
      fleet_id: fleetId,
      status: 'running',
      halt_reason: null,
      children: [
        { run_id: 'run-1', project_path: '/projA' },
        { run_id: 'run-2', project_path: '/projB' },
      ],
    };

    mockReadFileSync.mockImplementation((path) => {
      if (path.endsWith(`${fleetId}.json`)) return JSON.stringify(manifest);
      if (path.includes('run-1'))
        return JSON.stringify({ status: 'completed' });
      if (path.includes('run-2'))
        return JSON.stringify({ status: 'completed' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });
    watchCallback('change', `${fleetId}.json`);
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'fleet-update',
      expect.objectContaining({
        fleet_id: fleetId,
        status: 'completed',
        completed_children: 2,
        failed_children: 0,
      }),
    );
  });

  it('honors sticky halted status when children are all terminal', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';
    const fleetId = 'f_202605120809_halt001';
    // User halted the fleet — even with all-completed children, the broadcast
    // must keep 'halted' so the UI does not silently revive a halted fleet.
    const manifest = {
      fleet_id: fleetId,
      status: 'halted',
      halt_reason: 'user',
      children: [{ run_id: 'run-1', project_path: '/projA' }],
    };

    mockReadFileSync.mockImplementation((path) => {
      if (path.endsWith(`${fleetId}.json`)) return JSON.stringify(manifest);
      if (path.includes('run-1'))
        return JSON.stringify({ status: 'completed' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });
    watchCallback('change', `${fleetId}.json`);
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'fleet-update',
      expect.objectContaining({
        status: 'halted',
        halt_reason: 'user',
      }),
    );
  });

  it('treats missing child registry entry as running', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';
    const fleetId = 'f_missing_child';
    const manifest = {
      fleet_id: fleetId,
      status: 'running',
      halt_reason: null,
      children: [{ run_id: 'run-x', project_path: '/projX' }],
    };

    mockReadFileSync.mockImplementation((path) => {
      if (path.endsWith(`${fleetId}.json`)) return JSON.stringify(manifest);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });
    watchCallback('change', `${fleetId}.json`);
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'fleet-update',
      expect.objectContaining({
        children: [
          { run_id: 'run-x', project_path: '/projX', status: 'running' },
        ],
        completed_children: 0,
        failed_children: 0,
      }),
    );
  });

  it('does not broadcast when manifest is unreadable', async () => {
    const broadcaster = { broadcast: vi.fn() };
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    createFleetManifestWatcher({
      broadcaster,
      fleetRunsDir: '/tmp/test-fleet-runs',
    });
    watchCallback('change', 'f_bad.json');
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it('debounces rapid changes to the same fleet', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';
    const fleetId = 'f_debounce';
    const manifest = {
      fleet_id: fleetId,
      status: 'running',
      halt_reason: null,
      children: [],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(manifest));

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });

    watchCallback('change', `${fleetId}.json`);
    watchCallback('change', `${fleetId}.json`);
    watchCallback('change', `${fleetId}.json`);

    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent changes to different fleets independently', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';

    const makeManifest = (id) => ({
      fleet_id: id,
      status: 'running',
      halt_reason: null,
      children: [],
    });
    mockReadFileSync.mockImplementation((path) => {
      if (path.includes('f_alpha'))
        return JSON.stringify(makeManifest('f_alpha'));
      if (path.includes('f_beta'))
        return JSON.stringify(makeManifest('f_beta'));
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });

    watchCallback('change', 'f_alpha.json');
    watchCallback('change', 'f_beta.json');

    await vi.advanceTimersByTimeAsync(300);

    const types = broadcaster.broadcast.mock.calls.map((c) => c[0]);
    expect(types.filter((t) => t === 'fleet-update')).toHaveLength(2);
    const fleetIds = broadcaster.broadcast.mock.calls.map((c) => c[1].fleet_id);
    expect(fleetIds).toContain('f_alpha');
    expect(fleetIds).toContain('f_beta');
  });

  it('destroy() closes the fs watcher', () => {
    const broadcaster = { broadcast: vi.fn() };
    const closeFn = vi.fn();
    mockWatch.mockReturnValue({ close: closeFn });

    const watcher = createFleetManifestWatcher({
      broadcaster,
      fleetRunsDir: '/tmp/test-fleet-runs',
    });
    watcher.destroy();

    expect(closeFn).toHaveBeenCalled();
  });

  it('destroy() cancels pending debounce timers', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const manifest = {
      fleet_id: 'f_cancel',
      status: 'running',
      halt_reason: null,
      children: [],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(manifest));

    const watcher = createFleetManifestWatcher({
      broadcaster,
      fleetRunsDir: '/tmp/test-fleet-runs',
    });

    watchCallback('change', 'f_cancel.json');
    watcher.destroy();

    await vi.advanceTimersByTimeAsync(300);
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it('halted fleet includes halt_reason in payload', async () => {
    const broadcaster = { broadcast: vi.fn() };
    const fleetRunsDir = '/tmp/test-fleet-runs';
    const fleetId = 'f_halted';
    const manifest = {
      fleet_id: fleetId,
      status: 'halted',
      halt_reason: 'circuit_breaker',
      children: [],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(manifest));

    createFleetManifestWatcher({ broadcaster, fleetRunsDir });
    watchCallback('change', `${fleetId}.json`);
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcaster.broadcast).toHaveBeenCalledWith(
      'fleet-update',
      expect.objectContaining({
        fleet_id: fleetId,
        status: 'halted',
        halt_reason: 'circuit_breaker',
      }),
    );
  });
});
