"""Cross-repo integration test runner (W-047 §5).

After all tiers complete, sets up integration-env worktrees at
{workspace_root}/.worca/integration-env/{repo_name}/ on each child's branch,
executes the workspace.json integration_test.command, and captures output to
integration-test.log. Cleans up worktrees after (pass or fail).
"""
from __future__ import annotations

import os
import shutil
import subprocess

from worca.workspace.manifest import Workspace


def setup_integration_env(
    workspace_root: str,
    children: list[dict],
    workspace: Workspace,
) -> tuple[str, dict[str, str]]:
    """Create git worktrees in integration-env/ for each completed child.

    Returns (env_dir, {repo_name: worktree_path}).
    """
    env_dir = os.path.join(workspace_root, ".worca", "integration-env")
    os.makedirs(env_dir, exist_ok=True)

    repo_paths = {r.name: r.path for r in workspace.repos}
    env_paths: dict[str, str] = {}

    for child in children:
        if child["status"] != "completed" or not child.get("worktree_path"):
            continue

        repo_name = child["repo"]
        worktree_path = child["worktree_path"]

        proc = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            continue
        branch = proc.stdout.strip()

        original_repo = os.path.join(workspace_root, repo_paths[repo_name])
        dest = os.path.join(env_dir, repo_name)

        proc_add = subprocess.run(
            ["git", "worktree", "add", dest, branch],
            cwd=original_repo,
            capture_output=True,
            text=True,
        )
        if proc_add.returncode == 0:
            env_paths[repo_name] = dest

    return env_dir, env_paths


def cleanup_integration_env(
    workspace_root: str,
    env_paths: dict[str, str],
    workspace: Workspace,
) -> None:
    """Remove integration-env worktrees."""
    repo_paths = {r.name: r.path for r in workspace.repos}

    for repo_name, env_path in env_paths.items():
        original_repo = os.path.join(workspace_root, repo_paths[repo_name])
        subprocess.run(
            ["git", "worktree", "remove", "--force", env_path],
            cwd=original_repo,
            capture_output=True,
            text=True,
        )

    env_dir = os.path.join(workspace_root, ".worca", "integration-env")
    shutil.rmtree(env_dir, ignore_errors=True)


def run_integration_test(
    manifest: dict,
    workspace: Workspace,
    run_dir: str,
) -> dict:
    """Run cross-repo integration test phase.

    Returns {"status": "passed"|"failed"|"skipped",
             "exit_code": int|None, "log_path": str|None}.
    """
    result: dict = {"status": "skipped", "exit_code": None, "log_path": None}

    if manifest.get("skip_integration"):
        return result

    if workspace.integration_test is None:
        return result

    workspace_root = manifest["workspace_root"]
    children = manifest["children"]

    env_dir, env_paths = setup_integration_env(workspace_root, children, workspace)

    try:
        cwd = os.path.join(workspace_root, workspace.integration_test.working_dir)

        env = os.environ.copy()
        env["WORCA_INTEGRATION_ENV"] = "1"
        env["WORCA_WORKSPACE_ROOT"] = workspace_root

        log_path = os.path.join(run_dir, "integration-test.log")

        proc = subprocess.run(
            workspace.integration_test.command,
            shell=True,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
        )

        with open(log_path, "w") as f:
            if proc.stdout:
                f.write(proc.stdout)
            if proc.stderr:
                f.write("\n--- stderr ---\n")
                f.write(proc.stderr)

        result["exit_code"] = proc.returncode
        result["log_path"] = log_path
        result["status"] = "passed" if proc.returncode == 0 else "failed"

    finally:
        cleanup_integration_env(workspace_root, env_paths, workspace)

    return result
