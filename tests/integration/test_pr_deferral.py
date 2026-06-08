"""W-065 integration test: deferred PR creation + CLI promote.

Two-phase test:
1. Full pipeline run with stages.pr.defer:true (mock Claude) — assert:
   - commit lands on branch
   - no pr_url set
   - status.pr_deferred: true
   - pr_title / pr_body / base_branch stashed in stages.pr output
   - pipeline.git.pr_deferred event emitted (not pipeline.git.pr_created)

2. worca pr create <run-id> — assert:
   - PR opened via gh stub
   - status.pr_url set
   - pr_creation.state: "done"
"""
import json
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(180)

STUBS_DIR = Path(__file__).parent / "stubs"

# ---------------------------------------------------------------------------
# Mock scenario
# ---------------------------------------------------------------------------

_DEFERRED_GUARDIAN_SCENARIO = {
    "agents": {
        "tester": {
            "action": "succeed",
            "delay_s": 0.05,
            "structured_output": {"passed": True},
        },
        "guardian": {
            "action": "succeed",
            "delay_s": 0.05,
            "run_command": (
                "git commit --allow-empty -m 'feat: deferred PR implementation'"
            ),
            "structured_output": {
                "outcome": "success",
                "deferred": True,
                "commit_sha": "$HEAD",
                "source_branch": "worca/deferred-pr-test",
                "target_branch": "main",
                "provider": "github",
                "pr_title": "feat: deferred PR implementation",
                "pr_body": "## Summary\n- Added feature\n",
                "base_branch": "main",
            },
        },
    },
    "default": {"action": "succeed", "delay_s": 0.05},
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _enable_defer_pr(settings_path: Path) -> None:
    """Add worca.stages.pr.defer:true to project settings."""
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {}).setdefault("stages", {})
    settings["worca"]["stages"].setdefault("pr", {})["defer"] = True
    settings_path.write_text(json.dumps(settings, indent=2))


def _events_of(events: list, type_: str) -> list:
    return [e for e in events if e.get("event_type") == type_]


def _find_run_status_path(worca_dir: Path, run_id: str) -> Path:
    """Return the actual status.json path for a run_id."""
    return worca_dir / "runs" / run_id / "status.json"


# ---------------------------------------------------------------------------
# Phase 1: pipeline run with stages.pr.defer:true
# ---------------------------------------------------------------------------

def test_deferred_pipeline_completes_successfully(pipeline_env):
    """Pipeline with stages.pr.defer:true should exit 0."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="deferred pr test",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"


def test_deferred_pipeline_sets_pr_deferred_flag(pipeline_env):
    """status.pr_deferred must be True after a deferred PR run."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="deferred pr flag",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"
    assert result.status.get("pr_deferred") is True


def test_deferred_pipeline_no_pr_url(pipeline_env):
    """No pr_url should be set on a deferred run."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="deferred pr no url",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"
    assert result.status.get("pr_url") is None


def test_deferred_pipeline_stashes_pr_fields_in_stage(pipeline_env):
    """stages.pr must carry pr_title / pr_body / base_branch for later CLI promote."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="deferred pr fields",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"

    pr_stage = result.status.get("stages", {}).get("pr", {})
    assert pr_stage.get("deferred") is True, "stages.pr.deferred not set"
    assert pr_stage.get("pr_title") == "feat: deferred PR implementation"
    assert "## Summary" in pr_stage.get("pr_body", "")
    assert pr_stage.get("base_branch") == "main"


def test_deferred_pipeline_emits_git_pr_deferred_event(pipeline_env):
    """pipeline.git.pr_deferred event must be emitted once."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="deferred pr event",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"

    deferred_events = _events_of(result.events, "pipeline.git.pr_deferred")
    assert len(deferred_events) == 1, (
        f"Expected 1 pipeline.git.pr_deferred event, got {len(deferred_events)}"
    )


def test_deferred_pipeline_does_not_emit_pr_created_event(pipeline_env):
    """pipeline.git.pr_created must NOT be emitted on a deferred run."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="deferred pr no created",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"
    assert _events_of(result.events, "pipeline.git.pr_created") == []


# ---------------------------------------------------------------------------
# Phase 2: worca pr create promotes a deferred run to an open PR
# ---------------------------------------------------------------------------

def _register_run_for_cli(pipeline_env, run_id: str, status_json_path: Path) -> None:
    """Register a pipeline entry so 'worca pr create' can resolve it.

    pr.py calls get_pipeline(run_id, base=<project>/.worca) to find the
    worktree_path, then resolves status_path as
    <worktree_path>/.worca/runs/<run_id>/status.json (fixed path).

    We register the project root as worktree_path — pr.py's
    _resolve_status_path then finds the per-run status.json via run_id.
    """
    from worca.orchestrator.registry import register_pipeline

    register_pipeline(
        run_id,
        worktree_path=str(pipeline_env.project),
        title=run_id,
        pid=os.getpid(),
        base=str(pipeline_env.worca_dir),
    )


