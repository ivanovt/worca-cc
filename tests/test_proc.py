"""Tests for src/worca/utils/proc.py — pid_is_alive() helper.

Also verifies that all caller sites (runner, registry, beads) route through
pid_is_alive and never call os.kill(pid, 0) directly.
"""

import os
import signal
import unittest.mock

import pytest

from worca.utils.proc import pid_is_alive


# ---------------------------------------------------------------------------
# POSIX path (default on macOS/Linux)
# ---------------------------------------------------------------------------

class TestPidIsAlivePosix:
    """Tests that run on the real POSIX path (os.name == 'posix')."""

    @pytest.fixture(autouse=True)
    def _require_posix(self):
        if os.name != "posix":
            pytest.skip("POSIX-only test")

    def test_current_process_is_alive(self):
        assert pid_is_alive(os.getpid()) is True

    def test_nonexistent_pid_is_not_alive(self):
        assert pid_is_alive(99999999) is False

    def test_permission_error_re_raised(self):
        """PermissionError means the process exists but we can't signal it."""
        with unittest.mock.patch("os.kill", side_effect=PermissionError("eperm")):
            with pytest.raises(PermissionError):
                pid_is_alive(1)

    def test_negative_pid_returns_false(self):
        assert pid_is_alive(-1) is False

    def test_zero_pid_returns_false(self):
        assert pid_is_alive(0) is False


# ---------------------------------------------------------------------------
# Windows path (monkeypatched — asserts os.kill is NEVER called)
# ---------------------------------------------------------------------------

class TestPidIsAliveWindows:
    """Monkeypatch os.name to 'nt' and verify the ctypes-based path."""

    @pytest.fixture(autouse=True)
    def _patch_nt(self, monkeypatch):
        monkeypatch.setattr("os.name", "nt")
        # Prevent any accidental os.kill call — it would be destructive on
        # real Windows and must never be reached.
        monkeypatch.setattr(
            "os.kill",
            unittest.mock.Mock(side_effect=AssertionError("os.kill must not be called on Windows")),
        )

    def test_alive_process_returns_true(self, monkeypatch):
        """Simulate a live process via fake ctypes handles."""
        fake_kernel32 = _FakeKernel32(open_handle=42, wait_result=_WAIT_TIMEOUT)
        monkeypatch.setattr("worca.utils.proc._win_pid_is_alive", _make_win_stub(fake_kernel32))
        assert pid_is_alive(1234) is True
        assert fake_kernel32.close_called

    def test_dead_process_returns_false(self, monkeypatch):
        """OpenProcess returns NULL → process does not exist."""
        fake_kernel32 = _FakeKernel32(open_handle=0, wait_result=0)
        monkeypatch.setattr("worca.utils.proc._win_pid_is_alive", _make_win_stub(fake_kernel32))
        assert pid_is_alive(1234) is False

    def test_exited_process_returns_false(self, monkeypatch):
        """WaitForSingleObject returns WAIT_OBJECT_0 → process already exited."""
        fake_kernel32 = _FakeKernel32(open_handle=42, wait_result=_WAIT_OBJECT_0)
        monkeypatch.setattr("worca.utils.proc._win_pid_is_alive", _make_win_stub(fake_kernel32))
        assert pid_is_alive(1234) is False
        assert fake_kernel32.close_called

    def test_os_kill_never_called(self, monkeypatch):
        """Even on a valid PID, os.kill must not be invoked."""
        fake_kernel32 = _FakeKernel32(open_handle=42, wait_result=_WAIT_TIMEOUT)
        monkeypatch.setattr("worca.utils.proc._win_pid_is_alive", _make_win_stub(fake_kernel32))
        pid_is_alive(1234)
        os.kill.assert_not_called()

    def test_negative_pid_returns_false(self):
        assert pid_is_alive(-1) is False

    def test_zero_pid_returns_false(self):
        assert pid_is_alive(0) is False


# ---------------------------------------------------------------------------
# Helpers for faking the Windows ctypes path
# ---------------------------------------------------------------------------

_WAIT_OBJECT_0 = 0x00000000
_WAIT_TIMEOUT = 0x00000102


