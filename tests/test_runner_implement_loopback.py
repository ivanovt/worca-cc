"""Tests for IMPLEMENT next-bead loopback context persistence in runner.py.

Regression pin: save_context must be called before the next-bead continue at
runner.py:2633 so that assigned_bead_id, assigned_bead_title,
assigned_bead_description, all_files_changed, and all_tests_added survive a
kill/pause between bead iterations.
"""
import json
from unittest.mock import patch

import pytest

from worca.orchestrator.runner import run_pipeline
from worca.orchestrator.stages import Stage
from worca.orchestrator.work_request import WorkRequest


def _settings(tmp_path):
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


def _make_runner(tmp_path):
    settings_path = _settings(tmp_path)
    d = tmp_path / ".worca"
    d.mkdir()
    status_path = str(d / "status.json")
    wr = WorkRequest(source_type="prompt", title="Test task")
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n")
    return settings_path, status_path, wr, str(plan)


def _mock_stage(stage, result):
    return result, {"type": "result"}


@pytest.fixture(autouse=True)
def _mock_beads():
    with patch("worca.orchestrator.runner._ensure_beads_initialized"):
        yield


class TestImplementNextBeadLoopbackPersistence:

    def test_save_context_called_before_next_bead_continue(self, tmp_path):
        """save_context is called before the next-bead continue at runner.py:2633.

        Regression: without this call, assigned_bead_id, assigned_bead_title,
        assigned_bead_description, all_files_changed, and all_tests_added are
        lost if the pipeline is killed between bead iterations.
        """
        settings_path, status_path, wr, plan_file = _make_runner(tmp_path)

        bead_ids = ["beads-aaa", "beads-bbb"]
        implement_count = {"n": 0}
        call_order = []

        # Return bead-aaa first query, bead-bbb second, None thereafter
        bead_queue = iter([
            {"id": "beads-aaa", "title": "Bead AAA"},
            {"id": "beads-bbb", "title": "Bead BBB"},
        ])

        def mock_query_ready(allowed_ids=None, run_id=None):
            return next(bead_queue, None)

        def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                           prompt_override=None, **kwargs):
            call_order.append(("run_stage", stage.value))
            if stage == Stage.COORDINATE:
                return _mock_stage(stage, {"beads_ids": bead_ids, "dependency_graph": {}})
            if stage == Stage.IMPLEMENT:
                implement_count["n"] += 1
                return _mock_stage(stage, {
                    "files_changed": [f"file{implement_count['n']}.py"],
                    "tests_added": [f"test{implement_count['n']}.py"],
                })
            return _mock_stage(stage, {})

        from worca.state import status as status_mod
        original_save = status_mod.save_status

        def tracking_save(status, path):
            call_order.append(("save_status", None))
            return original_save(status, path)

        from worca.orchestrator.prompt_builder import PromptBuilder
        original_save_ctx = PromptBuilder.save_context

        def tracking_save_ctx(self, path=None):
            call_order.append(("save_context", None))
            return original_save_ctx(self, path)

        with patch("worca.orchestrator.runner.save_status", side_effect=tracking_save):
            with patch.object(PromptBuilder, "save_context", tracking_save_ctx):
                with patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage):
                    with patch("worca.orchestrator.runner._query_ready_bead", side_effect=mock_query_ready):
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
                                                                plan_file=plan_file,
                                                                settings_path=settings_path,
                                                                status_path=status_path,
                                                            )

        assert implement_count["n"] == 2, (
            f"Expected 2 IMPLEMENT runs (one per bead), got {implement_count['n']}"
        )

        impl_indices = [
            i for i, (fn, s) in enumerate(call_order)
            if fn == "run_stage" and s == "implement"
        ]
        assert len(impl_indices) >= 2, (
            f"Expected IMPLEMENT to run at least twice, got indices: {impl_indices}"
        )

        first_impl_idx = impl_indices[0]
        second_impl_idx = impl_indices[1]

        # save_context must be called between bead-aaa and bead-bbb IMPLEMENT runs
        between = call_order[first_impl_idx + 1:second_impl_idx]
        persist_fns = [fn for fn, _ in between if fn in ("save_status", "save_context")]

        assert "save_context" in persist_fns, (
            f"save_context must be called between bead iterations; "
            f"sequence between first and second IMPLEMENT: {between}"
        )
        assert "save_status" in persist_fns, (
            f"save_status must be called between bead iterations; "
            f"sequence between first and second IMPLEMENT: {between}"
        )


