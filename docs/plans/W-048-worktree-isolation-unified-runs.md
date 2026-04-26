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

  **`run_batch.py` is also deleted.** The codebase currently has two batch-style entry points: `run_multi.py` (parallel worktrees, intra-repo) and `run_batch.py` (sequential queue with per-pipeline circuit breaker, in-place — uses `worca.orchestrator.batch.run_batch`). Both serve the "process multiple work requests" need that `run_worktree.py` (one-at-a-time, called in a loop) and W-040's `run_fleet.py` (parallel across repos) cover better. Delete:
  - `src/worca/scripts/run_batch.py`
  - `src/worca/orchestrator/batch.py` — but only after confirming `CircuitBreakerError` is no longer imported elsewhere; if it is, move the exception class to `error_classifier.py` first.
  - Any settings keys exclusive to `run_batch.py` (e.g., `worca.batch.max_failures` if present).
  - Tests under `tests/test_batch*.py` if they exist.

  Pre-deletion check (run during Phase 3): `grep -rn "from worca.orchestrator.batch\|run_batch" src/ tests/ worca-ui/` — every hit must be in code that's also being deleted, or the deletion is blocked.

### 4. `run_pipeline.py` — Wire `--guide` Flag

- **Current state:** `run_pipeline.py:19-49` has flags for `--prompt`, `--source`, `--plan`, `--branch`, `--worktree`, etc. No `--guide` flag.
- **Obstacle:** W-040's shared reference-context mechanism requires `--guide` to be accepted by `run_pipeline.py` so that `run_worktree.py` (and later `run_fleet.py`) can pass it through.
- **Resolution:** Add `--guide` (repeatable) to `run_pipeline.py`'s argument parser. After `WorkRequest` normalization, call the `attach_guide()` helper (implemented in W-040 Phase 1, `work_request.py`).

  **Behavior in the W-048-only window (before W-040 ships):**

  Silent acceptance is forbidden — a user passing `--guide migration.md` would believe the guide is honored when it isn't. W-048 detects whether `attach_guide()` is importable from `worca.orchestrator.work_request` at startup:

  - **If `attach_guide` is available** (W-040 has shipped): call it, inject content normally.
  - **If `attach_guide` is NOT available** (W-048 standalone): emit `argparse.ArgumentError` with message:

    ```
    --guide requires worca-cc with attach_guide() (W-040 / #101). The flag was
    accepted by W-048 plumbing but content injection is not yet implemented in
    this version. Upgrade worca-cc to a version that ships W-040, or remove
    --guide from your invocation.
    ```

    The error fires at argparse-parse time so dispatch never starts. This is non-negotiable: we do not want runs that silently ignore an authoritative guide.

  - **Migration path off this gate:** Once W-040 ships, `attach_guide` is always importable and the error becomes unreachable. Delete the import-probe + error in W-040 Phase 1 task 3 (which also wires `--guide` into `run_pipeline.py`).

  This ensures `run_worktree.py` can pass `--guide` through to `run_pipeline.py` from day one (so the CLI surface stabilizes), without ever silently dropping guide content.

### 5. Extend `pipelines.d/` Registry

