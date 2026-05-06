"""W-050 Phase 1 — guardian / PR-stage integration tests.

The guardian agent owns ``git commit`` + ``gh pr create`` invocations — those
shells are inside the agent's tool calls and are mocked away by mock_claude.
What's testable through the mock surface is how the *runner* reacts to
guardian's structured output:

- `pipeline.git.pr_created` is emitted iff structured_output has both
  ``pr_url`` and ``pr_number`` (runner.py:2834-2842).
- The prose-fallback extracts ``pr_url`` / ``pr_number`` from the result text
  when structured_output is missing (runner.py:1065-1068, only for Stage.PR).
- Failure surfaces via the standard run.failed path.
- ``pipeline.git.branch_created`` fires before the PR stage starts.

Real ``gh`` invocation is exercised in Phase 5/6 against the gh stub.
"""
import pytest

from tests.integration.helpers import make_iteration_scenario


pytestmark = pytest.mark.timeout(180)


def _tester_pass() -> dict:
    return {"action": "succeed", "delay_s": 0.05,
            "structured_output": {"passed": True}}


def _events_of(events: list, type_: str) -> list:
    return [e for e in events if e.get("event_type") == type_]


# ===========================================================================
# 1. Guardian emits structured PR fields → GIT_PR_CREATED fires
# ===========================================================================

