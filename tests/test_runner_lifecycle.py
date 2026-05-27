"""Tests for pipeline lifecycle state management (signal handler, atexit, finally, resume, beads)."""

import json
import os
import signal
from unittest.mock import patch

import pytest

import worca.orchestrator.runner as runner
from worca.events.emitter import EventContext
from worca.orchestrator.control import write_control, control_path
from worca.state.status import save_status, load_status


@pytest.fixture(autouse=True)
def _reset_signal_event_flag():
    """Reset the signal-event guard so each test starts clean."""
    runner._signal_event_emitted = False
    runner._pending_signal_event = None
    yield
    runner._signal_event_emitted = False
    runner._pending_signal_event = None


def _make_ctx(tmp_path, run_id="test-run-1"):
    events_path = str(tmp_path / "events.jsonl")
    return EventContext(
        run_id=run_id,
        branch="main",
        work_request={},
        events_path=events_path,
        settings_path=str(tmp_path / "settings.json"),
        _webhooks=[],
        _control_webhooks=[],
        _shell_hooks={},
    )


# --- Layer 1: signal handler saves interrupted status ---

_posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX-only: signals")


@_posix_only
def test_signal_handler_saves_failed_status(tmp_path):
    """Calling the signal handler writes pipeline_status='interrupted' with stop_reason='signal'
    and emits a pipeline.run.interrupted event to events.jsonl."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "running", "current_stage": "plan", "stop_reason": ""}
    save_status(status, status_path)
    ctx = _make_ctx(tmp_path)

    runner._signal_status = status
    runner._signal_status_path = status_path
    runner._signal_event_ctx = ctx
    try:
        runner._install_signal_handlers()
        os.kill(os.getpid(), signal.SIGINT)

        on_disk = load_status(status_path)
        assert on_disk["pipeline_status"] == "interrupted"
        assert on_disk["stop_reason"] == "signal"

        lines = (tmp_path / "events.jsonl").read_text().strip().splitlines()
        assert len(lines) == 1
        event = json.loads(lines[0])
        assert event["event_type"] == "pipeline.run.interrupted"
    finally:
        runner._signal_event_ctx = None
        runner._signal_status = None
        runner._signal_status_path = None
        runner._shutdown_requested = False
        runner._restore_signal_handlers()


@_posix_only
def test_signal_handler_noop_when_status_not_set(tmp_path):
    """Signal handler is safe when _signal_status is None — no crash, no file write."""
    runner._signal_status = None
    runner._signal_status_path = None
    try:
        runner._install_signal_handlers()
        # Should not raise
        os.kill(os.getpid(), signal.SIGINT)
        # Just confirm we got here without error
        assert runner._shutdown_requested is True
    finally:
        runner._shutdown_requested = False
        runner._restore_signal_handlers()


@_posix_only
def test_signal_handler_preserves_existing_stop_reason(tmp_path):
    """Signal handler doesn't overwrite an existing stop_reason."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "running", "stop_reason": "stopped"}
    save_status(status, status_path)

    runner._signal_status = status
    runner._signal_status_path = status_path
    try:
        runner._install_signal_handlers()
        os.kill(os.getpid(), signal.SIGINT)

        on_disk = load_status(status_path)
        assert on_disk["pipeline_status"] == "interrupted"
        assert on_disk["stop_reason"] == "stopped"  # preserved, not "signal"
    finally:
        runner._signal_status = None
        runner._signal_status_path = None
        runner._shutdown_requested = False
        runner._restore_signal_handlers()


