"""CRG preflight: build base snapshot, WAL checkpoint, seed run-scoped copy.

Called by runner.run_preflight() after graphify preflight. Never raises —
returns a status dict indicating skipped/degraded/ready.

Base snapshots are content-addressed at
``<cache>/ast/<repo-id>/<commit-sha>/code-review-graph/graph.db`` and
published atomically with a ``.complete`` marker under an exclusive lock.
The run-scoped writable copy at ``<run-dir>/code-review-graph/graph.db``
is what agents actually query via ``code-review-graph serve``.
"""

import os
import shutil
import sqlite3
import subprocess
from typing import Optional

from worca.utils.ast_cache import (
    ast_snapshot_dir,
    mark_snapshot_complete,
    snapshot_lock,
)
from worca.utils.code_review_graph import (
    detect_code_review_graph,
    effective_crg_config,
)
from worca.utils.git import get_current_git_head, is_working_tree_clean, repo_id
from worca.utils.settings import load_global_settings, load_settings

_CRG_SUBDIR = "code-review-graph"
_GRAPH_DB = "graph.db"


def _wal_checkpoint(db_path: str) -> None:
    """PRAGMA wal_checkpoint(TRUNCATE) — fold WAL into the main DB file."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()


def _crg_data_dir(base: str) -> str:
    return os.path.join(base, _CRG_SUBDIR)


def _graph_db_path(data_dir: str) -> str:
    return os.path.join(data_dir, _GRAPH_DB)


def _run_build(*, project_root: str, data_dir: str, timeout: int) -> tuple[bool, str]:
    """Run ``code-review-graph build`` writing into data_dir.

    Returns (ok, error_detail).
    """
    os.makedirs(data_dir, exist_ok=True)
    env = {**os.environ, "CRG_REPO_ROOT": os.path.abspath(project_root), "CRG_DATA_DIR": data_dir}
    try:
        proc = subprocess.run(
            ["code-review-graph", "build"],
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, "timeout"
    if proc.returncode != 0:
        return False, (proc.stderr or "")[:500]
    return True, ""


def _copy_db(src_dir: str, dst_dir: str) -> None:
    """Copy graph.db from base snapshot into run-scoped dir."""
    os.makedirs(dst_dir, exist_ok=True)
    src = _graph_db_path(src_dir)
    dst = _graph_db_path(dst_dir)
    shutil.copy2(src, dst)


def run_crg_preflight(
    *,
    settings_path: str = ".claude/settings.json",
    project_root: str = ".",
    run_dir: str = ".",
    timeout: Optional[int] = None,
    global_settings: Optional[dict] = None,
) -> dict:
    """Detect CRG, build/reuse base snapshot, seed run-scoped copy.

    Returns a status dict with keys:
        status: "skipped" | "degraded" | "ready"
        reason: (when skipped/degraded) explanation string
        crg_data_dir: (when ready) absolute path to run-scoped CRG dir

    Never raises — all errors are caught and returned as degraded status.
    """
    settings = load_settings(settings_path)
    if global_settings is None:
        global_settings = load_global_settings()

    cfg = effective_crg_config(global_settings, settings)
    if not cfg.enabled:
        return {"status": "skipped", "reason": "disabled"}

    if timeout is None:
        timeout = cfg.preflight_timeout_seconds

    detect = detect_code_review_graph(cfg.version_range, cfg.fastmcp_min)
    if not detect.installed or not detect.compatible or not detect.fastmcp_ok:
        return {"status": "degraded", "reason": detect.error or "not installed or incompatible"}

    rid = repo_id(project_root)
    sha = get_current_git_head()
    if not rid or not sha:
        return {"status": "degraded", "reason": "not_a_git_repo"}

    snapshot_base = ast_snapshot_dir(rid, sha)
    base_data = _crg_data_dir(snapshot_base)
    run_data = _crg_data_dir(run_dir)

    if cfg.freshness == "clean_only" and not is_working_tree_clean(project_root):
        ok, err = _run_build(project_root=project_root, data_dir=run_data, timeout=timeout)
        if not ok:
            return {"status": "degraded", "reason": err or "build_failed"}
        if not os.path.isfile(_graph_db_path(run_data)):
            return {"status": "degraded", "reason": "graph.db not produced"}
        return {"status": "ready", "crg_data_dir": run_data}

    # The shared .complete marker may be set by graphify before CRG builds.
    # Check for CRG's own graph.db rather than the shared marker alone.
    _crg_base_ready = os.path.isfile(_graph_db_path(base_data))

    if _crg_base_ready:
        _copy_db(base_data, run_data)
        return {"status": "ready", "crg_data_dir": run_data}

    if not cfg.update_on_preflight:
        return {"status": "skipped", "reason": "update_on_preflight disabled"}

    with snapshot_lock(snapshot_base):
        if os.path.isfile(_graph_db_path(base_data)):
            _copy_db(base_data, run_data)
            return {"status": "ready", "crg_data_dir": run_data}
        ok, err = _run_build(project_root=project_root, data_dir=base_data, timeout=timeout)
        if not ok:
            return {"status": "degraded", "reason": err or "build_failed"}
        if not os.path.isfile(_graph_db_path(base_data)):
            return {"status": "degraded", "reason": "graph.db not produced"}
        _wal_checkpoint(_graph_db_path(base_data))
        mark_snapshot_complete(snapshot_base)

    _copy_db(base_data, run_data)
    return {"status": "ready", "crg_data_dir": run_data}
