"""Tests for worca.utils.beads - bd CLI wrapper."""

import os
import signal
import subprocess
from unittest.mock import patch, MagicMock, mock_open

from worca.utils.beads import (
    bd_create, bd_ready, bd_show, bd_close, bd_update, bd_dep_add,
    bd_daemon_stop, bd_daemon_status, bd_daemon_start, bd_daemon_ensure,
    bd_get_effort_label,
    _wait_for_pid_exit, _DAEMON_STOPPED_SENTINEL,
)


# --- bd_create ---

def test_bd_create_returns_id():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "Created ccexperiments-abc: My task\n"
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_create("My task")
    assert result == "ccexperiments-abc"


def test_bd_create_with_custom_type_and_priority():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "Created proj-123: Bug fix\n"
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result) as mock_run:
        result = bd_create("Bug fix", task_type="bug", priority=1)
    assert result == "proj-123"
    args = mock_run.call_args[0][0]
    assert "--type=bug" in args
    assert "--priority=1" in args


def test_bd_create_raises_on_failure():
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stderr = "Error: something went wrong"
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        try:
            bd_create("Fail task")
            assert False, "Should have raised"
        except RuntimeError as e:
            assert "something went wrong" in str(e)


# --- bd_ready ---

def test_bd_ready_parses_numbered_list():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = (
        "\U0001f4cb Ready work (2 issues with no blockers):\n"
        "\n"
        "1. [\u25cf P2] [task] worca-cc-744: Server: add listUnlinkedIssues() and listDistinctExternalRefs() queries to beads-reader.js\n"
        "2. [\u25cf P4] [feature] worca-cc-a27: test parsing output\n"
    )
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_ready()
    assert len(result) == 2
    assert result[0]["id"] == "worca-cc-744"
    assert result[0]["title"] == "Server: add listUnlinkedIssues() and listDistinctExternalRefs() queries to beads-reader.js"
    assert result[0]["priority"] == "2"
    assert result[0]["type"] == "task"
    assert result[1]["id"] == "worca-cc-a27"
    assert result[1]["title"] == "test parsing output"
    assert result[1]["priority"] == "4"
    assert result[1]["type"] == "feature"


def test_bd_ready_empty_output():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = ""
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_ready()
    assert result == []


def test_bd_ready_header_only():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "\U0001f4cb Ready work (0 issues with no blockers):\n"
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_ready()
    assert result == []


# --- bd_show ---

def test_bd_show_parses_full_output():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = (
        "\u25cb worca-cc-a27 \u00b7 test parsing output   [\u25cf P4 \u00b7 OPEN]\n"
        "\n"
        "DESCRIPTION\n"
        "Parse the bd ready output correctly to extract bead IDs.\n"
        "Should handle numbered list format.\n"
        "\n"
        "DEPENDENCIES\n"
        "  (none)\n"
    )
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_show("worca-cc-a27")
    assert result["id"] == "worca-cc-a27"
    assert result["title"] == "test parsing output"
    assert result["priority"] == "4"
    assert result["status"] == "open"
    assert "Parse the bd ready output correctly" in result["description"]
    assert "Should handle numbered list format." in result["description"]


def test_bd_show_no_description():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = (
        "\u25cb worca-cc-001 \u00b7 Simple task   [\u25cf P2 \u00b7 IN_PROGRESS]\n"
        "\n"
        "DESCRIPTION\n"
        "\n"
        "DEPENDENCIES\n"
    )
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_show("worca-cc-001")
    assert result["id"] == "worca-cc-001"
    assert result["title"] == "Simple task"
    assert result["description"] == ""


def test_bd_show_raises_on_failure():
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stderr = "Error: issue not found"
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        try:
            bd_show("nonexistent-id")
            assert False, "Should have raised"
        except RuntimeError as e:
            assert "issue not found" in str(e)


# --- bd_close ---

def test_bd_close_success():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result) as mock_run:
        result = bd_close("proj-001")
    assert result is True
    args = mock_run.call_args[0][0]
    assert "close" in args
    assert "proj-001" in args


def test_bd_close_with_reason():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result) as mock_run:
        result = bd_close("proj-001", reason="Completed")
    assert result is True
    args = mock_run.call_args[0][0]
    assert '--reason=Completed' in args


def test_bd_close_failure():
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_close("proj-999")
    assert result is False


# --- bd_update ---

def test_bd_update_success():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result) as mock_run:
        result = bd_update("proj-001", status="in-progress", title="New title")
    assert result is True
    args = mock_run.call_args[0][0]
    assert "--status=in-progress" in args
    assert "--title=New title" in args


