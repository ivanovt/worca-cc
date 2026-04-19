"""Tests for PipelineInterrupted stop_reason kwarg and AST lint."""

import ast
import inspect
from pathlib import Path

import pytest

from worca.orchestrator.runner import PipelineInterrupted


class TestPipelineInterruptedStopReason:
    """PipelineInterrupted requires stop_reason as a keyword argument."""

    def test_stop_reason_is_required(self):
        with pytest.raises(TypeError, match="stop_reason"):
            PipelineInterrupted("some message")

    def test_stop_reason_stored_on_instance(self):
        exc = PipelineInterrupted("stopped", stop_reason="control_file")
        assert exc.stop_reason == "control_file"

    def test_message_preserved(self):
        exc = PipelineInterrupted("Pipeline stopped via control file", stop_reason="control_file")
        assert str(exc) == "Pipeline stopped via control file"

    def test_stop_reason_signal(self):
        exc = PipelineInterrupted("Interrupted by signal", stop_reason="signal")
        assert exc.stop_reason == "signal"

    def test_stop_reason_control_webhook(self):
        exc = PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
        assert exc.stop_reason == "control_webhook"

    def test_stop_reason_not_positional(self):
        with pytest.raises(TypeError):
            PipelineInterrupted("msg", "control_file")


class TestAllPipelineInterruptedSitesHaveStopReason:
    """AST-based lint: every raise PipelineInterrupted(...) must pass stop_reason kwarg."""

    def test_all_pipeline_interrupted_sites_have_stop_reason(self):
        runner_path = Path(inspect.getfile(PipelineInterrupted)).resolve()
        source = runner_path.read_text()
        tree = ast.parse(source, filename=str(runner_path))

        missing = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Raise) or node.exc is None:
                continue
            call = node.exc
            if not isinstance(call, ast.Call):
                continue
            func = call.func
            if isinstance(func, ast.Name) and func.id == "PipelineInterrupted":
                kwarg_names = [kw.arg for kw in call.keywords]
                if "stop_reason" not in kwarg_names:
                    missing.append(node.lineno)

        assert missing == [], (
            f"raise PipelineInterrupted(...) without stop_reason kwarg at lines: {missing}"
        )