class TestTestToImplementLoopbackPersistence:

    def _settings_with_test(self, tmp_path):
        data = {
            "worca": {
                "stages": {
                    "plan": {"agent": "planner", "enabled": False},
                    "coordinate": {"agent": "coordinator", "enabled": True},
                    "implement": {"agent": "implementer", "enabled": True},
                    "test": {"agent": "tester", "enabled": True},
                    "review": {"agent": "guardian", "enabled": False},
                    "pr": {"agent": "guardian", "enabled": False},
                },
                "agents": {
                    "coordinator": {"model": "opus", "max_turns": 10},
                    "implementer": {"model": "sonnet", "max_turns": 10},
                    "tester": {"model": "sonnet", "max_turns": 10},
                },
                "loops": {"implement_test": 3},
            }
        }
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(data))
        return str(f)

    def test_save_context_called_before_test_to_implement_continue(self, tmp_path):
        """save_context is called before the TEST→IMPLEMENT continue at runner.py:2737.

        Regression: without this call, test_passed, test_failures,
        test_failure_history, and cleared review_* keys are lost if the
        pipeline is killed between the loopback continue and the next IMPLEMENT.
        """
        settings_path = self._settings_with_test(tmp_path)
        d = tmp_path / ".worca"
        d.mkdir()
        status_path = str(d / "status.json")
        wr = WorkRequest(source_type="prompt", title="Test task")
        plan = tmp_path / "plan.md"
        plan.write_text("# Plan\n")

        test_call_count = {"n": 0}
        call_order = []

        def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                           prompt_override=None, **kwargs):
            call_order.append(("run_stage", stage.value))
            if stage == Stage.COORDINATE:
                return {"beads_ids": ["beads-aaa"], "dependency_graph": {}}, {"type": "result"}
            if stage == Stage.IMPLEMENT:
                return {"files_changed": ["foo.py"], "tests_added": ["test_foo.py"]}, {"type": "result"}
            if stage == Stage.TEST:
                test_call_count["n"] += 1
                if test_call_count["n"] == 1:
                    return {"passed": False, "failures": [{"test_name": "test_foo", "error": "AssertionError"}]}, {"type": "result"}
                return {"passed": True, "coverage_pct": 80.0, "proof_artifacts": []}, {"type": "result"}
            return {}, {"type": "result"}

        from worca.state import status as status_mod
        original_save = status_mod.save_status

        def tracking_save(status, path):
            call_order.append(("save_status", None))
            return original_save(status, path)

        from worca.orchestrator.prompt_builder import PromptBuilder
        original_save_ctx = PromptBuilder.save_context

        def tracking_save_ctx(self, path=None):
            call_order.append(("save_context", None))
            return original_save_ctx(self, path)

        # Return bead on initial claim, None on after-implement check so the
        # pipeline drains after 1 bead and advances to TEST.
        ready_calls = [0]
        def mock_query_ready(*a, **kw):
            ready_calls[0] += 1
            if ready_calls[0] <= 1:
                return {"id": "beads-aaa", "title": "Bead AAA"}
            return None

        with patch("worca.orchestrator.runner.save_status", side_effect=tracking_save):
            with patch.object(PromptBuilder, "save_context", tracking_save_ctx):
                with patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage):
                    with patch("worca.orchestrator.runner._query_ready_bead",
                               side_effect=mock_query_ready):
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
                                                                plan_file=str(plan),
                                                                settings_path=settings_path,
                                                                status_path=status_path,
                                                            )

        assert test_call_count["n"] == 2, (
            f"Expected TEST to run twice (fail then pass), got {test_call_count['n']}"
        )

        impl_indices = [
            i for i, (fn, s) in enumerate(call_order)
            if fn == "run_stage" and s == "implement"
        ]
        test_indices = [
            i for i, (fn, s) in enumerate(call_order)
            if fn == "run_stage" and s == "test"
        ]
        assert len(impl_indices) >= 2, (
            f"Expected IMPLEMENT to run at least twice (initial + fix), got {impl_indices}"
        )
        assert len(test_indices) >= 1, f"Expected TEST to run, got {test_indices}"

        first_test_idx = test_indices[0]
        second_impl_idx = impl_indices[1]

        # save_context must be called between first failed TEST and second IMPLEMENT
        between = call_order[first_test_idx + 1:second_impl_idx]
        persist_fns = [fn for fn, _ in between if fn in ("save_status", "save_context")]

        assert "save_context" in persist_fns, (
            f"save_context must be called between failed TEST and fix IMPLEMENT; "
            f"sequence between first TEST and second IMPLEMENT: {between}"
        )
        assert "save_status" in persist_fns, (
            f"save_status must be called between failed TEST and fix IMPLEMENT; "
            f"sequence between first TEST and second IMPLEMENT: {between}"
        )