def test_bd_update_failure():
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_update("proj-001", status="done")
    assert result is False


# --- bd_dep_add ---

def test_bd_dep_add_success():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result) as mock_run:
        result = bd_dep_add("proj-001", "proj-002")
    assert result is True
    args = mock_run.call_args[0][0]
    assert "dep" in args
    assert "add" in args
    assert "proj-001" in args
    assert "proj-002" in args


def test_bd_dep_add_failure():
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_dep_add("proj-001", "proj-999")
    assert result is False


# --- bd_daemon_stop ---


def test_bd_daemon_stop_success_passes_cwd_for_workspace_resolution():
    """bd daemon stop succeeds within timeout and is invoked with cwd set to
    the workspace root so bd resolves the worktree's daemon (not the parent
    repo's).  Returns True without consulting the pidfile."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result) as mock_run:
        result = bd_daemon_stop("/tmp/beads")
    assert result is True
    kwargs = mock_run.call_args.kwargs
    assert kwargs["cwd"] == "/tmp", (
        "phase 1 must run with cwd=workspace root so bd resolves the right daemon"
    )
    assert kwargs["env"]["BEADS_DIR"] == "/tmp/beads"


def test_bd_daemon_stop_timeout_sigterm_fallback():
    """subprocess times out → liveness probe + SIGTERM via pidfile → True."""
    # os.kill is called twice in the fallback path: liveness probe (sig=0)
    # and the actual SIGTERM.  Bypass the post-SIGTERM wait helper so the
    # test doesn't sleep for ~1s.
    with patch("worca.utils.beads.subprocess.run",
               side_effect=subprocess.TimeoutExpired(cmd="bd", timeout=2.0)), \
         patch("builtins.open", mock_open(read_data="9999\n")), \
         patch("worca.utils.beads.os.kill") as mock_kill, \
         patch("worca.utils.beads._wait_for_pid_exit", return_value=True):
        result = bd_daemon_stop("/tmp/beads")
    assert result is True
    assert mock_kill.call_args_list == [
        ((9999, 0),),                # liveness probe
        ((9999, signal.SIGTERM),),   # actual signal
    ]


def test_bd_daemon_stop_no_pidfile():
    """subprocess fails, pidfile absent — returns False, error is swallowed."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result), \
         patch("builtins.open", side_effect=FileNotFoundError):
        result = bd_daemon_stop("/tmp/beads")
    assert result is False


def test_bd_daemon_stop_dead_pid_skips_sigterm():
    """When the recorded PID is dead, the liveness probe short-circuits and
    SIGTERM is NEVER delivered (PID-reuse guard)."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result), \
         patch("builtins.open", mock_open(read_data="12345\n")), \
         patch("worca.utils.beads.os.kill", side_effect=ProcessLookupError) as mock_kill:
        result = bd_daemon_stop("/tmp/beads")
    assert result is False
    # Only the liveness probe runs; no SIGTERM delivered to a possibly
    # reused PID.
    mock_kill.assert_called_once_with(12345, 0)


def test_bd_daemon_stop_permission_error_skips_sigterm():
    """When the PID is alive but owned by another user (PermissionError on
    the liveness probe), give up rather than blindly SIGTERM."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result), \
         patch("builtins.open", mock_open(read_data="42\n")), \
         patch("worca.utils.beads.os.kill", side_effect=PermissionError) as mock_kill:
        result = bd_daemon_stop("/tmp/beads")
    assert result is False
    mock_kill.assert_called_once_with(42, 0)


def test_bd_daemon_stop_oserror_swallowed():
    """Phase 1 raises OSError (bd not on PATH), liveness probe also raises
    OSError — function returns False without crashing."""
    with patch("worca.utils.beads.subprocess.run", side_effect=OSError("bd not found")), \
         patch("builtins.open", mock_open(read_data="7777\n")), \
         patch("worca.utils.beads.os.kill", side_effect=OSError("operation not permitted")):
        result = bd_daemon_stop("/tmp/beads")
    assert result is False


