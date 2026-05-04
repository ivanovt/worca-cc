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


# ===========================================================================
# Per-iteration directives (W-050 Phase 0)
# ===========================================================================
#
# When `agents[name]` is a dict-of-iterations (contains `iter_N` or
# `default` keys), the mock should pick a directive based on the iteration
# number parsed from the resolved-template path stem
# (e.g. ``...resolved/test-tester-iter-2.md`` → iteration=2).

def _resolved_path(stage: str, agent: str, iteration: int) -> str:
    """Build a resolved-template path stem matching runner.py's naming."""
    return f"/tmp/runs/X/agents/resolved/{stage}-{agent}-iter-{iteration}.md"


def test_iter_specific_directive_selected_by_iteration():
    scenario = {
        "agents": {
            "tester": {
                "iter_1": {"action": "fail", "delay_s": 0, "error": "iter1 failed"},
                "iter_2": {"action": "succeed", "delay_s": 0,
                           "result_text": "iter2 passed"},
            }
        },
        "default": {"action": "succeed", "delay_s": 0},
    }
    iter1 = _run(scenario, agent=_resolved_path("test", "tester", 1))
    iter2 = _run(scenario, agent=_resolved_path("test", "tester", 2))
    assert iter1.returncode != 0
    assert iter2.returncode == 0
    iter2_lines = _lines(iter2)
    iter2_result = next(ev for ev in iter2_lines if ev["type"] == "result")
    assert iter2_result["result"] == "iter2 passed"


def test_iter_directives_iter1_and_iter2_emit_different_results():
    """Phase 1 sanity-check (W-050 plan rule #14) baked into the mock layer."""
    scenario = {
        "agents": {
            "reviewer": {
                "iter_1": {"action": "succeed", "delay_s": 0,
                           "result_text": "REVISE: needs error handling"},
                "iter_2": {"action": "succeed", "delay_s": 0,
                           "result_text": "APPROVE"},
            }
        },
        "default": {"action": "succeed", "delay_s": 0},
    }
    iter1 = _run(scenario, agent=_resolved_path("review", "reviewer", 1))
    iter2 = _run(scenario, agent=_resolved_path("review", "reviewer", 2))
    iter1_text = next(ev for ev in _lines(iter1) if ev["type"] == "result")["result"]
    iter2_text = next(ev for ev in _lines(iter2) if ev["type"] == "result")["result"]
    assert iter1_text != iter2_text
    assert "REVISE" in iter1_text
    assert "APPROVE" in iter2_text


def test_iter_block_falls_back_to_agent_default():
    """An iter_N not listed under agents[name] falls back to agents[name].default."""
    scenario = {
        "agents": {
            "tester": {
                "iter_1": {"action": "fail", "delay_s": 0},
                "default": {"action": "succeed", "delay_s": 0,
                            "result_text": "tester default"},
            }
        },
        "default": {"action": "fail", "delay_s": 0},  # must not be picked
    }
    result = _run(scenario, agent=_resolved_path("test", "tester", 7))
    assert result.returncode == 0
    text = next(ev for ev in _lines(result) if ev["type"] == "result")["result"]
    assert text == "tester default"


def test_iter_block_without_match_falls_back_to_scenario_default():
    """No iter_N match and no agents[name].default → scenario.default."""
    scenario = {
        "agents": {
            "tester": {
                "iter_1": {"action": "fail", "delay_s": 0},
            }
        },
        "default": {"action": "succeed", "delay_s": 0,
                    "result_text": "scenario default"},
    }
    result = _run(scenario, agent=_resolved_path("test", "tester", 9))
    assert result.returncode == 0
    text = next(ev for ev in _lines(result) if ev["type"] == "result")["result"]
    assert text == "scenario default"


