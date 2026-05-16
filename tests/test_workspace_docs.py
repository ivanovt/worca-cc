"""Tests for workspace documentation (W-047 Phase 8, tasks 4-5).

Verifies that CLAUDE.md contains a Workspace Runs section and that
docs/workspace-runs.md exists with the required sections.
"""

import os

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(relpath: str) -> str:
    with open(os.path.join(_REPO_ROOT, relpath)) as f:
        return f.read()


class TestClaudeMdWorkspaceSection:
    """CLAUDE.md must contain a Workspace Runs section."""

    @pytest.fixture(autouse=True)
    def _load(self):
        self.text = _read("CLAUDE.md")

    def test_workspace_runs_heading_exists(self):
        assert "## Workspace Runs" in self.text

    def test_documents_run_workspace_script(self):
        assert "run_workspace.py" in self.text

    def test_documents_workspace_init_cli(self):
        assert "worca workspace init" in self.text

    def test_documents_workspace_json_format(self):
        assert "workspace.json" in self.text

    def test_documents_key_flags(self):
        for flag in ["--prompt", "--guide", "--branch", "--skip-integration",
                      "--skip-planning", "--resume", "--max-parallel", "--dry-run"]:
            assert flag in self.text, f"Missing flag {flag} in CLAUDE.md"

    def test_documents_dag_execution(self):
        assert "DAG" in self.text or "dag" in self.text or "tier" in self.text

    def test_documents_integration_test(self):
        assert "integration" in self.text.lower()

    def test_documents_workspace_cleanup(self):
        assert "workspace-id" in self.text or "workspace_id" in self.text

    def test_links_to_walkthrough(self):
        assert "docs/workspace-runs.md" in self.text


class TestWorkspaceRunsMd:
    """docs/workspace-runs.md must exist with required sections."""

    @pytest.fixture(autouse=True)
    def _load(self):
        self.text = _read("docs/workspace-runs.md")

    def test_file_exists(self):
        assert os.path.isfile(os.path.join(_REPO_ROOT, "docs", "workspace-runs.md"))

    def test_title_heading(self):
        assert "# Workspace Runs" in self.text

    def test_quick_start_section(self):
        assert "## Quick start" in self.text

    def test_workspace_json_section(self):
        assert "workspace.json" in self.text

    def test_workspace_json_schema_documented(self):
        for field in ["name", "projects", "path", "depends_on",
                       "integration_test", "umbrella_repo"]:
            assert field in self.text, f"Missing workspace.json field '{field}'"

    def test_master_planner_section(self):
        assert "planner" in self.text.lower()

    def test_dag_execution_section(self):
        assert "DAG" in self.text or "tier" in self.text.lower()

    def test_context_injection_documented(self):
        assert "context" in self.text.lower()

    def test_integration_test_section(self):
        assert "integration test" in self.text.lower() or "integration_test" in self.text

    def test_pr_linking_section(self):
        assert "PR" in self.text or "pull request" in self.text.lower()

    def test_umbrella_issue_documented(self):
        assert "umbrella" in self.text.lower()

    def test_resume_section(self):
        assert "resume" in self.text.lower()

    def test_cleanup_section(self):
        assert "cleanup" in self.text.lower()

    def test_guide_attachment_section(self):
        assert "guide" in self.text.lower()

    def test_branch_template_documented(self):
        assert "{slug}" in self.text or "{repo}" in self.text

    def test_status_values_documented(self):
        for status in ["planning", "running", "integration_testing",
                        "integration_failed", "completed", "failed", "halted"]:
            assert status in self.text, f"Missing status '{status}'"

    def test_circuit_breaker_documented(self):
        assert "circuit breaker" in self.text.lower() or "circuit_breaker" in self.text

    def test_file_layout_documented(self):
        assert "workspace-manifest.json" in self.text or ".worca/workspace-runs" in self.text

    def test_dry_run_documented(self):
        assert "--dry-run" in self.text
