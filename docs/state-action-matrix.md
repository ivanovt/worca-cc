# State-Action Matrix

Specification for worca **pipeline** and **fleet** states, actions, transitions, and their enforcement across the Python orchestrator and Node.js UI server.

- [Pipeline State-Action Matrix](#pipeline-states) — a single autonomous run
- [Fleet State-Action Matrix](#fleet-state-action-matrix) — one work-request fanned across N repos

A fleet is a thin orchestration layer *over* pipelines: every fleet child **is** a normal pipeline run with its own pipeline-level state machine (above). The fleet's own status is *derived* from its children plus a circuit-breaker rule — see [Fleet Status Derivation](#fleet-status-derivation).

## Pipeline States

A pipeline run's `pipeline_status` is always one of these seven values:

| State | Meaning | Set by |
|---|---|---|
| `pending` | Run created but not yet started | Node.js (cancel flow) |
| `running` | Pipeline actively executing stages | Python orchestrator |
| `paused` | Halted by user; resumable without data loss | Python (control file / webhook) |
| `completed` | All stages finished successfully | Python orchestrator |
| `failed` | Unrecoverable error, loop exhaustion, or crash | Python orchestrator, Node.js reconciler |
| `interrupted` | User-initiated stop (control file, signal, webhook) | Python orchestrator |
| `cancelled` | Force-cancelled from UI; not resumable | Node.js cancel endpoint |

### Terminal vs non-terminal

- **Terminal:** `completed`, `failed`, `cancelled` -- the run is done.
- **Resumable terminal:** `interrupted` -- the run ended (a terminal event is emitted), but `resume` is allowed because the user stopped intentionally.
- **Non-terminal:** `pending`, `running`, `paused` -- the run is active or can continue without re-entry.

Note: `interrupted` emits a terminal event (`pipeline.run.interrupted` via `dispatch_external`) because the pipeline has exited. However, unlike `failed` or `cancelled`, the user can resume it. This makes it "terminal for event dispatch, resumable for lifecycle."

### `failed` vs `interrupted`

These two states are often confused. The distinction is:

- **`interrupted`** = user-initiated stop. The pipeline was told to stop by a human (control file, SIGTERM, webhook abort). The code was healthy; the user decided to halt.
- **`failed`** = something went wrong. An exception was thrown, a loop was exhausted, a circuit breaker tripped, or the process crashed/died unexpectedly (stale PID).

A stale process (crash, OOM, SIGKILL without clean shutdown) is `failed` with `stop_reason="stale"`, not `interrupted`, because no human requested the stop.

## Stop Reasons

When a pipeline enters `failed`, `interrupted`, or `cancelled`, a `stop_reason` field explains why:

| stop_reason | pipeline_status | Trigger |
|---|---|---|
| `control_file` | `interrupted` | User wrote stop action to `control.json` |
| `signal` | `interrupted` | SIGTERM/SIGINT received |
| `control_webhook` | `interrupted` | Abort response from control webhook |
| `stale` | `failed` | Process died without clean shutdown (crash, OOM, SIGKILL) |
| `unexpected_exit` | `failed` | Pipeline exited with status still "running" |
| `loop_exhausted` | `failed` | Max loop iterations reached |
| `pipeline_error` | `failed` | `PipelineError` exception |
| `CircuitBreakerTripped` | `failed` | Circuit breaker halted the pipeline |
| `force_cancelled` | `cancelled` | User force-cancelled from UI |
| *(exception class name)* | `failed` | Any other unhandled exception |

## Action Matrix

The matrix defines which actions are valid for each pipeline state. An action not listed for a state is **blocked** -- the UI hides the button and the server returns 409.

| Action | pending | running | paused | completed | failed | interrupted | cancelled |
|---|---|---|---|---|---|---|---|
| **stop** | - | YES | - | - | - | - | - |
| **pause** | - | YES | - | - | - | - | - |
| **resume** | - | - | YES | - | YES | YES | - |
| **cancel** | YES | YES | YES | - | YES | YES | - |
| **archive** | YES | - | YES | YES | YES | YES | YES |
| **unarchive** | - | - | - | YES | YES | YES | YES |
| **delete** | YES | - | YES | YES | YES | YES | YES |
| **learn** | - | - | YES | YES | YES | YES | YES |

### Action semantics

- **stop** -- Write `control.json` with `action: "stop"` + send SIGTERM. Python handles clean shutdown. Only valid while running.
- **pause** -- Write `control.json` with `action: "pause"`. Python polls, sees it, sets status to `paused`, exits cleanly. Only valid while running.
- **resume** -- Spawn `run_pipeline.py --resume`. Valid from `paused`, `failed`, and `interrupted`. Clears `archived` flag if set.
- **cancel** -- Force-cancel: calls `stopPipelineSync` (if running), then writes `pipeline_status: "cancelled"`. Not valid on `completed` or already `cancelled` runs.
- **archive** -- Set `archived: true` in status.json. Hidden from main dashboard. Not valid while `running`.
- **unarchive** -- Remove `archived` flag. Only valid on terminal + `interrupted` states.
- **delete** -- Permanently remove the run directory. Not valid while `running`.
- **learn** -- Trigger post-run learning analysis. Not valid while `running` or `pending`.

### Design principles

1. **`running` blocks destructive actions.** You cannot archive, delete, or learn from a running pipeline. Stop or cancel first.
2. **`completed` and `cancelled` are final.** You cannot resume, stop, or pause them. Cancel is also blocked (already done).
3. **`resume` covers recovery.** Failed and interrupted runs can be resumed because the pipeline supports `--resume` to pick up from where it left off.
4. **`cancel` is the escape hatch.** Almost every non-terminal state allows cancel. It's the "I don't care about this run anymore" action.

## Source of Truth

The canonical matrix lives in:

```
worca-ui/app/utils/state-actions.js
```

This file exports `STATES` and the `actionAllowed(action, status)` function. Both the UI (button visibility) and the server (route validation) import `actionAllowed` from this file. The `ACTION_MATRIX` object is intentionally not exported — consumers use `actionAllowed()` for encapsulation.

### Consumers

**UI components** (button gating):
- `worca-ui/app/views/run-card.js` -- pause/stop/resume/cancel buttons on run cards
- `worca-ui/app/views/multi-dashboard.js` -- same buttons on multi-pipeline cards

**Server routes** (request validation):
- `worca-ui/server/project-routes.js` -- cancel and delete endpoints return 409 if action not allowed

**Tests:**
- `worca-ui/app/utils/state-actions.test.js` -- exhaustive 56-case matrix (8 actions x 7 states)
- `worca-ui/app/views/run-card.test.js` -- button visibility assertions
- `worca-ui/app/views/multi-dashboard.test.js` -- button visibility assertions

## State Transitions

### Python orchestrator (status.json writes)

```
pending ──► running           (pipeline starts)
running ──► paused            (control file: pause)
running ──► interrupted       (control file: stop, SIGTERM, webhook abort)
running ──► failed            (exception, loop exhausted, circuit breaker, crash)
running ──► completed         (all stages done)
paused  ──► running           (resume via --resume)
```

### Node.js server (status.json writes)

```
running ──► cancelled         (cancel endpoint, after stopPipelineSync)
paused  ──► cancelled         (cancel endpoint, no stop needed)
failed  ──► cancelled         (cancel endpoint)
interrupted ──► cancelled     (cancel endpoint)
pending ──► cancelled         (cancel endpoint)
running ──► failed            (reconciler: stale process detected)
```

### Mode-Dependent Stage Transitions (PLAN_REVIEW)

The `PLAN_REVIEW` stage has two modes — `review` and `review_and_edit` — configured via `worca.stages.plan_review.mode` (or forced by `worca.governance.plan_review_enforce`). The mode determines which outbound transitions are legal:

| Mode | Legal transitions from PLAN_REVIEW | Loopback to PLAN? |
|---|---|---|
| `review` (default) | COORDINATE (approve), PLAN (revise) | Yes — bounded by `loops.plan_review` |
| `review_and_edit` | COORDINATE only | No |

```
review mode (default):
  PLAN ──► PLAN_REVIEW ──approve──► COORDINATE
                       └─revise──► PLAN  (bounded by loops.plan_review)

review_and_edit mode:
  PLAN ──► PLAN_REVIEW(edit + self-approve) ──► COORDINATE
  (no PLAN_REVIEW ──► PLAN edge)
```

In `review_and_edit` mode the reviewer edits the plan in-place and self-approves; there is no loopback to the planner. A plan the reviewer cannot fully fix is edited best-effort and the run proceeds.

The `can_transition(from_stage, to_stage, *, mode=None)` function in `src/worca/orchestrator/stages.py` enforces this: when `mode="review_and_edit"`, the `PLAN_REVIEW → PLAN` edge is removed from the allowed set.

### Cancel endpoint race safety

The cancel endpoint re-reads `status.json` after `stopPipelineSync` returns, because Python's signal/atexit handler may have updated the file during the 5-second stop window. The re-read ensures the final `cancelled` write includes any stage progress Python persisted.

## Terminal Events (dispatch_external)

When a pipeline reaches a terminal state, an event is dispatched via `dispatch_external.py` for webhooks and integrations. Only three event types are valid:

| Event Type | pipeline_status | Payload |
|---|---|---|
| `pipeline.run.interrupted` | `interrupted` | `{ interrupted_stage, elapsed_ms, source }` |
| `pipeline.run.cancelled` | `cancelled` | `{ cancelled_stage, elapsed_ms, source }` |
| `pipeline.run.failed` | `failed` | `{ error, failed_stage, error_type }` |

`pipeline.run.completed` is NOT dispatched via `dispatch_external` -- it's emitted directly by the Python orchestrator since it's already running in-process.

## Status Badge Rendering

Each state maps to a visual treatment in the UI. See `worca-ui/docs/badge-color-language.md` for the full guide.

| State | Badge Variant | Color | Icon |
|---|---|---|---|
| `pending` | `neutral` | Grey | Circle |
| `running` | `primary` | Blue | Loader (spinning) |
| `paused` | `warning` | Orange | Pause |
| `completed` | `success` | Green | CircleCheck |
| `failed` | `danger` | Red | CircleAlert |
| `interrupted` | `warning` | Orange | Pause |
| `cancelled` | `neutral` | Grey | CircleSlash |

---

# Fleet State-Action Matrix

A **fleet run** fans a single work-request across N independent project repositories. Each child is a normal pipeline run (`run_worktree.py` → `run_pipeline.py`) with its own pipeline-level state. The fleet adds a coordinating layer: a manifest at `~/.worca/fleet-runs/<fleet_id>.json`, a dispatch loop with a parallelism cap, and a circuit breaker.

## Fleet States

A fleet manifest's `status` is one of these five values:

| State | Meaning | Set by |
|---|---|---|
| `running` | Dispatch loop active — children launching/executing, or some still pending | Python (`run_fleet.py`) |
| `resuming` | A `--resume` pass is re-launching failed/pending children | Python (`resume_fleet`) |
| `halted` | Stopped before all children reached a terminal state; **sticky** until an explicit resume | Python (`run_fleet.py`) / Node.js (`DELETE /:id`) |
| `completed` | Every dispatched child is terminal **and** all completed | Python (`derive_fleet_status`) |
| `failed` | Every dispatched child is terminal **and** at least one did not complete | Python (`derive_fleet_status`) |

### Terminal vs non-terminal

- **Terminal:** `completed`, `failed` — the fleet is done.
- **Resumable terminal:** `halted` — the dispatch loop exited, but `resume` re-enters it to pick up failed/pending children. The halt is sticky: a poll that re-derives status will **not** override a `halted` manifest until the user resumes.
- **Non-terminal:** `running`, `resuming` — the dispatch loop is live.

Unlike pipelines, a fleet has no `cancelled` or `interrupted` state. A user-initiated stop produces `halted` with `halt_reason: "user"` (the fleet equivalent of `paused` + `interrupted` combined): in-flight children are **never killed** — they finish naturally — only un-dispatched children are cancelled.

## Halt Reasons

When a fleet enters `halted`, a `halt_reason` field explains why. It is preserved across status re-derivation (a poll passing `status="halted"` with no reason keeps the existing one):

| halt_reason | Trigger | Routed on dashboard as |
|---|---|---|
| `user` | Operator halted the fleet (header **Halt** button → `DELETE /:id`) | **Paused** section |
| `circuit_breaker` | Failed-child ratio crossed `fleet_failure_threshold` while children were still in-flight | **Failures** section |
| `targets_not_ready` | Pre-dispatch readiness check found an un-worca-ready target — the **whole** fleet aborts before any child launches | **Failures** section |
| `plan_first_failed` | `--plan-first` reference child's Planner failed, so the shared plan never materialised | **Failures** section |

Only `user` halts read as "paused / you stopped it"; every other halt reads as a failure surface. See `_isFleetPaused` / `_isFleetFailed` in `worca-ui/app/views/dashboard.js`.

## Fleet Status Derivation

`derive_fleet_status(child_statuses, threshold)` in `src/worca/orchestrator/fleet_manifest.py` is a **pure function** — it computes the fleet status from the list of child pipeline statuses:

```
no children yet                        ──► running
any child running/resuming/paused:
  terminal ≥ min(3,total)
  AND failed > 0
  AND failed/terminal ≥ threshold       ──► halted (circuit_breaker)
  otherwise                             ──► running
all children terminal:
  all completed                         ──► completed
  otherwise                             ──► failed
some children still pending/untracked   ──► running
```

The circuit breaker only fires **while in-flight children remain** — there's no point halting a fleet whose children have all finished. `min(3, total)` adapts the "enough signal" floor for small fleets.

`poll_and_update_fleet_manifest()` reads each child's `pipelines.d/<run_id>.json`, runs `derive_fleet_status`, and writes the result back — unless the manifest is already `halted` (sticky).

## Fleet Action Matrix

An action not listed for a state is **blocked** — the UI hides the button and the server returns a 4xx.

| Action | running | resuming | halted | completed | failed |
|---|---|---|---|---|---|
| **halt** | YES | YES | - | - | - |
| **resume** | - | - | YES | - | YES |
| **cleanup** | - | - | YES | YES | YES |
| **re-run** | - | - | YES | YES | YES |
| **archive** | - | - | YES | YES | YES |
| **unarchive** | only when `archived: true` (any non-running state) | | | | |

### Action semantics

- **halt** — `DELETE /api/fleet-runs/:id` (no `?cleanup`). Sets `status: "halted"`, `halt_reason: "user"`. Un-dispatched children are cancelled; in-flight children finish naturally. Only valid while the dispatch loop is live.
- **resume** — `POST /api/fleet-runs/:id/resume` → spawns `run_fleet.py --resume`. Re-launches children whose status is `failed` / `setup_failed` / `pending`; leaves `completed` / `running` / `resuming` / `paused` / `unrecoverable` children alone. Returns **410** if a launched child's worktree was already cleaned (resume would be incoherent). Valid from `halted` and `failed`.
- **cleanup** — `DELETE /api/fleet-runs/:id?cleanup=1` → `worca cleanup --fleet-id`. Removes every child worktree **and** the fleet manifest directory. On a still-resumable fleet (`halted` / `failed`) it requires `?force=1` (the **412** resume-loss gate) because cleanup destroys the worktrees that `--resume` needs.
- **re-run** — `POST /api/fleet-runs/:id/relaunch` → mints a fresh `fleet_id`, copies this fleet's config (work request, head template, base, plan mode), and dispatches anew. The original manifest is untouched. Header button navigates to the launcher pre-filled instead, depending on entry point.
- **archive** — `POST /api/fleet-runs/:id/archive`. Sets `archived: true` + `archived_at`. Hidden from the default `/#/fleet-runs` list and every dashboard section; reachable via the **archived** filter chip. Refuses an in-flight fleet (`running` / `resuming`) with **409**. Idempotent.
- **unarchive** — `POST /api/fleet-runs/:id/unarchive`. Clears `archived` + `archived_at`. Idempotent.

### Design principles

1. **In-flight fleets block destructive actions.** You cannot archive (or cleanly cleanup) a `running` / `resuming` fleet — halt it first. In-flight children are *never* force-killed; the fleet always lets them finish.
2. **`halted` is the universal "needs a decision" state.** Resume it, clean it up, or re-run it. The `halt_reason` tells you *why* it stopped, but the available actions are the same.
3. **`resume` is recovery, `re-run` is a fresh start.** Resume continues the *same* fleet (same `fleet_id`, same manifest); re-run mints a new one from the same config.
4. **The halt is sticky.** Status polling never silently un-halts a fleet — only an explicit `resume` does.

## Fleet Action Source of Truth

Unlike pipelines, there is **no central `state-actions.js` matrix** for fleets — the gating is small enough to live inline at each call site, and the server enforces it independently:

**UI components** (button gating):
- `worca-ui/app/views/fleet-card.js` — `showHalt` / `showResume` / `showArchive` / `showUnarchive` flags on the dashboard + `/#/fleet-runs` cards
- `worca-ui/app/main.js` `contentHeaderView` — Halt / Resume / Cleanup / Re-run buttons in the fleet detail page header

**Server routes** (request validation, in `worca-ui/server/fleet-routes.js`):
- `POST /:id/archive` — 409 if `running` / `resuming`
- `DELETE /:id?cleanup=1` — 412 resume-loss gate on `halted` / `failed` without `?force=1`
- `POST /:id/resume` — 409 if already `running`, 410 if a child worktree was cleaned

**Python** (`src/worca/orchestrator/fleet_manifest.py`, `src/worca/scripts/run_fleet.py`):
- `derive_fleet_status` — the canonical status derivation
- `update_fleet_status` — the only writer that sets arbitrary status + sticky-halt-reason logic
- `register_fleet_child` — appends dispatched children to the manifest

**Tests:**
- `tests/test_fleet_manifest.py` — `derive_fleet_status`, `update_fleet_status`, `register_fleet_child`
- `tests/test_fleet_circuit_breaker.py` — circuit-breaker threshold + sticky-halt behaviour
- `worca-ui/server/fleet-routes.test.js` — archive / unarchive / resume / cleanup endpoint guards

## Fleet Status Badge Rendering

Fleet status maps to a badge variant via `fleetStatusVariant` / `fleetStatusLabel` in `worca-ui/app/views/group-rendering.js`. The `halted` variant depends on `halt_reason` — a user halt reads neutral, an automatic halt reads as a caution:

| State | halt_reason | Badge Variant | Label |
|---|---|---|---|
| `running` | — | `primary` | Running |
| `resuming` | — | `primary` | Resuming |
| `completed` | — | `success` | Completed |
| `failed` | — | `danger` | Failed |
| `halted` | `user` | `neutral` | Halted |
| `halted` | `circuit_breaker` / `targets_not_ready` / `plan_first_failed` | `warning` | Halted (auto) |

The badge is shown in the **page header** on the fleet detail page (not in the overview body) and on the fleet card's top row on the dashboard / list views.

## Fleet Terminal Events

Fleets do **not** yet emit lifecycle events to webhooks or chat integrations. A design for `fleet.*` event types (mirroring the `pipeline.*` namespace) is proposed in [`docs/proposals/fleet-events.md`](./proposals/fleet-events.md) but not implemented. Today the only fleet event surface is the in-process WS `fleet-update` broadcast that the UI uses to refresh the manifest cache.

---

## Changing the Matrix

When adding a new **pipeline** state or action:

1. Update `STATES` and `ACTION_MATRIX` in `worca-ui/app/utils/state-actions.js`
2. Add the new state/action to `state-actions.test.js` (maintain exhaustive coverage)
3. If adding a state: add entries to `CLASS_MAP` and `ICON_DATA` in `worca-ui/app/utils/status-badge.js`
4. If the state is set by Python: update `src/worca/orchestrator/runner.py`
5. If the state needs external dispatch: update `VALID_EVENT_TYPES` in `src/worca/events/dispatch_external.py` and add a payload builder in `src/worca/events/types.py`
6. Update this document
7. Run: `pytest tests/test_runner_control_polling.py && cd worca-ui && npx vitest run app/utils/state-actions.test.js`

When adding a new **fleet** state or action:

1. If it's a derived status: update `derive_fleet_status` in `src/worca/orchestrator/fleet_manifest.py` and its tests in `tests/test_fleet_manifest.py`
2. If it's a new `halt_reason`: thread it through `run_fleet.py`, update the dashboard routing (`_isFleetPaused` / `_isFleetFailed` in `worca-ui/app/views/dashboard.js`), and the badge logic in `worca-ui/app/views/group-rendering.js`
3. If it's a new action: add the endpoint + guard in `worca-ui/server/fleet-routes.js` (with tests in `fleet-routes.test.js`), the button in `fleet-card.js` and/or `contentHeaderView`, and the handler in `main.js`
4. Update the Fleet section of this document
5. Run: `pytest tests/test_fleet_manifest.py tests/test_fleet_circuit_breaker.py && cd worca-ui && npx vitest run server/fleet-routes.test.js`
