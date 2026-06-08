"""Tests that backfill_prompt_context is wired into the resume path in runner.py.

Regression pin: on resume, after prompt_builder.load_context(), the runner must
call backfill_prompt_context(prompt_builder, status, logs_dir) to fill any keys
that were missing from the stale prompt_context.json.
"""
import json
from unittest.mock import patch

import pytest

from worca.orchestrator.runner import run_pipeline
from worca.orchestrator.stages import Stage
from worca.orchestrator.work_request import WorkRequest


def _make_settings(tmp_path):
    data = {
        "worca": {
            "stages": {
                "plan": {"agent": "planner", "enabled": False},
                "coordinate": {"agent": "coordinator", "enabled": True},
                "implement": {"agent": "implementer", "enabled": True},
                "test": {"agent": "tester", "enabled": False},
                "review": {"agent": "guardian", "enabled": False},
                "pr": {"agent": "guardian", "enabled": False},
            },
            "agents": {
                "coordinator": {"model": "opus", "max_turns": 10},
                "implementer": {"model": "sonnet", "max_turns": 10},
            },
            "loops": {},
        }
    }
    f = tmp_path / "settings.json"
    f.write_text(json.dumps(data))
    return str(f)


def _make_resumable_run(tmp_path, title="Backfill task"):
    """Create a runs/<id>/status.json that looks like a paused/failed run."""
    run_id = "20260101-000000-000-backfill"
    run_dir = tmp_path / ".worca" / "runs" / run_id
    run_dir.mkdir(parents=True)

    status = {
        "run_id": run_id,
        "pipeline_status": "failed",
        "work_request": {"title": title},
        "branch": "backfill-test-branch",
        "stages": {
            "plan": {"status": "completed"},
            "plan_review": {"status": "pending"},
            "coordinate": {"status": "pending"},
            "implement": {"status": "pending"},
            "test": {"status": "pending"},
            "review": {"status": "pending"},
            "pr": {"status": "pending"},
        },
        "milestones": {},
        "loop_counters": {},
    }
    (run_dir / "status.json").write_text(json.dumps(status))
    status_path = str(tmp_path / ".worca" / "status.json")
    return status_path, str(run_dir)


@pytest.fixture(autouse=True)
def _mock_beads():
    with patch("worca.orchestrator.runner._ensure_beads_initialized"):
        yield


def _run_with_mocks(wr, settings_path, status_path, plan, extra_patches=None):
    """Run run_pipeline with the standard set of mocks needed for unit tests."""

    def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                       prompt_override=None, **kwargs):
        if stage == Stage.COORDINATE:
            return {"beads_ids": ["beads-aaa"], "dependency_graph": {}}, {"type": "result"}
        if stage == Stage.IMPLEMENT:
            return {"files_changed": ["foo.py"], "tests_added": []}, {"type": "result"}
        return {}, {"type": "result"}

    patches = [
        patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage),
        patch("worca.orchestrator.runner._query_ready_bead", side_effect=[
            {"id": "beads-aaa", "title": "Bead AAA"},
            None,
        ]),
        patch("worca.orchestrator.runner._claim_bead", return_value=True),
        patch("worca.orchestrator.runner.bd_show", return_value={"description": ""}),
        patch("worca.orchestrator.runner.bd_close", return_value=True),
        patch("worca.orchestrator.runner.bd_label_add", return_value=True),
        patch("worca.orchestrator.runner.bd_get_effort_label", return_value=None),
        patch("worca.orchestrator.effort.bd_get_effort_label", return_value=None),
        patch("worca.orchestrator.runner.create_branch"),
        patch("worca.orchestrator.runner._write_pid"),
        patch("worca.orchestrator.runner._remove_pid"),
    ]
    if extra_patches:
        patches.extend(extra_patches)

    ctx_stack = [p.__enter__() for p in patches]
    try:
        run_pipeline(wr, resume=True, plan_file=str(plan),
                     settings_path=settings_path, status_path=status_path)
    finally:
        for p, _ in zip(reversed(patches), reversed(ctx_stack)):
            p.__exit__(None, None, None)


