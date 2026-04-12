"""Tests for PromptBuilder learn stage context assembly."""


from worca.orchestrator.prompt_builder import PromptBuilder


def _make_status(iterations=2, test_fix_loops=1, review_fix_loops=0):
    """Build a minimal full_status dict for learn context tests."""
    return {
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "completed"},
            "implement": {
                "status": "completed",
                "iterations": [
                    {"agent": "implementer", "trigger": "initial", "status": "completed",
                     "output": {"files_changed": ["auth.py"]}},
                    {"agent": "implementer", "trigger": "test_fix", "status": "completed",
                     "output": {"files_changed": ["auth.py"]}},
                ],
            },
            "test": {
                "status": "completed",
                "iterations": [
                    {"agent": "tester", "status": "completed",
                     "output": {"passed": False, "failures": [{"test_name": "test_login"}]}},
                    {"agent": "tester", "status": "completed",
                     "output": {"passed": True}},
                ],
            },
            "review": {"status": "completed", "iterations": []},
        },
        "plan_file": "MASTER_PLAN.md",
    }


def test_build_context_learn_includes_work_request():
    pb = PromptBuilder("Add auth", "Implement user authentication")
    pb.update_context("full_status", _make_status())
    pb.update_context("termination_type", "success")
    ctx = pb.build_context("learn")
    assert "Add auth" in ctx.get("work_request", "")
    assert "Implement user authentication" in ctx.get("work_request", "")


def test_build_context_learn_includes_termination_type():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", _make_status())
    pb.update_context("termination_type", "failure")
    ctx = pb.build_context("learn")
    assert ctx.get("termination_type") == "failure"


def test_build_context_learn_includes_plan_content():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", _make_status())
    pb.update_context("termination_type", "success")
    pb.update_context("plan_file_content", "# Plan\n\n## Step 1\nDo the thing")
    ctx = pb.build_context("learn")
    assert "# Plan" in ctx.get("plan_content", "")
    assert "Step 1" in ctx.get("plan_content", "")


def test_build_context_learn_includes_status_as_json():
    status = _make_status()
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", status)
    pb.update_context("termination_type", "success")
    ctx = pb.build_context("learn")
    assert '"stages"' in ctx.get("run_data", "")
    assert '"implement"' in ctx.get("run_data", "")


def test_build_context_learn_without_plan_content():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", _make_status())
    pb.update_context("termination_type", "success")
    ctx = pb.build_context("learn")
    assert not ctx.get("plan_content")


def test_build_context_learn_with_termination_reason():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", _make_status())
    pb.update_context("termination_type", "success")
    pb.update_context("termination_reason", "")
    ctx = pb.build_context("learn")
    assert ctx.get("termination_type") == "success"


def test_build_context_learn_truncates_large_status():
    """If full_status JSON is very large, run_data should be truncated."""
    status = _make_status()
    large_output = "x" * 100_000
    status["stages"]["implement"]["iterations"][0]["output"]["large"] = large_output
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", status)
    pb.update_context("termination_type", "success")
    ctx = pb.build_context("learn")
    assert len(ctx.get("run_data", "")) < len(large_output)


def test_build_context_learn_empty_status():
    """Handle minimal/empty status gracefully."""
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", {"stages": {}})
    pb.update_context("termination_type", "failure")
    pb.update_context("termination_reason", "Unknown error")
    ctx = pb.build_context("learn")
    assert ctx.get("termination_type") == "failure"


def test_build_context_learn_run_id_from_status():
    """The learn context should surface run_id from full_status."""
    status = _make_status()
    status["run_id"] = "20260318-222430"
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", status)
    pb.update_context("termination_type", "success")
    ctx = pb.build_context("learn")
    assert ctx.get("run_id") == "20260318-222430"
    assert "20260318-222430" in ctx.get("run_data", "")


def test_build_context_learn_run_id_fallback_when_missing():
    """When run_id is missing from status, run_id should be 'unknown'."""
    status = _make_status()
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", status)
    pb.update_context("termination_type", "success")
    ctx = pb.build_context("learn")
    assert ctx.get("run_id") == "unknown"
