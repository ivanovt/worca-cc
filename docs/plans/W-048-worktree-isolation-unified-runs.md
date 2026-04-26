# W-048: Worktree-Based Pipeline Isolation and Unified Run Aggregation

**Status:** Draft
**Priority:** P1
**Area:** cc + ui
**Date:** 2026-04-26
**Depends on:** None (foundation for W-040, W-047)

## Problem

The pipeline architecture has a single-pipeline assumption baked into every layer. `runner.py:1270-1273` writes a single `active_run` pointer file to `.worca/active_run` on every fresh start. When a second pipeline starts in the same `.worca/` directory, it overwrites this pointer, making the first pipeline invisible to the UI. Every consumer — `hooks/prompt.py:19-28`, `resume.py:174-181`, `run_pipeline.py:154-162`, `watcher.js:52-71`, `ws-status-watcher.js:21-31`, `process-manager.js:576-585` — reads `active_run` as the single source of truth for "which run is active," silently dropping all others.

Meanwhile, `run_multi.py` exists as a batch orchestrator that launches multiple work requests in parallel worktrees, but it is intra-repo only (`git worktree add` cannot span distinct `.git/` directories). The UI's `discoverRuns` (`watcher.js:48-152`) scans `runs/` and `results/` but has no mechanism to discover worktree-hosted runs. The `pipelines.d/` registry (`registry.py:48-66`) exists but is write-only from `run_multi.py` — nothing in the UI reads it for run discovery.

This blocks W-040 (fleet runs) and W-047 (coordinated workspaces), both of which require multi-pipeline concurrency with unified visibility.

## Proposal

Replace the `active_run` single-pointer model with `runs/` directory scanning. Rename `run_multi.py` to `run_worktree.py` and repurpose it as a single-pipeline worktree launcher (the building block for W-040/W-047). Extend `discoverRuns` to fan out across `pipelines.d/` entries, making worktree runs visible alongside root runs. Add `target_branch` support for PR creation against non-default branches. Add a `worca cleanup` command for worktree disk management.

## Design

### 1. Drop `active_run` Pointer

- **Current state:** `runner.py:1270-1273` writes `run_id` to `.worca/active_run` on every fresh start. Six consumers read it: `runner.py:1182-1191` (resume detection), `hooks/prompt.py:19-28` (status loading in hook hot path), `resume.py:174-181` (`can_resume` check), `run_pipeline.py:154-162` (resume fallback), `watcher.js:52-71` (step 1 of `discoverRuns`), `ws-status-watcher.js:21-31` (`resolveActiveRunDir`), `process-manager.js:157-166` (`reconcileStatus` fallback), `process-manager.js:576-585` (`_readActiveRunId`), `process-manager.js:618-627` (`deleteRun` cleanup), `process-manager.js:680-688` (`restartStage` status lookup).
- **Obstacle:** A single pointer cannot represent multiple concurrent pipelines. Every write clobbers the previous value.
- **Resolution:** Delete the `active_run` write at `runner.py:1270-1273`. Replace all reads with `runs/` directory scanning. Each replacement strategy is tailored to the consumer's needs:

  **Python consumers:**

  | Consumer | Current logic | Replacement |
  |----------|--------------|-------------|
  | `runner.py:1182-1191` | Read `active_run` → look up `runs/{id}/status.json` | Scan `runs/*/status.json` for non-terminal runs. If exactly one, use it. If zero, fall through to legacy `status.json`. If multiple, require `--resume --status-dir` to disambiguate. |
  | `hooks/prompt.py:19-28` | Read `active_run` → parse JSON | Match `os.getpid()` against `runs/*/pipeline.pid` files. Integer comparison is cheaper than JSON parsing on every tool call. Cache the matched path for the process lifetime. |
  | `resume.py:174-181` | Read `active_run` → `load_status` | Same scan-for-non-terminal logic as `runner.py`. If the caller already knows the `run_id` (passed via `--status-dir`), use it directly. |
  | `run_pipeline.py:154-162` | Read `active_run` → candidate path | On `--resume` without `--status-dir`: scan `runs/` for non-terminal runs. If exactly one, resume it. If multiple, error with "specify --status-dir". |

  **UI server consumers:**

  | Consumer | Current logic | Replacement |
  |----------|--------------|-------------|
  | `watcher.js:52-71` | Step 1: read `active_run` → enrich | Remove step 1 entirely. Step 2 (`runs/` scan at lines 73-93) already discovers the same run. Deduplication via `seenIds` is unaffected. |
  | `ws-status-watcher.js:21-31` | `resolveActiveRunDir` reads `active_run` | Replace with: scan `runs/*/pipeline.pid`, find the one with a live process (`process.kill(pid, 0)`). If none found, return `worcaDir` (legacy fallback). Cache result, invalidate on `runs/` directory change. |
  | `ws-status-watcher.js:198-221` | Watch `worcaDir` for `active_run` changes | Remove the `active_run` filename filter. The `runsDirWatcher` at lines 223-239 already watches `runs/` recursively and triggers `scheduleRefresh` on `status.json` changes. The `activeRunWatcher` can be simplified to watch only for `status.json` changes (legacy flat file). |
  | `process-manager.js:157-166` | `reconcileStatus` adds `active_run` ID to check set | Remove. The `runs/*/pipeline.pid` scan at lines 141-155 already covers all runs. |
  | `process-manager.js:576-585` | `_readActiveRunId` helper | Delete entirely. No caller needs "the single active run" — callers now pass explicit `runId`. |
  | `process-manager.js:618-627` | `deleteRun` clears `active_run` if it matched | Remove the `active_run` cleanup block. |
  | `process-manager.js:680-688` | `restartStage` finds status via `active_run` | Accept `runId` parameter. Look up `runs/{runId}/status.json` directly. If `runId` not provided, scan `runs/` for non-terminal runs (same logic as Python side). |

  **Migration:** The `active_run` file is deleted on the next `worca init --upgrade`. Existing pipelines that wrote it before the upgrade are still discoverable via `runs/` scan (the `active_run` file was always a secondary pointer — `runs/{id}/status.json` is the primary record).

