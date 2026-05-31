"""Single work request pipeline runner.

Orchestrates the full pipeline from plan through PR.
"""

import atexit
import collections
import dataclasses
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Optional

from worca.orchestrator.guardian_context import build_guardian_context, compute_defer_pr
from worca.orchestrator.error_classifier import (
    classify_error, record_failure, record_success,
    should_halt, get_retry_delay, get_circuit_breaker_state,
    CATEGORY_TRANSIENT,
)
from worca.orchestrator.registry import update_pipeline
from worca.orchestrator.control import read_control, delete_control
from worca.orchestrator.overlay import OverlayResolver, resolve_agent
from worca.orchestrator.prompt_builder import PromptBuilder
from worca.orchestrator.effort import resolve_effort, escalation_iter_num, EFFORT_LEVELS
from worca.orchestrator.stages import (
    Stage, get_stage_config, get_enabled_stages, STAGE_AGENT_MAP,
    is_learn_enabled, resolve_plan_review_mode,
)
from worca.orchestrator.work_request import WorkRequest
from worca.state.status import (
    load_status, save_status, update_stage, set_milestone, init_status,
    start_iteration, complete_iteration,
    PipelineStatus, PIPELINE_TERMINAL, PIPELINE_ALL_TERMINAL,
)
from worca.utils.beads import bd_ready, bd_show, bd_update, bd_close, bd_label_add, bd_daemon_stop, bd_get_effort_label
from worca.utils.gh_issues import gh_issue_start, gh_issue_complete
from worca.utils.claude_cli import run_agent, terminate_current, terminate_all, AgentSubprocessError
from worca.utils.proc import pid_is_alive
from worca.utils.proc_registry import kill_all_tracked
from worca.utils.git import create_branch, current_branch, get_current_git_head
from worca.utils.pr_url import parse_pr_url
from worca.utils.settings import load_global_settings, load_settings
from worca.scripts.crg_preflight import run_crg_preflight
from worca.scripts.graphify_preflight import run_graphify_preflight
from worca.utils.graphify import (
    detect_graphify,
    effective_graphify_config,
)
from worca.utils.code_review_graph import (
    EffectiveCrgConfig,
    crg_mcp_config,
    crg_tools_for_stage,
    detect_code_review_graph,
    effective_crg_config,
)
from worca.utils.token_usage import extract_token_usage, aggregate_token_usage, aggregate_by_model
from worca.utils.stats import update_cumulative_stats
from worca.events.emitter import EventContext, emit_event, dispatch_event, _check_control_response
from worca.events.types import (
    RUN_STARTED, RUN_COMPLETED, RUN_FAILED, RUN_INTERRUPTED,
    RUN_RESUMED, RUN_PAUSED, RUN_RESUMED_FROM_PAUSE,
    run_started_payload, run_completed_payload, run_failed_payload, run_interrupted_payload,
    run_resumed_payload, run_paused_payload, run_resumed_from_pause_payload,
    STAGE_STARTED, STAGE_COMPLETED, STAGE_FAILED, STAGE_INTERRUPTED,
    stage_started_payload, stage_completed_payload,
    stage_failed_payload, stage_interrupted_payload,
    AGENT_SPAWNED, AGENT_TOOL_USE, AGENT_TOOL_RESULT, AGENT_TEXT, AGENT_COMPLETED,
    agent_spawned_payload, agent_tool_use_payload, agent_tool_result_payload,
    agent_text_payload, agent_completed_payload,
    BEAD_ASSIGNED, BEAD_COMPLETED, BEAD_FAILED, BEAD_LABELED, BEAD_NEXT,
    bead_assigned_payload, bead_completed_payload, bead_failed_payload,
    bead_labeled_payload, bead_next_payload,
    TEST_SUITE_STARTED, TEST_SUITE_PASSED, TEST_SUITE_FAILED, TEST_FIX_ATTEMPT,
    test_suite_started_payload, test_suite_passed_payload, test_suite_failed_payload, test_fix_attempt_payload,
    REVIEW_STARTED, REVIEW_VERDICT, REVIEW_FIX_ATTEMPT,
    review_started_payload, review_verdict_payload, review_fix_attempt_payload,
    MILESTONE_SET, LOOP_TRIGGERED, LOOP_EXHAUSTED,
    milestone_set_payload, loop_triggered_payload, loop_exhausted_payload,
    CB_FAILURE_RECORDED, CB_RETRY, CB_TRIPPED, CB_RESET,
    cb_failure_recorded_payload, cb_retry_payload, cb_tripped_payload, cb_reset_payload,
    COST_STAGE_TOTAL, COST_RUNNING_TOTAL, COST_BUDGET_WARNING,
    cost_stage_total_payload, cost_running_total_payload, cost_budget_warning_payload,
    GIT_BRANCH_CREATED, GIT_PR_CREATED,
    git_branch_created_payload, git_pr_created_payload,
    PREFLIGHT_COMPLETED, PREFLIGHT_SKIPPED,
    preflight_completed_payload, preflight_skipped_payload,
    LEARN_COMPLETED, LEARN_FAILED,
    learn_completed_payload, learn_failed_payload,
    PLAN_EDITED, plan_edited_payload,
    GUIDE_CONFLICT, guide_conflict_payload,
)

# Maps pipeline stages to their user-message block files. The stage's
# .block.md is resolved (three-tier overlay + placeholders) and passed as
# the -p user message to the agent. Stages not listed (e.g. PREFLIGHT) fall
# back to the default rendered_prompt (title + description).
_STAGE_BLOCK_MAP = {
    Stage.PLAN:         "plan",
    Stage.PLAN_REVIEW:  "plan-review",
    Stage.COORDINATE:   "coordinate",
    Stage.IMPLEMENT:    "implement",
    Stage.TEST:         "test",
    Stage.REVIEW:       "review",
    Stage.PR:           "pr",
    Stage.LEARN:        "learn",
}


def _emit_guide_conflicts(ctx, stage: str, result: dict) -> None:
    """Emit GUIDE_CONFLICT events for each entry in result['guide_conflicts'].

    Called after each plan/review/test stage completes. Each conflict item
    becomes its own event so the UI can surface them individually.
    """
    if ctx is None:
        return
    conflicts = result.get("guide_conflicts") if isinstance(result, dict) else None
    if not conflicts:
        return
    run_id = ctx.run_id
    for conflict in conflicts:
        if not isinstance(conflict, dict):
            continue
        message = conflict.get("message", "")
        source = conflict.get("source", "description")
        if not message:
            continue
        emit_event(ctx, GUIDE_CONFLICT, guide_conflict_payload(
            run_id=run_id,
            stage=stage,
            message=message,
            source=source,
        ))


class LoopExhaustedError(Exception):
    """Raised when a loop reaches its maximum iterations."""
    pass


class PipelineError(Exception):
    """Raised when pipeline encounters an unrecoverable error."""
    pass


class CircuitBreakerTripped(PipelineError):
    """Raised when the circuit breaker halts the pipeline."""
    pass


class PipelineInterrupted(Exception):
    """Raised when the pipeline is interrupted by a signal, control file, or control webhook."""

    def __init__(self, message, *, stop_reason):
        super().__init__(message)
        self.stop_reason = stop_reason


# Shutdown flag set by signal handlers
_shutdown_requested = False

# Signal/atexit status refs for crash safety (Layers 1 & 4)
_signal_status = None
_signal_status_path = None
_signal_project_status_path = None  # project-level status.json for PID cleanup
_signal_event_ctx = None  # set to EventContext when run starts; signal-safe event emission
_pending_signal_event = None  # signal handler stashes interrupted-event dict here for deferred dispatch
_signal_event_emitted = False  # guards against duplicate events.jsonl writes from repeated signals
_signal_registry_dir = None  # parent .worca for multi-pipeline registry updates from atexit
_signal_run_id = None  # run_id for registry updates from atexit


def _is_signal_kill_exception(exc) -> bool:
    """True when `exc` carries proof the agent subprocess was killed by a
    signal (negative returncode).

    Defense-in-depth for the W-044 signal-test race: when SIGTERM hits the
    pipeline mid-stage, Python defers the in-process signal handler until
    a bytecode boundary. A C-level exception raised inside the agent's
    streaming loop can reach the runner's except-Exception block while
    `_shutdown_requested` is still False — the same exception, however,
    is now an `AgentSubprocessError` carrying the actual subprocess exit
    signal (negative on Unix when killed). Trust that exit code over the
    timing-sensitive flag, but only when it is unambiguously negative.
    """
    return (
        isinstance(exc, AgentSubprocessError)
        and exc.returncode is not None
        and exc.returncode < 0
    )


def _check_control_file(
    run_id: Optional[str],
    worca_dir: str,
    status: dict,
    status_path: str,
    ctx,
    registry_dir: Optional[str] = None,
) -> None:
    """Poll the control file for pause/stop actions.

    Reads .worca/runs/{run_id}/control.json at the top of each iteration.
    Deletes the file after reading.

    On pause: sets pipeline_status=paused, mirrors that into the multi-pipeline
             registry, saves status, exits 0.
    On stop: SIGTERMs the Claude subprocess, sets pipeline_status=interrupted
             with stop_reason=control_file, saves status, raises PipelineInterrupted.

    registry_dir is the parent project's .worca/ in worktree mode (where the
    multi-pipeline registry lives). When omitted, the registry mirror is
    skipped — in-place runs have no registry entry to update.
    """
    if not run_id:
        return

    ctrl = read_control(run_id, base=worca_dir)
    if ctrl is None:
        return

    delete_control(run_id, base=worca_dir)

    action = ctrl["action"]

    if action == "pause":
        status["pipeline_status"] = PipelineStatus.PAUSED
        save_status(status, status_path)
        # Mirror paused into the registry. Without this the entry stays
        # "running" after this process exits, so reconcile_stale() later
        # flips it to "failed" (dead PID) and fleet status derivation
        # misreads a paused child.
        if status.get("worktree") and registry_dir:
            try:
                update_pipeline(run_id, status="paused", base=registry_dir)
            except Exception:
                pass  # registry mirror is best-effort; status.json is canonical
        if ctx is not None:
            emit_event(ctx, RUN_PAUSED, run_paused_payload(reason="control_file"))
        _log("Pipeline paused by control file", "warn")
        sys.exit(0)

    elif action == "stop":
        # Kill ALL tracked process groups for this run, not just the current
        # agent — a prior iteration's group may still be alive (e.g. a retry
        # spawned a new agent while the previous one outlived its reap).
        # run_id is guaranteed set here (early-returned above when falsy).
        terminate_all(os.path.join(worca_dir, "runs", run_id))
        status["pipeline_status"] = PipelineStatus.INTERRUPTED
        status["stop_reason"] = "control_file"
        save_status(status, status_path)
        _log("Pipeline stopped by control file", "warn")
        raise PipelineInterrupted("Pipeline stopped via control file", stop_reason="control_file")


def _handle_pause(ctx: EventContext, reason: str) -> None:
    """Enter a pause polling loop until a control webhook returns resume or abort.

    Emits pipeline.run.paused on entry and on each poll tick (30s interval).
    On "resume": emits pipeline.run.resumed_from_pause and returns.
    On "abort": raises PipelineInterrupted.
    On timeout/no response: continues polling.
    """
    pause_event = emit_event(ctx, RUN_PAUSED, run_paused_payload(reason=reason))
    _log(f"Pipeline paused: {reason}", "warn")
    while True:
        for _ in range(30):
            if _shutdown_requested:
                raise PipelineInterrupted("Interrupted by signal during pause", stop_reason="signal")
            time.sleep(1)
        poll_event = emit_event(ctx, RUN_PAUSED, run_paused_payload(reason=reason, waiting=True))
        action = _check_control_response(ctx, poll_event or pause_event)
        if action == "resume":
            emit_event(ctx, RUN_RESUMED_FROM_PAUSE, run_resumed_from_pause_payload(
                reason="control webhook",
            ))
            _log("Pipeline resumed by control webhook", "ok")
            return
        elif action == "abort":
            raise PipelineInterrupted(f"Aborted via control webhook: {reason}", stop_reason="control_webhook")


def _check_control_response_with_timeout(
    ctx: EventContext,
    event: dict,
    *,
    timeout_seconds: int,
    timeout_default: str,
) -> str:
    """Deadline-aware wrapper around _check_control_response.

    Polls until the helper returns a non-None action OR the deadline elapses,
    in which case returns timeout_default and emits a log line.
    """
    deadline = time.monotonic() + timeout_seconds
    poll_interval = 5
    while time.monotonic() < deadline:
        action = _check_control_response(ctx, event)
        if action is not None:
            return action
        time.sleep(poll_interval)
    _log(f"pr_approval gate auto-approved on {timeout_seconds}s timeout (event={event.get('id')})", "warn")
    return timeout_default


def _base62(n: int, length: int = 3) -> str:
    """Encode an integer as a base62 string of fixed length."""
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    result = []
    for _ in range(length):
        result.append(chars[n % 62])
        n //= 62
    return "".join(reversed(result))


def _sanitize_branch_name(title: str) -> str:
    """Convert a title to a valid git branch name with a unique suffix."""
    name = title.lower().strip()
    name = re.sub(r'[^a-z0-9\-]', '-', name)
    name = re.sub(r'-+', '-', name)
    name = name.strip('-')
    suffix = _base62(int(time.time()) % (62 ** 3))
    return f"worca/{name[:40]}-{suffix}"


def _resolve_project_root_for_registration(
    settings_path: str, registry_base: Optional[str]
) -> str:
    """Pick the path that should be registered in ~/.worca/projects.d/.

    In worktree mode (registry_base is set) the worktree's settings_path
    points inside the worktree, so deriving project_root from it would
    register the worktree itself as a separate "project" named
    pipeline-<runid>. The parent project's .worca/ is the authoritative
    anchor; its parent directory is the real project root.

    In in-place mode, settings_path is <project>/.claude/settings.json,
    and dirname-twice gives the project root.
    """
    if registry_base:
        return os.path.dirname(os.path.abspath(registry_base))
    return os.path.dirname(os.path.dirname(os.path.abspath(settings_path)))


def _generate_run_id(started_at_iso: str) -> str:
    """Generate a unique run ID from an ISO timestamp.

    Format: YYYYMMDD-HHMMSS-mmm-xxxx
      - mmm  = milliseconds (3 digits, zero-padded)
      - xxxx = 4 random hex characters

    Example: 20260323-143052-847-a1b2
    """
    import secrets

    dt = datetime.fromisoformat(started_at_iso)
    millis = dt.microsecond // 1000
    suffix = secrets.token_hex(2)  # 2 bytes = 4 hex chars
    return f"{dt.strftime('%Y%m%d-%H%M%S')}-{millis:03d}-{suffix}"


def _slugify(title: str) -> str:
    """Convert a title to a URL-safe slug for filenames."""
    slug = title.lower().strip()
    slug = re.sub(r'[^a-z0-9\-]', '-', slug)
    slug = re.sub(r'-+', '-', slug)
    return slug.strip('-')[:60]


def _next_plan_path(run_dir: str) -> str:
    """Return the next sequential plan file path inside run_dir.

    Scans for existing ``plan-NNN.md`` files and returns the path for the
    next number in sequence (e.g. ``plan-001.md`` when none exist).
    Always uses 3-digit zero-padded format (max plan-999.md).
    """
    import glob as _glob

    existing = _glob.glob(os.path.join(run_dir, "plan-[0-9][0-9][0-9].md"))
    if not existing:
        return os.path.join(run_dir, "plan-001.md")

    # Extract the numeric parts and find the max
    nums = []
    for path in existing:
        m = re.search(r'plan-(\d{3})\.md$', path)
        if m:
            nums.append(int(m.group(1)))
    next_num = max(nums) + 1 if nums else 1
    if next_num > 999:
        next_num = 999  # Cap at plan-999.md to stay within 3-digit format
    return os.path.join(run_dir, f"plan-{next_num:03d}.md")


def _mint_plan_edit_target(run_dir: Optional[str], current_plan: str) -> Optional[str]:
    """Copy the current plan forward to the next numbered revision for editing.

    The Plan Editor (review_and_edit mode) rewrites the plan *in place*; to keep
    the Planner's original intact we copy ``plan-N.md`` to ``plan-(N+1).md`` and
    point the editor at the copy. The pre-edit ``plan-N.md`` is then the retained
    original — this reuses W-061's append-only numbering instead of a bespoke
    ``plan-original.md`` artifact.

    Returns the new ``plan-(N+1).md`` path, or ``None`` when there is nothing to
    copy (no run_dir, or the current plan file does not exist).
    """
    if not run_dir or not current_plan or not os.path.isfile(current_plan):
        return None
    target = _next_plan_path(run_dir)
    shutil.copy2(current_plan, target)
    return target


def _resolve_plan_path(template: str, timestamp: str, title: str) -> str:
    """Resolve a plan_path_template with variable substitution."""
    return template.format(timestamp=timestamp, title_slug=_slugify(title))


def _render_agent_templates(run_dir: str, template_vars: dict,
                            overrides_dir: str = ".claude/agents",
                            template_agents_dir: str | None = None) -> None:
    """Read agent .md templates from .claude/worca/agents/core/, replace placeholders,
    apply project overlays from overrides_dir and template overlays from
    template_agents_dir, write results to {run_dir}/agents/."""
    src_dir = ".claude/worca/agents/core"
    dst_dir = os.path.join(run_dir, "agents")
    os.makedirs(dst_dir, exist_ok=True)
    if not os.path.isdir(src_dir):
        return

    resolver = OverlayResolver(overrides_dir=overrides_dir)

    for filename in os.listdir(src_dir):
        if filename.endswith(".block.md"):
            continue
        if not filename.endswith(".md"):
            continue
        with open(os.path.join(src_dir, filename), encoding="utf-8") as f:
            content = f.read()
        agent_name = filename[:-3]  # strip .md
        content = resolver.resolve(agent_name, content,
                                   template_agents_dir=template_agents_dir)
        with open(os.path.join(dst_dir, filename), "w", encoding="utf-8") as f:
            f.write(content)


def _agent_path(agent_name: str, run_dir: str = None) -> str:
    """Resolve agent name to the .md definition file path.

    If run_dir is provided, checks for a rendered template there first.
    Falls back to the static template in .claude/worca/agents/core/.
    """
    if run_dir:
        rendered = os.path.join(run_dir, "agents", f"{agent_name}.md")
        if os.path.exists(rendered):
            return rendered
    return f".claude/worca/agents/core/{agent_name}.md"


def _schema_path(schema_name: str) -> str:
    """Resolve schema filename to full path."""
    return f".claude/worca/schemas/{schema_name}"


def _is_same_work_request(existing_wr: dict, new_wr: WorkRequest) -> bool:
    """Check if the existing status file is for the same work request."""
    # Match on source_ref first (most reliable), fall back to title
    if existing_wr.get("source_ref") and new_wr.source_ref:
        return existing_wr["source_ref"] == new_wr.source_ref
    return existing_wr.get("title", "") == new_wr.title


_TERMINAL_STATUSES = PIPELINE_TERMINAL


