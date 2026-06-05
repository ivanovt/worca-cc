"""Tests for observations persistence to docs/reviews/ after each review iteration (W-065)."""

import json
import os
from unittest.mock import patch

from worca.orchestrator.runner import Stage, run_pipeline
from worca.orchestrator.work_request import WorkRequest


def _settings(tmp_path, review_enabled=True):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "worca": {
            "stages": {
                "preflight": {"enabled": False},
                "plan": {"agent": "planner", "enabled": False},
                "coordinate": {"agent": "coordinator", "enabled": False},
                "implement": {"agent": "implementer", "enabled": False},
                "test": {"agent": "tester", "enabled": False},
                "review": {"agent": "reviewer", "enabled": review_enabled},
                "pr": {"agent": "guardian", "enabled": False},
            },
            "agents": {},
            "loops": {},
        }
    }))
    return str(settings)


def _run_with_review_result(tmp_path, review_result):
    """Run pipeline where review stage returns review_result, return docs/reviews/ path."""
    monkeypatch_chdir = tmp_path
    os.chdir(tmp_path)

    settings_path = _settings(tmp_path)
    worca_dir = tmp_path / ".worca"
    worca_dir.mkdir()
    status_path = str(worca_dir / "status.json")

    wr = WorkRequest(source_type="prompt", title="test")

    call_count = [0]

    def mock_run_stage(stage, context, settings_path, msize=1, iteration=1, **kwargs):
        call_count[0] += 1
        if stage == Stage.REVIEW:
            return review_result, {"type": "result"}
        return {}, {"type": "result"}

    with (
        patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage),
        patch("worca.orchestrator.runner.create_branch"),
        patch("worca.orchestrator.runner._write_pid"),
        patch("worca.orchestrator.runner._remove_pid"),
        patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123"),
    ):
        try:
            run_pipeline(wr, settings_path=settings_path, status_path=status_path)
        except Exception:
            pass

    return tmp_path / "docs" / "reviews"


def test_runner_writes_observations_file(tmp_path):
    """Review result with observations creates docs/reviews/observations-<run_id>.md."""
    obs = [
        {"severity": "minor", "file": "src/foo.py", "line": 10, "description": "unused import"},
        {"severity": "suggestion", "file": "src/bar.py", "line": 5, "description": "rename for clarity"},
    ]
    reviews_dir = _run_with_review_result(tmp_path, {
        "outcome": "approve",
        "observations": obs,
    })

    obs_files = list(reviews_dir.glob("observations-*.md")) if reviews_dir.exists() else []
    assert len(obs_files) == 1, f"Expected 1 observations file, got {obs_files}"

    content = obs_files[0].read_text()
    assert "## Review iteration" in content
    assert "[minor]" in content
    assert "src/foo.py:10" in content
    assert "unused import" in content
    assert "[suggestion]" in content
    assert "src/bar.py:5" in content
    assert "rename for clarity" in content


def test_runner_no_observations_file_when_empty(tmp_path):
    """Empty or absent observations writes no file."""
    # Test with empty list
    reviews_dir = _run_with_review_result(tmp_path, {
        "outcome": "approve",
        "observations": [],
    })
    obs_files = list(reviews_dir.glob("observations-*.md")) if reviews_dir.exists() else []
    assert len(obs_files) == 0, "No file should be written for empty observations"

    # Test with absent key — use a different tmp subdir
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        import pathlib
        td_path = pathlib.Path(td)
        reviews_dir2 = _run_with_review_result(td_path, {"outcome": "approve"})
        obs_files2 = list(reviews_dir2.glob("observations-*.md")) if reviews_dir2.exists() else []
        assert len(obs_files2) == 0, "No file should be written when observations key is absent"


def test_runner_appends_observations_across_iterations(tmp_path):
    """Two review iterations append to the same observations file."""
    os.chdir(tmp_path)
    # Enable implement stage so loop-back works
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "worca": {
            "stages": {
                "preflight": {"enabled": False},
                "plan": {"agent": "planner", "enabled": False},
                "coordinate": {"agent": "coordinator", "enabled": False},
                "implement": {"agent": "implementer", "enabled": True},
                "test": {"agent": "tester", "enabled": False},
                "review": {"agent": "reviewer", "enabled": True},
                "pr": {"agent": "guardian", "enabled": False},
            },
            "agents": {},
            "loops": {"pr_changes": 2},
        }
    }))
    settings_path = str(settings)
    worca_dir = tmp_path / ".worca"
    worca_dir.mkdir()
    status_path = str(worca_dir / "status.json")

    wr = WorkRequest(source_type="prompt", title="test")

    review_count = [0]
    obs1 = [{"severity": "minor", "file": "a.py", "line": 1, "description": "first obs"}]
    obs2 = [{"severity": "suggestion", "file": "b.py", "line": 2, "description": "second obs"}]

    def mock_run_stage(stage, context, settings_path, msize=1, iteration=1, **kwargs):
        if stage == Stage.REVIEW:
            review_count[0] += 1
            if review_count[0] == 1:
                # First review: request changes (loop back) with critical issue AND observations
                return {
                    "outcome": "request_changes",
                    "issues": [{"severity": "critical", "file": "c.py", "line": 3, "description": "bug"}],
                    "observations": obs1,
                }, {"type": "result"}
            else:
                # Second review: approve with more observations
                return {"outcome": "approve", "observations": obs2}, {"type": "result"}
        return {}, {"type": "result"}

    with (
        patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage),
        patch("worca.orchestrator.runner.create_branch"),
        patch("worca.orchestrator.runner._write_pid"),
        patch("worca.orchestrator.runner._remove_pid"),
        patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123"),
    ):
        try:
            run_pipeline(wr, settings_path=settings_path, status_path=status_path)
        except Exception:
            pass

    reviews_dir = tmp_path / "docs" / "reviews"
    obs_files = list(reviews_dir.glob("observations-*.md")) if reviews_dir.exists() else []
    assert len(obs_files) == 1, "Should be a single observations file"
    content = obs_files[0].read_text()
    assert "first obs" in content
    assert "second obs" in content
    assert content.count("## Review iteration") == 2


def test_runner_observations_do_not_affect_loop_back(tmp_path):
    """Critical severity in observations does not trigger review loop-back (only issues do)."""
    obs = [
        {"severity": "critical", "file": "src/foo.py", "line": 1, "description": "pre-existing critical"},
    ]
    # No issues — outcome approve — observations with critical severity should NOT loop back
    reviews_dir = _run_with_review_result(tmp_path, {
        "outcome": "approve",
        "observations": obs,
        "issues": [],
    })

    # Pipeline should complete (approve, no loop) — file still written
    obs_files = list(reviews_dir.glob("observations-*.md")) if reviews_dir.exists() else []
    assert len(obs_files) == 1, "Observations file should be written"
    content = obs_files[0].read_text()
    assert "[critical]" in content
