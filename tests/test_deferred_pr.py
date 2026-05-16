"""Tests for deferred PR creation in workspace pipelines (W-047 §5/§6)."""
import subprocess
from unittest.mock import patch


from worca.workspace.manifest import RepoEntry, Workspace


# -- helpers ------------------------------------------------------------------


def _make_workspace():
    repos = [
        RepoEntry(name="lib", path="lib", depends_on=[]),
        RepoEntry(name="app", path="app", depends_on=["lib"]),
    ]
    return Workspace(name="test-ws", repos=repos, tiers=[["lib"], ["app"]])


def _make_manifest_no_prs():
    """Manifest with completed children but no PR info yet."""
    return {
        "workspace_id": "ws_202605150000_aabb1122",
        "workspace_name": "test-ws",
        "workspace_root": "/workspace",
        "work_request": {"title": "Apply migration", "description": "...", "source": None},
        "dag": {
            "tiers": [
                {"tier": 0, "repos": ["lib"], "status": "completed"},
                {"tier": 1, "repos": ["app"], "status": "completed"},
            ],
        },
        "children": [
            {
                "repo": "lib",
                "run_id": "r-001",
                "worktree_path": "/wt/lib",
                "status": "completed",
                "tier": 0,
            },
            {
                "repo": "app",
                "run_id": "r-002",
                "worktree_path": "/wt/app",
                "status": "completed",
                "tier": 1,
            },
        ],
    }


# -- test_defer_pr_env -------------------------------------------------------


class TestDeferPrEnv:
    """WORCA_DEFER_PR=1 is set in child env by the DagExecutor."""

    def test_child_env_has_defer_pr_set(self):
        from worca.workspace.dag_executor import _build_child_env

        env = _build_child_env(
            {"PATH": "/usr/bin", "HOME": "/home/user"},
            workspace_id="ws_test_123",
            workspace_name="my-workspace",
        )

        assert env["WORCA_DEFER_PR"] == "1"

    def test_child_env_has_workspace_id(self):
        from worca.workspace.dag_executor import _build_child_env

        env = _build_child_env(
            {"PATH": "/usr/bin"},
            workspace_id="ws_test_123",
            workspace_name="my-workspace",
        )

        assert env["WORCA_WORKSPACE_ID"] == "ws_test_123"

    def test_child_env_has_workspace_name(self):
        from worca.workspace.dag_executor import _build_child_env

        env = _build_child_env(
            {"PATH": "/usr/bin"},
            workspace_id="ws_test_123",
            workspace_name="my-workspace",
        )

        assert env["WORCA_WORKSPACE_NAME"] == "my-workspace"


# -- test_central_pr_creation ------------------------------------------------


