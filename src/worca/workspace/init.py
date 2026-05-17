"""Workspace per-target init with timeout + cancel (W-047 §10.3).

Runs ``worca init --upgrade`` on each workspace project in parallel.
Each subprocess gets an independent per-target timeout. A cancel_event
(threading.Event) can terminate outstanding subprocesses early.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

_DEFAULT_TIMEOUT = 60


def init_workspace_targets(
    *,
    projects: list[dict],
    workspace_root: str,
    timeout_seconds: int = _DEFAULT_TIMEOUT,
    cancel_event: threading.Event | None = None,
    max_parallel: int = 5,
) -> dict[str, dict]:
    """Run ``worca init --upgrade`` on each project with per-target timeout.

    Args:
        projects: List of dicts with at least ``name`` and ``path`` keys.
        workspace_root: Absolute path to the workspace parent directory.
        timeout_seconds: Max seconds per target init (default 60).
        cancel_event: Optional threading.Event; when set, skips unstarted
            targets and terminates in-flight subprocesses.
        max_parallel: Max concurrent init subprocesses.

    Returns:
        ``{project_name: {"status": str, "reason": str | None}}``
        Status is one of ``ready``, ``setup_failed``, ``cancelled``.
    """
    results: dict[str, dict] = {}

    if cancel_event is not None and cancel_event.is_set():
        for project in projects:
            results[project["name"]] = {
                "status": "cancelled",
                "reason": "cancelled before init started",
            }
        return results

    with ThreadPoolExecutor(max_workers=max_parallel) as pool:
        futures = {}
        for project in projects:
            if cancel_event is not None and cancel_event.is_set():
                results[project["name"]] = {
                    "status": "cancelled",
                    "reason": "cancelled before init started",
                }
                continue
            future = pool.submit(
                _init_single_target,
                project_name=project["name"],
                project_path=os.path.join(workspace_root, project["path"]),
                timeout_seconds=timeout_seconds,
                cancel_event=cancel_event,
            )
            futures[future] = project["name"]

        for future in as_completed(futures):
            project_name = futures[future]
            results[project_name] = future.result()

    return results


def _init_single_target(
    *,
    project_name: str,
    project_path: str,
    timeout_seconds: int,
    cancel_event: threading.Event | None,
) -> dict:
    """Init a single target with timeout and cancel support."""
    if cancel_event is not None and cancel_event.is_set():
        return {"status": "cancelled", "reason": "cancelled before init started"}

    cmd = [sys.executable, "-m", "worca", "init", project_path, "--upgrade"]

    if cancel_event is not None:
        return _init_with_cancel(
            cmd=cmd,
            cwd=project_path,
            timeout_seconds=timeout_seconds,
            cancel_event=cancel_event,
        )

    try:
        proc = subprocess.run(
            cmd,
            cwd=project_path,
            timeout=timeout_seconds,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            return {
                "status": "setup_failed",
                "reason": f"init failed (exit {proc.returncode})",
            }
        return {"status": "ready", "reason": None}
    except subprocess.TimeoutExpired:
        return {
            "status": "setup_failed",
            "reason": f"init timeout after {timeout_seconds}s",
        }


def _init_with_cancel(
    *,
    cmd: list[str],
    cwd: str,
    timeout_seconds: int,
    cancel_event: threading.Event,
) -> dict:
    """Run init with Popen so we can terminate on cancel."""
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    poll_interval = 0.5
    elapsed = 0.0

    while True:
        try:
            proc.wait(timeout=min(poll_interval, timeout_seconds - elapsed))
            break
        except subprocess.TimeoutExpired:
            elapsed += poll_interval
            if cancel_event.is_set():
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                return {"status": "cancelled", "reason": "cancelled by user"}
            if elapsed >= timeout_seconds:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                return {
                    "status": "setup_failed",
                    "reason": f"init timeout after {timeout_seconds}s",
                }

    if proc.returncode != 0:
        return {
            "status": "setup_failed",
            "reason": f"init failed (exit {proc.returncode})",
        }
    return {"status": "ready", "reason": None}
