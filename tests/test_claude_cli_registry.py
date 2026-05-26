"""Tests for claude_cli ↔ proc_registry integration.

Covers run_agent's record/remove of spawned process groups, _reap_returncode's
killpg escalation, and terminate_all. These live in tests/ (not alongside the
source module) so CI's ``pytest tests/`` actually collects them.
"""

import io
import json
import os
import signal
import subprocess
from unittest import mock

import pytest

from worca.utils.claude_cli import run_agent, terminate_all

pytestmark = pytest.mark.skipif(
    os.name != "posix",
    reason="Mocks os.getpgid/os.killpg which do not exist on Windows",
)


# ---------------------------------------------------------------------------
# Registry integration in run_agent
# ---------------------------------------------------------------------------

class TestRunAgentRegistry:
    """Verify that run_agent records/removes spawns via proc_registry."""

    def _mock_popen(self, events, returncode=0, pid=12345):
        ndjson = "".join(json.dumps(e) + "\n" for e in events)
        mock_proc = mock.MagicMock()
        mock_proc.stdout = io.StringIO(ndjson)
        mock_proc.stderr = io.StringIO("")
        mock_proc.returncode = returncode
        mock_proc.pid = pid
        mock_proc.wait.return_value = returncode
        return mock_proc

    @mock.patch("worca.utils.claude_cli._resolve_tool_args", return_value=([], "default"))
    @mock.patch("worca.utils.claude_cli.get_env", return_value={})
    @mock.patch("os.getpgid", return_value=9999)
    @mock.patch("subprocess.Popen")
    def test_records_spawn_on_start(self, mock_popen_cls, mock_getpgid, mock_env, _mock_resolve, tmp_path):
        """When run_dir/stage/iteration are provided, record_spawn is called after Popen."""
        events = [{"type": "result", "subtype": "success", "result": "ok"}]
        mock_popen_cls.return_value = self._mock_popen(events)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        with mock.patch("worca.utils.claude_cli.record_spawn") as mock_record, \
             mock.patch("worca.utils.claude_cli.remove_spawn"):
            run_agent(
                prompt="hello", agent="agent.md",
                run_dir=run_dir, stage="implement", iteration=3,
            )
            mock_record.assert_called_once()
            call_kwargs = mock_record.call_args
            assert call_kwargs[0][0] == os.path.join(run_dir, "procs")
            assert call_kwargs[1]["pgid"] == 9999
            assert call_kwargs[1]["pid"] == 12345
            assert call_kwargs[1]["stage"] == "implement"
            assert call_kwargs[1]["iteration"] == 3

    @mock.patch("worca.utils.claude_cli._resolve_tool_args", return_value=([], "default"))
    @mock.patch("worca.utils.claude_cli.get_env", return_value={})
    @mock.patch("os.getpgid", return_value=9999)
    @mock.patch("subprocess.Popen")
    def test_removes_spawn_on_clean_exit(self, mock_popen_cls, mock_getpgid, mock_env, _mock_resolve, tmp_path):
        """On successful completion, remove_spawn is called in finally."""
        events = [{"type": "result", "subtype": "success", "result": "ok"}]
        mock_popen_cls.return_value = self._mock_popen(events)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        with mock.patch("worca.utils.claude_cli.record_spawn"), \
             mock.patch("worca.utils.claude_cli.remove_spawn") as mock_remove:
            run_agent(
                prompt="hello", agent="agent.md",
                run_dir=run_dir, stage="implement", iteration=1,
            )
            mock_remove.assert_called_once()
            call_kwargs = mock_remove.call_args
            assert call_kwargs[0][0] == os.path.join(run_dir, "procs")
            assert call_kwargs[1]["pgid"] == 9999

    @mock.patch("worca.utils.claude_cli._resolve_tool_args", return_value=([], "default"))
    @mock.patch("worca.utils.claude_cli.get_env", return_value={})
    @mock.patch("os.getpgid", return_value=9999)
    @mock.patch("subprocess.Popen")
    def test_removes_spawn_on_failure(self, mock_popen_cls, mock_getpgid, mock_env, _mock_resolve, tmp_path):
        """On failure, remove_spawn is still called (in finally)."""
        events = [{"type": "result", "subtype": "error", "result": "fail"}]
        mock_popen_cls.return_value = self._mock_popen(events, returncode=1)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        with mock.patch("worca.utils.claude_cli.record_spawn"), \
             mock.patch("worca.utils.claude_cli.remove_spawn") as mock_remove:
            with pytest.raises(RuntimeError):
                run_agent(
                    prompt="hello", agent="agent.md",
                    run_dir=run_dir, stage="test", iteration=2,
                )
            mock_remove.assert_called_once()

    @mock.patch("worca.utils.claude_cli._resolve_tool_args", return_value=([], "default"))
    @mock.patch("worca.utils.claude_cli.get_env", return_value={})
    @mock.patch("subprocess.Popen")
    def test_no_registry_without_run_dir(self, mock_popen_cls, mock_env, _mock_resolve):
        """When run_dir is not provided, no registry calls are made."""
        events = [{"type": "result", "subtype": "success", "result": "ok"}]
        mock_popen_cls.return_value = self._mock_popen(events)

        with mock.patch("worca.utils.claude_cli.record_spawn") as mock_record, \
             mock.patch("worca.utils.claude_cli.remove_spawn") as mock_remove:
            run_agent(prompt="hello", agent="agent.md")
            mock_record.assert_not_called()
            mock_remove.assert_not_called()

    @mock.patch("worca.utils.claude_cli._resolve_tool_args", return_value=([], "default"))
    @mock.patch("worca.utils.claude_cli.get_env", return_value={})
    @mock.patch("os.getpgid", return_value=9999)
    @mock.patch("subprocess.Popen")
    def test_no_agent_pid_file_when_registry_used(self, mock_popen_cls, mock_getpgid, mock_env, _mock_resolve, tmp_path):
        """When run_dir is provided, the old agent.pid file is NOT written."""
        events = [{"type": "result", "subtype": "success", "result": "ok"}]
        mock_popen_cls.return_value = self._mock_popen(events)
        run_dir = str(tmp_path / "run")
        log_path = os.path.join(run_dir, "logs", "test.log")

        with mock.patch("worca.utils.claude_cli.record_spawn"), \
             mock.patch("worca.utils.claude_cli.remove_spawn"):
            run_agent(
                prompt="hello", agent="agent.md",
                log_path=log_path,
                run_dir=run_dir, stage="implement", iteration=1,
            )
        assert not os.path.exists(os.path.join(run_dir, "agent.pid"))


