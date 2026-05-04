"""W-050 Phase 1 — learn-stage integration tests.

The learn stage runs after pipeline termination when ``worca.stages.learn.enabled``
is True. It writes a per-run ``learnings.json`` artifact and emits
``pipeline.stage.started`` / ``pipeline.stage.completed`` events for the
``learn`` stage. See runner.py:722-863 for the implementation and
runner.py:2933, 2969, 2984, 2997 for the invocation sites (success,
loop_exhausted, pipeline_error, generic exception — but NOT user
interrupt or preflight failures).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tests.integration.helpers import read_run_dir

MOCK_CLAUDE_BIN = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"


pytestmark = pytest.mark.timeout(180)


def _tester_pass() -> dict:
    return {"action": "succeed", "delay_s": 0.05,
            "structured_output": {"passed": True}}


def _events_of(events: list, type_: str) -> list:
    return [e for e in events if e.get("event_type") == type_]


def _learn_started_events(events: list) -> list:
    return [
        e for e in events
        if e.get("event_type") == "pipeline.stage.started"
        and e.get("payload", {}).get("stage") == "learn"
    ]


# ===========================================================================
# 1. learn runs after a successful pipeline (when enabled)
# ===========================================================================

def test_learn_runs_after_success_when_enabled(pipeline_env):
    pipeline_env.enable_stages("learn")

    scenario = {
        "agents": {"tester": _tester_pass()},
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="learn happy", timeout=120)
    assert result.returncode == 0, f"stderr: {result.stderr[-500:]}"

    # learn stage_started event fired exactly once.
    assert len(_learn_started_events(result.events)) == 1
    # learn stage recorded in status with completed status.
    learn_stage = result.status["stages"].get("learn", {})
    assert learn_stage.get("status") == "completed"
    # learnings.json artifact written in the run dir.
    run_dir = read_run_dir(pipeline_env.worca_dir)
    assert (run_dir / "learnings.json").exists()


# ===========================================================================
# 2. learn does NOT run when stage is disabled (default fixture state)
# ===========================================================================

def test_learn_skipped_when_disabled(pipeline_env):
    """Default fixture has worca.stages.learn.enabled=False."""
    scenario = {
        "agents": {"tester": _tester_pass()},
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="learn skipped", timeout=120)
    assert result.returncode == 0

    # No learn stage_started event.
    assert _learn_started_events(result.events) == []
    # No learnings.json artifact.
    run_dir = read_run_dir(pipeline_env.worca_dir)
    assert not (run_dir / "learnings.json").exists()


# ===========================================================================
# 3. run_learn.py CLI parity — running the standalone script after a
#    completed run produces the same artifact.
# ===========================================================================

def test_run_learn_cli_parity_with_pipeline_invocation(pipeline_env):
    """Standalone ``run_learn.py --run-id ...`` writes learnings.json too."""
    # First: complete a run with learn DISABLED, so no learnings.json exists.
    scenario = {
        "agents": {"tester": _tester_pass()},
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="cli parity", timeout=120)
    assert result.returncode == 0

    run_dir = read_run_dir(pipeline_env.worca_dir)
    learnings_path = run_dir / "learnings.json"
    assert not learnings_path.exists(), "precondition: no learnings yet"

    # Build a learner-success scenario and invoke run_learn.py against the
    # completed run. The script will spawn a learner agent — we point it at
    # mock_claude so the call stays hermetic.
    scenario_path = pipeline_env.project / ".worca" / "learn_scenario.json"
    scenario_path.write_text(json.dumps({
        "default": {"action": "succeed", "delay_s": 0.05,
                    "structured_output": {"summary": "cli_marker"}},
    }))
    run_id = run_dir.name
    completed = subprocess.run(
        [sys.executable, "-m", "worca.scripts.run_learn",
         "--run-id", run_id],
        cwd=str(pipeline_env.project),
        env={
            **os.environ,
            "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
            "MOCK_CLAUDE_SCENARIO": str(scenario_path),
            "WORCA_AGENT": "",
            "WORCA_SKIP_BEADS": "1",
        },
        capture_output=True, text=True, timeout=60,
    )
    # Exit 0 plus an artifact on disk == parity with the in-pipeline path.
    assert completed.returncode == 0, (
        f"run_learn.py failed: stderr={completed.stderr[-500:]}"
    )
    assert learnings_path.exists()


# ===========================================================================
# 4. learnings.json contains the agent's structured output
#    (W-050 plan rule #14 — sanity)
# ===========================================================================

def test_learnings_artifact_captures_agent_output(pipeline_env):
    pipeline_env.enable_stages("learn")

    canned = {"summary": "iter1_marker_unique",
              "patterns": ["pattern-A"], "anti_patterns": []}
    scenario = {
        "agents": {
            "tester": _tester_pass(),
            "learner": {
                "action": "succeed", "delay_s": 0.05,
                "structured_output": canned,
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    result = pipeline_env.run(scenario, prompt="learn artifact", timeout=120)
    assert result.returncode == 0

    run_dir = read_run_dir(pipeline_env.worca_dir)
    learnings = json.loads((run_dir / "learnings.json").read_text())
    assert learnings == canned
    # The same content also lives on the iteration record.
    learn_iters = result.status["stages"]["learn"]["iterations"]
    assert learn_iters[0]["output"] == canned