def test_guardian_structured_pr_fields_emit_pr_created_event(pipeline_env):
    scenario = {
        "agents": {
            "tester": _tester_pass(),
            "guardian": {
                "action": "succeed", "delay_s": 0.05,
                "structured_output": {
                    "pr_url": "https://github.com/example/repo/pull/42",
                    "pr_number": 42,
                    "commit_sha": "abc1234567890def",
                    "source_branch": "feature/test-branch",
                    "target_branch": "main",
                    "provider": "github",
                    "is_draft": False,
                },
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="pr structured", timeout=120)
    assert result.returncode == 0, f"stderr: {result.stderr[-500:]}"

    pr_created = _events_of(result.events, "pipeline.git.pr_created")
    assert len(pr_created) == 1
    payload = pr_created[0]["payload"]
    assert payload["pr_url"] == "https://github.com/example/repo/pull/42"
    assert payload["pr_number"] == 42
    assert payload["commit_sha"] == "abc1234567890def"
    assert payload["source_branch"] == "feature/test-branch"
    assert payload["target_branch"] == "main"
    assert payload["provider"] == "github"
    assert payload["is_draft"] is False


# ===========================================================================
# 2. Prose-fallback extracts pr_url/pr_number when structured_output is absent
# ===========================================================================

def test_guardian_prose_fallback_extracts_pr_url(pipeline_env):
    """When the agent emits prose only, runner.py:1072 recovers PR fields."""
    scenario = {
        "agents": {
            "tester": _tester_pass(),
            "guardian": {
                "action": "succeed", "delay_s": 0.05,
                "result_text": ("Created the PR at "
                                "https://github.com/example/repo/pull/77 "
                                "and pushed the branch."),
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="pr prose", timeout=120)
    assert result.returncode == 0

    pr_created = _events_of(result.events, "pipeline.git.pr_created")
    assert len(pr_created) == 1
    payload = pr_created[0]["payload"]
    assert payload["pr_url"].endswith("/pull/77")
    assert payload["pr_number"] == 77


# ===========================================================================
# 3. Guardian failure → pipeline.run.failed
# ===========================================================================

def test_guardian_failure_surfaces_as_run_failed(pipeline_env):
    scenario = {
        "agents": {
            "tester": _tester_pass(),
            "guardian": {"action": "fail", "delay_s": 0.05,
                         "error": "guardian boom"},
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="pr fail", timeout=120)

    # Guardian failure aborts the pipeline.
    assert result.returncode != 0
    run_failed = _events_of(result.events, "pipeline.run.failed")
    assert len(run_failed) >= 1
    # No PR was created.
    assert _events_of(result.events, "pipeline.git.pr_created") == []


# ===========================================================================
# 4. Branch is created before PR stage runs
# ===========================================================================

def test_branch_created_before_pr_stage(pipeline_env):
    scenario = {
        "agents": {"tester": _tester_pass()},
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="branch order", timeout=120)
    assert result.returncode == 0

    # Find the index of branch_created and pr stage_started events.
    branch_idx = None
    pr_started_idx = None
    for idx, e in enumerate(result.events):
        if branch_idx is None and e.get("event_type") == "pipeline.git.branch_created":
            branch_idx = idx
        if (pr_started_idx is None
                and e.get("event_type") == "pipeline.stage.started"
                and e.get("payload", {}).get("stage") == "pr"):
            pr_started_idx = idx
    assert branch_idx is not None, "no branch_created event found"
    assert pr_started_idx is not None, "no pr stage_started event found"
    assert branch_idx < pr_started_idx, (
        f"branch_created (idx {branch_idx}) must precede pr stage.started "
        f"(idx {pr_started_idx})"
    )


# ===========================================================================
# 5. PR stage iteration recorded with success outcome on happy path
#    (W-050 plan rule #14 — sanity)
# ===========================================================================

def test_pr_stage_iteration_recorded_on_success(pipeline_env):
    """The pr stage should run exactly once and record outcome=success."""
    scenario = make_iteration_scenario({
        "tester": _tester_pass(),
        "guardian": {
            "iter_1": {
                "action": "succeed", "delay_s": 0.05,
                "structured_output": {
                    "pr_url": "https://github.com/example/repo/pull/1",
                    "pr_number": 1,
                    "commit_sha": "deadbeef00000001",
                    "source_branch": "feature/iter-test",
                    "target_branch": "main",
                    "provider": "github",
                    "is_draft": False,
                },
            },
        },
    })
    result = pipeline_env.run(scenario, prompt="pr happy", timeout=120)
    assert result.returncode == 0

    pr_iters = result.status["stages"]["pr"]["iterations"]
    assert len(pr_iters) == 1
    assert pr_iters[0]["outcome"] == "success"
    assert result.status["stages"]["pr"]["status"] == "completed"


# ===========================================================================
# 6. Post-condition verification: pr_verified milestone
# ===========================================================================

def test_pr_verified_milestone_true_when_guardian_commits_and_declares_success(pipeline_env):
    """When guardian commits and emits outcome=success, pr_verified=True in status."""
    scenario = {
        "agents": {
            "tester": _tester_pass(),
            "guardian": {
                "action": "succeed",
                "run_command": "git commit --allow-empty -m 'guardian: created PR'",
                "structured_output": {
                    "outcome": "success",
                    "pr_url": "https://github.com/example/repo/pull/1",
                    "pr_number": 1,
                    "commit_sha": "$HEAD",
                },
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="pr verify pass", timeout=120)
    assert result.returncode == 0, f"stderr: {result.stderr[-500:]}"
    assert result.status.get("milestones", {}).get("pr_verified") is True


def test_pr_verification_retries_then_succeeds_on_second_attempt(pipeline_env):
    """Retry fires when iter_1 fails verification; iter_2 commits and pr_verified=True."""
    scenario = make_iteration_scenario({
        "tester": _tester_pass(),
        "guardian": {
            "iter_1": {
                "action": "succeed", "delay_s": 0.05,
                "structured_output": {
                    "outcome": "success",
                    "pr_url": "https://github.com/example/repo/pull/1",
                    "pr_number": 1,
                    "commit_sha": "abc1234deadbeef",
                },
            },
            "iter_2": {
                "action": "succeed", "delay_s": 0.05,
                "run_command": "git commit --allow-empty -m 'guardian: created PR on retry'",
                "structured_output": {
                    "outcome": "success",
                    "pr_url": "https://github.com/example/repo/pull/1",
                    "pr_number": 1,
                    "commit_sha": "$HEAD",
                },
            },
        },
    })
    result = pipeline_env.run(scenario, prompt="pr retry success", timeout=120)
    assert result.returncode == 0, f"stderr: {result.stderr[-500:]}"
    assert result.status.get("milestones", {}).get("pr_verified") is True

    pr_iters = result.status["stages"]["pr"]["iterations"]
    assert len(pr_iters) == 2, f"expected 2 pr iterations, got {len(pr_iters)}"
    assert pr_iters[0]["outcome"] == "reject", "iter_1 should be rejected by verification"
    assert pr_iters[1]["outcome"] == "success", "iter_2 should succeed"


def test_pr_stage_halts_with_pr_verified_false_when_no_new_commit(pipeline_env):
    """When guardian declares outcome=success but HEAD doesn't change, pipeline halts."""
    scenario = {
        "agents": {
            "tester": _tester_pass(),
            "guardian": {
                "action": "succeed", "delay_s": 0.05,
                "structured_output": {
                    "outcome": "success",
                    "pr_url": "https://github.com/example/repo/pull/1",
                    "pr_number": 1,
                    "commit_sha": "abc1234deadbeef",
                },
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="pr verify fail", timeout=120)
    assert result.returncode != 0, "expected pipeline to fail but it succeeded"
    assert result.status.get("milestones", {}).get("pr_verified") is False
    assert result.status.get("pipeline_status") == "failed"


# ===========================================================================
# 9. All PR metadata fields are persisted to status["pr"]
# ===========================================================================

def test_guardian_pr_metadata_persisted_in_status(pipeline_env):
    """All new PR metadata fields from structured_output are written to status['pr']."""
    scenario = {
        "agents": {
            "tester": _tester_pass(),
            "guardian": {
                "action": "succeed", "delay_s": 0.05,
                "structured_output": {
                    "pr_url": "https://github.com/example/repo/pull/99",
                    "pr_number": 99,
                    "commit_sha": "cafebabe12345678",
                    "source_branch": "feature/my-feature",
                    "target_branch": "main",
                    "provider": "github",
                    "is_draft": False,
                },
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="pr metadata persistence", timeout=120)
    assert result.returncode == 0, f"stderr: {result.stderr[-500:]}"

    pr = result.status.get("pr")
    assert pr is not None, "status['pr'] should be populated after successful PR stage"
    assert pr["url"] == "https://github.com/example/repo/pull/99"
    assert pr["number"] == 99
    assert pr["commit_sha"] == "cafebabe12345678"
    assert pr["source_branch"] == "feature/my-feature"
    assert pr["target_branch"] == "main"
    assert pr["provider"] == "github"
    assert pr["is_draft"] is False
