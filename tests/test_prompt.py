"""Tests for prompt.py - Milestone approval gates for UserPromptSubmit."""
import json
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


# --- Status discovery: WORCA_RUN_DIR (production) and WORCA_STATUS_FILE (override) ---

class TestRunDirLookup:
    """WORCA_RUN_DIR is the runner→hook contract since W-048 (per-run dirs)."""

    def test_reads_status_from_run_dir(self, tmp_path, monkeypatch):
        run_dir = tmp_path / ".worca" / "runs" / "20260430-120000-000-abcd"
        run_dir.mkdir(parents=True)
        (run_dir / "status.json").write_text(json.dumps({
            "stage": "plan",
            "milestones": {"plan_approved": None},
        }))
        monkeypatch.setenv("WORCA_RUN_DIR", str(run_dir))
        monkeypatch.delenv("WORCA_STATUS_FILE", raising=False)

        from worca.hooks.prompt import load_status
        status = load_status()
        assert status is not None
        assert status["stage"] == "plan"

    def test_run_dir_takes_precedence_over_override(self, tmp_path, monkeypatch):
        """If both env vars are set, WORCA_RUN_DIR wins (it's the per-run truth)."""
        run_dir = tmp_path / "runs" / "current"
        run_dir.mkdir(parents=True)
        (run_dir / "status.json").write_text(json.dumps({"stage": "plan", "milestones": {}}))

        other = tmp_path / "other.json"
        other.write_text(json.dumps({"stage": "review", "milestones": {}}))

        monkeypatch.setenv("WORCA_RUN_DIR", str(run_dir))
        monkeypatch.setenv("WORCA_STATUS_FILE", str(other))

        from worca.hooks.prompt import load_status
        status = load_status()
        assert status["stage"] == "plan"

    def test_falls_through_to_override_when_run_dir_missing(self, tmp_path, monkeypatch):
        """If WORCA_RUN_DIR points somewhere with no status.json, fall to override."""
        empty_run_dir = tmp_path / "empty"
        empty_run_dir.mkdir()
        override = tmp_path / "override.json"
        override.write_text(json.dumps({"stage": "review", "milestones": {}}))

        monkeypatch.setenv("WORCA_RUN_DIR", str(empty_run_dir))
        monkeypatch.setenv("WORCA_STATUS_FILE", str(override))

        from worca.hooks.prompt import load_status
        status = load_status()
        assert status["stage"] == "review"

    def test_returns_none_when_run_dir_status_malformed(self, tmp_path, monkeypatch):
        """Malformed JSON in run dir falls through; with no override, returns None."""
        run_dir = tmp_path / "runs" / "bad"
        run_dir.mkdir(parents=True)
        (run_dir / "status.json").write_text("not json")
        monkeypatch.setenv("WORCA_RUN_DIR", str(run_dir))
        monkeypatch.delenv("WORCA_STATUS_FILE", raising=False)

        from worca.hooks.prompt import load_status
        assert load_status() is None


class TestStatusFileOverride:
    """WORCA_STATUS_FILE is an explicit override for tests / non-runner deployments."""

    def test_reads_from_override_when_run_dir_unset(self, tmp_path, monkeypatch):
        status_file = tmp_path / "status.json"
        status_file.write_text(json.dumps({
            "stage": "plan",
            "milestones": {"plan_approved": None},
        }))
        monkeypatch.delenv("WORCA_RUN_DIR", raising=False)
        monkeypatch.setenv("WORCA_STATUS_FILE", str(status_file))

        from worca.hooks.prompt import load_status
        status = load_status()
        assert status is not None
        assert status["stage"] == "plan"

    def test_returns_none_when_override_file_missing(self, tmp_path, monkeypatch):
        monkeypatch.delenv("WORCA_RUN_DIR", raising=False)
        monkeypatch.setenv("WORCA_STATUS_FILE", str(tmp_path / "nonexistent.json"))

        from worca.hooks.prompt import load_status
        assert load_status() is None

    def test_returns_none_when_neither_env_set(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("WORCA_RUN_DIR", raising=False)
        monkeypatch.delenv("WORCA_STATUS_FILE", raising=False)

        from worca.hooks.prompt import load_status
        assert load_status() is None
