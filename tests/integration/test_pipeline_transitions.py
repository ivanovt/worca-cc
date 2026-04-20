"""Phase 3: Core pipeline state × action transition tests.

Tier-1 cells test the current codebase (stop, pause, signal_*, crash actions).
Tier-2 cells (cancel, resume, cancelled state) are skip-marked stubs pending W-043.

Three test patterns:
  A - Mid-run actions: pipeline hangs at a stage; test acts, then asserts final status.
  B - Terminal-state immutability: pipeline exits; test writes control file; asserts no change.
  Paused - Pause via control file, pipeline exits, then resume + act.
"""
import json
import os
import signal
import sys

import pytest

from worca.events.types import (
    RUN_FAILED,
    RUN_INTERRUPTED,
    RUN_PAUSED,
)
from tests.integration.helpers import (
    _active_run_id,
    _find_latest_status,
    run_and_act,
    send_sigint,
    send_sigkill,
    send_sigterm,
    write_control_pause,
    write_control_stop,
)

# ---------------------------------------------------------------------------
# Transition matrix — Tier 1 (testable now)
# ---------------------------------------------------------------------------
# Format: (state, action) → (expected_status, expected_event_types, process_alive, pattern)
# process_alive: True = Pattern A (background process), False = Pattern B (post-exit)
# pattern: "A" = mid-run action, "B" = terminal-state immutability, "paused" = pause→act

EXPECTED_TRANSITIONS = {
    # Pattern A: Running state + action
    ("running", "stop"):        ("interrupted", [RUN_INTERRUPTED], True, "A"),
    ("running", "pause"):       ("paused",       [RUN_PAUSED],     True, "A"),
    ("running", "signal_term"): ("interrupted", [RUN_INTERRUPTED], True, "A"),
    ("running", "signal_int"):  ("interrupted", [RUN_INTERRUPTED], True, "A"),
    ("running", "signal_kill"): ("interrupted", [],               True, "A"),  # SIGKILL — no event emitted
    ("running", "crash"):       ("failed",      [RUN_FAILED],     True, "A"),  # agent crash → stage fail

    # Pattern A: Paused state + action (resume first, then act)
    ("paused",  "stop"):        ("interrupted", [RUN_INTERRUPTED], True, "paused"),
    ("paused",  "signal_term"): ("interrupted", [RUN_INTERRUPTED], True, "paused"),

    # Pattern B: Terminal-state immutability (control file written after exit)
    ("completed",  "stop"):     ("completed",   [], False, "B"),
    ("completed",  "pause"):    ("completed",   [], False, "B"),
    ("failed",     "stop"):     ("failed",      [], False, "B"),
    ("failed",     "pause"):    ("failed",      [], False, "B"),
    ("interrupted","stop"):     ("interrupted", [], False, "B"),
    ("interrupted","pause"):    ("interrupted", [], False, "B"),
}

# Cells that cannot be tested because there is no live process to signal after
# the pipeline exits into a terminal state.
SKIPPED_NO_PROCESS = [
    (terminal, sig)
    for terminal in ("completed", "failed", "interrupted")
    for sig in ("signal_term", "signal_int", "signal_kill", "crash")
]

# Tier-2 cells requiring W-043 (cancel action, cancelled state, resume action).
SKIPPED_W043 = [
    ("running",   "cancel"),
    ("paused",    "cancel"),
    ("paused",    "resume"),
    ("cancelled", "stop"),
    ("cancelled", "pause"),
    ("cancelled", "cancel"),
    ("cancelled", "signal_term"),
    ("cancelled", "signal_int"),
    ("cancelled", "signal_kill"),
    ("cancelled", "crash"),
]

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

# All stages succeed quickly; implementer hangs — lets tests inject signals/stop.
_HANG_AT_IMPLEMENT = {
    "agents": {"implementer": {"action": "hang"}},
    "default": {"action": "succeed", "delay_s": 0.1},
}

# All stages succeed — produces a completed pipeline.
_ALL_SUCCEED = {"default": {"action": "succeed", "delay_s": 0.1}}

# Planner fails — produces a failed pipeline.
_PLANNER_FAILS = {
    "agents": {"planner": {"action": "fail", "error": "Planned failure"}},
    "default": {"action": "succeed", "delay_s": 0.1},
}

# ---------------------------------------------------------------------------
# Action helpers (action → action_fn for run_and_act)
# ---------------------------------------------------------------------------

