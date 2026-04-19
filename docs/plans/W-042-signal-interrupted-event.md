# W-042: Pipeline stop should emit run.interrupted event

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-04-19
**Depends on:** None

## Problem

When a pipeline is stopped via the UI or `kill`, the process is terminated before the orchestrator can emit a `pipeline.run.interrupted` event. The signal handler in `src/worca/orchestrator/runner.py:346` (`_handler`) updates `status.json` to `failed` but never writes to `events.jsonl` or delivers webhooks. This means integrations (Telegram, Discord, etc.) never learn the run ended.

Three stop paths exist:

1. **Control file path** — orchestrator polls `control.json` at iteration boundaries (`runner.py:129`), raises `PipelineInterrupted`, emits `RUN_INTERRUPTED`. **This works.**
2. **SIGTERM path** — signal arrives mid-stage. `_handler()` (`runner.py:346`) persists `status.json` but **never emits the event**.
3. **SIGKILL path** — JS watchdog (`process-manager.js:392`) force-kills after 10s. No Python code runs. `reconcileStatus()` (`process-manager.js:117`) fixes `status.json` but **never writes an event**.

## Proposal

Emit `pipeline.run.interrupted` in the two broken paths:

1. In the Python signal handler — write the event directly to `events.jsonl` (best-effort, no webhook delivery in signal context).
2. In the JS `reconcileStatus()` — append a synthetic event to `events.jsonl` as a SIGKILL fallback.

## Design

### 1. Python signal handler emits event to JSONL

- **Current state:** `src/worca/orchestrator/runner.py:346-362` — `_handler()` sets `pipeline_status="failed"`, saves `status.json`, cleans PID files. No event emission.
- **Obstacle:** The signal handler runs in an interrupt context. Calling `emit_event()` would attempt webhook delivery (HTTP calls, threads) which is unsafe in a signal handler. The `EventContext` object (`ctx`) is a local variable in `run_pipeline()` — not accessible from the module-level `_handler`.
- **Resolution:** Add a module-level `_signal_event_ctx` reference (same pattern as `_signal_status`). In the signal handler, write a single JSONL line directly to `events.jsonl` using only signal-safe operations (open, write, close — no threads, no HTTP). Skip webhook delivery entirely.

```python
# Module-level — add alongside _signal_status/_signal_status_path
_signal_event_ctx = None  # set to EventContext when run starts

# In _handler(), after save_status():
if _signal_event_ctx is not None:
    try:
        import json, uuid
        from datetime import datetime, timezone
        event = {
            "schema_version": "1",
            "event_id": str(uuid.uuid4()),
            "event_type": "pipeline.run.interrupted",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "run_id": _signal_event_ctx.run_id,
            "pipeline": {
                "branch": _signal_event_ctx.branch,
                "work_request": _signal_event_ctx.work_request,
            },
            "payload": {
                "interrupted_stage": _signal_status.get("current_stage", "unknown"),
                "elapsed_ms": 0,  # best-effort, no timer in signal context
                "source": "signal",
            },
        }
        with open(_signal_event_ctx.events_path, "a") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        pass
```

Set `_signal_event_ctx = ctx` at `runner.py:1189` (right after `EventContext` creation) and clear it in the `finally` block at `runner.py:2608`.

### 2. JS reconcileStatus() writes fallback event

- **Current state:** `worca-ui/server/process-manager.js:117-176` — `reconcileStatus()` scans for stale `running` status, sets it to `failed` with `stop_reason="stale"`. No event written.
- **Obstacle:** The JS side doesn't know the event schema or have access to the Python `EventContext`.
- **Resolution:** After fixing `status.json`, check if `events.jsonl` already contains a `pipeline.run.interrupted` or `pipeline.run.failed` terminal event for this run. If not, append a synthetic one.

```javascript
// After writeFileSync(statusPath, ...) in reconcileStatus():
const eventsPath = join(this.worcaDir, 'runs', runId, 'events.jsonl');
try {
  // Check if a terminal event already exists
  const eventsContent = existsSync(eventsPath)
    ? readFileSync(eventsPath, 'utf8')
    : '';
  const hasTerminal = eventsContent.includes('"pipeline.run.interrupted"')
    || eventsContent.includes('"pipeline.run.failed"')
    || eventsContent.includes('"pipeline.run.completed"');

  if (!hasTerminal) {
    const { randomUUID } = await import('node:crypto');
    const event = {
      schema_version: '1',
      event_id: randomUUID(),
      event_type: 'pipeline.run.interrupted',
      timestamp: new Date().toISOString(),
      run_id: runId,
      pipeline: {
        branch: status.branch || '',
        work_request: status.work_request || {},
      },
      payload: {
        interrupted_stage: status.current_stage || status.stage || 'unknown',
        elapsed_ms: 0,
        source: 'reconcile',
      },
    };
    appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
  }
} catch { /* best-effort */ }
```

### 3. Status should be "interrupted" not "failed"

Both the signal handler and reconcileStatus currently set `pipeline_status = "failed"`. When the cause is an explicit stop (via control.json, SIGTERM, or SIGKILL), the status should be `"interrupted"` to distinguish from actual errors. Check `stop_reason` — if it's `"stopped"`, `"signal"`, or `"stale"` (reconcile), use `"interrupted"` as the status value.

This requires checking that `"interrupted"` is a valid pipeline status throughout the codebase (status rendering, UI filters, etc.).

## Implementation Plan

