"""Tests for cross-repo integration test runner (W-047 §5)."""
import os
from unittest.mock import MagicMock, patch


from worca.workspace.integration_test import (
    cleanup_integration_env,
    run_integration_test,
    setup_integration_env,
)
from worca.workspace.manifest import IntegrationTest, RepoEntry, Workspace


# -- helpers ------------------------------------------------------------------


def _make_workspace(*, integration_test=None, repos=None, tiers=None):
    if repos is None:
        repos = [
            RepoEntry(name="lib", path="lib", role="library", depends_on=[]),
            RepoEntry(name="backend", path="backend", role="service", depends_on=["lib"]),
        ]
    if tiers is None:
        tiers = [["lib"], ["backend"]]
    return Workspace(
        name="test-ws",
        repos=repos,
        tiers=tiers,
        integration_test=integration_test,
    )


def _make_manifest(*, skip_integration=False, children=None, workspace_root="/ws"):
    if children is None:
        children = [
            {"repo": "lib", "worktree_path": "/ws/.worktrees/lib-wt", "status": "completed", "tier": 0},
            {"repo": "backend", "worktree_path": "/ws/.worktrees/backend-wt", "status": "completed", "tier": 1},
        ]
    return {
        "workspace_id": "ws_test_123",
        "workspace_root": workspace_root,
        "skip_integration": skip_integration,
        "children": children,
        "integration_test": {"status": "pending", "exit_code": None, "log_path": None},
    }


# -- skip ---------------------------------------------------------------------


class TestSkip:
    def test_skip_no_integration_test(self, tmp_path):
        ws = _make_workspace(integration_test=None)
        manifest = _make_manifest(workspace_root=str(tmp_path))
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        result = run_integration_test(manifest, ws, run_dir)

        assert result["status"] == "skipped"
        assert result["exit_code"] is None
        assert result["log_path"] is None

    def test_skip_flag_set(self, tmp_path):
        ws = _make_workspace(
            integration_test=IntegrationTest(command="make test", working_dir="."),
        )
        manifest = _make_manifest(skip_integration=True, workspace_root=str(tmp_path))
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        result = run_integration_test(manifest, ws, run_dir)

        assert result["status"] == "skipped"
        assert result["exit_code"] is None


# -- env_setup ----------------------------------------------------------------


class TestEnvSetup:
    @patch("worca.workspace.integration_test.subprocess.run")
    def test_creates_worktrees_for_completed_children(self, mock_run, tmp_path):
        ws_root = str(tmp_path)
        repos = [
            RepoEntry(name="lib", path="lib", role="library", depends_on=[]),
            RepoEntry(name="backend", path="backend", role="service", depends_on=["lib"]),
        ]
        ws = _make_workspace(repos=repos)
        children = [
            {"repo": "lib", "worktree_path": str(tmp_path / "wt-lib"), "status": "completed", "tier": 0},
            {"repo": "backend", "worktree_path": str(tmp_path / "wt-backend"), "status": "completed", "tier": 1},
        ]

        os.makedirs(tmp_path / "lib")
        os.makedirs(tmp_path / "backend")

        mock_run.return_value = MagicMock(returncode=0, stdout="feat-branch\n")

        env_dir, env_paths = setup_integration_env(ws_root, children, ws)

        expected_env = os.path.join(ws_root, ".worca", "integration-env")
        assert env_dir == expected_env
        assert len(env_paths) == 2
        assert "lib" in env_paths
        assert "backend" in env_paths

        worktree_add_calls = [
            c for c in mock_run.call_args_list
            if "worktree" in str(c.args[0]) and "add" in str(c.args[0])
        ]
        assert len(worktree_add_calls) == 2

    @patch("worca.workspace.integration_test.subprocess.run")
    def test_skips_non_completed_children(self, mock_run, tmp_path):
        ws_root = str(tmp_path)
        repos = [RepoEntry(name="lib", path="lib", role="library", depends_on=[])]
        ws = _make_workspace(repos=repos, tiers=[["lib"]])
        children = [
            {"repo": "lib", "worktree_path": None, "status": "failed", "tier": 0},
        ]

        env_dir, env_paths = setup_integration_env(ws_root, children, ws)

        assert len(env_paths) == 0
        mock_run.assert_not_called()


