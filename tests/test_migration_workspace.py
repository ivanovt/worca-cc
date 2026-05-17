"""Tests that MIGRATION.md contains a workspace-runs release note (W-047 Phase 8 task 4)."""
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
MIGRATION_MD = ROOT / "MIGRATION.md"


class TestMigrationWorkspaceNote:
    """MIGRATION.md must have a workspace-runs release-note section covering key features."""

    def _content(self):
        return MIGRATION_MD.read_text()

    def test_workspace_section_exists(self):
        """A version-specific section mentioning workspace runs must exist."""
        content = self._content()
        assert "workspace" in content.lower(), "MIGRATION.md must mention workspace runs"

    def test_run_workspace_reference(self):
        content = self._content()
        assert "run_workspace.py" in content

    def test_workspace_init_command(self):
        content = self._content()
        assert "worca workspace init" in content

    def test_workspace_json_reference(self):
        content = self._content()
        assert "workspace.json" in content

    def test_master_planner(self):
        content = self._content()
        assert "master planner" in content.lower() or "Master planner" in content

    def test_dag_execution(self):
        content = self._content()
        assert "DAG" in content

    def test_integration_test(self):
        content = self._content()
        ws_idx = content.lower().find("workspace")
        assert ws_idx != -1
        post_ws = content[ws_idx:]
        assert "integration test" in post_ws.lower() or "integration_test" in post_ws

    def test_pr_linking(self):
        content = self._content()
        ws_idx = content.lower().find("workspace")
        post_ws = content[ws_idx:]
        assert "PR" in post_ws or "pr" in post_ws.lower()

    def test_skip_integration_flag(self):
        content = self._content()
        assert "--skip-integration" in content

    def test_skip_planning_flag(self):
        content = self._content()
        assert "--skip-planning" in content

    def test_resume_flag(self):
        content = self._content()
        ws_idx = content.lower().find("workspace")
        post_ws = content[ws_idx:]
        assert "--resume" in post_ws

    def test_dry_run_flag(self):
        content = self._content()
        assert "--dry-run" in content

    def test_workspace_status_values(self):
        content = self._content()
        assert "planning" in content
        assert "integration_testing" in content
        assert "integration_failed" in content

    def test_workspace_settings(self):
        content = self._content()
        assert "worca.workspace" in content or "workspace" in content.lower()

    def test_cleanup_workspace_id_flag(self):
        content = self._content()
        assert "--workspace-id" in content

    def test_workspace_id_in_pipelines(self):
        content = self._content()
        assert "workspace_id" in content

    def test_context_injection(self):
        content = self._content()
        ws_idx = content.lower().find("workspace")
        post_ws = content[ws_idx:]
        assert "context" in post_ws.lower()

    def test_umbrella_issue(self):
        content = self._content()
        assert "umbrella" in content.lower()

    def test_workspace_events(self):
        content = self._content()
        assert "workspace-update" in content or "workspace.launched" in content or "workspace event" in content.lower()

    def test_ui_surfaces(self):
        content = self._content()
        ws_idx = content.lower().find("workspace")
        post_ws = content[ws_idx:]
        assert "dashboard" in post_ws.lower() or "workspace detail" in post_ws.lower()

    def test_docs_reference(self):
        content = self._content()
        assert "docs/workspace-runs.md" in content
