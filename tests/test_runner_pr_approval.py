"""Tests for PR-approval gate and _check_control_response_with_timeout in runner.py.

Covers:
- Default (pr_approval absent or false) skips gate
- pr_approval=true + approve
- pr_approval=true + reject
- No ctx auto-approve
- Timeout auto-approve
- _check_control_response_with_timeout: returns action before deadline,
  returns timeout_default after deadline, respects custom timeout_default
"""
import json
from unittest.mock import patch, MagicMock

import pytest

from worca.orchestrator.runner import (
    run_pipeline,
    _check_control_response_with_timeout,
    PipelineInterrupted,
)
from worca.orchestrator.work_request import WorkRequest
from worca.events.emitter import EventContext


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def _settings(tmp_path, pr_approval=None, plan_approval=False, timeout_seconds=None):
    milestones = {"plan_approval": plan_approval}
    if pr_approval is not None:
        milestones["pr_approval"] = pr_approval
    if timeout_seconds is not None:
        milestones["pr_approval_timeout_seconds"] = timeout_seconds
    data = {
        "worca": {
            "stages": {
                "plan": {"agent": "planner", "enabled": False},
                "coordinate": {"agent": "coordinator", "enabled": False},
                "implement": {"agent": "implementer", "enabled": False},
                "test": {"agent": "tester", "enabled": False},
                "review": {"agent": "guardian", "enabled": False},
                "pr": {"agent": "guardian", "enabled": True},
            },
            "agents": {
                "guardian": {"model": "opus", "max_turns": 10},
            },
            "milestones": milestones,
        }
    }
    f = tmp_path / "settings.json"
    f.write_text(json.dumps(data))
    return str(f)


def _worca(tmp_path):
    d = tmp_path / ".worca"
    d.mkdir()
    return str(d), str(d / "status.json")


def _wr(title="PR gate test"):
    return WorkRequest(source_type="prompt", title=title)


def _mock_stage(stage, result):
    return result, {"type": "result"}


@pytest.fixture(autouse=True)
def _mock_beads():
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


@pytest.fixture(autouse=True)
def _no_real_sleep():
    """Patch time.sleep across this module so the PR-approval polling loop
    in _check_control_response_with_timeout never actually blocks.

    Tests that call the helper with timeout_seconds in the tens of seconds
    would otherwise sleep poll_interval=5s on each iteration whenever the
    mock _check_control_response returns None on the first poll. Currently
    the immediate-return paths happen to dodge this, but adding any test
    that exercises the polling loop would silently slow the suite.
    """
    with patch("time.sleep"):
        yield


def _run_pr_pipeline(tmp_path, pr_approval=None, timeout_seconds=None,
                     control_action=None, emit_returns=None):
    """Run pipeline with only PR stage enabled, return status dict."""
    settings_path = _settings(tmp_path, pr_approval=pr_approval,
                              timeout_seconds=timeout_seconds)
    _, status_path = _worca(tmp_path)
    wr = _wr()

    def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                       prompt_override=None, **kwargs):
        return _mock_stage(stage, {
            "pr_url": "https://github.com/test/repo/pull/1",
            "pr_number": 1,
            "commit_sha": "abc1234567",
            "source_branch": "feature/test",
            "target_branch": "main",
        })

    patches = [
        patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage),
        patch("worca.orchestrator.runner.create_branch"),
        patch("worca.orchestrator.runner._write_pid"),
        patch("worca.orchestrator.runner._remove_pid"),
    ]
    if control_action is not None:
        patches.append(patch(
            "worca.orchestrator.runner._check_control_response_with_timeout",
            return_value=control_action,
        ))
    if emit_returns is not None:
        patches.append(patch(
            "worca.orchestrator.runner.emit_event",
            return_value=emit_returns,
        ))

    for p in patches:
        p.start()
    try:
        return run_pipeline(wr, settings_path=settings_path, status_path=status_path)
    finally:
        for p in patches:
            p.stop()


# ---------------------------------------------------------------------------
# Default: gate is skipped
# ---------------------------------------------------------------------------

