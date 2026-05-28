"""Tests for the per-commit Graphify cache primitives (W-053 relocation).

Covers worca_cache_dir(), git.repo_id(), and the snapshot path / .complete /
lock helpers in utils/graphify.py.
"""

import os
import subprocess

import pytest

from worca.utils.ast_cache import (
    is_snapshot_complete,
    mark_snapshot_complete,
    snapshot_lock,
)
from worca.utils.git import repo_id
from worca.utils.graphify import (
    graphify_out_path,
    graphify_report_path,
    graphify_snapshot_dir,
)
from worca.utils.paths import worca_cache_dir


def _git(path, *args):
    subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _init_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@t")
    _git(path, "config", "user.name", "t")
    (path / "f.txt").write_text("x")
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "init")


class TestWorcaCacheDir:
    def test_env_override_wins(self, tmp_path, monkeypatch):
        monkeypatch.setenv("WORCA_CACHE", str(tmp_path / "c"))
        assert worca_cache_dir() == str(tmp_path / "c")

    def test_default_under_worca_home(self, tmp_path, monkeypatch):
        monkeypatch.delenv("WORCA_CACHE", raising=False)
        monkeypatch.setenv("WORCA_HOME", str(tmp_path / "home"))
        assert worca_cache_dir() == os.path.join(str(tmp_path / "home"), "cache")


class TestRepoId:
    def test_stable_and_12_hex(self, tmp_path):
        repo = tmp_path / "repo"
        _init_repo(repo)
        rid = repo_id(str(repo))
        assert len(rid) == 12
        assert all(c in "0123456789abcdef" for c in rid)
        assert repo_id(str(repo)) == rid  # deterministic

    def test_non_git_dir_returns_empty(self, tmp_path):
        assert repo_id(str(tmp_path)) == ""

    def test_shared_across_worktrees(self, tmp_path):
        repo = tmp_path / "repo"
        _init_repo(repo)
        wt = tmp_path / "wt"
        _git(repo, "worktree", "add", "-q", str(wt))
        # A worktree shares the parent's git common dir → same repo-id.
        assert repo_id(str(wt)) == repo_id(str(repo))


class TestSnapshotPaths:
    def test_snapshot_dir_layout(self):
        d = graphify_snapshot_dir("abc123", "deadbeef", cache_dir="/c")
        assert d == os.path.join("/c", "ast", "abc123", "deadbeef")

    def test_out_and_report_paths(self):
        d = graphify_snapshot_dir("r", "s", cache_dir="/c")
        assert graphify_out_path(d) == os.path.join(d, "graphify")
        assert graphify_report_path(d) == os.path.join(d, "graphify", "GRAPH_REPORT.md")

    def test_snapshot_dir_default_cache(self, tmp_path, monkeypatch):
        monkeypatch.setenv("WORCA_CACHE", str(tmp_path))
        d = graphify_snapshot_dir("r", "s")
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
        # Re-acquirable after release (no deadlock).
        with snapshot_lock(d):
            pass

    @pytest.mark.skipif(os.name != "posix", reason="fcntl.flock is POSIX-only")
    def test_lock_is_exclusive_across_processes(self, tmp_path):
        """A second flock attempt while held must block; non-blocking probe fails."""
        import fcntl

        d = str(tmp_path / "snap")
        with snapshot_lock(d):
            other = open(os.path.join(d, ".lock"), "w")
            try:
                with pytest.raises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                other.close()