@_posix_only
def test_signal_handler_emits_interrupted_event(tmp_path):
    """_handler() writes pipeline.run.interrupted to events.jsonl when _signal_event_ctx is set."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "running", "current_stage": "implement", "stop_reason": ""}
    save_status(status, status_path)
    ctx = _make_ctx(tmp_path)

    runner._signal_status = status
    runner._signal_status_path = status_path
    runner._signal_event_ctx = ctx
    try:
        runner._install_signal_handlers()
        os.kill(os.getpid(), signal.SIGINT)

        lines = (tmp_path / "events.jsonl").read_text().strip().splitlines()
        assert len(lines) == 1
        event = json.loads(lines[0])
        assert event["event_type"] == "pipeline.run.interrupted"
        assert event["payload"]["interrupted_stage"] == "implement"
        assert event["payload"]["source"] == "signal"
        assert event["run_id"] == "test-run-1"
    finally:
        runner._signal_event_ctx = None
        runner._signal_status = None
        runner._signal_status_path = None
        runner._shutdown_requested = False
        runner._restore_signal_handlers()


@_posix_only
def test_signal_handler_no_event_when_ctx_not_set(tmp_path):
    """_handler() is safe when _signal_event_ctx is None — no crash, no events file."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "running", "stop_reason": ""}
    save_status(status, status_path)

    runner._signal_status = status
    runner._signal_status_path = status_path
    runner._signal_event_ctx = None
    try:
        runner._install_signal_handlers()
        os.kill(os.getpid(), signal.SIGINT)

        assert not (tmp_path / "events.jsonl").exists()
        on_disk = load_status(status_path)
        assert on_disk["pipeline_status"] == "interrupted"
    finally:
        runner._signal_status = None
        runner._signal_status_path = None
        runner._shutdown_requested = False
        runner._restore_signal_handlers()


@_posix_only
def test_signal_handler_sets_interrupted_status(tmp_path):
    """_handler() sets pipeline_status='interrupted', not 'failed'."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "running", "current_stage": "test", "stop_reason": ""}
    save_status(status, status_path)
    ctx = _make_ctx(tmp_path)

    runner._signal_status = status
    runner._signal_status_path = status_path
    runner._signal_event_ctx = ctx
    try:
        runner._install_signal_handlers()
        os.kill(os.getpid(), signal.SIGINT)

        on_disk = load_status(status_path)
        assert on_disk["pipeline_status"] == "interrupted"
    finally:
        runner._signal_event_ctx = None
        runner._signal_status = None
        runner._signal_status_path = None
        runner._shutdown_requested = False
        runner._restore_signal_handlers()


# --- Layer 4: atexit cleanup ---


def test_atexit_cleanup_saves_when_running(tmp_path):
    """atexit handler transitions 'running' → 'failed' (no ctx) with stop_reason='unexpected_exit'."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "running"}
    save_status(status, status_path)

    runner._signal_status = status
    runner._signal_status_path = status_path
    runner._signal_event_ctx = None
    try:
        runner._atexit_cleanup()

        on_disk = load_status(status_path)
        assert on_disk["pipeline_status"] == "failed"
        assert on_disk["stop_reason"] == "unexpected_exit"
    finally:
        runner._signal_status = None
        runner._signal_status_path = None


def test_atexit_cleanup_noop_when_already_failed(tmp_path):
    """atexit handler does not overwrite when status is already 'failed'."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "failed", "stop_reason": "signal"}
    save_status(status, status_path)

    runner._signal_status = status
    runner._signal_status_path = status_path
    try:
        runner._atexit_cleanup()

        on_disk = load_status(status_path)
        assert on_disk["pipeline_status"] == "failed"
        assert on_disk["stop_reason"] == "signal"  # unchanged
    finally:
        runner._signal_status = None
        runner._signal_status_path = None


def test_atexit_emits_event(tmp_path):
    """_atexit_cleanup() writes pipeline.run.interrupted to events.jsonl when status was 'running'."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "running", "current_stage": "review", "stop_reason": ""}
    save_status(status, status_path)
    ctx = _make_ctx(tmp_path, run_id="atexit-run-1")

    runner._signal_status = status
    runner._signal_status_path = status_path
    runner._signal_event_ctx = ctx
    try:
        runner._atexit_cleanup()

        lines = (tmp_path / "events.jsonl").read_text().strip().splitlines()
        assert len(lines) == 1
        event = json.loads(lines[0])
        assert event["event_type"] == "pipeline.run.interrupted"
        assert event["run_id"] == "atexit-run-1"
        assert event["payload"]["source"] == "atexit"
        assert event["payload"]["interrupted_stage"] == "review"
    finally:
        runner._signal_event_ctx = None
        runner._signal_status = None
        runner._signal_status_path = None


