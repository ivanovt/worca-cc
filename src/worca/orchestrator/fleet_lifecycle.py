"""Fleet-level lifecycle actions: pause and stop.

A fleet has no long-lived coordinator process that can be signalled — the
fan-out children are independent worktree pipelines. Pause and Stop are
therefore implemented by fanning a per-run control file out to every
in-flight child (reusing the control protocol in ``worca_lifecycle``) and
stamping the fleet manifest:

  pause_fleet  -> writes a ``pause`` control file to every in-flight child;
                  manifest status -> "paused".
  stop_fleet   -> writes a ``stop`` control file and SIGTERMs every in-flight
                  child; manifest status -> "halted", halt_reason "stopped".

Both leave the fleet in a sticky state (poll_and_update_fleet_manifest never
overrides "halted"/"paused") that only ``resume_fleet`` clears. Children that
are already terminal or already paused are left untouched — a control file
written to an exited pipeline is inert.
"""

import json
import os
import subprocess
import sys

from worca.orchestrator.fleet_manifest import (
    read_fleet_manifest,
    update_fleet_status,
)

# run_pipeline.py lives in the sibling scripts/ package. fleet_lifecycle.py is
# at <runtime>/orchestrator/fleet_lifecycle.py, so dirname-twice + scripts/.
_RUN_PIPELINE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "scripts",
    "run_pipeline.py",
)

# Child registry statuses that mean "a pipeline process is in flight" and can
# therefore act on a control file. Terminal states (completed/failed/...) and
# already-paused children are skipped.
_IN_FLIGHT_CHILD_STATES = frozenset({"running", "resuming"})


def _resolve_child_status(project_path: str, run_id: str) -> str:
    """Return a child's live pipeline status from its registry entry.

    Falls back to "running" when the entry is missing or malformed — the
    conservative choice, since a missing entry during early dispatch should
    not cause us to silently skip a child that is in fact in flight.
    """
    entry_path = os.path.join(
        project_path, ".worca", "multi", "pipelines.d", f"{run_id}.json"
    )
    try:
        with open(entry_path) as f:
            return json.load(f).get("status", "running")
    except (OSError, json.JSONDecodeError):
        return "running"


def _fan_out(fleet_id: str, action_fn) -> int | None:
    """Apply ``action_fn(run_id, base=...)`` to every in-flight fleet child.

    ``base`` is the child's *project* .worca/ directory — worca_lifecycle's
    cmd_pause / cmd_stop resolve the worktree from the registry entry there.

    Returns the number of children the action was applied to, or None when
    the fleet manifest is missing.
    """
    manifest = read_fleet_manifest(fleet_id)
    if manifest is None:
        return None

    count = 0
    for child in manifest.get("children", []):
        project_path = child.get("project_path")
        run_id = child.get("run_id")
        if not project_path or not run_id:
            continue
        if _resolve_child_status(project_path, run_id) not in _IN_FLIGHT_CHILD_STATES:
            continue
        base = os.path.join(project_path, ".worca")
        try:
            action_fn(run_id, base=base)
            count += 1
        except Exception:
            # A single uncooperative child must not abort the fan-out — the
            # remaining children still need their control files.
            continue
    return count


def pause_fleet(fleet_id: str) -> int | None:
    """Pause every in-flight child of a fleet and mark the manifest "paused".

    Writes a ``pause`` control file into each in-flight child's worktree;
    the child reads it at the top of its next iteration, persists
    ``pipeline_status=paused`` (mirrored into the registry), and exits 0.

    Returns the number of children paused, or None if the manifest is missing.
    """
    from worca.scripts.worca_lifecycle import cmd_pause

    count = _fan_out(fleet_id, cmd_pause)
    if count is None:
        return None
    update_fleet_status(fleet_id, "paused")
    return count


