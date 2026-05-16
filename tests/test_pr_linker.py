"""Tests for worca.workspace.pr_linker — dependency comments + umbrella issue (W-047 §6)."""
import subprocess
from unittest.mock import patch


from worca.workspace.manifest import RepoEntry, Workspace
from worca.workspace.pr_linker import (
    build_dependency_comment,
    build_umbrella_body,
    create_umbrella_issue,
    parse_nwo_from_remote,
    post_dependency_comments,
    validate_gh_auth,
)


# -- helpers ------------------------------------------------------------------


def _make_workspace(*, umbrella_repo=None):
    repos = [
        RepoEntry(name="shared-lib", path="shared-lib", depends_on=[]),
        RepoEntry(name="backend", path="backend", depends_on=["shared-lib"]),
        RepoEntry(name="frontend", path="frontend", depends_on=["backend"]),
    ]
    tiers = [["shared-lib"], ["backend"], ["frontend"]]
    return Workspace(
        name="my-platform",
        repos=repos,
        tiers=tiers,
        umbrella_repo=umbrella_repo,
    )


def _make_manifest_with_prs():
    return {
        "workspace_id": "ws_202605150000_aabb1122",
        "workspace_name": "my-platform",
        "workspace_root": "/workspace",
        "work_request": {"title": "Add user profiles", "description": "...", "source": None},
        "dag": {
            "tiers": [
                {"tier": 0, "repos": ["shared-lib"], "status": "completed"},
                {"tier": 1, "repos": ["backend"], "status": "completed"},
                {"tier": 2, "repos": ["frontend"], "status": "completed"},
            ],
        },
        "children": [
            {
                "repo": "shared-lib",
                "run_id": "r-001",
                "worktree_path": "/wt/shared-lib",
                "status": "completed",
                "tier": 0,
                "pr_number": 15,
                "pr_url": "https://github.com/org/shared-lib/pull/15",
                "nwo": "org/shared-lib",
            },
            {
                "repo": "backend",
                "run_id": "r-002",
                "worktree_path": "/wt/backend",
                "status": "completed",
                "tier": 1,
                "pr_number": 42,
                "pr_url": "https://github.com/org/backend/pull/42",
                "nwo": "org/backend",
            },
            {
                "repo": "frontend",
                "run_id": "r-003",
                "worktree_path": "/wt/frontend",
                "status": "completed",
                "tier": 2,
                "pr_number": 43,
                "pr_url": "https://github.com/org/frontend/pull/43",
                "nwo": "org/frontend",
            },
        ],
    }


def _all_pr_info_from(manifest):
    return {
        c["repo"]: {"pr_number": c["pr_number"], "pr_url": c["pr_url"], "nwo": c["nwo"]}
        for c in manifest["children"]
        if c.get("pr_number")
    }


# -- parse_nwo_from_remote ---------------------------------------------------


class TestParseNwoFromRemote:
    def test_https_with_git_suffix(self):
        assert parse_nwo_from_remote("https://github.com/org/repo.git") == "org/repo"

    def test_ssh_with_git_suffix(self):
        assert parse_nwo_from_remote("git@github.com:org/repo.git") == "org/repo"

    def test_https_without_git_suffix(self):
        assert parse_nwo_from_remote("https://github.com/org/repo") == "org/repo"

    def test_ssh_without_git_suffix(self):
        assert parse_nwo_from_remote("git@github.com:org/repo") == "org/repo"

    def test_trailing_whitespace(self):
        assert parse_nwo_from_remote("https://github.com/org/repo.git\n") == "org/repo"

    def test_empty_returns_none(self):
        assert parse_nwo_from_remote("") is None

    def test_enterprise_host(self):
        assert parse_nwo_from_remote("https://github.corp.com/team/project.git") == "team/project"


# -- validate_gh_auth --------------------------------------------------------