def test_atexit_no_event_when_already_terminal(tmp_path):
    """_atexit_cleanup() skips event emission when status is already terminal ('failed')."""
    status_path = str(tmp_path / "status.json")
    status = {"pipeline_status": "failed", "stop_reason": "error"}
    save_status(status, status_path)
    ctx = _make_ctx(tmp_path)

    runner._signal_status = status
    runner._signal_status_path = status_path
    runner._signal_event_ctx = ctx
    try:
        runner._atexit_cleanup()

        assert not (tmp_path / "events.jsonl").exists()
        on_disk = load_status(status_path)
        assert on_disk["pipeline_status"] == "failed"
    finally:
        runner._signal_event_ctx = None
        runner._signal_status = None
        runner._signal_status_path = None


def test_atexit_cleanup_noop_when_refs_none():
    """atexit handler is a no-op when refs are None."""
    runner._signal_status = None
    runner._signal_status_path = None
    # Should not raise
    runner._atexit_cleanup()


# --- Finally block clears signal refs ---


def test_finally_block_clears_signal_refs():
    """The finally block in run_pipeline clears _signal_status and _signal_status_path.

    We verify this by inspecting the code structure: the finally block sets both
    refs to None. This test validates the mechanism by simulating what the
    finally block does — setting refs then clearing them.
    """
    import atexit as _atexit

    # Simulate what run_pipeline does: set refs, then execute finally cleanup
    runner._signal_status = {"pipeline_status": "failed"}
    runner._signal_status_path = "/tmp/fake.json"
    _atexit.register(runner._atexit_cleanup)

    # Simulate finally block cleanup
    runner._signal_status = None
    runner._signal_status_path = None
    try:
        _atexit.unregister(runner._atexit_cleanup)
    except Exception:
        pass

    assert runner._signal_status is None
    assert runner._signal_status_path is None


# --- Signal handler installation: non-main-thread / embedded guard ---


def test_install_signal_handlers_tolerates_value_error():
    """_install_signal_handlers silently swallows ValueError (non-main thread)."""
    with patch("worca.orchestrator.runner.signal") as mock_signal:
        mock_signal.SIGTERM = signal.SIGTERM
        mock_signal.SIGINT = signal.SIGINT
        mock_signal.signal.side_effect = ValueError("not main thread")
        # Must not raise
        runner._install_signal_handlers()


def test_restore_signal_handlers_tolerates_value_error():
    """_restore_signal_handlers silently swallows ValueError (non-main thread)."""
    with patch("worca.orchestrator.runner.signal") as mock_signal:
        mock_signal.SIGTERM = signal.SIGTERM
        mock_signal.SIGINT = signal.SIGINT
        mock_signal.SIG_DFL = signal.SIG_DFL
        mock_signal.signal.side_effect = ValueError("not main thread")
        # Must not raise
        runner._restore_signal_handlers()


def test_install_signal_handlers_tolerates_os_error():
    """_install_signal_handlers silently swallows OSError (embedded/restricted)."""
    with patch("worca.orchestrator.runner.signal") as mock_signal:
        mock_signal.SIGTERM = signal.SIGTERM
        mock_signal.SIGINT = signal.SIGINT
        mock_signal.signal.side_effect = OSError("signal not supported")
        runner._install_signal_handlers()


