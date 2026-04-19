# W-043: Unified pipeline state model + universal event dispatch

**Status:** Draft
**Priority:** P1
**Area:** cc + ui
**Date:** 2026-04-19
**Depends on:** W-042 (PR #108) — `dispatch_event()` helper, `_pending_signal_event`, signal-deferred dispatch are introduced there and assumed present.

## Problem

The pipeline has eight ways a run can reach a terminal state. Each one produces subtly different status values, dispatches notifications inconsistently (or not at all), and leaves the UI showing different visual cues for the same user intent. Three confirmed user-visible bugs and nine architectural inconsistencies.

### Confirmed bugs

1. **`pause` → `stop` produces no notification** (user-reported, rc3). After `pause`, the orchestrator process exits cleanly via `sys.exit(0)` (`src/worca/orchestrator/runner.py:155`). When the user then clicks `stop`, the UI route `worca-ui/server/project-routes.js:812` tries `SIGTERM` on a dead PID, falls through to a status-only rewrite (`project-routes.js:102-127`) — **no Python invocation, no webhook, no integration notification**. Same architectural shape as the rc3 known gap (JS-side terminal mutation bypasses Python dispatch) — different door.

2. **`cancel` is silent.** `POST /runs/:id/cancel` (`worca-ui/server/project-routes.js:875-905`) directly rewrites `status.json` to `pipeline_status="cancelled"`. No event written to `events.jsonl`. No webhook. No integration. Discord/Slack/Telegram never learn the run ended.

3. **JS reconciler synthetic event still bypasses dispatch.** `reconcileStatus()` (`worca-ui/server/process-manager.js:209-222`, post-W-042) appends a synthetic `pipeline.run.interrupted` event to `events.jsonl` for the SIGKILL fallback path, but Node has no access to Python's webhook/shell-hook delivery. Tracked as bead `worca-cc-77-jzf` from W-042.

### Architectural inconsistencies

4. **`PipelineInterrupted` exception ends in `failed`, not `interrupted`.** Five sources all raise `PipelineInterrupted` (control file `stop`, control webhook `abort`, `_shutdown_requested` between stages, `_shutdown_requested` during pause, signal-during-pause). The except handler at `src/worca/orchestrator/runner.py:2603-2611` sets `status["pipeline_status"] = "failed"` then emits `RUN_INTERRUPTED`. Same user intent ("stop"), two terminal states depending on which path won the race.

5. **Race condition: signal-handler `interrupted` overwritten by exception-handler `failed`.** Signal handler at `runner.py:443` (post-W-042) sets `pipeline_status="interrupted"`. Then the main thread reaches a stage boundary, raises `PipelineInterrupted`, and the except handler at line 2604 overwrites it to `"failed"`. UI may flicker `interrupted → failed`.

6. **Duplicate `RUN_INTERRUPTED` emission on signal.** Signal handler stashes an event via `_pending_signal_event` (W-042) → finally block dispatches it. Main thread also reaches `PipelineInterrupted` → `emit_event(ctx, RUN_INTERRUPTED, ...)` writes a *second* `pipeline.run.interrupted` event with `source="orchestrator"`. Webhook subscribers get notified twice for one stop.

7. **`stop` and `cancel` overlap on non-running states with different observability.** `stop` on a dead PID rewrites status silently; `cancel` rewrites status silently. Same effect, different label, both silent.

8. **`DELETE /runs/:id` is a literal duplicate of `POST /runs/:id/stop`.** `worca-ui/server/project-routes.js:742-754` calls `pm.stopPipeline()` — no actual run-directory deletion happens. Misleading API surface.

9. **`resuming` state defined but never assigned.** `worca-ui/app/utils/status-badge.js:18,32` maps `resuming → status-resuming` and `resuming → RotateCw`. No Python or Node code ever sets `pipeline_status = "resuming"`. Dead code that confuses readers.

10. **Legacy `resolve_status("interrupted") → "paused"` mapping.** `src/worca/state/status.py:201-205` defines a normalisation map that turns `interrupted` into `paused`. The function is currently uncalled, but if anyone wires it up post-W-042 it silently corrupts the new `interrupted` semantics.

11. **No state guards in UI.** Buttons remain clickable in states where the action is meaningless (e.g. `stop` button after `pause`). Server endpoints absorb the click and silently mutate state.

12. **`paused` is a process-exited state, but UI suggests "running but suspended".** When the user pauses, the Python process exits cleanly. To resume, a fresh process is spawned via `--resume`. Calling `stop` on a `paused` run is structurally meaningless — there's nothing to stop — yet the button is enabled and produces a silent state mutation.

### Bottom line

Same intent ("user stopped this") produces four different terminal states (`failed`, `interrupted`, `cancelled`, depending on which route wins). Three of those state mutations dispatch notifications; one doesn't; one dispatches twice; one dispatches inconsistently. There is no canonical answer to "did webhook subscribers get notified?".

## Proposal

Define seven canonical states with strict semantics. Make every terminal-state transition flow through a single dispatch helper that writes the event, fires webhooks, and runs integration shell-hooks — regardless of which actor (Python in-process, Node UI server, future tooling) initiated it. Add `RUN_CANCELLED` as a first-class event type. Unify all "user stopped" paths to land on `interrupted`. Add UI button gating so impossible actions are visually disabled rather than silently absorbed.

## Design

### 1. Canonical state model

Seven mutually exclusive values for `status.pipeline_status`. No others.

| State | Meaning | Terminal? | Resumable? | Set by |
|---|---|---|---|---|
| `pending` | Status row created, preflight in progress | no | n/a (auto) | `init_status()` (`src/worca/state/status.py:226`) |
| `running` | Process alive, at least one stage in flight | no | n/a | start of pipeline body (`runner.py:1368`) |
| `paused` | User paused; orchestrator process exited cleanly | yes | yes | control-file `pause` (`runner.py:150`) |
| `completed` | All enabled stages finished successfully | yes | no | end of pipeline body (`runner.py:2594` post-W-042) |
| `failed` | Pipeline died from **unintended** error | yes | yes | except branches for `PipelineError`, `LoopExhaustedError`, generic `Exception` |
| `interrupted` | Pipeline was **deliberately stopped by user** (any source) | yes | yes | unified path — see Section 5 |
| `cancelled` | Pipeline was **force-terminated, not resumable** | yes | **no** | new unified cancel path — see Section 6 |

The clean distinction:

> **`failed`** — something broke. **`interrupted`** — you stopped it but might want it back. **`cancelled`** — you killed it and meant it.

`stop_reason` discriminates the source within each terminal state:

| Terminal state | Allowed `stop_reason` values |
|---|---|
| `paused` | `control_file` |
| `failed` | `loop_exhausted`, `pipeline_error`, `<ExceptionClassName>`, `preflight_failed`, `unexpected_exit` |
| `interrupted` | `signal` (SIGTERM/SIGINT), `control_file` (control.json `action=stop`), `control_webhook` (webhook returned `abort`), `stale` (PID dead, JS-detected) |
| `cancelled` | `force_cancelled` |

`archived` is a separate boolean flag, not a state. A run can be `(state=completed, archived=true)`.

### 2. Action × state matrix (canonical)

This is the contract. Every UI button, CLI command, and HTTP endpoint must obey it.

| Action | pending | running | paused | completed | failed | interrupted | cancelled |
|---|---|---|---|---|---|---|---|
| **start (new)** | n/a (creates new run) | n/a | n/a | n/a | n/a | n/a | n/a |
| **stop** | ❌ no PID | ✅ → `interrupted` (`stop_reason=signal`) | ❌ no PID — UI greys out | ❌ already terminal | ❌ already terminal | ❌ already terminal | ❌ already terminal |
| **pause** | ❌ orchestrator not in loop | ✅ → `paused` | ❌ already paused | ❌ | ❌ | ❌ | ❌ |
| **resume** | ❌ never started | ❌ already running | ✅ → `running` | ❌ already done | ✅ → `running` | ✅ → `running` | ❌ explicitly killed |
| **cancel** | ✅ → `cancelled` | ✅ stop + → `cancelled` | ✅ → `cancelled` | ❌ no-op | ✅ → `cancelled` | ✅ → `cancelled` | ❌ no-op |
| **archive** | ✅ | ❌ refuses | ✅ | ✅ | ✅ | ✅ | ✅ |
| **unarchive** | n/a unless archived | n/a | n/a | ✅ if archived | ✅ if archived | ✅ if archived | ✅ if archived |
| **delete (real)** | ✅ | ❌ refuses | ✅ | ✅ | ✅ | ✅ | ✅ |
| **manual learn** | ❌ no plan history | ❌ races with running stages | ✅ | ✅ | ✅ | ✅ | ✅ |

Behavioral rules derived from the matrix:

- **`stop`** is meaningful **only** when a live PID exists (`running`). For all other states, the UI greys it out and the endpoint returns `409 Conflict` with `code: "no_running_process"`.
- **`cancel`** is the only action that lands on `cancelled`. If the process is alive, cancel = synchronous `stop` + state-write to `cancelled` + `RUN_CANCELLED` event.
- **`resume`** explicitly excludes `cancelled`. Cancelled means dead and meant.
- Every transition that changes `pipeline_status` MUST emit exactly one event through the universal dispatch helper (Section 3). No silent state mutations.

### 3. Universal event dispatch CLI helper

**Current state:** `dispatch_event(ctx, event)` in `src/worca/events/emitter.py` (introduced by W-042) handles webhook + shell-hook delivery for an already-built event. Reachable only from in-process Python.

**Obstacle:** Node-side state mutators (UI server's `cancel`, `stop`-on-dead-PID, `reconcileStatus`) cannot import Python. Today they write to `events.jsonl` and `status.json` directly, bypassing dispatch.

**Resolution:** Add a small Python CLI: `python -m worca.events.dispatch_external` that accepts an event payload via JSON on stdin (or `--event-json`), constructs an `EventContext` from `<run_dir>` + `settings.json`, and calls `emit_event()` (full path: write + dispatch). Node forks this process for each terminal-state mutation. Reuses 100% of the existing dispatch machinery — no logic duplicated in Node.

```bash
# Invocation contract
python -m worca.events.dispatch_external \
    --run-dir .worca/runs/<run_id> \
    --settings .claude/settings.json \
    --event-type pipeline.run.cancelled \
    --payload-json '{"cancelled_stage": "implement", "elapsed_ms": 12000, "source": "user_cancel"}'
```

Output (stdout, JSON line on success):

```json
{"ok": true, "event_id": "uuid", "dispatched_webhooks": 2, "dispatched_hooks": 1}
```

Exit codes: `0` success, `1` invalid args, `2` settings/run-dir not found, `3` dispatch error (still wrote to events.jsonl, but webhook/hook delivery had errors — non-fatal for caller).

Implementation location: `src/worca/events/dispatch_external.py` with `__main__` entry. Approximately 80 lines:

```python
# src/worca/events/dispatch_external.py (skeleton)
import argparse, json, sys
from pathlib import Path
from worca.events.emitter import EventContext, emit_event
from worca.events.types import (
    RUN_INTERRUPTED, RUN_CANCELLED, RUN_FAILED,
)

VALID_EVENT_TYPES = {RUN_INTERRUPTED, RUN_CANCELLED, RUN_FAILED}

def main(argv=None):
    p = argparse.ArgumentParser(prog="worca.events.dispatch_external")
    p.add_argument("--run-dir", required=True, help="Path to .worca/runs/<run_id>")
    p.add_argument("--settings", required=True, help="Path to .claude/settings.json")
    p.add_argument("--event-type", required=True, choices=sorted(VALID_EVENT_TYPES))
    p.add_argument("--payload-json", required=True)
    args = p.parse_args(argv)

    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        sys.exit(2)
    status_path = run_dir / "status.json"
    if not status_path.exists():
        sys.exit(2)
    status = json.loads(status_path.read_text())

    ctx = EventContext(
        run_id=status.get("run_id", run_dir.name),
        branch=status.get("branch", ""),
        work_request=status.get("work_request", {}),
        events_path=str(run_dir / "events.jsonl"),
        settings_path=args.settings,
    )
    payload = json.loads(args.payload_json)
    event = emit_event(ctx, args.event_type, payload)
    if event is None:
        sys.exit(3)
    print(json.dumps({"ok": True, "event_id": event["event_id"]}))

if __name__ == "__main__":
    main()
```

### 4. New `RUN_CANCELLED` event type

Add to `src/worca/events/types.py`:

```python
RUN_CANCELLED = "pipeline.run.cancelled"

def run_cancelled_payload(
    cancelled_stage: str,
    elapsed_ms: int,
    source: str = "user_cancel",
) -> dict:
    return {
        "cancelled_stage": cancelled_stage,
        "elapsed_ms": elapsed_ms,
        "source": source,
    }
```

`source` enum: `user_cancel` (UI cancel button), `force_cancel` (CLI/API force), `bulk_cancel` (multi-pipeline operation).

Update default integration event subscriptions (`worca-ui/app/views/integrations.js:14-29` `TIER1_EVENTS`) to include `pipeline.run.cancelled` so user gets notifications by default.

### 5. Unify all "user stopped" paths to `interrupted`

Currently three distinct code paths land on different terminal states for the same intent. Unify them.

#### 5.1 Control-file `stop` action

**Current:** `runner.py:159` sets `pipeline_status="failed"`, `stop_reason="stopped"`, then raises `PipelineInterrupted`.

**After W-043:**

```python
# src/worca/orchestrator/runner.py — _check_control_file()
elif action == "stop":
    terminate_current()
    status["pipeline_status"] = "interrupted"   # was "failed"
    status["stop_reason"] = "control_file"      # was "stopped"
    save_status(status, status_path)
    _log("Pipeline stopped by control file", "warn")
    raise PipelineInterrupted("Pipeline stopped via control file")
```

#### 5.2 Control-webhook `abort` action

**Current:** `runner.py:189` raises `PipelineInterrupted(f"Aborted via control webhook: {reason}")`. Falls through to the except handler at `runner.py:2603-2611` which sets `failed`/`stopped`.

**After W-043:** the except handler is changed (Section 5.4) to set `interrupted` for all `PipelineInterrupted` paths. The webhook-abort message is preserved in `stop_reason` via a new exception attribute.

```python
# src/worca/orchestrator/runner.py
class PipelineInterrupted(Exception):
    def __init__(self, message, stop_reason="stopped"):
        super().__init__(message)
        self.stop_reason = stop_reason

# call sites:
raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
raise PipelineInterrupted("Pipeline interrupted before stage start", stop_reason="signal")
raise PipelineInterrupted("Pipeline stopped via control file", stop_reason="control_file")
```

#### 5.3 `_shutdown_requested` between stages

Same: `raise PipelineInterrupted("Pipeline interrupted ...", stop_reason="signal")`.

#### 5.4 Unified `PipelineInterrupted` except handler

**Current** (`runner.py:2603-2611`):

```python
except PipelineInterrupted:
    status["pipeline_status"] = "failed"
    status["stop_reason"] = "stopped"
    save_status(status, actual_status_path)
    if ctx:
        emit_event(ctx, RUN_INTERRUPTED, run_interrupted_payload(
            interrupted_stage=status.get("stage", ""),
            elapsed_ms=int((time.time() - pipeline_t0) * 1000),
        ))
    raise
```

**After W-043:**

```python
except PipelineInterrupted as exc:
    status["pipeline_status"] = "interrupted"          # was "failed"
    status["stop_reason"] = exc.stop_reason             # was hardcoded "stopped"
    save_status(status, actual_status_path)
    # Suppress duplicate emit if signal handler already stashed one (same run, same stop).
    if ctx and _pending_signal_event is None:
        emit_event(ctx, RUN_INTERRUPTED, run_interrupted_payload(
            interrupted_stage=status.get("stage", ""),
            elapsed_ms=int((time.time() - pipeline_t0) * 1000),
            source=exc.stop_reason,
        ))
    raise  # Do NOT run learn on user interruption
```

This addresses inconsistency #4 (failed→interrupted), #5 (race), and #6 (duplicate emission).

### 6. New unified `cancel` flow

**Current:** `worca-ui/server/project-routes.js:875-905` directly rewrites `status.json` to `cancelled`/`force_cancelled`. No event.

**After W-043:**

```javascript
// worca-ui/server/project-routes.js — POST /runs/:id/cancel
router.post('/runs/:id/cancel', requireWorcaDir, async (req, res) => {
  const runId = req.params.id;
  if (!validateRunId(runId)) return res.status(400).json({ ok: false, error: 'Invalid runId' });

  const { worcaDir, settingsPath } = req.project;
  const statusPath = findRunStatusPath(worcaDir, runId);
  if (!statusPath) return res.status(404).json({ ok: false, error: `Run "${runId}" not found` });

  const st = JSON.parse(readFileSync(statusPath, 'utf8'));
  if (st.pipeline_status === 'completed' || st.pipeline_status === 'cancelled') {
    return res.json({ ok: true, already: st.pipeline_status });
  }

  // 1. If alive, stop synchronously (sends SIGTERM, waits up to N seconds, then SIGKILL).
  if (st.pipeline_status === 'running') {
    try {
      await req.project.pm.stopPipelineSync(runId, { timeoutMs: 5000 });
    } catch (err) {
      // already-dead is fine; continue to cancel state-write
    }
  }

  // 2. Update status to cancelled.
  st.pipeline_status = 'cancelled';
  st.stop_reason = 'force_cancelled';
  st.completed_at = new Date().toISOString();
  writeFileSync(statusPath, `${JSON.stringify(st, null, 2)}\n`, 'utf8');

  // 3. Emit RUN_CANCELLED through Python dispatch helper.
  await dispatchExternal({
    runDir: dirname(statusPath),
    settingsPath,
    eventType: 'pipeline.run.cancelled',
    payload: {
      cancelled_stage: st.stage || st.current_stage || 'unknown',
      elapsed_ms: elapsedMsSince(st.started_at),
      source: 'user_cancel',
    },
  });

  const { broadcast } = req.app.locals;
  if (broadcast) broadcast('run-cancelled', { runId });
  res.json({ ok: true, cancelled: true, runId });
});
```

`dispatchExternal()` is a small JS wrapper around `child_process.spawn('python', ['-m', 'worca.events.dispatch_external', ...])` that swallows non-zero exits but logs them. Lives in `worca-ui/server/dispatch-external.js`.

### 7. JS routes: route every state mutation through dispatch helper

Three call sites in `worca-ui/server/`:

| Site | Current behavior | After W-043 |
|---|---|---|
| `POST /runs/:id/cancel` (`project-routes.js:875`) | Silent status rewrite | Stop-if-alive + status rewrite + `dispatchExternal(RUN_CANCELLED)` |
| `POST /runs/:id/stop` fallback when PID dead (`project-routes.js:102-127`) | Silent rewrite to `failed/stale` | Reject with `409 Conflict { code: "no_running_process", suggested_action: "cancel" }` — no silent mutation |
| `reconcileStatus()` (`process-manager.js:189-222` post-W-042) | Writes synthetic event to JSONL only | After writing, also `dispatchExternal(RUN_INTERRUPTED, source="stale")` |

The `stop` endpoint **stops being a fallback force-cancel**. Its only job becomes "send signal to live process". This removes the `pause`→`stop` silent-mutation bug — clicking `stop` after `pause` now returns `409 Conflict` with a hint to use `cancel` instead. The UI button is also greyed out per Section 8.

### 8. UI button gating

**Current:** `worca-ui/app/views/run-card.js`, `worca-ui/app/views/run-list.js` always render action buttons regardless of state. Click handlers fire endpoints that may silently no-op or error.

**After W-043:** A single helper `actionAllowed(action, status)` in `worca-ui/app/utils/state-actions.js` (new file) implements the action × state matrix from Section 2. Each button uses it:

```javascript
// worca-ui/app/utils/state-actions.js (new)
export const STATES = ['pending', 'running', 'paused', 'completed', 'failed', 'interrupted', 'cancelled'];

const ACTION_MATRIX = {
  stop:    { running: true },
  pause:   { running: true },
  resume:  { paused: true, failed: true, interrupted: true },
  cancel:  { pending: true, running: true, paused: true, failed: true, interrupted: true },
  archive: { pending: true, paused: true, completed: true, failed: true, interrupted: true, cancelled: true },
  delete:  { pending: true, paused: true, completed: true, failed: true, interrupted: true, cancelled: true },
  learn:   { paused: true, completed: true, failed: true, interrupted: true, cancelled: true },
};

export function actionAllowed(action, status) {
  return Boolean(ACTION_MATRIX[action]?.[status]);
}
```

Buttons render with `?disabled=${!actionAllowed(action, run.pipeline_status)}` and a tooltip explaining why when disabled. This eliminates inconsistency #11.

### 9. Real `delete` endpoint + remove `DELETE /runs/:id` alias

**Current:** `DELETE /runs/:id` (`project-routes.js:742-754`) is a duplicate of `POST /runs/:id/stop`. No actual deletion.

**After W-043:**

- **Remove** the `DELETE /runs/:id` route — confusing alias, breaking-change, document in MIGRATION.md.
- **Add** `POST /runs/:id/delete` — refuses if `pipeline_status === 'running'` (force-stop first via cancel). Removes the entire `runs/<run_id>/` directory and clears any references in `active_run`, `multi-pipeline.json`. Emits no event (the run is gone — there's nothing to subscribe to).

### 10. Cleanup: dead code

| Item | File:line | Action |
|---|---|---|
| `resuming` state in badge map | `worca-ui/app/utils/status-badge.js:18,32` | Remove — no code path emits it. If/when needed, re-add intentionally with an event. |
| `resuming` in `isActive` check | `worca-ui/app/utils/status-badge.js:56` | Remove. |
| `resuming` in `stage-timeline.js:55`, `run-card.js:37` | UI views | Remove the conditionals. |
| `_LEGACY_STATUS_MAP` `interrupted → paused` | `src/worca/state/status.py:201-205` | Remove the `"interrupted": "paused"` entry. The other two legacy mappings (`in_progress → running`, `error → failed`) stay. |

### 11. Event flow diagram (after W-043)

```
                   ┌──────────────────────────────────────┐
                   │      Universal dispatch contract     │
                   │                                      │
                   │  Any actor → emit_event(ctx, type,   │
                   │              payload)                │
                   │           ↓                          │
                   │  events.jsonl (append)               │
                   │           ↓                          │
                   │  dispatch_event(ctx, event)          │
                   │   ├─ deliver_webhook (each)          │
                   │   └─ dispatch_shell_hooks            │
                   │       └─ Discord / Slack / Telegram  │
                   │           / webhook_out / ...        │
                   └──────────────────────────────────────┘
                           ▲                ▲
                           │                │
       ┌───────────────────┘                └────────────────────────┐
       │  In-process Python                                          │  External actors (Node, CLI)
       │                                                             │
       │  • run_pipeline() except branches                           │  python -m worca.events.dispatch_external
       │  • _check_control_file (stop/pause)                         │           ↑
       │  • PipelineInterrupted handler                              │           │
       │  • _atexit_cleanup (W-042)                                  │  • POST /runs/:id/cancel
       │  • _dispatch_pending_signal_event (W-042)                   │  • reconcileStatus() synthetic event
       │  • _emit_interrupted_event_signal_safe (W-042 — disk only)  │  • (future) third-party tools
       │      ↓ stashes for deferred dispatch                        │
       │      ↓ caller (finally / atexit) calls                      │
       │      ↓ _dispatch_pending_signal_event                       │
       │      ↓ which calls dispatch_event                           │
       │                                                             │
       └─────────────────────────────────────────────────────────────┘
```

Single contract: every state mutation that affects observers goes through `emit_event` → `dispatch_event`. No silent mutations.

## Implementation Plan

### Phase A: Foundation (event type + dispatch CLI)

**Files:**
- `src/worca/events/types.py` (add `RUN_CANCELLED`, `run_cancelled_payload`)
- `src/worca/events/dispatch_external.py` (new — CLI helper)
- `tests/test_event_types.py` (extend)
- `tests/test_dispatch_external.py` (new)

**Tasks:**
1. Add `RUN_CANCELLED` constant + `run_cancelled_payload()` builder in `events/types.py`.
2. Implement `src/worca/events/dispatch_external.py` per Section 3.
3. Unit tests: payload builder, CLI argument parsing, exit codes for missing run-dir / invalid event-type / dispatch error.
4. Integration test: spawn the CLI as a subprocess, point it at a tmp run-dir with a fake `events.jsonl`, assert the event is written and (if a `worca.webhooks` config is present in settings) `deliver_webhook` is called.

### Phase B: Python in-process unification

**Files:**
- `src/worca/orchestrator/runner.py` (PipelineInterrupted constructor, except handler, control-file/control-webhook stop_reason)
- `tests/test_runner.py`, `tests/test_runner_lifecycle.py`

**Tasks:**
1. Extend `PipelineInterrupted` exception to carry `stop_reason`.
2. Update all `raise PipelineInterrupted(...)` call sites (5 locations) to pass `stop_reason`.
3. Rewrite the `except PipelineInterrupted:` handler at `runner.py:2603-2611` per Section 5.4.
4. Update `_check_control_file()` `action=stop` branch per Section 5.1.
5. Tests:
   - `test_pipeline_interrupted_lands_on_interrupted_state` — was previously asserting `failed`.
   - `test_signal_then_stage_boundary_does_not_double_emit` — verify `_pending_signal_event` suppresses the orchestrator-path emit.
   - `test_control_file_stop_lands_on_interrupted` (was `failed`).
   - `test_control_webhook_abort_lands_on_interrupted` (was `failed`).
   - `test_pipeline_interrupted_carries_stop_reason` — new exception API.

### Phase C: JS routes use universal dispatch

**Files:**
- `worca-ui/server/dispatch-external.js` (new — JS wrapper around the CLI)
- `worca-ui/server/project-routes.js` (cancel route, stop route)
- `worca-ui/server/process-manager.js` (reconcileStatus, stopPipelineSync)
- `worca-ui/server/test/project-routes-cancel.test.js` (new)
- `worca-ui/server/test/process-manager-reconcile.test.js` (extend)

**Tasks:**
1. Implement `dispatch-external.js` — `await dispatchExternal({ runDir, settingsPath, eventType, payload })`.
2. Add `pm.stopPipelineSync(runId, { timeoutMs })` — SIGTERM, wait for exit, SIGKILL if timeout. Returns `{ pid, exitCode }`.
3. Rewrite cancel route per Section 6.
4. Rewrite stop route's PID-dead fallback to return `409 Conflict` (no silent mutation). Document in MIGRATION.md.
5. Update `reconcileStatus()` to call `dispatchExternal` after writing the synthetic event.
6. Tests:
   - cancel from each starting state (`running`, `paused`, `failed`, `interrupted`) hits dispatch helper.
   - cancel on `cancelled` is a no-op (returns `already: cancelled`).
   - stop on dead PID returns 409 with `code: "no_running_process"`.
   - reconcile invokes `dispatchExternal` (mocked).

### Phase D: UI button gating

**Files:**
- `worca-ui/app/utils/state-actions.js` (new)
- `worca-ui/app/utils/state-actions.test.js` (new)
- `worca-ui/app/views/run-card.js`
- `worca-ui/app/views/run-list.js`
- `worca-ui/app/views/multi-dashboard.js` (bulk action gating)

**Tasks:**
1. Implement `actionAllowed(action, status)` per Section 8.
2. Wire into all run-action buttons. Add `<sl-tooltip>` with reason when disabled.
3. Unit tests for `actionAllowed` covering all 7 states × 8 actions = 56 cells.
4. Add a Cancel button next to Stop in run-card (currently only Stop exists).

### Phase E: Cleanup

**Files:**
- `worca-ui/app/utils/status-badge.js` (remove `resuming`)
- `worca-ui/app/views/stage-timeline.js`, `run-card.js` (remove `resuming` checks)
- `src/worca/state/status.py` (remove legacy `interrupted → paused`)
- `worca-ui/server/project-routes.js` (remove `DELETE /runs/:id` alias, add real `POST /runs/:id/delete`)
- `worca-ui/server/process-manager.js` (add `deleteRun` method)
- `tests/test_status.py` (remove the `resolve_status_maps_interrupted_to_paused` test)
- `MIGRATION.md` (document breaking changes)

**Tasks:**
1. Remove `resuming` from badge map and all references.
2. Remove `_LEGACY_STATUS_MAP` `"interrupted": "paused"` entry; update test.
3. Remove `DELETE /runs/:id` route (was a duplicate).
4. Add `POST /runs/:id/delete` route + `pm.deleteRun(runId)` method.
5. Update MIGRATION.md with the breaking changes (terminal state for control-file/webhook stop; removed DELETE alias; `stop` no longer force-cancels dead PIDs).

### Files Changed Summary

| File | Phase | Change |
|------|-------|--------|
| `src/worca/events/types.py` | A | Add `RUN_CANCELLED`, `run_cancelled_payload` |
| `src/worca/events/dispatch_external.py` | A | New — CLI helper |
| `tests/test_event_types.py` | A | Extend with `RUN_CANCELLED` cases |
| `tests/test_dispatch_external.py` | A | New |
| `src/worca/orchestrator/runner.py` | B | `PipelineInterrupted` constructor; 5 `raise` call sites; except handler; `_check_control_file` stop branch |
| `tests/test_runner.py` | B | Update existing PipelineInterrupted tests; add new |
| `tests/test_runner_lifecycle.py` | B | Update lifecycle tests for new terminal state |
| `worca-ui/server/dispatch-external.js` | C | New — JS wrapper |
| `worca-ui/server/project-routes.js` | C, E | Cancel route rewrite; stop route 409; remove DELETE alias; add delete route |
| `worca-ui/server/process-manager.js` | C, E | `stopPipelineSync`, reconciler dispatch call, `deleteRun` |
| `worca-ui/server/test/project-routes-cancel.test.js` | C | New |
| `worca-ui/server/test/process-manager-reconcile.test.js` | C | Extend |
| `worca-ui/app/utils/state-actions.js` | D | New |
| `worca-ui/app/utils/state-actions.test.js` | D | New |
| `worca-ui/app/views/run-card.js` | D | Use `actionAllowed`; add Cancel button |
| `worca-ui/app/views/run-list.js` | D | Use `actionAllowed` |
| `worca-ui/app/views/multi-dashboard.js` | D | Bulk action gating |
| `worca-ui/app/utils/status-badge.js` | E | Remove `resuming` |
| `worca-ui/app/views/stage-timeline.js` | E | Remove `resuming` checks |
| `src/worca/state/status.py` | E | Remove legacy `interrupted → paused` |
| `tests/test_status.py` | E | Remove obsolete test |
| `MIGRATION.md` | E | Document breaking changes |
| `CLAUDE.md` | C | Add rule: "JS state mutations must invoke `dispatch_external`" |

## Considerations

### Breaking changes

1. **Control-file `stop` action terminal state changes from `failed` to `interrupted`.** Anyone querying `pipeline_status === 'failed'` to detect user-stops will miss them after upgrade. Mitigation: webhook subscribers should always look at `event_type` (`pipeline.run.interrupted` vs `pipeline.run.failed`), not status.json. Documented in MIGRATION.md.
2. **Control-webhook `abort` action terminal state changes from `failed` to `interrupted`.** Same mitigation.
3. **`POST /runs/:id/stop` no longer silently force-cancels dead PIDs.** Returns `409 Conflict` with `code: "no_running_process"`. Callers (UI, third-party scripts) must switch to `POST /runs/:id/cancel` for force-terminate semantics. UI is updated in Phase D.
4. **`DELETE /runs/:id` removed.** Was a duplicate of stop. Callers migrate to `POST /runs/:id/stop` (signal) or `POST /runs/:id/cancel` (force).
5. **`pipeline.run.cancelled` is a new event type.** Webhook/integration subscribers may receive a previously-unseen event type. Default `TIER1_EVENTS` (UI integration setup) includes it so users get notifications by default.

### Migration

`MIGRATION.md` adds a `### Upgrading to W-043 / 0.16.0` section:

```markdown
### Upgrading to 0.16.0

- **Terminal state for user-stop unified to `interrupted`.** Previously, control-file stop and control-webhook abort produced `failed`; signal stop produced `interrupted`. Now all user-stop paths land on `interrupted`. If your webhook subscribers gate on `pipeline_status === "failed"`, switch to `event_type === "pipeline.run.failed"` (which is unaffected — only true errors now produce `failed`).

- **`POST /runs/:id/stop` rejects dead-PID requests.** Returns `409 Conflict` instead of silently rewriting status. Use `POST /runs/:id/cancel` to force-terminate any non-running pipeline.

- **`DELETE /runs/:id` removed.** It was an alias for stop. Use `POST /runs/:id/stop` or `POST /runs/:id/cancel`. A real delete endpoint is now `POST /runs/:id/delete`.

- **New event `pipeline.run.cancelled`.** Fires whenever a pipeline reaches terminal state via the cancel action. Subscribed by default in the integration TIER1_EVENTS list.
```

### Governance / dispatch invariant

After W-043, the contract is:

> Every `pipeline.*` event observable through `events.jsonl` MUST be produced by `emit_event()` (which calls `dispatch_event()`). No code path may write to `events.jsonl` without invoking dispatch.

Add this as a code-review checklist item in `CLAUDE.md`. A future post_tool_use hook could grep for `appendFileSync.*events.jsonl` and similar Python patterns to enforce mechanically.

### Performance

`dispatchExternal()` spawns a Python subprocess per state mutation. State mutations are user-initiated and rare (cancel, reconcile-stale, etc.) — not in any hot path. Cold-start cost ~150ms per invocation, acceptable for these flows. If profile shows it matters, batch via a long-running helper process; not worth optimising now.

### Edge cases

- **Concurrent cancel + signal:** if user clicks cancel while SIGTERM is already in flight from another source, both write `events.jsonl` (signal handler stashes, then cancel emits RUN_CANCELLED). Expected behaviour: webhook subscribers see `pipeline.run.interrupted` (from signal) followed by `pipeline.run.cancelled`. The `cancel` rewrites the terminal status to `cancelled` (overwrites `interrupted`), so resume is correctly blocked. Document in test plan.
- **Cancel on `paused`:** no live PID, but state goes to `cancelled` and `RUN_CANCELLED` fires. Correct.
- **Reconcile race with running orchestrator:** if reconciler triggers between status update and PID cleanup, it may emit a spurious `interrupted/stale` event. Mitigation: reconciler already checks PID liveness; the race window is the brief gap between the orchestrator's `finally` block and PID-file removal. In practice never observed; if it surfaces, add a 500ms grace period to the reconciler.

## Test Plan

### Unit tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_run_cancelled_payload_required_fields` | New payload builder shape + `source` enum |
| Python | `test_dispatch_external_writes_event` | CLI subprocess writes correct event to events.jsonl |
| Python | `test_dispatch_external_invokes_dispatch_event` | CLI subprocess calls `dispatch_event` (webhook + shell-hook) |
| Python | `test_dispatch_external_exits_2_on_missing_run_dir` | Error handling |
| Python | `test_pipeline_interrupted_carries_stop_reason` | Exception API |
| Python | `test_pipeline_interrupted_handler_lands_on_interrupted` | Was `failed` |
| Python | `test_control_file_stop_lands_on_interrupted` | Section 5.1 |
| Python | `test_control_webhook_abort_lands_on_interrupted` | Section 5.2 |
| Python | `test_signal_does_not_duplicate_emit` | `_pending_signal_event` suppression |
| JS | `actionAllowed`: 56 cells | Action × state matrix coverage |
| JS | `dispatchExternal` spawns Python with correct args | Subprocess wrapper |
| JS | cancel from each state | Section 6 |
| JS | stop on dead PID returns 409 | Section 7 |
| JS | reconciler invokes dispatchExternal | Section 7 |

### Integration tests

| Scenario | Expected outcome |
|---|---|
| Start → pause → cancel | Status: `cancelled`. Events: `RUN_STARTED`, `RUN_PAUSED`, `RUN_CANCELLED`. Webhook + integration each receive 3 events. |
| Start → SIGTERM → wait | Status: `interrupted` (`stop_reason=signal`). Events: `RUN_STARTED`, `RUN_INTERRUPTED` (exactly once). |
| Start → SIGTERM during pause-poll | Status: `interrupted`. Events: `RUN_STARTED`, `RUN_PAUSED`, `RUN_INTERRUPTED`. |
| Start → control-file stop | Status: `interrupted` (`stop_reason=control_file`). Webhook gets `RUN_INTERRUPTED`. |
| Start → control-webhook abort | Status: `interrupted` (`stop_reason=control_webhook`). |
| Pause → stop (user-reported bug) | UI button greyed out. Programmatic POST returns 409. No silent mutation. |
| Cancel after SIGKILL | Reconciler emits `RUN_INTERRUPTED` first (`stop_reason=stale`), cancel emits `RUN_CANCELLED`. Status ends `cancelled`. |
| Resume from `cancelled` | UI button greyed out. Programmatic POST returns 409. |

### Existing tests to update

- `tests/test_status.py::test_resolve_status_maps_interrupted_to_paused` — **delete** (legacy mapping removed).
- `tests/test_runner.py` — any test asserting `pipeline_status == 'failed'` after `PipelineInterrupted` must change to `interrupted`.
- `worca-ui/server/test/process-manager-reconcile.test.js` — extend to verify `dispatchExternal` is called (mocked).
- W-042 tests for `_pending_signal_event` already exist; extend to cover the orchestrator-path suppression.

### Done criteria

- All Python tests pass (`pytest tests/`).
- All JS tests pass (`npx vitest run` in `worca-ui/`).
- `ruff check .` clean.
- `cd worca-ui && npm run lint` clean.
- Manual smoke test on `test-multi-02` matching the user's pause→stop scenario: notification fires for `RUN_PAUSED` AND for `RUN_CANCELLED`.

## Files to Create/Modify

See "Files Changed Summary" table in the Implementation Plan section.

## Out of Scope

- **Status migration tooling for old runs.** Existing `runs/<run_id>/status.json` files with `pipeline_status="failed"` from previous control-file stops will not be retroactively reclassified. Migration is forward-only; old runs keep their historical state.
- **Webhook delivery batching / persistent helper process.** Per-mutation Python subprocess spawn (~150ms) is acceptable for cancel/stop frequency. Optimisation deferred until profiled.
- **Status state machine validator.** Could add a runtime check that rejects any `pipeline_status` write not matching the canonical 7 values. Considered but deferred — the proposal removes the bad call sites; validator is belt-and-suspenders.
- **Bulk-cancel atomic guarantees.** Multi-pipeline cancel iterates per-run; no atomic group commit. If one fails halfway, callers see partial state. Out of scope.
- **GraphQL/REST API versioning.** The breaking endpoint changes (`DELETE` removed, `stop` now 409) are documented in MIGRATION.md but not version-gated. Acceptable for pre-1.0.
