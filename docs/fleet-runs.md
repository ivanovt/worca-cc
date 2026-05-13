# Fleet Runs

Fan out a single work-request to N independent project repositories in parallel. Each target gets its own isolated pipeline (own git worktree, own branch, own PR), all grouped under a shared `fleet_id` in the registry and dashboard.

## Quick start

```bash
python .claude/scripts/run_fleet.py \
  --projects /path/to/repo-a /path/to/repo-b /path/to/repo-c \
  --prompt "Apply the new authentication standard"
```

This provisions each target (runs `worca init --upgrade`), then fans out the pipeline in parallel. Progress appears in the worca-ui dashboard under a single fleet group.

## Lifecycle

A fleet is a fan-out **launcher + state machine** wrapping N independent single-project pipelines. The launcher itself runs no agents — it spawns and polls children. Fleet-level status is **derived** from child statuses and re-computed every poll; it is not stored independently except for the sticky `halted` flag.

### Phases

| # | Phase | Where | What happens |
|---|---|---|---|
| 1 | **Submit** | `POST /api/fleet-runs` (UI) or `run_fleet.py` (CLI) | Fleet ID generated as `f_<yyyymmddhhmm>_<hex>`. UI uploads any guide files to `~/.worca/fleet-runs/<fleet_id>/guides/`. Server spawns `run_fleet.py` detached and returns immediately. |
| 2 | **Pre-flight** | `run_fleet.py:main` | `--base` branch existence validated across every target (any missing → abort). Each target gets `worca init --upgrade` (default 60 s timeout). Targets that fail init are marked `setup_failed` and excluded from dispatch; the rest of the fleet still launches. |
| 3 | **Manifest write** | `~/.worca/fleet-runs/<fleet_id>.json` | Initial manifest captures launch params + `status: "running"` + empty `children: []`. From here the fleet is observable to the UI. |
| 4 | **Plan-first (optional)** | `run_plan_first` | Only when `--plan-first` was passed. Synchronous, single child — runs the Planner on a reference project, polls its worktree for `MASTER_PLAN.md` (1 h timeout), copies the plan to the fleet dir for the remaining children. If the reference Planner fails: fleet is marked `halted` with `halt_reason: "plan_first_failed"` and never fans out. |
| 5 | **Dispatch** | `dispatch_fleet` | Semaphore loop maintains up to `max_parallel` `subprocess.Popen` children, each running `run_worktree.py --fleet-id <fid> [...]` in its own worktree. Polls every 200 ms. Free slots get the next pending project. |
| 6 | **Terminal** | derived | When every child has reached a terminal state (`completed` / `failed` / `setup_failed` / `unrecoverable`) the fleet settles into `completed` or `failed`. |

