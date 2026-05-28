"""Workspace CRG per-project enablement (W-057 §11, Phase 4).

Each workspace child pipeline resolves CRG config independently.
crg_status is recorded on child entries in the workspace manifest.
No cross-project CRG sharing in v1.
"""

import json
import os


from worca.orchestrator.fleet_manifest import (
    GRAPH_STATUS_DEGRADED,
    GRAPH_STATUS_DISABLED,
    GRAPH_STATUS_READY,
)


# ---------------------------------------------------------------------------
# DagExecutor records crg_status on child entries
# ---------------------------------------------------------------------------


class TestDagExecutorCrgStatus:
    """DagExecutor detects per-project CRG status and records it on children."""

    def _make_project(self, tmp_path, name, crg_enabled=False):
        project_dir = tmp_path / "workspace" / name
        settings_dir = project_dir / ".claude"
        settings_dir.mkdir(parents=True)
        settings = {"worca": {}}
        if crg_enabled:
            settings["worca"]["code_review_graph"] = {"enabled": True}
        (settings_dir / "settings.json").write_text(json.dumps(settings))
        return project_dir

    def _make_manifest(self, tmp_path, projects_by_name, tiers=None):
        workspace_root = str(tmp_path / "workspace")
        if tiers is None:
            tiers = [list(projects_by_name.keys())]
        dag_tiers = [
            {"tier": i, "projects": tier_projects, "status": "pending"}
            for i, tier_projects in enumerate(tiers)
        ]
        return {
            "workspace_id": "ws-test",
            "workspace_name": "test-workspace",
            "workspace_root": workspace_root,
            "created_at": "2026-05-28T00:00:00+00:00",
            "work_request": {"title": "", "description": "test prompt", "source": None},
            "guide": {"paths": [], "bytes": 0, "filenames": []},
            "branch_template": "ws/{name}",
            "max_parallel": 5,
            "skip_integration": True,
            "skip_planning": True,
            "status": "running",
            "halt_reason": None,
            "dag": {"tiers": dag_tiers, "dependency_graph": {}},
            "projects_by_name": projects_by_name,
            "failure_threshold": None,
            "children": [],
            "integration_test": {"status": "pending", "exit_code": None, "log_path": None},
        }

    def test_crg_status_recorded_on_child_entry(self, tmp_path, monkeypatch):
        """When a project has CRG enabled and tools available, child gets crg_status=ready."""
        from worca.workspace.dag_executor import DagExecutor

        self._make_project(tmp_path, "alpha", crg_enabled=True)
        manifest = self._make_manifest(tmp_path, {"alpha": "alpha"})
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        monkeypatch.setattr(
            "worca.workspace.dag_executor.detect_child_crg_status",
            lambda project_dir: GRAPH_STATUS_READY,
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._run_child",
            lambda self, project: {
                "status": "completed", "run_id": "run-001", "worktree_path": "/tmp/wt",
            },
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._write_manifest",
            lambda self: None,
        )

        executor = DagExecutor(manifest, run_dir)
        executor.execute()

        children = manifest["children"]
        assert len(children) >= 1
        running_children = [c for c in children if c["project"] == "alpha"]
        assert any(c.get("crg_status") == GRAPH_STATUS_READY for c in running_children)

    def test_crg_disabled_when_not_configured(self, tmp_path, monkeypatch):
        """A project without CRG config gets crg_status=disabled."""
        from worca.workspace.dag_executor import DagExecutor

        self._make_project(tmp_path, "beta", crg_enabled=False)
        manifest = self._make_manifest(tmp_path, {"beta": "beta"})
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        monkeypatch.setattr(
            "worca.workspace.dag_executor.detect_child_crg_status",
            lambda project_dir: GRAPH_STATUS_DISABLED,
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._run_child",
            lambda self, project: {
                "status": "completed", "run_id": "run-002", "worktree_path": "/tmp/wt2",
            },
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._write_manifest",
            lambda self: None,
        )

        executor = DagExecutor(manifest, run_dir)
        executor.execute()

        children = manifest["children"]
        running_children = [c for c in children if c["project"] == "beta"]
        assert any(c.get("crg_status") == GRAPH_STATUS_DISABLED for c in running_children)

    def test_crg_degraded_when_cli_missing(self, tmp_path, monkeypatch):
        """CRG enabled but CLI not available → crg_status=degraded."""
        from worca.workspace.dag_executor import DagExecutor

        self._make_project(tmp_path, "gamma", crg_enabled=True)
        manifest = self._make_manifest(tmp_path, {"gamma": "gamma"})
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        monkeypatch.setattr(
            "worca.workspace.dag_executor.detect_child_crg_status",
            lambda project_dir: GRAPH_STATUS_DEGRADED,
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._run_child",
            lambda self, project: {
                "status": "completed", "run_id": "run-003", "worktree_path": "/tmp/wt3",
            },
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._write_manifest",
            lambda self: None,
        )

        executor = DagExecutor(manifest, run_dir)
        executor.execute()

        children = manifest["children"]
        running_children = [c for c in children if c["project"] == "gamma"]
        assert any(c.get("crg_status") == GRAPH_STATUS_DEGRADED for c in running_children)

    def test_mixed_crg_statuses_across_projects(self, tmp_path, monkeypatch):
        """Different projects can have different CRG statuses."""
        from worca.workspace.dag_executor import DagExecutor

        self._make_project(tmp_path, "proj-a", crg_enabled=True)
        self._make_project(tmp_path, "proj-b", crg_enabled=False)
        manifest = self._make_manifest(
            tmp_path,
            {"proj-a": "proj-a", "proj-b": "proj-b"},
        )
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        status_map = {
            "proj-a": GRAPH_STATUS_READY,
            "proj-b": GRAPH_STATUS_DISABLED,
        }

        def mock_detect(project_dir):
            name = os.path.basename(project_dir)
            return status_map.get(name, GRAPH_STATUS_DISABLED)

        monkeypatch.setattr(
            "worca.workspace.dag_executor.detect_child_crg_status",
            mock_detect,
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._run_child",
            lambda self, project: {
                "status": "completed", "run_id": f"run-{project}", "worktree_path": f"/tmp/{project}",
            },
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._write_manifest",
            lambda self: None,
        )

        executor = DagExecutor(manifest, run_dir)
        executor.execute()

        children_by_name = {}
        for c in manifest["children"]:
            children_by_name[c["project"]] = c

        assert children_by_name["proj-a"]["crg_status"] == GRAPH_STATUS_READY
        assert children_by_name["proj-b"]["crg_status"] == GRAPH_STATUS_DISABLED

    def test_blocked_children_get_crg_status(self, tmp_path, monkeypatch):
        """Even blocked children (due to failed deps) record crg_status."""
        from worca.workspace.dag_executor import DagExecutor

        self._make_project(tmp_path, "dep", crg_enabled=False)
        self._make_project(tmp_path, "child", crg_enabled=True)
        manifest = self._make_manifest(
            tmp_path,
            {"dep": "dep", "child": "child"},
            tiers=[["dep"], ["child"]],
        )
        manifest["dag"]["dependency_graph"] = {"child": ["dep"]}
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        status_map = {
            "dep": GRAPH_STATUS_DISABLED,
            "child": GRAPH_STATUS_READY,
        }

        def mock_detect(project_dir):
            name = os.path.basename(project_dir)
            return status_map.get(name, GRAPH_STATUS_DISABLED)

        monkeypatch.setattr(
            "worca.workspace.dag_executor.detect_child_crg_status",
            mock_detect,
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._run_child",
            lambda self, project: {
                "status": "failed", "run_id": None, "worktree_path": None,
            },
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._write_manifest",
            lambda self: None,
        )

        executor = DagExecutor(manifest, run_dir)
        executor.execute()

        children_by_name = {}
        for c in manifest["children"]:
            children_by_name[c["project"]] = c

        assert children_by_name["dep"]["crg_status"] == GRAPH_STATUS_DISABLED
        assert children_by_name["child"]["crg_status"] == GRAPH_STATUS_READY
        assert children_by_name["child"]["status"] == "blocked"

    def test_crg_detection_never_crashes_executor(self, tmp_path, monkeypatch):
        """If CRG detection raises, executor still runs (status defaults to disabled)."""
        from worca.workspace.dag_executor import DagExecutor

        self._make_project(tmp_path, "delta", crg_enabled=True)
        manifest = self._make_manifest(tmp_path, {"delta": "delta"})
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir, exist_ok=True)

        def exploding_detect(project_dir):
            raise RuntimeError("CRG detection exploded")

        monkeypatch.setattr(
            "worca.workspace.dag_executor.detect_child_crg_status",
            exploding_detect,
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._run_child",
            lambda self, project: {
                "status": "completed", "run_id": "run-004", "worktree_path": "/tmp/wt4",
            },
        )
        monkeypatch.setattr(
            "worca.workspace.dag_executor.DagExecutor._write_manifest",
            lambda self: None,
        )

        executor = DagExecutor(manifest, run_dir)
        result = executor.execute()

        assert result["status"] == "completed"
        children = manifest["children"]
        running_children = [c for c in children if c["project"] == "delta"]
        assert any(c.get("crg_status") == GRAPH_STATUS_DISABLED for c in running_children)