def test_bd_daemon_stop_corrupt_pidfile():
    """subprocess fails, pidfile has non-integer content — ValueError swallowed, returns False."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result), \
         patch("builtins.open", mock_open(read_data="not-a-pid\n")), \
         patch("worca.utils.beads.os.kill") as mock_kill:
        result = bd_daemon_stop("/tmp/beads")
    assert result is False
    mock_kill.assert_not_called()


def test_bd_daemon_stop_waits_for_exit_after_sigterm():
    """After SIGTERM, the helper polls for the daemon to actually exit so
    the caller (e.g. remove_pipeline_worktree) doesn't race FD release."""
    mock_result = MagicMock()
    mock_result.returncode = 1  # phase 1 fails → fall through to SIGTERM
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result), \
         patch("builtins.open", mock_open(read_data="5555\n")), \
         patch("worca.utils.beads.os.kill"), \
         patch("worca.utils.beads._wait_for_pid_exit", return_value=True) as mock_wait:
        result = bd_daemon_stop("/tmp/beads")
    assert result is True
    mock_wait.assert_called_once_with(5555)


# --- _wait_for_pid_exit ---


def test_wait_for_pid_exit_returns_true_when_process_dies():
    """ProcessLookupError on probe → process exited → True."""
    with patch("worca.utils.beads.os.kill", side_effect=ProcessLookupError), \
         patch("worca.utils.beads.time.sleep"):
        assert _wait_for_pid_exit(123) is True


def test_wait_for_pid_exit_returns_false_when_process_persists():
    """Probe always succeeds → process never exits within budget → False."""
    with patch("worca.utils.beads.os.kill", return_value=None), \
         patch("worca.utils.beads.time.sleep"):
        assert _wait_for_pid_exit(123) is False


def test_wait_for_pid_exit_treats_permission_error_as_exited():
    """If the PID is reused mid-poll and we lose permission to probe it,
    treat it as gone (the daemon we cared about is no longer there)."""
    with patch("worca.utils.beads.os.kill", side_effect=PermissionError), \
         patch("worca.utils.beads.time.sleep"):
        assert _wait_for_pid_exit(123) is True


# --- bd_daemon_stop sentinel ---


def test_bd_daemon_stop_writes_sentinel_on_phase1_success(tmp_path):
    """Successful bd daemon stop writes a sentinel so ensure() won't restart."""
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)

    mock_result = MagicMock(returncode=0)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_daemon_stop(beads_dir) is True

    assert os.path.exists(os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL))


def test_bd_daemon_stop_writes_sentinel_on_sigterm_success(tmp_path):
    """Sentinel is also written when phase 2 (SIGTERM fallback) succeeds."""
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)

    mock_result = MagicMock(returncode=1)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result), \
         patch("builtins.open", mock_open(read_data="5555\n")), \
         patch("worca.utils.beads.os.kill"), \
         patch("worca.utils.beads._wait_for_pid_exit", return_value=True):
        assert bd_daemon_stop(beads_dir) is True

    assert os.path.exists(os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL))


def test_bd_daemon_stop_no_sentinel_on_failure(tmp_path):
    """When stop fails entirely, no sentinel is written."""
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)

    mock_result = MagicMock(returncode=1)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result), \
         patch("builtins.open", side_effect=FileNotFoundError):
        assert bd_daemon_stop(beads_dir) is False

    assert not os.path.exists(os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL))


# --- bd_daemon_status ---


def test_bd_daemon_status_running():
    mock_result = MagicMock(returncode=0)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_daemon_status("/tmp/beads") is True


def test_bd_daemon_status_not_running():
    mock_result = MagicMock(returncode=1)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_daemon_status("/tmp/beads") is False


def test_bd_daemon_status_timeout():
    with patch("worca.utils.beads.subprocess.run",
               side_effect=subprocess.TimeoutExpired(cmd="bd", timeout=5.0)):
        assert bd_daemon_status("/tmp/beads") is None


def test_bd_daemon_status_oserror():
    with patch("worca.utils.beads.subprocess.run",
               side_effect=OSError("bd not found")):
        assert bd_daemon_status("/tmp/beads") is None


def test_bd_daemon_status_uses_workspace_cwd():
    """cwd must be the workspace root (parent of beads_dir) so bd resolves
    the correct daemon, matching bd_daemon_stop's pattern."""
    mock_result = MagicMock(returncode=0)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result) as mock_run:
        bd_daemon_status("/tmp/beads")
    kwargs = mock_run.call_args.kwargs
    assert kwargs["cwd"] == "/tmp"
    assert kwargs["env"]["BEADS_DIR"] == "/tmp/beads"


# --- bd_daemon_start ---


def test_bd_daemon_start_success():
    mock_result = MagicMock(returncode=0)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_daemon_start("/tmp/beads") is True


def test_bd_daemon_start_failure():
    mock_result = MagicMock(returncode=1)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_daemon_start("/tmp/beads") is False


def test_bd_daemon_start_clears_sentinel(tmp_path):
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)
    sentinel = os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL)
    with open(sentinel, "w") as f:
        f.write("")
    assert os.path.exists(sentinel)

    mock_result = MagicMock(returncode=0)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        bd_daemon_start(beads_dir)
    assert not os.path.exists(sentinel)


