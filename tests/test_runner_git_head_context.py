"""Tests for git_head loaded into PromptBuilder context at runner init (W-065)."""

import json
from unittest.mock import patch

from worca.orchestrator.prompt_builder import PromptBuilder
from worca.orchestrator.runner import run_pipeline
from worca.orchestrator.work_request import WorkRequest


SHA = "deadbeef12345678deadbeef12345678deadbeef"


def _settings(tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "worca": {
            "stages": {
                "preflight": {"enabled": False},
                "plan": {"agent": "planner", "enabled": False},
                "coordinate": {"agent": "coordinator", "enabled": False},
                "implement": {"agent": "implementer", "enabled": False},
                "test": {"agent": "tester", "enabled": False},
                "review": {"agent": "guardian", "enabled": False},
                "pr": {"agent": "guardian", "enabled": False},
            },
            "agents": {},
            "loops": {},
        }
    }))
    return str(settings)


def test_git_head_loaded_into_prompt_context(tmp_path, monkeypatch):
    """After runner init, build_context('review') must include git_head from status."""
    monkeypatch.chdir(tmp_path)
    settings_path = _settings(tmp_path)
    worca_dir = tmp_path / ".worca"
    worca_dir.mkdir()
    status_path = str(worca_dir / "status.json")

    wr = WorkRequest(source_type="prompt", title="test")

    captured = {}
    original_update = PromptBuilder.update_context

    def tracking_update(self, key, value):
        original_update(self, key, value)
        captured[key] = value
        captured["_pb"] = self

    def mock_run_stage(stage, context, settings_path, msize=1, iteration=1, **kwargs):
        return {}, {"type": "result"}

    with (
        patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage),
        patch("worca.orchestrator.runner.create_branch"),
        patch("worca.orchestrator.runner._write_pid"),
        patch("worca.orchestrator.runner._remove_pid"),
        patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA),
        patch.object(PromptBuilder, "update_context", tracking_update),
    ):
        run_pipeline(wr, settings_path=settings_path, status_path=status_path)

    assert "git_head" in captured, (
        "prompt_builder.update_context was never called with key='git_head'"
    )
    assert captured["git_head"] == SHA, (
        f"Expected git_head={SHA!r}, got {captured['git_head']!r}"
    )

    pb = captured.get("_pb")
    assert pb is not None
    ctx = pb.build_context("review")
    assert ctx.get("git_head") == SHA, (
        f"build_context('review') returned git_head={ctx.get('git_head')!r}, expected {SHA!r}"
    )
    assert ctx.get("review_base") == SHA, (
        f"build_context('review') returned review_base={ctx.get('review_base')!r}, expected {SHA!r}"
    )


def test_review_stage_review_base_empty_when_no_git_head():
    """build_context('review') returns review_base='' when git_head not set."""
    pb = PromptBuilder(work_request_title="test")
    ctx = pb.build_context("review")
    assert ctx.get("review_base") == "", (
        f"Expected review_base='', got {ctx.get('review_base')!r}"
    )