class TestValidateGhAuth:
    def test_returns_empty_on_success(self):
        proc = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with patch("worca.workspace.pr_linker.subprocess.run", return_value=proc):
            result = validate_gh_auth({"org/repo-a", "org/repo-b"})
        assert result == []

    def test_returns_orgs_on_failure(self):
        proc = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="")
        with patch("worca.workspace.pr_linker.subprocess.run", return_value=proc):
            result = validate_gh_auth({"org/repo-a", "other-org/repo-b"})
        assert "org" in result
        assert "other-org" in result


# -- dependency comments (test_dependency_comments) --------------------------


class TestDependencyComments:
    """Each PR gets a comment listing deps and dependents."""

    def test_root_repo_has_blocks_but_no_depends(self):
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()
        pr_info = _all_pr_info_from(manifest)

        comment = build_dependency_comment(
            "shared-lib", pr_info, ws, manifest["workspace_id"],
        )

        assert "## Workspace: my-platform" in comment
        assert "**Depends on:**" not in comment
        assert "**Blocks:**" in comment
        assert "org/backend#42" in comment
        assert "ws_202605150000_aabb1122" in comment

    def test_middle_repo_has_both_deps_and_blocks(self):
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()
        pr_info = _all_pr_info_from(manifest)

        comment = build_dependency_comment(
            "backend", pr_info, ws, manifest["workspace_id"],
        )

        assert "**Depends on:**" in comment
        assert "org/shared-lib#15" in comment
        assert "(must merge first)" in comment
        assert "**Blocks:**" in comment
        assert "org/frontend#43" in comment

    def test_leaf_repo_has_depends_but_no_blocks(self):
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()
        pr_info = _all_pr_info_from(manifest)

        comment = build_dependency_comment(
            "frontend", pr_info, ws, manifest["workspace_id"],
        )

        assert "**Depends on:**" in comment
        assert "org/backend#42" in comment
        assert "**Blocks:**" not in comment

    def test_workspace_run_id_always_present(self):
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()
        pr_info = _all_pr_info_from(manifest)

        for repo_name in ["shared-lib", "backend", "frontend"]:
            comment = build_dependency_comment(
                repo_name, pr_info, ws, manifest["workspace_id"],
            )
            assert "**Workspace run:** `ws_202605150000_aabb1122`" in comment

    def test_post_calls_gh_pr_comment_for_each_pr(self):
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()

        calls = []

        def mock_run(cmd, **kwargs):
            calls.append(list(cmd))
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            post_dependency_comments(manifest, ws)

        assert len(calls) == 3

        for cmd in calls:
            assert cmd[:3] == ["gh", "pr", "comment"]
            assert "--repo" in cmd
            assert "--body" in cmd

        commented_pr_numbers = {cmd[3] for cmd in calls}
        assert commented_pr_numbers == {"15", "42", "43"}

    def test_post_passes_correct_repo_flag(self):
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()

        calls = []

        def mock_run(cmd, **kwargs):
            calls.append(list(cmd))
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            post_dependency_comments(manifest, ws)

        repo_flags = {}
        for cmd in calls:
            pr_num = cmd[3]
            repo_idx = cmd.index("--repo")
            repo_flags[pr_num] = cmd[repo_idx + 1]

        assert repo_flags["15"] == "org/shared-lib"
        assert repo_flags["42"] == "org/backend"
        assert repo_flags["43"] == "org/frontend"

    def test_skips_children_without_pr_info(self):
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()
        manifest["children"][2]["pr_number"] = None
        manifest["children"][2]["nwo"] = None

        calls = []

        def mock_run(cmd, **kwargs):
            calls.append(list(cmd))
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            post_dependency_comments(manifest, ws)

        assert len(calls) == 2


# -- umbrella issue (test_umbrella_issue) ------------------------------------


