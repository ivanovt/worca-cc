"""Tests for sequenced plan file paths (plan-NNN.md).

Covers:
- _next_plan_path helper in runner.py
- guard.py allowing plan-NNN.md for planner agent
- Backward compatibility with MASTER_PLAN.md
"""
import os
from types import SimpleNamespace

from worca.orchestrator.runner import _materialize_plan_markdown, _next_plan_path
from worca.hooks.guard import check_guard


# --- _next_plan_path ---

class TestNextPlanPath:
    def test_returns_plan_001_for_empty_dir(self, tmp_path):
        result = _next_plan_path(str(tmp_path))
        assert result == os.path.join(str(tmp_path), "plan-001.md")

    def test_returns_plan_002_when_001_exists(self, tmp_path):
        (tmp_path / "plan-001.md").write_text("# Plan 1")
        result = _next_plan_path(str(tmp_path))
        assert result == os.path.join(str(tmp_path), "plan-002.md")

    def test_returns_plan_003_when_001_and_002_exist(self, tmp_path):
        (tmp_path / "plan-001.md").write_text("# Plan 1")
        (tmp_path / "plan-002.md").write_text("# Plan 2")
        result = _next_plan_path(str(tmp_path))
        assert result == os.path.join(str(tmp_path), "plan-003.md")

    def test_handles_gap_in_sequence(self, tmp_path):
        """If plan-001.md and plan-003.md exist, next should be plan-004.md."""
        (tmp_path / "plan-001.md").write_text("# Plan 1")
        (tmp_path / "plan-003.md").write_text("# Plan 3")
        result = _next_plan_path(str(tmp_path))
        assert result == os.path.join(str(tmp_path), "plan-004.md")

    def test_ignores_non_plan_files(self, tmp_path):
        """Other .md files in the dir should not affect numbering."""
        (tmp_path / "status.json").write_text("{}")
        (tmp_path / "README.md").write_text("# Readme")
        result = _next_plan_path(str(tmp_path))
        assert result == os.path.join(str(tmp_path), "plan-001.md")

    def test_ignores_malformed_plan_filenames(self, tmp_path):
        """Files like plan-abc.md or plan-1.md should not match."""
        (tmp_path / "plan-abc.md").write_text("bad")
        (tmp_path / "plan-1.md").write_text("bad")
        result = _next_plan_path(str(tmp_path))
        assert result == os.path.join(str(tmp_path), "plan-001.md")


# --- _materialize_plan_markdown (planner-skipped-write fallback) ---

class TestMaterializePlanMarkdown:
    def _wr(self, title="Add user auth"):
        return SimpleNamespace(title=title)

    def test_includes_title_and_sections(self):
        result = {
            "approach": "Bolt JWT onto the existing session layer.",
            "tasks_outline": [
                {
                    "title": "Add token issuance",
                    "description": "Issue JWTs on login.",
                    "estimated_complexity": "medium",
                },
                {"title": "Add middleware", "description": "Verify tokens per request."},
            ],
            "test_strategy": "Unit tests for issuance + integration for the gate.",
        }
        md = _materialize_plan_markdown(result, self._wr())
        assert md.startswith("# Add user auth")
        assert "## Approach" in md
        assert "Bolt JWT onto the existing session layer." in md
        assert "## Tasks" in md
        assert "**Add token issuance**" in md
        assert "complexity: medium" in md
        assert "Issue JWTs on login." in md
        assert "**Add middleware**" in md
        assert "## Test Strategy" in md
        assert "Unit tests for issuance" in md
        # The provenance note marks it as a materialized fallback.
        assert "Materialized from the planner's structured output" in md
        assert md.endswith("\n")

    def test_handles_missing_optional_fields(self):
        md = _materialize_plan_markdown({"approach": "Just do it."}, self._wr("Tiny"))
        assert md.startswith("# Tiny")
        assert "## Approach" in md
        # No tasks / test strategy sections when absent.
        assert "## Tasks" not in md
        assert "## Test Strategy" not in md

    def test_falls_back_to_generic_title(self):
        md = _materialize_plan_markdown({"approach": "x"}, SimpleNamespace())
        assert md.startswith("# Plan")

    def test_empty_result_still_renders_header(self):
        md = _materialize_plan_markdown({}, self._wr("Empty"))
        assert "# Empty" in md
        assert "Materialized from the planner's structured output" in md

    def test_skips_non_dict_tasks(self):
        md = _materialize_plan_markdown(
            {"tasks_outline": ["not-a-dict", {"title": "Real", "description": "d"}]},
            self._wr(),
        )
        assert "**Real**" in md
        assert "not-a-dict" not in md


