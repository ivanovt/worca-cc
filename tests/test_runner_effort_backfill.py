"""Tests for effort label backfill from coordinate structured output."""

import json
import os
from unittest.mock import patch

import pytest

from worca.orchestrator.runner import run_pipeline
from worca.orchestrator.work_request import WorkRequest


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


def _make_settings(tmp_path, effort=None):
    settings = {"worca": {"stages": {}, "agents": {}, "models": {}}}
    if effort is not None:
        settings["worca"]["effort"] = effort
    path = str(tmp_path / "settings.json")
    with open(path, "w") as f:
        json.dump(settings, f)
    return path


def _make_wr():
    return WorkRequest(source_type="prompt", title="test", description="test desc")


def _coordinate_result(beads, effort=None):
    r = {"beads_ids": beads, "dependency_graph": {}}
    if effort is not None:
        r["effort"] = effort
    return r


def _make_stage_side_effect(coordinate_result):
    call_count = [0]
    def stage_side_effect(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            return ({"approach": "ok", "tasks_outline": []}, {})
        elif call_count[0] == 2:
            return (coordinate_result, {})
        raise Exception("stop")
    return stage_side_effect


class TestEffortBackfillFromStructuredOutput:
    """Effort labels are applied programmatically from coordinate's effort map."""

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_applies_effort_labels_from_map(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(
            ["bead-1", "bead-2"],
            effort={"bead-1": "high", "bead-2": "low"},
        )
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        label_calls = mock_label.call_args_list
        effort_labels = [
            c for c in label_calls
            if len(c.args) >= 2 and "worca-effort:" in str(c.args[1])
        ]
        assert len(effort_labels) == 2, f"Expected 2 effort label calls, got: {label_calls}"

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_skips_unknown_bead_id_with_warning(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(
            ["bead-1"],
            effort={"bead-1": "high", "bead-unknown": "low"},
        )
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        skip_warnings = [m for m in log_messages if "bead-unknown" in m and "skip" in m.lower()]
        assert skip_warnings, f"Expected skip warning for unknown bead, got: {log_messages}"

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_skips_invalid_level_with_warning(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(
            ["bead-1"],
            effort={"bead-1": "ultra"},
        )
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        skip_warnings = [m for m in log_messages if "ultra" in m and "skip" in m.lower()]
        assert skip_warnings, f"Expected skip warning for invalid level, got: {log_messages}"

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_preserves_existing_effort_label(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.side_effect = lambda bid: "medium" if bid == "bead-1" else None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(
            ["bead-1", "bead-2"],
            effort={"bead-1": "high", "bead-2": "low"},
        )
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        label_calls = mock_label.call_args_list
        effort_labels = [
            c for c in label_calls
            if len(c.args) >= 2 and "worca-effort:" in str(c.args[1])
        ]
        assert len(effort_labels) == 1, (
            f"Expected 1 effort label call (bead-2 only; bead-1 preserved), got: {effort_labels}"
        )
        assert effort_labels[0].args[1] == "worca-effort:low"

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_backfilled_beads_excluded_from_unlabeled_warning(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(
            ["bead-1", "bead-2", "bead-3"],
            effort={"bead-1": "high", "bead-2": "low"},
        )
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        unlabeled_warnings = [
            m for m in log_messages
            if "missing worca-effort" in m.lower() or "unlabeled" in m.lower()
        ]
        assert unlabeled_warnings, "Expected unlabeled warning for bead-3"
        for w in unlabeled_warnings:
            assert "bead-1" not in w, f"bead-1 was backfilled, should not be in warning: {w}"
            assert "bead-2" not in w, f"bead-2 was backfilled, should not be in warning: {w}"
            assert "bead-3" in w, f"bead-3 was not backfilled, should be in warning: {w}"

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_no_unlabeled_warning_when_all_backfilled(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(
            ["bead-1", "bead-2"],
            effort={"bead-1": "high", "bead-2": "low"},
        )
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        unlabeled_warnings = [
            m for m in log_messages
            if "missing worca-effort" in m.lower()
        ]
        assert not unlabeled_warnings, (
            f"No unlabeled warning expected when all beads backfilled, got: {unlabeled_warnings}"
        )

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_empty_effort_map_no_crash(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(["bead-1"], effort={})
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        label_calls = mock_label.call_args_list
        effort_labels = [
            c for c in label_calls
            if len(c.args) >= 2 and "worca-effort:" in str(c.args[1])
        ]
        assert len(effort_labels) == 0, f"No effort labels expected from empty map, got: {effort_labels}"

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        unlabeled_warnings = [
            m for m in log_messages if "missing worca-effort" in m.lower()
        ]
        assert unlabeled_warnings, "Expected unlabeled warning with empty effort map"

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_no_effort_map_falls_through_to_original_warning(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(["bead-1", "bead-2"])
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        unlabeled_warnings = [
            m for m in log_messages
            if "missing worca-effort" in m.lower()
        ]
        assert unlabeled_warnings, "Expected original unlabeled warning when no effort map"
        assert "bead-1" in unlabeled_warnings[0]
        assert "bead-2" in unlabeled_warnings[0]

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_logs_backfill_count(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None

        settings_path = _make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        result = _coordinate_result(
            ["bead-1", "bead-2"],
            effort={"bead-1": "high", "bead-2": "low"},
        )
        mock_stage.side_effect = _make_stage_side_effect(result)

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        backfill_logs = [m for m in log_messages if "effort" in m.lower() and "backfill" in m.lower()]
        assert backfill_logs, f"Expected backfill log line, got: {log_messages}"