class TestBackfillPromptContextOnResume:

    def test_backfill_called_once_on_resume(self, tmp_path):
        """backfill_prompt_context is called exactly once after load_context on resume."""
        status_path, _ = _make_resumable_run(tmp_path)
        settings_path = _make_settings(tmp_path)
        wr = WorkRequest(source_type="prompt", title="Backfill task")
        plan = tmp_path / "plan.md"
        plan.write_text("# Plan\n")

        backfill_calls = []

        def mock_backfill(pb, stat, logs_dir=None):
            backfill_calls.append(logs_dir)
            return []

        with patch("worca.orchestrator.resume.backfill_prompt_context",
                   side_effect=mock_backfill):
            _run_with_mocks(wr, settings_path, status_path, plan)

        assert len(backfill_calls) == 1, (
            f"backfill_prompt_context should be called once on resume; "
            f"got {len(backfill_calls)} call(s)"
        )

    def test_backfill_receives_logs_dir(self, tmp_path):
        """backfill_prompt_context receives the run's logs_dir (not None)."""
        status_path, run_dir = _make_resumable_run(tmp_path)
        settings_path = _make_settings(tmp_path)
        wr = WorkRequest(source_type="prompt", title="Backfill task")
        plan = tmp_path / "plan.md"
        plan.write_text("# Plan\n")

        received_logs_dir = []

        def mock_backfill(pb, stat, logs_dir=None):
            received_logs_dir.append(logs_dir)
            return []

        with patch("worca.orchestrator.resume.backfill_prompt_context",
                   side_effect=mock_backfill):
            _run_with_mocks(wr, settings_path, status_path, plan)

        assert received_logs_dir, "backfill_prompt_context must have been called"
        assert received_logs_dir[0] is not None, (
            "logs_dir passed to backfill_prompt_context must not be None"
        )
        assert "logs" in received_logs_dir[0], (
            f"logs_dir should contain 'logs', got: {received_logs_dir[0]}"
        )

    def test_backfill_not_called_on_fresh_start(self, tmp_path):
        """backfill_prompt_context is NOT called when starting fresh (no resume)."""
        settings_path = _make_settings(tmp_path)
        (tmp_path / ".worca").mkdir(parents=True)
        wr = WorkRequest(source_type="prompt", title="Backfill task")
        plan = tmp_path / "plan.md"
        plan.write_text("# Plan\n")
        status_path = str(tmp_path / ".worca" / "status.json")

        backfill_calls = []

        def mock_backfill(pb, stat, logs_dir=None):
            backfill_calls.append(True)
            return []

        def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                           prompt_override=None, **kwargs):
            if stage == Stage.COORDINATE:
                return {"beads_ids": ["beads-aaa"], "dependency_graph": {}}, {"type": "result"}
            if stage == Stage.IMPLEMENT:
                return {"files_changed": ["foo.py"], "tests_added": []}, {"type": "result"}
            return {}, {"type": "result"}

        with patch("worca.orchestrator.resume.backfill_prompt_context",
                   side_effect=mock_backfill):
            with patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage):
                with patch("worca.orchestrator.runner._query_ready_bead", side_effect=[
                    {"id": "beads-aaa", "title": "Bead AAA"},
                    None,
                ]):
                    with patch("worca.orchestrator.runner._claim_bead", return_value=True):
                        with patch("worca.orchestrator.runner.bd_show", return_value={"description": ""}):
                            with patch("worca.orchestrator.runner.bd_close", return_value=True):
                                with patch("worca.orchestrator.runner.bd_label_add", return_value=True):
                                    with patch("worca.orchestrator.runner.bd_get_effort_label", return_value=None):
                                        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value=None):
                                            with patch("worca.orchestrator.runner.create_branch"):
                                                with patch("worca.orchestrator.runner._write_pid"):
                                                    with patch("worca.orchestrator.runner._remove_pid"):
                                                        run_pipeline(
                                                            wr,
                                                            resume=False,
                                                            plan_file=str(plan),
                                                            settings_path=settings_path,
                                                            status_path=status_path,
                                                        )

        assert len(backfill_calls) == 0, (
            f"backfill_prompt_context must NOT be called on fresh start; "
            f"got {len(backfill_calls)} call(s)"
        )


