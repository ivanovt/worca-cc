"""Fleet manifest storage and status polling (W-040 §10).

Manifests live at ~/.worca/fleet-runs/<fleet_id>.json.
Per-child pipeline state stays in each project's pipelines.d/ — not duplicated here.
"""

import json
import os
import secrets
import tempfile
from datetime import datetime, timezone

from worca.state.status import (
    PipelineStatus, FleetStatus, FLEET_STICKY,
    PIPELINE_ACTIVE, PIPELINE_FAILURE, PIPELINE_ALL_TERMINAL,
)
from worca.utils.paths import fleet_runs_dir

GRAPH_STATUS_READY = "ready"
GRAPH_STATUS_DEGRADED = "degraded"
GRAPH_STATUS_DISABLED = "disabled"


# Module-level override slot.  Resolution precedence (see paths.fleet_runs_dir):
#   1. _FLEET_RUNS_DIR if set (typically via ``mock.patch`` in tests)
#   2. $WORCA_HOME/fleet-runs
#   3. ~/.worca/fleet-runs
# Defaulting to None — and resolving lazily inside the helpers below — avoids
# the module-load-time capture that leaked test state into the real home
# directory (issue #162).
_FLEET_RUNS_DIR: str | None = None

_RUNNING_STATES = PIPELINE_ACTIVE
_FAILURE_STATES = PIPELINE_FAILURE
_TERMINAL_STATES = PIPELINE_ALL_TERMINAL


def generate_fleet_id(*, now=None) -> tuple:
    """Return (fleet_id, fleet_id_short) with format f_<yyyymmddhhmm>_<rand>.

    fleet_id_short is the random hex suffix stored in the manifest for
    use in PR titles (§11) and display (§13.7).
    """
    if now is None:
        now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y%m%d%H%M")
    fleet_id_short = secrets.token_hex(4)  # 8 hex chars — low collision probability
    fleet_id = f"f_{timestamp}_{fleet_id_short}"
    return fleet_id, fleet_id_short


def fleet_manifest_path(fleet_id: str, base_dir: str = None) -> str:
    """Return absolute path to the fleet manifest JSON file."""
    if base_dir is None:
        base_dir = fleet_runs_dir(_FLEET_RUNS_DIR)
    return os.path.join(base_dir, f"{fleet_id}.json")


