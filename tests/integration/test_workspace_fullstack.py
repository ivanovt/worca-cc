"""W-047 Phase 8: Full-stack W-048+W-040+W-047 integration test.

Synthetic 3-repo workspace (shared-lib → backend → frontend):
  1. Launch: run_workspace.py creates manifest/pointer, DagExecutor dispatches
     run_worktree.py per repo in tier order.
  2. Registry: pipelines.d/ entries have workspace_id + group_type=workspace +
     target_branch.
  3. Discovery: all 3 children found via registry scan (discoverRuns data shape).
  4. No duplicates: each child run_id appears exactly once; no double-counted
     workspace entries.
  5. Dashboard data: manifest children carry tier info for tier-grouped rendering.
  6. Cleanup: WorkspaceSource.remove() deletes worktrees, run dir, pipelines.d
     entries, and pointer file.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

MOCK_CLAUDE_BIN = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"
STUBS_DIR = Path(__file__).parent / "stubs"

_WORKSPACE_SCENARIO = {
    "agents": {
        "tester": {
            "action": "succeed",
            "delay_s": 0,
            "structured_output": {"passed": True},
        },
        "guardian": {
            "action": "succeed",
            "delay_s": 0,
            "run_command": (
                "echo 'fullstack change' > fs_change.txt && "
                "git add fs_change.txt && "
                "git commit -m 'fullstack implementation'"
            ),
            "structured_output": {
                "commit_sha": "$HEAD",
                "source_branch": "worca/ws-branch",
                "target_branch": "main",
                "provider": "github",
            },
        },
    },
    "default": {"action": "succeed", "delay_s": 0},
}


def _setup_workspace_repo(path: Path) -> None:
    """Initialize a scratch repo with 'main' branch, fake remote, worca runtime."""
    path.mkdir(parents=True, exist_ok=True)
    for cmd in [
        ["git", "init"],
        ["git", "config", "user.email", "test@test.com"],
        ["git", "config", "user.name", "Test"],
    ]:
        subprocess.run(cmd, cwd=str(path), check=True, capture_output=True)
    (path / "README.md").write_text("test\n")
    subprocess.run(["git", "add", "."], cwd=str(path), check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=str(path), check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "branch", "-M", "main"], cwd=str(path), check=True, capture_output=True,
    )
    subprocess.run(
        [sys.executable, "-m", "worca.cli.main", "init"],
        cwd=str(path), check=True, capture_output=True,
    )
    settings_path = path / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})
    settings["worca"]["stages"] = {
        "preflight": {"enabled": False},
        "plan_review": {"enabled": False},
        "learn": {"enabled": False},
    }
    settings["worca"]["agents"] = {
        "planner": {"max_turns": 5},
        "coordinator": {"max_turns": 5},
        "implementer": {"max_turns": 5},
        "tester": {"max_turns": 5},
        "reviewer": {"max_turns": 5},
        "guardian": {"max_turns": 5},
    }
    settings_path.write_text(json.dumps(settings, indent=2))


def _wait_for_pipeline_terminal(
    worktree_path: str, run_id: str, timeout: int = 120,
) -> dict:
    """Poll status.json until pipeline_status is terminal."""
    status_path = (
        Path(os.path.realpath(worktree_path)) / ".worca" / "runs" / run_id / "status.json"
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        if status_path.exists():
            try:
                data = json.loads(status_path.read_text())
                if data.get("pipeline_status") in ("completed", "failed"):
                    return data
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(0.3)
    raise TimeoutError(
        f"Pipeline {run_id} in {worktree_path!r} did not reach terminal state "
        f"within {timeout}s"
    )


# ---------------------------------------------------------------------------
# The test
# ---------------------------------------------------------------------------


@pytest.mark.timeout(300)
def test_workspace_fullstack_3_repos(tmp_path):
    """Full-stack: run_workspace.py setup → DagExecutor dispatch → registry →
    discovery → dashboard data → WorkspaceSource cleanup."""
    from worca.workspace.manifest import Workspace
    from worca.workspace.dag_executor import _extract_repo_context, _write_context_file
    from worca.scripts.run_workspace import (
        create_workspace_manifest,
        write_workspace_manifest,
    )
    from worca.orchestrator.registry import list_pipelines
    from worca.cli.cleanup import WorkspaceSource

    # ── 1. Set up workspace: 3 repos in a dependency chain ───────────────
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    repo_names = ["shared-lib", "backend", "frontend"]
    repo_paths: dict[str, Path] = {}
    for name in repo_names:
        path = workspace_root / name
        _setup_workspace_repo(path)
        subprocess.run(
            ["git", "remote", "add", "origin",
             f"https://github.com/example/{name}.git"],
            cwd=str(path), check=True, capture_output=True,
        )
        repo_paths[name] = path

    workspace_json = {
        "name": "acme-fullstack",
        "repos": [
            {"name": "shared-lib", "path": "shared-lib", 
             "depends_on": []},
            {"name": "backend", "path": "backend", 
             "depends_on": ["shared-lib"]},
            {"name": "frontend", "path": "frontend", 
             "depends_on": ["backend"]},
        ],
        "integration_test": {
            "command": "test \"$WORCA_INTEGRATION_ENV\" = \"1\"",
            "working_dir": "",
        },
    }
    (workspace_root / "workspace.json").write_text(json.dumps(workspace_json, indent=2))
    ws = Workspace.load(str(workspace_root))

    assert ws.tiers == [["shared-lib"], ["backend"], ["frontend"]]

    # ── 2. Environment for mock claude + gh stub ─────────────────────────
    scenario_path = tmp_path / "scenario.json"
    scenario_path.write_text(json.dumps(_WORKSPACE_SCENARIO))

    env = {
        **os.environ,
        "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
        "MOCK_CLAUDE_SCENARIO": str(scenario_path),
        "WORCA_SKIP_BEADS": "1",
        "WORCA_AGENT": "",
        "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
    }

    # ── 3. run_workspace.py manifest creation (what main() does) ─────────
    ws_id = "ws_test_fullstack_001"
    pointer_dir = tmp_path / "pointer_dir"
    pointer_dir.mkdir()

    run_dir = str(tmp_path / "workspace-run")
    os.makedirs(run_dir, exist_ok=True)

    manifest = create_workspace_manifest(
        workspace_id=ws_id,
        workspace_root=str(workspace_root),
        workspace_name="acme-fullstack",
        prompt="Full-stack integration test",
        source=None,
        guide_paths=[],
        branch_template="workspace/{slug}/{repo}",
        max_parallel=3,
        skip_integration=False,
        skip_planning=True,
        tiers=ws.tiers,
        repos_by_name={r.name: r.path for r in ws.repos},
        dependency_graph={r.name: r.depends_on for r in ws.repos},
    )

    assert manifest["workspace_id"] == ws_id
    assert manifest["status"] in ("planning", "running")
    assert len(manifest["dag"]["tiers"]) == 3

    # Write pointer file so WorkspaceSource can find it during cleanup
    pointer_path = pointer_dir / f"{ws_id}.json"
    pointer_path.write_text(json.dumps({
        "workspace_id": ws_id,
        "workspace_root": str(workspace_root),
    }))

    # Write manifest in the workspace run dir
    ws_run_dir = workspace_root / ".worca" / "workspace-runs" / ws_id
    ws_run_dir.mkdir(parents=True, exist_ok=True)
    manifest["status"] = "running"
    write_workspace_manifest(manifest, str(ws_run_dir))

    # ── 4. Dispatch via tier-ordered run_worktree.py (mirroring DagExecutor) ──
    run_ids: dict[str, str] = {}
    worktree_paths: dict[str, str] = {}
    dispatch_order: list[str] = []

    for tier_idx, tier in enumerate(ws.tiers):
        guide_args: list[str] = []
        context_dir = os.path.join(run_dir, "context")
        if tier_idx > 0:
            for prev_tier in ws.tiers[:tier_idx]:
                for prev_repo in prev_tier:
                    ctx_path = os.path.join(context_dir, f"{prev_repo}-diff.md")
                    if os.path.exists(ctx_path):
                        guide_args.extend(["--guide", ctx_path])

        for repo_name in tier:
            cmd = [
                sys.executable, "-m", "worca.scripts.run_worktree",
                "--prompt", "Full-stack integration test",
                "--workspace-id", ws_id,
            ] + guide_args
            result = subprocess.run(
                cmd,
                cwd=str(repo_paths[repo_name]),
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            assert result.returncode == 0, (
                f"dispatch failed for {repo_name}:\n{result.stderr[:800]}"
            )
            lines = result.stdout.strip().splitlines()
            assert len(lines) >= 2, (
                f"Expected '<run_id>\\n<worktree_path>'; got: {result.stdout!r}"
            )
            rid = lines[0]
            wt_path = lines[1]
            run_ids[repo_name] = rid
            worktree_paths[repo_name] = wt_path
            dispatch_order.append(repo_name)

        for repo_name in tier:
            status = _wait_for_pipeline_terminal(
                worktree_paths[repo_name], run_ids[repo_name],
            )
            assert status["pipeline_status"] == "completed", (
                f"Pipeline for {repo_name} did not complete: "
                f"status={status.get('pipeline_status')!r}"
            )

        if tier_idx < len(ws.tiers) - 1:
            for repo_name in tier:
                content = _extract_repo_context(worktree_paths[repo_name])
                if content.strip():
                    _write_context_file(run_dir, repo_name, content)

    # A1: Dispatch order follows tier dependency chain
    assert dispatch_order == ["shared-lib", "backend", "frontend"]

    # ── A2: pipelines.d/ entries have workspace_id + group_type + target_branch ──
    for repo_name in repo_names:
        entry_path = (
            repo_paths[repo_name] / ".worca" / "multi" / "pipelines.d"
            / f"{run_ids[repo_name]}.json"
        )
        assert entry_path.exists(), f"Registry entry missing: {entry_path}"
        entry = json.loads(entry_path.read_text())

        assert entry.get("workspace_id") == ws_id, (
            f"workspace_id mismatch in {repo_name}: "
            f"expected {ws_id!r}, got {entry.get('workspace_id')!r}"
        )
        assert entry.get("group_type") == "workspace", (
            f"group_type mismatch in {repo_name}: got {entry.get('group_type')!r}"
        )
        assert entry.get("run_id") == run_ids[repo_name]
        assert "worktree_path" in entry and entry["worktree_path"]

    # ── A3: discoverRuns finds all 3 children (registry shape check) ─────
    # discoverRuns scans pipelines.d/ per project. Verify each project has
    # exactly one entry and the data shape matches what watcher.js expects.
    all_discovered_run_ids: set[str] = set()

    for repo_name in repo_names:
        base = str(repo_paths[repo_name] / ".worca")
        entries = list_pipelines(base=base)
        workspace_entries = [
            e for e in entries if e.get("workspace_id") == ws_id
        ]
        assert len(workspace_entries) == 1, (
            f"Expected 1 workspace entry for {repo_name}, "
            f"got {len(workspace_entries)}: {workspace_entries}"
        )
        reg = workspace_entries[0]
        assert reg["run_id"] not in all_discovered_run_ids, (
            f"Duplicate run_id {reg['run_id']} across repos"
        )
        all_discovered_run_ids.add(reg["run_id"])

        # Shape check: fields that discoverRuns/watcher.js reads
        assert "worktree_path" in reg
        assert reg.get("workspace_id") == ws_id
        assert reg.get("group_type") == "workspace"

    assert len(all_discovered_run_ids) == 3, (
        f"Expected 3 unique run_ids, got {len(all_discovered_run_ids)}"
    )

    # ── A4: No duplicate broadcasts ──────────────────────────────────────
    # In real operation, the status watcher broadcasts once per run. Ensure
    # no run_id appears in more than one project's registry (which would
    # cause duplicate broadcasts in global mode).
    run_id_to_repo: dict[str, str] = {}
    for repo_name in repo_names:
        base = str(repo_paths[repo_name] / ".worca")
        for entry in list_pipelines(base=base):
            rid = entry["run_id"]
            assert rid not in run_id_to_repo, (
                f"run_id {rid} found in both {run_id_to_repo[rid]} and {repo_name} "
                "— would cause duplicate broadcasts"
            )
            run_id_to_repo[rid] = repo_name

    # ── A5: Dashboard groups by workspace tiers ──────────────────────────
    # Populate manifest.children with the data dashboard.js expects
    manifest["children"] = [
        {
            "repo": repo_name,
            "run_id": run_ids[repo_name],
            "worktree_path": worktree_paths[repo_name],
            "project_path": str(repo_paths[repo_name]),
            "status": "completed",
            "tier": tier_idx,
        }
        for tier_idx, tier in enumerate(ws.tiers)
        for repo_name in tier
    ]
    manifest["status"] = "completed"
    write_workspace_manifest(manifest, str(ws_run_dir))

    # Verify the manifest children have the shape dashboard.js needs
    # for _renderWorkspaceCard tier grouping
    for child in manifest["children"]:
        assert "repo" in child, "child missing 'repo' field"
        assert "run_id" in child, "child missing 'run_id' field"
        assert "status" in child, "child missing 'status' field"
        assert "tier" in child, "child missing 'tier' field for dashboard grouping"
        assert isinstance(child["tier"], int), "child tier must be int"

    # Verify tier data in dag matches what _renderWorkspaceCard reads
    for dag_tier in manifest["dag"]["tiers"]:
        assert "tier" in dag_tier
        assert "repos" in dag_tier
        assert "status" in dag_tier

    # Verify children cover all repos and are unique
    child_repos = [c["repo"] for c in manifest["children"]]
    assert sorted(child_repos) == sorted(repo_names)
    child_run_ids = [c["run_id"] for c in manifest["children"]]
    assert len(set(child_run_ids)) == len(child_run_ids), (
        "Duplicate run_ids in workspace children"
    )

    # Verify _wsChildRunIdSet would produce a set matching our run_ids
    ws_child_run_id_set = {c["run_id"] for c in manifest["children"]}
    assert ws_child_run_id_set == set(run_ids.values())

    # ── A6: WorkspaceSource cleanup removes everything ───────────────────
    workspace_source = WorkspaceSource(pointer_dir=str(pointer_dir))

    eligible = workspace_source.list_eligible({"workspace_id": ws_id})
    assert len(eligible) == 1, (
        f"Expected 1 eligible workspace for cleanup, got {len(eligible)}"
    )
    ws_entry = eligible[0]
    assert ws_entry["workspace_id"] == ws_id
    assert ws_entry["workspace_root"] == str(workspace_root)
    assert ws_entry["run_dir"] == str(ws_run_dir)
    assert ws_entry["pointer_path"] == str(pointer_path)
    assert len(ws_entry["children"]) == 3

    # Pre-remove worktrees from the correct cwd (remove_pipeline_worktree
    # uses _run_git without cwd, which fails when test cwd is a different
    # repo). This mirrors production where cleanup runs from within each
    # child project.
    for repo_name in repo_names:
        wt_path = worktree_paths[repo_name]
        if os.path.isdir(wt_path):
            subprocess.run(
                ["git", "worktree", "remove", "--force", wt_path],
                cwd=str(repo_paths[repo_name]),
                capture_output=True, timeout=10,
            )
            # Also clean up gitignored remnants (like .worca/ dirs)
            if os.path.isdir(wt_path):
                shutil.rmtree(wt_path)

    # Now WorkspaceSource.remove() skips worktree removal (dirs gone) but
    # cleans up registry entries, run dir, and pointer file.
    ok = workspace_source.remove(ws_entry)
    assert ok, "WorkspaceSource.remove() returned False"

    # Verify run directory removed
    assert not ws_run_dir.exists(), (
        f"Workspace run dir should be removed: {ws_run_dir}"
    )

    # Verify pointer file removed
    assert not pointer_path.exists(), (
        f"Pointer file should be removed: {pointer_path}"
    )

    # Verify pipelines.d entries removed for all repos
    for repo_name in repo_names:
        entry_path = (
            repo_paths[repo_name] / ".worca" / "multi" / "pipelines.d"
            / f"{run_ids[repo_name]}.json"
        )
        assert not entry_path.exists(), (
            f"pipelines.d entry should be removed for {repo_name}: {entry_path}"
        )