def test_iter_block_does_not_affect_other_agents():
    """A per-iteration block for tester must not leak into reviewer's resolution."""
    scenario = {
        "agents": {
            "tester": {
                "iter_1": {"action": "fail", "delay_s": 0},
                "iter_2": {"action": "fail", "delay_s": 0},
            }
        },
        "default": {"action": "succeed", "delay_s": 0,
                    "result_text": "default ok"},
    }
    result = _run(scenario, agent=_resolved_path("review", "reviewer", 1))
    assert result.returncode == 0
    text = next(ev for ev in _lines(result) if ev["type"] == "result")["result"]
    assert text == "default ok"


def test_plain_agent_path_with_iter_block_falls_back_to_default():
    """An unresolved agent path (no iter-N suffix) yields iteration=None.

    With iteration=None and a per-iteration block, the mock falls back to
    agents[name].default → scenario.default. This is what existing tests
    that pass plain ``--agent planner`` paths need to keep working.
    """
    scenario = {
        "agents": {
            "tester": {
                "iter_1": {"action": "fail", "delay_s": 0},
                "default": {"action": "succeed", "delay_s": 0,
                            "result_text": "fell through"},
            }
        },
        "default": {"action": "fail", "delay_s": 0},
    }
    result = _run(scenario, agent="tester")  # plain stem, no iter-N
    assert result.returncode == 0
    text = next(ev for ev in _lines(result) if ev["type"] == "result")["result"]
    assert text == "fell through"


# ===========================================================================
# Backward compatibility — existing scenario shapes (W-050 plan rule #5)
# ===========================================================================
#
# These three scenarios mirror shapes used by current integration tests:
#   - all_succeed (tests/mock_claude/conftest.py:49)
#   - agent_fails (tests/mock_claude/conftest.py:62)
#   - flat agents+default (tests/integration/test_pipeline_edge_cases.py)
#
# The post-W-050 mock must produce identical behavior for these shapes,
# regardless of whether --agent is a plain stem or a resolved-template path.

def test_backcompat_all_succeed_shape():
    scenario = {"default": {"action": "succeed", "delay_s": 0}}
    for agent in ["planner", _resolved_path("plan", "planner", 1)]:
        result = _run(scenario, agent=agent)
        assert result.returncode == 0
        ev = next(e for e in _lines(result) if e["type"] == "result")
        assert ev["subtype"] == "success"


def test_backcompat_agent_fails_shape():
    scenario = {
        "agents": {"planner": {"action": "fail", "error": "boom", "delay_s": 0}},
        "default": {"action": "succeed", "delay_s": 0},
    }
    for agent in ["planner", _resolved_path("plan", "planner", 1)]:
        result = _run(scenario, agent=agent)
        assert result.returncode != 0
        ev = next(e for e in _lines(result) if e["type"] == "result")
        assert ev["subtype"] == "error_max_turns"
        assert ev["result"] == "boom"


def test_backcompat_flat_agents_with_default_shape():
    """Pre-W-050 scenarios where agents[name] is a flat directive, not a dict-of-iterations."""
    scenario = {
        "agents": {"coordinator": {"action": "succeed", "delay_s": 0,
                                    "result_text": "coord done"}},
        "default": {"action": "succeed", "delay_s": 0,
                    "result_text": "default done"},
    }
    coord = _run(scenario, agent="coordinator")
    other = _run(scenario, agent="planner")
    assert next(e for e in _lines(coord) if e["type"] == "result")["result"] == "coord done"
    assert next(e for e in _lines(other) if e["type"] == "result")["result"] == "default done"


def test_backcompat_resolved_template_path_falls_back_to_flat_directive():
    """Resolved path on a flat agents[name] must still match by agent name."""
    scenario = {
        "agents": {"planner": {"action": "succeed", "delay_s": 0,
                                "result_text": "planner via resolved"}},
        "default": {"action": "fail"},
    }
    result = _run(scenario, agent=_resolved_path("plan", "planner", 1))
    assert result.returncode == 0
    text = next(ev for ev in _lines(result) if ev["type"] == "result")["result"]
    assert text == "planner via resolved"
