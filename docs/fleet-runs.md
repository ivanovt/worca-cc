# Fleet Runs

Fan out a single work-request to N independent project repositories in parallel. Each target gets its own isolated pipeline (own git worktree, own branch, own PR), all grouped under a shared `fleet_id` in the registry and dashboard.

## Quick start

```bash
python .claude/worca/scripts/run_fleet.py \
  --projects /path/to/repo-a /path/to/repo-b /path/to/repo-c \
  --prompt "Apply the new authentication standard"
```

This provisions each target (runs `worca init --upgrade`), then fans out the pipeline in parallel. Progress appears in the worca-ui dashboard under a single fleet group.

## Lifecycle

A fleet is a fan-out **launcher + state machine** wrapping N independent single-project pipelines. The launcher itself runs no agents — it spawns and polls children. Fleet-level status is **derived** from child statuses: `run_fleet.py` only writes the initial `running` and the sticky operator states, and the worca-ui server re-derives the rest on every read (see [Status derivation](#status-derivation)).

### Phases

| # | Phase | Where | What happens |
|---|---|---|---|
| 1 | **Submit** | `POST /api/fleet-runs` (UI) or `run_fleet.py` (CLI) | Fleet ID generated as `f_<yyyymmddhhmm>_<hex>`. UI uploads any guide files to `~/.worca/fleet-runs/<fleet_id>/guides/`. Server spawns `run_fleet.py` detached and returns immediately. |
| 2 | **Pre-flight** | `run_fleet.py:main` | `--base` branch existence validated across every target (any missing → abort). Each target's `.claude/worca/__init__.py` is read and its version is compared to the fleet host's installed `worca` package; **any mismatched or missing target aborts the entire fleet** (no manifest written, no dispatch). Users run `worca init` / `worca init --upgrade` manually before launching — the fleet runner never mutates target projects. |
| 3 | **Manifest write** | `~/.worca/fleet-runs/<fleet_id>.json` | Initial manifest captures launch params + `status: "running"` + empty `children: []`. From here the fleet is observable to the UI. |
| 4 | **Plan-first (optional)** | `run_plan_first` | Only when `--plan-first` was passed. Synchronous, single child — runs the Planner on a reference project, polls its worktree for `MASTER_PLAN.md` (1 h timeout), copies the plan to the fleet dir for the remaining children. If the reference Planner fails: fleet is marked `halted` with `halt_reason: "plan_first_failed"` and never fans out. |
| 5 | **Dispatch** | `dispatch_fleet` | Semaphore loop maintains up to `max_parallel` `subprocess.Popen` children, each running `run_worktree.py --fleet-id <fid> [...]` in its own worktree. Polls every 200 ms. Free slots get the next pending project. |
| 6 | **Terminal** | derived | When every child has reached a terminal state (`completed` / `failed` / `setup_failed` / `unrecoverable`) the fleet settles into `completed` or `failed`. |

See also: [Target provisioning](#target-provisioning), [Plan modes](#plan-modes), [Max-parallel](#max-parallel).

### Child runs

Each child is a **full single-project pipeline** running the standard 9 stages (Preflight → Planner → … → Guardian → Learner) — fleet doesn't override stage behaviour, it only injects `--fleet-id` and the shared guide/plan/base flags. Each child writes its status to its own project's `.worca/multi/pipelines.d/<run_id>.json`; the fleet reads those files to derive fleet status.

### Status derivation

Fleet status is **derived, not authoritative.** `run_fleet.py` only ever writes the initial `running` plus the sticky operator states — it launches detached children and exits within seconds, long before any child finishes. The terminal status is computed from the children's live `pipelines.d/` statuses by `derive_fleet_status` ([`src/worca/orchestrator/fleet_manifest.py`](../src/worca/orchestrator/fleet_manifest.py)) and its JS twin `deriveFleetStatus` ([`worca-ui/server/fleet-routes.js`](../worca-ui/server/fleet-routes.js)). The JS twin runs on every `GET /api/fleet-runs[/:id]` and **writes the reconciled status back to the manifest** — without it the manifest would stay `running` forever.

**Child state → bucket.** Every child's live registry status maps to one bucket:

| Child pipeline state | Bucket | Counts toward |
|---|---|---|
| `running`, `resuming`, `paused` | in-flight | `running_count` |
| `completed` | terminal-success | `completed_count`, `terminal_count` |
| `failed`, `setup_failed`, `unrecoverable` | terminal-failure | `failed_count`, `terminal_count` |
| `interrupted`, `cancelled` | terminal-stopped | `terminal_count` only — *not* a failure |
| `pending`, missing entry, unknown | untracked | nothing |

**Derivation** — evaluated top-down, first match wins:

| # | Combination of child buckets | Fleet status |
|---|---|---|
| 1 | No children at all | `running` |
| 2 | ≥1 in-flight **and** circuit breaker met¹ | `halted` (`halt_reason: "circuit_breaker"`) |
| 3 | ≥1 in-flight, breaker not met | `running` |
| 4 | 0 in-flight, ≥1 untracked (not all terminal) | `running` |
| 5 | All children terminal, **every** one `completed` | `completed` |
| 6 | All children terminal, ≥1 non-`completed` (failure or `interrupted`/`cancelled`) | `failed` |

¹ Circuit breaker met = `terminal_count ≥ min(3, total)` **and** `failed_count > 0` **and** `failed_count / terminal_count ≥ fleet_failure_threshold` (default 0.30). `interrupted`/`cancelled` are terminal but **not** failures — they raise `terminal_count` without raising `failed_count`, so a deliberate stop can never trip the breaker. A fleet with an interrupted child still settles to `failed` (row 6), never sticks on `running`.

**Sticky overlay.** The derivation above only runs when the *stored* manifest status is `running` or `resuming`. Everything else holds until an explicit [resume](#resume):

| Stored status | Re-derived on read? |
|---|---|
| `running` | yes — full derivation |
| `resuming` | yes — but may only advance to `running`, never straight to a terminal status² |
| `halted` (`user` / `stopped` / `circuit_breaker` / `targets_not_ready` / `plan_first_failed`) | no — operator/breaker action |
| `paused` | no — Pause action |
| `completed` / `failed` | no — terminal |

² A just-resumed fleet's children may still carry their pre-resume terminal registry state for a beat before the resumed runners flip them back; deriving `failed` there and sticking it would freeze the resume.

### Circuit breaker

When ≥ `min(3, total)` children have completed AND `failed / terminal ≥ fleet_failure_threshold` (default 30 %), the breaker trips:

- `manifest.status = "halted"`, `halt_reason = "circuit_breaker"`
- **No new children are spawned** — pending projects stay `pending`
- **In-flight children are never killed** — they finish naturally so no half-written repos are left behind
- Once the in-flight set drains, any still-unstarted children settle to `halted`

See [Fleet-level circuit breaker](#fleet-level-circuit-breaker) for tuning.

### Halt vs. Pause vs. Stop

Three operator actions wind down an in-flight fleet. They differ only in how they treat children that are already running — none of them launch new children:

| Action | CLI / API | In-flight children | Manifest result |
|---|---|---|---|
| **Halt** | `DELETE /api/fleet-runs/:id` | keep running until they finish naturally | `halted` / `halt_reason: "user"` |
| **Pause** | `run_fleet.py --pause` / `POST …/pause` | a `pause` control file is fanned out; each child stops at its next checkpoint and persists `paused` | `paused` |
| **Stop** | `run_fleet.py --stop` / `POST …/stop` | a `stop` control file is fanned out **and** each child process is SIGTERM'd; children persist `interrupted` | `halted` / `halt_reason: "stopped"` |

Pause and Stop reuse the per-run control protocol (`worca_lifecycle.cmd_pause` / `cmd_stop`) — there is no fleet-level coordinator process to signal, so the fleet fans a control file out to each child's worktree. All three states are sticky until [resume](#resume).

### Resume

Halted / stopped / paused / failed fleets resume via `run_fleet.py --resume <fleet_id>`. The resume handler reads each child's current pipeline-status entry and picks one of two paths per child:

- **In place** — `paused` and `interrupted` children still own a worktree with all their progress, so they are continued via `fleet_lifecycle.resume_child` (spawns `run_pipeline.py --resume` in the existing worktree).
- **Re-dispatch** — `pending`, `failed`, and `setup_failed` children are re-launched fresh through `dispatch_fleet` (a new worktree).
- Skips `{completed, running, resuming, unrecoverable}`.
- For `failed` children whose worktree was cleaned up, marks them `unrecoverable` (nothing left to retry).
- Sets fleet `status: "resuming"`, then resumes the in-place subset and re-enters the `dispatch_fleet` loop with the re-dispatch subset.

Circuit-breaker rules apply on the resumed dispatch too.

### Available actions per status

What the worca-ui fleet detail page offers (header buttons) and the CLI / API accept, by fleet status:

| Fleet status | Pause | Halt | Stop | Resume | Cleanup | Re-run | Archive |
|---|---|---|---|---|---|---|---|
| `running` / `resuming` | ✅ | ✅ | ✅ | — | — | — | — |
| `paused` | — | — | — | ✅ | ✅ | ✅ | ✅ |
| `halted` (any `halt_reason`) | — | — | — | ✅ | ✅ | ✅ | ✅ |
| `failed` | — | — | — | ✅ | ✅ | ✅ | ✅ |
| `completed` | — | — | — | — | ✅ | ✅ | ✅ |

- **Pause / Halt / Stop** require an in-flight fleet. `POST …/pause` and `POST …/stop` return `409` for any other status; `DELETE` (Halt) on an already-stopped fleet is an idempotent `200` no-op.
- **Resume** is offered for the non-in-flight states that still have resumable work — `paused`, `halted`, `failed`. Not `completed` (every child already succeeded). `POST …/resume` returns `409` only for an already-`running` fleet.
- **Cleanup / Re-run** appear once the fleet is no longer in-flight. Cleanup of a *resumable* fleet (`paused` / `halted` / `failed`) goes through a resume-loss confirmation — see [Cleanup](#cleanup).
- **Archive / Unarchive** are list-view card actions (not detail-page header buttons). `POST …/archive` refuses an in-flight fleet with `409`.

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
python .claude/worca/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend /repos/mobile \
  --prompt "Upgrade ESLint to v9"

# From a file (one path per line)
python .claude/worca/scripts/run_fleet.py \
  --projects-file repos.txt \
  --prompt "Upgrade ESLint to v9"
```

### Work request sources

Use `--prompt` for inline text or `--source` for an external reference. They are mutually exclusive.

```bash
# From a GitHub issue
python .claude/worca/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend \
  --source gh:issue:42

# From a bead
python .claude/worca/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend \
  --source bd:bd-abc123
```

## Guide attachment

A guide is a normative reference document (migration spec, RFC, compliance requirement) that every child's agents must treat as the highest-authority source. Attach one or more guides with `--guide`:

```bash
python .claude/worca/scripts/run_fleet.py \
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
python .claude/worca/scripts/run_fleet.py \
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
python .claude/worca/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend /repos/mobile \
  --prompt "Apply logging standards" \
  --plan ./shared-plan.md
```

### Plan-first (reference child generates the plan)

The first child runs the Planner; once its `MASTER_PLAN.md` appears, it is copied to `~/.worca/fleet-runs/<fleet_id>/shared-plan.md` and all remaining children launch with that plan:

```bash
python .claude/worca/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend /repos/mobile \
  --prompt "Migrate to v2 API" \
  --plan-first

# Or specify a reference project explicitly
python .claude/worca/scripts/run_fleet.py \
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
python .claude/worca/scripts/run_fleet.py \
  --projects /repos/a /repos/b /repos/c /repos/d /repos/e /repos/f \
  --prompt "Upgrade dependencies" \
  --max-parallel 3
```

### Fleet-level circuit breaker

The circuit breaker halts unstarted children when failures exceed a threshold. Default: 30% of completed children are failures, with at least 3 children completed.

```bash
# Lower threshold — halt earlier (50% failures)
python .claude/worca/scripts/run_fleet.py \
  --projects /repos/a /repos/b /repos/c /repos/d \
  --prompt "Apply migration" \
  --fleet-failure-threshold 0.50
```

When the breaker trips, the fleet manifest is marked `halted` with `halt_reason: "circuit_breaker"`. In-flight children are never killed — they finish naturally.

The dashboard surfaces a warning badge ("Halted — circuit breaker") and shows how many children were halted before starting. From there you can investigate the failures, fix the issue, and resume.

## Target readiness

Before dispatching, `run_fleet.py` runs a **read-only readiness check** against every selected target:

1. Reads `<project>/.claude/worca/__init__.py` and extracts `__version__`
2. Compares it to the fleet host's installed `worca` package version
3. Marks the target unready if `.claude/worca/` is missing or the versions don't match

**Any unready target aborts the entire fleet.** No manifest is written, no children are dispatched. The error message lists each unready project with the fix command:

```
error: fleet aborted — some targets are not worca-ready:
  /repos/repo-a: no .claude/worca/ found — run `worca init` in this project before launching the fleet
  /repos/repo-b: .claude/worca/ is on 0.27.0, fleet host has 0.28.0 — run `worca init --upgrade` in this project before launching the fleet
```

When the launcher invokes `run_fleet.py` with a pre-allocated `--fleet-id` (the UI path), the failed pre-flight updates the manifest to `status: "halted"` with `halt_reason: "targets_not_ready"` so the dashboard surfaces a clear failure state instead of a stuck-on-running record.

### Why no auto-upgrade

Earlier W-040 revisions ran `worca init --upgrade` as part of the fleet pre-flight, which would silently homogenise every selected project to the fleet host's version. That's a load-bearing mutation across N repos triggered from a single click — it can rewrite `settings.json`, migrate file paths, or run agent-override migrations on projects that the user didn't intend to touch in this launch. The current behaviour is the opposite: **the fleet runner never writes to a target project**. Projects must be on the host's worca version explicitly, and the user is responsible for getting them there with whatever cadence and review they want.

To upgrade many projects at once, run a per-project loop yourself:

```bash
for p in /repos/*; do
  (cd "$p" && worca init --upgrade)
done
```

…or install whatever per-project automation matches your release process.

## Pause, stop, and resume

A running fleet can be paused or stopped, and a halted / stopped / paused / failed fleet can be resumed:

```bash
python .claude/worca/scripts/run_fleet.py --pause  f_202601011200_abc12345
python .claude/worca/scripts/run_fleet.py --stop   f_202601011200_abc12345
python .claude/worca/scripts/run_fleet.py --resume f_202601011200_abc12345
```

`--pause`, `--stop`, and `--resume` are mutually exclusive lifecycle actions on an existing `fleet_id`. See [Halt vs. Pause vs. Stop](#halt-vs-pause-vs-stop) for what each does to in-flight children.

Resume reads the fleet manifest and resolves each child's current status from its project's `pipelines.d/` registry, then takes one of two paths per child:

- `paused` / `interrupted` → continued **in place** in the existing worktree (keeps all prior progress)
- `pending` / `failed` / `setup_failed` → **re-dispatched fresh** in a new worktree
- `completed` / `running` / `resuming` / `unrecoverable` → left alone

**Cleanup blocks future resume.** If a child's worktree was cleaned up, the child is marked `unrecoverable` and skipped — there is nothing to resume. The UI surfaces a warning when `worca cleanup` would make a fleet permanently unresumable.

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

## Fleet-level events and webhooks

Five aggregated `fleet.*` events complement the per-child `pipeline.run.*` stream. Subscribers watching a fleet should listen to these directly instead of reconstructing fleet state from each child's pipeline events.

| Event | When | Payload highlights |
|---|---|---|
| `fleet.launched` | After `run_fleet.py` finishes dispatching all children | `projects`, `plan_mode`, `guide_attached`, `head_template`, `base_branch`, `max_parallel`, `failure_threshold`, `child_count` |
| `fleet.halted` | `stop_fleet`, **or** when reconciler trips the breaker | `halt_reason` (`"stopped"`, `"circuit_breaker"`, `"user"`), `in_flight_count`, `pending_count` |
| `fleet.circuit_breaker.tripped` | Manifest reconciler crosses the failure-ratio threshold | `failed_count`, `terminal_count`, `total_count`, `threshold`, `failure_ratio` (fires alongside `fleet.halted`) |
| `fleet.completed` | All children landed `completed` | `child_count`, `completed_count` |
| `fleet.failed` | All children terminal, at least one not `completed` | `child_count`, `completed_count`, `failed_count`, `interrupted_count` |

Each event has the envelope:

```jsonc
{
  "schema_version": "1",
  "event_id": "<uuid4>",
  "event_type": "fleet.launched",
  "timestamp": "2026-01-01T12:00:00.000Z",
  "fleet_id": "f_202601011200_abc12345",
  "payload": { /* per-event fields */ }
}
```

Events are written to `~/.worca/fleet-runs/<fleet_id>.events.jsonl` (audit log) and dispatched to the same `worca.hooks` + `worca.webhooks` configuration the per-pipeline events use. Wire up a hook by event type:

```jsonc
"worca": {
  "hooks": {
    "fleet.halted": ["./scripts/page_on_call.sh"],
    "fleet.circuit_breaker.tripped": ["./scripts/page_on_call.sh"],
    "fleet.*": ["./scripts/log_fleet_events.sh"]
  }
}
```

Transitions are edge-triggered: a fleet that stays `running` across many polls fires no events, and a sticky `halted` / `paused` fleet doesn't re-emit on subsequent polls. `fleet.circuit_breaker.tripped` and `fleet.halted` both fire on a breaker trip (in that order) — subscribers that want only one signal should filter to the more specific event. Settings are resolved from the **first child's project root** (every fleet child shares its parent's settings), so each project's `worca.hooks` is honored without explicit fleet-level config.
