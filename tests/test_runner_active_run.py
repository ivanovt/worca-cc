"""Tests for W-048-01: active_run removal and _find_active_runs helper."""

import json
from unittest.mock import patch

import pytest

from worca.orchestrator.runner import run_pipeline


@pytest.fixture(autouse=True)
def _mock_beads_init():
    with patch("worca.orchestrator.runner._ensure_beads_initialized"):
        yield


@pytest.fixture(autouse=True)
def _reset_signal_event_flag():
    import worca.orchestrator.runner as runner_mod
    runner_mod._signal_event_emitted = False
    runner_mod._pending_signal_event = None
    yield
    runner_mod._signal_event_emitted = False
    runner_mod._pending_signal_event = None


def _make_minimal_settings(tmp_path):
    cfg = {
        "worca": {
            "stages": {
                "plan": {"agent": "planner", "enabled": True},
                "coordinate": {"agent": "coordinator", "enabled": False},
                "implement": {"agent": "implementer", "enabled": False},
                "test": {"agent": "tester", "enabled": False},
                "review": {"agent": "guardian", "enabled": False},
                "pr": {"agent": "guardian", "enabled": False},
            },
            "agents": {
                "planner": {"model": "opus", "max_turns": 10},
            },
            "loops": {},
        }
    }
    p = tmp_path / "settings.json"
    p.write_text(json.dumps(cfg))
    return str(p)


def _mock_run_stage(stage, context, settings_path, msize=1, iteration=1, prompt_override=None, **kwargs):
    return {}, {"type": "result"}


def test_fresh_start_no_active_run_write(tmp_path):
    """Fresh pipeline start must not write .worca/active_run pointer file."""
    from worca.orchestrator.work_request import WorkRequest

    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n")

    settings_path = _make_minimal_settings(tmp_path)
    worca_dir = tmp_path / ".worca"
    worca_dir.mkdir()
    status_path = str(worca_dir / "status.json")
    wr = WorkRequest(source_type="prompt", title="No active_run test")

    with patch("worca.orchestrator.runner.run_stage", side_effect=_mock_run_stage):
        with patch("worca.orchestrator.runner.create_branch"):
            with patch("worca.orchestrator.runner._write_pid"):
                with patch("worca.orchestrator.runner._remove_pid"):
                    run_pipeline(
                        wr,
                        plan_file=str(plan),
                        settings_path=settings_path,
                        status_path=status_path,
                    )

    assert not (worca_dir / "active_run").exists()


def test_fresh_start_per_run_pid_only(tmp_path):
    """Fresh pipeline start passes only the per-run status path to _write_pid, not the project-level path."""
    from worca.orchestrator.work_request import WorkRequest

    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n")

    settings_path = _make_minimal_settings(tmp_path)
    worca_dir = tmp_path / ".worca"
    worca_dir.mkdir()
    status_path = str(worca_dir / "status.json")
    wr = WorkRequest(source_type="prompt", title="Per-run PID test")

    pid_calls = []

    def tracking_write_pid(sp):
        pid_calls.append(sp)

    with patch("worca.orchestrator.runner.run_stage", side_effect=_mock_run_stage):
        with patch("worca.orchestrator.runner.create_branch"):
            with patch("worca.orchestrator.runner._write_pid", side_effect=tracking_write_pid):
                with patch("worca.orchestrator.runner._remove_pid"):
                    result = run_pipeline(
                        wr,
                        plan_file=str(plan),
                        settings_path=settings_path,
                        status_path=status_path,
                    )

    expected_per_run = str(worca_dir / "runs" / result["run_id"] / "status.json")
    assert expected_per_run in pid_calls, "per-run status path should be passed to _write_pid"
    assert status_path not in pid_calls, "project-level status_path must not be passed to _write_pid on fresh start"


def test_find_active_runs_single(tmp_path):
    """_find_active_runs returns one entry for a single non-terminal run."""
    from worca.orchestrator.runner import _find_active_runs

    worca_dir = str(tmp_path)
    run_dir = tmp_path / "runs" / "20260426-120000-000-abcd"
    run_dir.mkdir(parents=True)
    (run_dir / "status.json").write_text(
        json.dumps({"pipeline_status": "failed", "run_id": "20260426-120000-000-abcd"})
    )

    result = _find_active_runs(worca_dir)

    assert len(result) == 1
    assert result[0][0] == "20260426-120000-000-abcd"
    assert result[0][1] == str(run_dir / "status.json")


def test_find_active_runs_multiple(tmp_path):
    """_find_active_runs returns only non-terminal runs, skipping completed and interrupted."""
    from worca.orchestrator.runner import _find_active_runs

    worca_dir = str(tmp_path)
    statuses = [
        ("run-a", "running"),
        ("run-b", "completed"),
        ("run-c", "paused"),
        ("run-d", "interrupted"),
        ("run-e", "failed"),
    ]
    for run_id, status_val in statuses:
        d = tmp_path / "runs" / run_id
        d.mkdir(parents=True)
        (d / "status.json").write_text(json.dumps({"pipeline_status": status_val}))

    result = _find_active_runs(worca_dir)

    active_ids = [r[0] for r in result]
    assert "run-a" in active_ids
    assert "run-c" in active_ids
    assert "run-e" in active_ids
    assert "run-b" not in active_ids
    assert "run-d" not in active_ids
    assert len(result) == 3
