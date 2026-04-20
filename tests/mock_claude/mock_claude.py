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

    agent = os.path.splitext(os.path.basename(agent_raw))[0] if agent_raw else None
    agents_cfg = scenario.get("agents", {})
    directive = agents_cfg.get(agent) or agents_cfg.get(agent_raw) or scenario.get("default", {})
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
        time.sleep(directive.get("slow_s", 30))
        print(json.dumps({
            "type": "result",
            "subtype": "success",
            "result": "Done after delay.",
            "num_turns": 1,
            "total_cost_usd": 0.01,
            "duration_ms": int(delay * 1000),
        }))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
