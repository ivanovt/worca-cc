"""Tests for worca.workspace.dag_executor — tier-based dispatch (W-047 §3)."""
import os
import subprocess
from unittest.mock import MagicMock, patch



def _make_manifest(
    *,
    workspace_id="ws_202605150000_aabb1122",
    workspace_name="test-workspace",
    workspace_root="/workspace",
    tiers=None,
    max_parallel=5,
    prompt="Apply migration",
    guide_paths=None,
    branch_template="workspace/{slug}/{repo}",
    project_plans=None,
    dependency_graph=None,
):
    """Build a minimal workspace manifest dict for tests."""
    if tiers is None:
        tiers = [
            {"tier": 0, "projects": ["lib"], "status": "pending"},
            {"tier": 1, "projects": ["backend", "frontend"], "status": "pending"},
        ]
    return {
        "workspace_id": workspace_id,
        "workspace_name": workspace_name,
        "workspace_root": workspace_root,
        "status": "running",
        "halt_reason": None,
        "max_parallel": max_parallel,
        "work_request": {"title": "", "description": prompt, "source": None},
        "guide": {"paths": guide_paths or [], "bytes": 0, "filenames": []},
        "branch_template": branch_template,
        "dag": {"tiers": tiers, "dependency_graph": dependency_graph or {}},
        "children": [],
        "plan": {"workspace_plan_path": None, "project_plans": project_plans or {}},
    }


def _completed_proc(run_id="r-001", worktree_path="/tmp/wt"):
    """Simulate a successful run_worktree.py subprocess."""
    return subprocess.CompletedProcess(
        args=[], returncode=0, stdout=f"{run_id}\n{worktree_path}\n", stderr=""
    )


def _failed_proc():
    """Simulate a failed run_worktree.py subprocess."""
    return subprocess.CompletedProcess(
        args=[], returncode=1, stdout="", stderr="error: boom"
    )


