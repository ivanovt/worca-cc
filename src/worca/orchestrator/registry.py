"""Pipeline registry -- directory-based tracking of parallel pipeline instances.

Each pipeline writes its own status file to .worca/multi/pipelines.d/{run_id}.json.
Atomic writes via temp+rename. No file locking needed.
"""

import errno
import json
import os
import tempfile
from datetime import datetime, timezone

from worca.state.status import PipelineStatus


_DEFAULT_BASE = ".worca"


def _registry_dir(base=_DEFAULT_BASE):
    """Return the path to the pipelines.d directory, creating it if needed."""
    d = os.path.join(base, "multi", "pipelines.d")
    os.makedirs(d, exist_ok=True)
    return d


def _pipeline_path(run_id, base=_DEFAULT_BASE):
    """Return the path to a pipeline's registry file."""
    return os.path.join(_registry_dir(base), run_id + ".json")


def _atomic_write(path, data):
    """Write data dict as JSON using temp file + os.replace for atomicity."""
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(dir=parent, prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def register_pipeline(
    run_id,
    worktree_path,
    title,
    pid,
    base=_DEFAULT_BASE,
    *,
    branch=None,
    fleet_id=None,
    workspace_id=None,
    group_type=None,
    target_branch=None,
):
    """Register a new pipeline. Returns the path to the registry file.

    Creates .worca/multi/pipelines.d/{run_id}.json with pipeline metadata.
    Uses atomic writes (temp file + os.replace).

    branch: the worktree's own branch name (e.g. "worca/<slug>-<run_id>") —
    stored so the Worktrees UI can show it without reading the worktree's
    status.json. Distinct from target_branch (the PR base branch).

    fleet_id and workspace_id are mutually exclusive; pass at most one.
    """
    if fleet_id is not None and workspace_id is not None:
        raise ValueError("fleet_id and workspace_id are mutually exclusive; pass at most one")

    now = datetime.now(timezone.utc).isoformat()
    data = {
        "run_id": run_id,
        "worktree_path": worktree_path,
        "title": title,
        "pid": pid,
        "status": PipelineStatus.RUNNING,
        "started_at": now,
        "updated_at": now,
    }
    if branch is not None:
        data["branch"] = branch
    if fleet_id is not None:
        data["fleet_id"] = fleet_id
    if workspace_id is not None:
        data["workspace_id"] = workspace_id
    if group_type is not None:
        data["group_type"] = group_type
    if target_branch is not None:
        data["target_branch"] = target_branch

    path = _pipeline_path(run_id, base=base)
    _atomic_write(path, data)
    return path


def update_pipeline(run_id, status=None, *, pid=None, base=_DEFAULT_BASE):
    """Update terminal status (and/or pid) on an existing pipeline entry.

    Returns True on success, False if the registry file does not exist.

    The registry is a pointer (run_id → worktree_path + pid), not a state
    mirror. Per-stage transitions live in the worktree's status.json; the
    registry is only updated for terminal lifecycle changes (completed,
    failed) or to correct the pid (see below).

    ``pid`` was added to fix a stale-pid race: run_worktree.py registers
    itself with its *own* PID before forking into run_pipeline.py and
    exiting, so the recorded PID is dead by the time the reconciler
    polls. The live runner now calls update_pipeline(..., pid=os.getpid())
    once on startup so subsequent stale_pid checks find a live process.

    Note: The read-modify-write cycle is not atomic across concurrent callers.
    Each pipeline has its own run_id file, and the orchestrator processes
    completions sequentially via as_completed(); do not call concurrently
    for the same run_id without external locking.
    """
    path = _pipeline_path(run_id, base=base)
    if not os.path.exists(path):
        return False

    with open(path) as f:
        data = json.load(f)

    if status is not None:
        data["status"] = status
    if pid is not None:
        data["pid"] = pid
    data["updated_at"] = datetime.now(timezone.utc).isoformat()

    _atomic_write(path, data)
    return True


def deregister_pipeline(run_id, base=_DEFAULT_BASE):
    """Remove a pipeline's registry file. Returns True if file existed."""
    path = _pipeline_path(run_id, base=base)
    try:
        os.unlink(path)
        return True
    except FileNotFoundError:
        return False


def list_pipelines(base=_DEFAULT_BASE):
    """List all registered pipelines by scanning pipelines.d/. Returns list of dicts.

    Silently skips files with malformed JSON.
    """
    d = _registry_dir(base)
    results = []
    for fname in sorted(os.listdir(d)):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(d, fname)
        try:
            with open(fpath) as f:
                data = json.load(f)
            results.append(data)
        except (json.JSONDecodeError, OSError):
            continue
    return results


def get_pipeline(run_id, base=_DEFAULT_BASE):
    """Get a single pipeline entry by run_id. Returns None if not found."""
    path = _pipeline_path(run_id, base=base)
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def reconcile_stale(base=_DEFAULT_BASE):
    """Check PID liveness for running pipelines and mark dead ones as stale.

    Scans all registered pipelines. For each with status "running", checks
    whether the PID is still alive using os.kill(pid, 0). If the process is
    dead, updates the pipeline status to "failed" with a note field
    "stale - process not running".

    Skips processes that exist but are owned by another user (EPERM).
    Silently skips entries without a pid field.

    Returns a list of run_ids that were marked as stale.
    """
    stale_ids = []
    for entry in list_pipelines(base=base):
        if entry.get("status") != PipelineStatus.RUNNING:
            continue
        pid = entry.get("pid")
        if pid is None:
            continue
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pass  # Process does not exist — fall through to mark stale
        except OSError as e:
            if e.errno == errno.EPERM:
                continue  # Process exists but owned by another user — skip
            # Other OS errors — fall through to mark stale
        else:
            continue  # Process is alive — skip

        # Process is dead — mark as stale
        run_id = entry["run_id"]
        path = _pipeline_path(run_id, base=base)
        entry["status"] = PipelineStatus.FAILED
        entry["note"] = "stale - process not running"
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        _atomic_write(path, entry)
        stale_ids.append(run_id)
    return stale_ids


def reconcile_orphan_groups(base=_DEFAULT_BASE, *, fleet_manifest_base_dir=None, workspace_pointer_dir=None):
    """Strip fleet_id/group_type from registry entries whose fleet manifest is gone.

    For each entry with a fleet_id, checks whether
    ~/.worca/fleet-runs/<fleet_id>.json exists. If the manifest is missing,
    removes fleet_id and group_type from the entry and writes it back atomically.

    Returns a list of run_ids whose group context was stripped.
    """
    from worca.orchestrator.fleet_manifest import fleet_manifest_path  # local import avoids circular-import risk

    orphaned_ids = []
    for entry in list_pipelines(base=base):
        fleet_id = entry.get("fleet_id")
        if not fleet_id:
            continue
        if os.path.exists(fleet_manifest_path(fleet_id, base_dir=fleet_manifest_base_dir)):
            continue
        run_id = entry["run_id"]
        entry.pop("fleet_id", None)
        entry.pop("group_type", None)
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        _atomic_write(_pipeline_path(run_id, base=base), entry)
        orphaned_ids.append(run_id)
    if workspace_pointer_dir is None:
        workspace_pointer_dir = os.path.expanduser("~/.worca/workspace-runs")
    for entry in list_pipelines(base=base):
        workspace_id = entry.get("workspace_id")
        if not workspace_id:
            continue
        pointer_path = os.path.join(workspace_pointer_dir, f"{workspace_id}.json")
        if os.path.exists(pointer_path):
            continue
        run_id = entry["run_id"]
        entry.pop("workspace_id", None)
        entry.pop("group_type", None)
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        _atomic_write(_pipeline_path(run_id, base=base), entry)
        orphaned_ids.append(run_id)
    return orphaned_ids