### Phase 1: Python signal handler event emission

**Files:** `src/worca/orchestrator/runner.py`
**Tasks:**
1. Add `_signal_event_ctx = None` at module level (`runner.py:117`)
2. In `_handler()` (`runner.py:346`): after `save_status()`, write `pipeline.run.interrupted` event directly to `events.jsonl` using the `_signal_event_ctx` reference
3. Set `_signal_event_ctx = ctx` after EventContext creation (`runner.py:~1189`)
4. Clear `_signal_event_ctx = None` in the finally block (`runner.py:~2608`)
5. In `_atexit_cleanup()` (`runner.py:374`): also write the event if `_signal_event_ctx` is available

### Phase 2: JS reconcileStatus fallback event

**Files:** `worca-ui/server/process-manager.js`
**Tasks:**
1. Import `appendFileSync` from `node:fs` (if not already imported)
2. In `reconcileStatus()` (`process-manager.js:166-176`): after writing fixed status, check `events.jsonl` for existing terminal event; if missing, append a synthetic `pipeline.run.interrupted` event
3. Add `crypto` import for `randomUUID`

### Phase 3: Use "interrupted" status value

**Files:** `src/worca/orchestrator/runner.py`, `worca-ui/server/process-manager.js`
**Tasks:**
1. In `_handler()`: set `pipeline_status = "interrupted"` instead of `"failed"` when stop is intentional
2. In `_atexit_cleanup()`: keep `"failed"` for `unexpected_exit` (this is a real error)
3. In `reconcileStatus()`: set `pipeline_status = "interrupted"` instead of `"failed"` when `stop_reason` indicates intentional stop
4. Verify UI handles `"interrupted"` status (check `statusClass`/`statusIcon`/`resolveStatus` in `worca-ui/app/utils/status-badge.js`)

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/runner.py` | Add `_signal_event_ctx`, emit event in `_handler()` and `_atexit_cleanup()`, use `"interrupted"` status |
| `worca-ui/server/process-manager.js` | Emit fallback event in `reconcileStatus()`, use `"interrupted"` status |
| `tests/test_runner_lifecycle.py` | Add tests for event emission in signal handler |
| `worca-ui/server/test/process-manager-reconcile.test.js` | Add tests for fallback event in reconcileStatus |

## Considerations

- **Signal safety:** The handler must avoid threads, locks, or HTTP. Direct file append with `open()`/`write()`/`close()` is signal-safe on POSIX. No webhook delivery in signal context — integrations pick up the event from `events.jsonl` via the UI server's watcher/polling.
- **Race condition:** If SIGTERM arrives just as the orchestrator is polling `control.json`, both paths might try to emit `RUN_INTERRUPTED`. This is harmless — duplicate events are better than zero events. Consumers should be idempotent on terminal events.
- **SIGKILL:** Python cannot intercept SIGKILL. The JS fallback in `reconcileStatus()` is the only option. The `source: "reconcile"` field distinguishes this from a clean signal shutdown.
- **Elapsed time:** The signal handler doesn't have a reliable timer reference. `elapsed_ms: 0` with `source: "signal"` is acceptable — consumers can derive timing from `pipeline.run.started` timestamp.
- **"interrupted" status value:** If `"interrupted"` is not already handled in status rendering (badges, icons), it needs to be added. This is a small change — `resolveStatus()` and `statusClass()` in `status-badge.js` likely need a new case.
- **Breaking changes:** None. New events are additive. The `"interrupted"` status is a new value but only triggers when the run is stopped — previously this was incorrectly reported as `"failed"`.

## Test Plan

### Unit Tests — Python

| Test | Validates |
|------|-----------|
| `test_signal_handler_emits_interrupted_event` | `_handler()` writes `pipeline.run.interrupted` to `events.jsonl` when `_signal_event_ctx` is set |
| `test_signal_handler_no_event_when_ctx_not_set` | `_handler()` is safe when `_signal_event_ctx` is None |
| `test_signal_handler_sets_interrupted_status` | `_handler()` writes `pipeline_status="interrupted"` (not `"failed"`) |
| `test_atexit_emits_event` | `_atexit_cleanup()` writes event when status was `"running"` |
| `test_atexit_no_event_when_already_terminal` | `_atexit_cleanup()` skips event when status is already `"failed"` |

### Unit Tests — JavaScript

| Test | Validates |
|------|-----------|
| `test_reconcile_writes_interrupted_event` | `reconcileStatus()` appends event to `events.jsonl` when no terminal event exists |
| `test_reconcile_skips_event_when_already_exists` | `reconcileStatus()` does not append duplicate when `pipeline.run.interrupted` already in JSONL |
| `test_reconcile_sets_interrupted_status` | Status is `"interrupted"` not `"failed"` after reconcile |

### Existing Tests to Update

| File | Change needed |
|------|---------------|
| `tests/test_runner_lifecycle.py:test_signal_handler_saves_failed_status` | Update assertion from `"failed"` to `"interrupted"`, verify event in JSONL |
| `worca-ui/server/test/process-manager-reconcile.test.js` | Update assertions for `"interrupted"` status where stop was intentional |

## Out of Scope

- Webhook delivery from the signal handler (unsafe in signal context; consumers poll JSONL)
- Formal JSON schema / OpenAPI spec for event types
- Webhook timeout guards for sync delivery at pause points
- `pipeline.stage.interrupted` emission on resume for stages that were mid-flight
