"""Tests for workspace halt with halt_reason tracking (W-047 §7 + §10.5)."""
import json
import os
import tempfile


from worca.state.status import WorkspaceStatus


def _make_manifest(
    *,
    workspace_id="ws_202605150000_aabb1122",
    workspace_name="test-workspace",
    workspace_root="/workspace",
    status=WorkspaceStatus.RUNNING,
    halt_reason=None,
    tiers=None,
    children=None,
):
    if tiers is None:
        tiers = [
            {"tier": 0, "projects": ["lib"], "status": "running"},
            {"tier": 1, "projects": ["backend", "frontend"], "status": "pending"},
        ]
    return {
        "workspace_id": workspace_id,
        "workspace_name": workspace_name,
        "workspace_root": workspace_root,
        "status": status,
        "halt_reason": halt_reason,
        "max_parallel": 5,
        "work_request": {"title": "", "description": "Apply migration", "source": None},
        "guide": {"paths": [], "bytes": 0, "filenames": []},
        "branch_template": "workspace/{slug}/{repo}",
        "dag": {"tiers": tiers, "dependency_graph": {}},
        "children": children or [],
        "plan": {"workspace_plan_path": None, "project_plans": {}},
        "integration_test": {"status": "pending", "exit_code": None, "log_path": None},
    }