def _make_gh_responses(pr_url: str = "https://github.com/example/repo/pull/42") -> dict:
    """Canned gh stub responses: no existing PR, then create succeeds."""
    return {
        "pr list": {"stdout": "[]", "exit": 0},
        "pr create": {"stdout": pr_url, "exit": 0},
        "default": {"stdout": "", "exit": 0},
    }


def test_cli_pr_create_exits_zero(pipeline_env, tmp_path):
    """worca pr create exits 0 when PR is successfully created."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="cli pr create exit",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"
    run_id = result.status["run_id"]

    _register_run_for_cli(pipeline_env, run_id, None)

    gh_response_file = tmp_path / "gh_responses.json"
    gh_response_file.write_text(json.dumps(_make_gh_responses()))

    cli_result = pipeline_env.run_cli(
        "pr", "create", run_id,
        "--project", str(pipeline_env.project),
        env_overrides={
            "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
            "WORCA_STUB_GH_RESPONSE_FILE": str(gh_response_file),
            "WORCA_STUB_LOG": str(pipeline_env.stub_log_path),
        },
        timeout=30,
    )
    assert cli_result.returncode == 0, (
        f"worca pr create failed:\nstdout: {cli_result.stdout}\n"
        f"stderr: {cli_result.stderr}"
    )


def test_cli_pr_create_sets_pr_url_in_status(pipeline_env, tmp_path):
    """worca pr create writes pr_url to status.json."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="cli pr url",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"
    run_id = result.status["run_id"]

    _register_run_for_cli(pipeline_env, run_id, None)

    expected_pr_url = "https://github.com/example/repo/pull/42"
    gh_response_file = tmp_path / "gh_responses.json"
    gh_response_file.write_text(json.dumps(_make_gh_responses(expected_pr_url)))

    pipeline_env.run_cli(
        "pr", "create", run_id,
        "--project", str(pipeline_env.project),
        env_overrides={
            "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
            "WORCA_STUB_GH_RESPONSE_FILE": str(gh_response_file),
            "WORCA_STUB_LOG": str(pipeline_env.stub_log_path),
        },
        timeout=30,
    )

    status_path = _find_run_status_path(pipeline_env.worca_dir, run_id)
    updated = json.loads(status_path.read_text())
    assert updated.get("pr_url") == expected_pr_url, (
        f"pr_url not written to status.json: {updated.get('pr_url')!r}"
    )


def test_cli_pr_create_sets_pr_creation_state_done(pipeline_env, tmp_path):
    """worca pr create writes pr_creation.state='done' to status.json."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="cli pr creation state",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"
    run_id = result.status["run_id"]

    _register_run_for_cli(pipeline_env, run_id, None)

    gh_response_file = tmp_path / "gh_responses.json"
    gh_response_file.write_text(json.dumps(_make_gh_responses()))

    pipeline_env.run_cli(
        "pr", "create", run_id,
        "--project", str(pipeline_env.project),
        env_overrides={
            "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
            "WORCA_STUB_GH_RESPONSE_FILE": str(gh_response_file),
            "WORCA_STUB_LOG": str(pipeline_env.stub_log_path),
        },
        timeout=30,
    )

    status_path = _find_run_status_path(pipeline_env.worca_dir, run_id)
    updated = json.loads(status_path.read_text())
    pr_creation = updated.get("pr_creation", {})
    assert pr_creation.get("state") == "done", (
        f"pr_creation.state not 'done': {pr_creation}"
    )


def test_cli_pr_create_calls_gh_pr_create(pipeline_env, tmp_path):
    """worca pr create invokes 'gh pr create' via the stub."""
    _enable_defer_pr(pipeline_env.project / ".claude" / "settings.json")

    result = pipeline_env.run(
        _DEFERRED_GUARDIAN_SCENARIO,
        prompt="cli gh invocation",
        timeout=120,
    )
    assert result.returncode == 0, f"pipeline failed:\n{result.stderr[-500:]}"
    run_id = result.status["run_id"]

    _register_run_for_cli(pipeline_env, run_id, None)

    gh_response_file = tmp_path / "gh_responses.json"
    gh_response_file.write_text(json.dumps(_make_gh_responses()))

    pipeline_env.run_cli(
        "pr", "create", run_id,
        "--project", str(pipeline_env.project),
        env_overrides={
            "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
            "WORCA_STUB_GH_RESPONSE_FILE": str(gh_response_file),
            "WORCA_STUB_LOG": str(pipeline_env.stub_log_path),
        },
        timeout=30,
    )

    # Verify gh stub was called with pr create
    from tests.integration.helpers import read_stub_log
    invocations = read_stub_log(pipeline_env.stub_log_path)
    gh_calls = [i for i in invocations if i.get("binary") == "gh"]
    pr_create_calls = [
        i for i in gh_calls if "pr" in i.get("argv", []) and "create" in i.get("argv", [])
    ]
    assert len(pr_create_calls) >= 1, (
        f"Expected 'gh pr create' to be invoked, got gh calls: {gh_calls}"
    )
