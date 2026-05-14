"""Fleet manifest storage and status polling (W-040 §10).

Manifests live at ~/.worca/fleet-runs/<fleet_id>.json.
Per-child pipeline state stays in each project's pipelines.d/ — not duplicated here.
"""

import json
import os
import secrets
import tempfile
from datetime import datetime, timezone


_FLEET_RUNS_DIR = os.path.expanduser("~/.worca/fleet-runs")

_RUNNING_STATES = frozenset({"running", "resuming", "paused"})
_FAILURE_STATES = frozenset({"failed", "setup_failed", "unrecoverable"})
# `interrupted` / `cancelled` are terminal-but-not-completed child states.
# They must be in _TERMINAL_STATES so a fleet whose children include one
# can still reach a terminal status — otherwise `derive_fleet_status`
# never sees `terminal_count == total` and the fleet is stuck "running"
# forever. They are deliberately NOT in _FAILURE_STATES: a user-stopped
# child shouldn't inflate the circuit-breaker failure ratio. The fleet
# still derives as `failed` (not `completed`) because completed_count
# won't equal total.
_TERMINAL_STATES = (
    frozenset({"completed", "interrupted", "cancelled"}) | _FAILURE_STATES
)


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
        base_dir = _FLEET_RUNS_DIR
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

    children.append(
        {"project_path": project_path, "run_id": run_id, "status": "running"}
    )
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
        return "running", None

    total = len(child_statuses)
    running_count = sum(1 for s in child_statuses if s in _RUNNING_STATES)
    completed_count = sum(1 for s in child_statuses if s == "completed")
    failed_count = sum(1 for s in child_statuses if s in _FAILURE_STATES)
    terminal_count = sum(1 for s in child_statuses if s in _TERMINAL_STATES)

    # Circuit-breaker fires only while in-flight children exist — no point halting
    # if there are no more children to protect from launching.
    if running_count > 0:
        min_terminal = min(3, total)
        if terminal_count >= min_terminal and failed_count > 0:
            failure_ratio = failed_count / terminal_count
            if failure_ratio >= threshold:
                return "halted", "circuit_breaker"
        return "running", None

    # All dispatched children are in a terminal state
    if terminal_count == total:
        if completed_count == total:
            return "completed", None
        return "failed", None

    # Pending/untracked children not yet dispatched
    return "running", None


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

    current_status = manifest.get("status", "running")
    # Preserve sticky operator states — both stay put until an explicit resume:
    #   - "halted":  Halt (in-flight finished naturally) or Stop (in-flight
    #                killed, halt_reason="stopped"), plus circuit_breaker.
    #   - "paused":  Pause — every in-flight child received a pause control
    #                file. Children may still be transitioning to paused, so
    #                re-deriving here would race the manifest back to "running".
    if current_status in ("halted", "paused"):
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
            child_statuses.append(entry.get("status", "running"))
        except (json.JSONDecodeError, OSError):
            child_statuses.append("running")

    new_status, halt_reason = derive_fleet_status(child_statuses, threshold=threshold)

    if new_status != current_status or halt_reason is not None:
        update_fleet_status(
            fleet_id,
            new_status,
            halt_reason=halt_reason,
            base_dir=manifest_base_dir,
        )

    return new_status