class TestResumeAfterMidImplement:
    """Integration test: resume after interruption mid-IMPLEMENT processes
    remaining beads, completes IMPLEMENT, and advances to TEST."""

    def _make_mid_implement_run(self, tmp_path):
        run_id = "20260101-000000-000-midimpl"
        run_dir = tmp_path / ".worca" / "runs" / run_id
        logs_dir = run_dir / "logs"
        coord_log_dir = logs_dir / "coordinate"
        coord_log_dir.mkdir(parents=True)

        # Write coordinate log in envelope shape (production format)
        envelope = {
            "type": "result",
            "structured_output": {
                "beads_ids": ["b1", "b2", "b3"],
                "dependency_graph": {},
            },
        }
        (coord_log_dir / "iter-1.json").write_text(json.dumps(envelope))

        status = {
            "run_id": run_id,
            "pipeline_status": "failed",
            "work_request": {"title": "Mid-implement resume"},
            "branch": "mid-impl-branch",
            "stages": {
                "plan": {"status": "completed"},
                "plan_review": {"status": "pending"},
                "coordinate": {"status": "completed"},
                "implement": {"status": "in_progress"},
                "test": {"status": "pending"},
                "review": {"status": "pending"},
                "pr": {"status": "pending"},
            },
            "milestones": {},
            "loop_counters": {"bead_iteration": 1},
        }
        (run_dir / "status.json").write_text(json.dumps(status))
        status_path = str(tmp_path / ".worca" / "status.json")
        return status_path, str(run_dir)

    def test_resume_processes_remaining_beads_and_advances(self, tmp_path):
        """After mid-IMPLEMENT interruption with 1 of 3 beads done, resume
        processes the remaining 2 beads, completes IMPLEMENT, and advances
        to TEST (which is disabled, so pipeline completes)."""
        status_path, run_dir = self._make_mid_implement_run(tmp_path)
        settings_path = _make_settings(tmp_path)
        wr = WorkRequest(source_type="prompt", title="Mid-implement resume")
        plan = tmp_path / "plan.md"
        plan.write_text("# Plan\n")

        claimed_beads = []

        def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                           prompt_override=None, **kwargs):
            if stage == Stage.IMPLEMENT:
                return {"files_changed": ["impl.py"], "tests_added": []}, {"type": "result"}
            return {}, {"type": "result"}

        def mock_claim(bead_id):
            claimed_beads.append(bead_id)
            return True

        b2 = {"id": "b2", "title": "Bead b2"}
        b3 = {"id": "b3", "title": "Bead b3"}
        # _query_ready_bead is called twice per bead: once for assignment at
        # stage entry, once after completion to check for the next bead.
        # Sequence: assign b2 → check-next returns b3 → assign b3 → check-next returns None
        bead_sequence = [b2, b3, b3, None]

        patches = [
            patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage),
            patch("worca.orchestrator.runner._query_ready_bead", side_effect=bead_sequence),
            patch("worca.orchestrator.runner._claim_bead", side_effect=mock_claim),
            patch("worca.orchestrator.runner.bd_show", return_value={"description": ""}),
            patch("worca.orchestrator.runner.bd_close", return_value=True),
            patch("worca.orchestrator.runner.bd_label_add", return_value=True),
            patch("worca.orchestrator.runner.bd_get_effort_label", return_value=None),
            patch("worca.orchestrator.effort.bd_get_effort_label", return_value=None),
            patch("worca.orchestrator.runner.create_branch"),
            patch("worca.orchestrator.runner._write_pid"),
            patch("worca.orchestrator.runner._remove_pid"),
        ]

        ctx_stack = [p.__enter__() for p in patches]
        try:
            run_pipeline(wr, resume=True, plan_file=str(plan),
                         settings_path=settings_path, status_path=status_path)
        finally:
            for p, _ in zip(reversed(patches), reversed(ctx_stack)):
                p.__exit__(None, None, None)

        assert claimed_beads == ["b2", "b3"], (
            f"Expected beads b2 and b3 to be claimed; got {claimed_beads}"
        )

        # Verify IMPLEMENT completed and pipeline advanced past it
        final_status = json.loads(
            (tmp_path / ".worca" / "runs" / "20260101-000000-000-midimpl" / "status.json").read_text()
        )
        assert final_status["stages"]["implement"]["status"] == "completed"
        assert final_status["loop_counters"]["bead_iteration"] == 3
