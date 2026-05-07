"""W-050 Phase 3 — `worca cleanup` integration coverage.

Drives the ``worca cleanup`` CLI (via ``python -m worca.cli.main cleanup``)
against worktrees actually created by ``pipeline_env.run_worktree``. Covers
the four documented modes — ``--dry-run``, ``--all``, ``--run-id``,
``--older-than`` — and asserts on:

- stdout listing for dry-run
- worktree directory removal on disk
- pipelines.d/ registry entry deregistration
- filter exclusion (``--older-than`` skipping recent runs)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest


_HAPPY = {"default": {"action": "succeed", "delay_s": 0}}


def _registry_entries(project: Path) -> list[dict]:
    """Return all pipelines.d/*.json entries the registry currently knows about."""
    reg_dir = project / ".worca" / "multi" / "pipelines.d"
    if not reg_dir.is_dir():
        return []
    out = []
    for f in sorted(reg_dir.glob("*.json")):
        try:
            out.append(json.loads(f.read_text()))
        except (json.JSONDecodeError, OSError):
            pass
    return out


# ---------------------------------------------------------------------------
# --dry-run
# ---------------------------------------------------------------------------


def test_cleanup_dry_run_lists_without_removing(pipeline_env):
    """``--dry-run`` should print the eligible worktrees but leave both the
    on-disk dir and the pipelines.d/ registry entry intact."""
    result = pipeline_env.run_worktree(_HAPPY, prompt="dry-run candidate")
    assert result.returncode == 0
    wt_path = Path(result.worktree_path)
    assert wt_path.is_dir()

    proc = pipeline_env.run_cli("cleanup", "--dry-run")
    assert proc.returncode == 0, f"cleanup --dry-run rc={proc.returncode}\n{proc.stderr}"
    assert result.run_id in proc.stdout, (
        f"dry-run listing should mention run_id {result.run_id}; "
        f"stdout: {proc.stdout[:500]}"
    )
    assert "Would remove" in proc.stdout

    # Worktree and registry entry still present after dry-run.
    assert wt_path.is_dir(), "dry-run must not remove the worktree dir"
    entries = _registry_entries(pipeline_env.project)
    assert any(e.get("run_id") == result.run_id for e in entries), (
        "dry-run must not deregister"
    )


# ---------------------------------------------------------------------------
# --all
# ---------------------------------------------------------------------------


def test_cleanup_all_removes_completed_worktrees(pipeline_env):
    """``--all`` reaps every completed/failed worktree without prompting:
    the directory is gone from disk and the registry entry is deregistered."""
    result = pipeline_env.run_worktree(_HAPPY, prompt="reap me")
    assert result.returncode == 0
    wt_path = Path(result.worktree_path)
    assert wt_path.is_dir()

    proc = pipeline_env.run_cli("cleanup", "--all")
    assert proc.returncode == 0, f"cleanup --all rc={proc.returncode}\n{proc.stderr}"
    assert "Removed" in proc.stdout, f"unexpected stdout: {proc.stdout[:500]}"

    assert not wt_path.exists(), (
        "worktree dir should be gone after --all; cleanup wipes ignored "
        ".worca/ leftovers too via shutil.rmtree"
    )
    entries = _registry_entries(pipeline_env.project)
    assert not any(e.get("run_id") == result.run_id for e in entries), (
        "registry entry should be deregistered after --all"
    )


# ---------------------------------------------------------------------------
# --run-id
# ---------------------------------------------------------------------------


def test_cleanup_run_id_targets_only_specified_worktree(pipeline_env):
    """``--run-id <id>`` removes exactly one worktree, leaving sibling
    entries untouched."""
    result_a = pipeline_env.run_worktree(_HAPPY, prompt="keep me")
    result_b = pipeline_env.run_worktree(_HAPPY, prompt="remove me")
    assert result_a.returncode == 0 and result_b.returncode == 0
    wt_a, wt_b = Path(result_a.worktree_path), Path(result_b.worktree_path)
    assert wt_a.is_dir() and wt_b.is_dir()

    proc = pipeline_env.run_cli("cleanup", "--run-id", result_b.run_id)
    assert proc.returncode == 0, (
        f"cleanup --run-id rc={proc.returncode}\n{proc.stderr}"
    )

    assert wt_a.is_dir(), "non-targeted worktree must remain"
    assert not wt_b.exists(), "targeted worktree must be removed"

    run_ids = {e.get("run_id") for e in _registry_entries(pipeline_env.project)}
    assert result_a.run_id in run_ids
    assert result_b.run_id not in run_ids


# ---------------------------------------------------------------------------
# --older-than (filter excludes recent runs)
# ---------------------------------------------------------------------------


def test_cleanup_older_than_skips_recent_worktrees(pipeline_env):
    """A freshly-created worktree (started_at is "now") must NOT be reaped
    by ``--older-than 1h`` — the time filter excludes recent runs even when
    the worktree is otherwise eligible (completed pipeline_status)."""
    result = pipeline_env.run_worktree(_HAPPY, prompt="too recent")
    assert result.returncode == 0
    wt_path = Path(result.worktree_path)
    assert wt_path.is_dir()

    proc = pipeline_env.run_cli("cleanup", "--all", "--older-than", "1h")
    assert proc.returncode == 0, (
        f"cleanup --older-than rc={proc.returncode}\n{proc.stderr}"
    )
    # No eligible entries → "No eligible worktrees to clean up." printed.
    assert "No eligible worktrees" in proc.stdout, (
        f"unexpected stdout for filter-exclusion case: {proc.stdout[:500]}"
    )

    assert wt_path.is_dir(), "recent worktree must not be reaped"
    entries = _registry_entries(pipeline_env.project)
    assert any(e.get("run_id") == result.run_id for e in entries), (
        "registry entry for recent run must remain"
    )


# ---------------------------------------------------------------------------
# Daemon stop on cleanup (requires real bd binary)
# ---------------------------------------------------------------------------


def test_cleanup_all_stops_beads_daemon(pipeline_env):
    """After ``--all`` cleanup, the daemon process recorded in the worktree's
    ``.beads/daemon.pid`` is no longer alive.

    ``bd_daemon_stop`` first tries ``bd daemon stop`` then falls back to
    SIGTERM-from-pidfile; this test exercises the end-to-end path by placing
    a long-lived subprocess PID in the worktree's daemon.pid before cleanup.

    Skipped if ``WORCA_SKIP_BEADS`` is set in the outer test environment or
    ``bd`` is absent from PATH — the ``bd daemon stop`` phase must be
    reachable (even though the SIGTERM fallback is what does the work).
    """
    import sys

    if os.environ.get("WORCA_SKIP_BEADS"):
        pytest.skip("WORCA_SKIP_BEADS set — real bd unavailable")
    if not shutil.which("bd"):
        pytest.skip("bd not on PATH")

    result = pipeline_env.run_worktree(_HAPPY, prompt="daemon stop guard")
    assert result.returncode == 0
    wt_path = Path(result.worktree_path)
    assert wt_path.is_dir()

    # Create .beads/ in the worktree and plant a live PID in daemon.pid.
    beads_dir = wt_path / ".beads"
    beads_dir.mkdir(exist_ok=True)
    # A long-lived subprocess that responds to SIGTERM stands in for a real
    # bd daemon; it must be reaped by the cleanup's SIGTERM-fallback path.
    stand_in = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    (beads_dir / "daemon.pid").write_text(str(stand_in.pid))

    try:
        os.kill(stand_in.pid, 0)  # sanity: process is alive
    except ProcessLookupError:
        pytest.skip("stand-in process exited immediately — cannot test")

    proc = pipeline_env.run_cli("cleanup", "--all")
    assert proc.returncode == 0, f"cleanup --all rc={proc.returncode}\n{proc.stderr}"

    # wait() reaps the child once it exits; TimeoutExpired means SIGTERM was
    # never delivered (the daemon-stop path didn't fire).  returncode == -15
    # (SIGTERM) or -9 (SIGKILL) both mean the process is gone.
    try:
        stand_in.wait(timeout=3)
    except subprocess.TimeoutExpired:
        stand_in.kill()  # clean up before failing
        pytest.fail(
            f"stand-in daemon (pid={stand_in.pid}) is still alive after cleanup — "
            "bd_daemon_stop did not deliver SIGTERM via pidfile fallback"
        )
