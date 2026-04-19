"""Tests for agent.pid file writing and cleanup in run_agent()."""

import json
import os
from unittest.mock import patch, MagicMock

from worca.utils.claude_cli import run_agent


def _make_mock_popen(result_event, returncode=0, pid=12345):
    mock_proc = MagicMock()
    mock_proc.returncode = returncode
    mock_proc.pid = pid
    result_line = json.dumps({"type": "result", **result_event})
    mock_proc.stdout = iter([result_line + "\n"])
    mock_proc.stderr = iter([])
    mock_proc.wait.return_value = returncode
    return mock_proc


def test_agent_pid_written_when_log_path_provided(tmp_path):
    log_path = str(tmp_path / "agent.log")
    mock_proc = _make_mock_popen({"ok": True}, pid=42)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        run_agent("prompt", agent="planner", log_path=log_path)
    pid_path = str(tmp_path / "agent.pid")
    assert not os.path.exists(pid_path), "agent.pid should be cleaned up after run"


def test_agent_pid_contains_correct_pid(tmp_path):
    log_path = str(tmp_path / "agent.log")
    pid_written = []

    original_open = open

    def capture_pid_write(path, mode="r", *args, **kwargs):
        f = original_open(path, mode, *args, **kwargs)
        if str(path).endswith("agent.pid") and "w" in mode:
            original_write = f.write
            def tracking_write(data):
                pid_written.append(data)
                return original_write(data)
            f.write = tracking_write
        return f

    mock_proc = _make_mock_popen({"ok": True}, pid=9999)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        with patch("builtins.open", side_effect=capture_pid_write):
            run_agent("prompt", agent="planner", log_path=log_path)

    assert "9999" in pid_written, f"agent.pid should contain proc.pid, got {pid_written}"


def test_agent_pid_not_written_without_log_path(tmp_path):
    mock_proc = _make_mock_popen({"ok": True}, pid=42)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        run_agent("prompt", agent="planner")
    assert not os.path.exists(tmp_path / "agent.pid")


def test_agent_pid_cleaned_up_on_success(tmp_path):
    log_path = str(tmp_path / "agent.log")
    mock_proc = _make_mock_popen({"ok": True}, pid=42)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        run_agent("prompt", agent="planner", log_path=log_path)
    pid_path = str(tmp_path / "agent.pid")
    assert not os.path.exists(pid_path), "agent.pid must be removed in finally block"


def test_agent_pid_cleaned_up_on_error(tmp_path):
    log_path = str(tmp_path / "agent.log")
    mock_proc = _make_mock_popen({"result": "failed"}, returncode=1, pid=42)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        try:
            run_agent("prompt", agent="planner", log_path=log_path)
        except RuntimeError:
            pass
    pid_path = str(tmp_path / "agent.pid")
    assert not os.path.exists(pid_path), "agent.pid must be removed even on error"
