"""Tests for prompt.py - Milestone approval gates for UserPromptSubmit."""
import json
import os
from unittest.mock import patch
from worca.hooks.prompt import check_milestone


# --- Plan approval gate ---

class TestPlanApproval:
    def test_injects_prompt_when_plan_stage_not_approved(self):
        status = {
            "stage": "plan",
            "milestones": {"plan_approved": None},
        }
        code, message = check_milestone(status)
        assert code == 0
        assert "MILESTONE GATE" in message
        assert "plan" in message.lower()

    def test_no_gate_when_plan_approved(self):
        status = {
            "stage": "plan",
            "milestones": {"plan_approved": True},
        }
        code, message = check_milestone(status)
        assert code == 0
        assert message == ""

    def test_plan_gate_mentions_master_plan(self):
        status = {
            "stage": "plan",
            "milestones": {"plan_approved": None},
        }
        code, message = check_milestone(status)
        assert "MASTER_PLAN" in message


# --- PR approval gate ---

class TestPrApproval:
    def test_injects_prompt_when_review_stage_not_approved(self):
        status = {
            "stage": "review",
            "milestones": {"pr_approved": None},
        }
        code, message = check_milestone(status)
        assert code == 0
        assert "MILESTONE GATE" in message
        assert "pr" in message.lower() or "PR" in message

    def test_no_gate_when_pr_approved(self):
        status = {
            "stage": "review",
            "milestones": {"pr_approved": True},
        }
        code, message = check_milestone(status)
        assert code == 0
        assert message == ""

    def test_pr_gate_mentions_review(self):
        status = {
            "stage": "review",
            "milestones": {"pr_approved": None},
        }
        code, message = check_milestone(status)
        assert "review" in message.lower() or "Review" in message


# --- No gate active ---

class TestNoGate:
    def test_no_gate_when_status_is_none(self):
        code, message = check_milestone(None)
        assert code == 0
        assert message == ""

    def test_no_gate_when_stage_is_implement(self):
        status = {
            "stage": "implement",
            "milestones": {},
        }
        code, message = check_milestone(status)
        assert code == 0
        assert message == ""

    def test_no_gate_when_stage_is_empty(self):
        status = {
            "stage": "",
            "milestones": {},
        }
        code, message = check_milestone(status)
        assert code == 0
        assert message == ""

    def test_no_gate_when_milestones_missing(self):
        status = {"stage": "plan"}
        code, message = check_milestone(status)
        # plan_approved key doesn't exist => .get returns None => gate triggers
        assert code == 0
        assert "MILESTONE GATE" in message

    def test_no_gate_when_stage_is_test(self):
        status = {
            "stage": "test",
            "milestones": {},
        }
        code, message = check_milestone(status)
        assert code == 0
        assert message == ""


# --- Main function integration with status file ---

class TestMainStatusFile:
    def test_reads_from_status_file(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)  # isolate from real .worca/runs/
        status_file = tmp_path / "status.json"
        status_file.write_text(json.dumps({
            "stage": "plan",
            "milestones": {"plan_approved": None},
        }))
        monkeypatch.setenv("WORCA_STATUS_FILE", str(status_file))

        from worca.hooks.prompt import load_status
        status = load_status()
        assert status is not None
        assert status["stage"] == "plan"

    def test_returns_none_when_file_missing(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)  # isolate from real .worca/runs/
        monkeypatch.setenv("WORCA_STATUS_FILE", str(tmp_path / "nonexistent.json"))

        from worca.hooks.prompt import load_status
        status = load_status()
        assert status is None

    def test_returns_none_when_no_env_and_no_default(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("WORCA_STATUS_FILE", raising=False)

        from worca.hooks.prompt import load_status
        status = load_status()
        assert status is None


class TestPidMatchStatusLoad:
    def setup_method(self):
        import worca.hooks.prompt as prompt_mod
        prompt_mod._pid_cache.clear()

    def test_pid_match_status_load(self, tmp_path, monkeypatch):
        """load_status finds status.json by matching PID against pipeline.pid files."""
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("WORCA_STATUS_FILE", raising=False)

        run_dir = tmp_path / ".worca" / "runs" / "20260426-120000-000-abcd"
        run_dir.mkdir(parents=True)
        (run_dir / "pipeline.pid").write_text(str(os.getpid()))
        (run_dir / "status.json").write_text(json.dumps({"stage": "plan", "milestones": {}}))

        import worca.hooks.prompt as prompt_mod
        status = prompt_mod.load_status()
        assert status is not None
        assert status["stage"] == "plan"

    def test_pid_match_caching(self, tmp_path, monkeypatch):
        """Second call to _find_status_by_pid uses cached path without re-scanning."""
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("WORCA_STATUS_FILE", raising=False)

        run_dir = tmp_path / ".worca" / "runs" / "20260426-120000-000-abcd"
        run_dir.mkdir(parents=True)
        (run_dir / "pipeline.pid").write_text(str(os.getpid()))
        (run_dir / "status.json").write_text(json.dumps({"stage": "test", "milestones": {}}))

        import worca.hooks.prompt as prompt_mod

        listdir_calls = []
        real_listdir = os.listdir

        def tracking_listdir(path):
            listdir_calls.append(path)
            return real_listdir(path)

        with patch("os.listdir", side_effect=tracking_listdir):
            prompt_mod._find_status_by_pid()
            count_after_first = len(listdir_calls)
            assert count_after_first > 0

            prompt_mod._find_status_by_pid()
            assert len(listdir_calls) == count_after_first  # no new scans
