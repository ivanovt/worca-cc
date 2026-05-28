"""Shared per-commit AST cache primitives.

Engine-agnostic helpers for the content-addressed snapshot layout:
    $WORCA_CACHE/ast/<repo-id>/<commit-sha>/

Both graphify and code-review-graph build into engine-specific
subdirectories under this per-commit dir and share the flock /
.complete coordination.
"""

import contextlib
import os
from typing import Optional


def ast_snapshot_dir(
    repo_id_value: str, commit_sha: str, cache_dir: Optional[str] = None
) -> str:
    """Absolute path to the per-commit snapshot dir for a repo+sha."""
    from worca.utils.paths import worca_cache_dir

    root = cache_dir if cache_dir is not None else worca_cache_dir()
    return os.path.join(root, "ast", repo_id_value, commit_sha)


def _complete_marker(snapshot_dir: str) -> str:
    return os.path.join(snapshot_dir, ".complete")


def is_snapshot_complete(snapshot_dir: str) -> bool:
    """A snapshot is usable only once its ``.complete`` marker exists."""
    return os.path.isfile(_complete_marker(snapshot_dir))


def mark_snapshot_complete(snapshot_dir: str) -> None:
    """Publish a snapshot by writing its ``.complete`` marker."""
    os.makedirs(snapshot_dir, exist_ok=True)
    with open(_complete_marker(snapshot_dir), "w", encoding="utf-8") as f:
        f.write("ok\n")


@contextlib.contextmanager
def snapshot_lock(snapshot_dir: str):
    """Exclusive flock over a snapshot's ``.lock`` (single-writer build).

    No-op fallback on platforms without ``fcntl`` (e.g. Windows): the lock file
    is still created so the dir exists, but no advisory lock is held.
    """
    os.makedirs(snapshot_dir, exist_ok=True)
    lock_path = os.path.join(snapshot_dir, ".lock")
    f = open(lock_path, "w", encoding="utf-8")
    try:
        try:
            import fcntl

            fcntl.flock(f, fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        yield
    finally:
        try:
            import fcntl

            fcntl.flock(f, fcntl.LOCK_UN)
        except (ImportError, OSError):
            pass
        f.close()
