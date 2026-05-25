"""Verify pipeline_env finalizer stops beads daemons for worktrees and main project."""

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
CONFTEST = REPO_ROOT / "tests" / "integration" / "conftest.py"


@pytest.fixture
def fake_project(tmp_path):
    """Create a minimal git repo with .beads/ dir to simulate a test project."""
    project = tmp_path / "project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=str(project), check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "t@t.com"],
        cwd=str(project), check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "T"],
        cwd=str(project), check=True, capture_output=True,
    )
    (project / ".beads").mkdir()
    return project


class TestFinalizerStopsDaemons:
    def test_stops_daemon_for_main_project(self, fake_project):
        """Finalizer calls bd_daemon_stop for the main project's .beads/ dir."""

        stopped = []

        def track_stop(beads_dir, **kwargs):
            stopped.append(str(beads_dir))
            return True

        with patch("worca.utils.beads.bd_daemon_stop", side_effect=track_stop):
            from tests.integration.conftest import _stop_beads_daemons
            _stop_beads_daemons(fake_project, [])

        main_beads = str(fake_project / ".beads")
        assert main_beads in stopped, (
            f"Expected daemon stop for main project .beads at {main_beads}"
        )

    def test_stops_daemon_for_worktrees(self, fake_project, tmp_path):
        """Finalizer calls bd_daemon_stop for each worktree with a .beads/ dir."""
        wt1 = tmp_path / "wt1"
        wt1.mkdir()
        (wt1 / ".beads").mkdir()

        wt2 = tmp_path / "wt2"
        wt2.mkdir()
        (wt2 / ".beads").mkdir()

        stopped = []

        def track_stop(beads_dir, **kwargs):
            stopped.append(str(beads_dir))
            return True

        with patch("worca.utils.beads.bd_daemon_stop", side_effect=track_stop):
            from tests.integration.conftest import _stop_beads_daemons
            _stop_beads_daemons(fake_project, [str(wt1), str(wt2)])

        assert str(wt1 / ".beads") in stopped
        assert str(wt2 / ".beads") in stopped

    def test_skips_worktree_without_beads_dir(self, fake_project, tmp_path):
        """Finalizer skips worktrees that don't have a .beads/ dir."""
        wt_no_beads = tmp_path / "wt_no_beads"
        wt_no_beads.mkdir()

        stopped = []

        def track_stop(beads_dir, **kwargs):
            stopped.append(str(beads_dir))
            return True

        with patch("worca.utils.beads.bd_daemon_stop", side_effect=track_stop):
            from tests.integration.conftest import _stop_beads_daemons
            _stop_beads_daemons(fake_project, [str(wt_no_beads)])

        wt_beads = str(wt_no_beads / ".beads")
        assert wt_beads not in stopped

    def test_exception_in_stop_does_not_propagate(self, fake_project):
        """Daemon stop errors are swallowed (best-effort)."""
        def exploding_stop(beads_dir, **kwargs):
            raise RuntimeError("daemon stop failed")

        with patch("worca.utils.beads.bd_daemon_stop", side_effect=exploding_stop):
            from tests.integration.conftest import _stop_beads_daemons
            _stop_beads_daemons(fake_project, [])

    def test_skips_main_project_without_beads_dir(self, tmp_path):
        """No error when main project has no .beads/ dir."""
        project = tmp_path / "project_no_beads"
        project.mkdir()

        stopped = []

        def track_stop(beads_dir, **kwargs):
            stopped.append(str(beads_dir))
            return True

        with patch("worca.utils.beads.bd_daemon_stop", side_effect=track_stop):
            from tests.integration.conftest import _stop_beads_daemons
            _stop_beads_daemons(project, [])

        assert len(stopped) == 0
