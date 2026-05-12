"""Tests that fleet documentation files exist and cover required topics (W-040 Phase 5 task 3)."""
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
CLAUDE_MD = ROOT / "CLAUDE.md"
FLEET_DOCS = ROOT / "docs" / "fleet-runs.md"


class TestClaudeMdFleetSection:
    """CLAUDE.md must have a Fleet Runs section with CLI flags."""

    def _content(self):
        return CLAUDE_MD.read_text()

    def test_fleet_runs_section_exists(self):
        assert "## Fleet Runs" in self._content()

    def test_fleet_runs_run_fleet_reference(self):
        assert "run_fleet.py" in self._content()

    def test_fleet_runs_projects_flag(self):
        assert "--projects" in self._content()

    def test_fleet_runs_guide_flag(self):
        content = self._content()
        # guide flag should appear in fleet section
        idx = content.find("## Fleet Runs")
        assert idx != -1
        fleet_section = content[idx:]
        assert "--guide" in fleet_section

    def test_fleet_runs_base_flag(self):
        content = self._content()
        idx = content.find("## Fleet Runs")
        assert idx != -1
        fleet_section = content[idx:]
        assert "--base" in fleet_section

    def test_fleet_runs_resume_flag(self):
        content = self._content()
        idx = content.find("## Fleet Runs")
        assert idx != -1
        fleet_section = content[idx:]
        assert "--resume" in fleet_section

    def test_fleet_runs_cleanup_reference(self):
        content = self._content()
        idx = content.find("## Fleet Runs")
        assert idx != -1
        fleet_section = content[idx:]
        assert "cleanup" in fleet_section.lower()


class TestFleetRunsDoc:
    """docs/fleet-runs.md must exist and cover the required walkthrough topics."""

    def _content(self):
        return FLEET_DOCS.read_text()

    def test_file_exists(self):
        assert FLEET_DOCS.exists(), "docs/fleet-runs.md must exist"

    def test_covers_fleet_launch(self):
        content = self._content()
        assert "run_fleet.py" in content

    def test_covers_guide_attachment(self):
        content = self._content()
        assert "--guide" in content

    def test_covers_branch_templating(self):
        content = self._content()
        assert "--head-template" in content or "head-template" in content

    def test_covers_plan_modes(self):
        content = self._content()
        assert "--plan" in content

    def test_covers_circuit_breaker(self):
        content = self._content()
        assert "circuit" in content.lower() or "circuit_breaker" in content

    def test_covers_resume(self):
        content = self._content()
        assert "--resume" in content

    def test_covers_cleanup(self):
        content = self._content()
        assert "cleanup" in content.lower()

    def test_covers_base_branch(self):
        content = self._content()
        assert "--base" in content

    def test_covers_max_parallel(self):
        content = self._content()
        assert "--max-parallel" in content or "max-parallel" in content

    def test_has_quick_start_example(self):
        content = self._content()
        # Should have a concrete usage example
        assert "```" in content
