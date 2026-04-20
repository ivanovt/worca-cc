#!/usr/bin/env python3
"""Mock Claude CLI for integration testing.

Reads MOCK_CLAUDE_SCENARIO env var for a path to a JSON scenario file.
Parses --agent from argv to select a per-agent directive.
Emits stream-JSON events matching Claude CLI output format, then exits.
"""
import json
import os
import signal
import sys
import time


import re

_RESOLVED_RE = re.compile(r"^[a-z_]+-([a-z_]+)-iter-\d+$")


def _extract_agent_name(agent_path):
    """Extract agent name from either a plain path or a resolved template path.

    Plain:    .claude/worca/agents/core/planner.md → planner
    Resolved: .worca/runs/.../resolved/plan-planner-iter-1.md → planner
    """
    stem = os.path.splitext(os.path.basename(agent_path))[0]
    m = _RESOLVED_RE.match(stem)
    return m.group(1) if m else stem


def main():
    scenario_path = os.environ.get("MOCK_CLAUDE_SCENARIO")
    if not scenario_path:
        sys.exit("MOCK_CLAUDE_SCENARIO env var not set")

    with open(scenario_path) as f:
        scenario = json.load(f)

    agent_raw = None
    for i, arg in enumerate(sys.argv):
        if arg == "--agent" and i + 1 < len(sys.argv):
            agent_raw = sys.argv[i + 1]
            break

    agent = _extract_agent_name(agent_raw) if agent_raw else None
    agents_cfg = scenario.get("agents", {})
    directive = agents_cfg.get(agent) or scenario.get("default", {})
    action = directive.get("action", "succeed")
    delay = directive.get("delay_s", 0.5)

    print(json.dumps({
        "type": "system",
        "subtype": "init",
        "model": "mock-model",
        "session_id": "mock-session",
    }))
    sys.stdout.flush()

    time.sleep(delay)

    if action == "succeed":
        result_text = directive.get("result_text", "Done.")
        print(json.dumps({
            "type": "result",
            "subtype": "success",
            "result": result_text,
            "num_turns": 1,
            "total_cost_usd": 0.001,
            "duration_ms": int(delay * 1000),
        }))
        sys.stdout.flush()

    elif action == "fail":
        error_msg = directive.get("error", "Mock failure")
        print(json.dumps({
            "type": "result",
            "subtype": "error_max_turns",
            "result": error_msg,
            "num_turns": 1,
            "total_cost_usd": 0.001,
            "duration_ms": int(delay * 1000),
        }))
        sys.stdout.flush()
        sys.exit(1)

    elif action == "hang":
        if hasattr(signal, "pause"):
            signal.pause()
        else:
            time.sleep(3600)

    elif action == "crash":
        os._exit(directive.get("exit_code", 137))

    elif action == "slow":
        slow_s = directive.get("slow_s", 30)
        time.sleep(slow_s)
        print(json.dumps({
            "type": "result",
            "subtype": "success",
            "result": "Done after delay.",
            "num_turns": 1,
            "total_cost_usd": 0.01,
            "duration_ms": int((delay + slow_s) * 1000),
        }))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