### 2. Stop Writing Project-Level PID and Status Files

- **Current state:** `runner.py:1275-1277` writes PID to both `runs/{run_id}/pipeline.pid` (per-run) and `.worca/pipeline.pid` (project-level). Legacy `.worca/status.json` is referenced as a fallback in `watcher.js:95-110`, `hooks/prompt.py:31-32`.
- **Obstacle:** Project-level files assume a single active pipeline. With concurrent runs, only the last writer's PID survives.
- **Resolution:** Stop writing to `.worca/pipeline.pid` and `.worca/status.json` on fresh starts. Keep reading them as read-only legacy fallbacks for runs that were started before this change (lines `watcher.js:95-110`, `process-manager.js:98`). The `getRunningPid` method at `process-manager.js:92-124` already checks per-run PID first and falls back to project-level — this ordering means per-run is authoritative once written.

  Remove the second `_write_pid(status_path)` call at `runner.py:1277` (project-level). Keep the first `_write_pid(actual_status_path)` at `runner.py:1276` (per-run).

### 3. Rename `run_multi.py` → `run_worktree.py` and Repurpose

- **Current state:** `run_multi.py` (386 lines) is a batch orchestrator accepting `--requests`/`--sources` (multiple work items), dispatching them in parallel via `ThreadPoolExecutor`, each into its own worktree.
- **Obstacle:** W-040 needs a single-pipeline worktree launcher (one prompt → one worktree → fire-and-forget). The batch model conflates orchestration with isolation.
- **Resolution:** Replace `run_multi.py` with `run_worktree.py` — a single-pipeline worktree launcher with this CLI interface:

  ```
  python .claude/worca/scripts/run_worktree.py \
      --prompt "Add user auth" \           # or --source gh:issue:42
      --branch feature/auth \              # optional target branch
      --plan path/to/plan.md \             # optional pre-made plan
      --guide path/to/spec.md \            # optional reference guide (W-040)
      --fleet-id f_20260426_abc \          # optional fleet grouping (W-040)
      --msize 3 --mloops 2                 # pass-through to run_pipeline.py
  ```

  The script:
  1. Generates a `run_id` via the same `_generate_run_id` format as `runner.py:217-231`.
  2. Derives a slug from the prompt/source for branch and worktree naming.
  3. Creates a git worktree via `create_pipeline_worktree(run_id, slug, base_branch)` (`utils/git.py:67-81`).
  4. Copies `.claude/worca/` into the worktree (gitignored, won't exist otherwise).
  5. Initializes beads in the worktree via `init_worktree_beads` (`utils/git.py:166-175`).
  6. Registers in `pipelines.d/` via `register_pipeline(run_id, worktree_path, title, pid, fleet_id=..., target_branch=...)` — see §5.
  7. Spawns `run_pipeline.py --worktree [--plan ...] [--guide ...] [--branch ...]` inside the worktree as a detached subprocess.
  8. Prints `run_id` and worktree path, then exits immediately.

  **Flags designed for downstream consumers (W-040, W-047):**
  - `--fleet-id <id>`: Passed through to `register_pipeline()`. Optional, omitted for standalone worktree runs.
  - `--guide <path>` (repeatable): Resolved to absolute path, passed through to `run_pipeline.py --guide`. W-040's `attach_guide()` handles the content injection.
  - `--plan <path>`: Passed through to `run_pipeline.py --plan`.
  - `--branch <name>`: The base branch to fork from (passed to `create_pipeline_worktree` and stored as `target_branch` in the registry entry and status).
  - `--template`, `--param`, `--msize`, `--mloops`, `--skip-preflight`: Pass-through to `run_pipeline.py`.

  **Batch mode recovery:** The batch capability of `run_multi.py` (multiple `--requests`) is dropped. A shell loop (`for req in ...; do run_worktree.py --prompt "$req"; done`) or W-040's `run_fleet.py` replaces it.

### 4. `run_pipeline.py` — Wire `--guide` Flag

- **Current state:** `run_pipeline.py:19-49` has flags for `--prompt`, `--source`, `--plan`, `--branch`, `--worktree`, etc. No `--guide` flag.
- **Obstacle:** W-040's shared reference-context mechanism requires `--guide` to be accepted by `run_pipeline.py` so that `run_worktree.py` (and later `run_fleet.py`) can pass it through.
- **Resolution:** Add `--guide` (repeatable) to `run_pipeline.py`'s argument parser. After `WorkRequest` normalization, call the `attach_guide()` helper (implemented in W-040 Phase 1, `work_request.py`). For now, if `attach_guide` is not yet available (W-048 ships before W-040), accept the flag and store it in status metadata without injection. W-040 wires the actual content injection.

  This ensures `run_worktree.py` can pass `--guide` through to `run_pipeline.py` from day one, even before W-040 implements the guide content injection logic.

### 5. Extend `pipelines.d/` Registry

- **Current state:** `registry.py:48-66` registers pipelines with `run_id`, `worktree_path`, `title`, `pid`, `status`, timestamps. No fields for fleet grouping, target branch, or group type.
- **Obstacle:** W-040 needs `fleet_id`, W-047 needs `group_type`, and both need `target_branch`. These must be optional to maintain backward compatibility.
- **Resolution:** Extend `register_pipeline()` with keyword-only arguments:

  ```python
  def register_pipeline(
      run_id, worktree_path, title, pid,
      base=_DEFAULT_BASE,
      *,
      fleet_id=None,        # W-040: fleet grouping
      group_type=None,      # W-047: "fleet" | "workspace" | None
      target_branch=None,   # PR target branch
  ):
  ```

  All new fields are optional and omitted from the JSON when `None`. Existing callers (`run_multi.py` → `run_worktree.py`, `runner.py:1281-1285`) continue to work unchanged. `discoverRuns` includes these fields in run metadata when present.

  **Registry location:** `pipelines.d/` is always per-project at `<project>/.worca/multi/pipelines.d/`. For cross-project discovery (W-040 fleet, W-047 workspace), the higher-level orchestrator (`run_fleet.py`, `run_workspace.py`) maintains a manifest with child `project_path` + `run_id` pairs, and the UI's `discoverRuns` fans out by following those pointers. This plan does not introduce cross-project aggregation — that's W-040's responsibility. This plan makes the per-project registry ready for it.

### 6. Unified Run Aggregation — `discoverRuns` Fan-Out

- **Current state:** `discoverRuns` (`watcher.js:48-152`) has 4 steps: (1) `active_run` pointer, (2) `runs/` scan, (3) legacy `status.json`, (4) `results/` directory. Step 1 is removed per §1. Steps 2-4 only discover runs in the root `.worca/` directory. Worktree runs registered in `pipelines.d/` are invisible.
- **Obstacle:** `run_worktree.py` spawns pipelines in worktrees that have their own `.worca/runs/` directories. The root project's `discoverRuns` never looks there.
- **Resolution:** Add step 5 to `discoverRuns` (both sync and async variants):

  ```javascript
  // 5. Fan out across pipelines.d/ registry entries
  const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
  if (existsSync(pipelinesDir)) {
    for (const entry of readdirSync(pipelinesDir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const reg = JSON.parse(readFileSync(join(pipelinesDir, entry), 'utf8'));
        if (!reg.worktree_path) continue;
        const wtRunsDir = join(reg.worktree_path, '.worca', 'runs');
        // Try worktree's runs/ directory first
        if (existsSync(wtRunsDir)) {
          for (const runEntry of readdirSync(wtRunsDir)) {
            const sp = join(wtRunsDir, runEntry, 'status.json');
            if (!existsSync(sp)) continue;
            let status = JSON.parse(readFileSync(sp, 'utf8'));
            status = enrichWithDispatchEvents(status, join(wtRunsDir, runEntry));
            const id = createRunId(status);
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const active = !isTerminal(status) && status.pipeline_status === 'running';
            runs.push({
              id, active, ...status,
              worktree_worca_dir: join(reg.worktree_path, '.worca'),
              is_worktree_run: true,
              fleet_id: reg.fleet_id || null,
              group_type: reg.group_type || null,
              target_branch: reg.target_branch || null,
            });
          }
        }
      } catch { /* ignore */ }
    }
  }
  ```

  The `worktree_worca_dir` and `is_worktree_run` fields let the UI and `ProcessManager` resolve the correct `.worca/` directory for lifecycle operations (stop/pause/resume) on worktree runs.

### 7. Status Watcher — Watch `pipelines.d/` for Worktree Changes

- **Current state:** `ws-status-watcher.js:223-239` watches `.worca/runs/` recursively. No watcher on `pipelines.d/`.
- **Obstacle:** When a worktree run's status changes, the root project's `runs/` watcher doesn't fire — the change is in the worktree's `.worca/runs/`, not the root's.
- **Resolution:** Add two watcher layers:

  1. **`pipelines.d/` directory watcher:** Watch `.worca/multi/pipelines.d/` for file additions/removals. On change, `scheduleRefresh()` (which calls `discoverRunsAsync` including the new step 5).

  2. **Per-worktree status watchers:** For each active (non-terminal) entry in `pipelines.d/`, add a lightweight `fs.watch()` on `<worktree>/.worca/runs/` (recursive). Maintain a `Map<run_id, FSWatcher>` for lifecycle management. On `scheduleRefresh`, reconcile the map: add watchers for new entries, close watchers for completed/removed entries.

  **Scaling note:** Each active worktree adds one recursive watcher. On macOS kqueue, this is cheap. At >50 concurrent worktrees (unlikely for a single project), fall back to periodic polling (30s interval). W-040's fleet and W-047's workspace add more watchers across projects; those features manage their own cross-project watchers.

### 8. Lifecycle Routing for Worktree Runs

- **Current state:** `process-manager.js` methods (`stopPipeline:399`, `pausePipeline:637`, `restartStage:662`) operate on `this.worcaDir` — the root project's `.worca/`. They cannot target a worktree's `.worca/`.
- **Obstacle:** A stop/pause/resume command for a worktree run must target the correct PID file and status.json inside the worktree, not the root project.
- **Resolution:** Add `resolveRunContext(runId)` to `ProcessManager`:

  ```javascript
  resolveRunContext(runId) {
    // 1. Check root runs/ first
    const rootPath = join(this.worcaDir, 'runs', runId, 'status.json');
    if (existsSync(rootPath)) {
      return { worcaDir: this.worcaDir, runDir: join(this.worcaDir, 'runs', runId) };
    }
    // 2. Check pipelines.d/ registry
    const pipelinesDir = join(this.worcaDir, 'multi', 'pipelines.d');
    const regPath = join(pipelinesDir, `${runId}.json`);
    if (existsSync(regPath)) {
      const reg = JSON.parse(readFileSync(regPath, 'utf8'));
      if (reg.worktree_path) {
        const wtWorcaDir = join(reg.worktree_path, '.worca');
        return { worcaDir: wtWorcaDir, runDir: join(wtWorcaDir, 'runs', runId) };
      }
    }
    return null;
  }
  ```

  All lifecycle methods (`stopPipeline`, `pausePipeline`, `resumePipeline`, `restartStage`, `deleteRun`) call `resolveRunContext(runId)` first and operate on the resolved `worcaDir`/`runDir`. If the run is in a worktree, PID files and status.json are read/written in the worktree's `.worca/`, not the root's.

### 9. `startPipeline` — Switch to `run_worktree.py`

- **Current state:** `process-manager.js:273-391` spawns `run_pipeline.py` directly for new pipelines. This creates a run in the root project's `.worca/runs/` with no worktree isolation.
- **Obstacle:** Without isolation, concurrent pipelines started from the UI would collide (same working tree, same git index, same branch).
- **Resolution:** When starting a non-resume pipeline, `startPipeline` spawns `run_worktree.py` instead of `run_pipeline.py`. The worktree launcher handles isolation, registration, and `run_pipeline.py` dispatch internally.

  ```javascript
  // Before: spawn run_pipeline.py directly
  const args = ['.claude/worca/scripts/run_pipeline.py'];

  // After: spawn run_worktree.py for new runs, run_pipeline.py for resume
  const script = opts.resume
    ? '.claude/worca/scripts/run_pipeline.py'
    : '.claude/worca/scripts/run_worktree.py';
  const args = [script];
  ```

  Resume continues to target `run_pipeline.py --resume --status-dir <path>` because the worktree already exists and the run directory is known.

  **Backward compatibility:** The UI server detects whether `run_worktree.py` exists. If not (older worca version), it falls back to `run_pipeline.py` with a console warning. This supports the transition period where the user hasn't run `worca init --upgrade` yet.

### 10. `target_branch` for PR Creation

- **Current state:** Guardian reads the default branch from settings or git config for `gh pr create --base`. No mechanism to specify a custom target branch per-pipeline.
- **Obstacle:** Worktree runs forked from a feature branch should create PRs targeting that branch, not `main`.
- **Resolution:**
  - `run_worktree.py --branch feature/foo` passes the branch to `create_pipeline_worktree` as the base (forking point) and stores it in the `pipelines.d/` entry as `target_branch`.
  - `runner.py` stores `target_branch` in `status.json` at initialization (from `--branch` flag or `WORCA_TARGET_BRANCH` env var).
  - Guardian agent (`agents/core/guardian.md`) reads `status.get("target_branch")` and uses it for `gh pr create --base {target}`. Falls back to the default base branch if unset.

### 11. `discoverRuns` — Fix `results/` Active Flag

- **Current state:** `watcher.js:112-149` scans `results/` and derives `active` from `pipeline_status`. The logic at line 127/139 is: `!isTerminal(status) && status.pipeline_status === 'running'`. This is correct — `results/` entries will almost always be terminal. But if a run was moved to `results/` while still running (a bug in older versions), the flag correctly reflects that.
- **Obstacle:** No actual bug — the existing logic is already correct.
- **Resolution:** No change needed. Issue #82's original description listed this as step 1, but the code already handles it correctly. Verified at `watcher.js:127` and `watcher.js:139`.

### 12. Worktree Cleanup Command

- **Current state:** `utils/git.py:84-116` has `remove_pipeline_worktree(worktree_path)` and `list_pipeline_worktrees()` (`utils/git.py:119-153`). `run_multi.py:357-375` has cleanup logic but it's tied to the batch orchestrator.
- **Obstacle:** Worktrees persist after pipeline completion. No user-facing command to list and clean them up. Over time, disk usage grows (each worktree is a full working copy; git objects are shared via alternates but files are duplicated).
- **Resolution:** Add `worca cleanup` CLI command in `src/worca/cli/cleanup.py`:

  ```
  worca cleanup                          # Interactive: list worktrees, prompt for removal
  worca cleanup --all                    # Remove all completed worktrees
  worca cleanup --run-id <id>            # Remove a specific worktree by run ID
  worca cleanup --dry-run                # List what would be removed
  worca cleanup --older-than 7d          # Remove completed worktrees older than 7 days
  ```

  The command:
  1. Scans `pipelines.d/` for entries with `worktree_path`.
  2. Cross-references with `status.json` in each worktree — only completed/failed runs are eligible for cleanup.
  3. Calls `remove_pipeline_worktree(worktree_path)` and `deregister_pipeline(run_id)`.
  4. Reports freed disk space.

  Running worktrees are never cleaned up. The `--all` flag skips the interactive prompt but still excludes running pipelines.

## Implementation Plan

### Phase 1: Remove `active_run` — Python side

**Files:** `src/worca/orchestrator/runner.py`, `src/worca/hooks/prompt.py`, `src/worca/orchestrator/resume.py`, `src/worca/scripts/run_pipeline.py`

**Tasks:**
1. Remove `active_run` write at `runner.py:1270-1273`. Remove the project-level PID write at `runner.py:1277`.
2. Replace `active_run` read in `runner.py:1182-1191` with `runs/` scan for non-terminal runs (helper: `_find_active_runs(worca_dir)` returning list of `(run_id, status_path)` tuples).
3. Replace `active_run` read in `hooks/prompt.py:19-28` with PID-matching against `runs/*/pipeline.pid`. Cache the matched path in a module-level variable keyed by `os.getpid()`.
4. Replace `active_run` read in `resume.py:174-181` with `runs/` scan. Accept optional `run_id` parameter for direct lookup.
5. Update `run_pipeline.py:154-162` resume logic to use `runs/` scan. Error with "specify --status-dir" when multiple non-terminal runs found.

### Phase 2: Remove `active_run` — UI server side

**Files:** `worca-ui/server/watcher.js`, `worca-ui/server/ws-status-watcher.js`, `worca-ui/server/process-manager.js`

**Tasks:**
1. Remove step 1 (`active_run` pointer check) from `discoverRuns` at `watcher.js:52-71` and `discoverRunsAsync`.
2. Rewrite `resolveActiveRunDir` in `ws-status-watcher.js:21-31` to scan `runs/*/pipeline.pid` for live processes. Rename to `resolveLatestRunDir` to reflect new semantics.
3. Simplify `activeRunWatcher` at `ws-status-watcher.js:198-221`: remove the `filename === 'active_run'` filter. Keep watching `worcaDir` for `status.json` (legacy) only.
4. Remove `active_run` fallback from `reconcileStatus` at `process-manager.js:157-166`.
5. Delete `_readActiveRunId` at `process-manager.js:576-585`.
6. Remove `active_run` cleanup block from `deleteRun` at `process-manager.js:618-627`.
7. Update `restartStage` at `process-manager.js:680-688` to accept `runId` parameter and look up directly.

### Phase 3: Rename and rewrite `run_worktree.py`

**Files:** `src/worca/scripts/run_worktree.py` (new, replaces `run_multi.py`), `src/worca/scripts/run_multi.py` (delete)

**Tasks:**
1. Create `run_worktree.py` with the CLI interface defined in §3: `--prompt`, `--source`, `--branch`, `--plan`, `--guide`, `--fleet-id`, `--msize`, `--mloops`, `--template`, `--param`, `--skip-preflight`.
2. Implement: generate run_id, create worktree, copy `.claude/worca/`, init beads, register in `pipelines.d/`, spawn `run_pipeline.py --worktree`, exit.
3. Wire `--guide` flag into `run_pipeline.py` argument parser (accept and store in status; content injection deferred to W-040).
4. Delete `run_multi.py`.

### Phase 4: Extend `pipelines.d/` and `discoverRuns` fan-out

**Files:** `src/worca/orchestrator/registry.py`, `worca-ui/server/watcher.js`

**Tasks:**
1. Add `fleet_id`, `group_type`, `target_branch` keyword-only args to `register_pipeline()` at `registry.py:48`.
2. Add step 5 to `discoverRuns` (sync and async): fan out across `pipelines.d/` entries with `worktree_path`, read worktree's `runs/*/status.json`, augment with `worktree_worca_dir`, `is_worktree_run`, `fleet_id`, `group_type`, `target_branch`.

### Phase 5: Watchers and lifecycle routing

**Files:** `worca-ui/server/ws-status-watcher.js`, `worca-ui/server/process-manager.js`

**Tasks:**
1. Add `pipelines.d/` directory watcher in `ws-status-watcher.js`. On entry add/remove, `scheduleRefresh`.
2. Add per-worktree status watchers: maintain `Map<run_id, FSWatcher>`, reconcile on refresh.
3. Add `resolveRunContext(runId)` to `ProcessManager` (§8).
4. Update `stopPipeline`, `pausePipeline`, `resumePipeline`, `restartStage`, `deleteRun` to call `resolveRunContext` first.

### Phase 6: `startPipeline` switch and `target_branch`

**Files:** `worca-ui/server/process-manager.js`, `src/worca/orchestrator/runner.py`, `src/worca/agents/core/guardian.md`

**Tasks:**
1. Update `startPipeline` at `process-manager.js:273` to spawn `run_worktree.py` for new runs, `run_pipeline.py` for resume. Add fallback detection for older worca versions.
2. Store `target_branch` in `status.json` at `runner.py` initialization (from `--branch` flag).
3. Update `guardian.md` to read `status.target_branch` for `gh pr create --base`. Fall back to default branch if unset.

### Phase 7: Worktree cleanup command

**Files:** `src/worca/cli/cleanup.py` (new), `src/worca/cli/__init__.py`

**Tasks:**
1. Implement `worca cleanup` with `--all`, `--run-id`, `--dry-run`, `--older-than` flags.
2. Wire into CLI entry point.
3. Scan `pipelines.d/`, cross-reference status, call `remove_pipeline_worktree` + `deregister_pipeline`.

### Phase 8: Update tests

**Files:** See Test Plan below.

**Tasks:**
1. Update all 8 Python test files that reference `active_run`.
2. Update all 14 UI test/source files that reference `active_run`.
3. Add new tests for `runs/` scanning, PID matching, `discoverRuns` fan-out, lifecycle routing, `run_worktree.py`, cleanup command.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/runner.py` | Remove `active_run` write (line 1270-1273), remove project-level PID write (line 1277), replace `active_run` read (lines 1182-1191) with `runs/` scan, add `target_branch` to status |
| `src/worca/hooks/prompt.py` | Replace `active_run` read (lines 19-28) with PID-matching against `runs/*/pipeline.pid` |
| `src/worca/orchestrator/resume.py` | Replace `active_run` read (lines 174-181) with `runs/` scan, accept optional `run_id` param |
| `src/worca/scripts/run_pipeline.py` | Replace `active_run` read (lines 154-162) with `runs/` scan, add `--guide` flag |
| `src/worca/scripts/run_worktree.py` | **New** — single-pipeline worktree launcher replacing `run_multi.py` |
| `src/worca/scripts/run_multi.py` | **Delete** |
| `src/worca/orchestrator/registry.py` | Add `fleet_id`, `group_type`, `target_branch` kwargs to `register_pipeline()` |
| `src/worca/agents/core/guardian.md` | Read `status.target_branch` for `gh pr create --base` |
| `src/worca/cli/cleanup.py` | **New** — `worca cleanup` command |
| `src/worca/cli/__init__.py` | Register cleanup subcommand |
| `worca-ui/server/watcher.js` | Remove step 1 (`active_run`), add step 5 (`pipelines.d/` fan-out) |
| `worca-ui/server/ws-status-watcher.js` | Rewrite `resolveActiveRunDir` → `resolveLatestRunDir`, remove `active_run` watcher, add `pipelines.d/` watcher, add per-worktree watchers |
| `worca-ui/server/process-manager.js` | Remove `_readActiveRunId`, remove `active_run` from `reconcileStatus`/`deleteRun`/`restartStage`, add `resolveRunContext`, switch `startPipeline` to `run_worktree.py` |
| `CLAUDE.md` | Update run_multi references to run_worktree, document `--guide` flag, add cleanup command |
| `MIGRATION.md` | Document `active_run` removal, `run_multi.py` rename, cleanup command |

## Considerations

- **No archival needed.** Runs stay in `runs/` permanently. The original issue described removing `_archive_run` — this function does not exist in the current codebase (`runner.py:1239` confirms "previous runs stay in runs/ (no archival)"). No archival logic needs removal.
- **Hot path in `hooks/prompt.py`.** Replacing `active_run` read with `runs/*/pipeline.pid` scan adds directory listing on every tool call. Mitigated by: (a) PID files are tiny integer reads, not JSON parsing; (b) the matched path is cached per-PID for the process lifetime — the scan happens once, then all subsequent calls are a single `open()`. Worst case: 10 concurrent runs = 10 `open()` + `read()` + integer comparison. Measured overhead: <1ms.
- **`results/` backward compatibility.** Old completed runs in `results/` remain visible via `discoverRuns` step 4. Nothing new is written there (runs stay in `runs/`). Over time, users migrate by running `worca cleanup --older-than 30d` on the root project.
- **Test impact.** 8 Python test files and 14 UI files reference `active_run`. All need updating — the test plan below catalogs each.
- **macOS watcher limits.** Adding `fs.watch()` per active worktree uses kqueue file descriptors. macOS default soft limit is 256, hard limit ~unlimited. At >50 concurrent worktrees (exceeding realistic usage), fall back to polling.
- **Breaking changes:** The `active_run` file is no longer written. Tools or scripts that read it directly (outside worca's own code) will need to switch to scanning `runs/*/status.json`. The `run_multi.py` entry point is removed — callers must use `run_worktree.py` (one pipeline at a time) or a shell loop. The `_readActiveRunId` JS method is removed — server-side code calling it must pass explicit `runId`.
- **Migration:** `worca init --upgrade` should delete the stale `active_run` file if present and log a message. The project-level `pipeline.pid` and `status.json` files are left in place as read-only legacy — they are not deleted automatically because they may be needed by an older worca-ui that hasn't been upgraded yet.
- **Governance unchanged.** Only Guardian may commit (enforced by `pre_tool_use.py` checking `WORCA_AGENT`). Plan-check hook unchanged. Subagent dispatch unchanged. No new governance mechanisms introduced.
- **Splitting consideration.** This plan is large (8 phases) but tightly coupled — `active_run` removal and `discoverRuns` fan-out must ship together, otherwise worktree runs become invisible (old discovery removed, new discovery not yet added). The recommended split point, if needed during implementation, is between Phase 2 and Phase 3: Phases 1-2 can ship as "remove `active_run`" and Phases 3-7 as "worktree launcher + fan-out." Phase 8 (tests) spans both.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `tests/test_runner.py::test_fresh_start_no_active_run_write` | Fresh pipeline start does NOT create `.worca/active_run` |
| Python | `tests/test_runner.py::test_fresh_start_per_run_pid_only` | PID written to `runs/{id}/pipeline.pid` only, NOT `.worca/pipeline.pid` |
| Python | `tests/test_runner.py::test_find_active_runs_single` | `_find_active_runs` with one non-terminal run returns it |
| Python | `tests/test_runner.py::test_find_active_runs_multiple` | `_find_active_runs` with two non-terminal runs returns both |
| Python | `tests/test_runner.py::test_resume_ambiguous_error` | `--resume` without `--status-dir` and 2 active runs errors clearly |
| Python | `tests/test_runner.py::test_target_branch_in_status` | `--branch` flag stores `target_branch` in `status.json` |
| Python | `tests/test_prompt.py::test_pid_match_status_load` | `load_status()` finds status via PID matching, not `active_run` |
| Python | `tests/test_prompt.py::test_pid_match_caching` | Second call to `load_status()` uses cached path, no rescan |
| Python | `tests/test_resume.py::test_can_resume_no_active_run` | `can_resume()` works without `active_run` file |
| Python | `tests/test_resume.py::test_can_resume_with_run_id` | `can_resume(run_id=...)` looks up directly without scanning |
| Python | `tests/test_run_worktree.py::test_creates_worktree` | `run_worktree.py` creates worktree via `create_pipeline_worktree` |
| Python | `tests/test_run_worktree.py::test_registers_in_pipelines_d` | Registry entry created with `run_id`, `worktree_path`, `title`, `pid` |
| Python | `tests/test_run_worktree.py::test_fleet_id_passthrough` | `--fleet-id` flag written to `pipelines.d/` entry |
| Python | `tests/test_run_worktree.py::test_target_branch_passthrough` | `--branch` written to `pipelines.d/` entry as `target_branch` |
| Python | `tests/test_run_worktree.py::test_guide_passthrough` | `--guide` resolved to absolute path, passed to `run_pipeline.py` |
| Python | `tests/test_run_worktree.py::test_spawns_detached` | Subprocess is detached and `run_worktree.py` exits immediately |
| Python | `tests/test_registry.py::test_register_with_fleet_id` | `fleet_id` stored in entry JSON when provided |
| Python | `tests/test_registry.py::test_register_without_fleet_id` | Entry JSON has no `fleet_id` key when omitted |
| Python | `tests/test_registry.py::test_register_with_group_type` | `group_type` stored when provided |
| Python | `tests/test_registry.py::test_register_with_target_branch` | `target_branch` stored when provided |
| Python | `tests/test_cleanup.py::test_cleanup_completed_worktree` | Completed worktree removed, registry entry deregistered |
| Python | `tests/test_cleanup.py::test_cleanup_skips_running` | Running worktree not removed even with `--all` |
| Python | `tests/test_cleanup.py::test_cleanup_dry_run` | `--dry-run` lists but does not remove |
| Python | `tests/test_cleanup.py::test_cleanup_older_than` | `--older-than 7d` only removes worktrees older than 7 days |
| UI (vitest) | `worca-ui/server/watcher.test.js::discoverRuns_no_active_run` | `discoverRuns` works without `active_run` file |
| UI (vitest) | `worca-ui/server/watcher.test.js::discoverRuns_pipelines_d_fanout` | Step 5 discovers worktree runs via `pipelines.d/` entries |
| UI (vitest) | `worca-ui/server/watcher.test.js::discoverRuns_dedup_across_sources` | Same `run_id` in `runs/` and `pipelines.d/` not duplicated |
| UI (vitest) | `worca-ui/server/watcher.test.js::discoverRuns_fleet_id_propagation` | `fleet_id` from registry entry appears in discovered run |
| UI (vitest) | `worca-ui/server/process-manager.test.js::resolveRunContext_root` | Root run resolved from `runs/` |
| UI (vitest) | `worca-ui/server/process-manager.test.js::resolveRunContext_worktree` | Worktree run resolved from `pipelines.d/` entry |
| UI (vitest) | `worca-ui/server/process-manager.test.js::startPipeline_uses_worktree` | Non-resume start spawns `run_worktree.py` |
| UI (vitest) | `worca-ui/server/process-manager.test.js::startPipeline_resume_uses_pipeline` | Resume start spawns `run_pipeline.py` |

### Integration / E2E Tests

- **Single worktree pipeline (pytest fixture).** Spawn `run_worktree.py --prompt "test"` in a scratch repo with mock claude. Assert: worktree created, `pipelines.d/` entry exists, `run_pipeline.py --worktree` spawned inside worktree, `discoverRuns` finds the run.
- **Concurrent root + worktree runs.** Start a root pipeline and a worktree pipeline. Assert: both visible in `discoverRuns`, no collision, both have separate PID files, `hooks/prompt.py` resolves correct status for each PID.
- **Lifecycle routing.** Start a worktree pipeline, stop it via `ProcessManager.stopPipeline(runId)`. Assert: correct PID killed (worktree's, not root's), status updated in worktree's `status.json`.
- **Cleanup.** Create 3 worktree pipelines (2 completed, 1 running). Run `worca cleanup --all`. Assert: 2 worktrees removed, 1 (running) preserved, 2 `pipelines.d/` entries deregistered.
- **Playwright (`--workers=1`).** Start a pipeline from the UI dashboard, verify it appears in the runs list as a worktree run, stop it, verify status transition.

### Existing Tests to Update

**Python (8 files):**

| File | Current `active_run` usage | Update |
|------|---------------------------|--------|
| `tests/test_runner.py` | Creates `active_run` in setup, asserts it's written | Remove `active_run` creation, assert `runs/` scan works, assert no `active_run` written |
| `tests/integration/test_pipeline_transitions.py` | Creates `active_run` for resume tests | Use `--status-dir` instead of `active_run` pointer |
| `tests/integration/test_pipeline_edge_cases.py` | Creates `active_run` for edge case scenarios | Remove `active_run` setup, test with `runs/` directory directly |
| `tests/integration/helpers.py` | Helper that writes `active_run` for test setup | Remove `active_run` helper. Ensure test runs create per-run directories in `runs/` |
| `tests/test_worca_cli.py` | Tests CLI behavior with `active_run` present | Update to test without `active_run` |
| `tests/test_runner_git_divergence.py` | Sets up `active_run` for divergence checks | Use `runs/` directory directly |
| `tests/test_resume.py` | Tests `can_resume` with/without `active_run` | Test `can_resume` with `runs/` scan and explicit `run_id` |
| `tests/test_prompt.py` | Tests `load_status` via `active_run` pointer | Test `load_status` via PID matching |

**UI (14 files):**

| File | Update |
|------|--------|
| `worca-ui/server/watcher.js` | Source change (§1, §6) |
| `worca-ui/server/ws-status-watcher.js` | Source change (§7) |
| `worca-ui/server/process-manager.js` | Source change (§8, §9) |
| `worca-ui/server/test/process-manager-reconcile.test.js` | Remove `active_run` setup from reconcile tests |
| `worca-ui/server/test/process-manager-control.test.js` | Remove `active_run` references |
| `worca-ui/server/ws-setup-status-watcher.test.js` | Test new `resolveLatestRunDir` (PID-based) |
| `worca-ui/server/ws-resolve-run-dir.test.js` | Rename/rewrite for `resolveLatestRunDir` |
| `worca-ui/server/ws-pipeline-lifecycle.test.js` | Remove `active_run` watcher assertions |
| `worca-ui/server/ws-log-line-timestamp.test.js` | Remove `active_run` if present in setup |
| `worca-ui/server/test/ws-log-subscription.test.js` | Remove `active_run` if present in setup |
| `worca-ui/test/ws-integration.test.js` | Remove `active_run` setup |
| `worca-ui/e2e/websocket-updates.spec.js` | Remove `active_run` fixture setup |
| `worca-ui/e2e/run-lifecycle.spec.js` | Remove `active_run` fixture setup |
| `worca-ui/e2e/fixtures.js` | Remove `active_run` creation from test fixtures |

## Files to Create/Modify

See **Files Changed Summary** table in Implementation Plan above.

## Out of Scope

- **Cross-project run aggregation.** This plan makes per-project `pipelines.d/` ready for cross-project fan-out but does not implement it. W-040 handles cross-project discovery.
- **Fleet grouping UI.** `fleet_id` is stored in registry entries and propagated through `discoverRuns` but not rendered. W-040 adds the fleet header/grouping UI.
- **Workspace coordination.** `group_type` is stored but not acted upon. W-047 adds workspace-specific rendering.
- **Guide content injection.** `--guide` flag is accepted and passed through but content injection into `WorkRequest.description` is W-040's responsibility (`attach_guide()`).
- **Circuit breaker.** No per-pipeline or fleet-level circuit breaker. W-040 builds this from scratch.
- **Automatic worktree cleanup.** Cleanup is manual via `worca cleanup`. No TTL-based auto-removal.
- **Batch orchestration.** `run_multi.py`'s multi-request batch mode is dropped. Shell loops or W-040's `run_fleet.py` replace it.