class _FakeKernel32:
    def __init__(self, *, open_handle: int, wait_result: int):
        self.open_handle = open_handle
        self.wait_result = wait_result
        self.close_called = False

    def OpenProcess(self, access, inherit, pid):  # noqa: N802
        return self.open_handle

    def WaitForSingleObject(self, handle, timeout):  # noqa: N802
        return self.wait_result

    def CloseHandle(self, handle):  # noqa: N802
        self.close_called = True
        return 1


def _make_win_stub(fake_kernel32: _FakeKernel32):
    """Return a callable matching the _win_pid_is_alive(pid) signature."""

    def _stub(pid: int) -> bool:
        handle = fake_kernel32.OpenProcess(0x00100000, False, pid)
        if not handle:
            return False
        try:
            result = fake_kernel32.WaitForSingleObject(handle, 0)
            return result == _WAIT_TIMEOUT
        finally:
            fake_kernel32.CloseHandle(handle)
            fake_kernel32.close_called = True

    return _stub


# ---------------------------------------------------------------------------
# Caller-integration: verify each call-site routes through pid_is_alive
# ---------------------------------------------------------------------------

class TestCallerRoutingRunner:
    """runner._clear_stale_daemon_lock must use pid_is_alive, never os.kill."""

    def test_runner_routes_through_pid_is_alive(self, tmp_path):
        from worca.orchestrator import runner

        beads_dir = tmp_path / ".beads"
        beads_dir.mkdir()
        (beads_dir / "daemon.pid").write_text("12345\n")
        (beads_dir / "daemon.lock").write_text("")

        with unittest.mock.patch("worca.orchestrator.runner.pid_is_alive", return_value=True) as mock_alive, \
             unittest.mock.patch("worca.orchestrator.runner.os.kill",
                                 side_effect=AssertionError("os.kill must not be called")) as mock_kill:
            runner._clear_stale_daemon_lock(str(beads_dir))

        mock_alive.assert_called_once_with(12345)
        mock_kill.assert_not_called()


class TestCallerRoutingRegistry:
    """registry.reconcile_stale must use pid_is_alive, never os.kill."""

    def test_registry_routes_through_pid_is_alive(self, tmp_path):
        from worca.orchestrator.registry import register_pipeline, reconcile_stale

        base = str(tmp_path / ".worca")
        register_pipeline("run-probe", "/tmp/wt", "Probe", 12345, base=base)

        with unittest.mock.patch("worca.orchestrator.registry.pid_is_alive", return_value=True) as mock_alive, \
             unittest.mock.patch("worca.orchestrator.registry.os.kill",
                                 side_effect=AssertionError("os.kill must not be called")) as mock_kill:
            reconcile_stale(base=base)

        mock_alive.assert_called_once_with(12345)
        mock_kill.assert_not_called()


class TestCallerRoutingBeadsWaitPid:
    """beads._wait_for_pid_exit must use pid_is_alive, never os.kill."""

    def test_wait_for_pid_exit_routes_through_pid_is_alive(self):
        from worca.utils.beads import _wait_for_pid_exit

        with unittest.mock.patch("worca.utils.beads.pid_is_alive", return_value=False) as mock_alive, \
             unittest.mock.patch("worca.utils.beads.os.kill",
                                 side_effect=AssertionError("os.kill must not be called")) as mock_kill, \
             unittest.mock.patch("time.sleep"):
            result = _wait_for_pid_exit(9999)

        assert result is True
        mock_alive.assert_called_with(9999)
        mock_kill.assert_not_called()


class TestCallerRoutingBeadsDaemonStop:
    """beads.bd_daemon_stop must use pid_is_alive, never os.kill(pid, 0)."""

    def test_daemon_stop_routes_through_pid_is_alive(self, tmp_path):
        from worca.utils.beads import bd_daemon_stop

        beads_dir = tmp_path / ".beads"
        beads_dir.mkdir()
        (beads_dir / "daemon.pid").write_text("7777\n")

        with unittest.mock.patch("worca.utils.beads.pid_is_alive", return_value=True) as mock_alive, \
             unittest.mock.patch("os.kill") as mock_kill, \
             unittest.mock.patch("worca.utils.beads._wait_for_pid_exit", return_value=True):
            bd_daemon_stop(str(beads_dir))

        mock_alive.assert_called_with(7777)
        # os.kill should only be called for SIGTERM delivery, never with signal 0
        for call in mock_kill.call_args_list:
            assert call[0][1] != 0, "os.kill(pid, 0) must never be called — use pid_is_alive"