class TestPrApprovalDefault:

    def test_default_skips_gate_when_absent(self, tmp_path):
        """When pr_approval is absent from settings, PR runs without gating."""
        status = _run_pr_pipeline(tmp_path, pr_approval=None)
        assert status["stages"]["pr"]["status"] == "completed"

    def test_default_skips_gate_when_false(self, tmp_path):
        """When pr_approval is explicitly false, PR runs without gating."""
        status = _run_pr_pipeline(tmp_path, pr_approval=False)
        assert status["stages"]["pr"]["status"] == "completed"


# ---------------------------------------------------------------------------
# pr_approval=true + approve
# ---------------------------------------------------------------------------

class TestPrApprovalApprove:

    def test_approve_completes_pr_stage(self, tmp_path):
        """When pr_approval=true and control returns approve, PR stage completes."""
        status = _run_pr_pipeline(
            tmp_path, pr_approval=True,
            control_action="approve",
            emit_returns={"id": "e1"},
        )
        assert status["stages"]["pr"]["status"] == "completed"
        assert status["milestones"]["pr_approved"] is True
        assert status["pipeline_status"] == "completed"


# ---------------------------------------------------------------------------
# pr_approval=true + reject
# ---------------------------------------------------------------------------

class TestPrApprovalReject:

    def test_reject_raises_pipeline_interrupted(self, tmp_path):
        """When pr_approval=true and control returns reject, pipeline is interrupted."""
        settings_path = _settings(tmp_path, pr_approval=True)
        _, status_path = _worca(tmp_path)
        wr = _wr()

        def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                           prompt_override=None, **kwargs):
            return _mock_stage(stage, {
                "pr_url": "https://github.com/test/repo/pull/1",
                "pr_number": 1,
                "commit_sha": "abc1234567",
                "source_branch": "feature/test",
                "target_branch": "main",
            })

        with patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage), \
             patch("worca.orchestrator.runner.create_branch"), \
             patch("worca.orchestrator.runner._write_pid"), \
             patch("worca.orchestrator.runner._remove_pid"), \
             patch("worca.orchestrator.runner._check_control_response_with_timeout",
                   return_value="reject"), \
             patch("worca.orchestrator.runner.emit_event", return_value={"id": "e1"}):
            with pytest.raises(PipelineInterrupted) as exc_info:
                run_pipeline(wr, settings_path=settings_path, status_path=status_path)

        assert exc_info.value.stop_reason == "pr_rejected"


# ---------------------------------------------------------------------------
# No ctx → auto-approve
# ---------------------------------------------------------------------------

class TestPrApprovalNoCtx:

    def test_no_ctx_auto_approves(self, tmp_path):
        """When pr_approval=true but no ctx, gate auto-approves without waiting."""
        settings_path = _settings(tmp_path, pr_approval=True)
        _, status_path = _worca(tmp_path)
        wr = _wr()

        def mock_run_stage(stage, context, settings_path, msize=1, iteration=1,
                           prompt_override=None, **kwargs):
            return _mock_stage(stage, {
                "pr_url": "https://github.com/test/repo/pull/1",
                "pr_number": 1,
                "commit_sha": "abc1234567",
                "source_branch": "feature/test",
                "target_branch": "main",
            })

        # Prevent ctx from being created by making EventContext raise.
        # runner.py wraps EventContext construction in `if events_path:` and
        # initializes ctx = None above it, so we force events_path to be falsy
        # by intercepting os.path.join for the events.jsonl path.
        import os.path as osp
        _orig_join = osp.join

        def null_events_join(*args):
            if len(args) >= 2 and args[-1] == "events.jsonl":
                return None
            return _orig_join(*args)

        with patch("worca.orchestrator.runner.run_stage", side_effect=mock_run_stage), \
             patch("worca.orchestrator.runner.create_branch"), \
             patch("worca.orchestrator.runner._write_pid"), \
             patch("worca.orchestrator.runner._remove_pid"), \
             patch("os.path.join", side_effect=null_events_join):
            status = run_pipeline(wr, settings_path=settings_path, status_path=status_path)

        assert status["stages"]["pr"]["status"] == "completed"
        assert status["milestones"]["pr_approved"] is True