def _is_already_terminal(status_path: str, in_memory_status: dict | None = None) -> bool:
    """Return True if ANOTHER process already drove this run to a terminal state on disk.

    Disk read is required because the duplicate terminal event can arrive from a
    separate (orphaned) process — an in-process flag would not catch it (#113).

    A terminal status on disk only counts as "already terminal" (owned by someone
    else) when THIS process's in-memory status is itself still non-terminal.
    Otherwise we would suppress the run's *own* first terminal event: the
    control-file stop path writes pipeline_status=INTERRUPTED to disk *before*
    raising PipelineInterrupted, so by the time the except handler runs the disk
    is already terminal even though nobody else emitted anything. Passing the
    in-memory status lets the guard tell "we just wrote it" (emit) apart from
    "a different process wrote it" (skip).
    """
    try:
        with open(status_path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return False
    if data.get("pipeline_status") not in PIPELINE_ALL_TERMINAL:
        return False
    # Disk is terminal. If our own in-memory status is already terminal too, this
    # process drove it there — let the emit proceed. Only treat a terminal disk
    # state as a cross-process duplicate when our in-memory status is non-terminal.
    if (
        in_memory_status is not None
        and in_memory_status.get("pipeline_status") in PIPELINE_ALL_TERMINAL
    ):
        return False
    return True


def _find_active_runs(worca_dir: str) -> list:
    """Scan runs/*/status.json for non-terminal runs.

    Returns list of (run_id, status_path) tuples, sorted by run_id.
    Terminal statuses (completed, interrupted) are excluded.
    """
    runs_dir = os.path.join(worca_dir, "runs")
    result = []
    if not os.path.isdir(runs_dir):
        return result
    for run_id in sorted(os.listdir(runs_dir)):
        status_path = os.path.join(runs_dir, run_id, "status.json")
        if not os.path.isfile(status_path):
            continue
        try:
            with open(status_path, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("pipeline_status") not in _TERMINAL_STATUSES:
                result.append((run_id, status_path))
        except (json.JSONDecodeError, OSError):
            continue
    return result


def _pid_path(status_path: str) -> str:
    """Return the path to the PID file for this pipeline."""
    return os.path.join(os.path.dirname(status_path), "pipeline.pid")


def _write_pid(status_path: str) -> None:
    """Write our PID to the PID file."""
    path = _pid_path(status_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))


def _remove_pid(status_path: str) -> None:
    """Remove the PID file."""
    path = _pid_path(status_path)
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _elapsed_ms_since(started_at_iso: str) -> int:
    """Return milliseconds elapsed since an ISO 8601 timestamp, or 0 if unparseable."""
    if not started_at_iso:
        return 0
    try:
        from datetime import datetime as _dt, timezone as _tz
        started = _dt.fromisoformat(started_at_iso)
        if started.tzinfo is None:
            started = started.replace(tzinfo=_tz.utc)
        delta = _dt.now(_tz.utc) - started
        return max(0, int(delta.total_seconds() * 1000))
    except (ValueError, TypeError):
        return 0


def _emit_interrupted_event_signal_safe(ctx, status) -> None:
    """Append a pipeline.run.interrupted event from a signal handler.

    Writes the event to events.jsonl using only signal-safe file I/O AND stashes
    the event dict in _pending_signal_event so the main thread (run_pipeline's
    finally block) or atexit can later dispatch it to webhooks and integration
    shell-hooks. Webhook and shell-hook delivery cannot run in a signal handler
    because they perform network I/O, spawn threads, and import urllib/requests.

    Swallows all errors — signal-context callers cannot propagate exceptions.

    Signal-safety note: json.dumps, uuid.uuid4, and open() are not POSIX
    async-signal-safe in the strict sense. This relies on CPython's behavior of
    delivering signals between bytecode operations rather than mid-instruction,
    which makes it safe in practice but not portable to other Python runtimes.
    """
    global _pending_signal_event, _signal_event_emitted
    if _signal_event_emitted:
        return
    _signal_event_emitted = True
    import json as _json
    import uuid as _uuid
    from datetime import datetime as _dt, timezone as _tz

    fh = None
    try:
        event = {
            "schema_version": "1",
            "event_id": str(_uuid.uuid4()),
            "event_type": RUN_INTERRUPTED,
            "timestamp": _dt.now(_tz.utc).isoformat(),
            "run_id": ctx.run_id,
            "pipeline": {
                "branch": ctx.branch,
                "work_request": ctx.work_request,
            },
            "payload": {
                "interrupted_stage": status.get("current_stage", "unknown"),
                "elapsed_ms": _elapsed_ms_since(status.get("started_at", "")),
                "source": "signal",
            },
        }
        # Stash for deferred webhook dispatch before file I/O — ensures the event
        # is available for the webhook path even if the file write fails.
        _pending_signal_event = event
        line = _json.dumps(event, ensure_ascii=False)
        fh = open(ctx.events_path, "a", encoding="utf-8")
        fh.write(line + "\n")
        fh.flush()
    except Exception:
        pass
    finally:
        if fh is not None:
            try:
                fh.close()
            except Exception:
                pass


def _dispatch_pending_signal_event(ctx) -> None:
    """Dispatch the signal-stashed interrupted event to webhooks and shell hooks.

    Called from run_pipeline's finally block (normal exit after signal) and from
    _atexit_cleanup (process exit before finally completed). Idempotent: clears
    _pending_signal_event after dispatch so a follow-up call is a no-op.
    """
    global _pending_signal_event
    if _pending_signal_event is None or ctx is None:
        return
    event = _pending_signal_event
    _pending_signal_event = None
    try:
        dispatch_event(ctx, event)
    except Exception:
        pass


def _install_signal_handlers():
    """Install SIGTERM/SIGINT handlers that set the shutdown flag and kill the subprocess."""
    global _shutdown_requested

    def _handler(signum, frame):
        global _shutdown_requested
        _shutdown_requested = True
        terminate_current()
        # Layer 1: immediately persist interrupted status on signal
        if _signal_status is not None and _signal_status_path is not None:
            try:
                _signal_status["pipeline_status"] = PipelineStatus.INTERRUPTED
                if not _signal_status.get("stop_reason"):
                    _signal_status["stop_reason"] = "signal"
                save_status(_signal_status, _signal_status_path)
            except Exception:
                pass
            if _signal_event_ctx is not None:
                _emit_interrupted_event_signal_safe(_signal_event_ctx, _signal_status)
            # Clean up PID files (per-run + project-level)
            _remove_pid(_signal_status_path)
            if _signal_project_status_path:
                _remove_pid(_signal_project_status_path)

    try:
        signal.signal(signal.SIGTERM, _handler)
        signal.signal(signal.SIGINT, _handler)
    except (ValueError, OSError):
        pass


def _restore_signal_handlers():
    """Restore default signal handlers."""
    try:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
    except (ValueError, OSError):
        pass


def _atexit_cleanup():
    """Layer 4: fix stale 'running' status on normal Python exit.

    Covers cases where the finally block doesn't run (e.g. os._exit).
    Does NOT run on SIGKILL — that's covered by Node Layers 2-3.
    """
    if _signal_status is not None and _signal_status_path is not None:
        try:
            if _signal_status.get("pipeline_status") == PipelineStatus.RUNNING:
                _signal_status["pipeline_status"] = (
                    PipelineStatus.INTERRUPTED if _signal_event_ctx is not None else PipelineStatus.FAILED
                )
                if not _signal_status.get("stop_reason"):
                    _signal_status["stop_reason"] = "unexpected_exit"
                save_status(_signal_status, _signal_status_path)
                if _signal_event_ctx is not None:
                    # Full emit: writes to events.jsonl AND fires webhooks/integrations.
                    # atexit runs in normal Python context — network I/O is safe here.
                    emit_event(_signal_event_ctx, RUN_INTERRUPTED, run_interrupted_payload(
                        interrupted_stage=_signal_status.get("current_stage", "unknown"),
                        elapsed_ms=_elapsed_ms_since(_signal_status.get("started_at", "")),
                        source="atexit",
                    ))
            elif _signal_event_ctx is not None and _pending_signal_event is not None:
                # Signal handler already wrote an interrupted event but the main
                # thread's finally block didn't run (e.g. os._exit). Dispatch the
                # stashed event to webhooks/integrations now.
                _dispatch_pending_signal_event(_signal_event_ctx)
        except Exception:
            pass
        # Mirror the terminal status into the multi-pipeline registry so the UI
        # doesn't keep showing "running" for runs killed via os._exit / OOM /
        # SIGKILL where the finally block can't run. Best-effort.
        try:
            if (
                _signal_run_id
                and _signal_registry_dir
                and _signal_status.get("worktree")
                and _signal_status.get("pipeline_status") in {PipelineStatus.INTERRUPTED, PipelineStatus.FAILED, PipelineStatus.COMPLETED}
            ):
                update_pipeline(
                    _signal_run_id,
                    status=_signal_status["pipeline_status"],
                    base=_signal_registry_dir,
                )
        except Exception:
            pass
        # Clean up PID files (per-run + project-level)
        _remove_pid(_signal_status_path)
        if _signal_project_status_path:
            _remove_pid(_signal_project_status_path)


_orchestrator_log = None


def _init_orchestrator_log(logs_dir: str) -> None:
    """Open the orchestrator log file for appending."""
    global _orchestrator_log
    os.makedirs(logs_dir, exist_ok=True)
    _orchestrator_log = open(os.path.join(logs_dir, "orchestrator.log"), "a", encoding="utf-8")


def _close_orchestrator_log() -> None:
    """Close the orchestrator log file."""
    global _orchestrator_log
    if _orchestrator_log:
        _orchestrator_log.close()
        _orchestrator_log = None


def _log(msg: str, level: str = "info") -> None:
    """Print a timestamped progress message to stderr and log file."""
    ts = time.strftime("%H:%M:%S")
    prefix = {"info": "  ", "ok": "  \u2713", "err": "  \u2717", "warn": "  !"}
    line = f"[{ts}] {prefix.get(level, '  ')} {msg}"
    print(line, file=sys.stderr, flush=True)
    if _orchestrator_log:
        _orchestrator_log.write(line + "\n")
        _orchestrator_log.flush()


def _format_duration(seconds: float) -> str:
    """Format seconds into a human-readable duration."""
    if seconds < 60:
        return f"{seconds:.0f}s"
    m, s = divmod(int(seconds), 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m {s}s"


_ESCALATION_TRIGGERS = frozenset({
    "test_failure", "review_changes", "plan_review_revise", "restart_planning",
})


def format_effort_log_line(
    stage_label: str, iter_num: int, effort: dict | None, *, trigger: str = "initial",
) -> str | None:
    """Format a terse key=value effort log line per §6 of the W-052 plan.

    Returns None when effort is None (e.g. preflight).
    """
    if effort is None:
        return None

    level = effort.get("level")
    requested = effort.get("requested")
    source = effort.get("source", "model_default")
    capped_from = effort.get("capped_from")
    bc = effort.get("bead_classified")

    parts = [f"{stage_label} iter {iter_num}:"]

    parts.append(f"effort={level or '-'}")

    if requested and requested != level:
        parts.append(f"req={requested}")

    source_display = source.replace("adaptive:llm", "adaptive") if source else "model_default"
    parts.append(f"source={source_display}")

    if bc and bc.get("level") is not None:
        bead_level = bc["level"]
        if bc.get("applied"):
            parts.append(f"bead={bead_level}")
        elif bc.get("skip_reason") == "explicit_override":
            parts.append(f"bead={bead_level}(overridden)")
        else:
            parts.append(f"bead={bead_level}(ignored)")

    if iter_num > 1 and trigger in _ESCALATION_TRIGGERS:
        parts.append(f"+{trigger}")

    if capped_from:
        parts.append(f"capped_from={capped_from}")

    if requested and requested != level and source != "adaptive:llm":
        parts.append("model-collapsed")

    return " ".join(parts)


def _log_stage_metrics(
    stage_label: str,
    result: dict,
    raw_envelope: dict,
    *,
    cost_override: Optional[float] = None,
) -> None:
    """Log detailed metrics from a completed stage.

    When `cost_override` is provided, it is used as the cost figure instead of
    raw_envelope["total_cost_usd"]. The caller passes the override-aware value
    from `extract_token_usage(..., settings_path=...)` so the human-readable
    spawn-log line agrees with the persisted status.json record for
    alt-endpoint aliases (where Claude CLI's raw cost is not authoritative).
    """
    parts = []

    # Duration from envelope (more accurate than wall clock for agent time)
    duration_ms = raw_envelope.get("duration_ms")
    if duration_ms:
        parts.append(f"time={_format_duration(duration_ms / 1000)}")

    # Turns
    turns = raw_envelope.get("num_turns")
    if turns:
        parts.append(f"turns={turns}")

    # Cost — prefer the override-aware value from extract_token_usage when
    # supplied, fall back to the raw envelope number otherwise.
    cost = cost_override if cost_override is not None else raw_envelope.get("total_cost_usd")
    if cost:
        parts.append(f"cost=${cost:.2f}")

    # Tokens
    usage = raw_envelope.get("usage", {})
    out_tokens = usage.get("output_tokens", 0)
    if out_tokens:
        parts.append(f"output={out_tokens:,}tok")

    if parts:
        _log(f"{stage_label} metrics: {' | '.join(parts)}")

    # Stage-specific details
    if isinstance(result, dict):
        # Implement: files changed
        files = result.get("files_changed", [])
        if files:
            _log(f"{stage_label} files: {len(files)} changed")

        # Test: pass/fail
        if "passed" in result:
            failures = result.get("failures", [])
            if result["passed"]:
                _log(f"{stage_label} result: all tests passed", "ok")
            else:
                _log(f"{stage_label} result: {len(failures)} failure(s)", "err")

        # Review: outcome
        outcome = result.get("outcome")
        if outcome:
            level = "ok" if outcome == "approve" else "warn"
            _log(f"{stage_label} verdict: {outcome}", level)


def _save_stage_output(stage: Stage, result: dict, logs_dir: str = ".worca/logs", iteration: int = 1) -> None:
    """Save stage output to a per-iteration log file for resume support."""
    stage_dir = os.path.join(logs_dir, stage.value)
    os.makedirs(stage_dir, exist_ok=True)
    path = os.path.join(stage_dir, f"iter-{iteration}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)



def _run_learn_stage(status, prompt_builder, settings_path, run_dir,
                     termination_type, termination_reason, msize, logs_dir,
                     force=False, ctx=None):
    """Run the LEARN stage if enabled (or forced). Called after pipeline termination.

    Non-fatal: any exception is logged but not propagated.

    Args:
        force: If True, skip the is_learn_enabled() check. Used by the
               manual trigger (run_learn.py / UI button) so that learning
               analysis runs even when learn.enabled is false.
        ctx: Optional EventContext for emitting learn events.
    """
    if not force and not is_learn_enabled(settings_path):
        return
    _log("Running learn stage...", "info")
    actual_status_path = os.path.join(run_dir, "status.json") if run_dir else ".worca/status.json"
    learn_start = time.monotonic()
    try:
        # Feed context
        prompt_builder.update_context("full_status", status)
        prompt_builder.update_context("termination_type", termination_type)
        prompt_builder.update_context("termination_reason", termination_reason or "")
        plan_path = status.get("plan_file")
        if plan_path and os.path.exists(plan_path):
            with open(plan_path, encoding="utf-8") as f:
                prompt_builder.update_context("plan_file_content", f.read())

        # Initialize learn stage in status
        status["stages"]["learn"] = {"status": "pending", "agent": "learner"}
        start_iteration(status, "learn", agent="learner",
                        model="sonnet", trigger="initial")
        # Persist to disk so the UI sees learn as in_progress (not skipped)
        save_status(status, actual_status_path)

        if ctx:
            emit_event(ctx, STAGE_STARTED, stage_started_payload(
                stage="learn", iteration=1, agent="learner",
                model="sonnet", trigger="initial", max_turns=0,
            ))

        ctx_dict = prompt_builder.build_context("learn", 0)
        _learn_agent_name = "learner"
        _learn_template_path = (
            os.path.join(run_dir, "agents", f"{_learn_agent_name}.md")
            if run_dir else None
        )
        _learn_agent_override = None
        if (
            _learn_template_path
            and os.path.exists(_learn_template_path)
            and prompt_builder._resolver is not None
        ):
            with open(_learn_template_path, encoding="utf-8") as _f:
                _learn_content = _f.read()
            _learn_resolved = resolve_agent(
                _learn_content, ctx_dict,
                prompt_builder._resolver, prompt_builder._core_dir,
                prompt_builder._template_agents_dir,
            )
            _learn_resolved_dir = os.path.join(run_dir, "agents", "resolved")
            os.makedirs(_learn_resolved_dir, exist_ok=True)
            _learn_resolved_path = os.path.join(_learn_resolved_dir, f"learn-{_learn_agent_name}-iter-1.md")
            with open(_learn_resolved_path, "w", encoding="utf-8") as _f:
                _f.write(_learn_resolved)
            _learn_agent_override = _learn_resolved_path
        # Route learn.block.md into the -p user message (same pattern as
        # _STAGE_BLOCK_MAP in the main pipeline loop). This stage has its own
        # code path outside that loop, so the routing needs to be duplicated
        # here. Without this, the learner received only the raw work_request
        # title/description and missed run_data + files_changed_since_git_head,
        # which caused it to misread prior iterations' output as "pre-existing"
        # (see 20260413-063311-958-8068 W-038 run).
        rendered = ctx_dict.get("work_request", "")
        if prompt_builder._resolver and prompt_builder._core_dir:
            from worca.orchestrator.overlay import resolve_placeholders
            _learn_block = prompt_builder._resolver.resolve_block(
                "learn",
                prompt_builder._core_dir,
                prompt_builder._template_agents_dir,
            )
            if isinstance(_learn_block, str) and _learn_block:
                rendered = resolve_placeholders(_learn_block, ctx_dict).strip()

        # Persist the rendered -p prompt for UI/debugging visibility
        if status.get("stages", {}).get("learn"):
            status["stages"]["learn"]["prompt"] = rendered
            iters = status["stages"]["learn"].get("iterations", [])
            if iters:
                iters[-1]["prompt"] = rendered
            save_status(status, actual_status_path)

        result, raw = run_stage(Stage.LEARN, {}, settings_path, msize=msize,
                                prompt_override=rendered,
                                agent_override=_learn_agent_override)

        # Extract metrics from raw envelope (same pattern as the main loop)
        duration_ms = int((time.monotonic() - learn_start) * 1000)
        iter_extras = {
            "status": "completed",
            "outcome": "success",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": duration_ms,
            "output": result,
        }
        usage = extract_token_usage(raw, settings_path=settings_path) if isinstance(raw, dict) else {}
        if isinstance(raw, dict):
            if raw.get("duration_api_ms"):
                iter_extras["duration_api_ms"] = raw["duration_api_ms"]
            if raw.get("duration_ms"):
                iter_extras["duration_session_ms"] = raw["duration_ms"]
            if raw.get("num_turns"):
                iter_extras["turns"] = raw["num_turns"]
            _learn_cost = usage.get("total_cost_usd", raw.get("total_cost_usd"))
            if _learn_cost:
                iter_extras["cost_usd"] = _learn_cost
        if usage:
            iter_extras["token_usage"] = usage

        learn_cost = iter_extras.get("cost_usd", 0.0)
        learn_turns = iter_extras.get("turns", 0)
        learn_model = (usage.get("model") or
                       (raw.get("model") if isinstance(raw, dict) else None) or
                       "sonnet")

        complete_iteration(status, "learn", **iter_extras)
        update_stage(status, "learn", status="completed",
                     agent="learner", model=learn_model)

        # Save standalone learnings file
        learnings_path = None
        if run_dir:
            learnings_path = os.path.join(run_dir, "learnings.json")
            with open(learnings_path, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2)
        save_status(status, actual_status_path)
        _log("Learnings saved", "ok")
        if ctx:
            emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                stage="learn", iteration=1, duration_ms=duration_ms,
                cost_usd=learn_cost, turns=learn_turns, outcome="success",
            ))
            emit_event(ctx, LEARN_COMPLETED, learn_completed_payload(
                termination_type=termination_type,
                duration_ms=duration_ms,
                learnings_path=learnings_path,
            ))
    except Exception as e:
        _log(f"Learn stage failed (non-fatal): {e}", "warn")
        if ctx:
            try:
                elapsed_ms = int((time.monotonic() - learn_start) * 1000)
                emit_event(ctx, STAGE_FAILED, stage_failed_payload(
                    stage="learn", iteration=1, error=str(e),
                    error_type=type(e).__name__, elapsed_ms=elapsed_ms,
                ))
                emit_event(ctx, LEARN_FAILED, learn_failed_payload(
                    error=str(e),
                    duration_ms=elapsed_ms,
                    error_type=type(e).__name__,
                ))
            except Exception:
                pass
        try:
            complete_iteration(status, "learn", status="error", error=str(e),
                               completed_at=datetime.now(timezone.utc).isoformat())
            update_stage(status, "learn", status="error", error=str(e))
            save_status(status, actual_status_path)
        except Exception:
            pass


def _summarize_tool_input(block: dict) -> str:
    """Extract a short summary of a tool_use block's input for telemetry."""
    tool = block.get("name", "")
    inp = block.get("input", {})
    if tool in ("Read", "Write", "Edit"):
        return inp.get("file_path", "")
    if tool == "Bash":
        return (inp.get("command") or "")[:120]
    if tool == "Grep":
        return inp.get("pattern", "")
    if tool == "Glob":
        return inp.get("pattern", "")
    if tool == "Agent":
        return inp.get("description", "")
    return ""


def _is_agent_telemetry_enabled(settings_path: str) -> bool:
    """Check worca.events.agent_telemetry setting (defaults to True)."""
    try:
        settings = load_settings(settings_path)
        return settings.get("worca", {}).get("events", {}).get("agent_telemetry", True)
    except Exception:
        return True


_GRAPHIFY_READ_VERBS = frozenset({"query", "explain", "path", "affected", "diagnose"})


def _is_graphify_read_query(command: str) -> bool:
    """True if a Bash command invokes a read-only graphify subcommand.

    Counted per iteration for the run-detail "Graphify" badge. Mirrors the
    guard's parsing (strips a leading ``cd … &&`` and matches the first token
    after a ``graphify`` executable) but matches the *read* verbs, not the
    blocked mutating ones.
    """
    if not command:
        return False
    actual = command.split("&&", 1)[1].strip() if "&&" in command else command.strip()
    try:
        tokens = shlex.split(actual)
    except ValueError:
        return False
    for i, tok in enumerate(tokens):
        if os.path.basename(tok) == "graphify" and i + 1 < len(tokens):
            return tokens[i + 1] in _GRAPHIFY_READ_VERBS
    return False


_CRG_MCP_PREFIX = "mcp__code-review-graph__"


def _is_crg_tool_use(tool_name: str) -> bool:
    """True if a tool_use event name is a CRG MCP tool call."""
    return bool(tool_name) and tool_name.startswith(_CRG_MCP_PREFIX)


def _crg_tool_basename(tool_name: str) -> str:
    """Bare CRG tool name with the ``mcp__code-review-graph__`` prefix stripped.

    Used to build the per-tool breakdown ({"get_minimal_context_tool": 3}) shown
    in the CRG invocation badge tooltip.
    """
    return tool_name[len(_CRG_MCP_PREFIX):]


def _make_agent_event_handler(
    ctx: Optional[EventContext],
    stage: Stage,
    iteration: int,
    settings_path: str,
):
    """Create an on_event callback closure for agent telemetry.

    Returns None if ctx is None or agent_telemetry is disabled.
    The returned callable translates stream-json events to pipeline events.
    """
    if ctx is None:
        return None
    if not _is_agent_telemetry_enabled(settings_path):
        return None

    turn_counter = [0]
    tool_id_to_name: dict = {}

    def handler(event: dict) -> None:
        etype = event.get("type", "")

        if etype == "system":
            if event.get("subtype") == "init":
                emit_event(ctx, AGENT_SPAWNED, agent_spawned_payload(
                    stage=stage.value,
                    iteration=iteration,
                    agent=STAGE_AGENT_MAP.get(stage, ""),
                    model=event.get("model", ""),
                    max_turns=0,
                ))
            # All other system subtypes (hook, etc.) are silently ignored.

        elif etype == "assistant":
            turn_counter[0] += 1
            turn = turn_counter[0]
            content = event.get("message", {}).get("content", [])
            for block in content:
                btype = block.get("type", "")
                if btype == "tool_use":
                    tool_name = block.get("name", "")
                    tool_id = block.get("id", "")
                    if tool_id:
                        tool_id_to_name[tool_id] = tool_name
                    emit_event(ctx, AGENT_TOOL_USE, agent_tool_use_payload(
                        stage=stage.value,
                        iteration=iteration,
                        tool=tool_name,
                        tool_input_summary=_summarize_tool_input(block),
                        turn=turn,
                    ))
                elif btype == "text":
                    text = block.get("text", "")
                    if text:
                        emit_event(ctx, AGENT_TEXT, agent_text_payload(
                            stage=stage.value,
                            iteration=iteration,
                            text_length=len(text),
                            turn=turn,
                        ))

        elif etype == "user":
            content = event.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        tool_id = block.get("tool_use_id", "")
                        tool_name = tool_id_to_name.get(tool_id, "")
                        emit_event(ctx, AGENT_TOOL_RESULT, agent_tool_result_payload(
                            stage=stage.value,
                            iteration=iteration,
                            tool=tool_name,
                            is_error=block.get("is_error", False),
                            turn=turn_counter[0],
                        ))

        elif etype == "result":
            emit_event(ctx, AGENT_COMPLETED, agent_completed_payload(
                stage=stage.value,
                iteration=iteration,
                turns=event.get("num_turns", 0),
                cost_usd=event.get("total_cost_usd", 0.0),
                duration_ms=event.get("duration_ms", 0),
                exit_code=0,
            ))

    return handler


def run_stage(
    stage: Stage,
    context: dict,
    settings_path: str = ".claude/settings.json",
    msize: int = 1,
    iteration: int = 1,
    prompt_override: str = None,
    agent_override: str = None,
    ctx: Optional[EventContext] = None,
    env_overrides: Optional[dict] = None,
    graphify_out: Optional[str] = None,
    crg_data_dir: Optional[str] = None,
) -> tuple[dict, dict]:
    """Run a single pipeline stage.

    Gets stage config via get_stage_config(), calls run_agent() with the
    appropriate agent path, prompt, max_turns, and schema.

    Args:
        context: Dict with 'prompt', '_run_dir', '_logs_dir' keys.
        msize: Multiplier for max_turns (1-10). E.g. msize=2 doubles turns.
        iteration: Current iteration number (1-indexed). Controls log file path.
        prompt_override: When provided, used instead of context["prompt"].
        agent_override: When provided, used as the --agent path instead of the
            default _agent_path(). Allows per-stage resolved templates to be
            passed directly to the claude CLI.
        env_overrides: Extra env vars merged into model_env before passing to
            run_agent(). Used for CLAUDE_CODE_EFFORT_LEVEL injection.
        graphify_out: When set, exported as GRAPHIFY_OUT in the agent
            subprocess so on-demand `graphify query` reads the per-commit
            cache snapshot. Resolved at preflight when the graph is ready.
        crg_data_dir: When set, builds a per-agent MCP config pointing at the
            run-scoped CRG database so the agent gets code-review-graph MCP
            tools filtered to the stage's allow-list.

    Returns (structured_output, raw_envelope) tuple. The structured_output
    is the schema-conforming result used by pipeline logic. The raw_envelope
    is the full claude CLI JSON response for logging.
    """
    config = get_stage_config(stage, settings_path=settings_path)
    # PR stage uses a different schema when the run defers PR creation to a
    # parent orchestrator (workspace child). Two schemas instead of one
    # conditional schema keeps each flat — the Claude API rejects custom
    # tools whose input_schema has top-level allOf/oneOf/anyOf.
    if stage == Stage.PR and compute_defer_pr(os.environ):
        config = {**config, "schema": "pr-deferred.json"}
    max_turns = config["max_turns"] * msize
    raw_prompt = context.get("prompt", "")
    prompt = prompt_override if prompt_override is not None else raw_prompt
    logs_dir = context.get("_logs_dir", ".worca/logs")
    run_dir = context.get("_run_dir")
    log_dir = os.path.join(logs_dir, stage.value)
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, f"iter-{iteration}.log")
    _telemetry_on_event = _make_agent_event_handler(ctx, stage, iteration, settings_path)
    # Count read-only graphify queries this iteration, independent of telemetry,
    # for the run-detail "Graphify" badge. Wraps (not replaces) the telemetry
    # handler so disabling agent_telemetry doesn't zero the count.
    _gfx_metrics = {"graphify_invocations": 0, "crg_invocations": 0}
    # Per-tool CRG breakdown (e.g. {"get_minimal_context_tool": 3}), surfaced in
    # the invocation badge's hover tooltip. Keyed by the bare tool name (the
    # mcp__code-review-graph__ prefix stripped).
    _crg_tool_counts: dict[str, int] = {}

    def _on_event(event):
        if event.get("type") == "assistant":
            for _block in event.get("message", {}).get("content", []) or []:
                if _block.get("type") == "tool_use":
                    _tool = _block.get("name", "")
                    if _tool == "Bash":
                        if _is_graphify_read_query((_block.get("input") or {}).get("command", "")):
                            _gfx_metrics["graphify_invocations"] += 1
                    elif _is_crg_tool_use(_tool):
                        _gfx_metrics["crg_invocations"] += 1
                        _bare = _crg_tool_basename(_tool)
                        _crg_tool_counts[_bare] = _crg_tool_counts.get(_bare, 0) + 1
        if _telemetry_on_event is not None:
            _telemetry_on_event(event)

    # Wire the counting wrapper only when there's an event context (always true
    # in real runs, where run_dir/events.jsonl exist); without ctx we preserve
    # the historical "no on_event handler" contract — and there's no
    # status.json to record a count into anyway.
    on_event = _on_event if ctx is not None else None

    agent = agent_override if agent_override is not None else _agent_path(config["agent"], run_dir=run_dir)
    merged_env = dict(config.get("model_env") or {})
    if env_overrides:
        merged_env.update(env_overrides)

    _mcp_config: Optional[str] = None
    if crg_data_dir:
        _agent_role = STAGE_AGENT_MAP.get(stage, "")
        _crg_tools = crg_tools_for_stage(
            _agent_role or "",
            stage_tools=_resolve_crg_stage_tools(settings_path),
        )
        if _crg_tools:
            _mcp_config = crg_mcp_config(
                repo_root=os.getcwd(),
                data_dir=crg_data_dir,
                crg_tools=_crg_tools,
            )

    raw = run_agent(
        prompt=prompt,
        agent=agent,
        max_turns=max_turns,
        output_format="stream-json",
        json_schema=_schema_path(config["schema"]),
        model=config.get("model"),
        model_alias=config.get("cost_alias"),
        model_env=merged_env,
        log_path=log_path,
        on_event=on_event,
        graphify_out=graphify_out,
        mcp_config=_mcp_config,
        run_dir=run_dir,
        stage=stage.value,
        iteration=iteration,
    )
    _gfx = _gfx_metrics["graphify_invocations"]
    _crg = _gfx_metrics["crg_invocations"]
    _crg_tc = dict(_crg_tool_counts)
    # Per-iteration counts ride on the *envelope* (2nd return), never on the
    # structured result, so they can't pollute the agent's output.
    # claude CLI returns a JSON envelope; extract structured_output if present.
    if isinstance(raw, dict) and raw.get("structured_output"):
        raw["graphify_invocations"] = _gfx
        raw["crg_invocations"] = _crg
        raw["crg_tool_counts"] = _crg_tc
        return raw["structured_output"], raw
    # Fallback for stages whose agent occasionally returns prose instead of
    # JSON. Currently only Guardian (PR stage) — its prompt was rewritten to
    # emit JSON-only, but pre-existing runs and the occasional slip would
    # otherwise lose pr_number/pr_url. Recover what we can from the prose so
    # downstream events (GIT_PR_CREATED, status.json) still see the PR.
    if stage == Stage.PR and isinstance(raw, dict):
        recovered = _extract_pr_fields_from_text(raw.get("result"))
        if recovered:
            raw["graphify_invocations"] = _gfx
            raw["crg_invocations"] = _crg
            raw["crg_tool_counts"] = _crg_tc
            return recovered, raw
    # Generic fallback: result == envelope here, so attach the count to a copy
    # for the envelope and leave the returned result dict untouched.
    if isinstance(raw, dict):
        return raw, {
            **raw,
            "graphify_invocations": _gfx,
            "crg_invocations": _crg,
            "crg_tool_counts": _crg_tc,
        }
    return raw, raw