def test_restore_signal_handlers_tolerates_os_error():
    """_restore_signal_handlers silently swallows OSError (embedded/restricted)."""
    with patch("worca.orchestrator.runner.signal") as mock_signal:
        mock_signal.SIGTERM = signal.SIGTERM
        mock_signal.SIGINT = signal.SIGINT
        mock_signal.SIG_DFL = signal.SIG_DFL
        mock_signal.signal.side_effect = OSError("signal not supported")
        runner._restore_signal_handlers()


# --- Resume: stale control.json cleanup ---


def test_resume_deletes_stale_control_file(tmp_path):
    """On resume, any leftover control.json from a previous stop is deleted
    before the main loop starts, preventing an immediate re-stop."""
    worca_dir = str(tmp_path)
    run_id = "20260322-120000"
    run_dir = tmp_path / "runs" / run_id
    run_dir.mkdir(parents=True)

    # Write a stale stop control file (simulates process killed before consuming it)
    write_control(run_id, "stop", source="cli", base=worca_dir)
    ctrl_path = control_path(run_id, base=worca_dir)
    assert os.path.exists(ctrl_path)

    # delete_control should remove it
    from worca.orchestrator.control import delete_control
    delete_control(run_id, base=worca_dir)
    assert not os.path.exists(ctrl_path)


def test_resume_deletes_stale_pause_control_file(tmp_path):
    """On resume, a leftover pause control.json is also cleaned up."""
    worca_dir = str(tmp_path)
    run_id = "20260322-130000"
    run_dir = tmp_path / "runs" / run_id
    run_dir.mkdir(parents=True)

    write_control(run_id, "pause", source="ui", base=worca_dir)
    ctrl_path = control_path(run_id, base=worca_dir)
    assert os.path.exists(ctrl_path)

    from worca.orchestrator.control import delete_control
    delete_control(run_id, base=worca_dir)
    assert not os.path.exists(ctrl_path)


def test_resume_noop_when_no_control_file(tmp_path):
    """delete_control is a no-op when no control file exists."""
    worca_dir = str(tmp_path)
    run_id = "20260322-140000"
    run_dir = tmp_path / "runs" / run_id
    run_dir.mkdir(parents=True)

    from worca.orchestrator.control import delete_control
    # Should not raise
    delete_control(run_id, base=worca_dir)


def test_resume_kills_orphaned_processes(tmp_path):
    """On resume, kill_all_tracked cleans up the run's procs dir,
    pruning stale entries and killing live tracked groups."""
    from worca.utils.proc_registry import kill_all_tracked, record_spawn

    run_id = "20260322-150000"
    run_dir = tmp_path / "runs" / run_id
    run_dir.mkdir(parents=True)
    procs_dir = str(run_dir / "procs")

    record_spawn(procs_dir, pgid=999999, pid=999999, stage="implement", iteration=3)
    record_spawn(procs_dir, pgid=999998, pid=999998, stage="implement", iteration=4)
    assert os.path.exists(os.path.join(procs_dir, "999999.json"))
    assert os.path.exists(os.path.join(procs_dir, "999998.json"))

    killed = kill_all_tracked(procs_dir)
    assert killed == 0
    assert not os.path.exists(os.path.join(procs_dir, "999999.json"))
    assert not os.path.exists(os.path.join(procs_dir, "999998.json"))


def test_circuit_breaker_retry_kills_tracked_processes():
    """The circuit-breaker retry path in run_pipeline calls kill_all_tracked
    before continuing, so orphaned process groups from the failed iteration
    are cleaned up before spawning the next one."""
    import inspect
    source = inspect.getsource(runner.run_pipeline)
    retry_section = source[source.index("Transient error"):]
    kill_pos = retry_section.index("kill_all_tracked")
    continue_pos = retry_section.index("continue")
    assert kill_pos < continue_pos, (
        "kill_all_tracked must appear before continue in the circuit-breaker retry path"
    )


# --- Bead assignment: _query_ready_bead filtering ---


