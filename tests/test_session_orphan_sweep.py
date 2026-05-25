"""Tests for the pytest_sessionfinish orphan bd-daemon sweep in conftest.py."""

import os
import signal
from unittest.mock import MagicMock, patch



class TestSweepOrphanBdDaemons:
    """Unit tests for _sweep_orphan_bd_daemons."""

    def test_kills_daemon_with_deleted_cwd(self, tmp_path):
        """A bd daemon whose cwd no longer exists gets SIGTERM'd."""
        from tests.conftest import _sweep_orphan_bd_daemons

        deleted_dir = str(tmp_path / "gone")

        with patch("tests.conftest._find_bd_daemon_pids", return_value=[99999]), \
             patch("tests.conftest._get_pid_cwd", return_value=deleted_dir), \
             patch("os.kill") as mock_kill:
            _sweep_orphan_bd_daemons(str(tmp_path))

        mock_kill.assert_called_once_with(99999, signal.SIGTERM)

    def test_kills_daemon_under_pytest_tmp_root(self, tmp_path):
        """A bd daemon whose cwd is under the pytest tmp root gets SIGTERM'd."""
        from tests.conftest import _sweep_orphan_bd_daemons

        cwd_under_tmp = str(tmp_path / "pytest-of-user" / "test_foo" / ".beads")
        os.makedirs(cwd_under_tmp, exist_ok=True)

        with patch("tests.conftest._find_bd_daemon_pids", return_value=[88888]), \
             patch("tests.conftest._get_pid_cwd", return_value=cwd_under_tmp), \
             patch("os.kill") as mock_kill:
            _sweep_orphan_bd_daemons(str(tmp_path))

        mock_kill.assert_called_once_with(88888, signal.SIGTERM)

    def test_spares_daemon_outside_tmp_root(self, tmp_path):
        """A bd daemon with a live cwd outside the tmp root is NOT killed."""
        from tests.conftest import _sweep_orphan_bd_daemons

        live_dir = "/Users/dev/real-project/.beads"

        with patch("tests.conftest._find_bd_daemon_pids", return_value=[77777]), \
             patch("tests.conftest._get_pid_cwd", return_value=live_dir), \
             patch("os.path.isdir", return_value=True), \
             patch("os.kill") as mock_kill:
            _sweep_orphan_bd_daemons(str(tmp_path))

        mock_kill.assert_not_called()

    def test_swallows_all_exceptions(self, tmp_path):
        """Errors during sweep are silently swallowed."""
        from tests.conftest import _sweep_orphan_bd_daemons

        with patch("tests.conftest._find_bd_daemon_pids", side_effect=RuntimeError("boom")):
            _sweep_orphan_bd_daemons(str(tmp_path))

    def test_handles_no_daemons(self, tmp_path):
        """No-op when no bd daemon processes exist."""
        from tests.conftest import _sweep_orphan_bd_daemons

        with patch("tests.conftest._find_bd_daemon_pids", return_value=[]), \
             patch("os.kill") as mock_kill:
            _sweep_orphan_bd_daemons(str(tmp_path))

        mock_kill.assert_not_called()

    def test_handles_kill_permission_error(self, tmp_path):
        """PermissionError from os.kill is swallowed."""
        from tests.conftest import _sweep_orphan_bd_daemons

        with patch("tests.conftest._find_bd_daemon_pids", return_value=[66666]), \
             patch("tests.conftest._get_pid_cwd", return_value=str(tmp_path / "gone")), \
             patch("os.kill", side_effect=PermissionError("not allowed")):
            _sweep_orphan_bd_daemons(str(tmp_path))

    def test_handles_cwd_lookup_failure(self, tmp_path):
        """If cwd lookup fails for a PID, that PID is skipped."""
        from tests.conftest import _sweep_orphan_bd_daemons

        with patch("tests.conftest._find_bd_daemon_pids", return_value=[55555]), \
             patch("tests.conftest._get_pid_cwd", return_value=None), \
             patch("os.kill") as mock_kill:
            _sweep_orphan_bd_daemons(str(tmp_path))

        mock_kill.assert_not_called()

    def test_multiple_daemons_mixed(self, tmp_path):
        """Multiple daemons: only orphans get killed."""
        from tests.conftest import _sweep_orphan_bd_daemons

        gone_dir = str(tmp_path / "gone")
        live_dir = "/Users/dev/real-project"

        def fake_cwd(pid):
            return gone_dir if pid == 111 else live_dir

        with patch("tests.conftest._find_bd_daemon_pids", return_value=[111, 222]), \
             patch("tests.conftest._get_pid_cwd", side_effect=fake_cwd), \
             patch("os.path.isdir", side_effect=lambda p: p == live_dir), \
             patch("os.kill") as mock_kill:
            _sweep_orphan_bd_daemons(str(tmp_path))

        mock_kill.assert_called_once_with(111, signal.SIGTERM)


class TestFindBdDaemonPids:
    """Tests for _find_bd_daemon_pids helper."""

    def test_parses_pgrep_output(self):
        from tests.conftest import _find_bd_daemon_pids

        fake_output = "12345\n67890\n"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout=fake_output,
            )
            pids = _find_bd_daemon_pids()

        assert pids == [12345, 67890]

    def test_returns_empty_on_no_match(self):
        from tests.conftest import _find_bd_daemon_pids

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="")
            pids = _find_bd_daemon_pids()

        assert pids == []

    def test_returns_empty_on_exception(self):
        from tests.conftest import _find_bd_daemon_pids

        with patch("subprocess.run", side_effect=FileNotFoundError("no pgrep")):
            pids = _find_bd_daemon_pids()

        assert pids == []


class TestGetPidCwd:
    """Tests for _get_pid_cwd helper."""

    def test_parses_lsof_output(self):
        from tests.conftest import _get_pid_cwd

        lsof_output = "p12345\ncwd\nn/some/path\n"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout=lsof_output,
            )
            cwd = _get_pid_cwd(12345)

        assert cwd == "/some/path"

    def test_returns_none_on_failure(self):
        from tests.conftest import _get_pid_cwd

        with patch("subprocess.run", side_effect=OSError("fail")):
            cwd = _get_pid_cwd(12345)

        assert cwd is None

    def test_returns_none_on_no_cwd_line(self):
        from tests.conftest import _get_pid_cwd

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="p12345\n")
            cwd = _get_pid_cwd(12345)

        assert cwd is None