def stop_fleet(fleet_id: str) -> int | None:
    """Stop every in-flight child of a fleet and mark the manifest "halted".

    Writes a ``stop`` control file into each in-flight child's worktree and
    SIGTERMs the child's pipeline process; the child persists
    ``pipeline_status=interrupted`` and unwinds. The manifest is stamped
    ``status="halted"`` with ``halt_reason="stopped"`` to distinguish an
    operator Stop (in-flight killed) from a plain Halt (in-flight finished
    naturally) and from a circuit-breaker halt.

    Returns the number of children stopped, or None if the manifest is missing.

    Fires the ``fleet.halted`` webhook with halt_reason="stopped" exactly
    once per stop (not on every poll). Failures are non-fatal — emission
    is best-effort and never raises.
    """
    from worca.scripts.worca_lifecycle import cmd_stop

    count = _fan_out(fleet_id, cmd_stop)
    if count is None:
        return None
    update_fleet_status(fleet_id, "halted", halt_reason="stopped")
    _emit_fleet_stop_event(fleet_id, in_flight_count=count)
    return count


def _emit_fleet_stop_event(fleet_id: str, *, in_flight_count: int) -> None:
    """Fire fleet.halted (halt_reason=stopped). Best-effort, never raises."""
    try:
        manifest = read_fleet_manifest(fleet_id)
        if manifest is None:
            return
        from worca.events.fleet_emitter import emit_fleet_event
        from worca.events.types import FLEET_HALTED, fleet_halted_payload

        settings_path = ".claude/settings.json"
        children = manifest.get("children") or []
        if children:
            project_path = children[0].get("project_path")
            if project_path:
                settings_path = os.path.join(
                    project_path, ".claude", "settings.json"
                )
        emit_fleet_event(
            fleet_id,
            FLEET_HALTED,
            fleet_halted_payload(
                halt_reason="stopped", in_flight_count=in_flight_count
            ),
            settings_path=settings_path,
        )
    except Exception:
        pass


def resume_child(project_path: str, run_id: str) -> bool:
    """Resume a paused or interrupted fleet child in place.

    Spawns ``run_pipeline.py --resume`` inside the child's existing worktree,
    pointed at the worktree's worca root for status and the *parent project's*
    .worca for the multi-pipeline registry — so ``update_pipeline`` lands on
    the entry the fleet actually reads. This is the in-place counterpart to
    ``resume_fleet``'s re-dispatch path (which creates a fresh worktree for
    failed/pending children); a paused child's worktree still holds all of
    its progress, so it must be continued, not restarted.

    Mirrors the worktree-resume contract in worca-ui's process-manager.js:
      - ``--status-dir`` is the worktree's worca *root*, not the per-run dir
        (the runner derives ``runs/<id>/`` itself).
      - ``--registry-base`` is the parent project's .worca.
      - ``interrupted``/``failed`` status.json is flipped to ``resuming`` so
        the runner's _find_active_runs() (which skips terminal statuses)
        picks the run back up. ``paused`` is already non-terminal.

    The registry entry is also flipped to ``resuming`` up front so fleet
    status derivation doesn't briefly read the child as terminal in the
    window before the resumed runner flips it to ``running``.

    Returns True when a resume process was spawned, False when the child's
    registry entry, worktree, or status file is missing.
    """
    from worca.orchestrator.registry import get_pipeline, update_pipeline

    project_base = os.path.join(project_path, ".worca")
    entry = get_pipeline(run_id, base=project_base)
    if entry is None:
        return False
    worktree_path = entry.get("worktree_path")
    if not worktree_path or not os.path.isdir(worktree_path):
        return False

    worktree_worca = os.path.join(worktree_path, ".worca")
    status_path = os.path.join(worktree_worca, "runs", run_id, "status.json")

    try:
        with open(status_path) as f:
            status = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False

    if status.get("pipeline_status") in ("interrupted", "failed"):
        status["pipeline_status"] = "resuming"
        status.pop("stop_reason", None)
        with open(status_path, "w") as f:
            json.dump(status, f, indent=2)
            f.write("\n")

    update_pipeline(run_id, status="resuming", base=project_base)

    cmd = [
        sys.executable,
        _RUN_PIPELINE,
        "--resume",
        "--status-dir",
        worktree_worca,
        "--registry-base",
        os.path.abspath(project_base),
        "--worktree",
    ]
    subprocess.Popen(
        cmd,
        cwd=worktree_path,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return True