def _extract_pr_fields_from_text(text) -> Optional[dict]:
    """Pull pr_url and pr_number out of free-form agent prose.

    Matches GitHub `/pull/N` and GitLab `/merge_requests/N` URLs. Returns None
    if no PR URL is found. Defensive only — the proper fix is for the agent
    to emit structured output.
    """
    if not isinstance(text, str):
        return None
    import re
    m = re.search(r"https?://[^\s)\]\>]+/(?:pull|merge_requests)/(\d+)", text)
    if not m:
        return None
    return {"pr_url": m.group(0), "pr_number": int(m.group(1))}


PRVerification = collections.namedtuple("PRVerification", ["ok", "reason"])


def _verify_pr_via_gh(pr_number: int, expected_url: str, timeout: int = 10) -> Optional[PRVerification]:
    """Best-effort `gh pr view` check.

    Confirms the PR actually exists on the hosting platform and that its URL
    matches the URL guardian reported — defends against a fabricated `pr_url`
    that passes structural checks.

    Returns:
        PRVerification on a definitive answer (PR exists and matches → ok=True;
        gh ran cleanly but the PR is missing or the URL differs → ok=False).
        None when gh could not run a meaningful check (binary missing, no auth,
        no remote, transport error). Callers fall back on local invariants.
    """
    try:
        r = subprocess.run(
            ["gh", "pr", "view", str(pr_number), "--json", "url,number"],
            capture_output=True, text=True, timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if r.returncode != 0:
        stderr_lower = (r.stderr or "").lower()
        for needle in (
            "auth", "gh_token", "no such remote", "not a git repo",
            "no default remote", "no git remote", "could not determine",
        ):
            if needle in stderr_lower:
                return None
        return PRVerification(
            ok=False,
            reason=f"gh pr view #{pr_number} failed: {(r.stderr or '').strip()[:200]}",
        )
    try:
        data = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return None
    actual_number = data.get("number")
    actual_url = data.get("url")
    if actual_number != pr_number:
        return PRVerification(
            ok=False,
            reason=f"gh returned PR #{actual_number}, guardian reported #{pr_number}",
        )
    if actual_url and actual_url != expected_url:
        return PRVerification(
            ok=False,
            reason=f"PR URL mismatch: gh has {actual_url!r}, guardian reported {expected_url!r}",
        )
    return PRVerification(ok=True, reason="")


def _verify_pr_stage(stage_output, baseline_head: str, gh_lookup=None) -> PRVerification:
    """Post-condition check after the PR stage reports success.

    Validates these invariants:
    1. stage_output is a structured dict.
    2. git HEAD changed from baseline_head (a new commit was made).
    3. The reported commit_sha is a prefix of (or equal to) the actual HEAD SHA.

    When `stage_output.deferred is True` (workspace child with WORCA_DEFER_PR=1
    — the parent orchestrator creates the PR centrally after the integration
    test passes), only the three invariants above are checked. The guardian
    legitimately has no pr_number / pr_url to report.

    Otherwise the PR-creation invariants also apply:
    4. stage_output carries pr_url + pr_number.
    5. (Best-effort) `gh pr view <pr_number>` confirms the PR exists and its
       URL matches `pr_url`. Skipped silently when gh cannot run.

    Args:
        stage_output: Structured output dict from the guardian agent.
        baseline_head: git HEAD SHA captured before the PR stage ran.
        gh_lookup: Optional callable(pr_number, expected_url) → PRVerification|None.
            Defaults to _verify_pr_via_gh. Tests inject a stub.

    Returns:
        PRVerification(ok=True, reason="") on success, or
        PRVerification(ok=False, reason=<explanation>) on failure.
    """
    if not isinstance(stage_output, dict):
        return PRVerification(ok=False, reason="stage output is not a structured dict")

    deferred = stage_output.get("deferred") is True

    required = ["commit_sha"] if deferred else ["commit_sha", "pr_url", "pr_number"]
    for field in required:
        if field not in stage_output:
            return PRVerification(ok=False, reason=f"missing required field: {field}")

    actual_head = get_current_git_head()

    if actual_head == baseline_head:
        return PRVerification(ok=False, reason="no new commit on HEAD — git HEAD unchanged from baseline")

    reported_sha = stage_output["commit_sha"]
    if not actual_head.startswith(reported_sha):
        return PRVerification(
            ok=False,
            reason=f"commit sha mismatch: reported {reported_sha!r} but HEAD is {actual_head!r}",
        )

    if deferred:
        # Parent orchestrator will create + verify the PR centrally; no
        # pr_number/pr_url to check here.
        return PRVerification(ok=True, reason="")

    if gh_lookup is None:
        gh_lookup = _verify_pr_via_gh
    gh_result = gh_lookup(stage_output["pr_number"], stage_output["pr_url"])
    if gh_result is not None and not gh_result.ok:
        return gh_result

    return PRVerification(ok=True, reason="")


def _resolve_crg_stage_tools(settings_path: str) -> dict | None:
    """Read worca.code_review_graph.stage_tools from settings."""
    try:
        settings = load_settings(settings_path)
        return settings.get("worca", {}).get("code_review_graph", {}).get("stage_tools")
    except Exception:
        return None


def _reattach_crg_on_resume(status, prompt_builder):
    """Re-flag CRG availability when resuming past PREFLIGHT.

    Returns the run-scoped crg_data_dir when it still exists on disk, else None.
    """
    crg_data_dir = status.get("crg_data_dir")
    if crg_data_dir and os.path.isdir(crg_data_dir):
        prompt_builder.set_crg_available(True)
        _log("Resume: re-flagged CRG availability")
        return crg_data_dir
    return None


def _crg_post_implement_refresh(
    crg_data_dir: str,
    project_root: str,
    *,
    timeout: int = 30,
) -> bool:
    """Run ``code-review-graph update`` on the run-scoped DB after IMPLEMENT.

    Blocking (tester needs updated graph). On timeout/failure: returns False
    so the caller can log a warning and proceed with a stale graph.
    """
    env = {**os.environ, "CRG_REPO_ROOT": os.path.abspath(project_root), "CRG_DATA_DIR": crg_data_dir}
    try:
        proc = subprocess.run(
            ["code-review-graph", "update"],
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode == 0
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return False


def _maybe_crg_post_guardian(
    *,
    settings_path: str = ".claude/settings.json",
    is_worktree: bool = False,
) -> None:
    """Fire-and-forget: warm the per-commit CRG base cache for the NEW HEAD
    after a successful guardian commit.

    Mirrors _maybe_graphify_post_guardian. Skipped in worktree runs.
    Failures are logged, never raised.
    """
    if is_worktree:
        return

    try:
        settings = load_settings(settings_path)
        global_settings = load_global_settings()
        cfg = effective_crg_config(global_settings, settings)

        if not cfg.enabled:
            return
        if not cfg.update_on_guardian_post_commit:
            return

        detect = detect_code_review_graph(cfg.version_range, cfg.fastmcp_min)
        if not detect.installed or not detect.compatible or not detect.fastmcp_ok:
            return

        subprocess.Popen(
            [
                sys.executable,
                "-c",
                "from worca.scripts.crg_preflight import "
                "run_crg_preflight as r; r()",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        _log("CRG post-guardian cache-warm started (fire-and-forget)")
    except Exception as exc:
        _log(f"CRG post-guardian refresh failed: {exc}", "warn")


def _reattach_graphify_on_resume(status, prompt_builder):
    """Re-flag graphify availability when resuming past PREFLIGHT.

    The PREFLIGHT handler that flips ``has_graphify`` and resolves the
    ``GRAPHIFY_OUT`` dir is skipped on resume, so a resumed run would otherwise
    lose on-demand graph access. The report path persisted in
    ``status['graphify_report_path']`` at the original preflight identifies the
    snapshot's ``graphify/`` directory. Returns that directory (the value to
    export as ``GRAPHIFY_OUT`` for subsequent agents) when a ready snapshot
    still exists on disk, else None.
    """
    report_path = status.get("graphify_report_path")
    if report_path and os.path.isfile(report_path):
        prompt_builder.set_graphify_available(True)
        _log("Resume: re-flagged graphify availability")
        return os.path.dirname(report_path)
    return None


def _maybe_graphify_post_guardian(
    *,
    settings_path: str = ".claude/settings.json",
    is_worktree: bool = False,
) -> None:
    """Fire-and-forget: warm the per-commit graph cache for the NEW HEAD after
    a successful guardian commit.

    The commit changed HEAD, so there's no in-place "update" — we build a fresh
    snapshot for the new sha. Reuses the locked build+publish path in
    run_graphify_preflight (run detached so the pipeline reports complete
    immediately). Skipped in worktree runs. Failures are logged, never raised.
    """
    if is_worktree:
        return

    try:
        settings = load_settings(settings_path)
        global_settings = load_global_settings()
        cfg = effective_graphify_config(global_settings, settings)

        if not cfg.enabled:
            return
        if not cfg.update_on_guardian_post_commit:
            return

        detect = detect_graphify(cfg.version_range)
        if not detect.installed or not detect.compatible:
            return

        subprocess.Popen(
            [
                sys.executable,
                "-c",
                "from worca.scripts.graphify_preflight import "
                "run_graphify_preflight as r; r()",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            # Windows: silently ignored — detach not guaranteed (use WSL2).
            start_new_session=True,
        )
        _log("Graphify post-guardian cache-warm started (fire-and-forget)")
    except Exception as exc:
        _log(f"Graphify post-guardian refresh failed: {exc}", "warn")


def run_preflight(
    context: dict,
    settings_path: str = ".claude/settings.json",
    iteration: int = 1,
) -> dict:
    """Run the preflight checks script.

    Reads the script path from worca.stages.preflight.script in settings.
    If the script does not exist, returns a skipped result with a warning.
    Otherwise runs the script via subprocess.Popen with sys.executable,
    captures stdout/stderr, writes to log file, parses JSON, logs each check.

    Returns:
        Parsed JSON dict from the script, or a skipped indicator dict.

    Raises:
        PipelineError: When the script exits with non-zero code or output
            is not valid JSON.
    """
    settings = load_settings(settings_path)

    default_script = ".claude/worca/scripts/preflight_checks.py"
    script_path = (
        settings.get("worca", {})
        .get("stages", {})
        .get("preflight", {})
        .get("script", default_script)
    )

    if not os.path.exists(script_path):
        _log(f"Preflight script not found at {script_path!r}, skipping", "warn")
        return {"status": "skipped", "checks": [], "summary": "preflight skipped (script not found)"}

    logs_dir = context.get("_logs_dir", ".worca/logs")
    log_dir = os.path.join(logs_dir, "preflight")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, f"iter-{iteration}.log")

    proc = subprocess.Popen(
        [sys.executable, script_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, stderr = proc.communicate()

    with open(log_path, "w", encoding="utf-8") as log_file:
        log_file.write(stdout)
        if stderr:
            log_file.write("\n--- STDERR ---\n")
            log_file.write(stderr)

    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        raise PipelineError(f"Preflight script output is not valid JSON: {stdout[:200]!r}")

    for check in result.get("checks", []):
        name = check.get("name", "?")
        check_status = check.get("status", "?")
        msg = check.get("message", "")
        level = "ok" if check_status == "pass" else "warn" if check_status == "warn" else "err"
        _log(f"  preflight/{name}: {check_status} — {msg}", level)

    summary = result.get("summary", "")
    if summary:
        _log(f"Preflight: {summary}")

    if proc.returncode != 0:
        raise PipelineError(f"Preflight failed: {summary}")

    graphify_result = run_graphify_preflight(settings_path=settings_path)
    result["graphify_status"] = graphify_result.get("status", "skipped")
    if graphify_result.get("report_path"):
        result["graphify_report_path"] = graphify_result["report_path"]
    if graphify_result.get("outcome"):
        result["graphify_outcome"] = graphify_result["outcome"]
    if graphify_result.get("mode"):
        result["graphify_mode"] = graphify_result["mode"]
    if graphify_result.get("reason"):
        result["graphify_reason"] = graphify_result["reason"]

    # Seed the run-scoped writable copy at <cwd>/code-review-graph using an
    # ABSOLUTE run_dir (CRG opens the DB read-write; an absolute CRG_DATA_DIR
    # resolves regardless of the agent subprocess cwd, matching graphify's
    # absolute GRAPHIFY_OUT). The base/throwaway snapshot is published to the
    # per-commit cache regardless.
    crg_result = run_crg_preflight(settings_path=settings_path, run_dir=os.getcwd())
    result["crg_status"] = crg_result.get("status", "skipped")
    if crg_result.get("crg_data_dir"):
        result["crg_data_dir"] = crg_result["crg_data_dir"]
    if crg_result.get("outcome"):
        result["crg_outcome"] = crg_result["outcome"]
    if crg_result.get("reason"):
        result["crg_reason"] = crg_result["reason"]

    return result


def check_loop_limit(
    loop_name: str,
    current_iteration: int,
    settings_path: str = ".claude/settings.json",
    mloops: int = 1,
) -> bool:
    """Check if the current iteration is within the configured loop limit.

    Reads loop limits from settings.json under worca.loops namespace.
    Returns True if current_iteration < limit, False if exhausted.
    If no limit configured, defaults to 10.

    Args:
        mloops: Multiplier for the loop limit (1-10). E.g. mloops=2 doubles max loops.
    """
    default_limit = 5
    settings = load_settings(settings_path)

    loops = settings.get("worca", {}).get("loops", {})
    limit = loops.get(loop_name, default_limit) * mloops
    return current_iteration < limit


def _get_loop_limit(loop_name: str, settings_path: str, mloops: int = 1, default: int = 5) -> int:
    """Return the configured loop limit for event payloads."""
    settings = load_settings(settings_path)
    return settings.get("worca", {}).get("loops", {}).get(loop_name, default) * mloops


def handle_pr_review(outcome: str, status: dict) -> tuple:
    """Handle the outcome of a PR review.

    Args:
        outcome: One of "approve", "request_changes", "reject", "restart_planning"
        status: Current pipeline status dict

    Returns:
        Tuple of (next_stage_or_None, updated_status).
        None for next_stage means pipeline is complete or stopped.
    """
    status["pr_review_outcome"] = outcome
    if outcome == "approve":
        return (None, status)
    elif outcome == "request_changes":
        return (Stage.IMPLEMENT, status)
    elif outcome == "reject":
        return (None, status)
    elif outcome == "restart_planning":
        return (Stage.PLAN, status)
    else:
        return (None, status)


def _accumulate_design_note(prompt_builder, result: dict, trigger: str) -> None:
    """Accumulate design_notes from an implement result into prompt context."""
    new_note = result.get("design_notes", "")
    all_notes = prompt_builder.get_context("all_design_notes") or []

    if trigger in ("initial", "next_bead"):
        if new_note:
            bead_id = result.get("bead_id", "")
            all_notes.append({"bead_id": bead_id, "note": new_note})
        prompt_builder.update_context("all_design_notes", all_notes)
    elif trigger in ("test_failure", "review_changes"):
        if new_note:
            bead_id = prompt_builder.get_context("assigned_bead_id") or result.get("bead_id", "")
            replaced = False
            for i, entry in enumerate(all_notes):
                if entry["bead_id"] == bead_id:
                    all_notes[i] = {"bead_id": bead_id, "note": new_note}
                    replaced = True
                    break
            if not replaced:
                all_notes.append({"bead_id": bead_id, "note": new_note})
            prompt_builder.update_context("all_design_notes", all_notes)


def _query_ready_bead(allowed_ids: list[str] | None = None, run_id: str | None = None) -> dict | None:
    """Query bd ready and return the first available bead, or None.

    Args:
        allowed_ids: If provided, only return beads whose ID is in this list.
        run_id: If provided, pass --label run:{run_id} to bd ready so only
                beads from this run are returned. Without this, the 10-item
                display limit in bd ready can be filled by unrelated beads.
    """
    if os.environ.get("WORCA_SKIP_BEADS"):
        return None
    try:
        label = f"run:{run_id}" if run_id else None
        items = bd_ready(label=label)
        if allowed_ids is not None:
            allowed_set = set(allowed_ids)
            items = [b for b in items if b["id"] in allowed_set]
        if items:
            return items[0]
    except Exception:
        pass
    return None


def _claim_bead(bead_id: str) -> bool:
    """Claim a bead by setting its status to in_progress."""
    return bd_update(bead_id, status="in_progress")


def _clear_stale_daemon_lock(beads_dir: str) -> None:
    """Remove daemon.pid and daemon.lock when the recorded PID is no longer running.

    Uses os.kill(pid, 0) to probe liveness without sending a signal.
    If the PID is live or PermissionError is raised (process owned by another user),
    the files are left untouched.  If the pidfile is absent, this is a no-op.
    """
    pid_path = os.path.join(beads_dir, "daemon.pid")
    lock_path = os.path.join(beads_dir, "daemon.lock")
    try:
        with open(pid_path, encoding="utf-8") as fh:
            pid_text = fh.read().strip()
        pid = int(pid_text)
    except (FileNotFoundError, ValueError):
        return
    try:
        alive = pid_is_alive(pid)
    except PermissionError:
        return
    if not alive:
        for p in (pid_path, lock_path):
            try:
                os.remove(p)
            except FileNotFoundError:
                pass


def _ensure_beads_initialized() -> None:
    """Check if beads is initialized in the current project, init if not."""
    import subprocess
    if os.environ.get("WORCA_SKIP_BEADS"):
        return
    _clear_stale_daemon_lock(os.path.join(os.getcwd(), ".beads"))
    from worca.utils.env import get_env
    env = get_env()
    result = subprocess.run(
        ["bd", "stats"], capture_output=True, text=True, env=env
    )
    if result.returncode != 0:
        init_result = subprocess.run(
            ["bd", "init"], capture_output=True, text=True, env=env
        )
        if init_result.returncode != 0:
            raise PipelineError(f"Failed to initialize beads: {init_result.stderr}")


def run_pipeline(
    work_request: WorkRequest,
    plan_file: Optional[str] = None,
    resume: bool = False,
    settings_path: str = ".claude/settings.json",
    status_path: str = ".worca/status.json",
    msize: int = 1,
    mloops: int = 1,
    branch: Optional[str] = None,
    skip_preflight: bool = False,
    on_git_divergence=None,
    worktree: bool = False,
    pipeline_template: Optional[str] = None,
    registry_base: Optional[str] = None,
    run_id: Optional[str] = None,
) -> dict:
    """Run the full pipeline for a single work request.

    Creates branch, initializes status, then runs stages in sequence:
    PLAN -> (milestone gate) -> COORDINATE -> IMPLEMENT -> TEST -> REVIEW -> PR

    Handles loops:
    - test failure -> back to implement
    - review changes -> back to implement

    Args:
        plan_file: Path to a pre-made plan file. When provided, the PLAN
            stage is skipped and agents reference this file directly.
        resume: If True, attempt to resume a previous run for the same work
            request from status.json. If False (default), always start fresh
            and archive any existing run.
        msize: Multiplier for max_turns per stage (1-10).
        mloops: Multiplier for max loop iterations (1-10).

    Checks loop limits, raises LoopExhaustedError when exceeded.
    Saves status after each stage transition.
    Returns final status.
    """
    global _shutdown_requested, _signal_status, _signal_status_path, _signal_project_status_path, _signal_event_ctx, _pending_signal_event, _signal_event_emitted, _signal_registry_dir, _signal_run_id
    _shutdown_requested = False
    _pending_signal_event = None
    _signal_event_emitted = False

    # status_path can arrive in two shapes:
    #   <worca>/status.json                       (legacy flat layout)
    #   <worca>/runs/<run_id>/status.json         (caller targeted a specific run,
    #                                              e.g. worca-ui resume passing the
    #                                              per-run dir as --status-dir)
    # In the second shape, dirname(status_path) is the per-run dir, not the worca
    # root. Treating it as the worca root caused every <worca_dir>/runs/<run_id>/
    # join below to nest a fresh runs/<run_id>/ underneath, so the runner wrote
    # status updates and the registry to a shadow path while the original
    # status.json was never touched. Recover the real worca root so all joins
    # below land on the existing run dir.
    _status_dir = os.path.dirname(status_path)
    if os.path.basename(os.path.dirname(_status_dir)) == "runs":
        worca_dir = os.path.dirname(os.path.dirname(_status_dir))
    else:
        worca_dir = _status_dir
    # In worktree mode the registry lives in the parent project's .worca/, not
    # the worktree's. Caller passes its absolute path; in-place runs use worca_dir.
    registry_dir = registry_base or worca_dir
    run_dir = None
    actual_status_path = status_path  # may be redirected to per-run dir

    # Auto-register project for global worca-ui discovery (non-fatal).
    # See _resolve_project_root_for_registration for why worktree mode needs
    # the parent project's path, not the worktree's.
    try:
        from worca.utils.project_registry import auto_register_project
        project_root = _resolve_project_root_for_registration(
            settings_path, registry_base
        )
        auto_register_project(project_root)
    except Exception:
        pass

    # Signal handlers (PID file written after run_id is known)
    _install_signal_handlers()

    # Scan runs/ for a non-terminal run; fall back to legacy flat status.json
    active_runs = _find_active_runs(worca_dir)
    existing = None
    if len(active_runs) == 1:
        run_id_candidate, candidate = active_runs[0]
        existing = load_status(candidate)
        if existing:
            actual_status_path = candidate
            run_dir = os.path.join(worca_dir, "runs", run_id_candidate)
    elif len(active_runs) > 1:
        # Worktree-isolated runs should always see ≤1 active run per .worca/.
        # >1 means a legacy in-place project has multiple non-terminal runs;
        # we can't pick deterministically, so fall through to fresh-start.
        _log(
            f"WARNING: found {len(active_runs)} non-terminal runs in {worca_dir}/runs/ "
            f"({', '.join(rid for rid, _ in active_runs)}); "
            "starting fresh instead of resuming. Use --run-id to target a specific run.",
            "warn",
        )
    if existing is None:
        existing = load_status(status_path)

    resume_stage = None

    _branch_just_created = False
    if resume and existing and _is_same_work_request(existing.get("work_request", {}), work_request):
        # Explicit resume requested and same work request found
        from worca.orchestrator.resume import find_resume_point, check_git_divergence, restore_loop_counters, backfill_prompt_context
        resume_stage = find_resume_point(existing)
        if resume_stage is not None:
            # Git divergence guard: warn if HEAD changed since pipeline start
            divergence = check_git_divergence(existing)
            if divergence["diverged"]:
                _log(
                    f"WARNING: git HEAD has changed since pipeline start "
                    f"(was {divergence['stored'][:8]}, now {divergence['current'][:8]}). "
                    "Code changes made since then are not part of this run.",
                    "warn",
                )
                if on_git_divergence is not None:
                    proceed = on_git_divergence(divergence["stored"], divergence["current"])
                    if not proceed:
                        return existing
            _log(f"Resuming from {resume_stage.value.upper()}")
            status = existing
            branch_name = status.get("branch", "")
            # Derive run_dir from status if not already set
            if not run_dir and status.get("run_id"):
                run_dir = os.path.join(worca_dir, "runs", status["run_id"])
                actual_status_path = os.path.join(run_dir, "status.json")

            # Write PID to per-run directory (+ project-level for backward compat)
            _write_pid(actual_status_path)
            _write_pid(status_path)

            # Overwrite the registry's pid with the live runner's PID.
            # run_worktree.py / the original launcher registered with its own
            # (parent) PID before forking into us; without this update the
            # stale_pid reconciler ghosts a healthy resumed run within seconds.
            # Only meaningful in worktree mode — that's where the multi-pipeline
            # registry exists. Mirrors the worktree gate every other
            # update_pipeline call in this file uses.
            if (
                status.get("worktree")
                and status.get("run_id")
                and registry_dir
            ):
                update_pipeline(
                    status["run_id"], base=registry_dir, pid=os.getpid()
                )

            # Clear stale control.json left over from a previous stop/pause that
            # killed the process before it could consume the file.  Without this,
            # the first iteration of the resumed pipeline would read the old
            # command and immediately stop/pause again.
            if status.get("run_id"):
                delete_control(status["run_id"], base=worca_dir)

            if run_dir:
                orphans = kill_all_tracked(os.path.join(run_dir, "procs"))
                if orphans:
                    _log(f"Killed {orphans} orphaned process group(s) from previous run", "warn")
        else:
            _log("Pipeline already completed", "ok")
            return existing  # all done
    else:
        # Fresh start — previous runs stay in runs/ (no archival)
        if branch:
            branch_name = branch
        elif worktree:
            # Worktree mode: branch already created by worktree setup, detect it
            branch_name = current_branch() or _sanitize_branch_name(work_request.title)
        else:
            branch_name = _sanitize_branch_name(work_request.title)
            create_branch(branch_name)
            _branch_just_created = True

        wr_dict = dataclasses.asdict(work_request)
        status = init_status(wr_dict, branch_name, git_head=get_current_git_head(), pipeline_template=pipeline_template)

        if worktree:
            status["worktree"] = True

        # target_branch is the PR base branch (what the PR merges into).
        # Sourced from WORCA_TARGET_BRANCH env var (highest priority) or the
        # --branch flag, which in worktree mode names the base branch.
        status["target_branch"] = os.environ.get("WORCA_TARGET_BRANCH") or branch or None

        # Create per-run directory. In worktree mode the caller (run_worktree.py)
        # passes the run_id it already used to register the pipeline, so the
        # registry key and the runner's run_id stay in lockstep — otherwise
        # update_pipeline() silently can't find the entry on completion.
        if not run_id:
            run_id = _generate_run_id(status["started_at"])
        status["run_id"] = run_id
        run_dir = os.path.join(worca_dir, "runs", run_id)
        os.makedirs(os.path.join(run_dir, "agents"), exist_ok=True)
        os.makedirs(os.path.join(run_dir, "logs"), exist_ok=True)
        actual_status_path = os.path.join(run_dir, "status.json")

        # Write PID to per-run directory
        _write_pid(actual_status_path)

        # Overwrite the registry's pid with the live runner's PID.
        # run_worktree.py registered with its own (parent) PID before
        # forking into us; without this update the stale_pid reconciler
        # ghosts a healthy pipeline within seconds. Only meaningful in
        # worktree mode — see the resume-path comment for full rationale.
        if status.get("worktree") and registry_dir:
            update_pipeline(run_id, base=registry_dir, pid=os.getpid())

        save_status(status, actual_status_path)

        # The pipelines.d/ entry is a pointer (run_id, worktree_path, pid),
        # not a state mirror. Stage transitions are recorded in status.json
        # inside the worktree's run dir; the registry is only touched again
        # for terminal status updates (completed/failed). Avoiding mid-run
        # writes keeps the registry stable and removes a class of bugs where
        # the registry's "stage" goes stale because the runner forgets to
        # update it (the W-049 follow-up bug surfaced exactly this).

        # Notify GitHub issue that pipeline has started (no-op for non-GH sources)
        gh_issue_start(status)

    logs_dir = os.path.join(run_dir, "logs") if run_dir else os.path.join(worca_dir, "logs")
    _init_orchestrator_log(logs_dir)

    # Wire up signal/atexit status refs for crash safety (Layers 1 & 4)
    _signal_status = status
    _signal_status_path = actual_status_path
    _signal_project_status_path = status_path  # project-level for PID cleanup
    _signal_registry_dir = registry_dir
    _signal_run_id = status.get("run_id")
    atexit.register(_atexit_cleanup)

    ctx = None
    try:
        _log(f"Pipeline: {work_request.title}")
        _log(f"Branch: {branch_name}")
        pipeline_t0 = time.time()

        # Initialize EventContext for structured event emission
        events_path = os.path.join(run_dir, "events.jsonl") if run_dir else None
        if events_path:
            ctx = EventContext(
                run_id=status.get("run_id", ""),
                branch=branch_name,
                work_request=status.get("work_request", {}),
                events_path=events_path,
                settings_path=settings_path,
            )
            _signal_event_ctx = ctx
            os.environ["WORCA_EVENTS_PATH"] = events_path

            # Validate control webhooks: warn and skip those without a secret.
            # (control_webhooks property already enforces this, this is just logging.)
            try:
                _all_wh = load_settings(settings_path).get("worca", {}).get("webhooks", [])
                for _wh in _all_wh:
                    if _wh.get("control") and not _wh.get("secret"):
                        _log(
                            f"[webhook] Control webhook {_wh.get('url', '?')} has no "
                            "secret configured — skipping for security",
                            "warn",
                        )
            except Exception:
                pass

            if resume_stage is not None:
                previous = [
                    s for s, v in status.get("stages", {}).items()
                    if v.get("status") == PipelineStatus.COMPLETED
                ]
                emit_event(ctx, RUN_RESUMED, run_resumed_payload(
                    resume_stage=resume_stage.value,
                    previous_stages_completed=previous,
                ))
            else:
                emit_event(ctx, RUN_STARTED, run_started_payload(
                    resume=False,
                    started_at=status.get("started_at", ""),
                    plan_file=status.get("plan_file"),
                ))

            if _branch_just_created:
                emit_event(ctx, GIT_BRANCH_CREATED, git_branch_created_payload(
                    branch=branch_name,
                ))

        context = {
            "prompt": work_request.description or work_request.title,
            "_run_dir": run_dir,
            "_logs_dir": logs_dir,
        }
        if resume_stage:
            loop_counters = restore_loop_counters(status)
        else:
            loop_counters = {}
        # Captured once on first entry to the PR stage; preserved across
        # PR-stage retries so iter_2 verification compares against the same
        # pre-stage HEAD as iter_1.
        _pr_baseline_head: Optional[str] = None
        max_beads = 0

        # Initialize PromptBuilder for context threading across stages
        prompt_context_path = os.path.join(run_dir, "prompt_context.json") if run_dir else None
        _pb_settings = load_settings(settings_path)
        _pb_worca = _pb_settings.get("worca", {})
        _pb_overrides_dir = _pb_worca.get("agent_overrides_dir", ".claude/agents")
        _pb_template_agents_dir = _pb_worca.get("_template_agents_dir")
        _pb_core_dir = ".claude/worca/agents/core"
        prompt_builder = PromptBuilder(
            work_request.title,
            work_request.description,
            resolver=OverlayResolver(overrides_dir=_pb_overrides_dir),
            core_dir=_pb_core_dir,
            template_agents_dir=_pb_template_agents_dir,
            run_dir=run_dir,
            work_request_guide_content=work_request.guide_content,
        )
        # Resolved <snapshot>/graphify dir exported as GRAPHIFY_OUT to each
        # post-preflight agent when the graph is ready. Set at PREFLIGHT (fresh
        # runs) or by _reattach_graphify_on_resume (resumed runs).
        _graphify_out: Optional[str] = None
        # Run-scoped CRG data dir passed to run_stage() so each agent gets a
        # CRG MCP server pointed at the writable copy. Set at PREFLIGHT or
        # reattached on resume.
        _crg_data_dir: Optional[str] = None
        _crg_cfg: Optional[EffectiveCrgConfig] = None
        if resume_stage and prompt_context_path:
            prompt_builder.load_context(prompt_context_path)
            _backfilled = backfill_prompt_context(prompt_builder, status, logs_dir)
            if _backfilled:
                _log(f"Resume backfill: populated {len(_backfilled)} missing context key(s): {', '.join(_backfilled)}")
            # Restore max_beads from persisted context — the COORDINATE stage
            # that originally set it will be skipped on resume.
            resumed_beads = prompt_builder.get_context("beads_ids")
            if resumed_beads:
                max_beads = len(resumed_beads)
            # Re-flag graphify availability on resume — the PREFLIGHT handler
            # that sets has_graphify + GRAPHIFY_OUT is skipped on resume.
            _graphify_out = _reattach_graphify_on_resume(status, prompt_builder)
            _crg_data_dir = _reattach_crg_on_resume(status, prompt_builder)
            if _crg_data_dir:
                try:
                    _crg_cfg = effective_crg_config(
                        load_global_settings(), load_settings(settings_path)
                    )
                except Exception:
                    pass

        # Transition pipeline to running state
        status["pipeline_status"] = PipelineStatus.RUNNING
        save_status(status, actual_status_path)
        # On resume, the registry was previously flipped to "interrupted" /
        # "failed" when the original run stopped. Flip it back so the UI's
        # filter-by-registry-status views surface the live run again.
        if resume_stage is not None and status.get("worktree") and status.get("run_id"):
            try:
                update_pipeline(status["run_id"], status="running", base=registry_dir)
            except Exception:
                pass

        # Read effort settings once at pipeline start
        _effort_settings = load_settings(settings_path).get("worca", {}).get("effort", {})
        _effort_auto_mode = _effort_settings.get("auto_mode", "adaptive")
        _effort_auto_cap = _effort_settings.get("auto_cap", "xhigh")
        _log(f"Effort: auto_mode={_effort_auto_mode}, auto_cap={_effort_auto_cap}")

        stage_order = get_enabled_stages(settings_path)

        # Handle plan file
        if not resume_stage:
            if plan_file:
                # Pre-made plan: ingest a COPY into the run dir as the first
                # numbered plan (plan-001.md) so the run owns an immutable
                # snapshot of its input. The original source file is never
                # mutated mid-run (no source dirtying, no PR pollution, no
                # misleading working-tree diff). Revisions append plan-002.md,
                # plan-003.md, … (latest = highest number). See W-061.
                if run_dir:
                    _ingest_dest = _next_plan_path(run_dir)  # plan-001.md
                    shutil.copy2(plan_file, _ingest_dest)
                    status["plan_file"] = _ingest_dest
                    status["plan_source"] = plan_file  # audit: original location
                    prompt_builder.update_context("plan_file_path", _ingest_dest)
                    _log(f"Ingested provided plan -> {_ingest_dest} (source: {plan_file})", "ok")
                else:
                    # Legacy / no run_dir: reference directly (cannot snapshot).
                    status["plan_file"] = plan_file
                    prompt_builder.update_context("plan_file_path", plan_file)
                    _log(f"Pre-made plan: {plan_file}", "ok")
            else:
                # Generated plan: write to {run_dir}/plan-NNN.md
                if run_dir:
                    status["plan_file"] = _next_plan_path(run_dir)
                else:
                    # Fallback when no run_dir (legacy / tests)
                    _settings = load_settings(settings_path)
                    template = _settings.get("worca", {}).get(
                        "plan_path_template", "docs/plans/{timestamp}-{title_slug}.md"
                    )
                    status["plan_file"] = _resolve_plan_path(
                        template,
                        timestamp=status["run_id"] or datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S"),
                        title=work_request.title,
                    )

            # Set env vars for hooks
            os.environ["WORCA_PLAN_FILE"] = status["plan_file"]
            if status.get("run_id"):
                os.environ["WORCA_RUN_ID"] = status["run_id"]
            if run_dir:
                os.environ["WORCA_RUN_DIR"] = run_dir

            # Render agent templates with plan_file and other vars
            if run_dir:
                _render_settings = load_settings(settings_path)
                _render_worca = _render_settings.get("worca", {})
                overrides_dir = _render_worca.get(
                    "agent_overrides_dir", ".claude/agents"
                )
                template_agents_dir = _render_worca.get("_template_agents_dir")
                # Guardian template vars (#165) are threaded into PromptBuilder
                # context below — _render_agent_templates only performs overlay
                # merging, placeholders are resolved at agent-dispatch time.
                _render_agent_templates(run_dir, {
                    "plan_file": status["plan_file"],
                    "run_id": status.get("run_id", ""),
                    "branch": branch_name,
                    "title": work_request.title,
                }, overrides_dir=overrides_dir,
                   template_agents_dir=template_agents_dir)

            save_status(status, actual_status_path)

        # Ensure hook env vars are set for both new and resumed runs
        os.environ["WORCA_PLAN_FILE"] = status.get("plan_file") or ""

        # Thread template variables into PromptBuilder for {{placeholder}} resolution
        if status.get("plan_file"):
            prompt_builder.update_context("plan_file", status["plan_file"])
        prompt_builder.update_context("run_id", status.get("run_id", ""))
        prompt_builder.update_context("branch", branch_name)
        prompt_builder.update_context("title", work_request.title)
        # Guardian template variables (issue #165): derived once here so the
        # dispatch-time resolve_agent call resolves {{pr_title_prefix}},
        # {{pr_footer}}, and {{#if defer_pr}} in guardian.md. Computed from
        # the current process env, which carries the fleet/workspace child
        # WORCA_* vars set by run_fleet.py / dag_executor.py.
        for key, value in build_guardian_context(os.environ).items():
            prompt_builder.update_context(key, value)
        if status.get("run_id"):
            os.environ["WORCA_RUN_ID"] = status["run_id"]

        # Determine starting index
        if resume_stage:
            if resume_stage in stage_order:
                stage_idx = stage_order.index(resume_stage)
            else:
                # resume_stage is disabled (e.g. PREFLIGHT) — start from the
                # first enabled stage; the skip-completed logic below will
                # advance past already-done stages to the actual resume point.
                _log(f"Resume stage {resume_stage.value!r} is disabled — starting from first enabled stage")
                stage_idx = 0
        elif plan_file:
            # Mark PLAN stage as completed with pre-loaded status
            update_stage(status, Stage.PLAN.value,
                         status="completed", skipped=True, plan_file=plan_file)
            set_milestone(status, "plan_approved", True)
            if ctx:
                _ms_event = emit_event(ctx, MILESTONE_SET, milestone_set_payload(
                    milestone="plan_approved", value=True, stage=Stage.PLAN.value,
                ))
                if _ms_event:
                    _action = _check_control_response(ctx, _ms_event)
                    if _action == "pause":
                        _handle_pause(ctx, "plan_approved milestone")
                    elif _action == "abort":
                        raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
            save_status(status, actual_status_path)

            # Start from the beginning (includes PREFLIGHT) — PLAN will be
            # skipped in the main loop because it's already marked completed.
            stage_idx = 0
        else:
            stage_idx = 0

        # Track triggers for loop-back iterations
        _next_trigger = {}  # {stage_value: trigger_reason}

        while stage_idx < len(stage_order):
            current_stage = stage_order[stage_idx]

            # --- Control file polling ---
            _check_control_file(status.get("run_id"), worca_dir, status, actual_status_path, ctx, registry_dir)

            # Skip stages pre-marked as skipped (e.g. PLAN when plan_file provided)
            existing_stage = status.get("stages", {}).get(current_stage.value, {})
            if existing_stage.get("skipped"):
                _log(f"{current_stage.value.upper()} already completed — skipping")
                stage_idx += 1
                continue

            # On resume, skip stages already completed (PREFLIGHT always re-runs).
            # Once we reach a non-completed stage (the actual resume point),
            # clear resume_stage so subsequent loop-backs (e.g. implement→test)
            # don't incorrectly skip stages that were "completed" in a prior loop.
            if resume_stage and current_stage != Stage.PREFLIGHT:
                if existing_stage.get("status") == "completed":
                    _log(f"{current_stage.value.upper()} already completed — skipping on resume")
                    stage_idx += 1
                    continue
                else:
                    resume_stage = None

            # Update current stage tracker
            status["stage"] = current_stage.value

            # Determine iteration trigger and number
            trigger = _next_trigger.pop(current_stage.value, "initial")
            stage_config = get_stage_config(current_stage, settings_path=settings_path)

            # Preserve existing iterations but reset stage-level status
            prev_iterations = status.get("stages", {}).get(current_stage.value, {}).get("iterations", [])
            prev_iteration_count = status.get("stages", {}).get(current_stage.value, {}).get("iteration")
            stage_started = datetime.now(timezone.utc).isoformat()
            status["stages"][current_stage.value] = {
                "status": "in_progress",
                "started_at": stage_started,
                "agent": stage_config["agent"],
                "model": stage_config["model"],
                # model_alias preserves the user-typed alias (e.g. "glm-ds")
                # alongside the resolved id ("opus"). Omit when the user's
                # configured value IS already the resolved id, so old runs and
                # plain-model configs are unchanged on disk (backward compat).
                **(
                    {"model_alias": stage_config["model_alias"]}
                    if stage_config.get("model_alias")
                    else {}
                ),
            }
            if prev_iterations:
                status["stages"][current_stage.value]["iterations"] = prev_iterations
            if prev_iteration_count:
                status["stages"][current_stage.value]["iteration"] = prev_iteration_count

            # Resolve effort level for non-preflight stages
            _effort_env_overrides = {}
            _effort_dict = None
            if current_stage != Stage.PREFLIGHT and stage_config["agent"]:
                _assigned_bead = (
                    prompt_builder.get_context("assigned_bead_id")
                    if current_stage == Stage.IMPLEMENT else None
                )
                if _assigned_bead is None and current_stage == Stage.IMPLEMENT:
                    _bead_ids = prompt_builder.get_context("beads_ids") or []
                    if _bead_ids:
                        _assigned_bead = _bead_ids[0]
                # Escalation depth counts only escalation-relevant loopbacks,
                # NOT total stage iterations (per-bead Phase-1 fan-out would
                # otherwise inflate the multiplier — see escalation_iter_num).
                _eff_iter_num = escalation_iter_num(
                    stage_config["agent"] or "",
                    trigger,
                    [it.get("trigger") for it in prev_iterations],
                )
                _eff_level, _eff_requested, _eff_source, _eff_base, _eff_bc, _eff_capped = resolve_effort(
                    agent=stage_config["agent"],
                    agent_effort=stage_config["effort"],
                    auto_mode=_effort_auto_mode,
                    auto_cap=_effort_auto_cap,
                    trigger=trigger,
                    iter_num=_eff_iter_num,
                    bead=_assigned_bead,
                    model=stage_config["model"] or "",
                )
                _iter_num = len(prev_iterations) + 1
                _escalations = (
                    [trigger] if trigger in _ESCALATION_TRIGGERS and _iter_num > 1
                    else []
                )
                _effort_dict = {
                    "level": _eff_level,
                    "requested": _eff_requested,
                    "source": _eff_source,
                    "base": _eff_base,
                    "escalations": _escalations,
                    "capped_from": _eff_capped,
                    "bead_classified": _eff_bc,
                }
                if _eff_level is not None:
                    _effort_env_overrides["CLAUDE_CODE_EFFORT_LEVEL"] = _eff_level

            # Start a new iteration record
            _iter_kwargs = {
                "agent": stage_config["agent"],
                "model": stage_config["model"],
                "trigger": trigger,
                "effort": _effort_dict,
            }
            # Only set model_alias when distinct from the resolved id — keeps
            # old runs and plain-model configs unchanged on disk.
            if stage_config.get("model_alias"):
                _iter_kwargs["model_alias"] = stage_config["model_alias"]
            iter_record = start_iteration(
                status, current_stage.value,
                **_iter_kwargs,
            )
            iter_num = iter_record["number"]
            save_status(status, actual_status_path)
            if ctx:
                emit_event(ctx, STAGE_STARTED, stage_started_payload(
                    stage=current_stage.value,
                    iteration=iter_num,
                    agent=stage_config["agent"],
                    model=stage_config.get("model", ""),
                    trigger=trigger,
                    max_turns=(stage_config.get("max_turns") or 0) * msize,
                    effort=_effort_dict,
                ))
                if current_stage == Stage.TEST:
                    emit_event(ctx, TEST_SUITE_STARTED, test_suite_started_payload(
                        stage=current_stage.value,
                        iteration=iter_num,
                        trigger=trigger,
                    ))
                elif current_stage == Stage.REVIEW:
                    emit_event(ctx, REVIEW_STARTED, review_started_payload(
                        iteration=iter_num,
                        files_under_review=prompt_builder.get_context("files_changed"),
                    ))

            stage_label = current_stage.value.upper()
            iter_label = f" (iter {iter_num})" if iter_num > 1 else ""
            _effort_line = format_effort_log_line(stage_label, iter_num, _effort_dict, trigger=trigger)
            if _effort_line:
                _log(_effort_line)
            else:
                _log(f"{stage_label}{iter_label} starting...")
            t0 = time.time()

            # Check shutdown flag between stages
            if _shutdown_requested:
                complete_iteration(status, current_stage.value, status="interrupted")
                update_stage(status, current_stage.value, status="interrupted")
                save_status(status, actual_status_path)
                if ctx:
                    emit_event(ctx, STAGE_INTERRUPTED, stage_interrupted_payload(
                        stage=current_stage.value,
                        iteration=iter_num,
                        elapsed_ms=int((time.time() - t0) * 1000),
                    ))
                raise PipelineInterrupted("Pipeline interrupted before stage start", stop_reason="signal")

            # --- Phase 1 bead assignment (IMPLEMENT only) ---
            if current_stage == Stage.IMPLEMENT:
                if trigger in ("initial", "next_bead"):
                    # Phase 1: implement all beads sequentially
                    run_bead_ids = prompt_builder.get_context("beads_ids")
                    bead = _query_ready_bead(allowed_ids=run_bead_ids, run_id=status.get("run_id"))
                    if bead:
                        bead_id = bead["id"]
                        _claim_bead(bead_id)
                        if ctx:
                            emit_event(ctx, BEAD_ASSIGNED, bead_assigned_payload(
                                bead_id=bead_id,
                                title=bead["title"],
                                iteration=loop_counters.get("bead_iteration", 0) + 1,
                            ))
                        prompt_builder.update_context("assigned_bead_id", bead_id)
                        prompt_builder.update_context("assigned_bead_title", bead["title"])
                        try:
                            details = bd_show(bead_id)
                            prompt_builder.update_context("assigned_bead_description", details.get("description", ""))
                        except Exception:
                            prompt_builder.update_context("assigned_bead_description", "")
                elif trigger in ("test_failure", "review_changes"):
                    prompt_builder.update_context("assigned_bead_title", None)
                    prompt_builder.update_context("assigned_bead_description", None)

            # Build stage-specific context and resolve agent template per-stage
            if current_stage != Stage.PREFLIGHT:
                if current_stage.value == "implement":
                    pb_iteration = prompt_builder.get_context("bead_prompt_iteration") or 0
                else:
                    pb_iteration = loop_counters.get(f"{current_stage.value}_iteration", 0)

                ctx_dict = prompt_builder.build_context(current_stage.value, pb_iteration)
                _stage_agent_name = stage_config["agent"]
                if current_stage == Stage.PLAN_REVIEW:
                    _pr_mode, _pr_mode_reason = resolve_plan_review_mode(
                        load_settings(settings_path)
                    )
                    update_stage(status, current_stage.value, mode=_pr_mode, mode_reason=_pr_mode_reason)
                    save_status(status, actual_status_path)
                    if _pr_mode == "review_and_edit":
                        _stage_agent_name = "plan_editor"
                        _effort_env_overrides["WORCA_PLAN_REVIEWER_CAN_EDIT"] = "1"
                        # W-061 reconciliation: the editor rewrites the *next*
                        # numbered revision in place (plan-(N+1).md); the pre-edit
                        # plan-N.md is the retained original (append-only history).
                        # Copy forward, then re-point every consumer (status,
                        # WORCA_PLAN_FILE, {{plan_file}}) and re-render so the
                        # editor's writable-path matches the guard carve-out.
                        # Idempotent across crash/resume via the plan_edit_target
                        # marker (cleared in the PLAN_REVIEW handler).
                        _pre_edit_plan = status.get("plan_file", "")
                        _already_minted = (
                            bool(_pre_edit_plan)
                            and status.get("plan_edit_target") == _pre_edit_plan
                            and os.path.isfile(_pre_edit_plan)
                        )
                        if not _already_minted:
                            _edit_target = _mint_plan_edit_target(run_dir, _pre_edit_plan)
                            if _edit_target:
                                status["plan_file"] = _edit_target
                                status["plan_edit_target"] = _edit_target
                                status["plan_pre_edit_file"] = _pre_edit_plan
                                os.environ["WORCA_PLAN_FILE"] = _edit_target
                                prompt_builder.update_context("plan_file", _edit_target)
                                if prompt_context_path:
                                    prompt_builder.save_context(prompt_context_path)
                                save_status(status, actual_status_path)
                                _em_worca = load_settings(settings_path).get("worca", {})
                                _render_agent_templates(run_dir, {
                                    "plan_file": status["plan_file"],
                                    "run_id": status.get("run_id", ""),
                                    "branch": branch_name,
                                    "title": work_request.title,
                                }, overrides_dir=_em_worca.get(
                                       "agent_overrides_dir", ".claude/agents"),
                                   template_agents_dir=_em_worca.get("_template_agents_dir"))
                                # Rebuild ctx so {{plan_content}} reflects the copy.
                                ctx_dict = prompt_builder.build_context(
                                    current_stage.value, pb_iteration)
                                _log(f"Plan edit -> {_edit_target} "
                                     f"(original retained: {_pre_edit_plan})", "ok")
                _template_path = (
                    os.path.join(run_dir, "agents", f"{_stage_agent_name}.md")
                    if run_dir else None
                )

                if (
                    _template_path
                    and os.path.exists(_template_path)
                    and prompt_builder._resolver is not None
                ):
                    with open(_template_path, encoding="utf-8") as _f:
                        _agent_content = _f.read()
                    _resolved = resolve_agent(
                        _agent_content, ctx_dict,
                        prompt_builder._resolver, prompt_builder._core_dir,
                        prompt_builder._template_agents_dir,
                    )
                    _resolved_dir = os.path.join(run_dir, "agents", "resolved")
                    os.makedirs(_resolved_dir, exist_ok=True)
                    _resolved_path = os.path.join(
                        _resolved_dir, f"{current_stage.value}-{_stage_agent_name}-iter-{iter_num}.md"
                    )
                    with open(_resolved_path, "w", encoding="utf-8") as _f:
                        _f.write(_resolved)
                    _agent_override = _resolved_path
                else:
                    _agent_override = None

                # Default -p payload: minimal work request. Used when no stage
                # block exists, the resolver isn't configured, or for stages
                # without an associated block (preflight — already excluded above).
                rendered_prompt = (
                    f"## Work Request\n\n**{work_request.title}**\n\n"
                    f"{work_request.description or work_request.title}"
                )

                # Route the stage's .block.md to the -p user message (pre-W-037
                # contract): system prompt stays role/rules-only, dynamic
                # per-iteration content travels as a user message. Keeps W-037's
                # three-tier overlay + placeholder flexibility intact.
                _block_name = _STAGE_BLOCK_MAP.get(current_stage)
                if current_stage == Stage.PLAN_REVIEW and _pr_mode == "review_and_edit":
                    _block_name = "plan-edit"
                if (
                    _block_name
                    and prompt_builder._resolver is not None
                    and prompt_builder._core_dir is not None
                ):
                    from worca.orchestrator.overlay import resolve_placeholders
                    _block = prompt_builder._resolver.resolve_block(
                        _block_name,
                        prompt_builder._core_dir,
                        prompt_builder._template_agents_dir,
                    )
                    if isinstance(_block, str) and _block:
                        rendered_prompt = resolve_placeholders(_block, ctx_dict).strip()

                # Store rendered prompt in status for UI visibility
                status["stages"][current_stage.value]["prompt"] = rendered_prompt
                iter_record["prompt"] = rendered_prompt
                save_status(status, actual_status_path)
            else:
                rendered_prompt = None
                _agent_override = None

            # Run the stage
            try:
                # Ensure beads is initialized before coordinate stage
                if current_stage == Stage.COORDINATE:
                    _ensure_beads_initialized()

                if current_stage == Stage.PREFLIGHT and skip_preflight:
                    _log("PREFLIGHT skipped (--skip-preflight)", "warn")
                    stage_completed = datetime.now(timezone.utc).isoformat()
                    _elapsed_ms = int((time.time() - t0) * 1000)
                    complete_iteration(
                        status, current_stage.value,
                        status="completed",
                        completed_at=stage_completed,
                    )
                    update_stage(
                        status, current_stage.value,
                        status="completed",
                        skipped=True,
                        completed_at=stage_completed,
                    )
                    save_status(status, actual_status_path)
                    if ctx:
                        emit_event(ctx, PREFLIGHT_SKIPPED, preflight_skipped_payload(
                            reason="--skip-preflight",
                        ))
                        _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                            stage=current_stage.value,
                            iteration=iter_num,
                            duration_ms=_elapsed_ms,
                            cost_usd=0.0,
                            turns=0,
                            outcome="skipped",
                        ))
                        if _sc_event:
                            _action = _check_control_response(ctx, _sc_event)
                            if _action == "pause":
                                _handle_pause(ctx, f"{current_stage.value} stage.completed")
                            elif _action == "abort":
                                raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                    stage_idx += 1
                    continue
                elif current_stage == Stage.PREFLIGHT:
                    result = run_preflight(context, settings_path, iteration=iter_num)
                    raw_envelope = {"type": "preflight", "checks": result.get("checks", [])}
                else:
                    # Re-check shutdown flag before spawning a subprocess.
                    # The first check (above) runs before context building;
                    # a signal arriving during that ~160-line gap would set the
                    # flag but miss the earlier guard.  Without this second
                    # check the new subprocess starts, hangs, and nothing
                    # kills it (terminate_current already fired as a no-op).
                    if _shutdown_requested:
                        raise InterruptedError("Pipeline shutdown requested before stage execution")
                    if current_stage == Stage.PR and _pr_baseline_head is None:
                        _pr_baseline_head = get_current_git_head()
                    result, raw_envelope = run_stage(
                        current_stage, context, settings_path,
                        msize=msize, iteration=iter_num,
                        prompt_override=rendered_prompt,
                        agent_override=_agent_override,
                        ctx=ctx,
                        env_overrides=_effort_env_overrides,
                        graphify_out=_graphify_out,
                        crg_data_dir=_crg_data_dir,
                    )
            except InterruptedError:
                stage_completed = datetime.now(timezone.utc).isoformat()
                complete_iteration(
                    status, current_stage.value,
                    status="interrupted",
                    completed_at=stage_completed,
                )
                update_stage(
                    status, current_stage.value,
                    status="interrupted",
                    completed_at=stage_completed,
                )
                save_status(status, actual_status_path)
                if ctx:
                    emit_event(ctx, STAGE_INTERRUPTED, stage_interrupted_payload(
                        stage=current_stage.value,
                        iteration=iter_num,
                        elapsed_ms=int((time.time() - t0) * 1000),
                    ))
                raise PipelineInterrupted(f"Pipeline interrupted during {current_stage.value}", stop_reason="signal")
            except Exception as e:
                # Treat as interruption when EITHER the in-process signal
                # handler has run (sets _shutdown_requested) OR the agent
                # subprocess died with a negative returncode (signal kill
                # whose handler hasn't yet been delivered to Python).
                if _shutdown_requested or _is_signal_kill_exception(e):
                    stage_completed = datetime.now(timezone.utc).isoformat()
                    complete_iteration(status, current_stage.value, status="interrupted", completed_at=stage_completed)
                    update_stage(status, current_stage.value, status="interrupted", completed_at=stage_completed)
                    save_status(status, actual_status_path)
                    if ctx:
                        emit_event(ctx, STAGE_INTERRUPTED, stage_interrupted_payload(
                            stage=current_stage.value, iteration=iter_num,
                            elapsed_ms=int((time.time() - t0) * 1000),
                        ))
                    raise PipelineInterrupted(f"Pipeline interrupted during {current_stage.value}", stop_reason="signal")
                # Telemetry: when the failure carries a subprocess
                # returncode, surface it so future flakes give us data
                # instead of speculation.
                _rc = getattr(e, "returncode", None)
                _rc_suffix = f" (returncode={_rc})" if _rc is not None else ""
                _log(f"Stage {current_stage.value} failed: {e}{_rc_suffix}", "warn")
                stage_completed = datetime.now(timezone.utc).isoformat()
                complete_iteration(
                    status, current_stage.value,
                    status="error",
                    completed_at=stage_completed,
                    error=str(e),
                )
                update_stage(
                    status, current_stage.value,
                    status="error",
                    completed_at=stage_completed,
                    error=str(e),
                )
                save_status(status, actual_status_path)
                if ctx:
                    emit_event(ctx, STAGE_FAILED, stage_failed_payload(
                        stage=current_stage.value,
                        iteration=iter_num,
                        error=str(e),
                        error_type=type(e).__name__,
                        elapsed_ms=int((time.time() - t0) * 1000),
                    ))

                # Circuit breaker integration
                try:
                    _cb_config = load_settings(settings_path).get("worca", {}).get("circuit_breaker", {})
                except Exception:
                    _cb_config = {}

                if _cb_config.get("enabled", False) and current_stage != Stage.PREFLIGHT:
                    _failure_history = get_circuit_breaker_state(status).get("failure_history", [])
                    classification = classify_error(
                        str(e), current_stage.value, _failure_history, settings_path
                    )
                    record_failure(status, current_stage.value, str(e), classification)
                    if ctx:
                        emit_event(ctx, CB_FAILURE_RECORDED, cb_failure_recorded_payload(
                            stage=current_stage.value,
                            error=str(e),
                            category=classification.get("category", "unknown"),
                            retriable=classification.get("retriable", False),
                            consecutive_failures=get_circuit_breaker_state(status)["consecutive_failures"],
                        ))
                    iter_record["classification"] = classification
                    save_status(status, actual_status_path)

                    _cat = classification.get("category", "unknown")
                    _retriable = classification.get("retriable", False)
                    _log(f"Error classified: {_cat} (retriable={_retriable})")

                    halt, reason = should_halt(status, classification, settings_path)
                    if halt:
                        status["circuit_breaker"]["tripped"] = True
                        status["circuit_breaker"]["tripped_reason"] = reason
                        save_status(status, actual_status_path)
                        if ctx:
                            emit_event(ctx, CB_TRIPPED, cb_tripped_payload(
                                reason=reason,
                                consecutive_failures=get_circuit_breaker_state(status)["consecutive_failures"],
                                category=_cat,
                            ))
                        raise CircuitBreakerTripped(reason)

                    if _retriable and _cat == CATEGORY_TRANSIENT:
                        # NOTE: consecutive_failures is pipeline-global, not per-stage.
                        # It resets on any stage success (record_success), so backoff
                        # escalates across consecutive failures regardless of which stage
                        # failed. This is intentional — repeated failures anywhere in the
                        # pipeline should escalate severity, not reset per stage.
                        _retry_attempt = get_circuit_breaker_state(status)["consecutive_failures"] - 1
                        _delay = get_retry_delay(_retry_attempt, settings_path)
                        if _delay is not None:
                            _log(f"Transient error — retrying in {_delay}s", "warn")
                            if ctx:
                                emit_event(ctx, CB_RETRY, cb_retry_payload(
                                    stage=current_stage.value,
                                    attempt=_retry_attempt + 1,
                                    delay_seconds=_delay,
                                    consecutive_failures=get_circuit_breaker_state(status)["consecutive_failures"],
                                ))
                            time.sleep(_delay)
                            if run_dir:
                                _orphans = kill_all_tracked(os.path.join(run_dir, "procs"))
                                if _orphans:
                                    _log(f"Killed {_orphans} tracked process group(s) before retry", "warn")
                            continue

                raise
            else:
                _prev_consecutive = get_circuit_breaker_state(status)["consecutive_failures"]
                record_success(status)
                if ctx and _prev_consecutive > 0:
                    emit_event(ctx, CB_RESET, cb_reset_payload(
                        stage=current_stage.value,
                        previous_consecutive_failures=_prev_consecutive,
                    ))

            elapsed = time.time() - t0
            _log(f"{stage_label}{iter_label} completed ({_format_duration(elapsed)})", "ok")

            # Extract token usage from the raw envelope first so the metrics
            # log line below uses the same override-aware cost as the values
            # persisted into status.json (otherwise an alt-endpoint alias
            # silently shows Claude CLI's raw Anthropic-priced number in the
            # spawn log while the run record carries the overridden $0/local).
            usage = extract_token_usage(raw_envelope, settings_path=settings_path) if isinstance(raw_envelope, dict) else {}

            # Log detailed metrics
            if isinstance(raw_envelope, dict):
                _log_stage_metrics(
                    stage_label,
                    result,
                    raw_envelope,
                    cost_override=usage.get("total_cost_usd"),
                )

            # Save full envelope for resume/debugging (per-iteration)
            _save_stage_output(current_stage, raw_envelope, logs_dir, iteration=iter_num)

            # Emit cost events after token extraction
            if ctx and isinstance(raw_envelope, dict):
                _stage_cost = usage.get("total_cost_usd", raw_envelope.get("total_cost_usd") or 0.0)
                _stage_input = usage.get("input_tokens", 0)
                _stage_output = usage.get("output_tokens", 0)
                if _stage_cost or _stage_input or _stage_output:
                    emit_event(ctx, COST_STAGE_TOTAL, cost_stage_total_payload(
                        stage=current_stage.value,
                        iteration=iter_num,
                        cost_usd=_stage_cost,
                        input_tokens=_stage_input,
                        output_tokens=_stage_output,
                        model=stage_config.get("model", ""),
                        cache_creation_input_tokens=usage.get("cache_creation_input_tokens", 0),
                        cache_read_input_tokens=usage.get("cache_read_input_tokens", 0),
                        web_search_requests=usage.get("web_search_requests", 0),
                        web_fetch_requests=usage.get("web_fetch_requests", 0),
                    ))
                # Running total: sum of all previously-completed stages + current
                _prev_costs = sum(
                    (v.get("cost_usd") or 0)
                    for k, v in status.get("stages", {}).items()
                    if k != current_stage.value
                )
                _running_cost = _prev_costs + _stage_cost
                _prev_input = sum(
                    (v.get("token_usage", {}).get("input_tokens") or 0)
                    for v in status.get("stages", {}).values()
                )
                _prev_output = sum(
                    (v.get("token_usage", {}).get("output_tokens") or 0)
                    for v in status.get("stages", {}).values()
                )
                emit_event(ctx, COST_RUNNING_TOTAL, cost_running_total_payload(
                    total_cost_usd=_running_cost,
                    total_input_tokens=_prev_input + _stage_input,
                    total_output_tokens=_prev_output + _stage_output,
                ))
                # Budget warning check
                try:
                    _budget_settings = load_settings(settings_path).get("worca", {}).get("budget", {})
                except Exception:
                    _budget_settings = {}
                _max_cost = _budget_settings.get("max_cost_usd")
                if _max_cost and _max_cost > 0 and _running_cost > 0:
                    _warning_pct = _budget_settings.get("warning_pct", 80.0)
                    _pct_used = (_running_cost / _max_cost) * 100.0
                    if _pct_used >= _warning_pct:
                        emit_event(ctx, COST_BUDGET_WARNING, cost_budget_warning_payload(
                            total_cost_usd=_running_cost,
                            budget_usd=_max_cost,
                            pct_used=_pct_used,
                        ))

            # Build iteration completion kwargs
            stage_completed = datetime.now(timezone.utc).isoformat()
            iter_extras = {
                "status": "completed",
                "completed_at": stage_completed,
                "duration_ms": int(elapsed * 1000),
            }
            if isinstance(raw_envelope, dict):
                if raw_envelope.get("duration_api_ms"):
                    iter_extras["duration_api_ms"] = raw_envelope["duration_api_ms"]
                if raw_envelope.get("duration_ms"):
                    iter_extras["duration_session_ms"] = raw_envelope["duration_ms"]
                if raw_envelope.get("num_turns"):
                    iter_extras["turns"] = raw_envelope["num_turns"]
                _iter_cost = usage.get("total_cost_usd", raw_envelope.get("total_cost_usd"))
                if _iter_cost:
                    iter_extras["cost_usd"] = _iter_cost
                if current_stage != Stage.PREFLIGHT:
                    iter_extras["graphify_invocations"] = raw_envelope.get(
                        "graphify_invocations", 0
                    )
                    iter_extras["crg_invocations"] = raw_envelope.get(
                        "crg_invocations", 0
                    )
                    _crg_tc = raw_envelope.get("crg_tool_counts") or {}
                    if _crg_tc:
                        iter_extras["crg_tool_counts"] = _crg_tc
            if usage:
                iter_extras["token_usage"] = usage
            iter_extras["prompt"] = rendered_prompt
            if isinstance(result, dict):
                iter_extras["output"] = result

            # Mark stage and iteration completed
            stage_extras = {"status": "completed", "completed_at": stage_completed}
            if isinstance(raw_envelope, dict):
                if raw_envelope.get("num_turns"):
                    stage_extras["turns"] = raw_envelope["num_turns"]
                _stg_cost = usage.get("total_cost_usd", raw_envelope.get("total_cost_usd"))
                if _stg_cost:
                    stage_extras["cost_usd"] = _stg_cost

            # Compute stage-level token aggregate across all iterations
            all_iter_usages = []
            for it in status.get("stages", {}).get(current_stage.value, {}).get("iterations", []):
                it_usage = it.get("token_usage")
                if it_usage:
                    all_iter_usages.append(it_usage)
            if usage:
                all_iter_usages.append(usage)
            if all_iter_usages:
                stage_extras["token_usage"] = aggregate_token_usage(all_iter_usages)

            # Handle PREFLIGHT completion
            if current_stage == Stage.PREFLIGHT:
                preflight_skipped = result.get("status") == "skipped"
                iter_extras["outcome"] = "skipped" if preflight_skipped else "success"
                # No AI call — zero out session/api so timing bar shows this as pipeline overhead
                iter_extras.setdefault("duration_session_ms", 0)
                iter_extras.setdefault("duration_api_ms", 0)
                complete_iteration(status, current_stage.value, **iter_extras)
                _pf_stage_extras = {**stage_extras, "skipped": preflight_skipped}
                # Run-level graphify enablement (single source of truth for the
                # UI: drives "(disabled)" vs an integer invocation count).
                try:
                    _gfx_cfg = effective_graphify_config(
                        load_global_settings(), load_settings(settings_path)
                    )
                    status["graphify_enabled"] = bool(_gfx_cfg.enabled)
                except Exception:
                    status["graphify_enabled"] = False
                if result.get("graphify_status"):
                    status["graphify_status"] = result["graphify_status"]
                    _pf_stage_extras["graphify_status"] = result["graphify_status"]
                for _gfx_key in ("graphify_outcome", "graphify_mode", "graphify_reason"):
                    if result.get(_gfx_key):
                        status[_gfx_key] = result[_gfx_key]
                        _pf_stage_extras[_gfx_key] = result[_gfx_key]
                if result.get("graphify_report_path"):
                    status["graphify_report_path"] = result["graphify_report_path"]
                    _pf_stage_extras["graphify_report_path"] = result["graphify_report_path"]
                    _rp = result["graphify_report_path"]
                    if os.path.isfile(_rp):
                        # Agents query the graph on demand via GRAPHIFY_OUT; the
                        # prompt only carries a per-run availability note.
                        _graphify_out = os.path.dirname(_rp)
                        prompt_builder.set_graphify_available(True)
                        _log(
                            "Graphify: ready — agents query the cached graph via "
                            f"GRAPHIFY_OUT={_graphify_out}"
                        )
                if result.get("crg_status"):
                    status["crg_status"] = result["crg_status"]
                    _pf_stage_extras["crg_status"] = result["crg_status"]
                if result.get("crg_outcome"):
                    status["crg_outcome"] = result["crg_outcome"]
                    _pf_stage_extras["crg_outcome"] = result["crg_outcome"]
                if result.get("crg_reason"):
                    status["crg_reason"] = result["crg_reason"]
                    _pf_stage_extras["crg_reason"] = result["crg_reason"]
                if result.get("crg_data_dir"):
                    _crg_dd = result["crg_data_dir"]
                    if os.path.isdir(_crg_dd):
                        _crg_data_dir = _crg_dd
                        status["crg_data_dir"] = _crg_dd
                        _pf_stage_extras["crg_data_dir"] = _crg_dd
                        prompt_builder.set_crg_available(True)
                        _log(f"CRG: ready — agents get MCP tools via crg_data_dir={_crg_data_dir}")
                try:
                    _crg_cfg = effective_crg_config(
                        load_global_settings(), load_settings(settings_path)
                    )
                    status["crg_enabled"] = bool(_crg_cfg.enabled)
                except Exception:
                    status["crg_enabled"] = False
                update_stage(status, current_stage.value, **_pf_stage_extras)
                save_status(status, actual_status_path)
                if ctx:
                    if preflight_skipped:
                        emit_event(ctx, PREFLIGHT_SKIPPED, preflight_skipped_payload(
                            reason=result.get("summary", "preflight skipped"),
                        ))
                    else:
                        _pf_checks = result.get("checks", [])
                        _pf_all_passed = all(
                            c.get("status") in ("pass", "warn") for c in _pf_checks
                        ) if _pf_checks else True
                        emit_event(ctx, PREFLIGHT_COMPLETED, preflight_completed_payload(
                            checks=_pf_checks,
                            all_passed=_pf_all_passed,
                        ))
                    _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                        stage=current_stage.value, iteration=iter_num,
                        duration_ms=iter_extras.get("duration_ms", 0),
                        cost_usd=iter_extras.get("cost_usd", 0.0),
                        turns=iter_extras.get("turns", 0),
                        outcome=iter_extras["outcome"],
                        token_usage=iter_extras.get("token_usage"),
                    ))
                    if _sc_event:
                        _action = _check_control_response(ctx, _sc_event)
                        if _action == "pause":
                            _handle_pause(ctx, f"{current_stage.value} stage.completed")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")

            # Milestone gate after PLAN
            elif current_stage == Stage.PLAN:
                # Plan approval is a webhook-controlled gate, not a planner
                # self-assessment. Default to approved; the webhook (when
                # plan_approval is enabled and a subscriber is connected) can
                # override below via "reject".
                approved = True
                iter_extras["outcome"] = "success" if approved else "rejected"
                complete_iteration(status, current_stage.value, **iter_extras)
                update_stage(status, current_stage.value, **stage_extras)
                set_milestone(status, "plan_approved", approved)
                if ctx:
                    _ms_event = emit_event(ctx, MILESTONE_SET, milestone_set_payload(
                        milestone="plan_approved", value=approved, stage=Stage.PLAN.value,
                    ))
                    if _ms_event:
                        _action = _check_control_response(ctx, _ms_event)
                        if _action == "approve":
                            approved = True
                            set_milestone(status, "plan_approved", True)
                            iter_extras["outcome"] = "success"
                        elif _action == "reject":
                            approved = False
                            set_milestone(status, "plan_approved", False)
                            iter_extras["outcome"] = "rejected"
                        elif _action == "pause":
                            _handle_pause(ctx, "plan_approved milestone")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                save_status(status, actual_status_path)
                if ctx:
                    _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                        stage=current_stage.value, iteration=iter_num,
                        duration_ms=iter_extras.get("duration_ms", 0),
                        cost_usd=iter_extras.get("cost_usd", 0.0),
                        turns=iter_extras.get("turns", 0),
                        outcome=iter_extras["outcome"],
                        token_usage=iter_extras.get("token_usage"),
                    ))
                    if _sc_event:
                        _action = _check_control_response(ctx, _sc_event)
                        if _action == "pause":
                            _handle_pause(ctx, f"{current_stage.value} stage.completed")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                if not approved:
                    _log("PLAN not approved — stopping", "err")
                    raise PipelineError("Plan not approved")
                _log("PLAN approved", "ok")
                _emit_guide_conflicts(ctx, "plan", result)
                # Thread plan outputs into PromptBuilder for downstream stages
                prompt_builder.update_context("plan_approach", result.get("approach", ""))
                prompt_builder.update_context("plan_tasks_outline", result.get("tasks_outline", []))
                # Read plan file content now so plan_review has it immediately
                # (avoids race where plan_review starts before the file is flushed)
                _plan_path = status.get("plan_file")
                if _plan_path and os.path.exists(_plan_path):
                    with open(_plan_path, encoding="utf-8") as _pf:
                        _plan_text = _pf.read().strip()
                    if _plan_text:
                        prompt_builder.update_context("plan_file_content", _plan_text)

            # Handle plan review results
            elif current_stage == Stage.PLAN_REVIEW:
                outcome = result.get("outcome", "revise")  # fail-closed default
                issues = result.get("issues", [])
                critical_issues = [i for i in issues if i.get("severity") in ("critical", "major")]

                # Audit-trail integrity: normalize the agent's self-reported
                # outcome and per-issue resolution to match what was physically
                # possible, BEFORE recording the iteration / emitting events.
                #
                # - Edit mode (`review_and_edit`): the editor was given a fresh
                #   plan-(N+1).md copy and may write to it. We determine the
                #   honest outcome from the actual file content (W-061
                #   reconciliation), not the editor's verdict — the model has
                #   been observed to return "revise" without editing or to
                #   claim resolution=edited without writing. When unchanged,
                #   downgrade outcome → approve and resolution=edited →
                #   deferred, and collapse the speculative copy so the
                #   numbered sequence stays meaningful in the W-061 viewer.
                # - Review mode (or any non-edit mode): plan_reviewer is in
                #   read_only_agents and the guard blocks Write/Edit, so the
                #   reviewer can NEVER edit the plan. Any "approve_with_edits"
                #   or per-issue resolution value is a contract violation by
                #   the agent. Strip them so the audit trail is honest.
                _plan_actually_edited = False
                if _pr_mode == "review_and_edit":
                    _pre = status.get("plan_pre_edit_file")
                    _post = status.get("plan_file")
                    if _pre and _post and os.path.isfile(_pre) and os.path.isfile(_post):
                        try:
                            with open(_pre, "rb") as _a, open(_post, "rb") as _b:
                                _plan_actually_edited = _a.read() != _b.read()
                        except OSError:
                            _plan_actually_edited = False
                    if _plan_actually_edited:
                        outcome = "approve_with_edits"
                    else:
                        outcome = "approve"
                        if isinstance(result, dict):
                            for _iss in result.get("issues") or []:
                                if isinstance(_iss, dict) and _iss.get("resolution") == "edited":
                                    _iss["resolution"] = "deferred"
                        if (run_dir and _pre and _post and _post != _pre
                                and os.path.isfile(_post)):
                            try:
                                os.remove(_post)
                            except OSError:
                                pass
                            status["plan_file"] = _pre
                            os.environ["WORCA_PLAN_FILE"] = _pre
                            prompt_builder.update_context("plan_file", _pre)
                else:
                    # Review mode: read-only reviewer cannot edit, so any
                    # "approve_with_edits" or per-issue resolution claim is
                    # categorically impossible. Downgrade outcome and strip
                    # the resolution field — the schema permits these values
                    # because it is shared with edit mode, but in review mode
                    # they are fabrications. "revise" / "approve" outcomes
                    # flow through unchanged.
                    if outcome == "approve_with_edits":
                        outcome = "approve"
                    if isinstance(result, dict):
                        for _iss in result.get("issues") or []:
                            if isinstance(_iss, dict):
                                _iss.pop("resolution", None)

                iter_extras["outcome"] = outcome
                complete_iteration(status, current_stage.value, **iter_extras)
                update_stage(status, current_stage.value, **stage_extras)
                save_status(status, actual_status_path)
                if ctx:
                    _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                        stage=current_stage.value, iteration=iter_num,
                        duration_ms=iter_extras.get("duration_ms", 0),
                        cost_usd=iter_extras.get("cost_usd", 0.0),
                        turns=iter_extras.get("turns", 0),
                        outcome=iter_extras["outcome"],
                        token_usage=iter_extras.get("token_usage"),
                    ))
                    if _sc_event:
                        _action = _check_control_response(ctx, _sc_event)
                        if _action == "pause":
                            _handle_pause(ctx, f"{current_stage.value} stage.completed")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")

                # Revise gate: outcome == "revise" AND (critical issues present OR issues list empty)
                # Minor/suggestion-only issues are treated as approve.
                # Empty issues list with revise outcome is fail-closed — still revise.
                should_revise = (outcome == "revise") and bool(critical_issues or not issues)

                if _pr_mode == "review_and_edit":
                    # Edit mode: the plan editor rewrote the next numbered
                    # revision (plan-(N+1).md) in place — or produced a clean
                    # approve with no edits (the speculative copy was collapsed
                    # above). Either way, no loopback is needed.
                    set_milestone(status, "plan_approved", True)
                    # The pre-edit plan-N.md is the retained original (W-061).
                    _orig_path = status.get("plan_pre_edit_file") or None
                    # Clear edit markers so a later restart_planning re-entry
                    # mints a fresh revision instead of reusing this one.
                    status.pop("plan_edit_target", None)
                    status.pop("plan_pre_edit_file", None)
                    prompt_builder.pop_context("plan_review_issues")
                    prompt_builder.pop_context("plan_revision_mode")
                    prompt_builder.pop_context("plan_review_history")
                    if prompt_context_path:
                        prompt_builder.save_context(prompt_context_path)
                    save_status(status, actual_status_path)
                    _log("Plan approved by editor (no edits needed)"
                         if outcome == "approve"
                         else "Plan approved with edits", "ok")
                    # PLAN_EDITED only fires when the plan was actually rewritten —
                    # claiming edits we didn't make would inflate the audit trail.
                    if ctx and _plan_actually_edited:
                        _severity_counts = {"critical": 0, "major": 0, "minor": 0, "suggestion": 0}
                        for _iss in issues:
                            _sev = _iss.get("severity", "")
                            if _sev in _severity_counts:
                                _severity_counts[_sev] += 1
                        emit_event(ctx, PLAN_EDITED, plan_edited_payload(
                            stage=current_stage.value,
                            mode=_pr_mode,
                            mode_reason=_pr_mode_reason,
                            issue_counts=_severity_counts,
                            original_plan_path=_orig_path,
                        ))

                elif should_revise:
                    # Thread review feedback — only critical/major issues to limit context growth
                    prev_history = list(prompt_builder.get_context("plan_review_history") or [])
                    prev_history.append({"attempt": len(prev_history) + 1, "issues": list(critical_issues)})
                    # Cap history to most recent 50 entries to bound context growth
                    if len(prev_history) > 50:
                        prev_history = prev_history[-50:]
                    prompt_builder.update_context("plan_review_history", prev_history)
                    prompt_builder.update_context("plan_review_issues", list(critical_issues))
                    prompt_builder.update_context("plan_revision_mode", True)

                    # Update ALL counters before saving — single save to avoid inconsistent state
                    loop_counters["plan_review"] = loop_counters.get("plan_review", 0) + 1
                    loop_counters[f"{Stage.PLAN_REVIEW.value}_iteration"] = (
                        loop_counters.get(f"{Stage.PLAN_REVIEW.value}_iteration", 0) + 1
                    )
                    status["loop_counters"] = dict(loop_counters)

                    if check_loop_limit("plan_review", loop_counters["plan_review"],
                                        settings_path, mloops=mloops):
                        if ctx:
                            _lt_event = emit_event(ctx, LOOP_TRIGGERED, loop_triggered_payload(
                                loop_key="plan_review",
                                iteration=loop_counters["plan_review"],
                                from_stage=Stage.PLAN_REVIEW.value,
                                to_stage=Stage.PLAN.value,
                                trigger="plan_review_revise",
                            ))
                            if _lt_event:
                                _action = _check_control_response(ctx, _lt_event)
                                if _action == "pause":
                                    _handle_pause(ctx, "plan_review loop.triggered")
                                elif _action == "abort":
                                    raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")

                        # --- Atomic loop-back sequence ---
                        # 1. Reset PLAN stage status and clear plan_approved milestone
                        update_stage(status, Stage.PLAN.value, status="pending", skipped=False)
                        status.get("milestones", {}).pop("plan_approved", None)
                        # 1a. Append-only plan revision (W-061): preserve the current
                        # plan as the revision *source* (threaded into plan_file_content
                        # so the revision Planner reads it regardless of the re-pointed
                        # path), then mint the next numbered plan file as the *target*
                        # and re-point every consumer. The prior plan-00N.md is left
                        # intact as audit history; the Planner is restricted to
                        # WORCA_PLAN_FILE, so older revisions are immutable.
                        if run_dir:
                            _cur_plan_path = status.get("plan_file")
                            _cur_plan_text = ""
                            if _cur_plan_path and os.path.exists(_cur_plan_path):
                                with open(_cur_plan_path, encoding="utf-8") as _cpf:
                                    _cur_plan_text = _cpf.read().strip()
                            if _cur_plan_text:
                                prompt_builder.update_context("plan_file_content", _cur_plan_text)
                            _rev_plan_path = _next_plan_path(run_dir)
                            status["plan_file"] = _rev_plan_path
                            os.environ["WORCA_PLAN_FILE"] = _rev_plan_path
                            prompt_builder.update_context("plan_file", _rev_plan_path)
                            _log(f"Plan revision -> {_rev_plan_path} (revising {_cur_plan_path})", "ok")
                        # 2. Persist context + status before any in-memory transitions
                        if prompt_context_path:
                            prompt_builder.save_context(prompt_context_path)
                        save_status(status, actual_status_path)
                        # 2a. Re-render agent templates so planner.md stays consistent
                        # with the current plan_file path (defensive: prevents stale
                        # template instructions if plan_file ever changes mid-revision).
                        if run_dir:
                            _lb_settings = load_settings(settings_path)
                            _lb_worca = _lb_settings.get("worca", {})
                            _lb_overrides_dir = _lb_worca.get(
                                "agent_overrides_dir", ".claude/agents"
                            )
                            _lb_template_agents_dir = _lb_worca.get("_template_agents_dir")
                            _render_agent_templates(run_dir, {
                                "plan_file": status["plan_file"],
                                "run_id": status.get("run_id", ""),
                                "branch": branch_name,
                                "title": work_request.title,
                            }, overrides_dir=_lb_overrides_dir,
                               template_agents_dir=_lb_template_agents_dir)
                        # 3. In-memory transitions (context keys drive behavior on crash/resume)
                        _next_trigger[Stage.PLAN.value] = "plan_review_revise"
                        stage_idx = stage_order.index(Stage.PLAN)
                        continue  # Loop back to PLAN
                    else:
                        if critical_issues:
                            prompt_builder.update_context("unresolved_plan_issues", list(critical_issues))
                        prompt_builder.pop_context("plan_review_issues")
                        prompt_builder.pop_context("plan_revision_mode")
                        prompt_builder.pop_context("plan_review_history")
                        if prompt_context_path:
                            prompt_builder.save_context(prompt_context_path)
                        save_status(status, actual_status_path)
                        if ctx:
                            emit_event(ctx, LOOP_EXHAUSTED, loop_exhausted_payload(
                                loop_key="plan_review",
                                iteration=loop_counters["plan_review"],
                                limit=_get_loop_limit("plan_review", settings_path, mloops),
                            ))
                        n_carried = len(critical_issues) if critical_issues else 0
                        _log(f"Plan review loop exhausted — {n_carried} unresolved issues carried to COORDINATE", "warn")
                else:
                    # Approve path — pop cross-context keys to prevent leaking
                    prompt_builder.pop_context("plan_review_issues")
                    prompt_builder.pop_context("plan_revision_mode")
                    prompt_builder.pop_context("plan_review_history")
                    if prompt_context_path:
                        prompt_builder.save_context(prompt_context_path)

                    if outcome == "revise" and not critical_issues and issues:
                        _log(f"Plan approved with {len(issues)} minor issues (logged)", "ok")
                    elif issues:
                        _log(f"Plan approved with {len(issues)} minor issues (logged)", "ok")
                    else:
                        _log("Plan approved by reviewer", "ok")

            # Handle coordinate results
            elif current_stage == Stage.COORDINATE:
                iter_extras["outcome"] = "success"
                complete_iteration(status, current_stage.value, **iter_extras)
                update_stage(status, current_stage.value, **stage_extras)
                save_status(status, actual_status_path)
                if ctx:
                    _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                        stage=current_stage.value, iteration=iter_num,
                        duration_ms=iter_extras.get("duration_ms", 0),
                        cost_usd=iter_extras.get("cost_usd", 0.0),
                        turns=iter_extras.get("turns", 0),
                        outcome=iter_extras["outcome"],
                        token_usage=iter_extras.get("token_usage"),
                    ))
                    if _sc_event:
                        _action = _check_control_response(ctx, _sc_event)
                        if _action == "pause":
                            _handle_pause(ctx, f"{current_stage.value} stage.completed")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                # Thread coordinate outputs into PromptBuilder
                beads_ids = result.get("beads_ids", [])
                max_beads = len(beads_ids)
                prompt_builder.update_context("beads_ids", beads_ids)
                prompt_builder.update_context("dependency_graph", result.get("dependency_graph", {}))
                prompt_builder.pop_context("unresolved_plan_issues")
                # Link beads to this run via label
                if beads_ids:
                    run_label = f"run:{status['run_id']}"
                    if bd_label_add(beads_ids, run_label):
                        _log(f"Labeled {len(beads_ids)} beads with {run_label}", "ok")
                        if ctx:
                            emit_event(ctx, BEAD_LABELED, bead_labeled_payload(
                                bead_ids=beads_ids,
                                label=run_label,
                            ))
                    else:
                        _log(f"Failed to label beads with {run_label}", "warn")
                # Effort label backfill from structured output
                _effort_backfilled = set()
                effort_map = result.get("effort", {})
                if beads_ids and effort_map:
                    beads_set = set(beads_ids)
                    for bid, level in effort_map.items():
                        if bid not in beads_set:
                            _log(f"Effort backfill: skip unknown bead {bid}", "warn")
                            continue
                        if level not in EFFORT_LEVELS:
                            _log(f"Effort backfill: skip invalid level '{level}' for {bid}", "warn")
                            continue
                        if bd_get_effort_label(bid):
                            continue
                        if bd_label_add([bid], f"worca-effort:{level}"):
                            _effort_backfilled.add(bid)
                    if _effort_backfilled:
                        _log(f"Effort backfill: labeled {len(_effort_backfilled)} bead(s) from structured output", "ok")
                # Best-effort check: warn about beads missing worca-effort:* labels
                if beads_ids:
                    _unlabeled = [
                        bid for bid in beads_ids
                        if bid not in _effort_backfilled and not bd_get_effort_label(bid)
                    ]
                    if _unlabeled:
                        _log(f"{len(_unlabeled)} bead(s) missing worca-effort label: {', '.join(_unlabeled)}", "warn")

            # Handle implement results — batch-then-test flow
            elif current_stage == Stage.IMPLEMENT:
                iter_extras["outcome"] = "success"
                complete_iteration(status, current_stage.value, **iter_extras)

                # Thread implement outputs into PromptBuilder
                new_files = result.get("files_changed", [])
                new_tests = result.get("tests_added", [])
                prompt_builder.update_context("files_changed", new_files)
                prompt_builder.update_context("tests_added", new_tests)

                impl_trigger = trigger  # trigger was popped earlier in the loop
                _accumulate_design_note(prompt_builder, result, impl_trigger)
                if impl_trigger in ("initial", "next_bead"):
                    # Phase 1: close the bead we just implemented
                    claimed_bead = prompt_builder.get_context("assigned_bead_id")
                    if claimed_bead:
                        if bd_close(claimed_bead, reason="implemented"):
                            _log(f"Closed bead {claimed_bead}", "ok")
                            if ctx:
                                emit_event(ctx, BEAD_COMPLETED, bead_completed_payload(
                                    bead_id=claimed_bead,
                                    reason="implemented",
                                ))
                        else:
                            _log(f"Failed to close bead {claimed_bead}", "warn")
                            if ctx:
                                emit_event(ctx, BEAD_FAILED, bead_failed_payload(
                                    bead_id=claimed_bead,
                                    error="bd_close failed",
                                ))
                        # Record the bead as processed regardless of bd_close
                        # outcome — implementation is the expensive step and
                        # must not be retried on the same bead. Persisting here
                        # (via save_context below) lets resume skip it too.
                        _implemented = prompt_builder.get_context("implemented_bead_ids") or []
                        if claimed_bead not in _implemented:
                            _implemented.append(claimed_bead)
                            prompt_builder.update_context("implemented_bead_ids", _implemented)

                    # Accumulate files across all beads
                    all_files = prompt_builder.get_context("all_files_changed") or []
                    all_files.extend(new_files)
                    prompt_builder.update_context("all_files_changed", all_files)
                    all_tests = prompt_builder.get_context("all_tests_added") or []
                    all_tests.extend(new_tests)
                    prompt_builder.update_context("all_tests_added", all_tests)

                    loop_counters["bead_iteration"] = loop_counters.get("bead_iteration", 0) + 1
                    status["loop_counters"] = dict(loop_counters)

                    # Check for more beads (scoped to this run)
                    # NOTE: Do NOT mark IMPLEMENT "completed" yet — if the pipeline
                    # is stopped between bead iterations, resume must re-enter
                    # IMPLEMENT to process remaining beads.
                    next_bead = _query_ready_bead(allowed_ids=run_bead_ids, run_id=status.get("run_id"))
                    # Drain when bd_ready re-surfaces an already-implemented
                    # bead. Happens when the bead store doesn't reflect our
                    # closure yet (slow daemon, stateless test stub, or a
                    # bd_close failure). Re-implementing is never the right
                    # answer — advance instead.
                    if next_bead:
                        _impl_set = set(prompt_builder.get_context("implemented_bead_ids") or [])
                        if next_bead["id"] in _impl_set:
                            _log(
                                f"bd ready returned already-implemented bead {next_bead['id']} "
                                f"— treating bead queue as drained",
                                "warn",
                            )
                            next_bead = None
                    if next_bead and Stage.IMPLEMENT in stage_order:
                        safety_cap = max(max_beads, len(run_bead_ids or [])) + 3
                        if loop_counters["bead_iteration"] < safety_cap:
                            # Keep stage in_progress between beads so resume works
                            if prompt_context_path:
                                prompt_builder.save_context(prompt_context_path)
                            save_status(status, actual_status_path)
                            _log(f"Next bead available — looping back to IMPLEMENT (bead {loop_counters['bead_iteration']})", "ok")
                            _next_trigger[Stage.IMPLEMENT.value] = "next_bead"
                            stage_idx = stage_order.index(Stage.IMPLEMENT)
                            if ctx:
                                emit_event(ctx, BEAD_NEXT, bead_next_payload(
                                    next_bead_id=next_bead["id"],
                                    bead_iteration=loop_counters["bead_iteration"],
                                    max_beads=max_beads,
                                ))
                            continue
                        else:
                            _log(f"Safety cap reached ({safety_cap}) but bd ready still has "
                                 f"run-scoped beads — halting to prevent partial implementation", "err")
                            raise PipelineInterrupted(
                                f"implement_incomplete: bead {next_bead['id']} and possibly more still unstarted",
                                stop_reason="implement_incomplete",
                            )

                    # All beads done — NOW mark IMPLEMENT completed
                    prompt_builder.update_context("files_changed", list(set(all_files)))
                    prompt_builder.update_context("tests_added", list(set(all_tests)))
                    _log("All beads implemented — advancing to TEST", "ok")
                # Phase 3 (fix mode): just fall through to TEST with current files

                # Mark IMPLEMENT completed only when all beads are done (or fix mode)
                update_stage(status, current_stage.value, **stage_extras)

                if _crg_data_dir and _crg_cfg and _crg_cfg.update_on_post_implement:
                    _crg_ok = _crg_post_implement_refresh(_crg_data_dir, project_root, timeout=30)
                    if not _crg_ok:
                        iter_extras["crg_refresh_failed"] = True
                        _log("CRG post-implement refresh failed or timed out — tester proceeds with stale graph", "warn")

                save_status(status, actual_status_path)
                if ctx:
                    _bead_kwargs = {}
                    if max_beads:
                        _bead_kwargs["beads_done"] = loop_counters.get("bead_iteration", 0)
                        _bead_kwargs["beads_total"] = max_beads
                    _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                        stage=current_stage.value, iteration=iter_num,
                        duration_ms=iter_extras.get("duration_ms", 0),
                        cost_usd=iter_extras.get("cost_usd", 0.0),
                        turns=iter_extras.get("turns", 0),
                        outcome=iter_extras["outcome"],
                        token_usage=iter_extras.get("token_usage"),
                        **_bead_kwargs,
                    ))
                    if _sc_event:
                        _action = _check_control_response(ctx, _sc_event)
                        if _action == "pause":
                            _handle_pause(ctx, f"{current_stage.value} stage.completed")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")

            # Handle test results — simplified (flat counter, no per-bead logic)
            elif current_stage == Stage.TEST:
                passed = result.get("passed", False)
                _emit_guide_conflicts(ctx, "test", result)
                # Thread test outputs into PromptBuilder
                prompt_builder.update_context("test_passed", passed)
                prompt_builder.update_context("test_coverage", result.get("coverage_pct"))
                prompt_builder.update_context("proof_artifacts", result.get("proof_artifacts", []))
                if not passed:
                    new_failures = result.get("failures", [])
                    # Accumulate test failure history
                    prev_history = prompt_builder.get_context("test_failure_history") or []
                    prev_history.append({"attempt": len(prev_history) + 1, "failures": new_failures})
                    prompt_builder.update_context("test_failure_history", prev_history)
                    prompt_builder.update_context("test_failures", new_failures)
                    prompt_builder.update_context("review_issues", None)
                    prompt_builder.update_context("review_history", None)
                    iter_extras["outcome"] = "test_failure"
                    complete_iteration(status, current_stage.value, **iter_extras)
                    update_stage(status, current_stage.value, **stage_extras)
                    save_status(status, actual_status_path)
                    if ctx:
                        emit_event(ctx, TEST_SUITE_FAILED, test_suite_failed_payload(
                            iteration=iter_num,
                            failure_count=len(new_failures),
                            failures=new_failures,
                        ))
                        _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                            stage=current_stage.value, iteration=iter_num,
                            duration_ms=iter_extras.get("duration_ms", 0),
                            cost_usd=iter_extras.get("cost_usd", 0.0),
                            turns=iter_extras.get("turns", 0),
                            outcome=iter_extras["outcome"],
                            token_usage=iter_extras.get("token_usage"),
                        ))
                        if _sc_event:
                            _action = _check_control_response(ctx, _sc_event)
                            if _action == "pause":
                                _handle_pause(ctx, f"{current_stage.value} stage.completed")
                            elif _action == "abort":
                                raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                    if Stage.IMPLEMENT not in stage_order:
                        _log("Tests failed but IMPLEMENT stage is disabled — treating as pass", "warn")
                    else:
                        # Flat test-fix counter (not per-bead)
                        loop_counters["implement_test"] = loop_counters.get("implement_test", 0) + 1
                        status["loop_counters"] = dict(loop_counters)
                        bead_prompt_iter = prompt_builder.get_context("bead_prompt_iteration") or 0
                        prompt_builder.update_context("bead_prompt_iteration", bead_prompt_iter + 1)
                        _log(f"Tests failed — looping back to IMPLEMENT fix mode (attempt {loop_counters['implement_test']})", "warn")
                        if check_loop_limit("implement_test", loop_counters["implement_test"], settings_path, mloops=mloops):
                            if ctx:
                                emit_event(ctx, TEST_FIX_ATTEMPT, test_fix_attempt_payload(
                                    attempt=loop_counters["implement_test"],
                                    limit=_get_loop_limit("implement_test", settings_path, mloops),
                                    failures_summary=str(new_failures[:3]),
                                ))
                                _lt_event = emit_event(ctx, LOOP_TRIGGERED, loop_triggered_payload(
                                    loop_key="implement_test",
                                    iteration=loop_counters["implement_test"],
                                    from_stage=Stage.TEST.value,
                                    to_stage=Stage.IMPLEMENT.value,
                                    trigger="test_failure",
                                ))
                                if _lt_event:
                                    _action = _check_control_response(ctx, _lt_event)
                                    if _action == "pause":
                                        _handle_pause(ctx, "implement_test loop.triggered")
                                    elif _action == "abort":
                                        raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                            if prompt_context_path:
                                prompt_builder.save_context(prompt_context_path)
                            save_status(status, actual_status_path)
                            _next_trigger[Stage.IMPLEMENT.value] = "test_failure"
                            stage_idx = stage_order.index(Stage.IMPLEMENT)
                            continue
                        else:
                            _log(f"Test fix limit exhausted after {loop_counters['implement_test']} attempts — finishing", "warn")
                            if ctx:
                                emit_event(ctx, LOOP_EXHAUSTED, loop_exhausted_payload(
                                    loop_key="implement_test",
                                    iteration=loop_counters["implement_test"],
                                    limit=_get_loop_limit("implement_test", settings_path, mloops),
                                ))
                else:
                    iter_extras["outcome"] = "success"
                    complete_iteration(status, current_stage.value, **iter_extras)
                    update_stage(status, current_stage.value, **stage_extras)
                    save_status(status, actual_status_path)
                    if ctx:
                        emit_event(ctx, TEST_SUITE_PASSED, test_suite_passed_payload(
                            iteration=iter_num,
                            coverage_pct=result.get("coverage_pct"),
                            proof_artifacts=result.get("proof_artifacts"),
                        ))
                        _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                            stage=current_stage.value, iteration=iter_num,
                            duration_ms=iter_extras.get("duration_ms", 0),
                            cost_usd=iter_extras.get("cost_usd", 0.0),
                            turns=iter_extras.get("turns", 0),
                            outcome=iter_extras["outcome"],
                            token_usage=iter_extras.get("token_usage"),
                        ))
                        if _sc_event:
                            _action = _check_control_response(ctx, _sc_event)
                            if _action == "pause":
                                _handle_pause(ctx, f"{current_stage.value} stage.completed")
                            elif _action == "abort":
                                raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                    _log("Tests passed", "ok")

            # Handle review results — simplified (flat counter, no per-bead logic)
            elif current_stage == Stage.REVIEW:
                outcome = result.get("outcome", "approve")
                _log(f"Review outcome: {outcome}")
                _emit_guide_conflicts(ctx, "review", result)
                next_stage, status = handle_pr_review(outcome, status)
                _all_issues = result.get("issues", [])
                _critical_count = sum(
                    1 for i in _all_issues if i.get("severity") in ("critical", "major")
                )
                if ctx:
                    emit_event(ctx, REVIEW_VERDICT, review_verdict_payload(
                        outcome=outcome,
                        issue_count=len(_all_issues),
                        critical_count=_critical_count,
                    ))
                iter_extras["outcome"] = outcome
                complete_iteration(status, current_stage.value, **iter_extras)
                update_stage(status, current_stage.value, **stage_extras)
                save_status(status, actual_status_path)
                if ctx:
                    _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                        stage=current_stage.value, iteration=iter_num,
                        duration_ms=iter_extras.get("duration_ms", 0),
                        cost_usd=iter_extras.get("cost_usd", 0.0),
                        turns=iter_extras.get("turns", 0),
                        outcome=iter_extras["outcome"],
                        token_usage=iter_extras.get("token_usage"),
                    ))
                    if _sc_event:
                        _action = _check_control_response(ctx, _sc_event)
                        if _action == "pause":
                            _handle_pause(ctx, f"{current_stage.value} stage.completed")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                if next_stage is None:
                    if outcome == "reject":
                        _log("PR rejected — stopping", "err")
                        raise PipelineError("PR rejected")
                    _log("Review approved", "ok")

                elif next_stage == Stage.IMPLEMENT:
                    new_issues = result.get("issues", [])

                    # Severity-gate: only loop back for critical/major issues
                    critical_issues = [i for i in new_issues if i.get("severity") in ("critical", "major")]
                    if not critical_issues:
                        _log("Only minor/suggestion issues — treating as approve", "ok")
                    else:
                        # Accumulate review history
                        prev_history = prompt_builder.get_context("review_history") or []
                        prev_history.append({"attempt": len(prev_history) + 1, "issues": new_issues})
                        prompt_builder.update_context("review_history", prev_history)
                        prompt_builder.update_context("review_issues", critical_issues)
                        prompt_builder.update_context("test_failures", None)
                        prompt_builder.update_context("test_failure_history", None)

                        if Stage.IMPLEMENT not in stage_order:
                            _log("Changes requested but IMPLEMENT stage is disabled — skipping loop", "warn")
                        else:
                            # Flat review-fix counter (not per-bead)
                            loop_counters["pr_changes"] = loop_counters.get("pr_changes", 0) + 1
                            status["loop_counters"] = dict(loop_counters)
                            bead_prompt_iter = prompt_builder.get_context("bead_prompt_iteration") or 0
                            prompt_builder.update_context("bead_prompt_iteration", bead_prompt_iter + 1)
                            _log(f"Changes requested — looping back to IMPLEMENT fix mode (attempt {loop_counters['pr_changes']})", "warn")
                            if check_loop_limit("pr_changes", loop_counters["pr_changes"], settings_path, mloops=mloops):
                                if ctx:
                                    emit_event(ctx, REVIEW_FIX_ATTEMPT, review_fix_attempt_payload(
                                        attempt=loop_counters["pr_changes"],
                                        limit=_get_loop_limit("pr_changes", settings_path, mloops),
                                        critical_issues=critical_issues,
                                    ))
                                    _lt_event = emit_event(ctx, LOOP_TRIGGERED, loop_triggered_payload(
                                        loop_key="pr_changes",
                                        iteration=loop_counters["pr_changes"],
                                        from_stage=Stage.REVIEW.value,
                                        to_stage=Stage.IMPLEMENT.value,
                                        trigger="review_changes",
                                    ))
                                    if _lt_event:
                                        _action = _check_control_response(ctx, _lt_event)
                                        if _action == "pause":
                                            _handle_pause(ctx, "pr_changes loop.triggered")
                                        elif _action == "abort":
                                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                                if prompt_context_path:
                                    prompt_builder.save_context(prompt_context_path)
                                save_status(status, actual_status_path)
                                _next_trigger[Stage.IMPLEMENT.value] = "review_changes"
                                stage_idx = stage_order.index(Stage.IMPLEMENT)
                                continue
                            else:
                                _log(f"Review fix limit exhausted after {loop_counters['pr_changes']} attempts — finishing", "warn")
                                if ctx:
                                    emit_event(ctx, LOOP_EXHAUSTED, loop_exhausted_payload(
                                        loop_key="pr_changes",
                                        iteration=loop_counters["pr_changes"],
                                        limit=_get_loop_limit("pr_changes", settings_path, mloops),
                                    ))

                elif next_stage == Stage.PLAN:
                    if Stage.PLAN not in stage_order:
                        _log("Restart planning requested but PLAN stage is disabled — skipping loop", "warn")
                    else:
                        loop_key = "restart_planning"
                        loop_counters[loop_key] = loop_counters.get(loop_key, 0) + 1
                        status["loop_counters"] = dict(loop_counters)
                        _log(f"Restart planning requested (iteration {loop_counters[loop_key]})", "warn")
                        if not check_loop_limit(loop_key, loop_counters[loop_key], settings_path, mloops=mloops):
                            if ctx:
                                emit_event(ctx, LOOP_EXHAUSTED, loop_exhausted_payload(
                                    loop_key=loop_key,
                                    iteration=loop_counters[loop_key],
                                    limit=_get_loop_limit(loop_key, settings_path, mloops),
                                ))
                            raise LoopExhaustedError(
                                f"Loop {loop_key} exhausted after {loop_counters[loop_key]} iterations"
                            )
                        if ctx:
                            _lt_event = emit_event(ctx, LOOP_TRIGGERED, loop_triggered_payload(
                                loop_key=loop_key,
                                iteration=loop_counters[loop_key],
                                from_stage=Stage.REVIEW.value,
                                to_stage=Stage.PLAN.value,
                                trigger="restart_planning",
                            ))
                            if _lt_event:
                                _action = _check_control_response(ctx, _lt_event)
                                if _action == "pause":
                                    _handle_pause(ctx, "restart_planning loop.triggered")
                                elif _action == "abort":
                                    raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                        _next_trigger[Stage.PLAN.value] = "restart_planning"
                        stage_idx = stage_order.index(Stage.PLAN)
                        continue

            # PR stage: approval gate + completion
            elif current_stage == Stage.PR:
                # Milestone semantics intentionally asymmetric across approval gates:
                #   - plan_approval: default-true (opt-out). Already in production at this default;
                #     flipping it would silently disable an existing gate on every upgraded project.
                #   - pr_approval:   default-false (opt-in). New in W-049; default-true would hang
                #     every autonomous run waiting for an approval event nobody sends.
                _ms_cfg = load_settings(settings_path).get("worca", {}).get("milestones", {})
                if _ms_cfg.get("pr_approval") is not True:
                    pr_approved = True
                else:
                    set_milestone(status, "pr_approved", False)
                    status["pipeline_status"] = PipelineStatus.PAUSED
                    save_status(status, actual_status_path)
                    pr_approved = False
                    if ctx:
                        _ms_event = emit_event(ctx, MILESTONE_SET, milestone_set_payload(
                            milestone="pr_approved", value=False, stage=Stage.PR.value,
                        ))
                        if _ms_event:
                            _action = _check_control_response_with_timeout(
                                ctx, _ms_event,
                                timeout_seconds=_ms_cfg.get("pr_approval_timeout_seconds", 3600),
                                timeout_default="approve",
                            )
                            if _action == "approve":
                                pr_approved = True
                                set_milestone(status, "pr_approved", True)
                                status["pipeline_status"] = PipelineStatus.RUNNING
                            elif _action == "reject":
                                raise PipelineInterrupted("PR creation rejected by user", stop_reason="pr_rejected")
                            elif _action == "pause":
                                _handle_pause(ctx, "pr_approved milestone")
                            elif _action == "abort":
                                raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                    else:
                        pr_approved = True
                        set_milestone(status, "pr_approved", True)
                        status["pipeline_status"] = PipelineStatus.RUNNING

                if not pr_approved:
                    save_status(status, actual_status_path)
                    # Mirror paused into the multi-pipeline registry before
                    # returning — otherwise the entry stays "running" while
                    # this process exits at the PR-approval gate, and
                    # reconcile_stale() / fleet status derivation misread it.
                    if status.get("worktree") and status.get("run_id"):
                        try:
                            update_pipeline(
                                status["run_id"], status="paused", base=registry_dir
                            )
                        except Exception:
                            pass  # registry mirror is best-effort
                    return

                # Post-condition verification: only when guardian explicitly
                # declares outcome=success (prose-fallback and partial outputs
                # bypass this gate — they already recovered what they can).
                _pr_verification_passed = False
                if isinstance(result, dict) and result.get("outcome") == "success":
                    _vr = _verify_pr_stage(result, _pr_baseline_head)
                    if not _vr.ok:
                        _log(f"PR stage verification failed: {_vr.reason}", "warn")
                        loop_counters["pr_verification_retry"] = (
                            loop_counters.get("pr_verification_retry", 0) + 1
                        )
                        status["loop_counters"] = dict(loop_counters)
                        iter_extras["outcome"] = "reject"
                        complete_iteration(status, current_stage.value, **iter_extras)
                        if loop_counters["pr_verification_retry"] > 1:
                            set_milestone(status, "pr_verified", False)
                            if ctx:
                                emit_event(ctx, MILESTONE_SET, milestone_set_payload(
                                    milestone="pr_verified", value=False,
                                    stage=Stage.PR.value,
                                ))
                            raise PipelineError(
                                f"PR verification failed after retry: {_vr.reason}"
                            )
                        save_status(status, actual_status_path)
                        continue
                    _pr_verification_passed = True

                iter_extras["outcome"] = "success"
                complete_iteration(status, current_stage.value, **iter_extras)
                update_stage(status, current_stage.value, **stage_extras)
                save_status(status, actual_status_path)
                if ctx:
                    _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                        stage=current_stage.value, iteration=iter_num,
                        duration_ms=iter_extras.get("duration_ms", 0),
                        cost_usd=iter_extras.get("cost_usd", 0.0),
                        turns=iter_extras.get("turns", 0),
                        outcome=iter_extras["outcome"],
                        token_usage=iter_extras.get("token_usage"),
                    ))
                    if _sc_event:
                        _action = _check_control_response(ctx, _sc_event)
                        if _action == "pause":
                            _handle_pause(ctx, f"{current_stage.value} stage.completed")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
                if _pr_verification_passed:
                    set_milestone(status, "pr_verified", True)
                    save_status(status, actual_status_path)
                    if ctx:
                        emit_event(ctx, MILESTONE_SET, milestone_set_payload(
                            milestone="pr_verified", value=True,
                            stage=Stage.PR.value,
                        ))
                if isinstance(result, dict):
                    _pr_url = result.get("pr_url")
                    _pr_number = result.get("pr_number")
                    if _pr_url and _pr_number is not None:
                        _commit_sha = result.get("commit_sha")
                        # Branches: prefer agent value, fall back to runner state.
                        # The orchestrator already knows both — no reason to
                        # require the agent to re-emit them.
                        _source_branch = (
                            result.get("source_branch")
                            or status.get("branch")
                        )
                        _target_branch = (
                            result.get("target_branch")
                            or status.get("target_branch")
                        )
                        # Provider: agent may emit it, but verify/fill from URL.
                        _provider = result.get("provider")
                        if not _provider or _provider == "other":
                            _parsed = parse_pr_url(_pr_url)
                            if _parsed["provider"] != "other":
                                _provider = _parsed["provider"]
                            elif not _provider:
                                _provider = "other"
                        _review_status = result.get("review_status")
                        status["pr"] = {
                            "url": _pr_url,
                            "number": _pr_number,
                            "commit_sha": _commit_sha,
                            "source_branch": _source_branch,
                            "target_branch": _target_branch,
                            "provider": _provider,
                            "review_status": _review_status,
                        }
                        save_status(status, actual_status_path)
                        if ctx:
                            emit_event(ctx, GIT_PR_CREATED, git_pr_created_payload(
                                pr_url=_pr_url,
                                pr_number=_pr_number,
                                title=work_request.title,
                                commit_sha=_commit_sha,
                                source_branch=_source_branch,
                                target_branch=_target_branch,
                                provider=_provider,
                            ))

                    _maybe_graphify_post_guardian(
                        settings_path=settings_path,
                        is_worktree=bool(status.get("worktree")),
                    )
                    _maybe_crg_post_guardian(
                        settings_path=settings_path,
                        is_worktree=bool(status.get("worktree")),
                    )

            # Default: complete iteration for stages without special handling
            else:
                iter_extras["outcome"] = "success"
                complete_iteration(status, current_stage.value, **iter_extras)
                update_stage(status, current_stage.value, **stage_extras)
                save_status(status, actual_status_path)
                if ctx:
                    _sc_event = emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(
                        stage=current_stage.value, iteration=iter_num,
                        duration_ms=iter_extras.get("duration_ms", 0),
                        cost_usd=iter_extras.get("cost_usd", 0.0),
                        turns=iter_extras.get("turns", 0),
                        outcome=iter_extras["outcome"],
                        token_usage=iter_extras.get("token_usage"),
                    ))
                    if _sc_event:
                        _action = _check_control_response(ctx, _sc_event)
                        if _action == "pause":
                            _handle_pause(ctx, f"{current_stage.value} stage.completed")
                        elif _action == "abort":
                            raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")

            # Persist context and loop counters after each completed stage
            status["loop_counters"] = dict(loop_counters)
            save_status(status, actual_status_path)
            if prompt_context_path:
                prompt_builder.save_context(prompt_context_path)

            stage_idx += 1

        total_elapsed = time.time() - pipeline_t0

        # Compute run-level token aggregate from stage data
        all_iter_usages = []
        by_stage_agg = {}
        for stage_name, stage_data in status.get("stages", {}).items():
            stage_token = stage_data.get("token_usage")
            if stage_token:
                by_stage_agg[stage_name] = stage_token
            for it in stage_data.get("iterations", []):
                it_usage = it.get("token_usage")
                if it_usage:
                    all_iter_usages.append(it_usage)

        if all_iter_usages:
            run_agg = aggregate_token_usage(all_iter_usages)
            run_agg["by_model"] = aggregate_by_model(all_iter_usages)
            run_agg["by_stage"] = by_stage_agg
            status["token_usage"] = run_agg

        # Extract totals for logging
        run_token = status.get("token_usage", {})
        total_cost = run_token.get("total_cost_usd", 0)
        total_turns = run_token.get("num_turns", 0)

        # Persistent guard: skip terminal state-write + event if another process
        # (e.g. an orphaned subagent) already drove the run to a terminal state.
        if _is_already_terminal(actual_status_path, status):
            _log("Skipping RUN_COMPLETED — run is already terminal on disk", "warn")
        else:
            # Mark pipeline as completed with timestamp
            status["pipeline_status"] = PipelineStatus.COMPLETED
            status["completed_at"] = datetime.now(timezone.utc).isoformat()
            save_status(status, actual_status_path)

            # Update multi-pipeline registry on completion (worktree mode)
            if status.get("worktree") and status.get("run_id"):
                update_pipeline(status["run_id"], status="completed", base=registry_dir)

            # Update GitHub issue (post summary, remove label, close)
            gh_issue_complete(status)

            # Update cumulative stats
            stats_dir = os.path.join(os.path.dirname(actual_status_path), "..", "..", "stats")
            if run_dir:
                stats_dir = os.path.join(os.path.dirname(os.path.dirname(run_dir)), "stats")
            stats_path = os.path.join(stats_dir, "cumulative.json")
            try:
                update_cumulative_stats(status, stats_path)
            except Exception as e:
                _log(f"Warning: failed to update cumulative stats: {e}", "warn")

            _log(f"Pipeline completed in {_format_duration(total_elapsed)}", "ok")
            summary_parts = []
            if total_turns:
                summary_parts.append(f"turns={total_turns}")
            if total_cost:
                summary_parts.append(f"cost=${total_cost:.2f}")
            total_tokens = run_token.get("input_tokens", 0) + run_token.get("output_tokens", 0)
            if total_tokens:
                summary_parts.append(f"tokens={total_tokens:,}")
            if summary_parts:
                _log(f"Totals: {' | '.join(summary_parts)}")

            _run_learn_stage(status, prompt_builder, settings_path, run_dir,
                             "success", "", msize, logs_dir, ctx=ctx)

            if ctx:
                _stages_done = [s for s, d in status.get("stages", {}).items() if d.get("status") == PipelineStatus.COMPLETED]
                emit_event(ctx, RUN_COMPLETED, run_completed_payload(
                    duration_ms=int(total_elapsed * 1000),
                    total_cost_usd=total_cost,
                    total_turns=total_turns,
                    total_tokens=total_tokens,
                    stages_completed=_stages_done,
                ))

        return status
    except PipelineInterrupted as exc:
        if not _is_already_terminal(actual_status_path, status):
            status["pipeline_status"] = PipelineStatus.INTERRUPTED
            status["stop_reason"] = exc.stop_reason
            save_status(status, actual_status_path)
            # Mirror terminal status into the multi-pipeline registry so global-mode
            # views don't keep showing the run as "running" after SIGTERM/control_file.
            if status.get("worktree") and status.get("run_id"):
                try:
                    update_pipeline(status["run_id"], status="interrupted", base=registry_dir)
                except Exception:
                    pass  # registry sync is best-effort; status.json is canonical
            if ctx and _pending_signal_event is None and not _signal_event_emitted:
                emit_event(ctx, RUN_INTERRUPTED, run_interrupted_payload(
                    interrupted_stage=status.get("stage", ""),
                    elapsed_ms=int((time.time() - pipeline_t0) * 1000),
                    source=exc.stop_reason,
                ))
        else:
            _log("Skipping RUN_INTERRUPTED — run is already terminal on disk", "warn")
        raise  # Do NOT run learn on user interruption
    except LoopExhaustedError as e:
        if not _is_already_terminal(actual_status_path, status):
            status["pipeline_status"] = PipelineStatus.FAILED
            status["stop_reason"] = "loop_exhausted"
            save_status(status, actual_status_path)
            _run_learn_stage(status, prompt_builder, settings_path, run_dir,
                             "loop_exhausted", str(e), msize, logs_dir, ctx=ctx)
            if ctx:
                emit_event(ctx, RUN_FAILED, run_failed_payload(
                    error=str(e),
                    failed_stage=status.get("stage"),
                    error_type="loop_exhausted",
                ))
        else:
            _log("Skipping RUN_FAILED — run is already terminal on disk", "warn")
        raise
    except PipelineError as e:
        if not _is_already_terminal(actual_status_path, status):
            status["pipeline_status"] = PipelineStatus.FAILED
            status["stop_reason"] = "pipeline_error"
            save_status(status, actual_status_path)
            # Skip LEARN when preflight fails — environment is broken, claude CLI unavailable
            if status.get("stage") != "preflight":
                _run_learn_stage(status, prompt_builder, settings_path, run_dir,
                                 "failure", str(e), msize, logs_dir, ctx=ctx)
            if ctx:
                emit_event(ctx, RUN_FAILED, run_failed_payload(
                    error=str(e),
                    failed_stage=status.get("stage"),
                    error_type="pipeline_error",
                ))
        else:
            _log("Skipping RUN_FAILED — run is already terminal on disk", "warn")
        raise
    except Exception as e:
        if not _is_already_terminal(actual_status_path, status):
            status["pipeline_status"] = PipelineStatus.FAILED
            status["stop_reason"] = type(e).__name__
            save_status(status, actual_status_path)
            _run_learn_stage(status, prompt_builder, settings_path, run_dir,
                             "failure", str(e), msize, logs_dir, ctx=ctx)
            if ctx:
                emit_event(ctx, RUN_FAILED, run_failed_payload(
                    error=str(e),
                    failed_stage=status.get("stage"),
                    error_type=type(e).__name__,
                ))
        else:
            _log("Skipping RUN_FAILED — run is already terminal on disk", "warn")
        raise
    finally:
        # Final sweep: kill any process groups still tracked for this run. The
        # signal handler only fast-kills the current agent; this main-thread
        # sweep (full SIGTERM→SIGKILL escalation) catches prior-iteration groups
        # on the interrupt unwind, and anything left after an unexpected exit.
        # No-op on the happy path (entries already removed as agents finished)
        # and on non-POSIX (nothing was ever recorded).
        try:
            if run_dir:
                kill_all_tracked(os.path.join(run_dir, "procs"))
        except Exception:
            pass
        # Dispatch any signal-stashed interrupted event to webhooks/integrations.
        # Must run BEFORE ctx.close() so the dispatch helper can read ctx state.
        # No-op if the signal handler didn't fire or the dispatch already happened.
        try:
            _dispatch_pending_signal_event(ctx)
        except Exception:
            pass
        if ctx is not None:
            ctx.close()
        # Safety net: ensure pipeline_status is never left as "running" on exit
        try:
            if status and status.get("pipeline_status") == PipelineStatus.RUNNING:
                status["pipeline_status"] = PipelineStatus.FAILED
                if not status.get("stop_reason"):
                    status["stop_reason"] = "unexpected_exit"
            if prompt_context_path and prompt_builder:
                prompt_builder.save_context(prompt_context_path)
            if status:
                if loop_counters:
                    status["loop_counters"] = dict(loop_counters)
                save_status(status, actual_status_path)
        except Exception:
            pass  # Don't mask the real error
        # Update multi-pipeline registry on failure (worktree mode)
        # Success case is handled above before the except blocks.
        try:
            if (status and status.get("worktree") and status.get("run_id")
                    and status.get("pipeline_status") == PipelineStatus.FAILED):
                update_pipeline(status["run_id"], status="failed", base=registry_dir)
        except Exception:
            pass
        # Stop the worktree-scoped beads daemon. Never touch the parent project's
        # daemon (shared with worca-ui and user shells).
        try:
            if status and status.get("worktree"):
                beads_dir = os.path.normpath(
                    os.path.join(os.path.abspath(worca_dir), "..", ".beads")
                )
                if os.path.isdir(beads_dir):
                    bd_daemon_stop(beads_dir)
        except Exception:
            pass
        _restore_signal_handlers()
        # Clear signal/atexit refs — finally block already handled cleanup
        _signal_status = None
        _signal_status_path = None
        _signal_project_status_path = None
        _signal_event_ctx = None
        _pending_signal_event = None
        _signal_event_emitted = False
        _signal_registry_dir = None
        _signal_run_id = None
        try:
            atexit.unregister(_atexit_cleanup)
        except Exception:
            pass
        # Remove PID files (per-run + project-level)
        _remove_pid(actual_status_path)
        _remove_pid(status_path)
        _close_orchestrator_log()
        os.environ.pop("WORCA_PLAN_FILE", None)
        os.environ.pop("WORCA_RUN_ID", None)
        os.environ.pop("WORCA_RUN_DIR", None)
        os.environ.pop("WORCA_EVENTS_PATH", None)
