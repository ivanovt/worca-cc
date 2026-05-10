"""Integration tests: model env vars reach agent subprocesses end-to-end."""
import json


def test_model_env_reaches_subprocess(pipeline_env):
    env_dump = pipeline_env.tmp_path / "planner-env.txt"

    settings_path = pipeline_env.project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})["models"] = {
        "opus": "claude-opus-4-6",
        "custom-fast": {
            "id": "claude-haiku-4-5-20251001",
            "env": {"PIPELINE_TEST_MARKER": "hello-from-models-env"},
        },
    }
    settings["worca"].setdefault("agents", {})["planner"] = {
        "model": "custom-fast", "max_turns": 10
    }
    settings_path.write_text(json.dumps(settings))

    scenario = {
        "agents": {
            "planner": {
                "action": "succeed",
                "run_command": f"env > {env_dump}",
            },
        },
        "default": {"action": "succeed"},
    }
    result = pipeline_env.run(scenario, "smoke")

    assert env_dump.exists(), (
        f"env dump not created.\n"
        f"returncode={result.returncode}\n"
        f"status={result.status.get('pipeline_status', 'N/A')}\n"
        f"stderr={result.stderr[-2000:]}\n"
        f"stdout={result.stdout[-1000:]}"
    )
    dump = env_dump.read_text()
    assert "PIPELINE_TEST_MARKER=hello-from-models-env" in dump
    worca_agent_lines = [line for line in dump.splitlines() if "WORCA_AGENT" in line]
    assert worca_agent_lines, "WORCA_AGENT not found in dump"
    assert any("planner" in line for line in worca_agent_lines), (
        f"WORCA_AGENT not set to planner: {worca_agent_lines}"
    )


def test_reserved_key_in_model_env_is_stripped_with_warning(pipeline_env):
    env_dump = pipeline_env.tmp_path / "planner-env.txt"

    settings_path = pipeline_env.project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})["models"] = {
        "custom": {
            "id": "claude-haiku-4-5-20251001",
            "env": {
                "PATH": "/tmp/should-be-stripped",
                "ANTHROPIC_BASE_URL": "http://localhost:1",
            },
        },
    }
    settings["worca"].setdefault("agents", {})["planner"] = {
        "model": "custom", "max_turns": 10
    }
    settings_path.write_text(json.dumps(settings))

    scenario = {
        "agents": {
            "planner": {
                "action": "succeed",
                "run_command": f"env > {env_dump}",
            },
        },
        "default": {"action": "succeed"},
    }
    result = pipeline_env.run(scenario, "x")

    assert env_dump.exists(), (
        f"env dump not created.\n"
        f"returncode={result.returncode}\n"
        f"stderr={result.stderr[-2000:]}"
    )
    dump = env_dump.read_text()
    assert "PATH=/tmp/should-be-stripped" not in dump
    assert "ANTHROPIC_BASE_URL=http://localhost:1" in dump
    assert "model env keys dropped (reserved)" in result.stderr
    assert "PATH" in result.stderr
