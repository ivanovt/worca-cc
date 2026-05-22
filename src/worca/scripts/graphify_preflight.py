"""Graphify preflight: detect, build/update graph, return status.

Called by runner.run_preflight() after base preflight succeeds.
Never raises — returns a status dict indicating skipped/degraded/ready.
"""

import os
import subprocess
from typing import Optional

from worca.utils.graphify import (
    build_subprocess_env,
    build_update_cmd,
    detect_graphify,
    effective_graphify_config,
)
from worca.utils.settings import load_global_settings, load_settings


def run_graphify_preflight(
    *,
    settings_path: str = ".claude/settings.json",
    project_root: str = ".",
    timeout: Optional[int] = None,
    global_settings: Optional[dict] = None,
) -> dict:
    """Run graphify preflight checks and optional graph update.

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

    # Explicit timeout arg (tests) wins; otherwise use the configured value.
    if timeout is None:
        timeout = cfg.preflight_timeout_seconds

    detect = detect_graphify(cfg.version_range)

    if not detect.installed or not detect.compatible:
        reason = detect.error or "not installed or incompatible"
        return {"status": "degraded", "reason": reason}

    if not cfg.update_on_preflight:
        out_dir = cfg.out_dir
        if not os.path.isabs(out_dir):
            out_dir = os.path.join(project_root, out_dir)
        report_path = os.path.join(out_dir, "GRAPH_REPORT.md")
        if os.path.isfile(report_path):
            return {"status": "ready", "report_path": report_path}
        return {"status": "skipped", "reason": "update_on_preflight disabled"}

    cmd = build_update_cmd(cfg)
    env = build_subprocess_env(cfg, settings)

    try:
        proc = subprocess.run(
            cmd,
            cwd=project_root,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"status": "degraded", "reason": "timeout"}

    if proc.returncode != 0:
        return {
            "status": "degraded",
            "reason": "build_failed",
            "stderr": proc.stderr[:500] if proc.stderr else "",
        }

    out_dir = cfg.out_dir
    if not os.path.isabs(out_dir):
        out_dir = os.path.join(project_root, out_dir)
    report_path = os.path.join(out_dir, "GRAPH_REPORT.md")

    if not os.path.isfile(report_path):
        return {
            "status": "degraded",
            "reason": "report_not_found",
        }

    return {
        "status": "ready",
        "report_path": report_path,
    }
