"""Tests for worca.utils.beads - bd CLI wrapper."""

import os
import signal
import subprocess
from unittest.mock import patch, MagicMock, mock_open

from worca.utils.beads import bd_create, bd_ready, bd_show, bd_close, bd_update, bd_dep_add, bd_daemon_stop


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

def test_bd_daemon_stop_success():
    """bd daemon stop succeeds within timeout — returns True, no pidfile needed."""
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.beads.subprocess.run", return_value=mock_result):
        result = bd_daemon_stop("/tmp/beads")
    assert result is True


def test_bd_daemon_stop_timeout_sigterm_fallback():
    """subprocess times out → falls back to SIGTERM from pidfile → returns True."""
    with (
        patch("worca.utils.beads.subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="bd", timeout=2.0)),
        patch("builtins.open", mock_open(read_data="9999\n")),
        patch("worca.utils.beads.os.kill") as mock_kill,
    ):
        result = bd_daemon_stop("/tmp/beads")
    assert result is True
    mock_kill.assert_called_once_with(9999, signal.SIGTERM)


def test_bd_daemon_stop_no_pidfile():
    """subprocess fails, pidfile absent — returns False, error is swallowed."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    with (
        patch("worca.utils.beads.subprocess.run", return_value=mock_result),
        patch("builtins.open", side_effect=FileNotFoundError),
    ):
        result = bd_daemon_stop("/tmp/beads")
    assert result is False


def test_bd_daemon_stop_dead_pid():
    """subprocess fails, pidfile has a dead PID — os.kill raises ProcessLookupError, returns False."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    with (
        patch("worca.utils.beads.subprocess.run", return_value=mock_result),
        patch("builtins.open", mock_open(read_data="12345\n")),
        patch("worca.utils.beads.os.kill", side_effect=ProcessLookupError),
    ):
        result = bd_daemon_stop("/tmp/beads")
    assert result is False


def test_bd_daemon_stop_oserror_swallowed():
    """subprocess raises OSError (e.g. bd not on PATH), pidfile SIGTERM also fails — returns False."""
    with (
        patch("worca.utils.beads.subprocess.run", side_effect=OSError("bd not found")),
        patch("builtins.open", mock_open(read_data="7777\n")),
        patch("worca.utils.beads.os.kill", side_effect=OSError("permission denied")),
    ):
        result = bd_daemon_stop("/tmp/beads")
    assert result is False


def test_bd_daemon_stop_corrupt_pidfile():
    """subprocess fails, pidfile has non-integer content — ValueError swallowed, returns False."""
    mock_result = MagicMock()
    mock_result.returncode = 1
    with (
        patch("worca.utils.beads.subprocess.run", return_value=mock_result),
        patch("builtins.open", mock_open(read_data="not-a-pid\n")),
        patch("worca.utils.beads.os.kill") as mock_kill,
    ):
        result = bd_daemon_stop("/tmp/beads")
    assert result is False
    mock_kill.assert_not_called()