def test_bd_daemon_start_no_sentinel_ok():
    """Works when no sentinel file exists (normal start)."""
    mock_result = MagicMock(returncode=0)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_daemon_start("/tmp/beads") is True


def test_bd_daemon_start_timeout():
    with patch("worca.utils.beads.subprocess.run",
               side_effect=subprocess.TimeoutExpired(cmd="bd", timeout=5.0)):
        assert bd_daemon_start("/tmp/beads") is False


def test_bd_daemon_start_oserror():
    with patch("worca.utils.beads.subprocess.run",
               side_effect=OSError("bd not found")):
        assert bd_daemon_start("/tmp/beads") is False


def test_bd_daemon_start_uses_workspace_cwd():
    mock_result = MagicMock(returncode=0)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result) as mock_run:
        bd_daemon_start("/tmp/beads")
    kwargs = mock_run.call_args.kwargs
    assert kwargs["cwd"] == "/tmp"
    assert kwargs["env"]["BEADS_DIR"] == "/tmp/beads"


# --- bd_daemon_ensure ---


def test_bd_daemon_ensure_already_running(tmp_path):
    """When daemon is already running, returns True without calling start."""
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)

    with patch("worca.utils.beads.bd_daemon_status", return_value=True) as mock_status, \
         patch("worca.utils.beads.bd_daemon_start") as mock_start:
        result = bd_daemon_ensure(beads_dir)
    assert result is True
    mock_status.assert_called_once_with(beads_dir)
    mock_start.assert_not_called()


def test_bd_daemon_ensure_starts_when_not_running(tmp_path):
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)

    with patch("worca.utils.beads.bd_daemon_status", return_value=False), \
         patch("worca.utils.beads.bd_daemon_start", return_value=True) as mock_start:
        result = bd_daemon_ensure(beads_dir)
    assert result is True
    mock_start.assert_called_once_with(beads_dir)


def test_bd_daemon_ensure_respects_deliberate_stop(tmp_path):
    """When sentinel exists AND daemon is not running, ensure does NOT auto-start.

    The sentinel only blocks auto-start, not auto-detect — status is still
    probed first to handle the manually-restarted-after-stop case.
    """
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)
    with open(os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL), "w") as f:
        f.write("")

    with patch("worca.utils.beads.bd_daemon_status", return_value=False) as mock_status, \
         patch("worca.utils.beads.bd_daemon_start") as mock_start:
        result = bd_daemon_ensure(beads_dir)
    assert result is False
    mock_status.assert_called_once_with(beads_dir)
    mock_start.assert_not_called()


def test_bd_daemon_ensure_ignores_sentinel_when_daemon_running(tmp_path):
    """When daemon is running, sentinel is irrelevant — return True.

    Covers the case where a user (or another tool) ran `bd daemon start`
    after a deliberate stop but the sentinel was never cleared.
    """
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)
    with open(os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL), "w") as f:
        f.write("")

    with patch("worca.utils.beads.bd_daemon_status", return_value=True), \
         patch("worca.utils.beads.bd_daemon_start") as mock_start:
        result = bd_daemon_ensure(beads_dir)
    assert result is True
    mock_start.assert_not_called()


def test_bd_daemon_ensure_status_error(tmp_path):
    """When status returns None (error), ensure returns False without starting."""
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)

    with patch("worca.utils.beads.bd_daemon_status", return_value=None), \
         patch("worca.utils.beads.bd_daemon_start") as mock_start:
        result = bd_daemon_ensure(beads_dir)
    assert result is False
    mock_start.assert_not_called()


def test_bd_daemon_ensure_start_fails(tmp_path):
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)

    with patch("worca.utils.beads.bd_daemon_status", return_value=False), \
         patch("worca.utils.beads.bd_daemon_start", return_value=False):
        result = bd_daemon_ensure(beads_dir)
    assert result is False


# --- bd_daemon lifecycle invariant ---