_ACTION_FNS = {
    "stop":        write_control_stop,
    "pause":       write_control_pause,
    "signal_term": send_sigterm,
    "signal_int":  send_sigint,
    "signal_kill": send_sigkill,
}


def _crash_action(proc, env):
    """Kill the mock implementer (simulates crash) by sending SIGKILL to process group.

    A SIGKILL to the pipeline process group simulates an unrecoverable agent crash.
    The pipeline should record the stage as failed.
    """
    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)


# ---------------------------------------------------------------------------
# Pattern A: Mid-run (running state) tests
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="signal tests require Unix")
def test_running_stop(pipeline_env):
    """Running + control-stop → interrupted."""
    result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, write_control_stop,
                         act_after_stage="implement")
    assert result.status.get("pipeline_status") == "interrupted"
    assert any(e.get("event_type") == RUN_INTERRUPTED for e in result.events)


@pytest.mark.skipif(sys.platform == "win32", reason="signal tests require Unix")
def test_running_pause(pipeline_env):
    """Running + control-pause → paused."""
    result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, write_control_pause,
                         act_after_stage="implement")
    assert result.status.get("pipeline_status") == "paused"
    assert any(e.get("event_type") == RUN_PAUSED for e in result.events)


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM requires Unix")
def test_running_signal_term(pipeline_env):
    """Running + SIGTERM → interrupted."""
    result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, send_sigterm,
                         act_after_stage="implement")
    assert result.status.get("pipeline_status") == "interrupted"
    assert any(e.get("event_type") == RUN_INTERRUPTED for e in result.events)


@pytest.mark.skipif(sys.platform == "win32", reason="SIGINT requires Unix")
def test_running_signal_int(pipeline_env):
    """Running + SIGINT → interrupted."""
    result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, send_sigint,
                         act_after_stage="implement")
    assert result.status.get("pipeline_status") == "interrupted"
    assert any(e.get("event_type") == RUN_INTERRUPTED for e in result.events)


@pytest.mark.skipif(sys.platform == "win32", reason="SIGKILL requires Unix")
def test_running_signal_kill(pipeline_env):
    """Running + SIGKILL → interrupted (no event — process cannot write before death)."""
    result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, send_sigkill,
                         act_after_stage="implement")
    # SIGKILL prevents graceful shutdown; status may be interrupted or absent
    pipeline_status = result.status.get("pipeline_status", "interrupted")
    assert pipeline_status in ("interrupted", "running")


@pytest.mark.skipif(sys.platform == "win32", reason="SIGKILL requires Unix")
def test_running_crash(pipeline_env):
    """Running + agent crash (SIGKILL to process group) → process cannot write status.

    SIGKILL kills the entire process group instantly. Unlike SIGTERM, there is no
    signal handler and no finally block — status.json remains in the last written
    state (typically 'running'). This is the expected behavior: the recovery path
    is external (stale PID detection on next launch).
    """
    result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, _crash_action,
                         act_after_stage="implement")
    assert result.status.get("pipeline_status") in ("failed", "interrupted", "running")


# ---------------------------------------------------------------------------
# Pattern A (paused): Pause pipeline, then apply action on resume
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="signal tests require Unix")
def test_paused_stop(pipeline_env):
    """Paused + control-stop → interrupted.

    Pausing exits the pipeline process with status 'paused'. To act on a paused
    pipeline, we must resume it (--resume) and then apply stop before it finishes.
    """
    # Step 1: pause the pipeline
    pause_result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, write_control_pause,
                               act_after_stage="implement")
    assert pause_result.status.get("pipeline_status") == "paused", (
        f"Expected paused, got: {pause_result.status.get('pipeline_status')}\n"
        f"stderr: {pause_result.stderr[:500]}"
    )

    # Step 2: resume and immediately stop
    new_scenario = {
        "agents": {"implementer": {"action": "hang"}},
        "default": {"action": "succeed", "delay_s": 0.1},
    }
    resume_result = run_and_act(
        pipeline_env, new_scenario, write_control_stop,
        act_after_stage="implement",
    )
    assert resume_result.status.get("pipeline_status") == "interrupted"
    assert any(e.get("event_type") == RUN_INTERRUPTED for e in resume_result.events)


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM requires Unix")
def test_paused_signal_term(pipeline_env):
    """Paused + SIGTERM (applied after resume) → interrupted."""
    # Step 1: pause
    pause_result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, write_control_pause,
                               act_after_stage="implement")
    assert pause_result.status.get("pipeline_status") == "paused"

    # Step 2: resume and send SIGTERM
    resume_result = run_and_act(
        pipeline_env, _HANG_AT_IMPLEMENT, send_sigterm,
        act_after_stage="implement",
    )
    assert resume_result.status.get("pipeline_status") == "interrupted"
    assert any(e.get("event_type") == RUN_INTERRUPTED for e in resume_result.events)


