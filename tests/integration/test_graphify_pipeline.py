"""W-053 Phase 2 — full pipeline with graphify enabled (mode=structural).

Asserts:
- Preflight invokes mock graphify CLI (--update --no-llm)
- Planner prompt contains graph section (## Codebase Structure)
- Pipeline completes successfully
- status.json records graphify_status=ready
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tests.integration.helpers import _find_latest_status


MOCK_GRAPHIFY_DIR = Path(__file__).parent.parent / "mock_graphify"
MOCK_CLAUDE_BIN = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"

pytestmark = [pytest.mark.timeout(180), pytest.mark.allow_worca_writes]


def _tester_pass() -> dict:
    return {"action": "succeed", "delay_s": 0.05,
            "structured_output": {"passed": True}}


def _review_approve() -> dict:
    return {"action": "succeed", "delay_s": 0.05,
            "structured_output": {"outcome": "approve", "issues": []}}


def _happy_scenario() -> dict:
    return {
        "agents": {
            "tester": _tester_pass(),
            "reviewer": _review_approve(),
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }


def _setup_global_graphify(pipeline_env) -> Path:
    """Create a temp WORCA_HOME with global graphify enabled."""
    worca_home = pipeline_env.tmp_path / "worca_home"
    worca_home.mkdir(exist_ok=True)
    global_settings = {"worca": {"graphify": {"enabled": True}}}
    (worca_home / "settings.json").write_text(json.dumps(global_settings))
    return worca_home


def _run_pipeline_with_graphify(pipeline_env, scenario: dict, prompt: str,
                                 graphify_log_path: Path) -> subprocess.CompletedProcess:
    """Run the pipeline subprocess with mock graphify on PATH."""
    scenario_path = pipeline_env.tmp_path / "scenario_graphify.json"
    scenario_path.write_text(json.dumps(scenario))

    cmd = [sys.executable, "-m", "worca.scripts.run_pipeline",
           "--prompt", prompt]

    worca_home = _setup_global_graphify(pipeline_env)
    mock_path = f"{MOCK_GRAPHIFY_DIR}{os.pathsep}{os.environ.get('PATH', '')}"
    env = {
        **os.environ,
        "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
        "WORCA_AGENT": "",
        "WORCA_SKIP_BEADS": "1",
        "MOCK_CLAUDE_SCENARIO": str(scenario_path),
        "PATH": mock_path,
        "MOCK_GRAPHIFY_LOG": str(graphify_log_path),
        "WORCA_HOME": str(worca_home),
    }
    for key in ("WORCA_PLAN_FILE", "WORCA_PROJECT_ROOT", "WORCA_RUN_ID", "WORCA_RUN_DIR"):
        env.pop(key, None)

    return subprocess.run(
        cmd, cwd=str(pipeline_env.project), env=env,
        capture_output=True, text=True, timeout=120,
    )


def _enable_graphify_settings(pipeline_env, mode: str = "structural") -> None:
    """Enable graphify in project settings."""
    settings_path = pipeline_env.project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings["worca"]["graphify"] = {
        "enabled": True,
        "mode": mode,
        "out_dir": "graphify-out",
        "update_on": {"preflight": True},
        "version_range": ">=4,<5",
    }
    settings_path.write_text(json.dumps(settings, indent=2))


# ===========================================================================
# 1. Mock graphify invoked by preflight + graph injected into planner prompt
# ===========================================================================

def test_graphify_preflight_invokes_mock_and_injects_graph(pipeline_env):
    pipeline_env.enable_stages("preflight")
    _enable_graphify_settings(pipeline_env, mode="structural")
    log_path = pipeline_env.tmp_path / "mock_graphify_invocations.jsonl"

    result = _run_pipeline_with_graphify(
        pipeline_env, _happy_scenario(), "graphify pipeline test", log_path,
    )

    assert result.returncode == 0, (
        f"Pipeline failed (rc={result.returncode}).\nstderr: {result.stderr[-2000:]}"
    )

    # 1. Mock graphify was invoked with --update --no-llm
    assert log_path.exists(), f"Mock graphify was never invoked.\nstderr: {result.stderr[-1000:]}"
    invocations = [
        json.loads(line) for line in log_path.read_text().splitlines() if line.strip()
    ]
    assert len(invocations) >= 1
    update_calls = [i for i in invocations if "--update" in i["argv"]]
    assert update_calls, f"No --update invocation found in {invocations}"
    assert "--no-llm" in update_calls[0]["argv"]

    # 2. GRAPH_REPORT.md was created
    report_path = pipeline_env.project / "graphify-out" / "GRAPH_REPORT.md"
    assert report_path.exists(), "GRAPH_REPORT.md was not created by mock graphify"

    # 3. Verify status records graphify state
    worca_dir = pipeline_env.project / ".worca"
    status = _find_latest_status(worca_dir)
    assert status.get("graphify_status") == "ready"
    assert status["pipeline_status"] == "completed"
    assert status.get("graphify_report_path")

    # 4. The plan stage's rendered prompt (from plan.block.md) contains
    #    the graph section. The rendered prompt is stored in the status.json
    #    under stages.plan.prompt (written at runner.py:2221).
    plan_stage = status.get("stages", {}).get("plan", {})
    plan_prompt = plan_stage.get("prompt", "")
    assert "## Codebase Structure (advisory)" in plan_prompt, (
        f"Plan stage prompt missing graph section.\n"
        f"graphify_report_path: {status.get('graphify_report_path')!r}\n"
        f"prompt preview:\n{plan_prompt[:1000]}"
    )
    assert "Graph Report (mock)" in plan_prompt, (
        "Plan stage prompt missing mock graph report content"
    )


# ===========================================================================
# 2. Pipeline completes identically when graphify disabled (regression guard)
# ===========================================================================

def test_graphify_disabled_no_invocation(pipeline_env):
    """With graphify disabled, the mock is never invoked and pipeline completes."""
    pipeline_env.enable_stages("preflight")
    log_path = pipeline_env.tmp_path / "mock_graphify_disabled.jsonl"

    result = _run_pipeline_with_graphify(
        pipeline_env, _happy_scenario(), "graphify disabled test", log_path,
    )

    assert result.returncode == 0, f"stderr: {result.stderr[-500:]}"

    if log_path.exists():
        invocations = [
            json.loads(line) for line in log_path.read_text().splitlines()
            if line.strip()
        ]
        assert not invocations, f"Graphify should not be invoked when disabled: {invocations}"

    worca_dir = pipeline_env.project / ".worca"
    status = _find_latest_status(worca_dir)
    assert status["pipeline_status"] == "completed"
    assert status.get("graphify_status") in (None, "skipped")