class TestReviewToImplementLoopbackPersistence:

    def _settings_with_review(self, tmp_path):
        data = {
            "worca": {
                "stages": {
                    "plan": {"agent": "planner", "enabled": False},
                    "coordinate": {"agent": "coordinator", "enabled": True},
                    "implement": {"agent": "implementer", "enabled": True},
                    "test": {"agent": "tester", "enabled": False},
                    "review": {"agent": "guardian", "enabled": True},
                    "pr": {"agent": "guardian", "enabled": False},
                },
                "agents": {
                    "coordinator": {"model": "opus", "max_turns": 10},
                    "implementer": {"model": "sonnet", "max_turns": 10},
                    "guardian": {"model": "opus", "max_turns": 10},
                },
                "loops": {"pr_changes": 3},
            }
        }
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(data))
        return str(f)

    def test_save_context_called_before_review_to_implement_continue(self, tmp_path):
        """save_context is called before the REVIEW→IMPLEMENT continue at runner.py:2863.

        Regression: without this call, review_history, review_issues, and cleared
        test_* keys are lost if the pipeline is killed between the loopback
        continue and the next IMPLEMENT.
        """
        settings_path = self._settings_with_review(tmp_path)
        d = tmp_path / ".worca"
        d.mkdir()
        status_path = str(d / "status.json")
        wr = WorkRequest(source_type="prompt", title="Test task")
        plan = tmp_path / "plan.md"
        plan.write_text("# Plan\n")

        review_call_count = {"n": 0}
        call_order = []

        def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                           prompt_override=None, **kwargs):
            call_order.append(("run_stage", stage.value))
            if stage == Stage.COORDINATE:
                return {"beads_ids": ["beads-aaa"], "dependency_graph": {}}, {"type": "result"}
            if stage == Stage.IMPLEMENT:
                return {"files_changed": ["foo.py"], "tests_added": ["test_foo.py"]}, {"type": "result"}
            if stage == Stage.REVIEW:
                review_call_count["n"] += 1
                if review_call_count["n"] == 1:
                    return {
                        "outcome": "request_changes",
                        "issues": [{"severity": "critical", "description": "Critical bug found"}],
                    }, {"type": "result"}
                return {"outcome": "approve", "issues": []}, {"type": "result"}
            return {}, {"type": "result"}

        from worca.state import status as status_mod
        original_save = status_mod.save_status

        def tracking_save(status, path):
            call_order.append(("save_status", None))
            return original_save(status, path)

        from worca.orchestrator.prompt_builder import PromptBuilder
        original_save_ctx = PromptBuilder.save_context

        def tracking_save_ctx(self, path=None):
            call_order.append(("save_context", None))
            return original_save_ctx(self, path)

        # Return bead on initial claim, None on after-implement check so the
        # pipeline drains after 1 bead and advances to REVIEW.
        ready_calls = [0]
        def mock_query_ready(*a, **kw):
            ready_calls[0] += 1
            if ready_calls[0] <= 1:
                return {"id": "beads-aaa", "title": "Bead AAA"}
            return None

        with patch("worca.orchestrator.runner.save_status", side_effect=tracking_save):
            with patch.object(PromptBuilder, "save_context", tracking_save_ctx):
                with patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage):
                    with patch("worca.orchestrator.runner._query_ready_bead",
                               side_effect=mock_query_ready):
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
                                                                plan_file=str(plan),
                                                                settings_path=settings_path,
                                                                status_path=status_path,
                                                            )

        assert review_call_count["n"] == 2, (
            f"Expected REVIEW to run twice (changes then approve), got {review_call_count['n']}"
        )

        review_indices = [
            i for i, (fn, s) in enumerate(call_order)
            if fn == "run_stage" and s == "review"
        ]
        impl_indices = [
            i for i, (fn, s) in enumerate(call_order)
            if fn == "run_stage" and s == "implement"
        ]
        assert len(review_indices) >= 1, f"Expected REVIEW to run, got {review_indices}"
        assert len(impl_indices) >= 2, (
            f"Expected IMPLEMENT to run at least twice (initial + fix), got {impl_indices}"
        )

        first_review_idx = review_indices[0]
        second_impl_idx = impl_indices[1]

        # save_context must be called between first REVIEW (request_changes) and second IMPLEMENT
        between = call_order[first_review_idx + 1:second_impl_idx]
        persist_fns = [fn for fn, _ in between if fn in ("save_status", "save_context")]

        assert "save_context" in persist_fns, (
            f"save_context must be called between REVIEW request_changes and fix IMPLEMENT; "
            f"sequence between first REVIEW and second IMPLEMENT: {between}"
        )
        assert "save_status" in persist_fns, (
            f"save_status must be called between REVIEW request_changes and fix IMPLEMENT; "
            f"sequence between first REVIEW and second IMPLEMENT: {between}"
        )
