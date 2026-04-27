"""Phase 5: Edge case tests for signal handling, paused state, and disabled stages.

Tests:
1. SIGTERM kills a hanging agent subprocess (signal forwarded through process group)
2. Double SIGTERM — exactly one pipeline.run.interrupted event emitted
3. Control-file stop written to a paused run — paused state is preserved (no reader)
4. Signal mid-stage-transition — clean interrupted, no duplicate events or corruption
5. Pipeline with most stages disabled (only plan runs) — completes successfully
"""
import json
import os
import signal
import subprocess
import sys
import time

import pytest

from worca.events.types import RUN_INTERRUPTED
from tests.integration.helpers import (
    _find_latest_run_id,
    _find_latest_status,
    _read_events_jsonl,
    _wait_for_stage,
    _wait_for_stage_completed,
    run_and_act,
    send_sigterm,
    write_control_pause,
)

# ---------------------------------------------------------------------------
# Shared scenarios
# ---------------------------------------------------------------------------

# Planner hangs — used to test signal forwarding to a blocking subprocess
# at a stage before implement, so it's distinct from the transition tests.
_HANG_AT_PLAN = {
    "agents": {"planner": {"action": "hang"}},
    "default": {"action": "succeed", "delay_s": 0.1},
}

# Implementer hangs — used for double-SIGTERM test.
_HANG_AT_IMPLEMENT = {
    "agents": {"implementer": {"action": "hang"}},
    "default": {"action": "succeed", "delay_s": 0.1},
}

# Coordinator hangs after a fast planner — used to test mid-stage-transition signal.
_HANG_AT_COORDINATE = {
    "agents": {
        "planner":     {"action": "succeed", "delay_s": 0.1},
        "coordinator": {"action": "hang"},
    },
    "default": {"action": "succeed", "delay_s": 0.1},
}

# All stages succeed quickly — used for the disabled-stages test.
_ALL_SUCCEED = {"default": {"action": "succeed", "delay_s": 0.1}}


# ---------------------------------------------------------------------------
# Test 1: SIGTERM is forwarded to the hanging agent subprocess
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM requires Unix")
def test_sigterm_kills_hanging_agent(pipeline_env):
    """SIGTERM reaches the mock agent blocked in signal.pause() at the plan stage.

    Verifies that the signal is forwarded through the process group to the
    blocking mock subprocess — not just caught by the pipeline parent process.
    The pipeline records interrupted status and emits the interrupted event.
    """
    result = run_and_act(
        pipeline_env,
        scenario=_HANG_AT_PLAN,
        action_fn=send_sigterm,
        act_after_stage="plan",
        timeout=15,
    )

    assert result.status.get("pipeline_status") == "interrupted", (
        f"Expected interrupted, got: {result.status.get('pipeline_status')}\n"
        f"stderr: {result.stderr[:500]}"
    )
    event_types = [e.get("event_type") for e in result.events]
    assert RUN_INTERRUPTED in event_types, (
        f"Expected {RUN_INTERRUPTED!r} in events; got: {event_types}"
    )


# ---------------------------------------------------------------------------
# Test 2: Double SIGTERM produces exactly one interrupted event
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM requires Unix")
def test_double_sigterm_no_duplicate_events(pipeline_env):
    """Two rapid SIGTERMs produce exactly one pipeline.run.interrupted event.

    The signal handler uses _shutdown_requested and _pending_signal_event to
    ensure idempotency. The second signal should either be a no-op (process
    already exiting) or handled without emitting a second event.
    """
    proc = pipeline_env.run_background(_HANG_AT_IMPLEMENT)

    try:
        _wait_for_stage(pipeline_env.worca_dir, "implement", timeout=30)

        # Send two SIGTERMs in rapid succession
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        time.sleep(0.05)
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass  # Process may have already exited — that's fine

        proc.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()

    status = _find_latest_status(pipeline_env.worca_dir)
    events = _read_events_jsonl(pipeline_env.worca_dir)

    assert status.get("pipeline_status") == "interrupted", (
        f"Expected interrupted, got: {status.get('pipeline_status')}"
    )

    interrupted_events = [e for e in events if e.get("event_type") == RUN_INTERRUPTED]
    assert len(interrupted_events) == 1, (
        f"Expected exactly 1 {RUN_INTERRUPTED!r} event, got {len(interrupted_events)}: "
        f"{[e.get('event_type') for e in events]}"
    )


# ---------------------------------------------------------------------------
# Test 3: Control-file stop written to paused run preserves paused state
# ---------------------------------------------------------------------------