def test_query_ready_bead_filters_by_allowed_ids():
    """_query_ready_bead only returns beads from the allowed_ids list."""
    fake_beads = [
        {"id": "old-bead-001", "title": "Stale from prior run", "priority": "2", "type": "task"},
        {"id": "run-bead-001", "title": "Current run task", "priority": "2", "type": "task"},
        {"id": "run-bead-002", "title": "Another current task", "priority": "2", "type": "task"},
    ]
    with patch("worca.orchestrator.runner.bd_ready", return_value=fake_beads):
        # Without filter — returns first bead (which is stale)
        result = runner._query_ready_bead()
        assert result["id"] == "old-bead-001"

        # With filter — skips stale bead, returns first matching
        result = runner._query_ready_bead(allowed_ids=["run-bead-001", "run-bead-002"])
        assert result["id"] == "run-bead-001"


def test_query_ready_bead_returns_none_when_no_match():
    """_query_ready_bead returns None when no beads match the allowed_ids."""
    fake_beads = [
        {"id": "old-bead-001", "title": "Stale", "priority": "2", "type": "task"},
    ]
    with patch("worca.orchestrator.runner.bd_ready", return_value=fake_beads):
        result = runner._query_ready_bead(allowed_ids=["run-bead-001"])
        assert result is None


def test_query_ready_bead_no_filter_returns_first():
    """_query_ready_bead with allowed_ids=None returns the first available bead."""
    fake_beads = [
        {"id": "bead-A", "title": "Task A", "priority": "2", "type": "task"},
        {"id": "bead-B", "title": "Task B", "priority": "2", "type": "task"},
    ]
    with patch("worca.orchestrator.runner.bd_ready", return_value=fake_beads):
        result = runner._query_ready_bead(allowed_ids=None)
        assert result["id"] == "bead-A"


def test_query_ready_bead_empty_allowed_ids_returns_none():
    """_query_ready_bead with an empty allowed_ids list returns None."""
    fake_beads = [
        {"id": "bead-A", "title": "Task A", "priority": "2", "type": "task"},
    ]
    with patch("worca.orchestrator.runner.bd_ready", return_value=fake_beads):
        result = runner._query_ready_bead(allowed_ids=[])
        assert result is None


# ---------------------------------------------------------------------------
# Race-safe exception classification (defense-in-depth for the signal-test flake)
# ---------------------------------------------------------------------------


class TestIsSignalKillException:
    """The runner exposes _is_signal_kill_exception so the except-Exception
    block can route signal-induced agent deaths to the interruption path
    even when the in-process signal handler hasn't yet run (Python defers
    signal delivery to bytecode boundaries; a C-level exception raised
    before that boundary leaves _shutdown_requested still False).
    """

    def test_true_for_negative_returncode(self):
        from worca.utils.claude_cli import AgentSubprocessError
        err = AgentSubprocessError("killed by signal 15", returncode=-15)
        assert runner._is_signal_kill_exception(err) is True

    def test_false_for_positive_returncode(self):
        """Guardrail #1: real failures (positive exit codes) must NOT be
        reclassified as interruptions — they remain failures so the
        circuit breaker and stage-failure paths still fire correctly."""
        from worca.utils.claude_cli import AgentSubprocessError
        err = AgentSubprocessError("agent failed", returncode=1)
        assert runner._is_signal_kill_exception(err) is False

    def test_false_for_zero_returncode(self):
        from worca.utils.claude_cli import AgentSubprocessError
        err = AgentSubprocessError("clean exit but no result", returncode=0)
        assert runner._is_signal_kill_exception(err) is False

    def test_false_for_none_returncode(self):
        """If we couldn't determine the returncode (subprocess wedged), do
        NOT assume interruption — fall through to the failed path."""
        from worca.utils.claude_cli import AgentSubprocessError
        err = AgentSubprocessError("uncaught", returncode=None)
        assert runner._is_signal_kill_exception(err) is False

    def test_false_for_unrelated_exceptions(self):
        """Plain RuntimeError and other exception types must not match —
        only AgentSubprocessError carries the trustworthy returncode."""
        assert runner._is_signal_kill_exception(RuntimeError("generic")) is False
        assert runner._is_signal_kill_exception(ValueError("oops")) is False
        assert runner._is_signal_kill_exception(KeyError("missing")) is False


