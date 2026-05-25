"""Tests for worca.utils.proc_registry — per-run process-group tracking."""

import json
import os
import time
from unittest import mock

import pytest

from worca.utils.proc_registry import (
    is_alive_and_ours,
    kill_all_tracked,
    list_spawns,
    record_spawn,
    remove_spawn,
)


@pytest.fixture()
def procs_dir(tmp_path):
    d = tmp_path / "procs"
    d.mkdir()
    return d


class TestRecordSpawn:
    def test_creates_entry_file(self, procs_dir):
        record_spawn(str(procs_dir), pgid=1234, pid=1234, stage="implement", iteration=3)
        path = procs_dir / "1234.json"
        assert path.exists()
        data = json.loads(path.read_text())
        assert data["pgid"] == 1234
        assert data["pid"] == 1234
        assert data["stage"] == "implement"
        assert data["iteration"] == 3
        assert "start_time" in data

    def test_creates_procs_dir_if_missing(self, tmp_path):
        procs_dir = str(tmp_path / "procs")
        record_spawn(procs_dir, pgid=42, pid=42, stage="test", iteration=1)
        assert os.path.isdir(procs_dir)
        assert os.path.exists(os.path.join(procs_dir, "42.json"))

    def test_overwrites_existing_entry(self, procs_dir):
        record_spawn(str(procs_dir), pgid=10, pid=10, stage="implement", iteration=1)
        record_spawn(str(procs_dir), pgid=10, pid=10, stage="test", iteration=2)
        data = json.loads((procs_dir / "10.json").read_text())
        assert data["stage"] == "test"
        assert data["iteration"] == 2

    def test_start_time_is_wall_clock(self, procs_dir):
        record_spawn(str(procs_dir), pgid=1, pid=1, stage="s", iteration=0)
        t = json.loads((procs_dir / "1.json").read_text())["start_time"]
        assert isinstance(t, float)
        assert t > 0


class TestRemoveSpawn:
    def test_removes_existing_entry(self, procs_dir):
        record_spawn(str(procs_dir), pgid=99, pid=99, stage="s", iteration=0)
        assert (procs_dir / "99.json").exists()
        remove_spawn(str(procs_dir), pgid=99)
        assert not (procs_dir / "99.json").exists()

    def test_noop_for_missing_entry(self, procs_dir):
        remove_spawn(str(procs_dir), pgid=999)

    def test_noop_for_missing_dir(self, tmp_path):
        remove_spawn(str(tmp_path / "nonexistent"), pgid=1)


class TestListSpawns:
    def test_empty_dir(self, procs_dir):
        assert list_spawns(str(procs_dir)) == []

    def test_missing_dir(self, tmp_path):
        assert list_spawns(str(tmp_path / "nope")) == []

    def test_returns_all_entries(self, procs_dir):
        record_spawn(str(procs_dir), pgid=1, pid=1, stage="a", iteration=0)
        record_spawn(str(procs_dir), pgid=2, pid=2, stage="b", iteration=1)
        entries = list_spawns(str(procs_dir))
        pgids = {e["pgid"] for e in entries}
        assert pgids == {1, 2}

    def test_skips_corrupt_files(self, procs_dir):
        record_spawn(str(procs_dir), pgid=1, pid=1, stage="a", iteration=0)
        (procs_dir / "bad.json").write_text("not json{{{")
        entries = list_spawns(str(procs_dir))
        assert len(entries) == 1
        assert entries[0]["pgid"] == 1


class TestIsAliveAndOurs:
    def test_dead_process_returns_false(self):
        assert is_alive_and_ours(pgid=999999, pid=999999, start_time=time.monotonic()) is False

    def test_live_process_matching_start_time(self):
        pid = os.getpid()
        pgid = os.getpgid(pid)
        boot = _get_process_start_time(pid)
        if boot is None:
            pytest.skip("Cannot read process start time on this platform")
        assert is_alive_and_ours(pgid=pgid, pid=pid, start_time=boot) is True

    def test_start_time_mismatch_returns_false(self):
        pid = os.getpid()
        pgid = os.getpgid(pid)
        assert is_alive_and_ours(pgid=pgid, pid=pid, start_time=0.0) is False


class TestKillAllTracked:
    def test_kills_live_process_and_prunes(self, procs_dir):
        import subprocess
        proc = subprocess.Popen(
            ["sleep", "300"],
            start_new_session=True,
        )
        pgid = os.getpgid(proc.pid)
        boot = _get_process_start_time(pgid)
        if boot is None:
            proc.kill()
            proc.wait()
            pytest.skip("Cannot read process start time on this platform")

        record_spawn(str(procs_dir), pgid=pgid, pid=proc.pid, stage="test", iteration=0)
        # Patch the start_time in the file to match the real process
        path = procs_dir / f"{pgid}.json"
        data = json.loads(path.read_text())
        data["start_time"] = boot
        path.write_text(json.dumps(data))

        killed = kill_all_tracked(str(procs_dir))
        assert killed >= 1

        # Process should be dead
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            pytest.fail("Process was not killed")

        # Entry should be pruned
        assert not path.exists()

    def test_skips_dead_process_and_prunes(self, procs_dir):
        record_spawn(str(procs_dir), pgid=999999, pid=999999, stage="s", iteration=0)
        killed = kill_all_tracked(str(procs_dir))
        assert killed == 0
        assert not (procs_dir / "999999.json").exists()

    def test_skips_pid_reuse(self, procs_dir):
        pid = os.getpid()
        pgid = os.getpgid(pid)
        # Record with a bogus start_time that won't match
        record_spawn(str(procs_dir), pgid=pgid, pid=pid, stage="s", iteration=0)
        path = procs_dir / f"{pgid}.json"
        data = json.loads(path.read_text())
        data["start_time"] = 0.0  # won't match
        path.write_text(json.dumps(data))

        killed = kill_all_tracked(str(procs_dir))
        assert killed == 0
        # Entry pruned even though we didn't kill (stale)
        assert not path.exists()

    def test_empty_dir(self, procs_dir):
        assert kill_all_tracked(str(procs_dir)) == 0

    def test_missing_dir(self, tmp_path):
        assert kill_all_tracked(str(tmp_path / "nope")) == 0

    def test_sigkill_escalation(self, procs_dir):
        """Process that ignores SIGTERM gets SIGKILL after timeout."""
        import subprocess
        import textwrap

        script = textwrap.dedent("""\
            import signal, time
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            while True:
                time.sleep(1)
        """)
        proc = subprocess.Popen(
            ["python3", "-c", script],
            start_new_session=True,
        )
        pgid = os.getpgid(proc.pid)
        boot = _get_process_start_time(pgid)
        if boot is None:
            proc.kill()
            proc.wait()
            pytest.skip("Cannot read process start time on this platform")

        record_spawn(str(procs_dir), pgid=pgid, pid=proc.pid, stage="test", iteration=0)
        path = procs_dir / f"{pgid}.json"
        data = json.loads(path.read_text())
        data["start_time"] = boot
        path.write_text(json.dumps(data))

        with mock.patch("worca.utils.proc_registry.SIGTERM_TIMEOUT", 0.5):
            killed = kill_all_tracked(str(procs_dir))

        assert killed >= 1
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            pytest.fail("Process was not killed even after SIGKILL escalation")


def _get_process_start_time(pid):
    """Helper to get process start time — mirrors the module's implementation."""
    try:
        from worca.utils.proc_registry import _get_process_create_time
        return _get_process_create_time(pid)
    except Exception:
        return None