# --- Guard allows plan-NNN.md for planner ---

class TestGuardPlannerPlanFiles:
    def test_allows_planner_write_plan_001(self, monkeypatch):
        monkeypatch.setenv("WORCA_AGENT", "planner")
        monkeypatch.delenv("WORCA_PLAN_FILE", raising=False)
        code, reason = check_guard("Write", {"file_path": "/run/plan-001.md"})
        assert code == 0

    def test_allows_planner_write_plan_042(self, monkeypatch):
        monkeypatch.setenv("WORCA_AGENT", "planner")
        monkeypatch.delenv("WORCA_PLAN_FILE", raising=False)
        code, reason = check_guard("Write", {"file_path": "/run/plan-042.md"})
        assert code == 0

    def test_allows_planner_write_master_plan_backward_compat(self, monkeypatch):
        """MASTER_PLAN.md should still be allowed for backward compatibility."""
        monkeypatch.setenv("WORCA_AGENT", "planner")
        monkeypatch.delenv("WORCA_PLAN_FILE", raising=False)
        code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
        assert code == 0

    def test_blocks_planner_write_other_file(self, monkeypatch):
        monkeypatch.setenv("WORCA_AGENT", "planner")
        monkeypatch.delenv("WORCA_PLAN_FILE", raising=False)
        code, reason = check_guard("Write", {"file_path": "/project/app.py"})
        assert code == 2
        assert "planner" in reason.lower()

    def test_blocks_planner_write_plan_without_three_digits(self, monkeypatch):
        """plan-1.md does not match the plan-NNN.md pattern."""
        monkeypatch.setenv("WORCA_AGENT", "planner")
        monkeypatch.delenv("WORCA_PLAN_FILE", raising=False)
        code, reason = check_guard("Write", {"file_path": "/run/plan-1.md"})
        assert code == 2

    def test_blocks_planner_write_plan_with_extra_chars(self, monkeypatch):
        """plan-001-extra.md does not match the plan-NNN.md pattern."""
        monkeypatch.setenv("WORCA_AGENT", "planner")
        monkeypatch.delenv("WORCA_PLAN_FILE", raising=False)
        code, reason = check_guard("Write", {"file_path": "/run/plan-001-extra.md"})
        assert code == 2

    def test_plan_file_env_takes_precedence(self, monkeypatch):
        """When WORCA_PLAN_FILE is set, only that exact file is allowed."""
        monkeypatch.setenv("WORCA_AGENT", "planner")
        monkeypatch.setenv("WORCA_PLAN_FILE", "/run/plan-005.md")
        code, reason = check_guard("Write", {"file_path": "/run/plan-005.md"})
        assert code == 0
        # Different plan file should be blocked
        code, reason = check_guard("Write", {"file_path": "/run/plan-001.md"})
        assert code == 2


# --- PromptBuilder uses plan_file from context ---

class TestPromptBuilderPlanFile:
    def test_plan_context_uses_plan_file_from_context(self):
        """build_context('plan') passes plan_file through to the context dict."""
        from worca.orchestrator.prompt_builder import PromptBuilder
        pb = PromptBuilder("Test title", "Test desc")
        pb.update_context("plan_file", "/run/plan-001.md")
        ctx = pb.build_context("plan")
        assert ctx.get("plan_file") == "/run/plan-001.md"

    def test_plan_context_has_work_request(self):
        """build_context('plan') includes work_request key."""
        from worca.orchestrator.prompt_builder import PromptBuilder
        pb = PromptBuilder("Test title", "Test desc")
        ctx = pb.build_context("plan")
        assert "Test title" in ctx.get("work_request", "")
