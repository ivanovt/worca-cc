"""Workspace-level lifecycle actions: halt.

A workspace halt lets in-flight tier children finish naturally (no kill
signal or control file), marks pending tiers as halted, and stamps the
manifest with the appropriate halt_reason:

  halt_workspace  -> status="halted", halt_reason="user" (manual halt)
                     pending tier children get halted entries

The circuit breaker auto-halt (halt_reason="circuit_breaker") is handled
inline by DagExecutor._halt_remaining_tiers — it fires during dispatch,
not via this module.
"""
from __future__ import annotations

from worca.state.status import WorkspaceStatus, WORKSPACE_TERMINAL

_HALTABLE = frozenset({
    WorkspaceStatus.RUNNING,
    WorkspaceStatus.PLANNING,
    WorkspaceStatus.INTEGRATION_TESTING,
})


def halt_workspace(
    workspace_id: str,
    *,
    pointer_dir: str | None = None,
) -> bool:
    """Halt a workspace run. In-flight tier children finish naturally.

    Sets status to 'halted' and halt_reason to 'user'. Pending tiers
    are marked halted and their projects get halted child entries.

    Returns True on success, False when the manifest is missing or the
    workspace is already in a terminal/halted state.
    """
    from worca.scripts.run_workspace import (
        load_workspace_manifest,
        write_workspace_manifest,
    )

    kwargs = {}
    if pointer_dir is not None:
        kwargs["pointer_dir"] = pointer_dir

    manifest = load_workspace_manifest(workspace_id, **kwargs)
    if manifest is None:
        return False

    status = manifest.get("status", "")
    if status in WORKSPACE_TERMINAL:
        return False

    manifest["status"] = WorkspaceStatus.HALTED
    manifest["halt_reason"] = "user"

    existing_projects = {c["project"] for c in manifest.get("children", [])}

    for tier_info in manifest.get("dag", {}).get("tiers", []):
        if tier_info["status"] == "pending":
            tier_info["status"] = "halted"
            for project in tier_info["projects"]:
                if project not in existing_projects:
                    manifest["children"].append({
                        "project": project,
                        "run_id": None,
                        "worktree_path": None,
                        "status": "halted",
                        "tier": tier_info["tier"],
                    })

    ws_root = manifest.get("workspace_root", "")
    import os
    run_dir = os.path.join(
        ws_root, ".worca", "workspace-runs", workspace_id,
    )
    write_workspace_manifest(manifest, run_dir)

    return True
