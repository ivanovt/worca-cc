"""Phase 4: Event emission and webhook dispatch tests.

Tests verify that terminal pipeline transitions emit the correct event to
events.jsonl and deliver it to configured webhook endpoints.
"""
import sys

import pytest

from worca.events.types import RUN_CANCELLED, RUN_COMPLETED, RUN_INTERRUPTED
from tests.integration.helpers import (
    run_and_act,
    send_sigterm,
    write_control_stop,
)

# ---------------------------------------------------------------------------
# Shared scenarios
# ---------------------------------------------------------------------------

# Implementer hangs — used for SIGTERM tests (signal kills the subprocess)
_HANGING_SCENARIO = {
    "agents": {
        "planner": {"action": "succeed", "delay_s": 0.1},
        "coordinator": {"action": "succeed", "delay_s": 0.1},
        "implementer": {"action": "hang"},
    },
    "default": {"action": "succeed", "delay_s": 0.1},
}

# Slow coordinator — control file written after plan completes, caught at the
# top of the coordinate iteration before the coordinator agent starts.
_SLOW_COORDINATE_SCENARIO = {
    "agents": {
        "planner": {"action": "succeed", "delay_s": 0.1},
        "coordinator": {"action": "succeed", "delay_s": 2.0},
    },
    "default": {"action": "succeed", "delay_s": 0.1},
}

_ALL_SUCCEED_SCENARIO = {
    "default": {"action": "succeed", "delay_s": 0.1},
}


# ---------------------------------------------------------------------------
# 1. control-stop emits pipeline.run.interrupted to events.jsonl
# ---------------------------------------------------------------------------

def test_control_stop_emits_interrupted_event(pipeline_env):
    result = run_and_act(
        pipeline_env,
        scenario=_SLOW_COORDINATE_SCENARIO,
        action_fn=write_control_stop,
        act_after_stage_completed="plan",
        timeout=20,
    )

    event_types = [e.get("event_type") for e in result.events]
    assert RUN_INTERRUPTED in event_types, (
        f"Expected {RUN_INTERRUPTED!r} in events; got: {event_types}"
    )

    interrupted = next(e for e in result.events if e.get("event_type") == RUN_INTERRUPTED)
    assert "payload" in interrupted
    payload = interrupted["payload"]
    assert "elapsed_ms" in payload


# ---------------------------------------------------------------------------
# 2. control-stop delivers webhook when configured
# ---------------------------------------------------------------------------

def test_control_stop_delivers_webhook(pipeline_env, webhook_server):
    pipeline_env.add_webhook(webhook_server.url)

    run_and_act(
        pipeline_env,
        scenario=_SLOW_COORDINATE_SCENARIO,
        action_fn=write_control_stop,
        act_after_stage_completed="plan",
        timeout=20,
    )

    webhook_types = [w.get("event_type") for w in webhook_server.received]
    assert RUN_INTERRUPTED in webhook_types, (
        f"Expected {RUN_INTERRUPTED!r} in webhook payloads; got: {webhook_types}"
    )


# ---------------------------------------------------------------------------
# 3. SIGTERM emits interrupted event to events.jsonl
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM not available on Windows")
def test_sigterm_emits_interrupted_event(pipeline_env):
    result = run_and_act(
        pipeline_env,
        scenario=_HANGING_SCENARIO,
        action_fn=send_sigterm,
        act_after_stage="implement",
        timeout=20,
    )

    event_types = [e.get("event_type") for e in result.events]
    assert RUN_INTERRUPTED in event_types, (
        f"Expected {RUN_INTERRUPTED!r} in events after SIGTERM; got: {event_types}"
    )

    interrupted = next(e for e in result.events if e.get("event_type") == RUN_INTERRUPTED)
    payload = interrupted.get("payload", {})
    assert "elapsed_ms" in payload


# ---------------------------------------------------------------------------
# 4. Completed pipeline delivers pipeline.run.completed webhook
# ---------------------------------------------------------------------------

def test_completed_pipeline_delivers_webhook(pipeline_env, webhook_server):
    pipeline_env.add_webhook(webhook_server.url)

    pipeline_env.run(scenario=_ALL_SUCCEED_SCENARIO, timeout=60)

    webhook_types = [w.get("event_type") for w in webhook_server.received]
    assert RUN_COMPLETED in webhook_types, (
        f"Expected {RUN_COMPLETED!r} in webhook payloads; got: {webhook_types}"
    )

    completed = next(w for w in webhook_server.received if w.get("event_type") == RUN_COMPLETED)
    assert "payload" in completed
    payload = completed["payload"]
    assert "duration_ms" in payload
    assert "stages_completed" in payload


# ---------------------------------------------------------------------------
# 5. No webhook configured → no delivery attempt, no error
# ---------------------------------------------------------------------------

def test_no_webhook_no_error(pipeline_env, webhook_server):
    # Intentionally do NOT call pipeline_env.add_webhook()
    result = pipeline_env.run(scenario=_ALL_SUCCEED_SCENARIO, timeout=60)

    assert webhook_server.received == [], (
        f"Expected no webhook calls but got: {webhook_server.received}"
    )
    assert result.returncode == 0, f"Pipeline failed unexpectedly: {result.stderr}"


# ---------------------------------------------------------------------------
# 6. cancel → pipeline.run.cancelled webhook (W-043 stub)
# ---------------------------------------------------------------------------

@pytest.mark.skip(reason="requires W-043: cancel action and cancelled state")
def test_cancel_delivers_cancelled_webhook(pipeline_env, webhook_server):
    pipeline_env.add_webhook(webhook_server.url)

    # TODO(W-043): write_control_cancel action + cancelled pipeline state
    run_and_act(
        pipeline_env,
        scenario=_HANGING_SCENARIO,
        action_fn=None,  # replace with write_control_cancel
        act_after_stage="implement",
        timeout=20,
    )

    webhook_types = [w.get("event_type") for w in webhook_server.received]
    assert RUN_CANCELLED in webhook_types