class TestDagExecutorTierOrdering:
    """Tier 0 dispatches first; tier 1 waits until tier 0 completes."""

    def test_single_tier_dispatches_all_repos(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["repo-a", "repo-b"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        dispatch_order = []

        def mock_run(cmd, **kwargs):
            repo = kwargs.get("cwd", "")
            dispatch_order.append(repo)
            return _completed_proc(run_id=f"r-{len(dispatch_order)}")

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            result = executor.execute()

        assert len(dispatch_order) == 2
        assert set(dispatch_order) == {
            os.path.join("/workspace", "repo-a"),
            os.path.join("/workspace", "repo-b"),
        }
        assert result["status"] == "completed"

    def test_two_tiers_execute_sequentially(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        tier_at_dispatch = []

        def mock_run(cmd, **kwargs):
            tier_at_dispatch.append(executor._current_tier)
            return _completed_proc(run_id=f"r-{len(tier_at_dispatch)}")

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            result = executor.execute()

        assert tier_at_dispatch == [0, 1]
        assert result["status"] == "completed"

    def test_three_tiers_in_order(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["base"], "status": "pending"},
                {"tier": 1, "projects": ["mid"], "status": "pending"},
                {"tier": 2, "projects": ["top"], "status": "pending"},
            ],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        tier_at_dispatch = []

        def mock_run(cmd, **kwargs):
            tier_at_dispatch.append(executor._current_tier)
            return _completed_proc(run_id=f"r-{len(tier_at_dispatch)}")

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        assert tier_at_dispatch == [0, 1, 2]

    def test_within_tier_projects_run_in_parallel(self):
        """Repos within the same tier are submitted to ThreadPoolExecutor."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["a", "b", "c"], "status": "pending"},
            ],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
            patch(
                "worca.workspace.dag_executor.ThreadPoolExecutor"
            ) as mock_tpe_cls,
            patch(
                "worca.workspace.dag_executor.as_completed",
                side_effect=lambda fs: list(fs),
            ),
        ):
            mock_tpe = MagicMock()
            mock_tpe.__enter__ = MagicMock(return_value=mock_tpe)
            mock_tpe.__exit__ = MagicMock(return_value=False)
            mock_future = MagicMock()
            mock_future.result.return_value = {"status": "completed", "run_id": "r-1"}
            mock_tpe.submit.return_value = mock_future
            mock_tpe_cls.return_value = mock_tpe

            executor.execute()

        assert mock_tpe.submit.call_count == 3


class TestDagExecutorChildCommand:
    """Verify the subprocess command uses --workspace-id (not --fleet-id)."""

    def test_uses_workspace_id_flag(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            workspace_id="ws_test_123",
            tiers=[{"tier": 0, "projects": ["repo-a"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_cmd = []

        def mock_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        assert "--workspace-id" in captured_cmd
        assert "ws_test_123" in captured_cmd
        assert "--fleet-id" not in captured_cmd

    def test_passes_prompt(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["repo-a"], "status": "pending"}],
            prompt="Do the thing",
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_cmd = []

        def mock_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        assert "--prompt" in captured_cmd
        idx = captured_cmd.index("--prompt")
        assert captured_cmd[idx + 1] == "Do the thing"

    def test_passes_guide_paths(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["repo-a"], "status": "pending"}],
            guide_paths=["/guides/spec.md", "/guides/api.md"],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_cmd = []

        def mock_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        guide_indices = [i for i, v in enumerate(captured_cmd) if v == "--guide"]
        assert len(guide_indices) == 2

    def test_passes_repo_plan_when_available(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["repo-a"], "status": "pending"}],
            project_plans={"repo-a": "/plans/repo-a-plan.md"},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_cmd = []

        def mock_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        assert "--plan" in captured_cmd
        idx = captured_cmd.index("--plan")
        assert captured_cmd[idx + 1] == "/plans/repo-a-plan.md"


class TestDagExecutorChildEnv:
    """Per-child env vars: WORCA_WORKSPACE_ID, WORCA_WORKSPACE_NAME, WORCA_DEFER_PR=1."""

    def test_sets_workspace_env_vars(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            workspace_id="ws_test_456",
            workspace_name="my-workspace",
            tiers=[{"tier": 0, "projects": ["repo-a"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_env = {}

        def mock_run(cmd, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        assert captured_env["WORCA_WORKSPACE_ID"] == "ws_test_456"
        assert captured_env["WORCA_WORKSPACE_NAME"] == "my-workspace"
        assert captured_env["WORCA_DEFER_PR"] == "1"

    def test_scrubs_parent_worca_vars(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["repo-a"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_env = {}

        def mock_run(cmd, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            return _completed_proc()

        parent_env = os.environ.copy()
        parent_env["WORCA_AGENT"] = "planner"
        parent_env["WORCA_STAGE"] = "plan"
        parent_env["WORCA_RUN_ID"] = "old-run"

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
            patch.dict(os.environ, parent_env, clear=False),
        ):
            executor.execute()

        assert "WORCA_AGENT" not in captured_env
        assert "WORCA_STAGE" not in captured_env
        assert "WORCA_RUN_ID" not in captured_env

    def test_preserves_path(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["repo-a"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_env = {}

        def mock_run(cmd, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        assert "PATH" in captured_env


class TestDagExecutorManifestUpdates:
    """Tier status and children are written to workspace manifest."""

    def test_tier_status_updated_to_running_then_completed(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["lib"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        manifest_snapshots = []

        def capture_manifest(m, rd):
            import copy
            manifest_snapshots.append(copy.deepcopy(m))

        with (
            patch("subprocess.run", return_value=_completed_proc()),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest",
                side_effect=capture_manifest,
            ),
        ):
            executor.execute()

        tier_statuses = [s["dag"]["tiers"][0]["status"] for s in manifest_snapshots]
        assert "running" in tier_statuses
        assert tier_statuses[-1] == "completed"

    def test_child_registered_in_manifest(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["lib"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        final_manifest = {}

        def capture_manifest(m, rd):
            final_manifest.update(m)

        with (
            patch(
                "subprocess.run",
                return_value=_completed_proc(run_id="r-abc", worktree_path="/wt/lib"),
            ),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest",
                side_effect=capture_manifest,
            ),
        ):
            executor.execute()

        assert len(final_manifest["children"]) == 1
        child = final_manifest["children"][0]
        assert child["run_id"] == "r-abc"
        assert child["project"] == "lib"
        assert child["status"] == "completed"

    def test_workspace_status_completed_when_all_succeed(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            result = executor.execute()

        assert result["status"] == "completed"

    def test_workspace_status_failed_on_child_failure(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["lib"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_failed_proc()),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            result = executor.execute()

        assert result["status"] == "failed"

    def test_tier_marked_failed_on_child_failure(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["lib"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        manifest_snapshots = []

        def capture_manifest(m, rd):
            import copy
            manifest_snapshots.append(copy.deepcopy(m))

        with (
            patch("subprocess.run", return_value=_failed_proc()),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest",
                side_effect=capture_manifest,
            ),
        ):
            executor.execute()

        final_tier = manifest_snapshots[-1]["dag"]["tiers"][0]
        assert final_tier["status"] == "failed"

    def test_dependent_tier_not_dispatched_on_failure(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        dispatch_count = 0

        def mock_run(cmd, **kwargs):
            nonlocal dispatch_count
            dispatch_count += 1
            return _failed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        assert dispatch_count == 1

    def test_cwd_is_project_path_under_workspace_root(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            workspace_root="/projects",
            tiers=[{"tier": 0, "projects": ["my-lib"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_cwd = []

        def mock_run(cmd, **kwargs):
            captured_cwd.append(kwargs.get("cwd"))
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
        ):
            executor.execute()

        assert captured_cwd == [os.path.join("/projects", "my-lib")]


class TestDagExecutorPreRegisterRunning:
    """Children are pre-registered as 'running' before dispatch so a signal /
    crash mid-tier leaves a manifest trace for resume to find."""

    def test_children_visible_as_running_before_subprocess_returns(self):
        import copy

        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["a", "b"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        snapshots = []

        def capture_manifest(m, rd):
            snapshots.append(copy.deepcopy(m))

        # Inspect the manifest the moment subprocess.run is called — the
        # children entries must already exist with status="running".
        observed_during_dispatch = []

        def mock_run(cmd, **kwargs):
            observed_during_dispatch.append(
                [c.copy() for c in executor._manifest["children"]]
            )
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest",
                side_effect=capture_manifest,
            ),
        ):
            executor.execute()

        for snapshot in observed_during_dispatch:
            statuses = {c["project"]: c["status"] for c in snapshot}
            assert statuses == {"a": "running", "b": "running"}

        final_children = snapshots[-1]["children"]
        assert {c["project"] for c in final_children} == {"a", "b"}
        assert all(c["status"] == "completed" for c in final_children)
        assert len(final_children) == 2  # no duplicates from append + update

    def test_children_updated_not_duplicated_after_dispatch(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["a", "b", "c"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        assert len(manifest["children"]) == 3


class TestDagExecutorMaxParallel:
    """max_parallel caps concurrent children within a tier."""

    def test_max_parallel_passed_to_executor(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            max_parallel=2,
            tiers=[{"tier": 0, "projects": ["a", "b", "c", "d"], "status": "pending"}],
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()),
            patch(
                "worca.scripts.run_workspace.write_workspace_manifest"
            ),
            patch(
                "worca.workspace.dag_executor.ThreadPoolExecutor"
            ) as mock_tpe_cls,
            patch(
                "worca.workspace.dag_executor.as_completed",
                side_effect=lambda fs: list(fs),
            ),
        ):
            mock_tpe = MagicMock()
            mock_tpe.__enter__ = MagicMock(return_value=mock_tpe)
            mock_tpe.__exit__ = MagicMock(return_value=False)
            mock_future = MagicMock()
            mock_future.result.return_value = {"status": "completed", "run_id": "r-1"}
            mock_tpe.submit.return_value = mock_future
            mock_tpe_cls.return_value = mock_tpe

            executor.execute()

        mock_tpe_cls.assert_called_once_with(max_workers=2)


class TestContextInjection:
    """Between-tier context injection: diffs from completed children injected as --guide."""

    def test_context_extracted_from_completed_child_worktree(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        call_idx = [0]

        def mock_run(cmd, **kwargs):
            call_idx[0] += 1
            wt = "/wt/lib" if call_idx[0] == 1 else "/wt/app"
            return _completed_proc(worktree_path=wt)

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch(
                "worca.workspace.dag_executor._extract_project_context",
                return_value="diff stuff",
            ) as mock_extract,
            patch(
                "worca.workspace.dag_executor._write_context_file",
                return_value="/ctx/lib-diff.md",
            ),
        ):
            executor.execute()

        mock_extract.assert_any_call("/wt/lib")

    def test_context_file_written_to_run_dir(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch(
                "subprocess.run",
                return_value=_completed_proc(worktree_path="/wt/lib"),
            ),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch(
                "worca.workspace.dag_executor._extract_project_context",
                return_value="diff content",
            ),
            patch(
                "worca.workspace.dag_executor._write_context_file",
                return_value="/tmp/run-dir/context/lib-diff.md",
            ) as mock_write,
        ):
            executor.execute()

        mock_write.assert_any_call("/tmp/run-dir", "lib", "diff content")

    def test_dependent_child_receives_context_guide(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_cmds = []

        def mock_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            return _completed_proc(worktree_path="/wt/child")

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch(
                "worca.workspace.dag_executor._extract_project_context",
                return_value="ctx",
            ),
            patch(
                "worca.workspace.dag_executor._write_context_file",
                return_value="/ctx/lib-diff.md",
            ),
        ):
            executor.execute()

        tier1_cmd = captured_cmds[1]
        guide_indices = [i for i, v in enumerate(tier1_cmd) if v == "--guide"]
        guide_values = [tier1_cmd[i + 1] for i in guide_indices]
        assert "/ctx/lib-diff.md" in guide_values

    def test_tier_zero_child_has_no_context_guides(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        captured_cmds = []

        def mock_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            return _completed_proc(worktree_path="/wt/child")

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch(
                "worca.workspace.dag_executor._extract_project_context",
                return_value="ctx",
            ),
            patch(
                "worca.workspace.dag_executor._write_context_file",
                return_value="/ctx/lib-diff.md",
            ),
        ):
            executor.execute()

        tier0_cmd = captured_cmds[0]
        guide_indices = [i for i, v in enumerate(tier0_cmd) if v == "--guide"]
        assert len(guide_indices) == 0

    def test_context_only_from_direct_dependencies(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["mid"], "status": "pending"},
                {"tier": 2, "projects": ["top"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "mid": ["lib"], "top": ["mid"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        def mock_write(rd, repo, content):
            return f"/ctx/{repo}-diff.md"

        captured_cmds = []

        def mock_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            return _completed_proc(worktree_path="/wt/child")

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch(
                "worca.workspace.dag_executor._extract_project_context",
                return_value="ctx",
            ),
            patch(
                "worca.workspace.dag_executor._write_context_file",
                side_effect=mock_write,
            ),
        ):
            executor.execute()

        tier2_cmd = captured_cmds[2]
        guide_indices = [i for i, v in enumerate(tier2_cmd) if v == "--guide"]
        guide_values = [tier2_cmd[i + 1] for i in guide_indices]
        assert "/ctx/mid-diff.md" in guide_values
        assert "/ctx/lib-diff.md" not in guide_values


class TestContextTruncation:
    """Context artifacts capped at 8KB per dependency edge."""

    def test_small_diff_not_truncated(self):
        from worca.workspace.dag_executor import _assemble_context

        stat = " file.py | 5 +++++\n 1 file changed, 5 insertions(+)"
        diff = (
            "diff --git a/file.py b/file.py\n"
            "index abc..def 100644\n"
            "--- a/file.py\n"
            "+++ b/file.py\n"
            "@@ -1 +1,5 @@\n"
            "+line1\n+line2\n+line3\n+line4\n+line5"
        )

        result = _assemble_context(stat, diff, cap_bytes=8192)

        assert "truncated" not in result
        assert "+line5" in result

    def test_large_diff_truncated_with_marker(self):
        from worca.workspace.dag_executor import _assemble_context

        stat = " big.py | 1000 +++\n 1 file changed"
        lines = [f"+line{i}" for i in range(200)]
        diff = (
            "diff --git a/big.py b/big.py\n"
            "index abc..def 100644\n"
            "--- a/big.py\n"
            "+++ b/big.py\n"
            "@@ -0,0 +1,200 @@\n" + "\n".join(lines)
        )

        result = _assemble_context(stat, diff, cap_bytes=500)

        assert "truncated" in result.lower()
        assert "lines remaining" in result

    def test_stat_always_included(self):
        from worca.workspace.dag_executor import _assemble_context

        stat = " big.py | 1000 +++\n 1 file changed"
        lines = [f"+line{i}" for i in range(200)]
        diff = (
            "diff --git a/big.py b/big.py\n"
            "index abc..def 100644\n"
            "--- a/big.py\n"
            "+++ b/big.py\n"
            "@@ -0,0 +1,200 @@\n" + "\n".join(lines)
        )

        result = _assemble_context(stat, diff, cap_bytes=500)

        assert "1 file changed" in result

    def test_api_surface_files_prioritized(self):
        from worca.workspace.dag_executor import _assemble_context

        stat = " 2 files changed"
        internal_diff = (
            "diff --git a/src/internal/helper.py b/src/internal/helper.py\n"
            "index abc..def 100644\n"
            "--- a/src/internal/helper.py\n"
            "+++ b/src/internal/helper.py\n"
            "@@ -1 +1,2 @@\n"
            "+internal change"
        )
        api_diff = (
            "diff --git a/src/api/routes.py b/src/api/routes.py\n"
            "index abc..def 100644\n"
            "--- a/src/api/routes.py\n"
            "+++ b/src/api/routes.py\n"
            "@@ -1 +1,2 @@\n"
            "+api change"
        )
        full_diff = internal_diff + "\n" + api_diff

        result = _assemble_context(stat, full_diff, cap_bytes=8192)

        api_pos = result.find("src/api/routes.py")
        internal_pos = result.find("src/internal/helper.py")
        assert api_pos < internal_pos

    def test_truncation_marker_shows_remaining_count(self):
        import re
        from worca.workspace.dag_executor import _assemble_context

        stat = " file.py | 10 +\n"
        diff_lines = [
            "diff --git a/file.py b/file.py",
            "index abc..def 100644",
            "--- a/file.py",
            "+++ b/file.py",
            "@@ -1 +1,100 @@",
        ]
        diff_lines.extend(f"+line{i}" for i in range(100))
        diff = "\n".join(diff_lines)

        result = _assemble_context(stat, diff, cap_bytes=300)

        match = re.search(r"\[truncated — (\d+) lines remaining\]", result)
        assert match is not None, f"Expected truncation marker in: {result!r}"
        remaining = int(match.group(1))
        assert remaining > 0


class TestFailurePropagationBlockedOnFailure:
    """When a child in tier N fails, dependent children in tier N+1 are marked 'blocked'."""

    def test_dependent_child_blocked_when_dependency_fails(self):
        """app depends on lib; lib fails → app marked blocked, never dispatched."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        dispatched_repos = []

        def mock_run(cmd, **kwargs):
            dispatched_repos.append(kwargs.get("cwd"))
            return _failed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        assert os.path.join("/workspace", "lib") in dispatched_repos
        assert os.path.join("/workspace", "app") not in dispatched_repos

        blocked = [c for c in manifest["children"] if c["status"] == "blocked"]
        assert len(blocked) == 1
        assert blocked[0]["project"] == "app"

    def test_blocked_child_has_null_run_id_and_worktree(self):
        """Blocked children have no run_id or worktree_path."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_failed_proc()),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        blocked = [c for c in manifest["children"] if c["status"] == "blocked"]
        assert blocked[0]["run_id"] is None
        assert blocked[0]["worktree_path"] is None

    def test_transitive_dependents_blocked(self):
        """lib fails → mid (depends on lib) blocked → top (depends on mid) also blocked."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["mid"], "status": "pending"},
                {"tier": 2, "projects": ["top"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "mid": ["lib"], "top": ["mid"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_failed_proc()),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        blocked = {c["project"] for c in manifest["children"] if c["status"] == "blocked"}
        assert blocked == {"mid", "top"}

    def test_multiple_deps_one_fails_child_blocked(self):
        """app depends on [lib, svc]; lib fails → app blocked even though svc completed."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib", "svc"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "svc": [], "app": ["lib", "svc"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        def mock_run(cmd, **kwargs):
            cwd = kwargs.get("cwd", "")
            if os.path.basename(cwd) == "lib":
                return _failed_proc()
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        blocked = [c for c in manifest["children"] if c["status"] == "blocked"]
        assert len(blocked) == 1
        assert blocked[0]["project"] == "app"

    def test_workspace_status_failed_when_any_blocked(self):
        """Workspace overall status is 'failed' when there are blocked children."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_failed_proc()),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "failed"


class TestFailurePropagationNonDependentContinues:
    """When a child in tier N fails, non-dependent children in tier N+1 still run."""

    def test_non_dependent_child_runs_when_sibling_dep_fails(self):
        """lib fails; app depends on lib (blocked), svc has no deps (runs)."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["app", "svc"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "app": ["lib"], "svc": []},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        dispatched = []

        def mock_run(cmd, **kwargs):
            cwd = kwargs.get("cwd", "")
            dispatched.append(cwd)
            if os.path.basename(cwd) == "lib":
                return _failed_proc()
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        assert os.path.join("/workspace", "svc") in dispatched
        assert os.path.join("/workspace", "app") not in dispatched

        statuses = {c["project"]: c["status"] for c in manifest["children"]}
        assert statuses["app"] == "blocked"
        assert statuses["svc"] == "completed"

    def test_tier_with_mix_of_blocked_and_running(self):
        """Tier 1 has 3 repos: 2 depend on failed lib, 1 independent — only 1 dispatched."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib"], "status": "pending"},
                {"tier": 1, "projects": ["api", "web", "docs"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "api": ["lib"], "web": ["lib"], "docs": []},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        dispatched = []

        def mock_run(cmd, **kwargs):
            cwd = kwargs.get("cwd", "")
            dispatched.append(cwd)
            if os.path.basename(cwd) == "lib":
                return _failed_proc()
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        dispatched_repos = [os.path.basename(d) for d in dispatched]
        assert "lib" in dispatched_repos
        assert "docs" in dispatched_repos
        assert "api" not in dispatched_repos
        assert "web" not in dispatched_repos

    def test_all_tier_children_run_when_no_deps_on_failed(self):
        """Tier 0 has 2 repos; one fails. Tier 1 children don't depend on the failed one."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib", "config"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "config": [], "app": ["config"]},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        dispatched = []

        def mock_run(cmd, **kwargs):
            cwd = kwargs.get("cwd", "")
            dispatched.append(cwd)
            if os.path.basename(cwd) == "lib":
                return _failed_proc()
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        dispatched_repos = [os.path.basename(d) for d in dispatched]
        assert "app" in dispatched_repos

        statuses = {c["project"]: c["status"] for c in manifest["children"]}
        assert statuses["app"] == "completed"

    def test_context_injection_skips_failed_projects(self):
        """Context extraction only runs for completed repos, not failed ones."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib", "config"], "status": "pending"},
                {"tier": 1, "projects": ["app", "svc"], "status": "pending"},
            ],
            dependency_graph={
                "lib": [], "config": [], "app": ["config"], "svc": ["lib"],
            },
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        def mock_run(cmd, **kwargs):
            cwd = kwargs.get("cwd", "")
            if os.path.basename(cwd) == "lib":
                return _failed_proc()
            return _completed_proc(worktree_path="/wt/child")

        extract_calls = []

        def mock_extract(wt):
            extract_calls.append(wt)
            return "ctx"

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch(
                "worca.workspace.dag_executor._extract_project_context",
                side_effect=mock_extract,
            ),
            patch(
                "worca.workspace.dag_executor._write_context_file",
                return_value="/ctx/file.md",
            ),
        ):
            executor.execute()

        assert "/wt/child" in extract_calls