# -- env_cleanup --------------------------------------------------------------


class TestEnvCleanup:
    @patch("worca.workspace.integration_test.subprocess.run")
    def test_removes_worktrees(self, mock_run, tmp_path):
        ws_root = str(tmp_path)
        repos = [RepoEntry(name="lib", path="lib", role="library", depends_on=[])]
        ws = _make_workspace(repos=repos, tiers=[["lib"]])
        env_paths = {"lib": os.path.join(ws_root, ".worca", "integration-env", "lib")}

        os.makedirs(tmp_path / "lib")
        mock_run.return_value = MagicMock(returncode=0)

        cleanup_integration_env(ws_root, env_paths, ws)

        worktree_remove_calls = [
            c for c in mock_run.call_args_list
            if "worktree" in str(c.args[0]) and "remove" in str(c.args[0])
        ]
        assert len(worktree_remove_calls) == 1


# -- pass ---------------------------------------------------------------------


class TestPass:
    def test_pass_returns_status_and_log(self, tmp_path):
        ws_root = str(tmp_path)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        env_dir = os.path.join(ws_root, ".worca", "integration-env")
        ws = _make_workspace(
            integration_test=IntegrationTest(command="make test", working_dir="."),
            repos=[RepoEntry(name="lib", path="lib", role="library", depends_on=[])],
            tiers=[["lib"]],
        )
        manifest = _make_manifest(
            workspace_root=ws_root,
            children=[
                {"repo": "lib", "worktree_path": str(tmp_path / "wt"), "status": "completed", "tier": 0},
            ],
        )

        with (
            patch("worca.workspace.integration_test.setup_integration_env") as mock_setup,
            patch("worca.workspace.integration_test.cleanup_integration_env") as mock_cleanup,
            patch("worca.workspace.integration_test.subprocess") as mock_subprocess,
        ):
            mock_setup.return_value = (env_dir, {"lib": os.path.join(env_dir, "lib")})
            mock_subprocess.run.return_value = MagicMock(
                returncode=0, stdout="OK\n", stderr="",
            )

            result = run_integration_test(manifest, ws, run_dir)

        assert result["status"] == "passed"
        assert result["exit_code"] == 0
        assert result["log_path"] is not None
        assert os.path.isfile(result["log_path"])
        mock_cleanup.assert_called_once()

        _, call_kwargs = mock_subprocess.run.call_args
        assert call_kwargs["env"]["WORCA_INTEGRATION_ENV"] == "1"
        assert call_kwargs["env"]["WORCA_WORKSPACE_ROOT"] == ws_root
        assert call_kwargs["shell"] is True


# -- fail ---------------------------------------------------------------------


class TestFail:
    def test_fail_returns_status_and_log(self, tmp_path):
        ws_root = str(tmp_path)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        env_dir = os.path.join(ws_root, ".worca", "integration-env")
        ws = _make_workspace(
            integration_test=IntegrationTest(command="make test", working_dir="."),
            repos=[RepoEntry(name="lib", path="lib", role="library", depends_on=[])],
            tiers=[["lib"]],
        )
        manifest = _make_manifest(
            workspace_root=ws_root,
            children=[
                {"repo": "lib", "worktree_path": str(tmp_path / "wt"), "status": "completed", "tier": 0},
            ],
        )

        with (
            patch("worca.workspace.integration_test.setup_integration_env") as mock_setup,
            patch("worca.workspace.integration_test.cleanup_integration_env") as mock_cleanup,
            patch("worca.workspace.integration_test.subprocess") as mock_subprocess,
        ):
            mock_setup.return_value = (env_dir, {"lib": os.path.join(env_dir, "lib")})
            mock_subprocess.run.return_value = MagicMock(
                returncode=1, stdout="FAIL\n", stderr="error\n",
            )

            result = run_integration_test(manifest, ws, run_dir)

        assert result["status"] == "failed"
        assert result["exit_code"] == 1
        assert result["log_path"] is not None
        assert os.path.isfile(result["log_path"])
        mock_cleanup.assert_called_once()
