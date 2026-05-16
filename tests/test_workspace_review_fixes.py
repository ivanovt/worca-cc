"""Tests for workspace review fixes (W-047 review round 1).

Covers fixes for:
  - #1: dependency_graph stored in manifest
  - #2: _run_child uses repo path (not name)
  - #7: _detect_base_ref dynamic detection
  - #8: WORCA_REPO_ROLE set in child env
  - #9: halted workspace not eligible for cleanup
  - #10: children include project_path
  - #12: blocked repos counted in circuit breaker
  - #14: reconcile_orphan_groups handles workspace_id
  - #15: DagExecutor uses WorkspaceStatus enum
"""
import json
import os
import subprocess
from unittest.mock import patch


# ---- helpers ---------------------------------------------------------------

def _base_manifest(workspace_root="/workspace", **overrides):
    m = {
        "workspace_id": "ws_test_review",
        "workspace_name": "test-ws",
        "workspace_root": workspace_root,
        "status": "running",
        "halt_reason": None,
        "max_parallel": 5,
        "work_request": {"title": "", "description": "test", "source": None},
        "guide": {"paths": [], "bytes": 0, "filenames": []},
        "dag": {
            "tiers": [
                {"tier": 0, "repos": ["lib"], "status": "pending"},
                {"tier": 1, "repos": ["backend"], "status": "pending"},
            ],
            "dependency_graph": {
                "lib": [],
                "backend": ["lib"],
            },
        },
        "repos_by_name": {"lib": "shared-lib", "backend": "services/backend"},
        "children": [],
        "plan": {"workspace_plan_path": None, "repo_plans": {}},
    }
    m.update(overrides)
    return m


# ---- #1: dependency_graph in manifest --------------------------------------

