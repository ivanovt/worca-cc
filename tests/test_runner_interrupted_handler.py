"""
Tests for W-043/B2: PipelineInterrupted except handler and control-file stop branch.

Verifies:
- except PipelineInterrupted sets pipeline_status=interrupted (not failed)
- except handler uses exc.stop_reason (not hardcoded "stopped")
- control-file stop branch sets interrupted/control_file in status
- signal-deferred dispatch suppresses duplicate emit_event
"""

import ast
import inspect
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from worca.orchestrator.runner import PipelineInterrupted


# ---------------------------------------------------------------------------
# Test: except PipelineInterrupted handler sets interrupted, not failed
# ---------------------------------------------------------------------------


class TestPipelineInterruptedLandsOnInterrupted:
    """AST-level verification that the except PipelineInterrupted handler
    sets pipeline_status to 'interrupted' (not 'failed') and uses
    exc.stop_reason (not hardcoded 'stopped')."""

    @staticmethod
    def _find_except_handler():
        """Find the except PipelineInterrupted handler in runner.py and return
        the AST node list for the handler body."""
        runner_path = Path(inspect.getfile(PipelineInterrupted)).resolve()
        source = runner_path.read_text()
        tree = ast.parse(source, filename=str(runner_path))

        for node in ast.walk(tree):
            if not isinstance(node, ast.ExceptHandler):
                continue
            if node.type is None:
                continue
            name = getattr(node.type, "id", None)
            if name == "PipelineInterrupted":
                return node, source
        pytest.fail("Could not find except PipelineInterrupted handler in runner.py")

    def test_sets_pipeline_status_interrupted(self):
        """status['pipeline_status'] must be assigned 'interrupted' (or PipelineStatus.INTERRUPTED), not 'failed'."""
        handler, source = self._find_except_handler()
        found_assignment = False
        for stmt in ast.walk(handler):
            if not isinstance(stmt, ast.Assign):
                continue
            for target in stmt.targets:
                if (isinstance(target, ast.Subscript)
                        and isinstance(target.value, ast.Name)
                        and target.value.id == "status"):
                    slice_val = target.slice
                    if isinstance(slice_val, ast.Constant) and slice_val.value == "pipeline_status":
                        if isinstance(stmt.value, ast.Constant):
                            assert stmt.value.value == "interrupted", (
                                f"Expected 'interrupted' but got '{stmt.value.value}' "
                                f"at line {stmt.lineno}"
                            )
                        elif isinstance(stmt.value, ast.Attribute):
                            assert stmt.value.attr == "INTERRUPTED", (
                                f"Expected PipelineStatus.INTERRUPTED but got .{stmt.value.attr} "
                                f"at line {stmt.lineno}"
                            )
                        else:
                            pytest.fail(
                                f"Expected constant or PipelineStatus.INTERRUPTED at line {stmt.lineno}"
                            )
                        found_assignment = True

        assert found_assignment, "No status['pipeline_status'] assignment found in except handler"

    def test_uses_exc_stop_reason(self):
        """status['stop_reason'] must use exc.stop_reason, not a hardcoded string."""
        handler, source = self._find_except_handler()

        for stmt in ast.walk(handler):
            if not isinstance(stmt, ast.Assign):
                continue
            for target in stmt.targets:
                if (isinstance(target, ast.Subscript)
                        and isinstance(target.value, ast.Name)
                        and target.value.id == "status"):
                    slice_val = target.slice
                    if isinstance(slice_val, ast.Constant) and slice_val.value == "stop_reason":
                        assert not isinstance(stmt.value, ast.Constant), (
                            f"stop_reason must not be a hardcoded constant "
                            f"at line {stmt.lineno}"
                        )
                        return

        pytest.fail("No status['stop_reason'] assignment found in except handler")

    def test_emit_passes_source_from_stop_reason(self):
        """emit_event call must pass source= derived from exc.stop_reason."""
        handler, source = self._find_except_handler()

        for node in ast.walk(handler):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            func_name = getattr(func, "id", None) or getattr(func, "attr", None)
            if func_name == "run_interrupted_payload":
                kw_names = {kw.arg for kw in node.keywords}
                assert "source" in kw_names, (
                    f"run_interrupted_payload at line {node.lineno} must include source="
                )
                return


# ---------------------------------------------------------------------------
# Test: control-file stop branch sets interrupted/control_file
# ---------------------------------------------------------------------------


class TestControlFileStopLandsOnInterrupted:
    """_check_control_file stop branch must set interrupted + control_file."""

    def test_control_file_stop_sets_interrupted(self, tmp_path):
        """When control file says stop, status must be interrupted, not failed."""
        from worca.orchestrator.runner import _check_control_file

        status = {"pipeline_status": "running", "stage": "IMPLEMENT"}

        with patch("worca.orchestrator.runner.read_control", return_value={"action": "stop"}),                 patch("worca.orchestrator.runner.delete_control"),                 patch("worca.orchestrator.runner.terminate_current"),                 patch("worca.orchestrator.runner.save_status") as mock_save,                 patch("worca.orchestrator.runner._log"):
            with pytest.raises(PipelineInterrupted) as exc_info:
                _check_control_file(
                    run_id="test-run",
                    worca_dir=str(tmp_path),
                    status=status,
                    status_path=str(tmp_path / "status.json"),
                    ctx=None,
                )

            assert exc_info.value.stop_reason == "control_file"
            saved = mock_save.call_args[0][0]
            assert saved["pipeline_status"] == "interrupted"
            assert saved["stop_reason"] == "control_file"


# ---------------------------------------------------------------------------
# Test: signal does not duplicate emit (Unix only)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="Unix signals only")
class TestSignalDoesNotDuplicateEmit:
    """When _pending_signal_event is set, the except handler must NOT call emit_event
    (the finally block dispatches it instead, avoiding duplicate emission)."""

    def test_except_handler_guards_on_pending_signal(self):
        """AST check: emit_event call inside except PipelineInterrupted is guarded
        by a condition that checks _pending_signal_event."""
        runner_path = Path(inspect.getfile(PipelineInterrupted)).resolve()
        source = runner_path.read_text()
        tree = ast.parse(source, filename=str(runner_path))

        for node in ast.walk(tree):
            if not isinstance(node, ast.ExceptHandler):
                continue
            if node.type is None:
                continue
            name = getattr(node.type, "id", None)
            if name != "PipelineInterrupted":
                continue

            handler_source = ast.get_source_segment(source, node)
            assert "_pending_signal_event" in handler_source, (
                "except PipelineInterrupted handler must reference _pending_signal_event "
                "to suppress duplicate dispatch when signal already stashed an event"
            )
            return

        pytest.fail("Could not find except PipelineInterrupted handler")