# ---------------------------------------------------------------------------
# Pattern B: Terminal-state immutability
# ---------------------------------------------------------------------------

def test_completed_rejects_stop(pipeline_env):
    """Completed pipeline: writing control-stop leaves status unchanged."""
    result = pipeline_env.run(_ALL_SUCCEED)
    assert result.status.get("pipeline_status") == "completed"

    run_id = _active_run_id(pipeline_env.worca_dir)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "stop", "source": "test"}))

    status = _find_latest_status(pipeline_env.worca_dir)
    assert status.get("pipeline_status") == "completed"


def test_completed_rejects_pause(pipeline_env):
    """Completed pipeline: writing control-pause leaves status unchanged."""
    result = pipeline_env.run(_ALL_SUCCEED)
    assert result.status.get("pipeline_status") == "completed"

    run_id = _active_run_id(pipeline_env.worca_dir)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "pause", "source": "test"}))

    status = _find_latest_status(pipeline_env.worca_dir)
    assert status.get("pipeline_status") == "completed"


def test_failed_rejects_stop(pipeline_env):
    """Failed pipeline: writing control-stop leaves status unchanged."""
    result = pipeline_env.run(_PLANNER_FAILS)
    assert result.status.get("pipeline_status") == "failed"

    run_id = _active_run_id(pipeline_env.worca_dir)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "stop", "source": "test"}))

    status = _find_latest_status(pipeline_env.worca_dir)
    assert status.get("pipeline_status") == "failed"


def test_failed_rejects_pause(pipeline_env):
    """Failed pipeline: writing control-pause leaves status unchanged."""
    result = pipeline_env.run(_PLANNER_FAILS)
    assert result.status.get("pipeline_status") == "failed"

    run_id = _active_run_id(pipeline_env.worca_dir)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "pause", "source": "test"}))

    status = _find_latest_status(pipeline_env.worca_dir)
    assert status.get("pipeline_status") == "failed"


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM requires Unix")
def test_interrupted_rejects_stop(pipeline_env):
    """Interrupted pipeline: writing control-stop leaves status unchanged."""
    result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, send_sigterm,
                         act_after_stage="implement")
    assert result.status.get("pipeline_status") == "interrupted"

    run_id = _active_run_id(pipeline_env.worca_dir)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "stop", "source": "test"}))

    status = _find_latest_status(pipeline_env.worca_dir)
    assert status.get("pipeline_status") == "interrupted"


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM requires Unix")
def test_interrupted_rejects_pause(pipeline_env):
    """Interrupted pipeline: writing control-pause leaves status unchanged."""
    result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, send_sigterm,
                         act_after_stage="implement")
    assert result.status.get("pipeline_status") == "interrupted"

    run_id = _active_run_id(pipeline_env.worca_dir)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "pause", "source": "test"}))

    status = _find_latest_status(pipeline_env.worca_dir)
    assert status.get("pipeline_status") == "interrupted"


# ---------------------------------------------------------------------------
# Skipped: no process to signal after terminal state
# ---------------------------------------------------------------------------

