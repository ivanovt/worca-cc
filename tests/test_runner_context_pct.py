"""Tests for context_final_pct wiring in runner.py.

Step 4 of the context-consumed plan:
  4a: context_final_pct forwarded to cost_stage_total_payload() in COST_STAGE_TOTAL event
  4b: context_final_pct hoisted to iter_extras root, persisted in status.json iteration
"""

import json
from glob import glob
from unittest.mock import patch

import pytest

from worca.events.types import COST_STAGE_TOTAL
from worca.orchestrator.runner import run_pipeline
from worca.orchestrator.work_request import WorkRequest


@pytest.fixture(autouse=True)
def _mock_beads_init():
    with patch("worca.orchestrator.runner._ensure_beads_initialized"):
        yield


@pytest.fixture(autouse=True)
def _reset_signal_flags():
    import worca.orchestrator.runner as runner_mod
    runner_mod._signal_event_emitted = False
    runner_mod._pending_signal_event = None
    yield
    runner_mod._signal_event_emitted = False
    runner_mod._pending_signal_event = None


def _make_settings(tmp_path):
    settings = {"worca": {"stages": {}, "agents": {}, "models": {}}}
    path = str(tmp_path / "settings.json")
    with open(path, "w") as f:
        json.dump(settings, f)
    return path


def _make_wr():
    return WorkRequest(source_type="prompt", title="test", description="test desc")


def _plan_stage_side_effect(plan_result):
    """run_stage mock: returns plan_result on first call, raises on second."""
    call_count = [0]
    def _side(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            return (plan_result, {"num_turns": 3})
        raise Exception("stop")
    return _side


_USAGE_WITH_CTX = {
    "context_final_pct": 42.5,
    "total_cost_usd": 0.01,
    "input_tokens": 100,
    "output_tokens": 50,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "web_search_requests": 0,
    "web_fetch_requests": 0,
}

_USAGE_WITHOUT_CTX = {
    "context_final_pct": None,
    "total_cost_usd": 0.01,
    "input_tokens": 100,
    "output_tokens": 50,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "web_search_requests": 0,
    "web_fetch_requests": 0,
}


def _run_to_plan(tmp_path, usage_dict):
    """Run pipeline through Plan stage, stop at Coordinate. Returns settings/status paths."""
    settings_path = _make_settings(tmp_path)
    status_path = str(tmp_path / "status.json")
    plan_result = {"approach": "ok", "tasks_outline": []}

    with (
        patch("worca.orchestrator.runner.extract_token_usage", return_value=usage_dict),
        patch("worca.orchestrator.runner.emit_event") as mock_emit,
        patch("worca.orchestrator.runner.run_stage",
              side_effect=_plan_stage_side_effect(plan_result)),
        patch("worca.orchestrator.runner.create_branch"),
        patch("worca.orchestrator.runner.current_branch", return_value="main"),
        patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123"),
        patch("worca.orchestrator.runner._log"),
    ):
        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                _make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )
        return mock_emit.call_args_list, status_path, tmp_path


# ---------------------------------------------------------------------------
# 4a: context_final_pct forwarded to cost_stage_total_payload()
# ---------------------------------------------------------------------------


class TestContextFinalPctInCostEvent:

    def test_cost_event_includes_context_final_pct(self, tmp_path):
        """COST_STAGE_TOTAL payload carries context_final_pct when usage has it."""
        emit_calls, _, _ = _run_to_plan(tmp_path, _USAGE_WITH_CTX)

        cost_calls = [
            c for c in emit_calls
            if len(c.args) >= 3 and c.args[1] == COST_STAGE_TOTAL
        ]
        assert cost_calls, f"No COST_STAGE_TOTAL event emitted; all calls: {emit_calls}"
        payload = cost_calls[0].args[2]
        assert payload.get("context_final_pct") == 42.5, (
            f"Expected context_final_pct=42.5 in COST_STAGE_TOTAL payload, got: {payload}"
        )

    def test_cost_event_omits_context_final_pct_when_none(self, tmp_path):
        """COST_STAGE_TOTAL payload omits context_final_pct when usage has None."""
        emit_calls, _, _ = _run_to_plan(tmp_path, _USAGE_WITHOUT_CTX)

        cost_calls = [
            c for c in emit_calls
            if len(c.args) >= 3 and c.args[1] == COST_STAGE_TOTAL
        ]
        if cost_calls:
            payload = cost_calls[0].args[2]
            assert "context_final_pct" not in payload, (
                f"Expected no context_final_pct in COST_STAGE_TOTAL payload, got: {payload}"
            )


# ---------------------------------------------------------------------------
# 4b: context_final_pct hoisted to iter_extras root → status.json iteration
# ---------------------------------------------------------------------------


def _read_plan_iteration(tmp_path):
    """Find status.json under runs/ and return the last plan-stage iteration dict."""
    status_files = glob(str(tmp_path / "runs" / "*" / "status.json"))
    assert status_files, "No status.json found in runs/ directory"
    with open(status_files[0]) as f:
        status = json.load(f)
    plan_stage = status.get("stages", {}).get("plan", {})
    iterations = plan_stage.get("iterations", [])
    assert iterations, "No plan-stage iterations in status.json"
    return iterations[-1]


class TestContextFinalPctInIterExtras:

    def test_iter_includes_context_final_pct_at_root(self, tmp_path):
        """status.json plan iteration carries context_final_pct at top level."""
        _, _, tmp = _run_to_plan(tmp_path, _USAGE_WITH_CTX)
        iteration = _read_plan_iteration(tmp)
        assert iteration.get("context_final_pct") == 42.5, (
            f"Expected context_final_pct=42.5 in plan iteration, got: {iteration}"
        )

    def test_iter_omits_context_final_pct_when_none(self, tmp_path):
        """status.json plan iteration has no context_final_pct when usage returns None."""
        _, _, tmp = _run_to_plan(tmp_path, _USAGE_WITHOUT_CTX)
        iteration = _read_plan_iteration(tmp)
        assert "context_final_pct" not in iteration, (
            f"Expected no context_final_pct in plan iteration, got: {iteration}"
        )