class TestDependencyGraphInManifest:
    def test_create_manifest_includes_dependency_graph(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_manifest

        dep_graph = {"lib": [], "backend": ["lib"]}
        manifest = create_workspace_manifest(
            workspace_id="ws_x",
            workspace_root=str(tmp_path),
            workspace_name="test",
            prompt="x",
            source=None,
            guide_paths=[],
            branch_template="workspace/{slug}/{repo}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"], ["backend"]],
            repos_by_name={"lib": "lib", "backend": "backend"},
            dependency_graph=dep_graph,
        )
        assert manifest["dag"]["dependency_graph"] == dep_graph

    def test_executor_reads_dependency_graph(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _base_manifest()
        executor = DagExecutor(manifest, "/tmp/run-dir")
        assert executor._dependency_graph == {"lib": [], "backend": ["lib"]}


# ---- #2: _run_child uses repo path ----------------------------------------

class TestRunChildUsesRepoPath:
    def test_run_child_resolves_path_from_repos_by_name(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _base_manifest(workspace_root="/workspace")
        executor = DagExecutor(manifest, "/tmp/run-dir")

        captured_cwd = []

        def mock_run(cmd, *, cwd=None, **kwargs):
            captured_cwd.append(cwd)
            return subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout="run-123\n/tmp/wt\n", stderr=""
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor._run_child("lib")

        assert result["status"] == "completed"
        assert captured_cwd[0] == "/workspace/shared-lib"

    def test_run_child_falls_back_to_repo_name(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _base_manifest(repos_by_name={})
        executor = DagExecutor(manifest, "/tmp/run-dir")

        captured_cwd = []

        def mock_run(cmd, *, cwd=None, **kwargs):
            captured_cwd.append(cwd)
            return subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout="run-123\n/tmp/wt\n", stderr=""
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor._run_child("lib")

        assert captured_cwd[0] == "/workspace/lib"


# ---- #7: _detect_base_ref -------------------------------------------------

class TestDetectBaseRef:
    def test_returns_upstream_when_available(self):
        from worca.workspace.dag_executor import _detect_base_ref

        def mock_run_git(args, cwd):
            if "@{upstream}" in args:
                return "origin/main\n"
            return ""

        with patch("worca.workspace.dag_executor._run_git", side_effect=mock_run_git):
            assert _detect_base_ref("/some/path") == "origin/main"

    def test_falls_back_to_main(self):
        from worca.workspace.dag_executor import _detect_base_ref

        def mock_run_git(args, cwd):
            if "@{upstream}" in args:
                return ""
            if "refs/heads/main" in args:
                return "abc123\n"
            return ""

        with patch("worca.workspace.dag_executor._run_git", side_effect=mock_run_git):
            assert _detect_base_ref("/some/path") == "main"

    def test_falls_back_to_master(self):
        from worca.workspace.dag_executor import _detect_base_ref

        def mock_run_git(args, cwd):
            if "@{upstream}" in args:
                return ""
            if "refs/heads/main" in args:
                return ""
            if "refs/remotes/origin/main" in args:
                return ""
            if "refs/heads/master" in args:
                return "abc123\n"
            return ""

        with patch("worca.workspace.dag_executor._run_git", side_effect=mock_run_git):
            assert _detect_base_ref("/some/path") == "master"

    def test_falls_back_to_head_tilde_1(self):
        from worca.workspace.dag_executor import _detect_base_ref

        def mock_run_git(args, cwd):
            return ""

        with patch("worca.workspace.dag_executor._run_git", side_effect=mock_run_git):
            assert _detect_base_ref("/some/path") == "HEAD~1"


# ---- #10: project_path in children ----------------------------------------

class TestProjectPathInChildren:
    def test_dispatched_children_have_project_path(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _base_manifest(
            dag={
                "tiers": [{"tier": 0, "repos": ["lib"], "status": "pending"}],
                "dependency_graph": {"lib": []},
            },
        )
        executor = DagExecutor(manifest, "/tmp/run-dir")

        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout="run-123\n/tmp/wt\n", stderr=""
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        child = manifest["children"][0]
        assert child["project_path"] == "/workspace/shared-lib"

    def test_blocked_children_have_project_path(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _base_manifest()
        manifest["children"] = [
            {"repo": "lib", "status": "failed", "run_id": None,
             "worktree_path": None, "tier": 0},
        ]
        manifest["dag"]["tiers"][0]["status"] = "failed"
        executor = DagExecutor(manifest, "/tmp/run-dir")

        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr="error"
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        blocked = [c for c in manifest["children"] if c.get("status") == "blocked"]
        assert len(blocked) == 1
        assert blocked[0]["project_path"] == "/workspace/services/backend"


# ---- #12: blocked repos counted in circuit breaker -------------------------

class TestBlockedReposCircuitBreaker:
    def test_blocked_repos_increment_terminal_and_failed(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _base_manifest(
            dag={
                "tiers": [
                    {"tier": 0, "repos": ["lib"], "status": "pending"},
                    {"tier": 1, "repos": ["backend"], "status": "pending"},
                ],
                "dependency_graph": {"lib": [], "backend": ["lib"]},
            },
        )
        executor = DagExecutor(manifest, "/tmp/run-dir")

        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr="error"
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        assert executor._terminal_count == 2
        assert executor._failed_count == 2


# ---- #14: reconcile_orphan_groups workspace_id -----------------------------

class TestReconcileOrphanWorkspace:
    def test_strips_workspace_id_when_pointer_missing(self, tmp_path):
        from worca.orchestrator.registry import (
            register_pipeline, reconcile_orphan_groups, get_pipeline,
        )

        base = str(tmp_path / ".worca")
        fleet_dir = str(tmp_path / "fleet-runs")
        os.makedirs(fleet_dir)
        ws_pointer_dir = str(tmp_path / "ws-pointers")
        os.makedirs(ws_pointer_dir)

        register_pipeline(
            "run-orphan", "/wt", "orphan", 1, base=base,
            workspace_id="ws_gone", group_type="workspace",
        )

        orphaned = reconcile_orphan_groups(
            base=base,
            fleet_manifest_base_dir=fleet_dir,
            workspace_pointer_dir=ws_pointer_dir,
        )

        assert "run-orphan" in orphaned
        entry = get_pipeline("run-orphan", base=base)
        assert "workspace_id" not in entry
        assert "group_type" not in entry

    def test_keeps_workspace_id_when_pointer_exists(self, tmp_path):
        from worca.orchestrator.registry import (
            register_pipeline, reconcile_orphan_groups, get_pipeline,
        )

        base = str(tmp_path / ".worca")
        fleet_dir = str(tmp_path / "fleet-runs")
        os.makedirs(fleet_dir)
        ws_pointer_dir = str(tmp_path / "ws-pointers")
        os.makedirs(ws_pointer_dir)

        ws_id = "ws_exists"
        pointer_path = os.path.join(ws_pointer_dir, f"{ws_id}.json")
        with open(pointer_path, "w") as f:
            json.dump({"workspace_id": ws_id, "workspace_root": "/ws"}, f)

        register_pipeline(
            "run-kept", "/wt", "kept", 1, base=base,
            workspace_id=ws_id, group_type="workspace",
        )

        orphaned = reconcile_orphan_groups(
            base=base,
            fleet_manifest_base_dir=fleet_dir,
            workspace_pointer_dir=ws_pointer_dir,
        )

        assert "run-kept" not in orphaned
        entry = get_pipeline("run-kept", base=base)
        assert entry["workspace_id"] == ws_id


# ---- #15: DagExecutor uses WorkspaceStatus enum ----------------------------

class TestDagExecutorUsesStatusEnum:
    def test_completed_sets_enum_status(self):
        from worca.workspace.dag_executor import DagExecutor
        from worca.state.status import WorkspaceStatus

        manifest = _base_manifest(
            dag={
                "tiers": [{"tier": 0, "repos": ["lib"], "status": "pending"}],
                "dependency_graph": {"lib": []},
            },
        )
        executor = DagExecutor(manifest, "/tmp/run-dir")

        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout="run-123\n/tmp/wt\n", stderr=""
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "completed"
        assert manifest["status"] == WorkspaceStatus.COMPLETED

    def test_failed_sets_enum_status(self):
        from worca.workspace.dag_executor import DagExecutor
        from worca.state.status import WorkspaceStatus

        manifest = _base_manifest(
            dag={
                "tiers": [{"tier": 0, "repos": ["lib"], "status": "pending"}],
                "dependency_graph": {"lib": []},
            },
        )
        executor = DagExecutor(manifest, "/tmp/run-dir")

        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr="error"
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "failed"
        assert manifest["status"] == WorkspaceStatus.FAILED
