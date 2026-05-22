"""Worktree Graphify contract (W-053 cache relocation).

The old model materialized the parent's ``graphify-out/`` path into each
worktree's settings (single-writer / parent-owns-it). The cache relocation
replaces that with content-addressed snapshots keyed by repo-id + commit-sha:
a worktree shares the parent's repo-id (same git common dir) and resolves its
OWN snapshot by its base sha — "build-own, shared by sha". No settings
materialization happens, so the old hook is gone.
"""

import subprocess

from worca.utils.git import repo_id
from worca.utils.graphify import graphify_snapshot_dir


def _git(path, *args):
    subprocess.run(
        ["git", "-C", str(path), *args], check=True, capture_output=True, text=True
    )


def _init_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@t")
    _git(path, "config", "user.name", "t")
    (path / "f.txt").write_text("x")
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "init")


class TestMaterializationRemoved:
    def test_materialize_hook_is_gone(self):
        """The settings-materialization hook no longer exists (cache relocation)."""
        import worca.scripts.run_worktree as rw

        assert not hasattr(rw, "_materialize_graphify_for_worktree")


class TestWorktreeSharesRepoCache:
    def test_worktree_shares_parent_repo_id(self, tmp_path):
        """Worktree + parent map to the same repo-id (shared git common dir)."""
        repo = tmp_path / "repo"
        _init_repo(repo)
        wt = tmp_path / "wt"
        _git(repo, "worktree", "add", "-q", str(wt))
        assert repo_id(str(wt)) == repo_id(str(repo))

    def test_same_sha_resolves_same_snapshot(self, tmp_path, monkeypatch):
        """Parent and a worktree on the same base sha resolve the SAME snapshot
        dir, so a snapshot built by one is reused by the other."""
        monkeypatch.setenv("WORCA_CACHE", str(tmp_path / "cache"))
        repo = tmp_path / "repo"
        _init_repo(repo)
        wt = tmp_path / "wt"
        _git(repo, "worktree", "add", "-q", "--detach", str(wt))

        rid_parent = repo_id(str(repo))
        rid_wt = repo_id(str(wt))
        sha = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()

        assert graphify_snapshot_dir(rid_parent, sha) == graphify_snapshot_dir(
            rid_wt, sha
        )