def test_bd_daemon_ensure_does_not_restart_after_deliberate_stop(tmp_path):
    """The critical invariant: after bd_daemon_stop succeeds, bd_daemon_ensure
    must NOT restart the daemon. This interaction with worktree cleanup is the
    trickiest behavior and most likely to silently regress.

    Sequence: stop (succeeds) → ensure → daemon must NOT be restarted.
    Status is probed first (one subprocess call), then sentinel blocks start.
    """
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)

    # Step 1: Stop the daemon successfully
    mock_stop_ok = MagicMock(returncode=0)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_stop_ok):
        stopped = bd_daemon_stop(beads_dir)
    assert stopped is True

    # Sentinel must be present
    sentinel = os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL)
    assert os.path.exists(sentinel), "bd_daemon_stop must write sentinel"

    # Step 2: Ensure must NOT restart. Status probe runs (returncode=1 since
    # daemon is down); sentinel then blocks the start subprocess.
    mock_status_down = MagicMock(returncode=1)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_status_down) as mock_run:
        result = bd_daemon_ensure(beads_dir)
    assert result is False, "ensure must not restart after deliberate stop"
    # Exactly one call: bd daemon status. No bd daemon start.
    assert mock_run.call_count == 1
    assert mock_run.call_args.args[0] == ["bd", "daemon", "status"]


def test_bd_daemon_start_after_stop_reenables_ensure(tmp_path):
    """Full lifecycle: stop → ensure (blocked) → explicit start → ensure (works).

    Verifies that bd_daemon_start clears the sentinel so subsequent ensure()
    calls resume normal behavior."""
    beads_dir = str(tmp_path / ".beads")
    os.makedirs(beads_dir)
    sentinel = os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL)

    mock_ok = MagicMock(returncode=0)

    # Stop → writes sentinel
    with patch("worca.utils.beads.subprocess.run", return_value=mock_ok):
        bd_daemon_stop(beads_dir)
    assert os.path.exists(sentinel)

    # Ensure → status probe runs (daemon down), sentinel blocks start
    mock_status_down = MagicMock(returncode=1)
    with patch("worca.utils.beads.subprocess.run", return_value=mock_status_down) as mock_run:
        assert bd_daemon_ensure(beads_dir) is False
    assert mock_run.call_count == 1
    assert mock_run.call_args.args[0] == ["bd", "daemon", "status"]

    # Explicit start → clears sentinel
    with patch("worca.utils.beads.subprocess.run", return_value=mock_ok):
        bd_daemon_start(beads_dir)
    assert not os.path.exists(sentinel)

    # Ensure → now works (delegates to status + start)
    with patch("worca.utils.beads.bd_daemon_status", return_value=False), \
         patch("worca.utils.beads.bd_daemon_start", return_value=True):
        assert bd_daemon_ensure(beads_dir) is True


# --- bd_get_effort_label ---


def _bd_show_output_with_labels(labels_str: str) -> str:
    return (
        "○ worca-cc-xyz · Implement feature   [● P2 · OPEN]\n"
        "\n"
        "DESCRIPTION\n"
        "Some description.\n"
        "\n"
        f"LABELS: {labels_str}\n"
        "\n"
        "DEPENDENCIES\n"
        "  (none)\n"
    )


def test_bd_get_effort_label_parses_label():
    """Returns the effort level for a bead with a valid worca-effort label."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = _bd_show_output_with_labels("run:abc123, worca-effort:high")
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_get_effort_label("worca-cc-xyz") == "high"


def test_bd_get_effort_label_all_valid_levels():
    """Every canonical effort level is accepted."""
    for level in ("low", "medium", "high", "xhigh", "max"):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = _bd_show_output_with_labels(f"worca-effort:{level}")
        with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
            assert bd_get_effort_label("bead-1") == level


def test_bd_get_effort_label_invalid_returns_none():
    """Returns None when the worca-effort label has an unrecognized level."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = _bd_show_output_with_labels("worca-effort:bogus")
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_get_effort_label("bead-1") is None


def test_bd_get_effort_label_missing_returns_none():
    """Returns None when no worca-effort label exists."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = _bd_show_output_with_labels("run:abc123, area:cc")
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_get_effort_label("bead-1") is None


def test_bd_get_effort_label_no_labels_section():
    """Returns None when bd show output has no LABELS line."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = (
        "○ worca-cc-xyz · Task   [● P2 · OPEN]\n"
        "\n"
        "DESCRIPTION\n"
        "No labels here.\n"
        "\n"
        "DEPENDENCIES\n"
        "  (none)\n"
    )
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_get_effort_label("worca-cc-xyz") is None


def test_bd_get_effort_label_bd_show_fails():
    """Returns None when bd show fails (non-zero exit)."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stderr = "Error: not found"
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_get_effort_label("nonexistent") is None


def test_bd_get_effort_label_only_first_effort_label():
    """When multiple worca-effort labels exist, returns the first valid one."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = _bd_show_output_with_labels(
        "worca-effort:medium, worca-effort:high"
    )
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        assert bd_get_effort_label("bead-1") == "medium"
