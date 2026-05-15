"""Tests for workspace per-target init timeout + cancel (W-047 §10.3).

Two required tests per plan:
  - test_per_target_timeout: One target hangs >timeout → marked setup_failed;
    other repos dispatch normally.
  - test_cancel_during_init: Cancel signal kills outstanding worca init
    subprocesses; tier-0 children that already dispatched are unaffected.
"""
import subprocess
import threading
from unittest.mock import patch, MagicMock


from worca.workspace.init import init_workspace_targets


class TestPerTargetTimeout:
    """Hung target → marked setup_failed after timeout; other repos dispatch normally."""

    def test_timed_out_target_marked_setup_failed(self):
        """A target that exceeds the timeout is marked setup_failed."""
        def mock_run(cmd, **kwargs):
            repo_path = kwargs.get("cwd", "")
            if "slow-repo" in repo_path:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=1)
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        repos = [
            {"name": "fast-repo", "path": "fast-repo"},
            {"name": "slow-repo", "path": "slow-repo"},
        ]

        with patch("worca.workspace.init.subprocess.run", side_effect=mock_run):
            results = init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
                timeout_seconds=1,
            )

        assert results["slow-repo"]["status"] == "setup_failed"
        assert "timeout" in results["slow-repo"]["reason"].lower()

    def test_successful_targets_marked_ready(self):
        """Targets that init within the timeout are marked ready."""
        def mock_run(cmd, **kwargs):
            repo_path = kwargs.get("cwd", "")
            if "slow-repo" in repo_path:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=1)
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        repos = [
            {"name": "fast-repo", "path": "fast-repo"},
            {"name": "slow-repo", "path": "slow-repo"},
        ]

        with patch("worca.workspace.init.subprocess.run", side_effect=mock_run):
            results = init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
                timeout_seconds=1,
            )

        assert results["fast-repo"]["status"] == "ready"
        assert results["fast-repo"]["reason"] is None

    def test_failed_init_marked_setup_failed(self):
        """A target whose init returns non-zero is marked setup_failed."""
        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=cmd, returncode=1, stdout="", stderr="init error",
            )

        repos = [{"name": "broken-repo", "path": "broken-repo"}]

        with patch("worca.workspace.init.subprocess.run", side_effect=mock_run):
            results = init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
                timeout_seconds=60,
            )

        assert results["broken-repo"]["status"] == "setup_failed"
        assert "failed" in results["broken-repo"]["reason"].lower()

    def test_other_targets_dispatched_despite_timeout(self):
        """When one target times out, all other targets still complete normally."""
        call_log = []

        def mock_run(cmd, **kwargs):
            repo_path = kwargs.get("cwd", "")
            call_log.append(repo_path)
            if "slow-repo" in repo_path:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=1)
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        repos = [
            {"name": "repo-a", "path": "repo-a"},
            {"name": "slow-repo", "path": "slow-repo"},
            {"name": "repo-b", "path": "repo-b"},
        ]

        with patch("worca.workspace.init.subprocess.run", side_effect=mock_run):
            results = init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
                timeout_seconds=1,
            )

        assert results["repo-a"]["status"] == "ready"
        assert results["repo-b"]["status"] == "ready"
        assert results["slow-repo"]["status"] == "setup_failed"
        assert len(call_log) == 3

    def test_timeout_value_passed_to_subprocess(self):
        """The configured timeout_seconds is passed to subprocess.run."""
        captured_timeouts = []

        def mock_run(cmd, **kwargs):
            captured_timeouts.append(kwargs.get("timeout"))
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        repos = [{"name": "repo", "path": "repo"}]

        with patch("worca.workspace.init.subprocess.run", side_effect=mock_run):
            init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
                timeout_seconds=42,
            )

        assert captured_timeouts == [42]

    def test_default_timeout_is_60(self):
        """When no timeout_seconds is specified, the default is 60."""
        captured_timeouts = []

        def mock_run(cmd, **kwargs):
            captured_timeouts.append(kwargs.get("timeout"))
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        repos = [{"name": "repo", "path": "repo"}]

        with patch("worca.workspace.init.subprocess.run", side_effect=mock_run):
            init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
            )

        assert captured_timeouts == [60]


class TestCancelDuringInit:
    """Cancel signal kills outstanding worca init subprocesses."""

    def test_cancel_skips_unstarted_targets(self):
        """Targets not yet started when cancel fires are marked cancelled."""
        cancel = threading.Event()

        first_call = True

        def mock_popen(cmd, **kwargs):
            nonlocal first_call
            proc = MagicMock()
            if first_call:
                first_call = False
                proc.returncode = 0
                proc.wait.return_value = None
                cancel.set()
            else:
                proc.returncode = 0
                proc.wait.return_value = None
            return proc

        repos = [
            {"name": "repo-a", "path": "repo-a"},
            {"name": "repo-b", "path": "repo-b"},
            {"name": "repo-c", "path": "repo-c"},
        ]

        with patch("worca.workspace.init.subprocess.Popen", side_effect=mock_popen):
            results = init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
                timeout_seconds=60,
                cancel_event=cancel,
                max_parallel=1,
            )

        cancelled = [r for r, v in results.items() if v["status"] == "cancelled"]
        assert len(cancelled) >= 1

    def test_cancel_does_not_affect_already_completed(self):
        """Targets that completed before cancel are still marked ready."""
        cancel = threading.Event()

        first_call = True

        def mock_popen(cmd, **kwargs):
            nonlocal first_call
            proc = MagicMock()
            if first_call:
                first_call = False
                proc.returncode = 0
                proc.wait.return_value = None
                cancel.set()
            else:
                proc.returncode = 0
                proc.wait.return_value = None
            return proc

        repos = [
            {"name": "repo-first", "path": "repo-first"},
            {"name": "repo-second", "path": "repo-second"},
        ]

        with patch("worca.workspace.init.subprocess.Popen", side_effect=mock_popen):
            results = init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
                timeout_seconds=60,
                cancel_event=cancel,
                max_parallel=1,
            )

        assert results["repo-first"]["status"] == "ready"

    def test_cancel_kills_in_flight_subprocess(self):
        """A cancel event terminates an in-flight init subprocess."""
        cancel = threading.Event()
        mock_proc = MagicMock()

        def mock_wait(timeout=None):
            cancel.set()
            raise subprocess.TimeoutExpired(cmd=[], timeout=1)

        mock_proc.wait.side_effect = mock_wait
        mock_proc.returncode = None

        def mock_popen(cmd, **kwargs):
            return mock_proc

        repos = [{"name": "repo", "path": "repo"}]

        with patch("worca.workspace.init.subprocess.Popen", side_effect=mock_popen):
            results = init_workspace_targets(
                repos=repos,
                workspace_root="/workspace",
                timeout_seconds=60,
                cancel_event=cancel,
            )

        assert results["repo"]["status"] == "cancelled"
        mock_proc.terminate.assert_called()

    def test_cancel_reason_indicates_user_cancel(self):
        """Cancelled targets have a reason indicating user cancellation."""
        cancel = threading.Event()
        cancel.set()

        repos = [{"name": "repo", "path": "repo"}]

        results = init_workspace_targets(
            repos=repos,
            workspace_root="/workspace",
            timeout_seconds=60,
            cancel_event=cancel,
        )

        assert results["repo"]["status"] == "cancelled"
        assert "cancel" in results["repo"]["reason"].lower()