- **Current state:** `registry.py:48-66` registers pipelines with `run_id`, `worktree_path`, `title`, `pid`, `status`, timestamps. No fields for fleet grouping, target branch, or group type.
- **Obstacle:** W-040 needs `fleet_id`, W-047 needs `workspace_id` + `group_type`, and both need `target_branch`. These must be optional to maintain backward compatibility, AND the fleet/workspace identifiers must be **distinct fields** so consumers don't have to inspect a sibling field to disambiguate.
- **Resolution:** Extend `register_pipeline()` with keyword-only arguments:

  ```python
  def register_pipeline(
      run_id, worktree_path, title, pid,
      base=_DEFAULT_BASE,
      *,
      fleet_id=None,        # W-040: fleet grouping (mutually exclusive with workspace_id)
      workspace_id=None,    # W-047: workspace grouping (mutually exclusive with fleet_id)
      group_type=None,      # W-040/W-047: "fleet" | "workspace" | None — discriminator for UI rendering
      target_branch=None,   # PR base branch (gh pr create --base)
  ):
  ```

  All new fields are optional and omitted from the JSON when `None`. Existing callers (`run_multi.py` → `run_worktree.py`, `runner.py:1281-1285`) continue to work unchanged. `discoverRuns` includes these fields in run metadata when present.

  **Mutual-exclusion enforcement at registration time:** `register_pipeline()` raises `ValueError("fleet_id and workspace_id are mutually exclusive")` when both are non-`None`. The check fires before any file write — so an invalid registration never lands on disk. This guard is added in W-048 (this plan), not deferred to W-040 or W-047, even though the W-048-only window has no callers that pass either ID. Adding the guard here:

  - Locks the contract before downstream plans depend on it.
  - Avoids three plans each thinking they should add it (W-040 Phase 2 task 5 and W-047 Phase 1 task 5 reference this guard — they only **verify** it, they do not introduce it).
  - Avoids signature churn: all four kw-only fields are introduced once, no later plan needs to extend the signature again.

  **Authoritative rule for grouping fields (binding on W-040, W-047, and all UI consumers):**

  | Field | Set when | Mutually exclusive with | UI uses for |
  |-------|----------|-------------------------|-------------|
  | `fleet_id` | Child of a fleet (W-040 `run_fleet.py`) | `workspace_id` | Fleet header grouping (W-040 §13.2) |
  | `workspace_id` | Child of a workspace (W-047 `run_workspace.py`) | `fleet_id` | Workspace header + tier grouping (W-047 §10.4) |
  | `group_type` | Always set when either ID is set; values: `"fleet"` or `"workspace"` | n/a | Pure discriminator — never inspect the IDs to determine type |

  Code that filters by membership uses the explicit ID field. Code that branches on rendering style uses `group_type`. **Never derive type from `fleet_id != null`** — that pattern is forbidden because it would silently include workspace runs once W-047 ships (an earlier iteration of these plans overloaded `fleet_id` for workspaces; this rule replaces that approach).

  **Registry location:** `pipelines.d/` is always per-project at `<project>/.worca/multi/pipelines.d/`. For cross-project discovery (W-040 fleet, W-047 workspace), the higher-level orchestrator (`run_fleet.py`, `run_workspace.py`) maintains a manifest with child `project_path` + `run_id` pairs.

  **Cross-project run aggregation — explicit binding rule for the UI:**

  Fleet/workspace **grouping in the UI requires global mode** (`worca-ui` started without `--project`). In global mode, `discoverRuns` is invoked once per registered project in `~/.worca/projects.d/` and the results are merged into a single `state.runs` map; group rendering (W-040 §13.2 fleet header, W-047 §10.4 tier sub-grouping) operates on that merged map.

  - **Global mode (`pnpm worca:ui` with no `--project`):** All projects' `pipelines.d/` are scanned. A fleet whose children land in 5 different projects appears as one group with 5 child rows.
  - **Single-project mode (`pnpm worca:ui --project /path`):** Only the targeted project's `pipelines.d/` is scanned. A fleet/workspace child whose `project_path` matches the targeted project appears as a standalone-looking run; siblings in other projects are invisible. The UI **detects this** and surfaces a small inline notice on the fleet/workspace dashboard view: *"This fleet has children in other projects. Switch to global mode to see all members."*
  - **No cross-project pointer-following from inside `discoverRuns`.** The plan deliberately keeps `discoverRuns` per-project — adding cross-project I/O inside it (reading `~/.worca/fleet-runs/*.json` then chasing `project_path` to load each child's `status.json`) would couple per-project discovery to a global filesystem and complicate caching/invalidation. Instead, global mode loops over projects at the caller level (existing W-032 pattern) and the merge happens in the WS broadcaster's `runs-list` payload.
  - **W-040 §13.2 and W-047 §10.4 must reference this rule** — fleet/workspace grouping is a global-mode-only feature; single-project users see partial groups with the explanatory notice.

  This plan adds the per-project step 5 fan-out (§6) but does not introduce cross-project aggregation. W-040 wires fleet headers on top of the global-mode merge. W-047 wires workspace tiers on top of fleet headers.

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
              workspace_id: reg.workspace_id || null,
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

### 6.5 Retire `MultiWatcher`, Decide `multi-dashboard.js` Fate, Migrate Clients

- **Current state:** `worca-ui/server/multi-watcher.js` (237 lines) watches `.worca/multi/pipelines.d/` independently of `discoverRuns` and broadcasts `pipeline-status-changed` events with payload `{ project, runId, status, stage, title, worktree_path, started_at, pid }`. Frontend handler at `worca-ui/app/main.js:726` writes these into `state.pipelines`, which `multiPipelineDashboardView` (`worca-ui/app/views/multi-dashboard.js:150-190`) renders as a grid of compact `pipelineCardView` cards (stage-dot progress, elapsed time, quick actions). With §6's `discoverRuns` fan-out, every change to `pipelines.d/` is already reflected in the next `runs-list` broadcast. Keeping both produces dual broadcasts on every status change — the very dual-source-of-truth problem this plan exists to fix.
- **Obstacle:** A naive removal orphans the frontend `pipeline-status-changed` listener, the `state.pipelines` map, the entire `multi-dashboard.js` view, and any tests that subscribe to those. A naive keep duplicates broadcasts and recreates the bug.
- **Resolution:** Delete `MultiWatcher`, derive `state.pipelines` from `state.runs`, repurpose `multi-dashboard.js` as a thin compact-mode renderer.

  **Data-flow before vs after:**

  ```
  BEFORE (dual sources):
    pipelines.d/*.json --[MultiWatcher]--> pipeline-status-changed --[main.js:726]--> state.pipelines --> multiPipelineDashboardView
    runs/*/status.json --[ws-status-watcher]--> runs-list ----------> state.runs ------> dashboardView (run-card.js)

  AFTER (single source):
    pipelines.d/*.json + runs/*/status.json --[discoverRuns step 5]--> runs-list --> state.runs
                                                                                         |
                                                            +----------------------------+
                                                            |                            |
                                                            v                            v
                                                  dashboardView                    multiPipelineDashboardView
                                                  (full run cards)                 (compact, when is_worktree_run=true)
  ```

  **Server-side:**
  - Delete `worca-ui/server/multi-watcher.js` and `worca-ui/server/multi-watcher.test.js`.
  - Remove every `MultiWatcher` instantiation site (likely in `worca-ui/server/ws-modular.js` — verify with grep before removal).
  - **Remove all five `pipeline-*` message types from `worca-ui/app/protocol.js` `MESSAGE_TYPES` (lines 33-37)**, not just `pipeline-status-changed`. The full set:

    | Removed | Direction | Replacement after W-048 |
    |---------|-----------|-------------------------|
    | `list-pipelines` | client → server request | `runs-list` (already filtered by `is_worktree_run` + `group_type` client-side via `selectParallelPipelines`) |
    | `subscribe-pipeline` | client → server request | per-pipeline log subscription folds into existing `subscribe-log` keyed by `run_id` (worktree run is just a run with `is_worktree_run: true`) |
    | `unsubscribe-pipeline` | client → server request | mirrors above — `unsubscribe-log` |
    | `pipeline-status-changed` | server → client event | every `pipelines.d/` change triggers `runs-list` via `discoverRuns` step 5 (§6) |
    | `pipelines-list` | server → client response/event | `runs-list` carries the merged set |

  - **Remove all four request handlers from `worca-ui/server/ws-message-router.js`:** `list-pipelines` (line 855), `subscribe-pipeline` (line 864), `unsubscribe-pipeline` (line 887), and any `pipelines-list` emit sites. Audit with `grep -rn "list-pipelines\|subscribe-pipeline\|unsubscribe-pipeline\|pipelines-list\|pipeline-status-changed" worca-ui/` before removal — every hit must be in code being deleted in this phase, or it's a hidden client (e.g., a stale test) that needs separate handling.
  - **Verify no `WatcherSet.promotePipeline` / `demotePipeline` references remain** — those existed only to support per-pipeline log subscription via `MultiWatcher`.

  **Client-side state migration:**
  - Delete the `ws.on('pipeline-status-changed', ...)` handler at `worca-ui/app/main.js:726`.
  - Delete the `state.pipelines` map. Add a derived selector `selectParallelPipelines(state)` that filters `Object.values(state.runs)` for entries where `is_worktree_run === true` and shapes them to the `pipelineCardView` contract (see field map below). Selector is memoized on `state.runs` reference.
  - Field map for the compact card (preserved exactly to avoid `multiPipelineDashboardView` template churn):

    | `pipelineCardView` field | Source in `state.runs[id]` (post-W-048) |
    |---|---|
    | `run_id` | `id` |
    | `title` | `work_request?.title` |
    | `status` | `pipeline_status` (already present) |
    | `stage` | `stage` (already present in `status.json`; verified in `runner.py`) |
    | `started_at` | `started_at` |
    | `worktree_path` | `worktree_worca_dir` (parent of `.worca/`) — derived |
    | `pid` | `pid` (already present) |

  **`multi-dashboard.js` fate — KEEP, repurpose as compact-mode renderer:**
  - The view file survives; `multiPipelineDashboardView` is still useful for at-a-glance multi-run dashboards (active worktree fleets, parallel runs).
  - Caller (`worca-ui/app/main.js`) switches from `multiPipelineDashboardView(state.pipelines)` to `multiPipelineDashboardView(selectParallelPipelines(state))`.
  - W-040 §13.2 fleet grouping renders fleet headers + child cards using this same compact `pipelineCardView`.
  - W-047 §10.4 tier rendering also uses `pipelineCardView` for child rows.
  - **No template change to `pipelineCardView`** required for this plan — only the upstream selector changes.

  **Stage-dot data preservation:** `pipelineCardView` (`multi-dashboard.js:14-24`) shows stage progress via `STAGES.indexOf(currentStage)`. The `stage` field is already written to `runs/{id}/status.json` by `runner.py` and surfaced through `discoverRuns`. Verified by reading `state.runs[id].stage` in existing dashboard rendering paths. Add a vitest covering this exactly: `selectParallelPipelines` against a fixture run-list where one run has `is_worktree_run: true, stage: "implement"` → asserts `pipelineCardView` renders `implement` dot as active.

  **Test cleanup:**
  - Remove `multi-watcher.test.js`. Move stale-entry reconciliation coverage into `watcher.test.js` against the new step 5 of `discoverRuns`.
  - Add `worca-ui/app/views/multi-dashboard.test.js` extension: render with selector output instead of mock `state.pipelines`. Coverage matrix: zero worktree runs (renders nothing), one running, mixed running/paused/completed (paused appears next to running, completed in `<sl-details>`), stage progression visible via stage-dot active state.
  - Add `worca-ui/app/select-parallel-pipelines.test.js` (new): pure unit test for the selector — filter logic, field mapping, memoization stability.

  **Migration safety:**
  - Ship server-side delete, selector introduction, `multi-dashboard.js` caller switch, and §6 fan-out in the **same release**. A split release would either drop status updates (delete first) or duplicate them (keep first).
  - Add a one-time browser-cache-busting bump to the UI bundle version (`worca-ui/package.json` micro bump) so cached clients reload and pick up the new protocol allowlist; otherwise stale clients will log a "received unknown event" warning until they refresh.

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

- **Naming clarification (important for W-040 compatibility):** In this plan, `target_branch` is the **base branch** — the branch the worktree is forked FROM and the branch the PR targets via `gh pr create --base`. Both meanings collapse into one field because a worktree run forked from `dev` should, by default, create a PR back into `dev`.

  W-040 introduces a separate `--branch <template>` concept that controls the **head branch name** (the per-child branch that gets pushed and referenced in `gh pr create --head`). These are two different concepts with confusingly similar names:

  | Concept | W-048 field | W-040 field | gh pr create flag |
  |---------|-------------|-------------|-------------------|
  | Where the worktree forks from | `target_branch` (= base) | inherited from W-048 | `--base` |
  | New branch the agent commits to | derived from slug | `--branch <template>` | `--head` |

  W-040 must explicitly distinguish "fleet base" (passed as `--base` to `run_worktree.py`, becomes `target_branch`) from "head branch template" (becomes the new branch name in each child worktree). This plan does not rename `target_branch` to avoid churn, but W-040 should refer to it as "the PR base branch" rather than "the target branch" in user-facing docs to avoid confusion with the `--branch` template flag.

### 11. `discoverRuns` — Fix `results/` Active Flag

- **Current state:** `watcher.js:112-149` scans `results/` and derives `active` from `pipeline_status`. The logic at line 127/139 is: `!isTerminal(status) && status.pipeline_status === 'running'`. This is correct — `results/` entries will almost always be terminal. But if a run was moved to `results/` while still running (a bug in older versions), the flag correctly reflects that.
- **Obstacle:** No actual bug — the existing logic is already correct.
- **Resolution:** No change needed. Issue #82's original description listed this as step 1, but the code already handles it correctly. Verified at `watcher.js:127` and `watcher.js:139`.

### 11.5 Reconcile Orphan Group Memberships

- **Current state:** `registry.py:reconcile_stale()` (line 138) checks PID liveness for `running` pipelines and marks dead ones `failed`. There is no equivalent reconciler for the **grouping fields** added in §5.
- **Obstacle:** Once W-040 / W-047 ship, two new failure modes appear:
  1. A fleet manifest at `~/.worca/fleet-runs/<id>.json` is deleted (by `worca cleanup --fleet-id`, manual `rm`, or a crashed cleanup) while child `pipelines.d/` entries still carry that `fleet_id`. The children become "ghost members" of a fleet that no longer exists — UI groups them under a header with no manifest, lifecycle commands fail at the manifest read.
  2. Same for `workspace_id` once W-047 ships and the workspace run directory under `{workspace_root}/.worca/workspace-runs/<run_id>/` is removed.
- **Resolution:** Extend `registry.py` with `reconcile_orphan_groups(base=_DEFAULT_BASE)`. Behavior:

  ```python
  def reconcile_orphan_groups(base=_DEFAULT_BASE):
      """Strip fleet_id/workspace_id from pipelines.d/ entries whose parent
      manifest no longer exists. Returns list of (run_id, dropped_field) tuples.

      A child whose fleet_id/workspace_id has no matching manifest is downgraded
      to a standalone run rather than deregistered — the child pipeline itself
      is still valid, only the grouping pointer is dead.
      """
      # For each entry with fleet_id: check ~/.worca/fleet-runs/<fleet_id>.json
      # For each entry with workspace_id: check ~/.worca/workspace-runs/<wid>.json
      # If manifest missing: rewrite entry without the dead ID, log "downgraded
      # run X from fleet:Y to standalone (manifest missing)".
  ```

  **W-048 ships the function but only the no-op variant** — the function exists, signature is final, but only handles the empty case (no IDs to check, since W-048 doesn't write fleet/workspace IDs). W-040 / W-047 wire the actual lookups into their respective manifest paths via the same function. Adding the function shape now avoids a third-time signature churn later.

  **Where it's called:** Once per UI server startup, and on each `pipelines.d/` directory-watcher refresh (debounced — same pathway as `reconcile_stale`). UI server logs each downgrade at INFO level so users see what's happening on cold-start after a manual cleanup.

  **What it never does:** It does not deregister children. Removing a child pipeline's registry entry would lose the run from the History view. Only the dead group ID is stripped — `group_type` is also cleared in the same write.

  **What it does NOT cover (deliberately):** A live manifest pointing at a `pipelines.d/` entry that doesn't exist. That direction is the manifest's responsibility to detect (W-040 / W-047 manifest readers can flag missing children) and is reported in the UI as part of the children-grid render, not via this reconciler.

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

  **Extensibility for W-040 / W-047 cleanup.** `worca cleanup` is the single user entry point for all worca-managed artifact removal. W-040 will add `~/.worca/fleet-runs/<fleet_id>.json` manifests and W-047 will add `{workspace_root}/.worca/workspace-runs/{run_id}/` directories — both need cleanup paths. Design the cleanup command from the start to support a pluggable artifact-source model:

  ```python
  # src/worca/cli/cleanup.py
  CLEANUP_SOURCES = [
      WorktreeSource(),     # W-048 — pipelines.d/ + git worktree
      # FleetSource(),      # W-040 — adds ~/.worca/fleet-runs/
      # WorkspaceSource(),  # W-047 — adds {ws_root}/.worca/workspace-runs/
  ]
  ```

  Each source implements `list_eligible(filters)` and `remove(entry)`. New flags added by future plans:
  - `worca cleanup --fleet-id <id>` — W-040 hooks in to remove a fleet manifest plus all its child worktrees (when they are completed).
  - `worca cleanup --workspace-id <id>` — W-047 hooks in to remove a workspace run directory plus integration-env worktrees.
  - `worca cleanup --older-than 7d` — already in W-048; future sources reuse the same age filter.

  W-048 ships `WorktreeSource` only; the source-list pattern keeps the CLI surface stable as W-040/W-047 add their own sources without rewriting the command.

### 13. UI Surface

W-048 changes how runs are isolated and discovered. Most of that is invisible plumbing — but four user-facing UX questions surface from it: *how do I see that a run is in a worktree*, *why doesn't my working tree get dirty anymore*, *how do I set the PR base branch from the UI*, and *how do I clean up old worktrees without dropping to the CLI*. This section answers each.

#### 13.1 Worktree Run Indicator

- **Where it appears:** Run cards in `worca-ui/app/views/run-list.js` and `worca-ui/app/views/run-card.js`. Also in the `multi-dashboard.js` global runs list.
- **Design:** A small inline icon — `<sl-icon name="folder-symlink">` — placed next to the run title when `is_worktree_run === true`. On hover (native `title` attribute), shows: "Isolated worktree at `<worktree_path>`". No badge, no extra row — keep the existing run-card density.
- **Why an icon, not a badge:** Worktree-vs-root is a structural property, not a status. The badge color language (`docs/badge-color-language.md`) reserves badges for status semantics (active / done / caution / failed). Adding a sixth axis of meaning to badges would dilute the language.
- **Detail view:** `app/views/run-detail.js` adds a row in the run metadata block: `Worktree: <path>` (only shown when `is_worktree_run`). Path is selectable text + a copy button (`<sl-copy-button>`).

#### 13.2 "Start Run" Page — Worktree Awareness and Pipeline Block Removal

- **Current state:** New runs are launched from the inline `worca-ui/app/views/new-run.js` page (485 lines, not a dialog). The page collects prompt + source + plan + template + branch + msize + mloops and calls `POST /api/(projects/:id/)runs` which now spawns `run_worktree.py` instead of `run_pipeline.py`. The page currently blocks new submissions when any pipeline is active via `hasActivePipeline()` (`new-run.js:204-208`) and shows a `new-run-info` warning panel ("Pipeline already running. Parallel pipelines on the same project are not fully supported yet.") at lines 293-300.
- **Change 1 — Remove the "Pipeline already running" block:** With worktree isolation (this plan), concurrent pipelines no longer collide on the working tree, git index, or branch. The block is wrong post-W-048. Delete the `pipelineRunning` warning panel (`new-run.js:293-300`) and the form-disable class (`new-run-form-disabled` at line 304). Keep `hasActivePipeline` for any other callers but remove its use in this view. Update `new-run-parallel-block.test.js` to assert the warning is **not** rendered when an active pipeline exists. **This change ships in Phase 6 alongside the `startPipeline` switch to `run_worktree.py`** — the two must land together to avoid leaving the warning visible after isolation works.
- **Change 2 — Worktree info banner:** Add a one-line info banner at the top of the form:
  > Runs execute in an isolated git worktree. Your current working tree isn't modified. Manage existing worktrees in the **Worktrees** view.
  Render via `<sl-alert variant="primary" open closable>`. Dismissable per-user via `localStorage.setItem('worca.worktree-banner-dismissed', '1')` so power users see it once. The banner replaces the deleted "Pipeline already running" panel — the existing visual real estate at the top of the page is reused.
- **New input — PR base branch:** Add a `<sl-input>` field labeled "PR base branch (optional)" with placeholder "main" and helper text "Branch the worktree forks from and the PR will target. Defaults to repo's default branch." The value submits as `branch` in the POST body, which `run_worktree.py` consumes via `--branch` (= W-048 `target_branch`, see §10 naming clarification). Existing "Branch" input under Advanced Options retains its meaning (use existing branch instead of creating a new one) — the new field controls fork-from / PR-target, while the existing field controls head-branch behavior. Render the new field at the top of Advanced Options for visibility; both have non-overlapping semantics.
- **Validation:** Client-side regex `^[a-zA-Z0-9._/-]+$`; server-side check that the branch exists in `git branch --list` before launching (the existing process-manager dispatch should reject early with a clear error toast rather than letting the worktree creation fail in the spawned subprocess).

#### 13.3 Worktree Manager View

- **Why:** `worca cleanup` is CLI-only; UI users will accumulate worktrees indefinitely without ever knowing.
- **New view file:** `worca-ui/app/views/worktrees.js`. Accessible via a sidebar entry "Worktrees" (see §13.7 sidebar layout).
- **Sidebar entry:** Conditional on `pipelines.d/` non-empty. **Includes a count badge** (`<sl-badge variant="neutral" pill>` with the worktree count) — matches the existing convention of badging Pipeline > Running, History, and Beads entries (see `sidebar.js:163-191`). When the count exceeds disk-pressure threshold (default: total > 2 GB across worktrees), the badge variant flips to `warning` to nudge cleanup. Threshold configurable via `worca.ui.worktree_disk_warning_bytes`.
- **Layout:** Reuses the standard `dashboard.js` table pattern: rows = worktree entries from `GET /api/worktrees`, columns = [Run title, Status badge, Branch, Worktree path, Disk usage, Age, Group (standalone / fleet:&lt;short&gt; / workspace:&lt;short&gt;), Actions].
- **Status badge column** uses the existing pipeline status badge mapping (no new colors).
- **Group column** displays the worktree's parent: `—` for standalone runs, `fleet:f_xxxx` (linked to fleet detail) when `fleet_id` is set, `workspace:ws_xxxx` (linked to workspace detail) when `workspace_id` is set. Reads from the augmented `discoverRuns` payload (§5 + §6). Helps users understand cleanup impact ("removing this kills the fleet's resume path").
- **Actions column:**
  - "Open" (`<sl-button size="small">`) → opens the existing run detail view for that worktree's run.
  - "Cleanup" (`<sl-button size="small" variant="danger" outline>`) — verb is **"Cleanup"** to match `worca cleanup` CLI and to align with W-040 §13.3 / W-047 §10.5 (single verb across all artifact removal surfaces). Opens a confirmation `<sl-dialog>` then calls `DELETE /api/worktrees/:run_id` which invokes the same `WorktreeSource.remove(entry)` helper used by `worca cleanup`.
  - **Disabled with tooltip** when the run is still active: "Cannot cleanup a running worktree".
  - **Resume-aware warning:** Even for completed/failed runs, if the run is in a non-terminal-but-resumable state (`pipeline_status` in `failed`, `paused`, `cancelled`), the confirmation dialog includes the warning: "Removing this worktree prevents resuming the run. The run row stays in History but cannot continue." Confirmation requires checking an explicit "I understand resume will be unavailable" `<sl-checkbox>` for resumable runs. For `completed` runs, the standard one-step confirmation applies.
  - **Group warning:** When the worktree is part of a halted/incomplete fleet (`group_type == "fleet"` and fleet manifest status is `halted` or `failed`) or workspace (`group_type == "workspace"` and workspace status is `halted`, `failed`, `integration_failed`, or any non-terminal tier in progress), the confirmation dialog adds: "This worktree belongs to **&lt;group&gt;** — removing it will block the group's `--resume` for this child." Same explicit checkbox required.
- **Bulk actions:** Above the table, a `<sl-button>` "Cleanup all completed" (warns in a confirm dialog with the count and total disk to be freed; **explicitly groups affected worktrees by parent**: "5 standalone, 3 from fleet f_xxxx, 2 from workspace ws_yyyy" with each group's resume impact spelled out) and a `<sl-input type="text">` filter (matches branch / title / group substring).
- **Disk surface:** Header strip shows "Total worktree disk: 2.3 GB across 14 worktrees · 1.8 GB cleanable". Cleanable = sum of disk usage of `completed` worktrees only (not `failed`/`paused`/`cancelled`, since those are resumable). A second sub-line shows "Resumable: 0.5 GB across 4 worktrees (cleanup blocks resume)" when applicable.
- **REST endpoints (new in `worca-ui/server/worktrees-routes.js`):**
  - `GET /api/worktrees` — returns `[{run_id, title, branch, worktree_path, disk_bytes, age_seconds, status, removable, fleet_id, workspace_id, group_type, group_status, resumable}]` by reading `pipelines.d/`, joining against fleet/workspace manifests (when `fleet_id`/`workspace_id` present), and shelling out to `du -sb <path>` per entry (cached for 30s to avoid disk hammering). `resumable` is `true` for non-terminal-but-recoverable statuses (`failed`, `paused`, `cancelled`) and `false` for `completed` and `running`.
  - `DELETE /api/worktrees/:run_id` — wraps `WorktreeSource.remove`. Returns 409 if running. Accepts `?force=1` query param to skip server-side group-impact warnings (UI sets this only after the user confirmed the warning).
- **Empty state:** When `pipelines.d/` is empty, the view shows a centered illustration + caption "No worktrees yet. Start a run to create one." This is the only empty state W-048 introduces.

#### 13.4 Status Vocabulary — No New Badge Colors

W-048 introduces no new pipeline-level status values. The existing badge mapping (`success` / `primary` / `warning` / `danger` / `neutral`) covers everything. This is intentional: W-048 is plumbing, not new lifecycle states. New states (`halted`, `planning`, `integration_testing`, etc.) ship in W-040 / W-047.

**Binding contract for W-040 / W-047 — every new status value must extend three call sites:**

Each plan that introduces new pipeline / fleet / workspace status values **must** extend all three of the following in the same phase that introduces the status, so the value flows correctly from server through state through render:

1. **`worca-ui/app/utils/state-actions.js` — `STATES` array and `ACTION_MATRIX`.** Determines which lifecycle buttons (Stop/Pause/Resume/Cancel/Archive/Delete/Learn) are enabled for the new status. A status not in `STATES` is treated as unknown; an action not in `ACTION_MATRIX[<action>][<status>]` returns `false` from `actionAllowed()`, hiding the button. Every new status must explicitly pick which actions are allowed — defaulting to none silently disables features.

2. **`worca-ui/app/views/multi-dashboard.js` — `pipelineStatusClass()` switch (line 38).** Maps the status to a CSS class for the run-card border-left. New statuses falling through to `pipeline-unknown` show no border accent — visually indistinguishable from an unstarted card.

3. **`worca-ui/app/styles.css` — `.pipeline-<status>` class with `border-left-color`.** Define the actual color from existing CSS variables (`--status-running`, `--status-paused`, etc.) — do NOT introduce new color variables. Match the badge variant from W-040 §13.7 / W-047 §10.7 (e.g., `halted` → `warning` → `--status-paused`).

W-040 and W-047 each include explicit phase tasks that touch all three files. A reviewer must reject any new-status PR that misses one of these three call sites — the symptom is "button doesn't appear" or "card looks unstarted" with no obvious cause.

#### 13.5 UI Test Coverage

| File | Coverage |
|------|----------|
| `worca-ui/app/views/run-card.test.js` (existing) | Worktree indicator icon renders when `is_worktree_run === true`; hidden otherwise. |
| `worca-ui/app/views/run-detail.test.js` (existing or new) | "Worktree" metadata row appears with path + copy button when worktree run. |
| `worca-ui/app/views/new-run.test.js` (existing) | (a) "Pipeline already running" warning panel is **not** rendered after the W-048 isolation switch (replaces the pre-W-048 assertion in `new-run-parallel-block.test.js`); (b) form is **not** disabled when `state.runs` has active runs; (c) PR base branch input present; submits `branch` field in POST body; (d) worktree info banner renders, is dismissable, stays dismissed via localStorage. |
| `worca-ui/app/views/new-run-parallel-block.test.js` (existing) | Replace pre-W-048 assertion (warning shown when active pipeline) with post-W-048 assertion (warning never shown — concurrent runs are safe). Keep the file so the regression is documented; do not delete. |
| `worca-ui/app/views/worktrees.test.js` (new) | Render rows from `GET /api/worktrees`; cleanup button disabled when running; bulk cleanup confirmation lists per-group impact; filter input narrows rows; resume-aware confirmation requires explicit checkbox for resumable runs; group column links to fleet/workspace detail when set. |
| `worca-ui/server/worktrees-routes.test.js` (new) | `GET` returns enriched entries with `fleet_id`/`workspace_id`/`group_type`/`group_status`/`resumable`; `DELETE` returns 409 for running run; `DELETE` returns 412 (Precondition Failed) without `?force=1` for resumable runs or fleet/workspace members; calls `WorktreeSource.remove` for completed run. |
| `worca-ui/app/views/sidebar.test.js` (existing) | "Worktrees" nav entry hidden when `pipelines.d/` empty, shown when non-empty; count badge variant flips to `warning` past disk threshold. |
| `worca-ui/app/views/multi-dashboard.test.js` (existing) | Worktree indicator icon renders in compact pipeline cards; data sourced from `selectParallelPipelines(state)` (post-MultiWatcher migration); stage-dot active state derives from `run.stage`; mixed running/paused/completed split renders correctly. |
| `worca-ui/app/select-parallel-pipelines.test.js` (new) | Pure unit test for the selector: filters on `is_worktree_run === true`; field map correct; memoization stable across same-reference state.runs; returns `{}` when no worktree runs. |
| `worca-ui/server/watcher.test.js` (existing or new) | (Inherits from §6.5) Stale-entry reconciliation moved here; concurrent `runs/` + `pipelines.d/` discovery; dedup via `seenIds`; `workspace_id`/`fleet_id`/`group_type` propagation. |

#### 13.6 Files Added/Touched for §13

| File | Change |
|------|--------|
| `worca-ui/app/views/worktrees.js` | **New** — worktree manager view (resume-aware Cleanup, group column, bulk cleanup with grouped impact) |
| `worca-ui/app/views/run-card.js` | Add worktree indicator icon |
| `worca-ui/app/views/run-detail.js` | Add worktree metadata row |
| `worca-ui/app/views/new-run.js` | Remove "Pipeline already running" warning + form-disable; add worktree info banner; add PR base branch input |
| `worca-ui/app/views/sidebar.js` | Conditional "Worktrees" nav entry **with count badge** (variant flips on disk-pressure threshold); §13.7 sets the broader sidebar layout that W-040 / W-047 extend |
| `worca-ui/app/views/multi-dashboard.js` | Caller switch: `state.pipelines` → `selectParallelPipelines(state)` (data source migration only; `pipelineCardView` template unchanged) |
| `worca-ui/app/select-parallel-pipelines.js` | **New** — derived selector replacing the deleted `state.pipelines` map |
| `worca-ui/app/main.js` | Remove `state.pipelines` map; remove `pipeline-status-changed` handler at line 726; wire selector into `multiPipelineDashboardView` call sites |
| `worca-ui/server/worktrees-routes.js` | **New** — REST endpoints for worktree management (joins fleet/workspace manifests for group context) |
| `worca-ui/app/styles.css` | New CSS for the worktrees view (table density, disk-usage strip, group column tag styles) |
| Tests above | **New / extended** |

#### 13.7 Sidebar Layout — Foundation for Multi-Repo Entries

W-048 sets the convention W-040 and W-047 must follow. The existing sidebar (`sidebar.js:161-211`) has flat sections only; introducing nested nav for two siblings (Fleets + Workspaces) would break the convention. Establish the layout once here so subsequent plans extend it without re-deciding:

- **Pipeline section** — flat siblings, conditionally visible:
  - `Running` (badge: active count) — existing
  - `History` (badge: total count) — existing
  - `Worktrees` (badge: worktree count, see §13.3) — added by this plan, hidden when `pipelines.d/` empty
  - `Fleets` (badge: active fleet count) — added by W-040, hidden when no fleets
  - `Workspaces` (badge: active workspace count) — added by W-047, hidden when no workspaces

- **No nesting.** Even with all five entries visible, flat siblings preserve the existing visual rhythm. W-047's earlier "Multi-Repo > Workspaces" nesting proposal is **superseded** by this layout.

- **"+ New Pipeline" CTA evolution:** Currently a single button at sidebar top (`sidebar.js:153-158`). When W-040 ships, convert into a `<sl-dropdown>` button with options:
  - "+ New Pipeline" (default, existing flow → `new-run.js`)
  - "+ New Fleet" (W-040 → `fleet-launcher.js`)
  - "+ New Workspace" (W-047 → `workspace-launcher.js`)
  Each option conditionally shown based on whether the feature is enabled (e.g., workspace option visible only when at least one workspace.json exists, or always visible with onboarding to creation flow). W-048 ships only the dropdown scaffold + the existing single option; W-040 and W-047 each add their option.

#### 13.8 Stage-Dot Data Path Verification (post-MultiWatcher)

Per §6.5, `pipelineCardView` (`multi-dashboard.js:14-24`) renders stage-dot progress from `pipeline.stage`. After the MultiWatcher migration, this field comes from `state.runs[id].stage` (already written by `runner.py` to `runs/{id}/status.json` and surfaced via `discoverRuns`). Add explicit verification:
- During Phase 6, log a one-line confirmation in the Phase 6 PR description: "Verified `state.runs[id].stage` populated for worktree runs in fixture XYZ".
- The `select-parallel-pipelines.test.js` test asserts the field-mapping contract.
- The `multi-dashboard.test.js` test asserts the rendered stage-dot active state matches the input `stage`.

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

### Phase 2.5: Retire `MultiWatcher` and migrate clients (ships with Phase 4)

**Files:** `worca-ui/server/multi-watcher.js` (delete), `worca-ui/server/multi-watcher.test.js` (delete), `worca-ui/server/ws-modular.js`, `worca-ui/server/ws-message-router.js`, `worca-ui/app/main.js`, `worca-ui/app/protocol.js`, `worca-ui/package.json`

**Tasks:**
1. Verify with `grep -rn "MultiWatcher\|pipeline-status-changed\|list-pipelines\|subscribe-pipeline\|unsubscribe-pipeline\|pipelines-list\|promotePipeline\|demotePipeline" worca-ui/` that this list is exhaustive (per §6.5 — all five protocol message types removed, not just `pipeline-status-changed`).
2. Delete `worca-ui/server/multi-watcher.js` and `worca-ui/server/multi-watcher.test.js`.
3. Remove all `MultiWatcher` instantiation sites in `worca-ui/server/ws-modular.js` (and any other server file the grep finds).
4. **Remove all four other pipeline-* request handlers** from `worca-ui/server/ws-message-router.js`: `list-pipelines` (line 855), `subscribe-pipeline` (line 864), `unsubscribe-pipeline` (line 887), and any `pipelines-list` emit sites. Replacement paths are documented in §6.5 (clients consume `runs-list` filtered via `selectParallelPipelines`).
5. Delete the `ws.on('pipeline-status-changed', ...)` handler in `worca-ui/app/main.js:726`. Re-derive any state it maintained from successive `runs-list` payloads.
6. **Remove all five `pipeline-*` strings from `worca-ui/app/protocol.js` `MESSAGE_TYPES` (lines 33-37):** `list-pipelines`, `subscribe-pipeline`, `unsubscribe-pipeline`, `pipeline-status-changed`, `pipelines-list`. Update `protocol.test.js` accordingly.
7. **Remove `WatcherSet.promotePipeline` and `demotePipeline`** if grep shows no remaining callers — these existed only to support per-pipeline log subscription via `MultiWatcher`.
8. Bump `worca-ui/package.json` micro version to bust the client bundle cache.
9. Move any unique behavioral coverage from the deleted test (e.g., stale-entry reconciliation) into `watcher.test.js` against §6's step 5.

**Sequencing constraint:** This phase must ship in the same release as Phase 4 (the `discoverRuns` fan-out). Splitting them either drops status events (Phase 2.5 first) or duplicates them (Phase 4 first).

### Phase 3: Rename and rewrite `run_worktree.py`; delete legacy batch entry points

**Files:** `src/worca/scripts/run_worktree.py` (new, replaces `run_multi.py`), `src/worca/scripts/run_multi.py` (delete), `src/worca/scripts/run_batch.py` (delete), `src/worca/orchestrator/batch.py` (delete or relocate `CircuitBreakerError`)

**Tasks:**
1. Create `run_worktree.py` with the CLI interface defined in §3: `--prompt`, `--source`, `--branch`, `--plan`, `--guide`, `--fleet-id`, `--msize`, `--mloops`, `--template`, `--param`, `--skip-preflight`.
2. Implement: generate run_id, create worktree, copy `.claude/worca/`, init beads, register in `pipelines.d/`, spawn `run_pipeline.py --worktree`, exit.
3. Wire `--guide` flag into `run_pipeline.py` argument parser (accept and store in status; content injection deferred to W-040).
4. Delete `run_multi.py`.
5. Run `grep -rn "from worca.orchestrator.batch\|run_batch" src/ tests/ worca-ui/` and confirm every hit is in code being deleted in this phase.
6. Delete `run_batch.py`. If `CircuitBreakerError` is imported by code that's *not* being deleted (e.g., `runner.py` uses its own `CircuitBreakerTripped`), simply delete `batch.py`. Otherwise move `CircuitBreakerError` into `error_classifier.py` first, update imports, then delete `batch.py`.
7. Remove any settings keys exclusive to the deleted scripts (`worca.batch.*`).

### Phase 4: Extend `pipelines.d/` and `discoverRuns` fan-out

**Files:** `src/worca/orchestrator/registry.py`, `worca-ui/server/watcher.js`

**Tasks:**
1. **Add all four kw-only fields to `register_pipeline()` at `registry.py:48` in a single edit:** `fleet_id`, `workspace_id`, `group_type`, `target_branch`. **`workspace_id` is added now even though no W-048 caller passes it** — see §5 for the rationale (avoid signature churn across W-040 / W-047). Add the mutual-exclusion guard:

   ```python
   if fleet_id is not None and workspace_id is not None:
       raise ValueError(
           "fleet_id and workspace_id are mutually exclusive — "
           "see W-048 §5"
       )
   ```

   The guard fires before any disk write. Test: `tests/test_registry.py::test_register_rejects_both_ids` passes `fleet_id="x", workspace_id="y"` → asserts ValueError, asserts no file is created.
2. Add `reconcile_orphan_groups(base=_DEFAULT_BASE)` skeleton to `registry.py` per §11.5. W-048 ships the no-op variant (manifest paths checked are empty for now); W-040 / W-047 wire actual lookups into `~/.worca/fleet-runs/*.json` and `~/.worca/workspace-runs/*.json`. Test: `tests/test_registry.py::test_reconcile_orphan_groups_noop` registers an entry without group fields → asserts function returns `[]`.
3. Add step 5 to `discoverRuns` (sync and async): fan out across `pipelines.d/` entries with `worktree_path`, read worktree's `runs/*/status.json`, augment with `worktree_worca_dir`, `is_worktree_run`, `fleet_id`, `workspace_id`, `group_type`, `target_branch`.

### Phase 5: Watchers and lifecycle routing

**Files:** `worca-ui/server/ws-status-watcher.js`, `worca-ui/server/process-manager.js`

**Tasks:**
1. Add `pipelines.d/` directory watcher in `ws-status-watcher.js`. On entry add/remove, `scheduleRefresh`.
2. Add per-worktree status watchers: maintain `Map<run_id, FSWatcher>`, reconcile on refresh.
3. Add `resolveRunContext(runId)` to `ProcessManager` (§8).
4. Update `stopPipeline`, `pausePipeline`, `resumePipeline`, `restartStage`, `deleteRun` to call `resolveRunContext` first.

### Phase 6: `startPipeline` switch, `target_branch`, and new-run.js block removal

**Files:** `worca-ui/server/process-manager.js`, `src/worca/orchestrator/runner.py`, `src/worca/agents/core/guardian.md`, `worca-ui/app/views/new-run.js`, `worca-ui/app/views/new-run-parallel-block.test.js`

**Tasks:**
1. Update `startPipeline` at `process-manager.js:273` to spawn `run_worktree.py` for new runs, `run_pipeline.py` for resume. Add fallback detection for older worca versions.
2. Store `target_branch` in `status.json` at `runner.py` initialization (from `--branch` flag).
3. Update `guardian.md` to read `status.target_branch` for `gh pr create --base`. Fall back to default branch if unset.
4. **Remove the "Pipeline already running" warning panel** in `new-run.js:293-300` and the `new-run-form-disabled` class application (line 304). Keep the `hasActivePipeline` helper for other callers but stop calling it from `newRunView`. Add the worktree info banner (§13.2) and PR base branch input in the same change.
5. **Update `new-run-parallel-block.test.js`** to assert the warning is **not** rendered (post-W-048 isolation makes parallel runs safe). Document the inversion in the test description.

**Sequencing constraint:** Tasks 1, 4, and 5 must ship together. Switching dispatch (task 1) without removing the warning (task 4) leaves users with a misleading block; removing the warning (task 4) without isolation (task 1) re-introduces the working-tree collision bug.

### Phase 7: Worktree cleanup command

**Files:** `src/worca/cli/cleanup.py` (new), `src/worca/cli/__init__.py`

**Tasks:**
1. Implement `worca cleanup` with `--all`, `--run-id`, `--dry-run`, `--older-than` flags.
2. Wire into CLI entry point.
3. Scan `pipelines.d/`, cross-reference status, call `remove_pipeline_worktree` + `deregister_pipeline`.

### Phase 7.5: UI Surface (§13)

**Files:** `worca-ui/app/views/worktrees.js` (new), `worca-ui/app/views/run-card.js`, `worca-ui/app/views/run-detail.js`, `worca-ui/app/views/sidebar.js`, `worca-ui/server/worktrees-routes.js` (new), `worca-ui/app/select-parallel-pipelines.js` (new), `worca-ui/app/main.js`, `worca-ui/app/views/multi-dashboard.js`, `worca-ui/app/styles.css`

**Tasks:**
1. Add `<sl-icon name="folder-symlink">` worktree indicator to `run-card.js` and `multi-dashboard.js` rendering paths; gated on `is_worktree_run`.
2. Add "Worktree" metadata row in `run-detail.js` with path + `<sl-copy-button>`.
3. Build `worktrees.js` view per §13.3: table from `GET /api/worktrees`, group column, filter input, resume-aware Cleanup button + bulk Cleanup, disk-usage strip with resumable sub-line.
4. Build `worktrees-routes.js`: `GET /api/worktrees` (with 30s `du -sb` cache; joins fleet/workspace manifests for group context), `DELETE /api/worktrees/:run_id` (409 when running, 412 when resumable/grouped without `?force=1`).
5. Conditional "Worktrees" entry in `sidebar.js` with count badge per §13.3 (variant flips on disk-pressure threshold). Apply §13.7 sidebar layout (flat siblings under Pipeline; "+ New Pipeline" CTA scaffolded as `<sl-dropdown>` for W-040/W-047 to extend).
6. Build `select-parallel-pipelines.js` selector and migrate `multi-dashboard.js` caller per §6.5. Remove `state.pipelines` map and `pipeline-status-changed` handler in `main.js` (this is also covered by Phase 2.5; both reference the same code change to avoid duplication).
7. Add tests listed in §13.5 (including the `multi-dashboard.test.js` and `select-parallel-pipelines.test.js` extensions).

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
| `src/worca/scripts/run_batch.py` | **Delete** — superseded by `run_worktree.py` (one-at-a-time) and W-040's `run_fleet.py` (parallel across repos) |
| `src/worca/orchestrator/batch.py` | **Delete** — relocate `CircuitBreakerError` into `error_classifier.py` if any non-deleted code still imports it |
| `src/worca/orchestrator/registry.py` | Add `fleet_id`, `workspace_id`, `group_type`, `target_branch` kwargs to `register_pipeline()` (see §5 authoritative rule on field disambiguation) |
| `src/worca/agents/core/guardian.md` | Read `status.target_branch` for `gh pr create --base` |
| `src/worca/cli/cleanup.py` | **New** — `worca cleanup` command |
| `src/worca/cli/__init__.py` | Register cleanup subcommand |
| `worca-ui/server/watcher.js` | Remove step 1 (`active_run`), add step 5 (`pipelines.d/` fan-out) |
| `worca-ui/server/ws-status-watcher.js` | Rewrite `resolveActiveRunDir` → `resolveLatestRunDir`, remove `active_run` watcher, add `pipelines.d/` watcher, add per-worktree watchers |
| `worca-ui/server/process-manager.js` | Remove `_readActiveRunId`, remove `active_run` from `reconcileStatus`/`deleteRun`/`restartStage`, add `resolveRunContext`, switch `startPipeline` to `run_worktree.py` |
| `worca-ui/server/multi-watcher.js` | **Delete** — superseded by §6 `discoverRuns` fan-out; clients migrate to `runs-list` (see §6.5) |
| `worca-ui/server/multi-watcher.test.js` | **Delete** — coverage moves to `watcher.test.js` for the new step 5 |
| `worca-ui/server/ws-modular.js` | Remove `MultiWatcher` instantiation site(s) |
| `worca-ui/server/ws-message-router.js` | Remove handlers for `list-pipelines` (line 855), `subscribe-pipeline` (line 864), `unsubscribe-pipeline` (line 887), and any `pipelines-list` emit sites — see §6.5 |
| `worca-ui/server/watcher-set.js` | Remove `promotePipeline`/`demotePipeline` if no remaining callers (per Phase 2.5 task 7) |
| `worca-ui/app/main.js` | Remove `pipeline-status-changed` handler at line 726; remove `state.pipelines` map; wire `selectParallelPipelines(state)` into `multiPipelineDashboardView` calls |
| `worca-ui/app/select-parallel-pipelines.js` | **New** — derived selector replacing `state.pipelines` (see §6.5 field map) |
| `worca-ui/app/views/multi-dashboard.js` | Caller switch only — `pipelineCardView` template unchanged |
| `worca-ui/app/views/new-run.js` | Phase 6: remove "Pipeline already running" warning + form-disable; add worktree info banner; add PR base branch input |
| `worca-ui/app/views/new-run-parallel-block.test.js` | Invert assertion: warning is NOT rendered post-W-048 |
| `worca-ui/app/protocol.js` | **Remove all five `pipeline-*` strings from `MESSAGE_TYPES` (lines 33-37)** — `list-pipelines`, `subscribe-pipeline`, `unsubscribe-pipeline`, `pipeline-status-changed`, `pipelines-list` (see §6.5) |
| `worca-ui/app/protocol.test.js` | Update assertions to match the trimmed `MESSAGE_TYPES` set |
| `worca-ui/package.json` | Micro version bump to bust client bundle cache after protocol allowlist trim |
| `CLAUDE.md` | Update run_multi references to run_worktree, document `--guide` flag, add cleanup command, document fleet/workspace global-mode requirement (§5 cross-project rule) |
| `MIGRATION.md` | Document `active_run` removal, `run_multi.py` and `run_batch.py` removal, cleanup command, `MultiWatcher` removal + **all five pipeline-* protocol message types removed** (§6.5), "Pipeline already running" block removal, third-party WS subscriber breakage warning |

## Considerations

- **No archival needed.** Runs stay in `runs/` permanently. The original issue described removing `_archive_run` — this function does not exist in the current codebase (`runner.py:1239` confirms "previous runs stay in runs/ (no archival)"). No archival logic needs removal.
- **Hot path in `hooks/prompt.py`.** Replacing `active_run` read with `runs/*/pipeline.pid` scan adds directory listing on every tool call. Mitigated by: (a) PID files are tiny integer reads, not JSON parsing; (b) the matched path is cached per-PID for the process lifetime — the scan happens once, then all subsequent calls are a single `open()`. Worst case: 10 concurrent runs = 10 `open()` + `read()` + integer comparison. Measured overhead: <1ms.
- **`results/` backward compatibility.** Old completed runs in `results/` remain visible via `discoverRuns` step 4. Nothing new is written there (runs stay in `runs/`). Over time, users migrate by running `worca cleanup --older-than 30d` on the root project.
- **Test impact.** 8 Python test files and 14 UI files reference `active_run`. All need updating — the test plan below catalogs each.
- **macOS watcher limits.** Adding `fs.watch()` per active worktree uses kqueue file descriptors. macOS default soft limit is 256, hard limit ~unlimited. At >50 concurrent worktrees (exceeding realistic usage), fall back to polling.
- **Breaking changes:**
  - The `active_run` file is no longer written. Tools or scripts that read it directly (outside worca's own code) will need to switch to scanning `runs/*/status.json`.
  - The `run_multi.py` and `run_batch.py` entry points are removed — callers must use `run_worktree.py` (one pipeline at a time) or a shell loop. W-040's `run_fleet.py` covers parallel cross-repo dispatch.
  - The `_readActiveRunId` JS method is removed — server-side code calling it must pass explicit `runId`.
  - **All five `pipeline-*` WS protocol message types are removed** (§6.5): `list-pipelines`, `subscribe-pipeline`, `unsubscribe-pipeline`, `pipeline-status-changed`, `pipelines-list`. Third-party WebSocket subscribers outside `worca-ui` that listen to any of these will silently stop receiving events. There is no formal protocol-version mechanism; MIGRATION.md must call out the change prominently. Built-in worca-ui clients are handled via the `package.json` micro bump (cache bust) and the §6.5 selector migration.
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
| Python | `tests/test_registry.py::test_register_with_workspace_id` | `workspace_id` stored when provided (signature accepts it even though no W-048 caller passes it — see §5) |
| Python | `tests/test_registry.py::test_register_with_group_type` | `group_type` stored when provided |
| Python | `tests/test_registry.py::test_register_with_target_branch` | `target_branch` stored when provided |
| Python | `tests/test_registry.py::test_register_rejects_both_ids` | `register_pipeline(fleet_id="x", workspace_id="y")` raises `ValueError`; **no file is created on disk** (guard fires before write) |
| Python | `tests/test_registry.py::test_reconcile_orphan_groups_noop` | With no fleet/workspace IDs in any entry, returns `[]` (W-048 ships the function in skeleton form per §11.5) |
| Python | `tests/test_run_pipeline.py::test_guide_flag_errors_without_attach_guide` | When `attach_guide` is not importable, `--guide foo.md` raises `ArgumentError` with the §4 message; dispatch never starts |
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
- **Concurrent fleet + workspace + standalone in one project's `discoverRuns`.** Manually create three `pipelines.d/` entries — one with `fleet_id` only, one with `workspace_id` only, one with neither (standalone). Assert: `discoverRuns` returns all three, `group_type` discriminator correctly populated, no IDs cross-leak (a `fleet_id`-bearing entry never has `workspace_id` non-null and vice versa).
- **MultiWatcher → `runs-list` regression test.** Start a worktree pipeline. Assert: `selectParallelPipelines(state)` returns one entry; `pipelineCardView` renders with stage-dot active state matching `state.runs[id].stage`; `multiPipelineDashboardView` output stable across successive `runs-list` payloads when nothing changed (memoization works).
- **Lifecycle routing.** Start a worktree pipeline, stop it via `ProcessManager.stopPipeline(runId)`. Assert: correct PID killed (worktree's, not root's), status updated in worktree's `status.json`.
- **Cleanup.** Create 3 worktree pipelines (2 completed, 1 running). Run `worca cleanup --all`. Assert: 2 worktrees removed, 1 (running) preserved, 2 `pipelines.d/` entries deregistered.
- **Resume-aware cleanup (UI).** Create 1 `failed` worktree pipeline. Call `DELETE /api/worktrees/:run_id` without `?force=1`. Assert: returns 412 with body explaining "resumable, force=1 required". Call again with `?force=1`. Assert: succeeds, worktree removed.
- **Playwright (`--workers=1`).** Start a pipeline from the UI dashboard, verify it appears in the runs list as a worktree run, stop it, verify status transition. Also verify the "Pipeline already running" warning is gone — start a second pipeline while the first is still active and confirm both appear in the dashboard.

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
