"""Tests for the post-guardian Graphify cache-warm in runner.py.

After a successful guardian commit, the runner warms the per-commit cache for
the NEW HEAD by spawning a detached ``run_graphify_preflight`` (W-053 cache
relocation). Skipped in worktrees; failures are logged, never raised.
"""

import sys
from unittest.mock import MagicMock, patch

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
        version_range=">=0.8.16,<1",
        reason=None,
    )


_ENABLED = {"worca": {"graphify": {"enabled": True}}}


class TestCacheWarmTriggeredInParent:
    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_spawns_detached_preflight(self, ms, mg, mdetect, mcfg, mpopen):
        mdetect.return_value = MagicMock(installed=True, compatible=True)
        _maybe_graphify_post_guardian(is_worktree=False)
        mpopen.assert_called_once()
        argv = mpopen.call_args[0][0]
        assert argv[0] == sys.executable
        assert argv[1] == "-c"
        assert "run_graphify_preflight" in argv[2]
        # detached / silenced
        assert mpopen.call_args.kwargs.get("start_new_session") is True


class TestCacheWarmSkipped:
    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_skipped_in_worktree(self, ms, mpopen):
        _maybe_graphify_post_guardian(is_worktree=True)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config(enabled=False))
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {}})
    def test_skipped_when_disabled(self, ms, mg, mcfg, mpopen):
        _maybe_graphify_post_guardian(is_worktree=False)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch(
        "worca.orchestrator.runner.effective_graphify_config",
        return_value=_make_config(update_on_guardian_post_commit=False),
    )
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_skipped_when_flag_off(self, ms, mg, mdetect, mcfg, mpopen):
        mdetect.return_value = MagicMock(installed=True, compatible=True)
        _maybe_graphify_post_guardian(is_worktree=False)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_skipped_when_not_installed(self, ms, mg, mdetect, mcfg, mpopen):
        mdetect.return_value = MagicMock(installed=False, compatible=False, error="not found")
        _maybe_graphify_post_guardian(is_worktree=False)
        mpopen.assert_not_called()

    @patch("worca.orchestrator.runner.subprocess.Popen")
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch(
        "worca.orchestrator.runner.load_global_settings",
        return_value={"worca": {"graphify": {"enabled": False}}},
    )
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_global_kill_switch(self, ms, mg, mdetect, mpopen):
        # global off → effective disabled → no detect, no spawn
        _maybe_graphify_post_guardian(is_worktree=False)
        mpopen.assert_not_called()
        mdetect.assert_not_called()


class TestCacheWarmFailureLogged:
    @patch("worca.orchestrator.runner._log")
    @patch("worca.orchestrator.runner.subprocess.Popen", side_effect=OSError("spawn failed"))
    @patch("worca.orchestrator.runner.effective_graphify_config", return_value=_make_config())
    @patch("worca.orchestrator.runner.detect_graphify")
    @patch("worca.orchestrator.runner.load_global_settings", return_value=_ENABLED)
    @patch("worca.orchestrator.runner.load_settings", return_value=_ENABLED)
    def test_popen_failure_logged_not_raised(self, ms, mg, mdetect, mcfg, mpopen, mlog):
        mdetect.return_value = MagicMock(installed=True, compatible=True)
        _maybe_graphify_post_guardian(is_worktree=False)
        warn_calls = [c for c in mlog.call_args_list if len(c[0]) > 1 and c[0][1] == "warn"]
        assert len(warn_calls) >= 1

    @patch("worca.orchestrator.runner._log")
    @patch("worca.orchestrator.runner.effective_graphify_config", side_effect=Exception("boom"))
    @patch("worca.orchestrator.runner.load_global_settings", return_value={})
    @patch("worca.orchestrator.runner.load_settings", return_value={"worca": {}})
    def test_config_error_logged_not_raised(self, ms, mg, mcfg, mlog):
        _maybe_graphify_post_guardian(is_worktree=False)
        warn_calls = [c for c in mlog.call_args_list if len(c[0]) > 1 and c[0][1] == "warn"]
        assert len(warn_calls) >= 1