def _write_manifest_to_disk(manifest, tmp_dir):
    """Write manifest files (pointer + manifest) so halt_workspace can find them."""
    ws_id = manifest["workspace_id"]
    ws_root = manifest["workspace_root"]

    run_dir = os.path.join(ws_root, ".worca", "workspace-runs", ws_id)
    os.makedirs(run_dir, exist_ok=True)

    manifest_path = os.path.join(run_dir, "workspace-manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    pointer_dir = os.path.join(tmp_dir, "pointers")
    os.makedirs(pointer_dir, exist_ok=True)
    pointer_path = os.path.join(pointer_dir, f"{ws_id}.json")
    with open(pointer_path, "w") as f:
        json.dump({"workspace_root": ws_root, "workspace_id": ws_id}, f)

    return run_dir, pointer_dir


def _read_manifest_from_disk(ws_root, ws_id):
    path = os.path.join(
        ws_root, ".worca", "workspace-runs", ws_id, "workspace-manifest.json",
    )
    with open(path) as f:
        return json.load(f)


class TestHaltReasonUser:
    """Manual halt via halt_workspace sets halt_reason='user'."""

    def test_halt_sets_status_halted(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(workspace_root=ws_root)
            run_dir, pointer_dir = _write_manifest_to_disk(manifest, tmp)

            result = halt_workspace(
                manifest["workspace_id"], pointer_dir=pointer_dir,
            )

            assert result is True
            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            assert saved["status"] == WorkspaceStatus.HALTED

    def test_halt_sets_halt_reason_user(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(workspace_root=ws_root)
            _write_manifest_to_disk(manifest, tmp)

            halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )

            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            assert saved["halt_reason"] == "user"

    def test_halt_marks_pending_tiers_as_halted(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                tiers=[
                    {"tier": 0, "projects": ["lib"], "status": "running"},
                    {"tier": 1, "projects": ["app"], "status": "pending"},
                    {"tier": 2, "projects": ["web"], "status": "pending"},
                ],
            )
            _write_manifest_to_disk(manifest, tmp)

            halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )

            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            assert saved["dag"]["tiers"][1]["status"] == "halted"
            assert saved["dag"]["tiers"][2]["status"] == "halted"

    def test_halt_preserves_running_tier_status(self):
        """In-flight tier children finish naturally — running tier stays 'running'."""
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                tiers=[
                    {"tier": 0, "projects": ["lib"], "status": "running"},
                    {"tier": 1, "projects": ["app"], "status": "pending"},
                ],
            )
            _write_manifest_to_disk(manifest, tmp)

            halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )

            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            assert saved["dag"]["tiers"][0]["status"] == "running"

    def test_halt_adds_halted_children_for_pending_tiers(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                tiers=[
                    {"tier": 0, "projects": ["lib"], "status": "running"},
                    {"tier": 1, "projects": ["app", "web"], "status": "pending"},
                ],
                children=[
                    {"project": "lib", "run_id": "r-1", "worktree_path": "/wt/lib",
                     "status": "running", "tier": 0},
                ],
            )
            _write_manifest_to_disk(manifest, tmp)

            halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )

            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            halted_children = [
                c for c in saved["children"] if c["status"] == "halted"
            ]
            halted_repos = {c["project"] for c in halted_children}
            assert halted_repos == {"app", "web"}
            for c in halted_children:
                assert c["run_id"] is None
                assert c["worktree_path"] is None

    def test_halt_preserves_existing_children(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                tiers=[
                    {"tier": 0, "projects": ["lib"], "status": "completed"},
                    {"tier": 1, "projects": ["app"], "status": "pending"},
                ],
                children=[
                    {"project": "lib", "run_id": "r-1", "worktree_path": "/wt/lib",
                     "status": "completed", "tier": 0},
                ],
            )
            _write_manifest_to_disk(manifest, tmp)

            halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )

            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            lib_child = next(c for c in saved["children"] if c["project"] == "lib")
            assert lib_child["status"] == "completed"
            assert lib_child["run_id"] == "r-1"

    def test_halt_returns_false_for_missing_manifest(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            pointer_dir = os.path.join(tmp, "pointers")
            os.makedirs(pointer_dir, exist_ok=True)

            result = halt_workspace("ws_nonexistent", pointer_dir=pointer_dir)
            assert result is False

    def test_halt_returns_false_for_terminal_workspace(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                status=WorkspaceStatus.COMPLETED,
                tiers=[{"tier": 0, "projects": ["lib"], "status": "completed"}],
            )
            _write_manifest_to_disk(manifest, tmp)

            result = halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )
            assert result is False

    def test_halt_idempotent_on_already_halted(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                status=WorkspaceStatus.HALTED,
                halt_reason="user",
                tiers=[
                    {"tier": 0, "projects": ["lib"], "status": "completed"},
                    {"tier": 1, "projects": ["app"], "status": "halted"},
                ],
            )
            _write_manifest_to_disk(manifest, tmp)

            result = halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )
            assert result is False

    def test_halt_works_during_planning(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                status=WorkspaceStatus.PLANNING,
                tiers=[
                    {"tier": 0, "projects": ["lib"], "status": "pending"},
                    {"tier": 1, "projects": ["app"], "status": "pending"},
                ],
            )
            _write_manifest_to_disk(manifest, tmp)

            result = halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )

            assert result is True
            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            assert saved["status"] == WorkspaceStatus.HALTED
            assert saved["halt_reason"] == "user"

    def test_halt_works_during_integration_testing(self):
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                status=WorkspaceStatus.INTEGRATION_TESTING,
                tiers=[
                    {"tier": 0, "projects": ["lib"], "status": "completed"},
                ],
            )
            _write_manifest_to_disk(manifest, tmp)

            result = halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )

            assert result is True
            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            assert saved["status"] == WorkspaceStatus.HALTED
            assert saved["halt_reason"] == "user"