class TestCentralPrCreation:
    """run_workspace.py creates PRs via gh pr create --repo after integration pass."""

    def test_creates_pr_for_each_completed_child(self):
        from worca.workspace.pr_linker import create_workspace_prs

        ws = _make_workspace()
        manifest = _make_manifest_no_prs()
        nwos = {"lib": "org/lib", "app": "org/app"}

        gh_calls = []

        def mock_run(cmd, **kwargs):
            if cmd[:2] == ["git", "rev-parse"]:
                cwd = kwargs.get("cwd", "")
                branch = "workspace/migration/lib" if "lib" in cwd else "workspace/migration/app"
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0, stdout=f"{branch}\n", stderr="",
                )
            if cmd[:3] == ["gh", "pr", "create"]:
                gh_calls.append(list(cmd))
                repo_idx = cmd.index("--repo")
                nwo = cmd[repo_idx + 1]
                pr_num = 10 + len(gh_calls)
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout=f"https://github.com/{nwo}/pull/{pr_num}\n",
                    stderr="",
                )
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            create_workspace_prs(manifest, ws, nwos)

        assert len(gh_calls) == 2

        for cmd in gh_calls:
            assert cmd[:3] == ["gh", "pr", "create"]
            assert "--repo" in cmd
            assert "--head" in cmd
            assert "--title" in cmd

    def test_pr_url_stored_on_child(self):
        from worca.workspace.pr_linker import create_workspace_prs

        ws = _make_workspace()
        manifest = _make_manifest_no_prs()
        nwos = {"lib": "org/lib", "app": "org/app"}

        def mock_run(cmd, **kwargs):
            if cmd[:2] == ["git", "rev-parse"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0, stdout="feat-branch\n", stderr="",
                )
            if cmd[:3] == ["gh", "pr", "create"]:
                repo_idx = cmd.index("--repo")
                nwo = cmd[repo_idx + 1]
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout=f"https://github.com/{nwo}/pull/99\n",
                    stderr="",
                )
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            create_workspace_prs(manifest, ws, nwos)

        for child in manifest["children"]:
            assert child.get("pr_url") is not None
            assert child.get("pr_number") == 99
            assert child.get("nwo") is not None

    def test_uses_repo_flag_not_cwd(self):
        """PR creation uses --repo flag, not cwd, since cwd is workspace root."""
        from worca.workspace.pr_linker import create_workspace_prs

        ws = _make_workspace()
        manifest = _make_manifest_no_prs()
        nwos = {"lib": "org/lib", "app": "org/app"}

        gh_calls = []

        def mock_run(cmd, **kwargs):
            if cmd[:2] == ["git", "rev-parse"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0, stdout="branch\n", stderr="",
                )
            if cmd[:3] == ["gh", "pr", "create"]:
                gh_calls.append(list(cmd))
                repo_idx = cmd.index("--repo")
                nwo = cmd[repo_idx + 1]
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout=f"https://github.com/{nwo}/pull/1\n",
                    stderr="",
                )
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            create_workspace_prs(manifest, ws, nwos)

        repos_used = set()
        for cmd in gh_calls:
            repo_idx = cmd.index("--repo")
            repos_used.add(cmd[repo_idx + 1])

        assert repos_used == {"org/lib", "org/app"}

    def test_skips_failed_children(self):
        from worca.workspace.pr_linker import create_workspace_prs

        ws = _make_workspace()
        manifest = _make_manifest_no_prs()
        manifest["children"][1]["status"] = "failed"
        nwos = {"lib": "org/lib", "app": "org/app"}

        gh_calls = []

        def mock_run(cmd, **kwargs):
            if cmd[:2] == ["git", "rev-parse"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0, stdout="branch\n", stderr="",
                )
            if cmd[:3] == ["gh", "pr", "create"]:
                gh_calls.append(list(cmd))
                repo_idx = cmd.index("--repo")
                nwo = cmd[repo_idx + 1]
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout=f"https://github.com/{nwo}/pull/1\n",
                    stderr="",
                )
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            create_workspace_prs(manifest, ws, nwos)

        assert len(gh_calls) == 1

    def test_skips_children_with_existing_pr(self):
        from worca.workspace.pr_linker import create_workspace_prs

        ws = _make_workspace()
        manifest = _make_manifest_no_prs()
        manifest["children"][0]["pr_number"] = 99
        manifest["children"][0]["pr_url"] = "https://github.com/org/lib/pull/99"
        manifest["children"][0]["nwo"] = "org/lib"
        nwos = {"lib": "org/lib", "app": "org/app"}

        gh_calls = []

        def mock_run(cmd, **kwargs):
            if cmd[:2] == ["git", "rev-parse"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0, stdout="branch\n", stderr="",
                )
            if cmd[:3] == ["gh", "pr", "create"]:
                gh_calls.append(list(cmd))
                repo_idx = cmd.index("--repo")
                nwo = cmd[repo_idx + 1]
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout=f"https://github.com/{nwo}/pull/1\n",
                    stderr="",
                )
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            create_workspace_prs(manifest, ws, nwos)

        assert len(gh_calls) == 1
        repo_idx = gh_calls[0].index("--repo")
        assert gh_calls[0][repo_idx + 1] == "org/app"

    def test_title_has_workspace_prefix(self):
        from worca.workspace.pr_linker import create_workspace_prs

        ws = _make_workspace()
        manifest = _make_manifest_no_prs()
        nwos = {"lib": "org/lib", "app": "org/app"}

        gh_calls = []

        def mock_run(cmd, **kwargs):
            if cmd[:2] == ["git", "rev-parse"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0, stdout="branch\n", stderr="",
                )
            if cmd[:3] == ["gh", "pr", "create"]:
                gh_calls.append(list(cmd))
                repo_idx = cmd.index("--repo")
                nwo = cmd[repo_idx + 1]
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout=f"https://github.com/{nwo}/pull/1\n",
                    stderr="",
                )
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            create_workspace_prs(manifest, ws, nwos)

        for cmd in gh_calls:
            title_idx = cmd.index("--title")
            title = cmd[title_idx + 1]
            assert title.startswith("[workspace:aabb1122]")
            assert "Apply migration" in title
