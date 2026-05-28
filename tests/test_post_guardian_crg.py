"""Tests for the post-guardian CRG base cache warm in runner.py.

After a successful guardian commit, the runner warms the per-commit CRG
base cache for the NEW HEAD by spawning a detached ``run_crg_preflight``
subprocess. Mirrors the graphify post-guardian pattern. Skipped in
worktrees; failures are logged, never raised.
"""

import sys
from unittest.mock import MagicMock, patch

from worca.orchestrator.runner import _maybe_crg_post_guardian
from worca.utils.code_review_graph import EffectiveCrgConfig


def _make_config(*, enabled=True, update_on_guardian_post_commit=True):
    return EffectiveCrgConfig(
        enabled=enabled,
        embeddings=False,
        update_on_preflight=True,
        update_on_post_implement=True,
        update_on_guardian_post_commit=update_on_guardian_post_commit,
        min_repo_files=100,
        version_range=">=2,<3",
        fastmcp_min="3.2.4",
        preflight_timeout_seconds=300,
        freshness="clean_only",
        stage_tools=None,
    )


_ENABLED = {"worca": {"code_review_graph": {"enabled": True}}}


class TestCrgCacheWarmTriggeredInParent:
    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_crg_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_code_review_graph")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_spawns_detached_preflight(self, ms, mg, mdetect, mcfg, mpopen):
        mdetect.return_value = MagicMock(installed=True, compatible=True, fastmcp_ok=True)
        _maybe_crg_post_guardian(is_worktree=False)
        mpopen.assert_called_once()
        argv = mpopen.call_args[0][0]
        assert argv[0] == sys.executable
        assert argv[1] == "-c"
        assert "run_crg_preflight" in argv[2]
        assert mpopen.call_args.kwargs.get("start_new_session") is True


class TestCrgCacheWarmSkipped:
    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_skipped_in_worktree(self, ms, mpopen):
        _maybe_crg_post_guardian(is_worktree=True)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_crg_config", return_value=_make_config(enabled=False))
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {}})
    def test_skipped_when_disabled(self, ms, mg, mcfg, mpopen):
        _maybe_crg_post_guardian(is_worktree=False)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch(
        "worca.orchestrator.runner.effective_crg_config",
        return_value=_make_config(update_on_guardian_post_commit=False),
    )
    @patch("worca.orchestrator.runner.detect_code_review_graph")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_skipped_when_flag_off(self, ms, mg, mdetect, mcfg, mpopen):
        mdetect.return_value = MagicMock(installed=True, compatible=True, fastmcp_ok=True)
        _maybe_crg_post_guardian(is_worktree=False)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_crg_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_code_review_graph")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_skipped_when_not_installed(self, ms, mg, mdetect, mcfg, mpopen):
        mdetect.return_value = MagicMock(installed=False, compatible=False, fastmcp_ok=False)
        _maybe_crg_post_guardian(is_worktree=False)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_crg_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_code_review_graph")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_skipped_when_fastmcp_missing(self, ms, mg, mdetect, mcfg, mpopen):
        mdetect.return_value = MagicMock(installed=True, compatible=True, fastmcp_ok=False)
        _maybe_crg_post_guardian(is_worktree=False)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.detect_code_review_graph")
    @patch(
        "worca.orchestrator.runner.load_global_settings",
        return_value={"worca": {"code_review_graph": {"enabled": False}}},
    )
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_global_kill_switch(self, ms, mg, mdetect, mpopen):
        _maybe_crg_post_guardian(is_worktree=False)
        mpopen.assert_not_called()
        mdetect.assert_not_called()


class TestCrgCacheWarmFailureLogged:
    @patch("worca.orchestrator.runner._log")
    @patch("worca.orchestrator.runner.subprocess.Popen", side_effect=OSError("spawn failed"))
    @patch("worca.orchestrator.runner.effective_crg_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_code_review_graph")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_popen_failure_logged_not_raised(self, ms, mg, mdetect, mcfg, mpopen, mlog):
        mdetect.return_value = MagicMock(installed=True, compatible=True, fastmcp_ok=True)
        _maybe_crg_post_guardian(is_worktree=False)
        warn_calls = [c for c in mlog.call_args_list if len(c[0]) > 1 and c[0][1] == "warn"]
        assert len(warn_calls) >= 1

    @patch("worca.orchestrator.runner._log")
    @patch("worca.orchestrator.runner.effective_crg_config", side_effect=Exception("boom"))
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {}})
    def test_config_error_logged_not_raised(self, ms, mg, mcfg, mlog):
        _maybe_crg_post_guardian(is_worktree=False)
        warn_calls = [c for c in mlog.call_args_list if len(c[0]) > 1 and c[0][1] == "warn"]
        assert len(warn_calls) >= 1