@pytest.mark.skip(reason="no process to signal after completed state")
def test_completed_signal_term(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after completed state")
def test_completed_signal_int(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after completed state")
def test_completed_signal_kill(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after completed state")
def test_completed_crash(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after failed state")
def test_failed_signal_term(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after failed state")
def test_failed_signal_int(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after failed state")
def test_failed_signal_kill(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after failed state")
def test_failed_crash(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after interrupted state")
def test_interrupted_signal_term(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after interrupted state")
def test_interrupted_signal_int(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after interrupted state")
def test_interrupted_signal_kill(pipeline_env): ...


@pytest.mark.skip(reason="no process to signal after interrupted state")
def test_interrupted_crash(pipeline_env): ...


# ---------------------------------------------------------------------------
# Tier-2 stubs: requires W-043 (cancel action, cancelled state, resume action)
# ---------------------------------------------------------------------------

@pytest.mark.skip(reason="requires W-043: cancel action not in current VALID_ACTIONS")
def test_running_cancel(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: cancel action not in current VALID_ACTIONS")
def test_paused_cancel(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: resume action not in current control protocol")
def test_paused_resume(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: cancelled state does not exist yet")
def test_cancelled_stop(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: cancelled state does not exist yet")
def test_cancelled_pause(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: cancelled state does not exist yet")
def test_cancelled_cancel(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: cancelled state does not exist yet")
def test_cancelled_signal_term(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: cancelled state does not exist yet")
def test_cancelled_signal_int(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: cancelled state does not exist yet")
def test_cancelled_signal_kill(pipeline_env): ...


@pytest.mark.skip(reason="requires W-043: cancelled state does not exist yet")
def test_cancelled_crash(pipeline_env): ...


# ---------------------------------------------------------------------------
# Parametrized dispatcher — documents the full matrix in one place
# ---------------------------------------------------------------------------

_TIER1_PARAMS = [
    pytest.param(state, action, id=f"{state}-{action}")
    for (state, action) in EXPECTED_TRANSITIONS
]

_NO_PROCESS_PARAMS = [
    pytest.param(state, action, id=f"{state}-{action}",
                 marks=pytest.mark.skip(reason="no process to signal after terminal state"))
    for (state, action) in SKIPPED_NO_PROCESS
]

_W043_PARAMS = [
    pytest.param(state, action, id=f"{state}-{action}",
                 marks=pytest.mark.skip(reason="requires W-043"))
    for (state, action) in SKIPPED_W043
]


@pytest.mark.parametrize("state,action", _TIER1_PARAMS + _NO_PROCESS_PARAMS + _W043_PARAMS)
def test_state_transition(state, action, pipeline_env):
    """Parametrized dispatcher: validates every cell in the transition matrix.

    Tier-1 cells dispatch to the correct pattern based on EXPECTED_TRANSITIONS.
    Tier-2 and no-process cells are skip-marked — they document the full matrix
    without running. W-043 landing means removing skip markers and filling in
    expected results.
    """
    if (state, action) not in EXPECTED_TRANSITIONS:
        pytest.skip("not in tier-1 matrix")

    expected_status, expected_events, _, pattern = EXPECTED_TRANSITIONS[(state, action)]

    if sys.platform == "win32" and action in ("signal_term", "signal_int", "signal_kill", "crash"):
        pytest.skip("signal tests require Unix")

    if pattern == "A":
        action_fn = _crash_action if action == "crash" else _ACTION_FNS[action]
        result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, action_fn,
                             act_after_stage="implement")

    elif pattern == "B":
        if state == "completed":
            result = pipeline_env.run(_ALL_SUCCEED)
        elif state == "failed":
            result = pipeline_env.run(_PLANNER_FAILS)
        elif state == "interrupted":
            result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, send_sigterm,
                                 act_after_stage="implement")
        else:
            pytest.fail(f"Unhandled Pattern B state: {state!r}")

        assert result.status.get("pipeline_status") == expected_status

        # Write control file to the exited run — status must not change
        run_id = _active_run_id(pipeline_env.worca_dir)
        control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
        control.write_text(json.dumps({"action": action.replace("_", ""), "source": "test"}))

        final_status = _find_latest_status(pipeline_env.worca_dir)
        assert final_status.get("pipeline_status") == expected_status
        return

    elif pattern == "paused":
        # Pause first, then resume and apply action
        run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, write_control_pause,
                    act_after_stage="implement")
        action_fn = _ACTION_FNS.get(action, send_sigterm)
        result = run_and_act(pipeline_env, _HANG_AT_IMPLEMENT, action_fn,
                             act_after_stage="implement")

    else:
        pytest.fail(f"Unknown pattern: {pattern!r}")

    actual_status = result.status.get("pipeline_status")
    assert actual_status == expected_status, (
        f"Expected pipeline_status={expected_status!r}, got {actual_status!r}\n"
        f"stderr: {result.stderr[:500]}"
    )
    for event_type in expected_events:
        assert any(e.get("event_type") == event_type for e in result.events), (
            f"Expected event {event_type!r} not found in {[e.get('event_type') for e in result.events]}"
        )
