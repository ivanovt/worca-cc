"""Tests for the shared per-commit AST cache primitives (ast_cache.py).

Covers ast_snapshot_dir(), snapshot_lock, .complete marker helpers.
These are the engine-agnostic primitives that both graphify and CRG consume.
"""

import os

import pytest

from worca.utils.ast_cache import (
    ast_snapshot_dir,
    is_snapshot_complete,
    mark_snapshot_complete,
    snapshot_lock,
)


class TestAstSnapshotDir:
    def test_layout(self):
        d = ast_snapshot_dir("abc123", "deadbeef", cache_dir="/c")
        assert d == os.path.join("/c", "ast", "abc123", "deadbeef")

    def test_default_cache(self, tmp_path, monkeypatch):
        monkeypatch.setenv("WORCA_CACHE", str(tmp_path))
        d = ast_snapshot_dir("r", "s")
        assert d == os.path.join(str(tmp_path), "ast", "r", "s")


class TestSnapshotCompletion:
    def test_incomplete_then_complete(self, tmp_path):
        d = str(tmp_path / "snap")
        assert is_snapshot_complete(d) is False
        mark_snapshot_complete(d)
        assert is_snapshot_complete(d) is True
        assert os.path.isfile(os.path.join(d, ".complete"))


class TestSnapshotLock:
    def test_lock_creates_lockfile_and_releases(self, tmp_path):
        d = str(tmp_path / "snap")
        with snapshot_lock(d):
            assert os.path.isfile(os.path.join(d, ".lock"))
        with snapshot_lock(d):
            pass

    @pytest.mark.skipif(os.name != "posix", reason="fcntl.flock is POSIX-only")
    def test_lock_is_exclusive_across_processes(self, tmp_path):
        import fcntl

        d = str(tmp_path / "snap")
        with snapshot_lock(d):
            other = open(os.path.join(d, ".lock"), "w")
            try:
                with pytest.raises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                other.close()