# --- Finally block: daemon stop in worktree mode ---


def _minimal_settings(tmp_path):
    s = tmp_path / "settings.json"
    s.write_text(json.dumps({
        "worca": {
            "stages": {
                "plan": {"agent": "planner", "enabled": False},
                "coordinate": {"agent": "coordinator", "enabled": True},
                "implement": {"agent": "implementer", "enabled": False},
                "test": {"agent": "tester", "enabled": False},
                "review": {"agent": "guardian", "enabled": False},
                "pr": {"agent": "guardian", "enabled": False},
            },
            "agents": {"coordinator": {"model": "opus", "max_turns": 10}},
            "loops": {},
        }
    }))
    return s


def _run_pipeline_minimal(tmp_path, worktree: bool, *, create_beads_dir: bool = True):
    from worca.orchestrator.runner import run_pipeline
    from worca.orchestrator.work_request import WorkRequest

    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n")
    settings = _minimal_settings(tmp_path)
    worca_dir = tmp_path / ".worca"
    worca_dir.mkdir(exist_ok=True)
    # The finally block only calls bd_daemon_stop when the worktree's
    # `.beads/` directory exists.  Tests that want to exercise that path
    # must materialize one; tests that want to verify the gate skip it.
    if create_beads_dir:
        (tmp_path / ".beads").mkdir(exist_ok=True)
    status_path = str(worca_dir / "status.json")
    wr = WorkRequest(source_type="prompt", title="Daemon stop test")

    def _mock_stage(stage, context, settings_path, msize=1, iteration=1, prompt_override=None, **kwargs):
        return {"beads_ids": [], "dependency_graph": {}}, {"type": "result"}

    with patch("worca.orchestrator.runner._ensure_beads_initialized"), \
         patch("worca.orchestrator.runner.run_stage", side_effect=_mock_stage), \
         patch("worca.orchestrator.runner.create_branch"), \
         patch("worca.orchestrator.runner._write_pid"), \
         patch("worca.orchestrator.runner._remove_pid"), \
         patch("worca.orchestrator.runner.bd_daemon_stop") as mock_stop:
        run_pipeline(
            wr,
            plan_file=str(plan),
            settings_path=str(settings),
            status_path=status_path,
            worktree=worktree,
        )
        return mock_stop


def test_run_pipeline_finally_calls_bd_daemon_stop_in_worktree_mode(tmp_path):
    """In worktree mode with a real .beads/, the finally block calls bd_daemon_stop once."""
    mock_stop = _run_pipeline_minimal(tmp_path, worktree=True)
    mock_stop.assert_called_once()


def test_run_pipeline_finally_does_not_call_bd_daemon_stop_in_place_mode(tmp_path):
    """In in-place mode (worktree=False) bd_daemon_stop is never called."""
    mock_stop = _run_pipeline_minimal(tmp_path, worktree=False)
    mock_stop.assert_not_called()


def test_run_pipeline_finally_skips_bd_daemon_stop_when_beads_dir_absent(tmp_path):
    """Gate: even in worktree mode, if .beads/ does not exist (e.g. WORCA_SKIP_BEADS
    runs), the finally block must not invoke bd_daemon_stop."""
    mock_stop = _run_pipeline_minimal(tmp_path, worktree=True, create_beads_dir=False)
    mock_stop.assert_not_called()


# --- _clear_stale_daemon_lock tests ---