# ---------------------------------------------------------------------------
# Timeout → auto-approve (via _check_control_response_with_timeout unit tests)
# ---------------------------------------------------------------------------

class TestPrApprovalTimeout:

    def test_timeout_auto_approves(self, tmp_path):
        """Timeout path results in auto-approve (tested via the helper mock returning approve)."""
        status = _run_pr_pipeline(
            tmp_path, pr_approval=True,
            control_action="approve",
            emit_returns={"id": "e1"},
            timeout_seconds=1,
        )
        assert status["stages"]["pr"]["status"] == "completed"
        assert status["milestones"]["pr_approved"] is True


# ---------------------------------------------------------------------------
# _check_control_response_with_timeout
# ---------------------------------------------------------------------------

class TestCheckControlResponseWithTimeout:

    def test_returns_action_before_deadline(self):
        """If _check_control_response returns non-None before deadline, return it."""
        ctx = MagicMock(spec=EventContext)
        event = {"id": "e1"}

        with patch("worca.orchestrator.runner._check_control_response", return_value="approve"):
            result = _check_control_response_with_timeout(
                ctx, event, timeout_seconds=60, timeout_default="approve",
            )
        assert result == "approve"

    def test_returns_reject_before_deadline(self):
        """If _check_control_response returns reject before deadline, return it."""
        ctx = MagicMock(spec=EventContext)
        event = {"id": "e1"}

        with patch("worca.orchestrator.runner._check_control_response", return_value="reject"):
            result = _check_control_response_with_timeout(
                ctx, event, timeout_seconds=60, timeout_default="approve",
            )
        assert result == "reject"

    def test_returns_timeout_default_after_deadline(self):
        """If deadline elapses with no action, return timeout_default."""
        ctx = MagicMock(spec=EventContext)
        event = {"id": "e1"}

        with patch("worca.orchestrator.runner._check_control_response", return_value=None), \
             patch("time.monotonic", side_effect=[0, 100, 200]):
            result = _check_control_response_with_timeout(
                ctx, event, timeout_seconds=1, timeout_default="approve",
            )
        assert result == "approve"

    def test_respects_custom_timeout_default(self):
        """Custom timeout_default is returned when deadline elapses."""
        ctx = MagicMock(spec=EventContext)
        event = {"id": "e1"}

        with patch("worca.orchestrator.runner._check_control_response", return_value=None), \
             patch("time.monotonic", side_effect=[0, 100, 200]):
            result = _check_control_response_with_timeout(
                ctx, event, timeout_seconds=1, timeout_default="reject",
            )
        assert result == "reject"

    def test_polls_until_action_received(self):
        """Helper polls multiple times, returning None, then an action."""
        ctx = MagicMock(spec=EventContext)
        event = {"id": "e1"}
        call_count = 0

        def mock_check(ctx, event):
            nonlocal call_count
            call_count += 1
            if call_count >= 3:
                return "approve"
            return None

        monotonic_values = [0, 1, 2, 3]

        with patch("worca.orchestrator.runner._check_control_response", side_effect=mock_check), \
             patch("time.monotonic", side_effect=monotonic_values), \
             patch("time.sleep"):
            result = _check_control_response_with_timeout(
                ctx, event, timeout_seconds=60, timeout_default="approve",
            )
        assert result == "approve"
        assert call_count == 3

    def test_timeout_emits_log_warning(self):
        """On timeout, a warning log line is emitted."""
        ctx = MagicMock(spec=EventContext)
        event = {"id": "e1"}

        with patch("worca.orchestrator.runner._check_control_response", return_value=None), \
             patch("time.monotonic", side_effect=[0, 100, 200]), \
             patch("worca.orchestrator.runner._log") as mock_log:
            _check_control_response_with_timeout(
                ctx, event, timeout_seconds=1, timeout_default="approve",
            )
        mock_log.assert_called()
        log_msg = mock_log.call_args[0][0]
        assert "auto-approved" in log_msg or "timeout" in log_msg
