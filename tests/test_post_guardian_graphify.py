"""Tests for post-guardian graphify refresh in runner.py.

Phase 4 of W-053: after successful guardian commit, runner triggers
fire-and-forget `graphify --update [--no-llm]` when configured.
"""

from unittest.mock import patch, MagicMock


from worca.orchestrator.runner import _maybe_graphify_post_guardian
from worca.utils.graphify import EffectiveGraphifyConfig


def _make_config(*, enabled=True, mode="structural", update_on_guardian_post_commit=True):
    return EffectiveGraphifyConfig(
        enabled=enabled,
        mode=mode,
        backend=None,
        model_profile=None,
        out_dir="graphify-out",
        update_on_preflight=True,
        update_on_guardian_post_commit=update_on_guardian_post_commit,
        min_repo_files=100,
        version_range=">=4,<5",
        reason=None,
    )


class TestGraphifyPostGuardianTriggeredInParent:
    """Graphify refresh fires in parent project (non-worktree) runs."""

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_fires_in_parent_project(self, mock_settings, mock_global, mock_detect, mock_cfg, mock_popen):
        mock_detect.return_value = MagicMock(installed=True, compatible=True)
        mock_popen.return_value = MagicMock()

        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        mock_popen.assert_called_once()
        cmd = mock_popen.call_args[0][0]
        assert cmd[0] == "graphify"
        assert "--update" in cmd

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config(mode="structural"))
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_structural_mode_passes_no_llm(self, mock_settings, mock_global, mock_detect, mock_cfg, mock_popen):
        mock_detect.return_value = MagicMock(installed=True, compatible=True)
        mock_popen.return_value = MagicMock()

        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        cmd = mock_popen.call_args[0][0]
        assert "--no-llm" in cmd

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config(mode="full"))
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_full_mode_omits_no_llm(self, mock_settings, mock_global, mock_detect, mock_cfg, mock_popen):
        mock_detect.return_value = MagicMock(installed=True, compatible=True)
        mock_popen.return_value = MagicMock()

        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        cmd = mock_popen.call_args[0][0]
        assert "--no-llm" not in cmd


class TestGraphifyPostGuardianSkippedInWorktree:
    """Worktree runs must NOT refresh the parent graph (single-writer invariant)."""

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_skipped_in_worktree(self, mock_settings, mock_popen):
        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=True,
        )

        mock_popen.assert_not_called()


class TestGraphifyPostGuardianSkippedWhenDisabled:
    """Refresh skipped when graphify is disabled or flag is off."""

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config(enabled=False))
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {}})
    def test_skipped_when_disabled(self, mock_settings, mock_global, mock_cfg, mock_popen):
        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        mock_popen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config(update_on_guardian_post_commit=False))
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_skipped_when_flag_off(self, mock_settings, mock_global, mock_detect, mock_cfg, mock_popen):
        mock_detect.return_value = MagicMock(installed=True, compatible=True)

        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        mock_popen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_skipped_when_not_installed(self, mock_settings, mock_global, mock_detect, mock_cfg, mock_popen):
        mock_detect.return_value = MagicMock(installed=False, compatible=False, error="not found")

        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        mock_popen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_skipped_when_incompatible(self, mock_settings, mock_global, mock_detect, mock_cfg, mock_popen):
        mock_detect.return_value = MagicMock(installed=True, compatible=False, error="version 3.0 not in >=4,<5")

        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        mock_popen.assert_not_called()


class TestGraphifyPostGuardianGlobalKillSwitch:
    """Global enabled=false must override project enabled=true."""

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={"worca": {"graphify": {"enabled": False}}})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_global_off_overrides_project_on(self, mock_settings, mock_global, mock_detect, mock_popen):
        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        mock_popen.assert_not_called()
        mock_detect.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={"worca": {"graphify": {"enabled": False}}})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_global_kill_switch_passes_global_settings_to_config(self, mock_settings, mock_global, mock_detect, mock_popen):
        """effective_graphify_config receives separate global and project dicts."""
        with patch("worca.orchestrator.runner.effective_graphify_config", wraps=None) as mock_cfg:
            mock_cfg.return_value = _make_config(enabled=False)

            _maybe_graphify_post_guardian(
                settings_path=".claude/settings.json",
                is_worktree=False,
            )

            mock_cfg.assert_called_once()
            args = mock_cfg.call_args[0]
            assert args[0] == {"worca": {"graphify": {"enabled": False}}}
            assert args[1] == {"worca": {"graphify": {"enabled": True}}}


class TestGraphifyPostGuardianFailureLogged:
    """Failures are logged but never fail the pipeline."""

    @patch("worca.orchestrator.runner._log")
    @patch("worca.orchestrator.runner.subprocess.Popen", side_effect=OSError("spawn failed"))
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {"graphify": {"enabled": True}}})
    def test_popen_failure_logged_not_raised(self, mock_settings, mock_global, mock_detect, mock_cfg, mock_popen, mock_log):
        mock_detect.return_value = MagicMock(installed=True, compatible=True)

        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        warn_calls = [c for c in mock_log.call_args_list if c[0][1] == "warn"]
        assert len(warn_calls) >= 1
        assert "graphify" in warn_calls[0][0][0].lower()

    @patch("worca.orchestrator.runner._log")
    @patch("worca.orchestrator.runner.effective_graphify_config", side_effect=Exception("config boom"))
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {}})
    def test_config_error_logged_not_raised(self, mock_settings, mock_global, mock_cfg, mock_log):
        _maybe_graphify_post_guardian(
            settings_path=".claude/settings.json",
            is_worktree=False,
        )

        warn_calls = [c for c in mock_log.call_args_list if c[0][1] == "warn"]
        assert len(warn_calls) >= 1
