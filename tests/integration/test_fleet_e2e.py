"""W-040 Phase 6: E2E fleet tests.

Phase 6.1 (test_fleet_e2e_synthetic_3_repos):
  Dispatches a trivial guide to 3 scratch repos and asserts worktrees,
  pipelines.d/ entries, branches, PRs, and fleet manifest status.

Phase 6.2 (test_fleet_dogfooding_5_repos):
  Real-world fleet of 5 registered projects applying a trivial guide.
  Validates fleet dispatch, worktree isolation, PR creation, dashboard
  grouping (fleet_id/group_type on all 5 entries), and cleanup via
  FleetSource (manifest removal + pipelines.d deregistration).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

MOCK_CLAUDE_BIN = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"
STUBS_DIR = Path(__file__).parent / "stubs"

# All agents succeed; guardian emits PR structured_output (no outcome field so
# the runner skips HEAD-match verification — matches test_guardian_pr_creation.py
# pattern that confirms returncode==0 without a guardian commit).
_FLEET_SCENARIO = {
    "agents": {
        "tester": {
            "action": "succeed",
            "delay_s": 0,
            "structured_output": {"passed": True},
        },
        "guardian": {
            "action": "succeed",
            "delay_s": 0,
            "structured_output": {
                "pr_url": "https://github.com/example/fleet-repo/pull/1",
                "pr_number": 1,
                "commit_sha": "abc1234567890fleet",
                "source_branch": "worca/fleet-branch",
                "target_branch": "main",
                "provider": "github",
            },
        },
    },
    "default": {"action": "succeed", "delay_s": 0},
}


def _setup_repo(path: Path) -> None:
    """Initialise a throwaway git repo with an initial commit + worca runtime."""
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
    subprocess.run(
        [sys.executable, "-m", "worca.cli.main", "init"],
        cwd=str(path),
        check=True,
        capture_output=True,
    )
    # Speed up: disable slow stages and cap max_turns
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
    worktree_path: str, run_id: str, timeout: int = 120
) -> dict:
    """Poll status.json until pipeline_status is terminal. Returns the status dict."""
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
        f"Pipeline {run_id} in {worktree_path!r} did not reach terminal state within {timeout}s"
    )


@pytest.mark.timeout(300)
def test_fleet_e2e_synthetic_3_repos(tmp_path):
    """E2E fleet: 3 scratch repos, trivial guide, all assertions verified.

    This test does NOT go through run_fleet.main() / dispatch_fleet because
    build_child_env strips WORCA_CLAUDE_BIN (reserved prefix).  Instead it
    dispatches run_worktree.py directly for each repo — the same subprocess
    that dispatch_fleet ultimately invokes — so the integration surface is
    identical.  The fleet manifest children array is populated after dispatch
    (the step that run_fleet.main() currently omits, exercised explicitly here).
    """
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
        read_fleet_manifest,
        write_fleet_manifest,
    )

    # ── 1. Set up 3 scratch repos ──────────────────────────────────────────
    repos = [tmp_path / f"repo_{i}" for i in range(3)]
    for repo in repos:
        _setup_repo(repo)

    # ── 2. Guide file + mock scenario ──────────────────────────────────────
    guide = tmp_path / "health_guide.md"
    guide.write_text("# Health Guide\n\nCreate HEALTH.md with content 'OK'.\n")

    scenario_path = tmp_path / "scenario.json"
    scenario_path.write_text(json.dumps(_FLEET_SCENARIO))

    # ── 3. Initial fleet manifest (empty children — populated after dispatch) ─
    fleet_runs_dir = tmp_path / "fleet-runs"
    fleet_runs_dir.mkdir()
    fleet_id, fleet_id_short = generate_fleet_id()

    manifest = {
        "fleet_id": fleet_id,
        "fleet_id_short": fleet_id_short,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "work_request": {"title": "", "description": "Add HEALTH.md", "source": None},
        "guide": {
            "paths": [str(guide)],
            "bytes": guide.stat().st_size,
            "filenames": [guide.name],
            "uploaded": False,
        },
        "plan": {"mode": "none", "path": None},
        "head_template": None,
        "base_branch": None,
        "max_parallel": 3,
        "fleet_failure_threshold": 0.30,
        "status": "running",
        "halt_reason": None,
        "children": [],
    }
    write_fleet_manifest(manifest, base_dir=str(fleet_runs_dir))

    # ── 4. Dispatch: invoke run_worktree.py for each repo with fleet_id ────
    # Direct invocation (not through run_fleet's build_child_env) so
    # WORCA_CLAUDE_BIN survives into the detached pipeline subprocess.
    env = {
        **os.environ,
        "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
        "MOCK_CLAUDE_SCENARIO": str(scenario_path),
        "WORCA_SKIP_BEADS": "1",
        "WORCA_AGENT": "",
        # Prepend stubs dir so the stub `gh` shadows any real gh
        "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
    }

    run_ids: list[str] = []
    worktree_paths: list[str] = []
    children: list[dict] = []

    for repo in repos:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "worca.scripts.run_worktree",
                "--prompt",
                "Add HEALTH.md",
                "--fleet-id",
                fleet_id,
            ],
            cwd=str(repo),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0, (
            f"run_worktree failed for {repo.name}:\n{result.stderr[:600]}"
        )
        lines = result.stdout.strip().splitlines()
        assert len(lines) >= 2, (
            f"run_worktree stdout must be '<run_id>\\n<worktree_path>'; got: {result.stdout!r}"
        )
        run_id = lines[0]
        worktree_path = lines[1]
        run_ids.append(run_id)
        worktree_paths.append(worktree_path)
        children.append({"project_path": str(repo), "run_id": run_id})

    # ── 5. Populate fleet manifest children ────────────────────────────────
    manifest["children"] = children
    write_fleet_manifest(manifest, base_dir=str(fleet_runs_dir))

    # ── 6. Wait for all 3 pipelines to reach a terminal state ──────────────
    final_statuses: list[dict] = []
    for run_id, worktree_path in zip(run_ids, worktree_paths):
        status = _wait_for_pipeline_terminal(worktree_path, run_id, timeout=120)
        final_statuses.append(status)

    # ── Assertions ──────────────────────────────────────────────────────────

    # A1: 3 worktrees created
    for worktree_path in worktree_paths:
        assert Path(worktree_path).is_dir(), (
            f"Expected worktree directory at {worktree_path!r}"
        )

    # A2: 3 pipelines.d/ entries with matching fleet_id and group_type="fleet"
    for repo, run_id in zip(repos, run_ids):
        entry_path = repo / ".worca" / "multi" / "pipelines.d" / f"{run_id}.json"
        assert entry_path.exists(), f"Registry entry missing: {entry_path}"
        entry = json.loads(entry_path.read_text())
        assert entry.get("fleet_id") == fleet_id, (
            f"fleet_id mismatch in {entry_path.name}: "
            f"expected {fleet_id!r}, got {entry.get('fleet_id')!r}"
        )
        assert entry.get("group_type") == "fleet", (
            f"Expected group_type='fleet' in {entry_path.name}, got {entry.get('group_type')!r}"
        )

    # A3: 3 branches (each run_worktree creates worca/<slug>-<run_id>)
    for repo, run_id in zip(repos, run_ids):
        branch_output = subprocess.run(
            ["git", "-C", str(repo), "branch", "--list"],
            capture_output=True,
            text=True,
        ).stdout
        assert run_id in branch_output, (
            f"Expected a branch containing run_id {run_id!r} in {repo.name}; "
            f"branches: {branch_output.strip()!r}"
        )

    # A4: 3 PRs — each pipeline reached "completed" and status["pr"] is populated
    for run_id, status in zip(run_ids, final_statuses):
        assert status.get("pipeline_status") == "completed", (
            f"Pipeline {run_id} did not complete successfully; "
            f"pipeline_status={status.get('pipeline_status')!r}"
        )
        pr = status.get("pr")
        assert pr is not None, (
            f"Expected 'pr' key in status for run {run_id}; "
            f"got keys: {list(status.keys())}"
        )
        assert pr.get("url"), f"PR URL empty for run {run_id}: {pr}"

    # A5: fleet manifest status == "completed"
    # runner.py updates pipelines.d/ entry to "completed" when the pipeline
    # finishes, so poll_and_update_fleet_manifest can derive the final status.
    fleet_status = poll_and_update_fleet_manifest(
        fleet_id, manifest_base_dir=str(fleet_runs_dir)
    )
    assert fleet_status == "completed", (
        f"Expected fleet_status='completed', got {fleet_status!r}"
    )
    final_manifest = read_fleet_manifest(fleet_id, base_dir=str(fleet_runs_dir))
    assert final_manifest is not None
    assert final_manifest["status"] == "completed", (
        f"Fleet manifest status: {final_manifest.get('status')!r}"
    )

    # ── Cleanup worktrees (tmp_path handles repos, but explicit removal avoids ─
    # dangling worktree refs inside the throwaway git repos)
    for repo, worktree_path in zip(repos, worktree_paths):
        subprocess.run(
            ["git", "worktree", "remove", "--force", worktree_path],
            cwd=str(repo),
            capture_output=True,
            timeout=10,
        )


@pytest.mark.timeout(600)
def test_fleet_dogfooding_5_repos(tmp_path):
    """Phase 6.2: Real-world fleet of 5 repos — dispatch, isolation, PRs, grouping, cleanup.

    Extends the 3-repo smoke test to:
      - 5 registered projects (more realistic scale)
      - Full dashboard-grouping assertion: all 5 entries share fleet_id + group_type="fleet"
      - Cleanup via FleetSource: manifest removal + pipelines.d deregistration

    Same dispatch bypass as test_fleet_e2e_synthetic_3_repos: dispatches
    run_worktree.py directly per repo so WORCA_CLAUDE_BIN survives env
    (build_child_env strips it — the dispatch surface is otherwise identical).
    """
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
        read_fleet_manifest,
        write_fleet_manifest,
    )
    from worca.cli.cleanup import FleetSource
    from worca.orchestrator.registry import get_pipeline

    # ── 1. Set up 5 scratch repos ──────────────────────────────────────────
    repos = [tmp_path / f"repo_{i}" for i in range(5)]
    for repo in repos:
        _setup_repo(repo)

    # ── 2. Guide file + mock scenario ──────────────────────────────────────
    guide = tmp_path / "trivial_guide.md"
    guide.write_text("# Trivial Guide\n\nCreate HEALTH.md with content 'OK'.\n")

    scenario_path = tmp_path / "scenario.json"
    scenario_path.write_text(json.dumps(_FLEET_SCENARIO))

    # ── 3. Fleet manifest (empty children — populated after dispatch) ──────
    fleet_runs_dir = tmp_path / "fleet-runs"
    fleet_runs_dir.mkdir()
    fleet_id, fleet_id_short = generate_fleet_id()

    manifest = {
        "fleet_id": fleet_id,
        "fleet_id_short": fleet_id_short,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "work_request": {"title": "", "description": "Add HEALTH.md", "source": None},
        "guide": {
            "paths": [str(guide)],
            "bytes": guide.stat().st_size,
            "filenames": [guide.name],
            "uploaded": False,
        },
        "plan": {"mode": "none", "path": None},
        "head_template": None,
        "base_branch": None,
        "max_parallel": 5,
        "fleet_failure_threshold": 0.30,
        "status": "running",
        "halt_reason": None,
        "children": [],
    }
    write_fleet_manifest(manifest, base_dir=str(fleet_runs_dir))

    # ── 4. Dispatch: invoke run_worktree.py for each of the 5 repos ────────
    env = {
        **os.environ,
        "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
        "MOCK_CLAUDE_SCENARIO": str(scenario_path),
        "WORCA_SKIP_BEADS": "1",
        "WORCA_AGENT": "",
        "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
    }

    run_ids: list[str] = []
    worktree_paths: list[str] = []
    children: list[dict] = []

    for repo in repos:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "worca.scripts.run_worktree",
                "--prompt",
                "Add HEALTH.md",
                "--fleet-id",
                fleet_id,
            ],
            cwd=str(repo),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0, (
            f"run_worktree failed for {repo.name}:\n{result.stderr[:600]}"
        )
        lines = result.stdout.strip().splitlines()
        assert len(lines) >= 2, (
            f"run_worktree stdout must be '<run_id>\\n<worktree_path>'; got: {result.stdout!r}"
        )
        run_id = lines[0]
        worktree_path = lines[1]
        run_ids.append(run_id)
        worktree_paths.append(worktree_path)
        children.append({"project_path": str(repo), "run_id": run_id})

    # ── 5. Populate fleet manifest children ────────────────────────────────
    manifest["children"] = children
    write_fleet_manifest(manifest, base_dir=str(fleet_runs_dir))

    # ── 6. Wait for all 5 pipelines to reach terminal state ────────────────
    final_statuses: list[dict] = []
    for run_id, worktree_path in zip(run_ids, worktree_paths):
        status = _wait_for_pipeline_terminal(worktree_path, run_id, timeout=120)
        final_statuses.append(status)

    # ── Dispatch + isolation assertions ─────────────────────────────────────

    # A1: 5 worktrees created
    for worktree_path in worktree_paths:
        assert Path(worktree_path).is_dir(), (
            f"Expected worktree directory at {worktree_path!r}"
        )

    # A2: 5 pipelines.d/ entries with matching fleet_id + group_type="fleet"
    # (dashboard grouping criterion — all 5 share the same fleet_id)
    for repo, run_id in zip(repos, run_ids):
        entry_path = repo / ".worca" / "multi" / "pipelines.d" / f"{run_id}.json"
        assert entry_path.exists(), f"Registry entry missing: {entry_path}"
        entry = json.loads(entry_path.read_text())
        assert entry.get("fleet_id") == fleet_id, (
            f"fleet_id mismatch in {entry_path.name}: "
            f"expected {fleet_id!r}, got {entry.get('fleet_id')!r}"
        )
        assert entry.get("group_type") == "fleet", (
            f"Expected group_type='fleet' in {entry_path.name}, "
            f"got {entry.get('group_type')!r}"
        )

    # A3: 5 branches (each run_worktree creates worca/<slug>-<run_id>)
    for repo, run_id in zip(repos, run_ids):
        branch_output = subprocess.run(
            ["git", "-C", str(repo), "branch", "--list"],
            capture_output=True,
            text=True,
        ).stdout
        assert run_id in branch_output, (
            f"Expected a branch containing run_id {run_id!r} in {repo.name}; "
            f"branches: {branch_output.strip()!r}"
        )

    # A4: 5 PRs — each pipeline reached "completed" with a pr URL
    for run_id, status in zip(run_ids, final_statuses):
        assert status.get("pipeline_status") == "completed", (
            f"Pipeline {run_id} did not complete; "
            f"pipeline_status={status.get('pipeline_status')!r}"
        )
        pr = status.get("pr")
        assert pr is not None, (
            f"Expected 'pr' key in status for run {run_id}; "
            f"got keys: {list(status.keys())}"
        )
        assert pr.get("url"), f"PR URL empty for run {run_id}: {pr}"

    # A5: fleet manifest status == "completed" (derived from all 5 children)
    fleet_status = poll_and_update_fleet_manifest(
        fleet_id, manifest_base_dir=str(fleet_runs_dir)
    )
    assert fleet_status == "completed", (
        f"Expected fleet_status='completed', got {fleet_status!r}"
    )
    final_manifest = read_fleet_manifest(fleet_id, base_dir=str(fleet_runs_dir))
    assert final_manifest is not None
    assert final_manifest["status"] == "completed"

    # ── A6: Cleanup via FleetSource ─────────────────────────────────────────
    # Verify FleetSource finds the completed fleet as eligible for cleanup.
    fleet_source = FleetSource(fleet_runs_dir=str(fleet_runs_dir))
    eligible = fleet_source.list_eligible({"fleet_id": fleet_id})
    assert len(eligible) == 1, (
        f"Expected 1 eligible fleet entry, got {len(eligible)}: {eligible}"
    )
    cleanup_entry = eligible[0]
    assert cleanup_entry["fleet_id"] == fleet_id

    # Manually remove worktrees first (git worktree remove must run from the
    # owning repo's directory — FleetSource.remove skips dirs that don't exist).
    for repo, worktree_path in zip(repos, worktree_paths):
        subprocess.run(
            ["git", "worktree", "remove", "--force", worktree_path],
            cwd=str(repo),
            capture_output=True,
            timeout=10,
        )

    # With worktrees gone, FleetSource.remove handles deregistration + manifest removal.
    ok = fleet_source.remove(cleanup_entry)
    assert ok, "FleetSource.remove() returned False — cleanup had errors"

    # pipelines.d/ entries deregistered
    for repo, run_id in zip(repos, run_ids):
        entry_path = repo / ".worca" / "multi" / "pipelines.d" / f"{run_id}.json"
        assert not entry_path.exists(), (
            f"Registry entry should be deregistered after cleanup: {entry_path}"
        )
        child_base = str(repo / ".worca")
        assert get_pipeline(run_id, base=child_base) is None, (
            f"get_pipeline({run_id!r}) should return None after deregistration"
        )

    # fleet manifest file removed
    manifest_path = fleet_runs_dir / f"{fleet_id}.json"
    assert not manifest_path.exists(), (
        f"Fleet manifest should be removed after cleanup: {manifest_path}"
    )