def test_control_stop_while_paused_preserves_paused(pipeline_env):
    """Writing a stop control file to a paused run does not mutate its state.

    When a pipeline is paused, the process exits via sys.exit(0) with
    pipeline_status='paused'. A stop control file written to the run directory
    afterward has no live reader — verifies that the paused terminal state is
    immutable, just like completed/failed/interrupted states.

    The control file is only polled between stages (at the top of the main loop),
    not while an agent is running. Writing the pause file after plan completes
    ensures the next iteration's poll catches it before coordinator starts.
    A 2s coordinator delay makes the window reliable regardless of scheduling.
    """
    # Slow coordinator gives a wide window: the pause file written after plan
    # completes will be caught either before coordinator starts or after it
    # finishes — either way the pipeline exits with pipeline_status='paused'.
    scenario = {
        "agents": {"coordinator": {"action": "succeed", "delay_s": 2.0}},
        "default": {"action": "succeed", "delay_s": 0.1},
    }
    proc = pipeline_env.run_background(scenario)
    stderr_output = ""

    try:
        # Step 1: wait for plan to complete, then write the pause control file.
        # The runner polls the control file at the top of each stage iteration,
        # so the pause will be caught at the next stage boundary.
        _wait_for_stage_completed(pipeline_env.worca_dir, "plan", timeout=20)
        write_control_pause(proc, pipeline_env)
        _, stderr_output = proc.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        _, stderr_output = proc.communicate()

    status = _find_latest_status(pipeline_env.worca_dir)
    assert status.get("pipeline_status") == "paused", (
        f"Expected paused, got: {status.get('pipeline_status')}\n"
        f"stderr: {stderr_output[:500]}"
    )

    # Step 2: write a stop control file to the now-dead paused run
    run_id = _find_latest_run_id(pipeline_env.worca_dir)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "stop", "source": "test"}))

    # Step 3: status must remain paused — no process is reading the control file
    status_after = _find_latest_status(pipeline_env.worca_dir)
    assert status_after.get("pipeline_status") == "paused", (
        f"Paused state mutated after stop write: {status_after.get('pipeline_status')}"
    )


# ---------------------------------------------------------------------------
# Test 4: Signal mid-stage-transition — no corruption or duplicate events
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM requires Unix")
def test_signal_mid_stage_transition(pipeline_env):
    """SIGTERM between stages produces one interrupted event with no state corruption.

    Uses a scenario where plan succeeds quickly and coordinator hangs. SIGTERM
    is sent as soon as plan completes (status.json shows plan=completed), before
    coordinator finishes. The signal may fire during the runner's post-plan result
    processing, during the control-file poll at the top of the next iteration, or
    at the start of coordinator's stage setup. All cases must produce a single
    clean interrupted record.
    """
    proc = pipeline_env.run_background(_HANG_AT_COORDINATE)
    stderr_output = ""

    try:
        # Wait for plan to complete, then immediately signal at the boundary
        _wait_for_stage_completed(pipeline_env.worca_dir, "plan", timeout=30)
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        _, stderr_output = proc.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        _, stderr_output = proc.communicate()

    status = _find_latest_status(pipeline_env.worca_dir)
    events = _read_events_jsonl(pipeline_env.worca_dir)

    assert status.get("pipeline_status") == "interrupted", (
        f"Expected interrupted, got: {status.get('pipeline_status')}\n"
        f"stderr: {stderr_output[:500]}"
    )

    interrupted_events = [e for e in events if e.get("event_type") == RUN_INTERRUPTED]
    assert len(interrupted_events) == 1, (
        f"Expected exactly 1 {RUN_INTERRUPTED!r} event, got {len(interrupted_events)}: "
        f"{[e.get('event_type') for e in events]}"
    )


# ---------------------------------------------------------------------------
# Test 5: Pipeline with most stages disabled (only plan runs)
# ---------------------------------------------------------------------------

def test_most_stages_disabled_plan_only(pipeline_env):
    """Pipeline with only the plan stage enabled completes successfully.

    Disables coordinate, implement, test, review, pr in addition to the
    already-disabled preflight, plan_review, and learn. With only [Stage.PLAN]
    in stage_order, the main loop exits after plan completes and pipeline_status
    is set to 'completed'.
    """
    settings_path = pipeline_env.project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})
    settings["worca"]["stages"] = {
        "preflight":   {"enabled": False},
        "plan_review": {"enabled": False},
        "coordinate":  {"enabled": False},
        "implement":   {"enabled": False},
        "test":        {"enabled": False},
        "review":      {"enabled": False},
        "pr":          {"enabled": False},
        "learn":       {"enabled": False},
    }
    settings_path.write_text(json.dumps(settings, indent=2))

    result = pipeline_env.run(_ALL_SUCCEED, timeout=30)

    assert result.status.get("pipeline_status") == "completed", (
        f"Expected completed, got: {result.status.get('pipeline_status')}\n"
        f"stderr: {result.stderr[:500]}"
    )

    completed_stages = [
        s for s, v in result.status.get("stages", {}).items()
        if v.get("status") == "completed"
    ]
    assert "plan" in completed_stages, (
        f"Expected 'plan' in completed stages; got: {completed_stages}"
    )

    non_plan_completed = [s for s in completed_stages if s != "plan"]
    assert not non_plan_completed, (
        f"Expected only 'plan' to complete; got extra completed stages: {non_plan_completed}"
    )