See also: [Target provisioning](#target-provisioning), [Plan modes](#plan-modes), [Max-parallel](#max-parallel).

### Child runs

Each child is a **full single-project pipeline** running the standard 9 stages (Preflight → Planner → … → Guardian → Learner) — fleet doesn't override stage behaviour, it only injects `--fleet-id` and the shared guide/plan/base flags. Each child writes its status to its own project's `.worca/multi/pipelines.d/<run_id>.json`; the fleet reads those files to derive fleet status.

### Status derivation

`derive_fleet_status` (in [`src/worca/orchestrator/fleet_manifest.py`](../src/worca/orchestrator/fleet_manifest.py)) is pure and re-runs every UI poll:

| Children state | Fleet status |
|---|---|
| Any in `{running, resuming, paused}`, breaker not tripped | `running` |
| Any in `{running, resuming, paused}`, breaker tripped | `halted` (`halt_reason: "circuit_breaker"`) |
| All terminal AND all `completed` | `completed` |
| All terminal AND ≥1 failure | `failed` |
| No children registered yet | `running` |

A user-initiated halt (`halt_reason: "user"`) is **sticky** — re-derivation never overrides it. The same applies to `halt_reason: "circuit_breaker"`; both stay halted until explicit [resume](#resume).

### Circuit breaker

When ≥ `min(3, total)` children have completed AND `failed / terminal ≥ fleet_failure_threshold` (default 30 %), the breaker trips:

- `manifest.status = "halted"`, `halt_reason = "circuit_breaker"`
- **No new children are spawned** — pending projects stay `pending`
- **In-flight children are never killed** — they finish naturally so no half-written repos are left behind
- Once the in-flight set drains, any still-unstarted children settle to `halted`

See [Fleet-level circuit breaker](#fleet-level-circuit-breaker) for tuning.

### Resume

Halted / failed fleets resume via `run_fleet.py --resume <fleet_id>`. The resume handler:

- Reads each child's current pipeline-status file
- Re-dispatches only children in `{pending, failed, setup_failed}`
- Skips `{completed, running, resuming, paused, unrecoverable}`
- For `failed` children whose worktree was cleaned up, marks them `unrecoverable` (nothing left to retry)
- Sets fleet `status: "resuming"`, then re-enters the same `dispatch_fleet` loop with the resumable subset

Circuit-breaker rules apply on the resumed dispatch too.

### State diagram

```
                ┌───────────────┐
                │   submitted   │  POST /api/fleet-runs (or CLI)
                └───────┬───────┘
                        │ pre-flight + manifest write
                        ▼
                ┌───────────────┐
   ┌────────────│    running    │◀──────────┐
   │            └───────┬───────┘           │
   │                    │                   │
   │       ┌────────────┼─────────────┐     │
   │       │            │             │     │
   │       ▼            ▼             ▼     │
   │   breaker      all OK       user STOP  │
   │       │            │             │     │
   │       ▼            │             ▼     │
   │    halted          │          halted   │
   │ (circuit_breaker)  │          (user)   │
   │       │            │             │     │
   │       └─── resume ─┤             │     │
   │                    │             │     │
   │                    ▼             │     │
   │     ┌───────────────────────┐    │     │
   │     │ all children terminal?│    │     │
   │     └─────┬─────────────┬───┘    │     │
   │           │             │        │     │
   │     all completed   any failed   │     │
   │           │             │        │     │
   │           ▼             ▼        │     │
   │      ┌──────────┐  ┌────────┐    │     │
   └─▶    │completed │  │ failed │ ───┴─────┘ resume
          └──────────┘  └────────┘
```

### Process model

- The fleet runner is a single Python process; it spawns each child as an independent `subprocess.Popen` with its own pgid.
- **Killing the fleet runner (e.g. `kill -9`) does not kill in-flight children** — they continue, finish, and write their status normally. The fleet manifest, however, won't update until something re-polls it.
- The fleet runner does not go through the UI's `LaunchLock`, so a fleet running with `max_parallel > worca.parallel.max_concurrent_pipelines` will exceed the host cap while running. The UI Launch button does check capacity at submit time.

## Launching a fleet

### Specifying targets

Pass project paths inline or via a file:

```bash
# Inline
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend /repos/mobile \
  --prompt "Upgrade ESLint to v9"

# From a file (one path per line)
python .claude/scripts/run_fleet.py \
  --projects-file repos.txt \
  --prompt "Upgrade ESLint to v9"
```

### Work request sources

Use `--prompt` for inline text or `--source` for an external reference. They are mutually exclusive.

```bash
# From a GitHub issue
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend \
  --source gh:issue:42

# From a bead
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend \
  --source bd:bd-abc123
```

## Guide attachment

A guide is a normative reference document (migration spec, RFC, compliance requirement) that every child's agents must treat as the highest-authority source. Attach one or more guides with `--guide`:

```bash
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend \
  --prompt "Migrate to v2 API" \
  --guide ./migration-spec.md \
  --guide ./breaking-changes.md
```

Guide paths are resolved to absolute paths before dispatch. Relative paths are relative to the fleet launcher's working directory, not the child project's.

**Authority order: guide > plan > description.** When all three are present, agents treat the guide as authoritative. Any description request that conflicts with the guide is surfaced as a bug in the description, not silently resolved.

**Size cap:** Combined guide content is capped at 64 KB (configurable via `worca.guide.max_bytes` in `settings.json`). Exceeding the cap aborts launch before any child starts.

## Branch templating

Fleet children need distinct branch names to avoid PR collisions. Two separate flags control the two distinct branch concepts:

| Flag | Concept | Example |
|------|---------|---------|
| `--head-template TMPL` | Per-child head branch (the branch agents commit to) | `migration/v2/{project}` |
| `--base BRANCH` | PR base branch shared across the fleet | `main` |

```bash
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend \
  --prompt "Migrate to v2 API" \
  --head-template "migration/v2/{project}" \
  --base main
```

**`--branch` is explicitly rejected.** It means different things in `run_worktree.py` (base branch) and would be confusing in a fleet context. Use `--base` and `--head-template` instead.

### Head-template placeholders

| Placeholder | Value |
|-------------|-------|
| `{project}` | Slugified basename of the target directory |
| `{fleet_id}` | Full fleet ID (`f_<yyyymmddhhmm>_<rand>`) |
| `{slug}` | Slugified work-request title |
| `{yyyymmdd}` | Date at fleet launch time |
| `{yyyymmddhhmm}` | Date + time at fleet launch time |

If no placeholder is present, `/{project}` is appended automatically to ensure uniqueness.

### Base branch pre-flight

When `--base` is set, the fleet verifies the branch exists in every target repo before launching any children. Missing-in-some-repos fails fast with the list of affected repos:

```
error: base branch 'main' not found in:
  /repos/legacy-service
```

When `--base` is omitted each child resolves its own default branch independently.

## Plan modes

By default each child runs its own Planner, which produces N independent strategies. For fleet work you almost always want a shared strategy:

### Explicit shared plan (recommended)

Provide a pre-written plan file. Every child receives it and skips the PLAN stage entirely:

```bash
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend /repos/mobile \
  --prompt "Apply logging standards" \
  --plan ./shared-plan.md
```

### Plan-first (reference child generates the plan)

The first child runs the Planner; once its `MASTER_PLAN.md` appears, it is copied to `~/.worca/fleet-runs/<fleet_id>/shared-plan.md` and all remaining children launch with that plan:

```bash
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend /repos/mobile \
  --prompt "Migrate to v2 API" \
  --plan-first

# Or specify a reference project explicitly
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend /repos/mobile \
  --prompt "Migrate to v2 API" \
  --plan-first /repos/frontend
```

If the reference Planner fails, the fleet halts before fan-out.

### Independent plans (neither flag)

Each child runs its own Planner. Strategies may diverge. Use only when per-repo differences are intentional.

`--plan` and `--plan-first` are mutually exclusive.

## Concurrency and the circuit breaker

### Max-parallel

`--max-parallel` caps how many children run concurrently (default: 5). Children are dispatched in batches; the circuit breaker check fires between batches.

```bash
python .claude/scripts/run_fleet.py \
  --projects /repos/a /repos/b /repos/c /repos/d /repos/e /repos/f \
  --prompt "Upgrade dependencies" \
  --max-parallel 3
```

### Fleet-level circuit breaker

The circuit breaker halts unstarted children when failures exceed a threshold. Default: 30% of completed children are failures, with at least 3 children completed.

```bash
# Lower threshold — halt earlier (50% failures)
python .claude/scripts/run_fleet.py \
  --projects /repos/a /repos/b /repos/c /repos/d \
  --prompt "Apply migration" \
  --fleet-failure-threshold 0.50
```

When the breaker trips, the fleet manifest is marked `halted` with `halt_reason: "circuit_breaker"`. In-flight children are never killed — they finish naturally.

The dashboard surfaces a warning badge ("Halted — circuit breaker") and shows how many children were halted before starting. From there you can investigate the failures, fix the issue, and resume.

## Target provisioning

Before dispatching each child, `run_fleet.py` runs `worca init --upgrade` in the target project. This is non-destructive (preserves user `settings.json`, updates worca-owned files only) and idempotent.

Targets that fail provisioning are marked `setup_failed` and skipped; the fleet continues with the rest.

**Per-target init timeout** defaults to 60 seconds. Override with `--init-timeout SECONDS` or `worca.fleet.init_timeout_seconds` in `settings.json`.

## Resume

A fleet interrupted by Ctrl+C, crash, or circuit-breaker trip can be resumed:

```bash
python .claude/scripts/run_fleet.py --resume f_202601011200_abc12345
```

Resume reads the fleet manifest and resolves each child's current status from its project's `pipelines.d/` registry. Only children with status `pending`, `failed`, or `setup_failed` are re-launched. Children that are `completed`, `running`, `paused`, or `resuming` are left alone.

**Cleanup blocks future resume.** If a child's worktree was cleaned up after failure, the child is marked `unrecoverable` and skipped — there is nothing to resume. The UI surfaces a warning when `worca cleanup` would make a fleet permanently unresumable.

### Finding a fleet ID

Fleet manifests live at `~/.worca/fleet-runs/<fleet_id>.json`. List them:

```bash
ls ~/.worca/fleet-runs/
```

Or use the worca-ui dashboard — fleet detail view shows the ID in the header.

## Cleanup

Fleet worktrees and the manifest directory are cleaned up together:

```bash
# Remove all child worktrees + manifest dir for a specific fleet
worca cleanup --fleet-id f_202601011200_abc12345

# Standard cleanup also picks up fleet child worktrees
worca cleanup --all
worca cleanup --older-than 7d
```

`worca cleanup --fleet-id` removes:
- Each child's git worktree
- Each child's `pipelines.d/` registry entry
- The fleet manifest file and `~/.worca/fleet-runs/<fleet_id>/` directory (including uploaded guides)

Running children are never eligible for cleanup.

## Dashboard grouping

The worca-ui dashboard groups fleet children under a collapsible fleet header showing:

- Fleet status badge (blue = running, orange = halted by circuit breaker, grey = halted by user, green = completed, red = failed)
- Aggregate progress (`N/M completed · K failed`)
- Links to the fleet detail view

Fleet and workspace grouping require **global mode** (`pnpm worca:ui` without `--project`). In single-project mode, cross-project siblings are invisible.

## Guardian PR titles

When `fleet_id` is present, the Guardian agent prepends `[fleet:<short_id>]` to every PR title, making fleet PRs easy to spot in GitHub's PR list:

```
[fleet:abc12345] Apply authentication migration in frontend
[fleet:abc12345] Apply authentication migration in backend
```

## Fleet manifest

Each fleet is described by a manifest at `~/.worca/fleet-runs/<fleet_id>.json`. Key fields:

```json
{
  "fleet_id": "f_202601011200_abc12345",
  "fleet_id_short": "abc12345",
  "created_at": "2026-01-01T12:00:00Z",
  "work_request": { "title": "...", "description": "...", "source": null },
  "guide": { "paths": ["/abs/path/spec.md"], "bytes": 4096, "filenames": ["spec.md"], "uploaded": false },
  "plan": { "mode": "explicit", "path": "/abs/path/shared-plan.md" },
  "head_template": "migration/v2/{project}",
  "base_branch": "main",
  "max_parallel": 5,
  "fleet_failure_threshold": 0.30,
  "status": "running",
  "halt_reason": null,
  "children": [
    { "project_path": "/repos/frontend", "project_slug": "frontend", "head_branch": "migration/v2/frontend", "run_id": "r_..." }
  ]
}
```

Per-child pipeline state (status, worktree path, timestamps) lives in each project's `pipelines.d/` entries — not duplicated in the manifest.

## Configuration

Fleet-level defaults in `.claude/settings.json` (or `settings.local.json` for secrets):

```jsonc
"worca": {
  "guide": {
    "max_bytes": 65536         // 64 KB hard cap on combined guide content
  },
  "fleet": {
    "init_timeout_seconds": 60 // per-target worca init --upgrade timeout
  }
}
```