# ---------------------------------------------------------------------------
# Signal handler resilience (Bucket B)
# ---------------------------------------------------------------------------

class TestSignalHandlerResilience:
    """_install_signal_handlers must not crash when signal.signal raises."""

    def test_install_tolerates_value_error(self):
        from worca.orchestrator import runner

        with unittest.mock.patch.object(signal, "signal", side_effect=ValueError("not main thread")):
            runner._install_signal_handlers()

    def test_install_tolerates_os_error(self):
        from worca.orchestrator import runner

        with unittest.mock.patch.object(signal, "signal", side_effect=OSError("restricted")):
            runner._install_signal_handlers()

    def test_restore_tolerates_value_error(self):
        from worca.orchestrator import runner

        with unittest.mock.patch.object(signal, "signal", side_effect=ValueError("not main thread")):
            runner._restore_signal_handlers()

    def test_restore_tolerates_os_error(self):
        from worca.orchestrator import runner

        with unittest.mock.patch.object(signal, "signal", side_effect=OSError("restricted")):
            runner._restore_signal_handlers()


# ---------------------------------------------------------------------------
# Bucket C — process-group guards (source-level verification)
# ---------------------------------------------------------------------------

class TestProcGroupGuards:
    """Every os.getpgid/os.killpg call must be behind _HAS_PROC_GROUPS."""

    @staticmethod
    def _guarded_calls(source_lines):
        """Return os.getpgid/os.killpg line numbers NOT inside a _HAS_PROC_GROUPS guard.

        Recognises two guard patterns:
        - ``if _HAS_PROC_GROUPS:`` block (indent-scoped)
        - ``if not _HAS_PROC_GROUPS:`` followed by ``return``/``continue`` on the
          same or next line (early-exit — rest of the function is guarded)
        """
        import re
        unguarded = []
        in_block_guard = False
        block_guard_indent = 0
        func_guarded = False
        pending_not_guard = False
        for i, line in enumerate(source_lines, 1):
            stripped = line.rstrip()
            lstripped = stripped.lstrip()
            curr_indent = len(line) - len(line.lstrip())
            if re.match(r"\s*def ", line):
                func_guarded = False
                pending_not_guard = False
            if pending_not_guard:
                pending_not_guard = False
                if re.search(r"\breturn\b|\bcontinue\b", lstripped):
                    func_guarded = True
            if re.search(r"if\s+not\s+_HAS_PROC_GROUPS\s*:", stripped):
                if re.search(r"\breturn\b|\bcontinue\b", stripped):
                    func_guarded = True
                else:
                    pending_not_guard = True
            if "_HAS_PROC_GROUPS" in stripped and "if" in stripped and \
               "not _HAS_PROC_GROUPS" not in stripped:
                in_block_guard = True
                block_guard_indent = curr_indent
            elif in_block_guard:
                if stripped and curr_indent <= block_guard_indent and "else" not in stripped:
                    in_block_guard = False
            if lstripped.startswith("#"):
                continue
            if re.search(r"os\.(getpgid|killpg)\(", stripped):
                if not in_block_guard and not func_guarded:
                    unguarded.append((i, stripped.strip()))
        return unguarded

    def test_proc_registry_all_guarded(self):
        import inspect
        from worca.utils import proc_registry
        source = inspect.getsource(proc_registry).splitlines(keepends=True)
        unguarded = self._guarded_calls(source)
        assert unguarded == [], f"Unguarded os.getpgid/os.killpg in proc_registry: {unguarded}"

    def test_claude_cli_all_guarded(self):
        import inspect
        from worca.utils import claude_cli
        source = inspect.getsource(claude_cli).splitlines(keepends=True)
        unguarded = self._guarded_calls(source)
        assert unguarded == [], f"Unguarded os.getpgid/os.killpg in claude_cli: {unguarded}"


class TestWindowsDegradationDocstrings:
    """Module docstrings must document Windows degradation."""

    def test_proc_registry_docstring_mentions_windows(self):
        from worca.utils import proc_registry
        doc = proc_registry.__doc__ or ""
        assert "Windows" in doc, "proc_registry module docstring must mention Windows degradation"

    def test_claude_cli_docstring_mentions_windows(self):
        from worca.utils import claude_cli
        doc = claude_cli.__doc__ or ""
        assert "Windows" in doc, "claude_cli module docstring must mention Windows degradation"
