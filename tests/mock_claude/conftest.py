"""Pytest fixtures and helpers for mock_claude scenario files."""
import json
import os
import sys
from pathlib import Path

import pytest

MOCK_CLAUDE_BIN = Path(__file__).parent / "mock_claude.py"


@pytest.fixture
def mock_claude_env(tmp_path):
    """Return a factory that writes a scenario file and returns env vars for mock claude."""

    def _make_env(scenario: dict) -> dict:
        scenario_path = tmp_path / "scenario.json"
        scenario_path.write_text(json.dumps(scenario))
        return {
            **os.environ,
            "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
            "MOCK_CLAUDE_SCENARIO": str(scenario_path),
        }

    return _make_env


@pytest.fixture
def write_scenario(tmp_path):
    """Write a scenario dict to a temp file and return its path."""

    def _write(scenario: dict) -> Path:
        path = tmp_path / "scenario.json"
        path.write_text(json.dumps(scenario))
        return path

    return _write


def make_scenario(default_action: str = "succeed", delay_s: float = 0.1,
                  agents: dict | None = None) -> dict:
    """Build a scenario dict with sensible defaults for tests."""
    scenario: dict = {"default": {"action": default_action, "delay_s": delay_s}}
    if agents:
        scenario["agents"] = agents
    return scenario


def all_succeed(delay_s: float = 0.1) -> dict:
    """Scenario where every agent succeeds quickly."""
    return {"default": {"action": "succeed", "delay_s": delay_s}}


def agent_hangs(agent: str, delay_s: float = 0.1) -> dict:
    """Scenario where one agent hangs and all others succeed."""
    return {
        "agents": {agent: {"action": "hang"}},
        "default": {"action": "succeed", "delay_s": delay_s},
    }


def agent_fails(agent: str, error: str = "Mock failure",
                delay_s: float = 0.1) -> dict:
    """Scenario where one agent fails and all others succeed."""
    return {
        "agents": {agent: {"action": "fail", "error": error, "delay_s": delay_s}},
        "default": {"action": "succeed", "delay_s": delay_s},
    }


def agent_crashes(agent: str, exit_code: int = 137, delay_s: float = 0.1) -> dict:
    """Scenario where one agent crashes with os._exit and all others succeed."""
    return {
        "agents": {agent: {"action": "crash", "exit_code": exit_code}},
        "default": {"action": "succeed", "delay_s": delay_s},
    }