# ---------------------------------------------------------------------------
# _reap_returncode escalation to killpg
# ---------------------------------------------------------------------------

class TestReapReturncode:
    def test_escalates_to_killpg_on_timeout(self):
        """_reap_returncode uses killpg (not proc.kill) when wait times out."""
        from worca.utils.claude_cli import _reap_returncode

        mock_proc = mock.MagicMock()
        mock_proc.wait.side_effect = [subprocess.TimeoutExpired("cmd", 2), None]
        mock_proc.returncode = -9
        mock_proc.pid = 42

        with mock.patch("os.getpgid", return_value=42), \
             mock.patch("os.killpg") as mock_killpg:
            _reap_returncode(mock_proc)
            mock_killpg.assert_called_once_with(42, signal.SIGKILL)
            mock_proc.kill.assert_not_called()

    def test_falls_back_to_proc_kill_if_killpg_fails(self):
        """If killpg fails (e.g. process not a group leader), falls back to proc.kill."""
        from worca.utils.claude_cli import _reap_returncode

        mock_proc = mock.MagicMock()
        mock_proc.wait.side_effect = [subprocess.TimeoutExpired("cmd", 2), None]
        mock_proc.returncode = -9
        mock_proc.pid = 42

        with mock.patch("os.getpgid", return_value=42), \
             mock.patch("os.killpg", side_effect=OSError("no such group")):
            _reap_returncode(mock_proc)
            mock_proc.kill.assert_called_once()


# ---------------------------------------------------------------------------
# terminate_all
# ---------------------------------------------------------------------------

class TestTerminateAll:
    def test_delegates_to_kill_all_tracked(self, tmp_path):
        """terminate_all(run_dir) calls kill_all_tracked with procs_dir."""
        run_dir = str(tmp_path / "run")
        with mock.patch("worca.utils.claude_cli.kill_all_tracked", return_value=2) as mock_kill:
            count = terminate_all(run_dir)
            mock_kill.assert_called_once_with(os.path.join(run_dir, "procs"))
            assert count == 2

    def test_also_kills_current_proc(self):
        """terminate_all kills _current_proc via terminate_current too."""
        import worca.utils.claude_cli as cli
        mock_proc = mock.MagicMock()
        mock_proc.pid = 123
        with cli._proc_lock:
            cli._current_proc = mock_proc
        try:
            with mock.patch("worca.utils.claude_cli.kill_all_tracked", return_value=0), \
                 mock.patch("os.killpg") as mock_killpg, \
                 mock.patch("os.getpgid", return_value=999):
                terminate_all(str("/tmp/fake-run"))
                mock_killpg.assert_called_once_with(999, signal.SIGTERM)
        finally:
            with cli._proc_lock:
                cli._current_proc = None
