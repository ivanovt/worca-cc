"""Graphify preflight: detect, build/reuse the per-commit graph snapshot.

Called by runner.run_preflight() after base preflight succeeds. Never raises —
returns a status dict indicating skipped/degraded/ready.

Snapshots are content-addressed at ``<cache>/ast/<repo-id>/<commit-sha>/`` and
published atomically with a ``.complete`` marker under an exclusive lock, so
parallel worktrees on the same base commit share one validated snapshot. See
docs/plans/W-053 and utils/graphify.py for the layout.
"""

import os
import subprocess
from typing import Optional

from worca.utils.git import get_current_git_head, is_working_tree_clean, repo_id
from worca.utils.graphify import (
    build_graph_cmd,
    build_subprocess_env,
    detect_graphify,
    effective_graphify_config,
    graphify_out_path,
    graphify_report_path,
    graphify_snapshot_dir,
    is_snapshot_complete,
    mark_snapshot_complete,
    snapshot_lock,
)
from worca.utils.settings import load_global_settings, load_settings


def _run_build(cfg, settings, *, project_root, out_dir, timeout) -> tuple[bool, str]:
    """Run `graphify update <project>` writing into out_dir (GRAPHIFY_OUT).

    Runs from the cache dir (``cwd``), not the project, and scans the project by
    absolute path. graphify writes a ``graphify-out/manifest.json`` relative to
    its cwd independently of GRAPHIFY_OUT, so running from the project would
    leave an untracked dir that dirties the working tree — which forces
    clean_only into a throwaway snapshot that's never published. Pointing cwd at
    the cache keeps every graphify side-effect out of the project. Returns
    (ok, stderr).
    """
    os.makedirs(out_dir, exist_ok=True)
    cmd = build_graph_cmd(cfg, os.path.abspath(project_root))
    env = build_subprocess_env(cfg, settings, graphify_out=out_dir)
    try:
        proc = subprocess.run(
            cmd,
            cwd=os.path.dirname(out_dir),
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


def run_graphify_preflight(
    *,
    settings_path: str = ".claude/settings.json",
    project_root: str = ".",
    timeout: Optional[int] = None,
    global_settings: Optional[dict] = None,
) -> dict:
    """Detect graphify and resolve the per-commit snapshot for this run.

    Returns a status dict with keys:
        status: "skipped" | "degraded" | "ready"
        reason: (when skipped/degraded) explanation string
        report_path: (when ready) absolute path to GRAPH_REPORT.md

    Never raises — all errors are caught and returned as degraded status.
    """
    settings = load_settings(settings_path)
    if global_settings is None:
        global_settings = load_global_settings()

    cfg = effective_graphify_config(global_settings, settings)
    if not cfg.enabled:
        return {"status": "skipped", "reason": "disabled"}

    mode = cfg.mode

    if timeout is None:
        timeout = cfg.preflight_timeout_seconds

    detect = detect_graphify(cfg.version_range)
    if not detect.installed or not detect.compatible:
        return {"status": "degraded", "mode": mode, "reason": detect.error or "not installed or incompatible"}

    rid = repo_id(project_root)
    sha = get_current_git_head()
    if not rid or not sha:
        return {"status": "degraded", "mode": mode, "reason": "not_a_git_repo"}

    snapshot_dir = graphify_snapshot_dir(rid, sha)
    out_dir = graphify_out_path(snapshot_dir)

    # Dirty + clean_only: build a run-scoped throwaway (never published to the
    # cache), so an in-progress working tree never poisons the per-commit entry.
    if cfg.freshness == "clean_only" and not is_working_tree_clean(project_root):
        throwaway = snapshot_dir + ".dirty"
        throwaway_out = graphify_out_path(throwaway)
        ok, err = _run_build(
            cfg, settings, project_root=project_root, out_dir=throwaway_out, timeout=timeout
        )
        if not ok:
            return {"status": "degraded", "mode": mode, "reason": err or "build_failed"}
        return {"status": "ready", "outcome": "throwaway", "mode": mode, "report_path": graphify_report_path(throwaway)}

    # Cache hit: a published snapshot for this sha already exists.
    if is_snapshot_complete(snapshot_dir):
        return {"status": "ready", "outcome": "cached", "mode": mode, "report_path": graphify_report_path(snapshot_dir)}

    # When preflight builds are disabled, only read an existing snapshot.
    if not cfg.update_on_preflight:
        return {"status": "skipped", "mode": mode, "reason": "update_on_preflight disabled"}

    # Build under an exclusive lock; re-check completion in case a parallel
    # worktree published while we waited.
    with snapshot_lock(snapshot_dir):
        if is_snapshot_complete(snapshot_dir):
            return {"status": "ready", "outcome": "cached", "mode": mode, "report_path": graphify_report_path(snapshot_dir)}
        ok, err = _run_build(
            cfg, settings, project_root=project_root, out_dir=out_dir, timeout=timeout
        )
        if not ok:
            return {"status": "degraded", "mode": mode, "reason": err or "build_failed"}
        if not os.path.isfile(graphify_report_path(snapshot_dir)):
            return {"status": "degraded", "mode": mode, "reason": "report_not_found"}
        mark_snapshot_complete(snapshot_dir)

    return {"status": "ready", "outcome": "built", "mode": mode, "report_path": graphify_report_path(snapshot_dir)}