class TestDagCircuitBreaker:
    """W-040 circuit breaker integrated across all DAG tiers."""

    def test_circuit_breaker_halts_workspace_on_threshold(self):
        """When failure ratio crosses threshold, workspace is halted."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["a", "b", "c", "d"], "status": "pending"},
                {"tier": 1, "projects": ["e"], "status": "pending"},
            ],
            dependency_graph={"a": [], "b": [], "c": [], "d": [], "e": []},
        )
        manifest["failure_threshold"] = 0.30
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        def mock_run(cmd, **kwargs):
            return _failed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "halted"
        assert manifest.get("halt_reason") == "circuit_breaker"

    def test_circuit_breaker_requires_min_terminal(self):
        """Breaker doesn't fire until min(3, total) children are terminal."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["a", "b", "c", "d", "e"], "status": "pending"},
            ],
            dependency_graph={"a": [], "b": [], "c": [], "d": [], "e": []},
        )
        manifest["failure_threshold"] = 0.30
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        call_count = [0]

        def mock_run(cmd, **kwargs):
            call_count[0] += 1
            if call_count[0] <= 2:
                return _failed_proc()
            return _completed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        assert call_count[0] == 5

    def test_circuit_breaker_fires_across_tiers(self):
        """Circuit breaker accumulates failures from all tiers."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["a", "b"], "status": "pending"},
                {"tier": 1, "projects": ["c", "d"], "status": "pending"},
            ],
            dependency_graph={"a": [], "b": [], "c": [], "d": []},
        )
        manifest["failure_threshold"] = 0.50
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        def mock_run(cmd, **kwargs):
            return _failed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "halted"

    def test_circuit_breaker_halts_remaining_tiers(self):
        """After breaker fires, remaining tiers are not dispatched; children marked halted."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["a", "b", "c"], "status": "pending"},
                {"tier": 1, "projects": ["d"], "status": "pending"},
            ],
            dependency_graph={"a": [], "b": [], "c": [], "d": []},
        )
        manifest["failure_threshold"] = 0.30
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        dispatched = []

        def mock_run(cmd, **kwargs):
            dispatched.append(kwargs.get("cwd"))
            return _failed_proc()

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        dispatched_repos = [os.path.basename(d) for d in dispatched]
        assert "d" not in dispatched_repos

        halted = [c for c in manifest["children"] if c["status"] == "halted"]
        assert any(c["project"] == "d" for c in halted)

    def test_no_circuit_breaker_when_threshold_not_set(self):
        """Without failure_threshold, circuit breaker is not active."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["a", "b", "c"], "status": "pending"},
            ],
            dependency_graph={"a": [], "b": [], "c": []},
        )
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_failed_proc()),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "failed"
        assert manifest.get("halt_reason") is None

    def test_circuit_breaker_small_workspace_min_adapts(self):
        """For workspace with 2 total repos, min(3, 2)=2 — breaker fires when both fail."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["a", "b"], "status": "pending"},
            ],
            dependency_graph={"a": [], "b": []},
        )
        manifest["failure_threshold"] = 0.50
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_failed_proc()),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "halted"
        assert manifest.get("halt_reason") == "circuit_breaker"