class TestHaltReasonCircuitBreaker:
    """Circuit breaker auto-halt sets halt_reason='circuit_breaker'."""

    def test_circuit_breaker_sets_halt_reason(self):
        """DagExecutor sets halt_reason='circuit_breaker' when threshold crossed."""
        from unittest.mock import patch
        import subprocess

        from worca.workspace.dag_executor import DagExecutor

        tiers = [
            {"tier": 0, "projects": ["a", "b", "c", "d"], "status": "pending"},
            {"tier": 1, "projects": ["e"], "status": "pending"},
        ]
        manifest = {
            "workspace_id": "ws_test_cb",
            "workspace_name": "test",
            "workspace_root": "/workspace",
            "status": "running",
            "halt_reason": None,
            "max_parallel": 5,
            "work_request": {"title": "", "description": "test", "source": None},
            "guide": {"paths": [], "bytes": 0, "filenames": []},
            "dag": {"tiers": tiers, "dependency_graph": {}},
            "children": [],
            "plan": {"workspace_plan_path": None, "project_plans": {}},
            "failure_threshold": 0.30,
        }
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr="error",
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "halted"
        assert manifest["halt_reason"] == "circuit_breaker"
        assert manifest["status"] == "halted"

    def test_circuit_breaker_halt_reason_differs_from_user(self):
        """circuit_breaker and user halt_reasons are distinct values."""
        from worca.workspace.lifecycle import halt_workspace

        with tempfile.TemporaryDirectory() as tmp:
            ws_root = os.path.join(tmp, "workspace")
            manifest = _make_manifest(
                workspace_root=ws_root,
                tiers=[
                    {"tier": 0, "projects": ["lib"], "status": "running"},
                    {"tier": 1, "projects": ["app"], "status": "pending"},
                ],
            )
            _write_manifest_to_disk(manifest, tmp)

            halt_workspace(
                manifest["workspace_id"], pointer_dir=os.path.join(tmp, "pointers"),
            )

            saved = _read_manifest_from_disk(ws_root, manifest["workspace_id"])
            assert saved["halt_reason"] == "user"
            assert saved["halt_reason"] != "circuit_breaker"

    def test_circuit_breaker_halts_remaining_tiers_with_reason(self):
        """Remaining tiers marked halted and halt_reason is circuit_breaker."""
        from unittest.mock import patch
        import subprocess

        from worca.workspace.dag_executor import DagExecutor

        tiers = [
            {"tier": 0, "projects": ["a", "b", "c"], "status": "pending"},
            {"tier": 1, "projects": ["d"], "status": "pending"},
            {"tier": 2, "projects": ["e"], "status": "pending"},
        ]
        manifest = {
            "workspace_id": "ws_test_cb2",
            "workspace_name": "test",
            "workspace_root": "/workspace",
            "status": "running",
            "halt_reason": None,
            "max_parallel": 5,
            "work_request": {"title": "", "description": "test", "source": None},
            "guide": {"paths": [], "bytes": 0, "filenames": []},
            "dag": {"tiers": tiers, "dependency_graph": {}},
            "children": [],
            "plan": {"workspace_plan_path": None, "project_plans": {}},
            "failure_threshold": 0.30,
        }
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr="error",
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            executor.execute()

        assert manifest["halt_reason"] == "circuit_breaker"
        halted_tiers = [t for t in tiers if t["status"] == "halted"]
        assert len(halted_tiers) >= 1

    def test_no_halt_reason_on_normal_failure(self):
        """A failed workspace (no circuit breaker) has halt_reason=None."""
        from unittest.mock import patch
        import subprocess

        from worca.workspace.dag_executor import DagExecutor

        tiers = [
            {"tier": 0, "projects": ["a"], "status": "pending"},
        ]
        manifest = {
            "workspace_id": "ws_test_nohalt",
            "workspace_name": "test",
            "workspace_root": "/workspace",
            "status": "running",
            "halt_reason": None,
            "max_parallel": 5,
            "work_request": {"title": "", "description": "test", "source": None},
            "guide": {"paths": [], "bytes": 0, "filenames": []},
            "dag": {"tiers": tiers, "dependency_graph": {}},
            "children": [],
            "plan": {"workspace_plan_path": None, "project_plans": {}},
        }
        run_dir = "/tmp/run-dir"
        executor = DagExecutor(manifest, run_dir)

        def mock_run(cmd, **kwargs):
            return subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr="error",
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        assert result["status"] == "failed"
        assert manifest["halt_reason"] is None
