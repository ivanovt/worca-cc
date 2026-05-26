"""Tests for the mock_claude parent-death watchdog.

(a) Spawn mock_claude hang via an intermediate parent that exits → verify
    mock self-terminates within a few seconds.
(b) Spawn mock_claude succeed with a live parent → verify normal exit.

POSIX-only — the watchdog uses os.getppid() which is meaningless on Windows.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX-only watchdog")

MOCK_CLAUDE = os.path.join(os.path.dirname(__file__), "mock_claude", "mock_claude.py")


def _write_scenario(tmp_path, action, **extra):
    scenario = {"default": {"action": action, "delay_s": 0, **extra}}
    p = tmp_path / "scenario.json"
    p.write_text(json.dumps(scenario))
    return str(p)


def _is_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _spawn_orphan(scenario, tmp_path):
    """Spawn mock_claude via an intermediate parent that exits after mock starts.

    The wrapper stays alive for 2s so mock_claude can record start_ppid, then exits.
    Returns the mock_claude PID.
    """
    # The wrapper: start mock_claude, print its PID, sleep to let mock record
    # start_ppid, then exit — orphaning mock_claude.
    wrapper = (
        "import subprocess, sys, os, time; "
        f"p = subprocess.Popen("
        f"[sys.executable, {MOCK_CLAUDE!r}], "
        f"env={{**os.environ, 'MOCK_CLAUDE_SCENARIO': {scenario!r}}},"
        f"start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        f"print(p.pid, flush=True); "
        f"time.sleep(2)"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", wrapper],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    mock_pid = int(parent.stdout.readline().strip())
    parent.wait(timeout=10)
    return mock_pid


class TestWatchdogOrphanDetection:
    """When the parent exits, the hang/slow mock should self-terminate."""

    def test_hang_orphan_self_terminates(self, tmp_path):
        scenario = _write_scenario(tmp_path, "hang")
        mock_pid = _spawn_orphan(scenario, tmp_path)

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if not _is_alive(mock_pid):
                break
            time.sleep(0.5)

        assert not _is_alive(mock_pid), (
            f"mock_claude hang (pid={mock_pid}) survived after parent exit"
        )

    def test_slow_orphan_self_terminates(self, tmp_path):
        scenario = _write_scenario(tmp_path, "slow", slow_s=3600)
        mock_pid = _spawn_orphan(scenario, tmp_path)

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if not _is_alive(mock_pid):
                break
            time.sleep(0.5)

        assert not _is_alive(mock_pid), (
            f"mock_claude slow (pid={mock_pid}) survived after parent exit"
        )


class TestWatchdogLiveParent:
    """With a live parent, mock_claude should exit normally."""

    def test_succeed_normal_exit(self, tmp_path):
        scenario = _write_scenario(tmp_path, "succeed")
        env = {**os.environ, "MOCK_CLAUDE_SCENARIO": scenario}
        result = subprocess.run(
            [sys.executable, MOCK_CLAUDE],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 0
        lines = [l for l in result.stdout.strip().split("\n") if l]
        assert any('"type": "result"' in l or '"subtype": "success"' in l for l in lines)