class TestUmbrellaIssue:
    """Umbrella issue created with checklist in merge order."""

    def test_body_has_checklist_in_tier_order(self):
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()

        body = build_umbrella_body(manifest, ws)

        assert "## Workspace PR Set: Add user profiles" in body
        assert "- [ ] org/shared-lib#15" in body
        assert "- [ ] org/backend#42" in body
        assert "- [ ] org/frontend#43" in body

        lib_pos = body.index("org/shared-lib#15")
        backend_pos = body.index("org/backend#42")
        frontend_pos = body.index("org/frontend#43")
        assert lib_pos < backend_pos < frontend_pos

    def test_body_uses_repo_name_as_description(self):
        # `role` was removed (was a freeform label with no behavior). The
        # umbrella body now falls back to the repo name.
        ws = _make_workspace()
        manifest = _make_manifest_with_prs()

        body = build_umbrella_body(manifest, ws)

        assert "— shared-lib" in body
        assert "— backend" in body
        assert "— frontend" in body

    def test_create_uses_umbrella_repo_from_workspace(self):
        ws = _make_workspace(umbrella_repo="org/platform-meta")
        manifest = _make_manifest_with_prs()

        captured = []

        def mock_run(cmd, **kwargs):
            captured.append(list(cmd))
            return subprocess.CompletedProcess(
                args=cmd, returncode=0,
                stdout="https://github.com/org/platform-meta/issues/7\n",
                stderr="",
            )

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            result = create_umbrella_issue(manifest, ws)

        assert result is not None
        assert result["url"] == "https://github.com/org/platform-meta/issues/7"

        cmd = captured[0]
        repo_idx = cmd.index("--repo")
        assert cmd[repo_idx + 1] == "org/platform-meta"

    def test_create_falls_back_to_first_tier0_repo(self):
        ws = _make_workspace(umbrella_repo=None)
        manifest = _make_manifest_with_prs()

        captured = []

        def mock_run(cmd, **kwargs):
            captured.append(list(cmd))
            return subprocess.CompletedProcess(
                args=cmd, returncode=0,
                stdout="https://github.com/org/shared-lib/issues/1\n",
                stderr="",
            )

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            result = create_umbrella_issue(manifest, ws)

        assert result is not None

        cmd = captured[0]
        repo_idx = cmd.index("--repo")
        assert cmd[repo_idx + 1] == "org/shared-lib"

    def test_create_calls_gh_issue_create(self):
        ws = _make_workspace(umbrella_repo="org/platform-meta")
        manifest = _make_manifest_with_prs()

        captured = []

        def mock_run(cmd, **kwargs):
            captured.append(list(cmd))
            return subprocess.CompletedProcess(
                args=cmd, returncode=0,
                stdout="https://github.com/org/platform-meta/issues/7\n",
                stderr="",
            )

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            create_umbrella_issue(manifest, ws)

        cmd = captured[0]
        assert cmd[:3] == ["gh", "issue", "create"]
        assert "--title" in cmd
        assert "--body" in cmd

    def test_create_returns_none_on_failure(self):
        ws = _make_workspace(umbrella_repo="org/platform-meta")
        manifest = _make_manifest_with_prs()

        proc = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="error")
        with patch("worca.workspace.pr_linker.subprocess.run", return_value=proc):
            result = create_umbrella_issue(manifest, ws)

        assert result is None

    def test_umbrella_stored_in_manifest_via_link(self):
        from worca.workspace.pr_linker import link_workspace_prs

        ws = _make_workspace(umbrella_repo="org/platform-meta")
        manifest = _make_manifest_with_prs()

        def mock_run(cmd, **kwargs):
            if cmd[:3] == ["gh", "issue", "create"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout="https://github.com/org/platform-meta/issues/7\n",
                    stderr="",
                )
            if cmd[:2] == ["gh", "auth"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0, stdout="", stderr="",
                )
            if cmd[:2] == ["git", "remote"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout="https://github.com/org/repo.git\n", stderr="",
                )
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("worca.workspace.pr_linker.subprocess.run", side_effect=mock_run):
            result = link_workspace_prs(manifest, ws, "/tmp/run-dir")

        assert "umbrella_issue" in result
        assert result["umbrella_issue"]["url"] == "https://github.com/org/platform-meta/issues/7"