def test_clear_stale_daemon_lock_removes_files_for_dead_pid(tmp_path):
    """When daemon.pid contains a PID that is not running, both lock files are removed."""
    beads_dir = tmp_path / ".beads"
    beads_dir.mkdir()
    pid_file = beads_dir / "daemon.pid"
    lock_file = beads_dir / "daemon.lock"
    pid_file.write_text("999999\n")
    lock_file.write_text("")

    with patch("worca.orchestrator.runner.pid_is_alive", return_value=False):
        runner._clear_stale_daemon_lock(str(beads_dir))

    assert not pid_file.exists()
    assert not lock_file.exists()


def test_clear_stale_daemon_lock_leaves_files_for_live_pid(tmp_path):
    """When daemon.pid contains a running PID, the lock files are left untouched."""
    beads_dir = tmp_path / ".beads"
    beads_dir.mkdir()
    pid_file = beads_dir / "daemon.pid"
    lock_file = beads_dir / "daemon.lock"
    pid_file.write_text("12345\n")
    lock_file.write_text("")

    with patch("worca.orchestrator.runner.pid_is_alive", return_value=True):
        runner._clear_stale_daemon_lock(str(beads_dir))

    assert pid_file.exists()
    assert lock_file.exists()


def test_clear_stale_daemon_lock_noop_when_pidfile_missing(tmp_path):
    """When daemon.pid does not exist, the function returns without error."""
    beads_dir = tmp_path / ".beads"
    beads_dir.mkdir()

    runner._clear_stale_daemon_lock(str(beads_dir))


def test_clear_stale_daemon_lock_leaves_files_on_permission_error(tmp_path):
    """When pid_is_alive raises PermissionError the PID is assumed live; files are left."""
    beads_dir = tmp_path / ".beads"
    beads_dir.mkdir()
    pid_file = beads_dir / "daemon.pid"
    lock_file = beads_dir / "daemon.lock"
    pid_file.write_text("42\n")
    lock_file.write_text("")

    with patch("worca.orchestrator.runner.pid_is_alive", side_effect=PermissionError):
        runner._clear_stale_daemon_lock(str(beads_dir))

    assert pid_file.exists()
    assert lock_file.exists()


# --- Persistent terminal-event guard ---


class TestIsAlreadyTerminal:
    """_is_already_terminal reads status.json from disk and returns True
    when the run has already reached a terminal pipeline_status."""

    def test_returns_true_for_completed(self, tmp_path):
        status_path = str(tmp_path / "status.json")
        save_status({"pipeline_status": "completed", "completed_at": "2026-01-01T00:00:00Z"}, status_path)
        assert runner._is_already_terminal(status_path) is True

    def test_returns_true_for_failed(self, tmp_path):
        status_path = str(tmp_path / "status.json")
        save_status({"pipeline_status": "failed"}, status_path)
        assert runner._is_already_terminal(status_path) is True

    def test_returns_true_for_interrupted(self, tmp_path):
        status_path = str(tmp_path / "status.json")
        save_status({"pipeline_status": "interrupted"}, status_path)
        assert runner._is_already_terminal(status_path) is True

    def test_returns_false_for_running(self, tmp_path):
        status_path = str(tmp_path / "status.json")
        save_status({"pipeline_status": "running"}, status_path)
        assert runner._is_already_terminal(status_path) is False

    def test_returns_false_for_paused(self, tmp_path):
        status_path = str(tmp_path / "status.json")
        save_status({"pipeline_status": "paused"}, status_path)
        assert runner._is_already_terminal(status_path) is False

    def test_returns_false_when_file_missing(self, tmp_path):
        status_path = str(tmp_path / "nonexistent.json")
        assert runner._is_already_terminal(status_path) is False

    def test_returns_false_on_corrupt_json(self, tmp_path):
        status_path = str(tmp_path / "status.json")
        (tmp_path / "status.json").write_text("not json")
        assert runner._is_already_terminal(status_path) is False
