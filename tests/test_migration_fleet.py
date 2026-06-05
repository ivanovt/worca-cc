"""Tests that MIGRATION.md contains a fleet-runs release note (W-040 Phase 6 task 3)."""
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
MIGRATION_MD = ROOT / "MIGRATION.md"


class TestMigrationFleetNote:
    """MIGRATION.md must have a fleet-runs release-note section covering key flags and surfaces."""

    def _content(self):
        # encoding="utf-8" is required: MIGRATION.md carries non-ASCII (em-dashes,
        # arrows, emoji) and a bare read_text() decodes with the locale codec on
        # Windows (cp1252) → UnicodeDecodeError on bytes like 0x8f.
        return MIGRATION_MD.read_text(encoding="utf-8")

    def test_fleet_section_exists(self):
        """A version-specific section mentioning fleet runs must exist."""
        content = self._content()
        # Should have a version header with fleet mention or a Fleet Runs heading
        assert "fleet" in content.lower(), "MIGRATION.md must mention fleet runs"

    def test_run_fleet_reference(self):
        content = self._content()
        assert "run_fleet.py" in content

    def test_head_template_flag(self):
        content = self._content()
        assert "--head-template" in content

    def test_base_flag(self):
        content = self._content()
        assert "--base" in content

    def test_guide_flag(self):
        content = self._content()
        assert "--guide" in content

    def test_plan_flag(self):
        content = self._content()
        # --plan and/or --plan-first
        assert "--plan" in content

    def test_plan_first_flag(self):
        content = self._content()
        assert "--plan-first" in content

    def test_max_parallel_flag(self):
        content = self._content()
        assert "--max-parallel" in content

    def test_resume_flag(self):
        content = self._content()
        # --resume in fleet section context
        fleet_idx = content.lower().find("fleet")
        assert fleet_idx != -1
        post_fleet = content[fleet_idx:]
        assert "--resume" in post_fleet

    def test_fleet_id_in_pipelines(self):
        content = self._content()
        assert "fleet_id" in content

    def test_worca_fleet_settings(self):
        content = self._content()
        assert "worca.fleet" in content

    def test_worca_guide_settings(self):
        content = self._content()
        assert "worca.guide" in content

    def test_new_ui_surfaces(self):
        content = self._content()
        # UI surfaces: fleet detail, fleet launcher, dashboard grouping
        assert "dashboard" in content.lower() or "fleet detail" in content.lower() or "fleet-detail" in content.lower()

    def test_fleet_manifest_reference(self):
        content = self._content()
        assert "fleet-runs" in content or "fleet manifest" in content.lower()

    def test_cleanup_fleet_id_flag(self):
        content = self._content()
        assert "--fleet-id" in content