class TestDagExecutorPlanSkip:
    """Projects marked skip in the workspace plan are not dispatched (master/existing modes)."""

    def test_master_plan_skips_projects_without_plan(self):
        """In master plan mode, projects absent from project_plans are skipped."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["es", "hippo", "kafka"], "status": "pending"}],
            dependency_graph={"es": [], "hippo": [], "kafka": []},
            project_plans={"es": "/plans/es.md"},
        )
        manifest["plan_mode"] = "master"
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()) as mock_run,
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "completed"
        # Only one subprocess call — for "es"
        assert mock_run.call_count == 1
        call_args = mock_run.call_args[0][0]
        assert any("es" in str(a) for a in call_args)

    def test_existing_plan_skips_projects_without_plan(self):
        """'existing' plan mode behaves the same as 'master' for skip logic."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["es", "hippo"], "status": "pending"}],
            dependency_graph={"es": [], "hippo": []},
            project_plans={"es": "/plans/es.md"},
        )
        manifest["plan_mode"] = "existing"
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()) as mock_run,
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "completed"
        assert mock_run.call_count == 1

    def test_per_repo_mode_dispatches_all_projects(self):
        """per-repo mode dispatches every project regardless of project_plans."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["es", "hippo"], "status": "pending"}],
            dependency_graph={"es": [], "hippo": []},
            project_plans={"es": "/plans/es.md"},
        )
        manifest["plan_mode"] = "per-repo"
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()) as mock_run,
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "completed"
        assert mock_run.call_count == 2

    def test_independent_mode_dispatches_all_projects(self):
        """independent mode dispatches every project regardless of project_plans."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[{"tier": 0, "projects": ["es", "hippo"], "status": "pending"}],
            dependency_graph={"es": [], "hippo": []},
            project_plans={"es": "/plans/es.md"},
        )
        manifest["plan_mode"] = "independent"
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()) as mock_run,
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "completed"
        assert mock_run.call_count == 2

    def test_skipped_project_does_not_block_downstream_tier(self):
        """A skipped tier-0 project counts as completed so tier-1 dependents proceed."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _make_manifest(
            tiers=[
                {"tier": 0, "projects": ["lib", "utils"], "status": "pending"},
                {"tier": 1, "projects": ["app"], "status": "pending"},
            ],
            dependency_graph={"lib": [], "utils": [], "app": ["lib", "utils"]},
            project_plans={"lib": "/plans/lib.md", "app": "/plans/app.md"},
        )
        manifest["plan_mode"] = "master"
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        with (
            patch("subprocess.run", return_value=_completed_proc()) as mock_run,
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch(
                "worca.workspace.dag_executor._extract_project_context",
                return_value="diff stuff",
            ),
            patch(
                "worca.workspace.dag_executor._write_context_file",
                return_value="/ctx/lib-diff.md",
            ),
        ):
            result = executor.execute()

        assert result["status"] == "completed"
        # 2 calls: lib (tier 0) + app (tier 1). utils skipped.
        assert mock_run.call_count == 2
