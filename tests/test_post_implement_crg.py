"""Tests for _crg_post_implement_refresh (W-057 §8, Phase 4).

The helper runs ``code-review-graph update`` against the run-scoped CRG
data dir after all beads complete in the IMPLEMENT stage, so the tester
sees in-flight edits.
"""

import os
import subprocess
from unittest.mock import MagicMock, patch

from worca.orchestrator.runner import _crg_post_implement_refresh


class TestCrgPostImplementRefresh:
    """Unit tests for _crg_post_implement_refresh."""

    def test_success_returns_true(self, tmp_path):
        crg_dir = str(tmp_path / "code-review-graph")
        os.makedirs(crg_dir)
        project_root = str(tmp_path / "repo")
        os.makedirs(project_root)

        with patch("worca.orchestrator.runner.subprocess") as mock_sub:
            mock_sub.run.return_value = MagicMock(returncode=0)
            mock_sub.TimeoutExpired = subprocess.TimeoutExpired

            result = _crg_post_implement_refresh(crg_dir, project_root, timeout=30)

        assert result is True
        mock_sub.run.assert_called_once()
        call_args = mock_sub.run.call_args
        assert call_args[0][0] == ["code-review-graph", "update"]
        env = call_args[1]["env"]
        assert env["CRG_REPO_ROOT"] == os.path.abspath(project_root)
        assert env["CRG_DATA_DIR"] == crg_dir
        assert call_args[1]["timeout"] == 30

    def test_nonzero_returncode_returns_false(self, tmp_path):
        crg_dir = str(tmp_path / "code-review-graph")
        os.makedirs(crg_dir)
        project_root = str(tmp_path / "repo")
        os.makedirs(project_root)

        with patch("worca.orchestrator.runner.subprocess") as mock_sub:
            mock_sub.run.return_value = MagicMock(returncode=1)
            mock_sub.TimeoutExpired = subprocess.TimeoutExpired

            result = _crg_post_implement_refresh(crg_dir, project_root, timeout=30)

        assert result is False

    def test_timeout_returns_false(self, tmp_path):
        crg_dir = str(tmp_path / "code-review-graph")
        os.makedirs(crg_dir)
        project_root = str(tmp_path / "repo")
        os.makedirs(project_root)

        with patch("worca.orchestrator.runner.subprocess") as mock_sub:
            mock_sub.TimeoutExpired = subprocess.TimeoutExpired
            mock_sub.run.side_effect = subprocess.TimeoutExpired(
                cmd=["code-review-graph", "update"], timeout=30
            )

            result = _crg_post_implement_refresh(crg_dir, project_root, timeout=30)

        assert result is False

    def test_unexpected_exception_returns_false(self, tmp_path):
        crg_dir = str(tmp_path / "code-review-graph")
        os.makedirs(crg_dir)
        project_root = str(tmp_path / "repo")
        os.makedirs(project_root)

        with patch("worca.orchestrator.runner.subprocess") as mock_sub:
            mock_sub.TimeoutExpired = subprocess.TimeoutExpired
            mock_sub.run.side_effect = OSError("no such file")

            result = _crg_post_implement_refresh(crg_dir, project_root, timeout=30)

        assert result is False

    def test_default_timeout_is_30(self, tmp_path):
        crg_dir = str(tmp_path / "code-review-graph")
        os.makedirs(crg_dir)
        project_root = str(tmp_path / "repo")
        os.makedirs(project_root)

        with patch("worca.orchestrator.runner.subprocess") as mock_sub:
            mock_sub.run.return_value = MagicMock(returncode=0)
            mock_sub.TimeoutExpired = subprocess.TimeoutExpired

            _crg_post_implement_refresh(crg_dir, project_root)

        assert mock_sub.run.call_args[1]["timeout"] == 30

    def test_captures_output(self, tmp_path):
        """Subprocess output is captured (not leaked to pipeline stdout)."""
        crg_dir = str(tmp_path / "code-review-graph")
        os.makedirs(crg_dir)
        project_root = str(tmp_path / "repo")
        os.makedirs(project_root)

        with patch("worca.orchestrator.runner.subprocess") as mock_sub:
            mock_sub.run.return_value = MagicMock(returncode=0)
            mock_sub.TimeoutExpired = subprocess.TimeoutExpired

            _crg_post_implement_refresh(crg_dir, project_root)

        assert mock_sub.run.call_args[1]["capture_output"] is True
