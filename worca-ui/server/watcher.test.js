import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _setDiscoverRunsTtlForTest,
  clearDiscoverRunsCache,
  createRunId,
  discoverRuns,
  discoverRunsAsync,
  findRun,
} from './watcher.js';

describe('watcher', () => {
  let dir;
  beforeEach(() => {
    dir = join(tmpdir(), `worca-watch-${Date.now()}`);
    mkdirSync(join(dir, 'results'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    // Reset discoverRuns cache state so the cache test's TTL override can't
    // leak into other tests.
    clearDiscoverRunsCache();
    _setDiscoverRunsTtlForTest(0);
  });

  // ---- findRun: O(1) single-run lookup, parity with discoverRuns ----
  it('findRun returns null when the run does not exist', () => {
    expect(findRun(dir, 'does-not-exist')).toBeNull();
    expect(findRun(dir, '')).toBeNull();
    expect(findRun('', 'x')).toBeNull();
  });

  it('findRun matches discoverRuns for a runs/ (active) run', () => {
    const runId = 'run-active-1';
    const runDir = join(dir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        started_at: '2026-05-01T10:00:00Z',
        pipeline_status: 'running',
        work_request: { title: 'active' },
        stages: { plan: { status: 'in_progress' } },
      }),
    );
    const viaFind = findRun(dir, runId);
    const viaScan = discoverRuns(dir).find((r) => r.id === runId);
    expect(viaFind).toEqual(viaScan);
    expect(viaFind.active).toBe(true);
  });

  it('findRun matches discoverRuns for a results/<id>/ (archived) run', () => {
    const runId = 'run-archived-1';
    const runDir = join(dir, 'results', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        started_at: '2026-05-01T11:00:00Z',
        completed_at: '2026-05-01T11:30:00Z',
        pipeline_status: 'completed',
        work_request: { title: 'done' },
        stages: { plan: { status: 'completed' } },
      }),
    );
    const viaFind = findRun(dir, runId);
    const viaScan = discoverRuns(dir).find((r) => r.id === runId);
    expect(viaFind).toEqual(viaScan);
    expect(viaFind.active).toBe(false);
  });

  it('findRun matches discoverRuns for a legacy results/<id>.json file', () => {
    const runId = 'run-legacy-1';
    writeFileSync(
      join(dir, 'results', `${runId}.json`),
      JSON.stringify({
        run_id: runId,
        started_at: '2026-05-01T12:00:00Z',
        completed_at: '2026-05-01T12:30:00Z',
        pipeline_status: 'completed',
        work_request: { title: 'legacy' },
        stages: { plan: { status: 'completed' } },
      }),
    );
    const viaFind = findRun(dir, runId);
    const viaScan = discoverRuns(dir).find((r) => r.id === runId);
    expect(viaFind).toEqual(viaScan);
  });

  it('findRun matches discoverRuns for a worktree (pipelines.d) run incl. worktree fields', () => {
    const runId = 'run-wt-1';
    const wtDir = join(dir, 'worktrees', 'wt-1');
    const wtRunDir = join(wtDir, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        started_at: '2026-05-01T13:00:00Z',
        pipeline_status: 'running',
        work_request: { title: 'wt task' },
        stages: { plan: { status: 'in_progress' } },
      }),
    );
    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${runId}.json`),
      JSON.stringify({
        run_id: runId,
        worktree_path: wtDir,
        branch: 'feat/x',
        target_branch: 'main',
        fleet_id: 'fleet-9',
        status: 'running',
      }),
    );
    const viaFind = findRun(dir, runId);
    const viaScan = discoverRuns(dir).find((r) => r.id === runId);
    expect(viaFind).toEqual(viaScan);
    expect(viaFind.is_worktree_run).toBe(true);
    expect(viaFind.worktree_worca_dir).toBe(join(wtDir, '.worca'));
    expect(viaFind.head_branch).toBe('feat/x');
    expect(viaFind.target_branch).toBe('main');
    expect(viaFind.fleet_id).toBe('fleet-9');
  });

  it('findRun falls back to a scan for the legacy flat status.json (name != id)', () => {
    const status = {
      started_at: '2026-05-01T14:00:00Z',
      pipeline_status: 'running',
      work_request: { title: 'flat legacy' },
      stages: { plan: { status: 'in_progress' } },
    };
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    const id = createRunId(status); // hashed id (no run_id) → no matching dir
    const viaFind = findRun(dir, id);
    const viaScan = discoverRuns(dir).find((r) => r.id === id);
    expect(viaFind).not.toBeNull();
    expect(viaFind).toEqual(viaScan);
  });

  // ---- discoverRuns TTL cache (#2) ----
  it('discoverRuns caches within the TTL and refreshes after clear', () => {
    _setDiscoverRunsTtlForTest(5000);
    clearDiscoverRunsCache();
    const mk = (id) => {
      const rd = join(dir, 'runs', id);
      mkdirSync(rd, { recursive: true });
      writeFileSync(
        join(rd, 'status.json'),
        JSON.stringify({
          run_id: id,
          started_at: '2026-05-01T10:00:00Z',
          pipeline_status: 'running',
          work_request: { title: id },
          stages: { plan: { status: 'in_progress' } },
        }),
      );
    };
    mk('cache-r1');
    expect(discoverRuns(dir).length).toBe(1);
    mk('cache-r2');
    // Within the TTL window the cached scan is reused — the new run isn't seen.
    expect(discoverRuns(dir).length).toBe(1);
    clearDiscoverRunsCache();
    // After invalidation the fresh scan picks up both runs.
    expect(discoverRuns(dir).length).toBe(2);
  });

  it('createRunId generates deterministic ID from status', () => {
    const status = {
      started_at: '2026-03-08T10:00:00Z',
      work_request: { title: 'test' },
    };
    const id = createRunId(status);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(createRunId(status)).toBe(id);
  });

  it('discoverRuns finds active run from status.json when pipeline_status is running', () => {
    const status = {
      started_at: '2026-03-08T10:00:00Z',
      stage: 'implement',
      pipeline_status: 'running',
      work_request: { title: 'test' },
      stages: {
        plan: { status: 'completed' },
        implement: { status: 'in_progress' },
      },
    };
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    const runs = discoverRuns(dir);
    expect(runs.length).toBe(1);
    expect(runs[0].stage).toBe('implement');
    expect(runs[0].active).toBe(true);
  });

  it('discoverRuns marks run inactive when pipeline_status is not running', () => {
    const status = {
      started_at: '2026-03-08T10:00:00Z',
      stage: 'implement',
      work_request: { title: 'test' },
      stages: {
        plan: { status: 'completed' },
        implement: { status: 'in_progress' },
      },
    };
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    const runs = discoverRuns(dir);
    expect(runs.length).toBe(1);
    expect(runs[0].active).toBe(false);
  });

  it('discoverRuns finds completed runs from results/', () => {
    const result = {
      started_at: '2026-03-07T09:00:00Z',
      stage: 'pr',
      work_request: { title: 'old run' },
      stages: { plan: { status: 'completed' }, pr: { status: 'completed' } },
    };
    writeFileSync(join(dir, 'results', 'abc123.json'), JSON.stringify(result));
    const runs = discoverRuns(dir);
    expect(runs.length).toBe(1);
    expect(runs[0].active).toBe(false);
  });

  it('discoverRuns preserves iterations array in status', () => {
    const status = {
      started_at: '2026-03-08T12:00:00Z',
      stage: 'implement',
      work_request: { title: 'iter test' },
      stages: {
        plan: { status: 'completed' },
        implement: {
          status: 'in_progress',
          iterations: [
            { iteration: 1, files_changed: 3 },
            { iteration: 2, files_changed: 1 },
          ],
        },
      },
    };
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    const runs = discoverRuns(dir);
    expect(runs.length).toBe(1);
    expect(runs[0].stages.implement.iterations).toEqual([
      { iteration: 1, files_changed: 3 },
      { iteration: 2, files_changed: 1 },
    ]);
  });

  it('enriches iterations with aggregated dispatch_events when events.jsonl is present', () => {
    const runId = 'run-disp-1';
    const runDir = join(dir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    // Status with one implement iteration spanning 11:00 → 11:05.
    const status = {
      run_id: runId,
      started_at: '2026-04-13T11:00:00.000Z',
      completed_at: '2026-04-13T11:05:00.000Z',
      pipeline_status: 'completed',
      stages: {
        implement: {
          status: 'completed',
          iterations: [
            {
              number: 1,
              started_at: '2026-04-13T11:00:00.000Z',
              completed_at: '2026-04-13T11:05:00.000Z',
            },
          ],
        },
      },
    };
    writeFileSync(join(runDir, 'status.json'), JSON.stringify(status));
    // events.jsonl: three explore allowed + one general-purpose blocked, all in window.
    const events = [
      {
        event_type: 'pipeline.run.started',
        timestamp: '2026-04-13T11:00:00.000Z',
        payload: {},
      },
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:01:00.000Z',
        payload: {
          agent: 'implementer',
          section: 'subagents',
          candidate: 'Explore',
        },
      },
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:02:00.000Z',
        payload: {
          agent: 'implementer',
          section: 'subagents',
          candidate: 'Explore',
        },
      },
      {
        event_type: 'pipeline.hook.dispatch_allowed',
        timestamp: '2026-04-13T11:03:00.000Z',
        payload: {
          agent: 'implementer',
          section: 'subagents',
          candidate: 'Explore',
        },
      },
      {
        event_type: 'pipeline.hook.dispatch_blocked',
        timestamp: '2026-04-13T11:04:00.000Z',
        payload: {
          agent: 'implementer',
          section: 'subagents',
          candidate: 'general-purpose',
          reason: 'Blocked: denylist',
        },
      },
    ];
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );

    const runs = discoverRuns(dir);
    const run = runs.find((r) => r.id === runId);
    expect(run).toBeDefined();
    const iter = run.stages.implement.iterations[0];
    expect(iter.dispatch_events).toBeDefined();
    // One entry per (type, section, candidate) — not four.
    expect(iter.dispatch_events).toHaveLength(2);
    const allowed = iter.dispatch_events.find(
      (e) => e.type === 'pipeline.hook.dispatch_allowed',
    );
    expect(allowed.section).toBe('subagents');
    expect(allowed.candidate).toBe('Explore');
    expect(allowed.count).toBe(3);
    const blocked = iter.dispatch_events.find(
      (e) => e.type === 'pipeline.hook.dispatch_blocked',
    );
    expect(blocked.section).toBe('subagents');
    expect(blocked.candidate).toBe('general-purpose');
    expect(blocked.count).toBe(1);
    expect(blocked.reason).toBe('Blocked: denylist');
  });

  it('discoverRuns_no_active_run: finds runs in runs/ without active_run file present', () => {
    const runId = 'run-no-active-run';
    const runDir = join(dir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const status = {
      run_id: runId,
      started_at: '2026-04-26T10:00:00Z',
      pipeline_status: 'running',
      work_request: { title: 'no active_run test' },
      stages: { plan: { status: 'in_progress' } },
    };
    writeFileSync(join(runDir, 'status.json'), JSON.stringify(status));
    // Deliberately no active_run file
    const runs = discoverRuns(dir);
    const run = runs.find((r) => r.run_id === runId);
    expect(run).toBeDefined();
    expect(run.active).toBe(true);
  });

  it('does not add dispatch_events when events.jsonl is missing', () => {
    const runId = 'run-disp-2';
    const runDir = join(dir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const status = {
      run_id: runId,
      started_at: '2026-04-13T11:00:00.000Z',
      pipeline_status: 'completed',
      stages: {
        implement: {
          status: 'completed',
          iterations: [{ number: 1, started_at: '2026-04-13T11:00:00.000Z' }],
        },
      },
    };
    writeFileSync(join(runDir, 'status.json'), JSON.stringify(status));

    const runs = discoverRuns(dir);
    const run = runs.find((r) => r.id === runId);
    expect(run.stages.implement.iterations[0].dispatch_events).toBeUndefined();
  });

  it('discoverRuns_pipelines_d_fanout: reads worktree runs from pipelines.d/ entries', () => {
    const wtDir = join(dir, 'worktrees', 'wt-abc');
    const wtRunId = 'run-wt-001';
    const wtRunDir = join(wtDir, '.worca', 'runs', wtRunId);
    mkdirSync(wtRunDir, { recursive: true });

    const wtStatus = {
      run_id: wtRunId,
      started_at: '2026-04-26T10:00:00Z',
      pipeline_status: 'running',
      work_request: { title: 'worktree task' },
      stages: { plan: { status: 'in_progress' } },
    };
    writeFileSync(join(wtRunDir, 'status.json'), JSON.stringify(wtStatus));

    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    const reg = {
      run_id: wtRunId,
      worktree_path: wtDir,
      title: 'worktree task',
      pid: 99999,
      status: 'running',
    };
    writeFileSync(join(pipelinesDir, `${wtRunId}.json`), JSON.stringify(reg));

    const runs = discoverRuns(dir);
    const run = runs.find((r) => r.run_id === wtRunId);
    expect(run).toBeDefined();
    expect(run.is_worktree_run).toBe(true);
    expect(run.worktree_worca_dir).toBe(join(wtDir, '.worca'));
    expect(run.active).toBe(true);
  });

  it('discoverRuns_dedup_across_sources: run in both root runs/ and worktree appears once', () => {
    const sharedRunId = 'run-shared-001';

    // Root runs/ entry
    const rootRunDir = join(dir, 'runs', sharedRunId);
    mkdirSync(rootRunDir, { recursive: true });
    const rootStatus = {
      run_id: sharedRunId,
      started_at: '2026-04-26T11:00:00Z',
      pipeline_status: 'running',
      work_request: { title: 'shared run' },
      stages: { plan: { status: 'in_progress' } },
    };
    writeFileSync(join(rootRunDir, 'status.json'), JSON.stringify(rootStatus));

    // Same run also in a worktree (same run_id)
    const wtDir = join(dir, 'worktrees', 'wt-shared');
    const wtRunDir = join(wtDir, '.worca', 'runs', sharedRunId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(join(wtRunDir, 'status.json'), JSON.stringify(rootStatus));

    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${sharedRunId}.json`),
      JSON.stringify({
        run_id: sharedRunId,
        worktree_path: wtDir,
        title: 'shared run',
        pid: 99998,
        status: 'running',
      }),
    );

    const runs = discoverRuns(dir);
    const matching = runs.filter((r) => r.run_id === sharedRunId);
    expect(matching).toHaveLength(1);
  });

  it('discoverRuns_stale_entry: gracefully skips pipelines.d entry whose worktree no longer exists', () => {
    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, 'run-gone.json'),
      JSON.stringify({
        run_id: 'run-gone',
        worktree_path: join(dir, 'worktrees', 'does-not-exist'),
        title: 'vanished task',
        pid: 99990,
        status: 'running',
      }),
    );

    // Should not throw; stale entry is silently skipped
    const runs = discoverRuns(dir);
    expect(runs.find((r) => r.run_id === 'run-gone')).toBeUndefined();
  });

  it('worktree run includes head_branch from registry entry', async () => {
    const wtDir = join(dir, 'worktrees', 'wt-branch');
    const wtRunId = 'run-branch-001';
    const wtRunDir = join(wtDir, '.worca', 'runs', wtRunId);
    mkdirSync(wtRunDir, { recursive: true });

    const wtStatus = {
      run_id: wtRunId,
      started_at: '2026-05-18T10:00:00Z',
      pipeline_status: 'running',
      branch: 'master',
      work_request: { title: 'branch test' },
      stages: { plan: { status: 'in_progress' } },
    };
    writeFileSync(join(wtRunDir, 'status.json'), JSON.stringify(wtStatus));

    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${wtRunId}.json`),
      JSON.stringify({
        run_id: wtRunId,
        worktree_path: wtDir,
        title: 'branch test',
        pid: 99996,
        status: 'running',
        branch: 'worca/feature-xyz-20260518',
        target_branch: 'master',
      }),
    );

    // Sync
    const syncRuns = discoverRuns(dir);
    const syncRun = syncRuns.find((r) => r.run_id === wtRunId);
    expect(syncRun).toBeDefined();
    expect(syncRun.head_branch).toBe('worca/feature-xyz-20260518');

    // Async
    const asyncRuns = await discoverRunsAsync(dir);
    const asyncRun = asyncRuns.find((r) => r.run_id === wtRunId);
    expect(asyncRun).toBeDefined();
    expect(asyncRun.head_branch).toBe('worca/feature-xyz-20260518');
  });

  it('worktree run has head_branch null when registry has no branch', async () => {
    const wtDir = join(dir, 'worktrees', 'wt-no-branch');
    const wtRunId = 'run-no-branch-001';
    const wtRunDir = join(wtDir, '.worca', 'runs', wtRunId);
    mkdirSync(wtRunDir, { recursive: true });

    const wtStatus = {
      run_id: wtRunId,
      started_at: '2026-05-18T10:30:00Z',
      pipeline_status: 'running',
      work_request: { title: 'no branch test' },
      stages: { plan: { status: 'in_progress' } },
    };
    writeFileSync(join(wtRunDir, 'status.json'), JSON.stringify(wtStatus));

    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${wtRunId}.json`),
      JSON.stringify({
        run_id: wtRunId,
        worktree_path: wtDir,
        title: 'no branch test',
        pid: 99995,
        status: 'running',
      }),
    );

    const syncRuns = discoverRuns(dir);
    const syncRun = syncRuns.find((r) => r.run_id === wtRunId);
    expect(syncRun.head_branch).toBeNull();

    const asyncRuns = await discoverRunsAsync(dir);
    const asyncRun = asyncRuns.find((r) => r.run_id === wtRunId);
    expect(asyncRun.head_branch).toBeNull();
  });

  // ---- source_type / source_ref passthrough (#W-067) ----
  it('source_type and source_ref pass through from status.json for a regular run', () => {
    const runId = 'run-pr-src-1';
    const runDir = join(dir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        started_at: '2026-06-04T10:00:00Z',
        pipeline_status: 'running',
        source_type: 'github_pr',
        source_ref: 'gh:pr:42',
        work_request: { title: 'pr revision' },
        stages: { plan: { status: 'in_progress' } },
      }),
    );
    const run = discoverRuns(dir).find((r) => r.run_id === runId);
    expect(run).toBeDefined();
    expect(run.source_type).toBe('github_pr');
    expect(run.source_ref).toBe('gh:pr:42');
  });

  it('source_type and source_ref default to null when absent from status.json', () => {
    const runId = 'run-no-src-1';
    const runDir = join(dir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        run_id: runId,
        started_at: '2026-06-04T10:00:00Z',
        pipeline_status: 'running',
        work_request: { title: 'no source' },
        stages: { plan: { status: 'in_progress' } },
      }),
    );
    const run = discoverRuns(dir).find((r) => r.run_id === runId);
    expect(run).toBeDefined();
    expect(run.source_type).toBeNull();
    expect(run.source_ref).toBeNull();
  });

  it('worktree run passes source_type and source_ref from status.json', async () => {
    const wtDir = join(dir, 'worktrees', 'wt-pr-src');
    const wtRunId = 'run-wt-pr-src-1';
    const wtRunDir = join(wtDir, '.worca', 'runs', wtRunId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: wtRunId,
        started_at: '2026-06-04T10:00:00Z',
        pipeline_status: 'running',
        source_type: 'github_pr',
        source_ref: 'gh:pr:99',
        work_request: { title: 'wt pr revision' },
        stages: { plan: { status: 'in_progress' } },
      }),
    );
    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${wtRunId}.json`),
      JSON.stringify({
        run_id: wtRunId,
        worktree_path: wtDir,
        title: 'wt pr revision',
        pid: 99994,
        status: 'running',
      }),
    );
    const run = discoverRuns(dir).find((r) => r.run_id === wtRunId);
    expect(run).toBeDefined();
    expect(run.is_worktree_run).toBe(true);
    expect(run.source_type).toBe('github_pr');
    expect(run.source_ref).toBe('gh:pr:99');
  });

  it('worktree run source_type and source_ref default to null when absent', async () => {
    const wtDir = join(dir, 'worktrees', 'wt-no-src');
    const wtRunId = 'run-wt-no-src-1';
    const wtRunDir = join(wtDir, '.worca', 'runs', wtRunId);
    mkdirSync(wtRunDir, { recursive: true });
    writeFileSync(
      join(wtRunDir, 'status.json'),
      JSON.stringify({
        run_id: wtRunId,
        started_at: '2026-06-04T10:00:00Z',
        pipeline_status: 'running',
        work_request: { title: 'wt no source' },
        stages: { plan: { status: 'in_progress' } },
      }),
    );
    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${wtRunId}.json`),
      JSON.stringify({
        run_id: wtRunId,
        worktree_path: wtDir,
        title: 'wt no source',
        pid: 99993,
        status: 'running',
      }),
    );
    const run = discoverRuns(dir).find((r) => r.run_id === wtRunId);
    expect(run).toBeDefined();
    expect(run.is_worktree_run).toBe(true);
    expect(run.source_type).toBeNull();
    expect(run.source_ref).toBeNull();
  });

  it('in-place run does not have head_branch', () => {
    const runId = 'run-inplace-001';
    const runDir = join(dir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });

    const status = {
      run_id: runId,
      started_at: '2026-05-18T11:00:00Z',
      pipeline_status: 'running',
      branch: 'master',
      work_request: { title: 'in-place run' },
      stages: { plan: { status: 'in_progress' } },
    };
    writeFileSync(join(runDir, 'status.json'), JSON.stringify(status));

    const runs = discoverRuns(dir);
    const run = runs.find((r) => r.run_id === runId);
    expect(run).toBeDefined();
    expect(run.head_branch).toBeUndefined();
  });

  it('discoverRuns_fleet_id_propagation: fleet_id from registry entry propagates to run', async () => {
    const wtDir = join(dir, 'worktrees', 'wt-fleet');
    const wtRunId = 'run-fleet-001';
    const wtRunDir = join(wtDir, '.worca', 'runs', wtRunId);
    mkdirSync(wtRunDir, { recursive: true });

    const wtStatus = {
      run_id: wtRunId,
      started_at: '2026-04-26T12:00:00Z',
      pipeline_status: 'running',
      work_request: { title: 'fleet task' },
      stages: { plan: { status: 'in_progress' } },
    };
    writeFileSync(join(wtRunDir, 'status.json'), JSON.stringify(wtStatus));

    const pipelinesDir = join(dir, 'multi', 'pipelines.d');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, `${wtRunId}.json`),
      JSON.stringify({
        run_id: wtRunId,
        worktree_path: wtDir,
        title: 'fleet task',
        pid: 99997,
        status: 'running',
        fleet_id: 'fleet-abc-123',
        group_type: 'fleet',
        target_branch: 'main',
      }),
    );

    // Test sync variant
    const syncRuns = discoverRuns(dir);
    const syncRun = syncRuns.find((r) => r.run_id === wtRunId);
    expect(syncRun).toBeDefined();
    expect(syncRun.fleet_id).toBe('fleet-abc-123');
    expect(syncRun.group_type).toBe('fleet');
    expect(syncRun.target_branch).toBe('main');
    expect(syncRun.workspace_id).toBeNull();

    // Test async variant
    const asyncRuns = await discoverRunsAsync(dir);
    const asyncRun = asyncRuns.find((r) => r.run_id === wtRunId);
    expect(asyncRun).toBeDefined();
    expect(asyncRun.fleet_id).toBe('fleet-abc-123');
    expect(asyncRun.group_type).toBe('fleet');
    expect(asyncRun.is_worktree_run).toBe(true);
  });
});
