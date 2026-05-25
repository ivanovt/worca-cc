"""W-047 Phase 8: E2E workspace integration test — 3-repo dependency chain.

Synthetic 3-repo workspace: shared-lib → backend → frontend.
  Tier 0: shared-lib (no deps)
  Tier 1: backend (depends on shared-lib)
  Tier 2: frontend (depends on backend)

Dispatches children in tier order via run_worktree.py (same bypass as
test_fleet_e2e_synthetic_3_repos — DagExecutor's _build_child_env strips
WORCA_CLAUDE_BIN). Tier-ordered dispatch + context injection exercised
explicitly.

Assertions:
  A1: 3 tiers execute in dependency order (0 → 1 → 2)
  A2: Context artifacts generated between tiers (shared-lib → backend context)
  A3: Integration test runs and passes
  A4: 3 PRs created with dependency comments
  A5: Umbrella issue created linking all 3 PRs in merge order
  A6: Registry entries have workspace_id and group_type="workspace"
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

MOCK_CLAUDE_BIN = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"
STUBS_DIR = Path(__file__).parent / "stubs"

# All agents succeed. Guardian creates a real git commit via run_command so
# there is a diff for context extraction (git diff main..HEAD). The tester
# returns structured_output with passed=True. No pr_url — workspace children
# defer PR creation (WORCA_DEFER_PR=1 in the real flow); the PR linker
# creates PRs centrally after integration tests pass.
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
                "echo 'workspace change' > ws_change.txt && "
                "git add ws_change.txt && "
                "git commit -m 'workspace implementation'"
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
    """Initialize a scratch repo with 'main' branch, fake remote, worca runtime, fast settings."""
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
        ["git", "commit", "-m", "init"], cwd=str(path), check=True, capture_output=True
    )
    # Context extraction uses git diff main..HEAD — ensure default branch is "main"
    subprocess.run(
        ["git", "branch", "-M", "main"], cwd=str(path), check=True, capture_output=True
    )
    subprocess.run(
        [sys.executable, "-m", "worca.cli.main", "init"],
        cwd=str(path),
        check=True,
        capture_output=True,
        env={**os.environ, "WORCA_SKIP_BEADS": "1"},
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


@pytest.mark.timeout(300)
def test_workspace_e2e_3_repos(tmp_path):
    """E2E workspace: shared-lib → backend → frontend.

    3 tiers in order, context injection between tiers, integration test,
    3 PRs with dependency comments, umbrella issue.

    Same dispatch bypass as test_fleet_e2e_synthetic_3_repos: dispatches
    run_worktree.py directly per repo so WORCA_CLAUDE_BIN survives env
    (DagExecutor's _build_child_env strips WORCA_* — the dispatch surface
    is otherwise identical).
    """
    from worca.workspace.dag_executor import _extract_project_context, _write_context_file
    from worca.workspace.integration_test import run_integration_test
    from worca.workspace.manifest import Workspace
    from worca.workspace.pr_linker import link_workspace_prs
    from worca.scripts.run_workspace import create_workspace_manifest

    # ── 1. Set up workspace: 3 repos in a dependency chain ────────────────
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

    # ── 2. workspace.json ─────────────────────────────────────────────────
    workspace_json = {
        "name": "acme-platform",
        "projects": [
            {
                "name": "shared-lib",
                "path": "shared-lib",
                
                "depends_on": [],
            },
            {
                "name": "backend",
                "path": "backend",
                
                "depends_on": ["shared-lib"],
            },
            {
                "name": "frontend",
                "path": "frontend",
                
                "depends_on": ["backend"],
            },
        ],
        "integration_test": {
            "command": "test \"$WORCA_INTEGRATION_ENV\" = \"1\"",
            "working_dir": "",
        },
        "umbrella_repo": "example/shared-lib",
    }
    (workspace_root / "workspace.json").write_text(json.dumps(workspace_json, indent=2))

    ws = Workspace.load(str(workspace_root))

    # A1 (part 1): tier computation is correct for the linear chain
    assert ws.tiers == [["shared-lib"], ["backend"], ["frontend"]]

    # ── 3. Scenario + gh stub responses + environment ─────────────────────
    scenario_path = tmp_path / "scenario.json"
    scenario_path.write_text(json.dumps(_WORKSPACE_SCENARIO))

    stub_log_path = tmp_path / "stub_log.jsonl"
    gh_response_file = tmp_path / "gh_responses.json"
    gh_responses = {
        "auth status": {"stdout": "Logged in to github.com", "exit": 0},
        "pr create --repo example/shared-lib": {
            "stdout": "https://github.com/example/shared-lib/pull/1",
            "exit": 0,
        },
        "pr create --repo example/backend": {
            "stdout": "https://github.com/example/backend/pull/2",
            "exit": 0,
        },
        "pr create --repo example/frontend": {
            "stdout": "https://github.com/example/frontend/pull/3",
            "exit": 0,
        },
        "pr comment": {"stdout": "", "exit": 0},
        "issue create": {
            "stdout": "https://github.com/example/shared-lib/issues/10",
            "exit": 0,
        },
        "default": {"stdout": "", "exit": 0},
    }
    gh_response_file.write_text(json.dumps(gh_responses))

    env = {
        **os.environ,
        "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
        "MOCK_CLAUDE_SCENARIO": str(scenario_path),
        "WORCA_SKIP_BEADS": "1",
        "WORCA_AGENT": "",
        "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
        "WORCA_STUB_GH_RESPONSE_FILE": str(gh_response_file),
        "WORCA_STUB_LOG": str(stub_log_path),
    }

    ws_id = "ws_test_abc12345"
    run_dir = str(tmp_path / "workspace-run")
    os.makedirs(run_dir, exist_ok=True)

    # ── 4. Dispatch tiers in dependency order ─────────────────────────────
    # Each tier has exactly one repo (linear chain), dispatched sequentially.
    # Between tiers, context artifacts are extracted and injected as --guide
    # to downstream repos — mirroring DagExecutor's tier-ordered dispatch.
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
                "--prompt", "Implement workspace changes",
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
                f"stdout must be '<run_id>\\n<worktree_path>'; "
                f"got: {result.stdout!r}"
            )
            run_id = lines[0]
            wt_path = lines[1]
            run_ids[repo_name] = run_id
            worktree_paths[repo_name] = wt_path
            dispatch_order.append(repo_name)

        # Wait for this tier to complete before dispatching the next
        for repo_name in tier:
            status = _wait_for_pipeline_terminal(
                worktree_paths[repo_name], run_ids[repo_name],
            )
            assert status["pipeline_status"] == "completed", (
                f"Pipeline for {repo_name} did not complete: "
                f"status={status.get('pipeline_status')!r}"
            )

        # Extract context artifacts for downstream tiers
        if tier_idx < len(ws.tiers) - 1:
            for repo_name in tier:
                content = _extract_project_context(worktree_paths[repo_name])
                if content.strip():
                    _write_context_file(run_dir, repo_name, content)

    # ── Assertions ────────────────────────────────────────────────────────

    # A1: Tiers execute in dependency order
    assert dispatch_order == ["shared-lib", "backend", "frontend"], (
        f"Dispatch order mismatch: {dispatch_order}"
    )

    # A2: Context artifacts generated between tiers
    context_dir_path = Path(run_dir) / "context"
    shared_lib_ctx_path = context_dir_path / "shared-lib-diff.md"
    assert shared_lib_ctx_path.exists(), (
        "Context artifact for shared-lib not generated — "
        "guardian run_command may not have created a commit"
    )
    shared_lib_ctx = shared_lib_ctx_path.read_text()
    assert "ws_change.txt" in shared_lib_ctx, (
        f"shared-lib context should reference ws_change.txt from guardian commit;\n"
        f"content: {shared_lib_ctx[:500]}"
    )
    backend_ctx_path = context_dir_path / "backend-diff.md"
    assert backend_ctx_path.exists(), (
        "Context artifact for backend not generated"
    )

    # A3: Integration test runs and passes
    manifest = create_workspace_manifest(
        workspace_id=ws_id,
        workspace_root=str(workspace_root),
        workspace_name="acme-platform",
        prompt="Implement workspace changes",
        source=None,
        guide_paths=[],
        branch_template="workspace/{slug}/{repo}",
        max_parallel=3,
        skip_integration=False,
        skip_planning=True,
        tiers=ws.tiers,
        projects_by_name={r.name: r.path for r in ws.projects},
        dependency_graph={r.name: r.depends_on for r in ws.projects},
    )
    manifest["children"] = [
        {
            "project": repo_name,
            "run_id": run_ids[repo_name],
            "worktree_path": worktree_paths[repo_name],
            "status": "completed",
            "tier": tier_idx,
        }
        for tier_idx, tier in enumerate(ws.tiers)
        for repo_name in tier
    ]

    it_result = run_integration_test(manifest, ws, run_dir)
    assert it_result["status"] == "passed", (
        f"Integration test should pass: {it_result}"
    )
    assert it_result["exit_code"] == 0
    assert it_result["log_path"] is not None
    assert Path(it_result["log_path"]).exists()

    # A4 + A5: PR creation, dependency comments, umbrella issue
    # Set up env so subprocess.run("gh ...") finds the stub
    old_env: dict[str, str | None] = {}
    env_overrides = {
        "WORCA_STUB_GH_RESPONSE_FILE": str(gh_response_file),
        "WORCA_STUB_LOG": str(stub_log_path),
        "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
    }
    for key, value in env_overrides.items():
        old_env[key] = os.environ.get(key)
        os.environ[key] = value

    try:
        link_workspace_prs(manifest, ws, run_dir)
    finally:
        for key, old_value in old_env.items():
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old_value

    # A4: 3 PRs created
    pr_children = [c for c in manifest["children"] if c.get("pr_url")]
    assert len(pr_children) == 3, (
        f"Expected 3 PRs, got {len(pr_children)}: "
        f"{[(c['repo'], c.get('pr_url')) for c in manifest['children']]}"
    )
    pr_map = {c["project"]: c for c in pr_children}
    assert pr_map["shared-lib"]["pr_number"] == 1
    assert pr_map["backend"]["pr_number"] == 2
    assert pr_map["frontend"]["pr_number"] == 3
    assert pr_map["shared-lib"]["nwo"] == "example/shared-lib"
    assert pr_map["backend"]["nwo"] == "example/backend"
    assert pr_map["frontend"]["nwo"] == "example/frontend"

    # A5: Umbrella issue created
    assert manifest.get("umbrella_issue") is not None, "Umbrella issue not created"
    assert "issues/10" in manifest["umbrella_issue"]["url"]

    # A6: Registry entries have workspace_id and group_type="workspace"
    for repo_name in repo_names:
        entry_path = (
            repo_paths[repo_name] / ".worca" / "multi" / "pipelines.d"
            / f"{run_ids[repo_name]}.json"
        )
        assert entry_path.exists(), f"Registry entry missing: {entry_path}"
        entry = json.loads(entry_path.read_text())
        assert entry.get("workspace_id") == ws_id, (
            f"workspace_id mismatch in {entry_path.name}: "
            f"expected {ws_id!r}, got {entry.get('workspace_id')!r}"
        )
        assert entry.get("group_type") == "workspace", (
            f"Expected group_type='workspace' in {entry_path.name}, "
            f"got {entry.get('group_type')!r}"
        )

    # ── Verify stub log: dependency comments + umbrella issue ─────────────
    assert stub_log_path.exists(), "gh stub log not created"
    stub_records = [
        json.loads(line) for line in stub_log_path.read_text().splitlines()
        if line.strip()
    ]
    gh_records = [r for r in stub_records if r.get("binary") == "gh"]
    pr_create_calls = [
        r for r in gh_records
        if len(r["argv"]) >= 2 and r["argv"][0] == "pr" and r["argv"][1] == "create"
    ]
    pr_comment_calls = [
        r for r in gh_records
        if len(r["argv"]) >= 2 and r["argv"][0] == "pr" and r["argv"][1] == "comment"
    ]
    issue_create_calls = [
        r for r in gh_records
        if len(r["argv"]) >= 2 and r["argv"][0] == "issue" and r["argv"][1] == "create"
    ]

    assert len(pr_create_calls) == 3, (
        f"Expected 3 'gh pr create' calls, got {len(pr_create_calls)}: {pr_create_calls}"
    )
    assert len(pr_comment_calls) == 3, (
        f"Expected 3 'gh pr comment' calls, got {len(pr_comment_calls)}: {pr_comment_calls}"
    )
    assert len(issue_create_calls) == 1, (
        f"Expected 1 'gh issue create' call, got {len(issue_create_calls)}: {issue_create_calls}"
    )

    # ── Cleanup worktrees ─────────────────────────────────────────────────
    for repo_name in repo_names:
        subprocess.run(
            ["git", "worktree", "remove", "--force", worktree_paths[repo_name]],
            cwd=str(repo_paths[repo_name]),
            capture_output=True,
            timeout=10,
        )
