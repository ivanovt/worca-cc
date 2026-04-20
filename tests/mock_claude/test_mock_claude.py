"""Tests for mock_claude.py — verifies all 5 action behaviors."""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

MOCK_CLAUDE = Path(__file__).parent / "mock_claude.py"


def _run(scenario: dict, agent: str = "planner", timeout: int = 10):
    """Run mock_claude with a given scenario and agent, return CompletedProcess."""
    scenario_file = Path(os.environ.get("TMPDIR", "/tmp")) / "mock_scenario_test.json"
    scenario_file.write_text(json.dumps(scenario))
    env = {**os.environ, "MOCK_CLAUDE_SCENARIO": str(scenario_file)}
    return subprocess.run(
        [sys.executable, str(MOCK_CLAUDE), "--agent", agent],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _lines(result) -> list[dict]:
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


# --- succeed action ---

def test_succeed_exits_zero():
    result = _run({"default": {"action": "succeed", "delay_s": 0}})
    assert result.returncode == 0


def test_succeed_emits_init_and_result():
    result = _run({"default": {"action": "succeed", "delay_s": 0}})
    lines = _lines(result)
    types = [ev["type"] for ev in lines]
    assert "system" in types
    assert "result" in types


def test_succeed_result_subtype():
    result = _run({"default": {"action": "succeed", "delay_s": 0}})
    lines = _lines(result)
    result_event = next(ev for ev in lines if ev["type"] == "result")
    assert result_event["subtype"] == "success"


def test_succeed_custom_result_text():
    result = _run({"default": {"action": "succeed", "delay_s": 0,
                               "result_text": "All good"}})
    lines = _lines(result)
    result_event = next(ev for ev in lines if ev["type"] == "result")
    assert result_event["result"] == "All good"


def test_succeed_agent_directive_overrides_default():
    scenario = {
        "agents": {"planner": {"action": "succeed", "delay_s": 0,
                                "result_text": "planner done"}},
        "default": {"action": "fail"},
    }
    result = _run(scenario, agent="planner")
    assert result.returncode == 0
    lines = _lines(result)
    result_event = next(ev for ev in lines if ev["type"] == "result")
    assert result_event["result"] == "planner done"


# --- fail action ---

def test_fail_exits_nonzero():
    result = _run({"default": {"action": "fail", "delay_s": 0}})
    assert result.returncode != 0


def test_fail_emits_error_result():
    result = _run({"default": {"action": "fail", "delay_s": 0,
                               "error": "boom"}})
    lines = _lines(result)
    result_event = next(ev for ev in lines if ev["type"] == "result")
    assert result_event["subtype"] == "error_max_turns"
    assert result_event["result"] == "boom"


# --- crash action ---

def test_crash_exits_with_code():
    result = _run({"default": {"action": "crash", "exit_code": 137}})
    assert result.returncode == 137


def test_crash_emits_no_result_event():
    result = _run({"default": {"action": "crash", "exit_code": 1}})
    lines = _lines(result)
    result_types = [ev for ev in lines if ev.get("type") == "result"]
    assert result_types == []


# --- slow action ---

def test_slow_exits_zero():
    result = _run({"default": {"action": "slow", "delay_s": 0, "slow_s": 0}})
    assert result.returncode == 0


def test_slow_emits_success_result():
    result = _run({"default": {"action": "slow", "delay_s": 0, "slow_s": 0}})
    lines = _lines(result)
    result_event = next(ev for ev in lines if ev["type"] == "result")
    assert result_event["subtype"] == "success"


# --- hang action ---

@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM not available on Windows")
def test_hang_blocks_until_signal():
    scenario_file = Path(os.environ.get("TMPDIR", "/tmp")) / "mock_hang_test.json"
    scenario_file.write_text(json.dumps({"default": {"action": "hang"}}))
    env = {**os.environ, "MOCK_CLAUDE_SCENARIO": str(scenario_file)}

    proc = subprocess.Popen(
        [sys.executable, str(MOCK_CLAUDE), "--agent", "planner"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(0.2)
    assert proc.poll() is None, "hang should not have exited"
    proc.send_signal(signal.SIGTERM)
    proc.wait(timeout=5)
    assert proc.returncode is not None


# --- default fallback ---

def test_unknown_agent_falls_back_to_default():
    scenario = {
        "agents": {"planner": {"action": "fail"}},
        "default": {"action": "succeed", "delay_s": 0},
    }
    result = _run(scenario, agent="coordinator")
    assert result.returncode == 0