def write_fleet_manifest(manifest: dict, base_dir: str = None) -> str:
    """Write manifest atomically via temp+rename. Returns the path written."""
    fleet_id = manifest["fleet_id"]
    path = fleet_manifest_path(fleet_id, base_dir=base_dir)
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(dir=parent, prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return path


def read_fleet_manifest(fleet_id: str, base_dir: str = None) -> dict:
    """Read and return fleet manifest dict. Returns None if not found or malformed."""
    path = fleet_manifest_path(fleet_id, base_dir=base_dir)
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def register_fleet_child(
    fleet_id: str,
    project_path: str,
    run_id: str,
    *,
    graph_status: str | None = None,
    base_dir: str = None,
) -> bool:
    """Append a dispatched child to the fleet manifest's children array.

    Idempotent — skips when (project_path, run_id) is already present. Returns
    True when the child was added, False when the manifest is missing or the
    entry was a duplicate. Called by the dispatcher right after a child's
    run_worktree.py exits, so the manifest carries a back-reference to every
    dispatched run. The UI also has a registry-side reverse-lookup fallback;
    this write is the authoritative source.
    """
    manifest = read_fleet_manifest(fleet_id, base_dir=base_dir)
    if manifest is None:
        return False

    children = manifest.get("children") or []
    for child in children:
        if (
            child.get("project_path") == project_path
            and child.get("run_id") == run_id
        ):
            return False

    entry = {"project_path": project_path, "run_id": run_id, "status": PipelineStatus.RUNNING}
    if graph_status is not None:
        entry["graph_status"] = graph_status
    children.append(entry)
    manifest["children"] = children
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    write_fleet_manifest(manifest, base_dir=base_dir)
    return True


def update_fleet_status(
    fleet_id: str,
    status: str,
    *,
    halt_reason=None,
    base_dir: str = None,
) -> bool:
    """Update fleet status in the manifest. Returns True on success, False if not found.

    When halt_reason is provided it is written; when not provided and status
    is not "halted", halt_reason is cleared to None (resetting from a prior halt).
    When not provided and status IS "halted", the existing halt_reason is preserved
    so a user-initiated halt reason survives a subsequent poll call that passes
    status="halted" without a reason.
    """
    manifest = read_fleet_manifest(fleet_id, base_dir=base_dir)
    if manifest is None:
        return False

    manifest["status"] = status
    if halt_reason is not None:
        manifest["halt_reason"] = halt_reason
    elif status != "halted":
        manifest["halt_reason"] = None
    # If halt_reason is None and status == "halted", leave existing halt_reason intact.
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()

    write_fleet_manifest(manifest, base_dir=base_dir)
    return True


def derive_fleet_status(child_statuses: list, *, threshold: float = 0.30) -> tuple:
    """Derive fleet-level status from a list of child pipeline statuses (pure).

    Returns (fleet_status, halt_reason) where halt_reason is None or
    "circuit_breaker".

    Circuit-breaker rule (§7): trips when
      failed_count / terminal_count >= threshold
      AND terminal_count >= min(3, total)
    """
    if not child_statuses:
        return FleetStatus.RUNNING, None

    total = len(child_statuses)
    running_count = sum(1 for s in child_statuses if s in _RUNNING_STATES)
    completed_count = sum(1 for s in child_statuses if s == PipelineStatus.COMPLETED)
    failed_count = sum(1 for s in child_statuses if s in _FAILURE_STATES)
    terminal_count = sum(1 for s in child_statuses if s in _TERMINAL_STATES)

    # Circuit-breaker fires only while in-flight children exist — no point halting
    # if there are no more children to protect from launching.
    if running_count > 0:
        min_terminal = min(3, total)
        if terminal_count >= min_terminal and failed_count > 0:
            failure_ratio = failed_count / terminal_count
            if failure_ratio >= threshold:
                return FleetStatus.HALTED, "circuit_breaker"
        return FleetStatus.RUNNING, None

    # All dispatched children are in a terminal state
    if terminal_count == total:
        if completed_count == total:
            return FleetStatus.COMPLETED, None
        return FleetStatus.FAILED, None

    # Pending/untracked children not yet dispatched
    return FleetStatus.RUNNING, None


def poll_and_update_fleet_manifest(
    fleet_id: str,
    *,
    manifest_base_dir: str = None,
) -> str:
    """Poll per-project pipelines.d/ entries and update fleet manifest status.

    Reads each child's pipeline status from
      <child.project_path>/.worca/multi/pipelines.d/<run_id>.json
    Derives fleet status via derive_fleet_status() and writes it back.

    A user-initiated halt (halt_reason == "user") is never overridden.
    Missing registry entries are treated as "running" (not yet created).

    Returns the resulting fleet status, or None if the manifest is not found.
    """
    manifest = read_fleet_manifest(fleet_id, base_dir=manifest_base_dir)
    if manifest is None:
        return None

    current_status = manifest.get("status", FleetStatus.RUNNING)
    # Preserve sticky operator states — both stay put until an explicit resume:
    #   - "halted":  Halt (in-flight finished naturally) or Stop (in-flight
    #                killed, halt_reason="stopped"), plus circuit_breaker.
    #   - "paused":  Pause — every in-flight child received a pause control
    #                file. Children may still be transitioning to paused, so
    #                re-deriving here would race the manifest back to "running".
    if current_status in FLEET_STICKY:
        return current_status

    children = manifest.get("children", [])
    threshold = manifest.get("fleet_failure_threshold", 0.30)

    child_statuses = []
    for child in children:
        project_path = child.get("project_path")
        run_id = child.get("run_id")
        if not project_path or not run_id:
            continue
        registry_entry = os.path.join(
            project_path, ".worca", "multi", "pipelines.d", f"{run_id}.json"
        )
        try:
            with open(registry_entry) as f:
                entry = json.load(f)
            child_statuses.append(entry.get("status", PipelineStatus.RUNNING))
        except (json.JSONDecodeError, OSError):
            child_statuses.append("running")

    new_status, halt_reason = derive_fleet_status(child_statuses, threshold=threshold)

    transitioned = new_status != current_status
    if transitioned or halt_reason is not None:
        update_fleet_status(
            fleet_id,
            new_status,
            halt_reason=halt_reason,
            base_dir=manifest_base_dir,
        )

    # Fleet-level webhook emission. Only on genuine state transitions —
    # poll_and_update is called every WS tick and a no-op poll on a
    # running fleet would otherwise spam subscribers. Failures here are
    # non-fatal (emit_fleet_event never raises). Settings come from the
    # first child's project root — every child in a fleet shares the
    # parent's settings, and the manifest doesn't carry one of its own.
    if transitioned:
        _emit_fleet_transition_event(
            manifest, new_status, halt_reason, child_statuses, threshold
        )

    return new_status


def _emit_fleet_transition_event(
    manifest: dict,
    new_status: str,
    halt_reason: str | None,
    child_statuses: list,
    threshold: float,
) -> None:
    """Emit a fleet webhook event for a status transition.

    Decoupled into its own helper so the polling hot path is unaffected
    when no subscribers are configured (the import + emit cost is paid
    once per transition, not per poll).
    """
    try:
        from worca.events.fleet_emitter import emit_fleet_event
        from worca.events.types import (
            FLEET_CIRCUIT_BREAKER_TRIPPED,
            FLEET_COMPLETED,
            FLEET_FAILED,
            FLEET_HALTED,
            fleet_circuit_breaker_tripped_payload,
            fleet_completed_payload,
            fleet_failed_payload,
            fleet_halted_payload,
        )
    except Exception:
        return  # events module unavailable — keep the poll quiet

    fleet_id = manifest.get("fleet_id")
    children = manifest.get("children") or []
    settings_path = _settings_path_for_fleet(manifest)

    total = len(child_statuses)
    completed_count = sum(1 for s in child_statuses if s == PipelineStatus.COMPLETED)
    failed_count = sum(1 for s in child_statuses if s in PIPELINE_FAILURE)
    interrupted_count = sum(
        1 for s in child_statuses
        if s in (PipelineStatus.INTERRUPTED, PipelineStatus.CANCELLED)
    )
    terminal_count = completed_count + failed_count + interrupted_count

    def _emit(event_type: str, payload: dict) -> None:
        try:
            emit_fleet_event(
                fleet_id,
                event_type,
                payload,
                settings_path=settings_path,
            )
        except Exception:
            pass  # never propagate from the polling path

    if new_status == FleetStatus.COMPLETED:
        _emit(
            FLEET_COMPLETED,
            fleet_completed_payload(
                child_count=total,
                completed_count=completed_count,
            ),
        )
    elif new_status == FleetStatus.FAILED:
        _emit(
            FLEET_FAILED,
            fleet_failed_payload(
                child_count=total,
                completed_count=completed_count,
                failed_count=failed_count,
                interrupted_count=interrupted_count,
            ),
        )
    elif new_status == FleetStatus.HALTED:
        # Circuit breaker is its own event AND a halt — subscribers can
        # listen to just the specific one if they want fewer firings.
        if halt_reason == "circuit_breaker":
            _emit(
                FLEET_CIRCUIT_BREAKER_TRIPPED,
                fleet_circuit_breaker_tripped_payload(
                    failed_count=failed_count,
                    terminal_count=terminal_count,
                    total_count=total,
                    threshold=threshold,
                ),
            )
        in_flight = total - terminal_count
        pending = max(total - len(children), 0)
        _emit(
            FLEET_HALTED,
            fleet_halted_payload(
                halt_reason=halt_reason or "unknown",
                in_flight_count=in_flight,
                pending_count=pending,
            ),
        )


def _settings_path_for_fleet(manifest: dict) -> str:
    """Pick a settings.json path to resolve worca.hooks/webhooks from.

    The fleet manifest doesn't carry a settings reference of its own.
    Every child shares its parent project's settings; we use the first
    child's project root as the conventional source. Falls back to the
    cwd-relative default when no children are registered yet (in which
    case there's nothing meaningful to emit anyway — fleet.launched
    happens after at least one child is registered).
    """
    children = manifest.get("children") or []
    if children:
        project_path = children[0].get("project_path")
        if project_path:
            return os.path.join(project_path, ".claude", "settings.json")
    return ".claude/settings.json"
