# W-043: Unified pipeline state model + universal event dispatch

**Status:** Draft (rev 3 — concern-driven amendments: dispatch timeout, stop_reason safety, Windows polling gap)
**Priority:** P1
**Area:** cc + ui
**Date:** 2026-04-19
**Depends on:** W-042 (PR #108) — `dispatch_event()` helper, `_pending_signal_event`, signal-deferred dispatch are introduced there and assumed present.
**Target platforms:** macOS, Linux, Windows — see §12 for platform-specific handling.

## Revision Notes (rev 3)

Rev 3 addresses three concerns identified during deep code analysis of rev 2:

- **Concern 1 — Daemon thread latency underestimated.** §3.1 claimed "~10s per webhook" for `deliver_webhook_sync()`. Actual worst case with defaults (`timeout_ms=5000`, `max_retries=3`, exponential backoff 1+2+4s) is **27s per webhook**. The `dispatchExternal` timeout was 15s — would kill the subprocess mid-retry on the first webhook. §3.1 now states the real formula; §6/C+D raises `dispatchExternal` default timeout to 60s. Safe because dispatch runs after the HTTP response is sent.
- **Concern 2 — Silent failure on missed `stop_reason`.** `PipelineInterrupted(message, stop_reason="stopped")` with a default meant missed sites silently produce wrong metadata. §5.2 now makes `stop_reason` a **required keyword argument** (no default) — any missed site raises `TypeError` at runtime. The f-string variant at line 190 is explicitly called out in the Phase B table.
- **Concern 3 — Windows control-file polling gap.** `_check_control_file()` polls once per stage loop iteration. During a blocking `run_agent()` call (2-5 minutes for a Claude turn), no polling occurs. The 5s `stopPipelineSync` timeout force-kills every time. §12.1 now: (a) increases Windows timeout to 30s, (b) adds agent subprocess termination to unblock polling, (c) writes agent PID to `<run_dir>/agent.pid` for Node-side kill. New integration test validates mid-stage graceful stop on Windows.

## Revision Notes (rev 2)

Rev 2 incorporates findings from a code-level review of rev 1:

- **Critical:** `deliver_webhook()` (`src/worca/events/webhook.py:263`) starts a **daemon thread** for each HTTP POST. In a short-lived `dispatch_external` CLI subprocess, the interpreter exits before the thread finishes and webhooks are silently truncated. §3.1 now specifies a `sync=True` path through `deliver_webhook_sync()`.
- **Cross-platform:** Windows has no SIGTERM-to-user-handler delivery; `process.kill(pid, 'SIGTERM')` on Windows is equivalent to `TerminateProcess`. The signal-unification in §5 is Unix-only; on Windows, `control.json` (graceful) + reconciler (fallback) are the primary paths. New §12 documents the full platform matrix.
- **Scope correction:** Phase B previously claimed "5 `raise PipelineInterrupted(...)` call sites" — there are actually **21** in `runner.py` (17 are identical `"Aborted via control webhook"` inside stage loops). Task list updated.
- **Line-reference drift fixed:** `runner.py:2603-2611` → `2641-2650` (except handler); `project-routes.js:102-127` → `842-867` (stop fallback); `process-manager.js:189-222` → `131-238` (reconcileStatus). Rev 1 references were from an older snapshot.
- **§7 mischaracterization fixed:** the stop-on-dead-PID fallback writes `cancelled/force_cancelled` today (identical to `/cancel`), not `failed/stale` as rev 1 claimed.
- **Phase ordering:** C and D now ship as one PR — shipping C alone would produce silent Stop-button failures for paused runs because the UI has no Cancel button yet.
- **New edge cases:** concurrent cancel+signal and Windows force-kill paths added to §Test Plan.

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

**Resolution:** Add a small Python CLI: `python -m worca.events.dispatch_external` that accepts event args on argv, constructs an `EventContext` from `<run_dir>` + `settings.json`, and calls `emit_event(..., sync=True)` (full path: write + sync dispatch). Node forks this process for each terminal-state mutation. Reuses the existing dispatch machinery — no logic duplicated in Node.

#### 3.1 Dispatch-lifetime contract (critical — daemon-thread trap)

`deliver_webhook()` (`src/worca/events/webhook.py:263`) starts a **daemon thread** per HTTP POST and returns immediately:

```python
t = threading.Thread(target=_do_post, args=(event, webhook_cfg), daemon=True)
t.start()
```

In the long-lived orchestrator this is safe — the process lives long enough for the daemon thread to complete its round-trip. In a short-lived CLI helper, `emit_event()` returns in milliseconds, the interpreter exits, and **all daemon threads are killed mid-flight**. Webhooks would be silently truncated (swapping one silent-failure mode for another).

**Resolution:** `dispatch_event()` gains a `sync: bool = False` parameter. When `sync=True`:

- Webhook delivery uses `deliver_webhook_sync()` (already implemented for control webhooks — same signing, retries, filtering, error handling — just blocking).
- Shell-hook dispatch stays `subprocess.Popen` fire-and-forget. On Unix AND Windows, spawned children survive parent exit (no job-object binding). Stdin is written and closed synchronously before Popen returns, so hook commands receive the full event payload even if the CLI exits immediately after.

```python
# src/worca/events/emitter.py (change)
def dispatch_event(ctx, event, *, sync: bool = False) -> None:
    if ctx._webhooks:
        from worca.events.webhook import deliver_webhook, deliver_webhook_sync
        deliver = deliver_webhook_sync if sync else deliver_webhook
        try:
            for wh in ctx._webhooks:
                deliver(event, wh)
        except Exception as exc:
            print(f"[worca.events] Webhook dispatch error: {exc}", file=sys.stderr)
    # Shell hooks unchanged — Popen(shell=True) fire-and-forget is cross-platform safe.
    ...

def emit_event(ctx, event_type, payload, *, sync: bool = False):
    # ... existing write to events.jsonl ...
    dispatch_event(ctx, event, sync=sync)
    return event
```

CLI invokes `emit_event(..., sync=True)`. Orchestrator in-process call sites keep the default (`sync=False`) — unchanged behavior.

**Trade-off:** sequential webhook delivery in the CLI. Bounded latency per webhook is `timeout_ms × (max_retries + 1) + Σ(2^i for i in 0..max_retries-1)`. With defaults (`timeout_ms=5000`, `max_retries=3`): 5s × 4 attempts + 7s backoff = **27s per webhook**. With 2 subscribers: ~54s worst case. The JS caller (`dispatchExternal`) imposes its own `timeoutMs` (default 60s — must exceed the worst-case delivery time for configured webhooks) and decouples dispatch from the HTTP response — see §6. The user never waits; only webhook delivery is subject to this latency.

#### 3.2 Invocation contract

```bash
python -m worca.events.dispatch_external \
    --run-dir .worca/runs/<run_id> \
    --settings .claude/settings.json \
    --event-type pipeline.run.cancelled \
    --payload-json '{"cancelled_stage": "implement", "elapsed_ms": 12000, "source": "user_cancel"}'
```

Output (stdout, one JSON line on success):

```json
{"ok": true, "event_id": "uuid", "dispatched_webhooks": 2, "dispatched_hooks": 1}
```

Exit codes: `0` success, `1` invalid args, `2` settings/run-dir/status.json not found, `3` event written to events.jsonl but one or more deliveries failed (non-fatal for caller; details on stderr).

Argv form (not stdin) is chosen deliberately: Windows `child_process.spawn` pipe semantics can differ from Unix for large stdin writes, and argv is simpler for small event payloads. If payloads ever exceed ~32KB (Windows argv limit is 32767 chars), switch to `--payload-file <path>`.

#### 3.3 Cross-platform invocation

Node resolves the Python interpreter per OS — see §12.2. The CLI forces UTF-8 on stdout/stderr — see §12.3.

#### 3.4 Skeleton

Implementation location: `src/worca/events/dispatch_external.py` with `__main__` entry. Approximately 100 lines:

```python
# src/worca/events/dispatch_external.py (skeleton)
import argparse, io, json, sys
from pathlib import Path
from worca.events.emitter import EventContext, emit_event
from worca.events.types import (
    RUN_INTERRUPTED, RUN_CANCELLED, RUN_FAILED,
)

VALID_EVENT_TYPES = {RUN_INTERRUPTED, RUN_CANCELLED, RUN_FAILED}


def main(argv=None):
    # Force UTF-8 I/O — Windows defaults stdout/stderr to cp1252 which breaks
    # on branch names / work_request strings containing non-ASCII characters.
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="\n")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", newline="\n")

    p = argparse.ArgumentParser(prog="worca.events.dispatch_external")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--settings", required=True)
    p.add_argument("--event-type", required=True, choices=sorted(VALID_EVENT_TYPES))
    p.add_argument("--payload-json", required=True)
    args = p.parse_args(argv)

    run_dir = Path(args.run_dir)
    status_path = run_dir / "status.json"
    if not run_dir.exists() or not status_path.exists():
        sys.exit(2)
    status = json.loads(status_path.read_text(encoding="utf-8"))

    ctx = EventContext(
        run_id=status.get("run_id", run_dir.name),
        branch=status.get("branch", ""),
        work_request=status.get("work_request", {}),
        events_path=str(run_dir / "events.jsonl"),
        settings_path=args.settings,
    )
    try:
        payload = json.loads(args.payload_json)
        event = emit_event(ctx, args.event_type, payload, sync=True)
    finally:
        ctx.close()
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
    def __init__(self, message, *, stop_reason):  # keyword-only, REQUIRED — no default
        super().__init__(message)
        self.stop_reason = stop_reason
```

`stop_reason` is intentionally required (no default). Any call site that omits it raises `TypeError: missing required keyword argument 'stop_reason'` at runtime — failing loudly rather than silently producing wrong metadata. The AST lint test (Phase B task 7) is a belt-and-suspenders check, not the sole safety net.

```python
# call sites:
raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
raise PipelineInterrupted("Pipeline interrupted before stage start", stop_reason="signal")
raise PipelineInterrupted("Pipeline stopped via control file", stop_reason="control_file")
```

**Note:** line 190 is an f-string variant: `f"Aborted via control webhook: {reason}"` — it must not be missed during the bulk find/replace of the 16 identical bare-string sites.

#### 5.3 `_shutdown_requested` between stages

Same: `raise PipelineInterrupted("Pipeline interrupted ...", stop_reason="signal")`.

#### 5.4 Unified `PipelineInterrupted` except handler

**Current** (`runner.py:2641-2650` — verify line range before editing, as post-W-042 surgery may have shifted them further):

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

`dispatchExternal()` is a small JS wrapper around `child_process.spawn('python', ['-m', 'worca.events.dispatch_external', ...])` that swallows non-zero exits but logs them. Lives in `worca-ui/server/dispatch-external.js`. Default `timeoutMs` is **60s** — must exceed the worst-case `deliver_webhook_sync` latency for 2 webhooks with default retry config (~54s). Safe because dispatch runs after the HTTP response is sent (§Considerations).

### 7. JS routes: route every state mutation through dispatch helper

Four call sites in `worca-ui/server/`:

| Site | Current behavior | After W-043 |
|---|---|---|
| `POST /runs/:id/cancel` (`project-routes.js:875-905`) | Silent rewrite to `cancelled/force_cancelled`; no event, no webhook, no integration | Stop-if-alive (`stopPipelineSync`) + status rewrite + `dispatchExternal(RUN_CANCELLED)` |
| `POST /runs/:id/stop` fallback when PID dead (`project-routes.js:842-867`) | Silent rewrite to `cancelled/force_cancelled` — **identical behavior to the cancel endpoint today**, making stop an undocumented alias for cancel | Reject with `409 Conflict { code: "no_running_process", suggested_action: "cancel" }` — no silent mutation |
| `DELETE /runs/:id` (`project-routes.js:742-754`) | Silent `pm.stopPipeline()` — not a deletion despite the verb | Remove the route; add real `POST /runs/:id/delete` (§9) |
| `reconcileStatus()` (`process-manager.js:131-238` post-W-042) | Maps stale `running` → `interrupted/stale`; writes synthetic event to JSONL only | After writing, also `dispatchExternal(RUN_INTERRUPTED, source="stale")` — this becomes the **primary** terminal-state path on Windows (see §12.1) |

The `stop` endpoint **stops being a fallback force-cancel**. Its only job becomes "signal the live process" (Unix) or "write control.json and wait, with reconciler fallback" (Windows — see §12). This removes the `pause`→`stop` silent-mutation bug: clicking `stop` after `pause` now returns `409 Conflict` with `suggested_action: "cancel"`. The UI button is also greyed out per §8.

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

#### 8.1 Shared matrix: single source of truth

`ACTION_MATRIX` is the canonical definition. To prevent drift between client-side gating and server-side validation:

- **Server imports the same matrix.** `project-routes.js` imports `actionAllowed` from `../app/utils/state-actions.js`. The module is pure JS with no DOM references; it is safe to load in Node. Each mutating endpoint calls `actionAllowed(action, currentStatus)` before mutating and returns `409 Conflict { code: "action_not_allowed" }` when it returns false — a belt-and-braces check behind the UI gating.
- **Unit test enforces completeness.** `state-actions.test.js` iterates the cartesian product of `STATES × actions` and fails if a cell is neither `true` nor explicitly absent. New states therefore require explicit matrix entries before tests pass.
- **Python does not import the matrix.** The orchestrator is the authority that writes states; the UI and server enforce the matrix against user-originated actions. Python's role is to emit correct transitions (§5), not to validate UI-initiated ones.

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

### 12. Cross-platform support (macOS / Linux / Windows)

The pipeline runs on all three OSes. Signal, subprocess, and I/O semantics differ enough to warrant explicit handling. Two hard rules anchor the rest of this section:

- **Graceful stop must never depend on POSIX signals alone.** On Windows, `process.kill(pid, 'SIGTERM')` is equivalent to `TerminateProcess` — the orchestrator's Python signal handler never runs. Graceful shutdown flows through `control.json` (file-based, OS-agnostic); signal is the emergency force-terminate fallback only.
- **Reconciler is the primary terminal-state path on Windows.** When the orchestrator is force-killed, no `_signal_status["pipeline_status"] = "interrupted"` runs and no `_pending_signal_event` is stashed. The reconciler (§7, now dispatching through `dispatch_external`) MUST produce `pipeline.run.interrupted` with `stop_reason="stale"`.

#### 12.1 Orchestrator signal handling per OS

| OS | `process.kill(pid, 'SIGTERM')` effect | Python handler runs? | Graceful path |
|---|---|---|---|
| macOS | Sends SIGTERM; user handler runs before default action. | ✅ | `_handler()` sets `interrupted` + stashes `_pending_signal_event`. |
| Linux | Sends SIGTERM; user handler runs before default action. | ✅ | Same as macOS. |
| Windows | Calls `TerminateProcess`. Immediate kill. | ❌ | `control.json` poll (orchestrator sees it at next stage boundary); signal path is force-kill → reconciler cleans up. |

**Consequence:** the signal-path unification in §5.3 (`_shutdown_requested` between stages → `PipelineInterrupted(stop_reason="signal")`) is an effective path on macOS/Linux only. On Windows it never fires. That's acceptable because:

1. `control.json` (§5.1) works identically on all three OSes and is the documented graceful path.
2. `reconcileStatus()` (§7, updated to dispatch) handles force-kill on all three OSes.
3. Any future introduction of `CTRL_BREAK_EVENT` as a Windows graceful-stop mechanism can be added without changing the `interrupted` semantics defined here.

`stopPipelineSync(runId, { timeoutMs })` MUST behave as follows:

```javascript
// worca-ui/server/process-manager.js
async stopPipelineSync(runId, { timeoutMs } = {}) {
  // Default timeout: 5s on Unix (SIGTERM interrupts blocking I/O immediately),
  // 30s on Windows (must wait for agent subprocess exit + control.json poll).
  if (timeoutMs === undefined) {
    timeoutMs = process.platform === 'win32' ? 30000 : 5000;
  }
  const pid = this.getRunningPid(runId);
  if (!pid) { const e = new Error('not running'); e.code = 'not_running'; throw e; }

  // 1. Request graceful stop (control.json) — cross-platform.
  this._writeControlJson(runId, { action: 'stop' });

  if (process.platform !== 'win32') {
    // 2a. Unix: also send SIGTERM to nudge the signal handler.
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  } else {
    // 2b. Windows: SIGTERM is TerminateProcess (instant kill, no handler).
    // Instead, terminate the agent subprocess to unblock run_agent()'s
    // subprocess.communicate(), allowing the orchestrator to loop back and
    // poll control.json. Agent PID is written to <run_dir>/agent.pid.
    this._killAgentSubprocess(runId);
  }

  // 3. Poll for exit.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return { pid, exitCode: null }; }
    await new Promise((r) => setTimeout(r, 100));
  }

  // 4. Timeout — force terminate.
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  return { pid, exitCode: null, forced: true };
}

/**
 * Kill the active Claude agent subprocess to unblock the orchestrator.
 * Reads PID from <run_dir>/agent.pid (written by claude_cli.py on spawn).
 * No-op if file missing or process already dead.
 */
_killAgentSubprocess(runId) {
  const agentPidPath = join(this.worcaDir, 'runs', runId, 'agent.pid');
  try {
    const agentPid = parseInt(readFileSync(agentPidPath, 'utf8').trim(), 10);
    if (agentPid) process.kill(agentPid, 'SIGTERM');
  } catch { /* missing file or already dead — expected */ }
}
```

**Platform behavior:**

| OS | Step 2 | Effect | Typical time to graceful exit |
|---|---|---|---|
| Unix | SIGTERM to orchestrator | Signal handler runs immediately, interrupts blocking I/O | <1s |
| Windows | Kill agent subprocess | Unblocks `run_agent()` → orchestrator loops → reads `control.json` → exits gracefully | 1-5s (depends on cleanup) |

On Unix, step 2a delivers SIGTERM (handler runs, status persisted). On Windows, step 2b kills the agent subprocess, unblocking the orchestrator so it can poll `control.json` on the next loop iteration. The 30s Windows timeout accommodates the orchestrator's cleanup and status persistence. If the timeout fires before the poll (e.g., orchestrator stuck in non-agent blocking I/O), the reconciler fires `RUN_INTERRUPTED` with `stop_reason="stale"` afterwards. Both OSes converge on correct terminal state + dispatch.

#### 12.1.1 Agent subprocess PID file

To support Windows graceful stop, `claude_cli.py` writes the agent subprocess PID to `<run_dir>/agent.pid` immediately after `subprocess.Popen`:

```python
# src/worca/utils/claude_cli.py — inside run_agent(), after Popen
agent_pid_path = os.path.join(run_dir, "agent.pid") if run_dir else None
if agent_pid_path:
    try:
        with open(agent_pid_path, "w") as f:
            f.write(str(proc.pid))
    except OSError:
        pass  # best-effort; Windows stop degrades to timeout+reconciler
```

The file is cleaned up in the `finally` block of `run_agent()`. On Unix this file is also written but `_killAgentSubprocess` is not called (SIGTERM handles it). The file serves as a cross-platform diagnostic aid regardless.

#### 12.2 JS → Python subprocess invocation

`dispatch-external.js` wraps `child_process.spawn()`. Python discovery order:

1. `process.env.WORCA_PYTHON` (escape hatch, all OSes — also usable in CI).
2. `python3` (macOS / Linux / WSL).
3. Windows only: `py -3` (launcher bundled with python.org installers), then `python` / `python.exe` on PATH.

```javascript
// worca-ui/server/dispatch-external.js
function resolvePythonCmd() {
  if (process.env.WORCA_PYTHON) return [process.env.WORCA_PYTHON];
  if (process.platform === 'win32') {
    // Prefer the py launcher, then fall back to python on PATH.
    // Actual fallback happens in spawnWithFallback() — see below.
    return ['py', '-3'];
  }
  return ['python3'];
}

async function spawnWithFallback(argv, opts) {
  const candidates = [
    resolvePythonCmd(),
    process.platform === 'win32' ? ['python'] : ['python'],  // last-resort
  ];
  let lastErr;
  for (const [cmd, ...prefix] of candidates) {
    try {
      return await spawnOnce(cmd, [...prefix, ...argv], opts);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
```

Always use the **arg-array** form of `spawn()` — never the shell-string form — so paths with spaces work identically across OSes and no OS-specific quoting is required.

#### 12.3 Python CLI — encoding, line endings, paths

- **Encoding.** Windows defaults stdout/stderr/stdin to `cp1252`. The CLI must wrap them in UTF-8 `TextIOWrapper` at startup (see §3.4 skeleton). `status.json` and `events.jsonl` reads/writes MUST pass `encoding="utf-8"` explicitly.
- **Line endings.** `newline="\n"` on writes; readers must be tolerant of both `\n` and `\r\n` (they already are — `.split('\n')` followed by `.trim()` in Node, and Python's default universal-newlines on read).
- **Paths.** Everywhere: `pathlib.Path` in Python and `path.join()` in Node. Never string-concatenate with `'/'`. The `run_dir` argument to the CLI is accepted as an OS-native path and resolved with `Path()`.
- **JSON argv size.** Windows caps `CreateProcess` argv at 32767 chars. Event payloads are <1KB typical (stage name + ms + source). If this ceiling is ever approached, switch to `--payload-file <path>` — out of scope for v1.

#### 12.4 Process liveness check

| OS | Node | Python |
|---|---|---|
| macOS / Linux | `process.kill(pid, 0)` → throws `ESRCH` if dead | `os.kill(pid, 0)` → raises `ProcessLookupError` if dead |
| Windows | `process.kill(pid, 0)` → throws `ESRCH` if dead (Node translates `GetExitCodeProcess`/`OpenProcess`) | `os.kill(pid, 0)` → raises `OSError` if dead |

`getRunningPid()` in `process-manager.js` already uses `process.kill(pid, 0)` — portable and unchanged. Reconciler liveness check is unchanged.

#### 12.5 Shell-hook portability

`dispatch_shell_hooks()` uses `subprocess.Popen(cmd, shell=True)` — this spawns `cmd.exe /c <cmd>` on Windows and `/bin/sh -c <cmd>` on Unix. User hook commands are **not** portable by default (e.g., `curl -X POST` works on both; `| jq` needs `jq` on PATH; `echo "foo"` semantics differ between cmd.exe and sh).

- Document in `MIGRATION.md` and the worca hooks docs: hook commands target the default shell of the host OS.
- If cross-platform hook demand surfaces, add a `shell: "bash" | "cmd" | "powershell"` field to hook config. Out of scope for W-043.

Children spawned by Popen **do** survive parent exit on Windows (no job-object binding by default) — same as Unix. Fire-and-forget is safe.

#### 12.6 File operations

- `status.json` writes use `fs.writeFileSync` / `Path.write_text` — non-atomic. On Windows, a concurrent read during the write window can briefly see a partial file. Not introduced by W-043; tracked separately if it surfaces.
- PID-file cleanup (`_remove_pid`) must `unlink` a file the parent may still have open on Windows (Windows refuses `unlink` of an in-use file). Current code already uses a best-effort try/except — unchanged.

#### 12.7 CI coverage

Python tests run on all three OSes via GitHub Actions matrix (`ubuntu-latest`, `macos-latest`, `windows-latest`). The new Phase C+D JS tests (dispatch-external, cancel-route, reconciler) also run on the matrix. Phase B tests that exercise signal handlers are skipped on `sys.platform == 'win32'` with a clear marker (`@pytest.mark.skipif(sys.platform == 'win32', reason='SIGTERM handler unreachable on Windows — covered by reconciler tests')`).

## Implementation Plan

### Phase A: Foundation (event type + sync dispatch + CLI)

**Files:**
- `src/worca/events/types.py` (add `RUN_CANCELLED`, `run_cancelled_payload`)
- `src/worca/events/emitter.py` (add `sync: bool = False` parameter to `dispatch_event` / `emit_event`)
- `src/worca/events/dispatch_external.py` (new — CLI helper)
- `tests/test_event_types.py` (extend)
- `tests/test_emitter_sync.py` (new — verify `sync=True` uses `deliver_webhook_sync`)
- `tests/test_dispatch_external.py` (new)

**Tasks:**
1. Add `RUN_CANCELLED` constant + `run_cancelled_payload()` builder in `events/types.py`. `source` enum: `user_cancel`, `force_cancel`, `bulk_cancel`.
2. Add `sync: bool = False` parameter to `dispatch_event()` and `emit_event()` per §3.1. Default preserves existing async behavior; sync path routes through `deliver_webhook_sync`. Orchestrator call sites unchanged.
3. Implement `src/worca/events/dispatch_external.py` per §3.4 — forces UTF-8 I/O (Windows parity) and invokes `emit_event(..., sync=True)`.
4. Unit tests:
   - `test_emit_event_sync_uses_deliver_webhook_sync` — patch both deliver functions; verify sync path is taken.
   - `test_emit_event_async_default_unchanged` — regression: orchestrator path still uses `deliver_webhook`.
   - `test_dispatch_external_utf8_io` — invoke the CLI with a non-ASCII branch name; assert the stdout JSON parses cleanly.
   - `test_dispatch_external_exit_codes` — missing run-dir → 2; invalid event-type → 1 (argparse); dispatch fail → 3.
5. Integration test: spawn the CLI as a subprocess via `subprocess.run(..., check=False)`, point it at a tmp run-dir with a fake `events.jsonl` + test-local webhook (using `http.server.HTTPServer` in a thread), assert the event was delivered before the CLI exited. This is the regression guard against the daemon-thread trap.
6. CI: add matrix job (`ubuntu-latest`, `macos-latest`, `windows-latest`) — run the Phase A test files on all three. This is where the UTF-8 and argv-size assumptions are validated.

### Phase B: Python in-process unification

**Files:**
- `src/worca/orchestrator/runner.py` (PipelineInterrupted constructor, **21** `raise` call sites, except handler, control-file stop branch)
- `tests/test_runner.py`, `tests/test_runner_lifecycle.py`

**Tasks:**
1. Extend `PipelineInterrupted` exception to carry `stop_reason` as a **required keyword argument** (no default — any missed site raises `TypeError` at runtime). See §5.2.
2. Update **all 21** `raise PipelineInterrupted(...)` call sites in `runner.py` to pass `stop_reason` explicitly. Verify count with `grep -c "raise PipelineInterrupted" src/worca/orchestrator/runner.py`. Distribution at time of writing:

   | Count | `stop_reason` | Sites |
   |---|---|---|
   | 1 | `"control_file"` | line 163 (control-file stop) |
   | 3 | `"signal"` | line 179 (signal during pause), 1552 (before stage), 1727 (during stage) |
   | 1 | `"control_webhook"` | line 190 — **f-string variant**: `f"Aborted via control webhook: {reason}"` — must not be missed during bulk replace |
   | 16 | `"control_webhook"` | lines 1452, 1694, 1968, 1999, 2015, 2056, 2096, 2178, 2286, 2327, 2356, 2392, 2428, 2479, 2523, 2548 |

   The 16 bare-string control-webhook sites are mechanically identical (`raise PipelineInterrupted("Aborted via control webhook")`) — a single bulk find/replace is sufficient. **Line 190 is a separate f-string variant** — handle it individually. Second pass: verify none were in strings / docstrings / comments (the grep will flag those too).

3. Rewrite the `except PipelineInterrupted:` handler at `runner.py:2641-2650` per §5.4 (verify line range — post-W-042 rebases may have shifted it).
4. Update `_check_control_file()` `action=stop` branch (`runner.py:157-163`) per §5.1.
5. Tests (all Python; mark Windows-skip where signal-dependent):
   - `test_pipeline_interrupted_lands_on_interrupted_state` — was previously asserting `failed`.
   - `test_pipeline_interrupted_carries_stop_reason` — new exception API.
   - `test_control_file_stop_lands_on_interrupted_all_os` — runs everywhere (no signal dependency). **Was `failed`.**
   - `test_control_webhook_abort_lands_on_interrupted_all_os` — runs everywhere. **Was `failed`.**
   - `test_signal_then_stage_boundary_does_not_double_emit` — Unix only (`@skipif win32`). Verifies `_pending_signal_event` suppresses the orchestrator-path emit.
   - `test_signal_handler_sets_interrupted_status` — Unix only.
   - `test_all_pipeline_interrupted_sites_have_stop_reason` — AST-based lint test that parses `runner.py` and asserts every `raise PipelineInterrupted(...)` call supplies a `stop_reason` kwarg. Prevents regressions from future copy/paste. Runs on all OSes.

### Phase C + D: JS routes + UI gating (ship together)

**Bundling rationale.** Phases C and D ship as **one PR**, not two. Today the UI only calls `/runs/:id/stop` (`worca-ui/app/main.js:1169, 1263`) — there is no Cancel button anywhere in the frontend. If Phase C ships alone, clicking Stop on a paused run returns `409 Conflict` and the UI has no handler, producing a silent breakage. Bundling avoids this window. If the PR proves too large in review, split into "C-server-only behind `WORCA_STRICT_STOP=1` flag" + "D-UI + flip flag" — but default to bundled.

**Files:**
- `worca-ui/server/dispatch-external.js` (new — JS wrapper around the CLI)
- `worca-ui/server/project-routes.js` (cancel route, stop route)
- `worca-ui/server/process-manager.js` (`reconcileStatus(worcaDir, settingsPath)`, `stopPipelineSync` — see §12.1 for cross-platform body)
- `worca-ui/server/ws-message-router.js` (thread `proj.settingsPath` through the reconciler call at line 508 — currently only `proj.worcaDir` is passed)
- `worca-ui/server/test/project-routes-cancel.test.js` (new)
- `worca-ui/server/test/project-routes-stop-409.test.js` (new)
- `worca-ui/server/test/process-manager-reconcile.test.js` (extend)
- `worca-ui/server/test/dispatch-external.test.js` (new — resolves Python per OS, respects `WORCA_PYTHON`, timeout handling)
- `worca-ui/app/utils/state-actions.js` (new)
- `worca-ui/app/utils/state-actions.test.js` (new — 56 cells × action × state coverage)
- `worca-ui/app/views/run-card.js` (import `actionAllowed`; add Cancel button next to Stop)
- `worca-ui/app/views/run-list.js` (import `actionAllowed`)
- `worca-ui/app/views/multi-dashboard.js` (bulk action gating)

**Tasks:**
1. Implement `dispatch-external.js` — `await dispatchExternal({ runDir, settingsPath, eventType, payload, timeoutMs = 60000 })`. Python discovery + spawn-with-fallback per §12.2. Timeout default is 60s (must exceed worst-case webhook delivery for 2 subscribers with default retries — see §3.1). On timeout: kill the subprocess, log to stderr, resolve with `{ ok: false, reason: 'timeout' }` (do not reject — callers should not block the HTTP response on dispatch failure).
2. Thread `settingsPath` through `ProcessManager` constructor and `reconcileStatus(worcaDir, settingsPath)`. Fix the standalone helper at `process-manager.js:644`. Fix the ws-router call at `ws-message-router.js:508` to pass `proj.settingsPath` (already in scope per line 68).
3. Implement `pm.stopPipelineSync(runId, { timeoutMs })` per §12.1 — cross-platform body (control.json + optional SIGTERM on Unix + poll + force-terminate).
4. Rewrite cancel route per §6. Use `actionAllowed('cancel', currentStatus)` as a pre-check (§8.1); return `409 { code: 'action_not_allowed' }` when disallowed.
5. Rewrite stop route's PID-dead fallback to return `409 Conflict { code: 'no_running_process', suggested_action: 'cancel' }`.
6. Update `reconcileStatus()` to call `dispatchExternal` after writing the synthetic event. This is the primary `RUN_INTERRUPTED` path on Windows (§12.1).
7. Remove `DELETE /runs/:id` route (§9).
8. Implement `actionAllowed(action, status)` per §8. Server-side import at `project-routes.js` header.
9. Wire `actionAllowed` into all run-action buttons (`run-card.js`, `run-list.js`). Add `<sl-tooltip>` with reason when disabled.
10. Add a Cancel button next to Stop in `run-card.js`.
11. UI handler for `409 { code: 'no_running_process' }` — display a toast prompting the user to use Cancel, with a one-click redirect (covers the case where state changed between render and click).
12. Tests — server:
    - cancel from each starting state (`running`, `paused`, `failed`, `interrupted`, `pending`) hits dispatch helper.
    - cancel on `cancelled` is an idempotent no-op (returns `{ ok: true, already: 'cancelled' }`, no dispatch spawned).
    - stop on dead PID returns 409 with `code: "no_running_process"`.
    - reconcile invokes `dispatchExternal` (mocked).
    - `dispatchExternal` respects `WORCA_PYTHON`, falls back on `ENOENT`, and times out cleanly on unresponsive Python.
13. Tests — UI:
    - `actionAllowed` 56-cell matrix.
    - Stop button disabled on paused runs.
    - Cancel button present on run-card for all non-terminal + reversibly-terminal states.
14. CI: entire Phase C+D PR runs on `ubuntu-latest`, `macos-latest`, `windows-latest` (vitest + playwright workers=1). Windows playwright step validates the control.json-based graceful stop (see §Test Plan).

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
| `src/worca/events/emitter.py` | A | Add `sync: bool = False` parameter to `dispatch_event` and `emit_event` |
| `src/worca/events/dispatch_external.py` | A | New — CLI helper; UTF-8 I/O wrappers; `sync=True` dispatch |
| `tests/test_event_types.py` | A | Extend with `RUN_CANCELLED` cases |
| `tests/test_emitter_sync.py` | A | New — verify sync vs async dispatch routing |
| `tests/test_dispatch_external.py` | A | New — CLI matrix on macOS/Linux/Windows |
| `src/worca/orchestrator/runner.py` | B | `PipelineInterrupted` constructor (required `stop_reason` kwarg); **21** `raise` call sites; except handler; `_check_control_file` stop branch |
| `src/worca/utils/claude_cli.py` | C+D | Write agent subprocess PID to `<run_dir>/agent.pid` for Windows graceful stop (§12.1.1) |
| `tests/test_runner.py` | B | Update existing tests; add new; AST lint test for 21-site coverage |
| `tests/test_runner_lifecycle.py` | B | Update lifecycle tests for new terminal state (OS-skip where signal-dependent) |
| `worca-ui/server/dispatch-external.js` | C+D | New — JS wrapper with per-OS Python discovery, timeout, `WORCA_PYTHON` support |
| `worca-ui/server/project-routes.js` | C+D, E | Cancel route rewrite; stop route 409; server-side `actionAllowed` check; remove DELETE alias; add real delete route |
| `worca-ui/server/process-manager.js` | C+D, E | `stopPipelineSync` (cross-platform per §12.1); reconciler dispatch call with `settingsPath`; `deleteRun` |
| `worca-ui/server/ws-message-router.js` | C+D | Thread `proj.settingsPath` through the reconciler call at line 508 |
| `worca-ui/server/test/project-routes-cancel.test.js` | C+D | New |
| `worca-ui/server/test/project-routes-stop-409.test.js` | C+D | New |
| `worca-ui/server/test/process-manager-reconcile.test.js` | C+D | Extend with `dispatchExternal` mock |
| `worca-ui/server/test/dispatch-external.test.js` | C+D | New — per-OS Python resolution, timeout, fallback |
| `worca-ui/app/utils/state-actions.js` | C+D | New — canonical action × state matrix (shared with server) |
| `worca-ui/app/utils/state-actions.test.js` | C+D | New — 56-cell coverage |
| `worca-ui/app/views/run-card.js` | C+D | Use `actionAllowed`; add Cancel button; handle 409 → toast |
| `worca-ui/app/views/run-list.js` | C+D | Use `actionAllowed` |
| `worca-ui/app/views/multi-dashboard.js` | C+D | Bulk action gating |
| `worca-ui/app/utils/status-badge.js` | E | Remove `resuming` |
| `worca-ui/app/views/stage-timeline.js` | E | Remove `resuming` checks |
| `src/worca/state/status.py` | E | Remove legacy `interrupted → paused` |
| `tests/test_status.py` | E | Remove obsolete test |
| `MIGRATION.md` | E | Document breaking changes (incl. Windows stop semantics note) |
| `CLAUDE.md` | C+D | Add rule: "JS state mutations must invoke `dispatch_external`"; note Windows SIGTERM semantics |
| `.github/workflows/*.yml` | A, C+D | Extend matrix to include `macos-latest` and `windows-latest` for affected test files |

## Considerations

### Breaking changes

1. **Control-file `stop` action terminal state changes from `failed` to `interrupted`.** Anyone querying `pipeline_status === 'failed'` to detect user-stops will miss them after upgrade. Mitigation: webhook subscribers should always look at `event_type` (`pipeline.run.interrupted` vs `pipeline.run.failed`), not status.json. Documented in MIGRATION.md.
2. **Control-webhook `abort` action terminal state changes from `failed` to `interrupted`.** Same mitigation.
3. **`POST /runs/:id/stop` no longer silently force-cancels dead PIDs.** Returns `409 Conflict` with `code: "no_running_process"` instead of silently rewriting status to `cancelled`. Callers (UI, third-party scripts) must switch to `POST /runs/:id/cancel` for force-terminate semantics. UI handles this gracefully with a toast + one-click redirect (§C+D).
4. **`DELETE /runs/:id` removed.** Was a duplicate of stop. Callers migrate to `POST /runs/:id/stop` (signal) or `POST /runs/:id/cancel` (force). A real delete endpoint is now `POST /runs/:id/delete`.
5. **`pipeline.run.cancelled` is a new event type.** Webhook/integration subscribers may receive a previously-unseen event type. Default `TIER1_EVENTS` (UI integration setup) includes it so users get notifications by default.
6. **Windows graceful-stop behavior (documentation change, not code regression).** On Windows, the UI's stop button invokes control.json + a short grace window, NOT SIGTERM. If the orchestrator doesn't poll control.json within the timeout, the process is force-terminated and the reconciler fires `RUN_INTERRUPTED` with `stop_reason="stale"` afterwards. Subscribers see the same final state (`interrupted`) but with a slightly different `stop_reason` than on Unix. Documented in MIGRATION.md.

### Migration

`MIGRATION.md` adds a `### Upgrading to W-043 / 0.16.0` section:

```markdown
### Upgrading to 0.16.0

- **Terminal state for user-stop unified to `interrupted`.** Previously, control-file stop and control-webhook abort produced `failed`; signal stop produced `interrupted`. Now all user-stop paths land on `interrupted`. If your webhook subscribers gate on `pipeline_status === "failed"`, switch to `event_type === "pipeline.run.failed"` (which is unaffected — only true errors now produce `failed`).

- **`POST /runs/:id/stop` rejects dead-PID requests.** Returns `409 Conflict` instead of silently rewriting status. Use `POST /runs/:id/cancel` to force-terminate any non-running pipeline.

- **`DELETE /runs/:id` removed.** It was an alias for stop. Use `POST /runs/:id/stop` or `POST /runs/:id/cancel`. A real delete endpoint is now `POST /runs/:id/delete`.

- **New event `pipeline.run.cancelled`.** Fires whenever a pipeline reaches terminal state via the cancel action. Subscribed by default in the integration TIER1_EVENTS list.

- **Windows users:** the Stop button on the dashboard now targets `control.json` (graceful) rather than SIGTERM. If a pipeline is mid-stage and does not poll the control file within the ~5s grace window, it is force-terminated by the UI server and the reconciler fires `pipeline.run.interrupted` with `stop_reason="stale"` shortly after. If you monitor `stop_reason` on Windows specifically, expect `"stale"` more often than `"signal"`.
```

### Governance / dispatch invariant

After W-043, the contract is:

> Every `pipeline.*` event observable through `events.jsonl` MUST be produced by `emit_event()` (which calls `dispatch_event()`). No code path may write to `events.jsonl` without invoking dispatch.

Add this as a code-review checklist item in `CLAUDE.md`. A future post_tool_use hook could grep for `appendFileSync.*events.jsonl` and similar Python patterns to enforce mechanically.

### Performance

`dispatchExternal()` spawns a Python subprocess per state mutation. State mutations are user-initiated and rare (cancel, reconcile-stale, etc.) — not in any hot path. Cold-start cost approximately:

| OS | Cold-start (Python import + emit) | Warm-start (OS fs cache hot) |
|---|---|---|
| Linux | ~120ms | ~60ms |
| macOS | ~150ms | ~80ms |
| Windows | ~250-400ms (process creation is slower; py launcher adds overhead) | ~150ms |

Acceptable for cancel/stop frequency on all three OSes. Mitigation for Windows: `dispatchExternal` runs **after** the HTTP response is sent (see §6 sidebar below), so the user perceives cancel as instant and only the webhook delivery is subject to Windows process-creation latency. If this becomes a bottleneck, batch via a long-running helper process — out of scope for v1.

### Dispatch lifetime

Covered in detail in §3.1. Summary: `deliver_webhook` uses daemon threads that die when the interpreter exits. The CLI helper MUST invoke `emit_event(..., sync=True)` to avoid silently truncating webhook delivery. Regression guard is `tests/test_dispatch_external.py::test_cli_waits_for_webhook_delivery` — a local HTTP server records receipt; the CLI must exit only after the POST completes.

**Timeout alignment:** `dispatchExternal` timeout (60s) must exceed the worst-case `deliver_webhook_sync` latency. With default config and 2 subscribers: `(5s timeout × 4 attempts + 7s backoff) × 2 webhooks = 54s`. The 60s default covers this with a 6s buffer. If users configure more than 2 webhooks or increase `max_retries`, they must also increase `dispatchExternal` timeout (documented in MIGRATION.md). Future improvement: read webhook count from settings and compute the timeout dynamically — out of scope for v1.

### HTTP-response vs dispatch decoupling

In §6, the cancel endpoint's order of operations is:

1. `stopPipelineSync` (if alive) — blocking but bounded by `timeoutMs`.
2. Status.json rewrite — fast, local.
3. WebSocket broadcast to clients — fast, local.
4. HTTP 200 response to the user.
5. `dispatchExternal` spawn — the Python subprocess — does NOT block the response; it runs after `res.json()` and its completion is logged for observability but never bubbles back to the user.

Rationale: dispatch is best-effort and cross-OS slow (especially Windows). A stalled webhook subscriber must not delay the UI response. If dispatch fails, the event is already in `events.jsonl`, so no observable state is lost — webhook retries are already bounded internally.

Implementation: `dispatchExternal` returns a promise that `project-routes.js` `await`s **after** `res.json()` has been called (Express allows further work after response, but awaiting after response is sent is idempotent). For stricter guarantees, pass the promise to a small in-memory queue that drains on server shutdown — out of scope unless the unresolved-promise count grows.

### Edge cases

- **Concurrent cancel + signal:** if user clicks cancel while SIGTERM is already in flight (or the orchestrator's pause-handler is already processing), both paths may write `events.jsonl`. Expected behavior: webhook subscribers see `pipeline.run.interrupted` (from signal, exactly once — guarded by `_pending_signal_event`) then `pipeline.run.cancelled`. Cancel's status rewrite (`cancelled`) overwrites `interrupted`, so resume is correctly blocked. Dedicated integration test — see §Test Plan.
- **Cancel on `paused`:** no live PID, but state goes to `cancelled` and `RUN_CANCELLED` fires. Correct.
- **Reconcile race with running orchestrator:** if the reconciler triggers between status update and PID cleanup, it may emit a spurious `interrupted/stale` event. Mitigation: reconciler already checks PID liveness; the race window is the brief gap between the orchestrator's `finally` block and PID-file removal. In practice never observed; if it surfaces, add a 500ms grace period to the reconciler.
- **Windows graceful stop (agent.pid mechanism):** On Windows, `stopPipelineSync` writes `control.json` then kills the Claude agent subprocess via `<run_dir>/agent.pid` (§12.1.1). This unblocks the orchestrator's `run_agent()` call, causing it to loop back to `_check_control_file()` and exit gracefully with `stop_reason="control_file"`. The 30s Windows timeout (vs 5s on Unix) accommodates cleanup. If the agent.pid file is missing or the orchestrator is stuck in non-agent blocking I/O, the timeout fires, SIGKILL lands, and the reconciler sets `stop_reason="stale"` as the fallback path.
- **Windows force-kill (no signal handler):** `process.kill(pid, 'SIGTERM')` on Windows invokes `TerminateProcess`; the Python handler never runs, so `_signal_status` is never set to `interrupted` and no `_pending_signal_event` is stashed. The status stays `running` with the PID dead. The reconciler picks this up on its next scan (WS reconnect, UI refresh, or next route request) and fires `RUN_INTERRUPTED` with `stop_reason="stale"`. First-class path on Windows; fallback on Unix.
- **User-provided shell hooks that themselves call webhooks:** user-written hook commands may take seconds (e.g., `curl -X POST ...`). On Unix they survive parent exit cleanly; on Windows same (no job-object binding). No action needed.
- **WSL / Cygwin / MSYS:** treated as `win32` by Node's `process.platform` only if running native Windows Node; running `node` under WSL reports `linux`. Plan behavior: follow the reported platform. Users running cross-environment setups must export `WORCA_PYTHON` to disambiguate.

## Test Plan

### Unit tests

| Layer | Test | Validates | OS scope |
|-------|------|-----------|---|
| Python | `test_run_cancelled_payload_required_fields` | New payload builder shape + `source` enum | all |
| Python | `test_emit_event_sync_uses_deliver_webhook_sync` | §3.1 — sync path avoids daemon threads | all |
| Python | `test_emit_event_async_default_unchanged` | Regression: orchestrator path still uses `deliver_webhook` | all |
| Python | `test_dispatch_external_writes_event` | CLI subprocess writes correct event to events.jsonl | all |
| Python | `test_dispatch_external_invokes_dispatch_event_sync` | CLI uses sync dispatch — webhook delivered before CLI exits (see below) | all |
| Python | `test_cli_waits_for_webhook_delivery` | Daemon-thread regression guard — local HTTP server records receipt; CLI exit code 0 only after POST lands | all |
| Python | `test_dispatch_external_exits_2_on_missing_run_dir` | Error handling | all |
| Python | `test_dispatch_external_utf8_branch_name` | UTF-8 I/O (§12.3) — non-ASCII branch name roundtrips cleanly | **Windows** primary; also run on Unix |
| Python | `test_pipeline_interrupted_carries_stop_reason` | Exception API | all |
| Python | `test_pipeline_interrupted_handler_lands_on_interrupted` | Was `failed` | all |
| Python | `test_control_file_stop_lands_on_interrupted` | §5.1 | all |
| Python | `test_control_webhook_abort_lands_on_interrupted` | §5.2 | all |
| Python | `test_signal_does_not_duplicate_emit` | `_pending_signal_event` suppression | **Unix only** (`@skipif win32`) |
| Python | `test_all_pipeline_interrupted_sites_have_stop_reason` | AST lint — every `raise PipelineInterrupted(...)` has `stop_reason` kwarg | all |
| JS | `actionAllowed`: 56 cells | Action × state matrix coverage | all |
| JS | `dispatchExternal` spawns with correct args | Subprocess wrapper shape | all |
| JS | `dispatchExternal` resolves Python per OS | Respects `WORCA_PYTHON`; prefers `py -3` on Windows; falls back on `ENOENT` | per-OS mocks |
| JS | `dispatchExternal` times out cleanly | Unresponsive Python → kill subprocess; `{ ok: false, reason: 'timeout' }` | all |
| JS | cancel from each state | §6 | all |
| JS | cancel endpoint awaits stopPipelineSync before status rewrite | Prevents cancel-before-stop race | all |
| JS | stop on dead PID returns 409 | §7 | all |
| JS | reconciler invokes dispatchExternal | §7 | all |
| JS | `stopPipelineSync` control.json write + SIGTERM on Unix | §12.1 branch for non-win32 | Unix only |
| JS | `stopPipelineSync` control.json only on Windows (no SIGTERM send) | §12.1 win32 branch | Windows only |
| JS | `stopPipelineSync` kills agent subprocess on Windows via agent.pid | §12.1.1 — unblocks orchestrator polling | Windows only |
| JS | `stopPipelineSync` Windows timeout is 30s (not 5s) | §12.1 platform-specific default | Windows only |
| JS | `dispatchExternal` timeout is 60s default | §3.1 latency bound for 2 webhooks | all |

### Integration tests

Every integration test runs on the full OS matrix unless explicitly marked Unix-only (signal-dependent) or Windows-only.

| Scenario | OS scope | Expected outcome |
|---|---|---|
| Start → pause → cancel | all | Status: `cancelled`. Events: `RUN_STARTED`, `RUN_PAUSED`, `RUN_CANCELLED`. Webhook + integration each receive 3 events. |
| Start → SIGTERM → wait | Unix only | Status: `interrupted` (`stop_reason=signal`). Events: `RUN_STARTED`, `RUN_INTERRUPTED` (exactly once). |
| Start → `TerminateProcess` (force-kill) → reconcile | Windows only | Status: `interrupted` (`stop_reason=stale`). Events: `RUN_STARTED`, `RUN_INTERRUPTED` fired by reconciler via dispatch helper. Zero silent mutations. |
| Start → SIGTERM during pause-poll | Unix only | Status: `interrupted`. Events: `RUN_STARTED`, `RUN_PAUSED`, `RUN_INTERRUPTED` (once; `_pending_signal_event` suppresses the orchestrator-path duplicate). |
| Start → control-file stop | all | Status: `interrupted` (`stop_reason=control_file`). Webhook gets `RUN_INTERRUPTED`. **Primary graceful path on Windows.** |
| Start → control-webhook abort | all | Status: `interrupted` (`stop_reason=control_webhook`). |
| Start → stop during mid-stage Claude call | Windows primary, also Unix | Agent subprocess killed → orchestrator unblocks → polls `control.json` → graceful `interrupted` (not `stale`). Validates §12.1.1 agent.pid mechanism. |
| Pause → stop (user-reported bug) | all | UI button greyed out (§8). Programmatic POST returns 409. No silent mutation. |
| Cancel after force-kill | all | Reconciler emits `RUN_INTERRUPTED` first (`stop_reason=stale`) via dispatch helper, then cancel emits `RUN_CANCELLED`. Status ends `cancelled`. Two event types; each delivered exactly once. |
| **Concurrent cancel + signal (race)** | Unix only | SIGTERM in-flight; user clicks cancel in same ~50ms window. Expected timeline: signal handler stashes `_pending_signal_event` → main thread raises → except handler sees `_pending_signal_event` set and skips emit → cancel route fires `RUN_CANCELLED`. Final status: `cancelled`. Events: `RUN_INTERRUPTED` (from signal, once) + `RUN_CANCELLED` (from cancel, once). No duplicates. |
| Resume from `cancelled` | all | UI button greyed out. Programmatic POST returns 409. |
| `dispatchExternal` when Python not on PATH | all | Falls back through candidate list (§12.2). If all fail, logs to stderr; event still written to `events.jsonl`; webhook not delivered (best-effort contract). |
| UTF-8 branch name end-to-end | all | Branch name contains non-ASCII; event payload written correctly; webhook receives intact body. |

### Existing tests to update

- `tests/test_status.py::test_resolve_status_maps_interrupted_to_paused` — **delete** (legacy mapping removed).
- `tests/test_runner.py` — any test asserting `pipeline_status == 'failed'` after `PipelineInterrupted` must change to `interrupted`.
- `worca-ui/server/test/process-manager-reconcile.test.js` — extend to verify `dispatchExternal` is called with `settingsPath` (mocked).
- W-042 tests for `_pending_signal_event` already exist; extend to cover the orchestrator-path suppression.

### Done criteria

- All Python tests pass on `ubuntu-latest`, `macos-latest`, **and** `windows-latest` (`pytest tests/`).
- All JS tests pass on the same matrix (`npx vitest run` in `worca-ui/`).
- Playwright e2e tests pass on all three OSes with `--workers=1`.
- `ruff check .` clean on Unix and Windows (ruff is cross-platform).
- `cd worca-ui && npm run lint` clean.
- Manual smoke test on `test-multi-02` matching the user's pause→stop scenario: notification fires for `RUN_PAUSED` AND for `RUN_CANCELLED`.
- Windows-specific smoke test: start a pipeline, kill via Task Manager (force-terminate), wait for reconciler to tick, verify `pipeline.run.interrupted` with `stop_reason="stale"` landed in events.jsonl AND that the webhook URL received exactly one POST.

## Files to Create/Modify

See "Files Changed Summary" table in the Implementation Plan section.

## Out of Scope

- **Status migration tooling for old runs.** Existing `runs/<run_id>/status.json` files with `pipeline_status="failed"` from previous control-file stops will not be retroactively reclassified. Migration is forward-only; old runs keep their historical state.
- **Webhook delivery batching / persistent helper process.** Per-mutation Python subprocess spawn (~150ms) is acceptable for cancel/stop frequency. Optimisation deferred until profiled.
- **Status state machine validator.** Could add a runtime check that rejects any `pipeline_status` write not matching the canonical 7 values. Considered but deferred — the proposal removes the bad call sites; validator is belt-and-suspenders.
- **Bulk-cancel atomic guarantees.** Multi-pipeline cancel iterates per-run; no atomic group commit. If one fails halfway, callers see partial state. Out of scope.
- **GraphQL/REST API versioning.** The breaking endpoint changes (`DELETE` removed, `stop` now 409) are documented in MIGRATION.md but not version-gated. Acceptable for pre-1.0.
