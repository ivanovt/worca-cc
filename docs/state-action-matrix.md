# Pipeline State-Action Matrix

Specification for worca pipeline states, actions, transitions, and their enforcement across the Python orchestrator and Node.js UI server.

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

## Changing the Matrix

When adding a new state or action:

1. Update `STATES` and `ACTION_MATRIX` in `worca-ui/app/utils/state-actions.js`
2. Add the new state/action to `state-actions.test.js` (maintain exhaustive coverage)
3. If adding a state: add entries to `CLASS_MAP` and `ICON_DATA` in `worca-ui/app/utils/status-badge.js`
4. If the state is set by Python: update `src/worca/orchestrator/runner.py`
5. If the state needs external dispatch: update `VALID_EVENT_TYPES` in `src/worca/events/dispatch_external.py` and add a payload builder in `src/worca/events/types.py`
6. Update this document
7. Run: `pytest tests/test_runner_control_polling.py && cd worca-ui && npx vitest run app/utils/state-actions.test.js`
