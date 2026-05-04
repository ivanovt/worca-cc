"""W-050 Phase 1 — full happy-path integration tests.

End-to-end runs with all stages enabled (plan_review + learn) and every agent
returning success on the first try. Asserts:

- Stage ordering: PLAN → PLAN_REVIEW → COORDINATE → IMPLEMENT → TEST →
  REVIEW → PR → (LEARN runs after the run-completed event).
- ``mloops`` is idle when no loops fire — counters never appear.
- Exactly one ``pipeline.run.completed`` webhook is delivered.
"""
import time

import pytest

from tests.integration.helpers import assert_stage_sequence


pytestmark = pytest.mark.timeout(180)


def _tester_pass() -> dict:
    return {"action": "succeed", "delay_s": 0.05,
            "structured_output": {"passed": True}}


def _review_approve() -> dict:
    return {"action": "succeed", "delay_s": 0.05,
            "structured_output": {"outcome": "approve", "issues": []}}


def _plan_review_approve() -> dict:
    """Plan reviewer outcome — same outcome semantics as the code reviewer."""
    return {"action": "succeed", "delay_s": 0.05,
            "structured_output": {"outcome": "approve", "issues": []}}


def _events_of(events: list, type_: str) -> list:
    return [e for e in events if e.get("event_type") == type_]


def _happy_scenario() -> dict:
    return {
        "agents": {
            "tester": _tester_pass(),
            "reviewer": _review_approve(),
            "plan_reviewer": _plan_review_approve(),
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }


# ===========================================================================
# 1. All stages on with success scenario — full pipeline runs to completion
# ===========================================================================

def test_full_happy_path_all_stages_complete(pipeline_env):
    pipeline_env.enable_stages("plan_review", "learn")
    result = pipeline_env.run(_happy_scenario(), prompt="happy all-stages",
                              timeout=120)
    assert result.returncode == 0, f"stderr: {result.stderr[-500:]}"
    assert result.status["pipeline_status"] == "completed"

    # All stages report status=completed.
    expected = ["plan", "plan_review", "coordinate", "implement",
                "test", "review", "pr", "learn"]
    for stage in expected:
        s = result.status["stages"].get(stage, {})
        assert s.get("status") == "completed", (
            f"stage {stage!r} not completed (got {s.get('status')!r})"
        )


# ===========================================================================
# 2. plan_review fires between PLAN and COORDINATE (positional invariant)
# ===========================================================================

def test_plan_review_runs_between_plan_and_coordinate(pipeline_env):
    pipeline_env.enable_stages("plan_review")
    result = pipeline_env.run(_happy_scenario(), prompt="plan_review pos",
                              timeout=120)
    assert result.returncode == 0
    assert_stage_sequence(
        result.events,
        ["plan", "plan_review", "coordinate", "implement", "test",
         "review", "pr"],
    )


# ===========================================================================
# 3. mloops is idle on the happy path — no loop counters set
# ===========================================================================

def test_mloops_idle_when_all_loops_pass_first_try(pipeline_env):
    """``--mloops 5`` must not change behavior when nothing actually loops."""
    result = pipeline_env.run(_happy_scenario(), prompt="mloops idle",
                              timeout=120, extra_args=["--mloops", "5"])
    assert result.returncode == 0

    counters = result.status.get("loop_counters", {})
    # No loop should have fired even once.
    assert counters.get("implement_test", 0) == 0
    assert counters.get("pr_changes", 0) == 0
    assert counters.get("plan_review", 0) == 0
    assert counters.get("restart_planning", 0) == 0

    # And no LOOP_TRIGGERED events.
    assert _events_of(result.events, "pipeline.loop.triggered") == []


# ===========================================================================
# 4. Exactly one pipeline.run.completed webhook is delivered
# ===========================================================================

def test_exactly_one_run_completed_webhook(pipeline_env, webhook_server):
    pipeline_env.add_webhook(webhook_server.url)
    result = pipeline_env.run(_happy_scenario(), prompt="webhook once",
                              timeout=120)
    assert result.returncode == 0

    # Webhook deliveries are async — wait briefly for them to land.
    deadline = time.time() + 5
    while time.time() < deadline:
        if any(p.get("event_type") == "pipeline.run.completed"
               for p in webhook_server.received):
            break
        time.sleep(0.05)

    completed = [p for p in webhook_server.received
                 if p.get("event_type") == "pipeline.run.completed"]
    assert len(completed) == 1, (
        f"expected 1 run.completed webhook, got {len(completed)}: "
        f"{[p.get('event_type') for p in webhook_server.received]}"
    )
