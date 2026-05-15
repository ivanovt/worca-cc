"""Tests for workspace resume + error recovery (W-047-16)."""
import json
import os
from unittest.mock import patch



# ---- helpers ----------------------------------------------------------------

def _make_run_dir(tmp_path, ws_id="ws_202601011200_abc12345"):
    """Create workspace run dir and return (workspace_root, run_dir)."""
    workspace_root = str(tmp_path)
    run_dir = os.path.join(workspace_root, ".worca", "workspace-runs", ws_id)
    os.makedirs(run_dir, exist_ok=True)
    return workspace_root, run_dir


def _write_manifest(run_dir, manifest):
    path = os.path.join(run_dir, "workspace-manifest.json")
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)
    return path


def _write_pointer(pointer_dir, ws_id, workspace_root):
    os.makedirs(pointer_dir, exist_ok=True)
    path = os.path.join(pointer_dir, f"{ws_id}.json")
    with open(path, "w") as f:
        json.dump({"workspace_id": ws_id, "workspace_root": workspace_root}, f)
    return path


def _linear_workspace_json():
    return {
        "name": "my-platform",
        "repos": [
            {"name": "lib", "path": "lib", "role": "library", "depends_on": []},
            {"name": "backend", "path": "backend", "role": "service", "depends_on": ["lib"]},
            {"name": "frontend", "path": "frontend", "role": "app", "depends_on": ["backend"]},
        ],
    }


def _diamond_workspace_json():
    return {
        "name": "diamond",
        "repos": [
            {"name": "lib", "path": "lib", "role": "library", "depends_on": []},
            {"name": "backend", "path": "backend", "role": "service", "depends_on": ["lib"]},
            {"name": "worker", "path": "worker", "role": "service", "depends_on": ["lib"]},
            {"name": "frontend", "path": "frontend", "role": "app", "depends_on": ["backend", "worker"]},
        ],
    }


def _base_manifest(workspace_root, ws_id="ws_202601011200_abc12345", **overrides):
    """Build a base workspace manifest with sensible defaults."""
    m = {
        "workspace_id": ws_id,
        "workspace_name": "my-platform",
        "workspace_root": workspace_root,
        "created_at": "2026-01-01T12:00:00+00:00",
        "work_request": {"title": "", "description": "Add user profiles", "source": None},
        "guide": {"paths": [], "bytes": 0, "filenames": []},
        "branch_template": "workspace/{slug}/{repo}",
        "max_parallel": 5,
        "skip_integration": False,
        "skip_planning": True,
        "status": "failed",
        "halt_reason": None,
        "dag": {
            "tiers": [
                {"tier": 0, "repos": ["lib"], "status": "completed"},
                {"tier": 1, "repos": ["backend"], "status": "failed"},
                {"tier": 2, "repos": ["frontend"], "status": "pending"},
            ],
            "dependency_graph": {
                "lib": [],
                "backend": ["lib"],
                "frontend": ["backend"],
            },
        },
        "children": [
            {"repo": "lib", "run_id": "run_lib_001", "worktree_path": "/tmp/wt/lib", "status": "completed", "tier": 0},
            {"repo": "backend", "run_id": "run_be_001", "worktree_path": "/tmp/wt/backend", "status": "failed", "tier": 1},
        ],
        "plan": {"workspace_plan_path": "/tmp/plan.json", "repo_plans": {}},
        "integration_test": {"status": "pending", "exit_code": None, "log_path": None},
    }
    m.update(overrides)
    return m


# ---- load_workspace_manifest ------------------------------------------------

class TestLoadWorkspaceManifest:
    def test_loads_manifest_from_pointer(self, tmp_path):
        from worca.scripts.run_workspace import load_workspace_manifest

        ws_id = "ws_202601011200_abc12345"
        workspace_root, run_dir = _make_run_dir(tmp_path, ws_id)
        manifest = _base_manifest(workspace_root, ws_id)
        _write_manifest(run_dir, manifest)

        pointer_dir = str(tmp_path / "pointers")
        _write_pointer(pointer_dir, ws_id, workspace_root)

        result = load_workspace_manifest(ws_id, pointer_dir=pointer_dir)
        assert result is not None
        assert result["workspace_id"] == ws_id

    def test_returns_none_for_missing_pointer(self, tmp_path):
        from worca.scripts.run_workspace import load_workspace_manifest

        pointer_dir = str(tmp_path / "pointers")
        os.makedirs(pointer_dir)
        result = load_workspace_manifest("ws_nonexistent", pointer_dir=pointer_dir)
        assert result is None

    def test_returns_none_for_missing_manifest(self, tmp_path):
        from worca.scripts.run_workspace import load_workspace_manifest

        ws_id = "ws_202601011200_abc12345"
        pointer_dir = str(tmp_path / "pointers")
        _write_pointer(pointer_dir, ws_id, str(tmp_path))

        result = load_workspace_manifest(ws_id, pointer_dir=pointer_dir)
        assert result is None


# ---- classify_children_for_resume -------------------------------------------

class TestClassifyChildrenForResume:
    def test_completed_children_skipped(self):
        from worca.scripts.run_workspace import classify_children_for_resume

        children = [
            {"repo": "lib", "run_id": "r1", "status": "completed", "tier": 0},
        ]
        skip, redispatch = classify_children_for_resume(children)
        assert "lib" in skip
        assert len(redispatch) == 0

    def test_failed_children_redispatched(self):
        from worca.scripts.run_workspace import classify_children_for_resume

        children = [
            {"repo": "lib", "run_id": "r1", "status": "completed", "tier": 0},
            {"repo": "backend", "run_id": "r2", "status": "failed", "tier": 1},
        ]
        skip, redispatch = classify_children_for_resume(children)
        assert "lib" in skip
        assert "backend" in redispatch

    def test_blocked_children_redispatched(self):
        from worca.scripts.run_workspace import classify_children_for_resume

        children = [
            {"repo": "lib", "run_id": "r1", "status": "completed", "tier": 0},
            {"repo": "backend", "run_id": "r2", "status": "blocked", "tier": 1},
        ]
        skip, redispatch = classify_children_for_resume(children)
        assert "backend" in redispatch

    def test_halted_children_redispatched(self):
        from worca.scripts.run_workspace import classify_children_for_resume

        children = [
            {"repo": "lib", "run_id": None, "status": "halted", "tier": 2},
        ]
        skip, redispatch = classify_children_for_resume(children)
        assert "lib" in redispatch


# ---- rebuild_resume_manifest ------------------------------------------------

class TestRebuildResumeManifest:
    def test_resets_status_to_running(self, tmp_path):
        from worca.scripts.run_workspace import rebuild_resume_manifest

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root, status="failed")

        result = rebuild_resume_manifest(manifest, {"lib"}, {"backend", "frontend"})
        assert result["status"] == "running"
        assert result["halt_reason"] is None

    def test_resets_failed_tier_status(self, tmp_path):
        from worca.scripts.run_workspace import rebuild_resume_manifest

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root, status="failed")

        result = rebuild_resume_manifest(manifest, {"lib"}, {"backend", "frontend"})
        for tier in result["dag"]["tiers"]:
            if tier["tier"] == 0:
                assert tier["status"] == "completed"
            elif tier["tier"] == 1:
                assert tier["status"] == "pending"
            elif tier["tier"] == 2:
                assert tier["status"] == "pending"

    def test_removes_non_completed_children(self, tmp_path):
        from worca.scripts.run_workspace import rebuild_resume_manifest

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root)

        result = rebuild_resume_manifest(manifest, {"lib"}, {"backend"})
        child_repos = [c["repo"] for c in result["children"]]
        assert "lib" in child_repos
        assert "backend" not in child_repos

    def test_preserves_completed_children(self, tmp_path):
        from worca.scripts.run_workspace import rebuild_resume_manifest

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root)

        result = rebuild_resume_manifest(manifest, {"lib"}, {"backend"})
        lib_child = [c for c in result["children"] if c["repo"] == "lib"][0]
        assert lib_child["status"] == "completed"
        assert lib_child["run_id"] == "run_lib_001"

    def test_resets_integration_test(self, tmp_path):
        from worca.scripts.run_workspace import rebuild_resume_manifest

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root)
        manifest["integration_test"] = {"status": "failed", "exit_code": 1, "log_path": "/tmp/log"}

        result = rebuild_resume_manifest(manifest, {"lib"}, {"backend"})
        assert result["integration_test"]["status"] == "pending"
        assert result["integration_test"]["exit_code"] is None


# ---- resume_workspace_partial_tier ------------------------------------------

class TestResumePartialTier:
    """Resume a workspace where tier 0 completed but tier 1 failed — only
    failed/blocked/halted children should be re-dispatched."""

    def test_resume_skips_completed_repos(self, tmp_path):
        """DagExecutor in resume mode must not re-dispatch completed repos."""
        from worca.workspace.dag_executor import DagExecutor

        ws_root, run_dir = _make_run_dir(tmp_path)
        (tmp_path / "workspace.json").write_text(json.dumps(_linear_workspace_json()))

        manifest = _base_manifest(ws_root)
        manifest["status"] = "running"
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
            {"tier": 1, "repos": ["backend"], "status": "pending"},
            {"tier": 2, "repos": ["frontend"], "status": "pending"},
        ]
        manifest["children"] = [
            {"repo": "lib", "run_id": "run_lib_001", "worktree_path": str(tmp_path / "wt_lib"), "status": "completed", "tier": 0},
        ]

        dispatched = []

        def fake_run_child(self_inner, repo):
            dispatched.append(repo)
            return {"status": "completed", "run_id": f"run_{repo}_002", "worktree_path": str(tmp_path / f"wt_{repo}")}

        def fake_extract(worktree_path, cap_bytes=8192):
            return ""

        with patch.object(DagExecutor, "_run_child", fake_run_child), \
             patch("worca.workspace.dag_executor._extract_repo_context", fake_extract):
            executor = DagExecutor(manifest, run_dir)
            result = executor.execute()

        assert "lib" not in dispatched
        assert "backend" in dispatched
        assert "frontend" in dispatched
        assert result["status"] == "completed"

    def test_resume_regenerates_context_from_completed(self, tmp_path):
        """Context artifacts from completed tier 0 should be regenerated for tier 1."""
        from worca.workspace.dag_executor import DagExecutor

        ws_root, run_dir = _make_run_dir(tmp_path)
        (tmp_path / "workspace.json").write_text(json.dumps(_linear_workspace_json()))

        wt_lib = tmp_path / "wt_lib"
        wt_lib.mkdir()

        manifest = _base_manifest(ws_root)
        manifest["status"] = "running"
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
            {"tier": 1, "repos": ["backend"], "status": "pending"},
            {"tier": 2, "repos": ["frontend"], "status": "pending"},
        ]
        manifest["dag"]["dependency_graph"] = {
            "lib": [], "backend": ["lib"], "frontend": ["backend"],
        }
        manifest["children"] = [
            {"repo": "lib", "run_id": "run_lib_001", "worktree_path": str(wt_lib), "status": "completed", "tier": 0},
        ]

        context_extracted_from = []

        def fake_extract(worktree_path, cap_bytes=8192):
            context_extracted_from.append(worktree_path)
            return "### Changes summary\n```\nfoo.py | 10 +\n```\n"

        def fake_run_child(self_inner, repo):
            return {"status": "completed", "run_id": f"run_{repo}_002", "worktree_path": str(tmp_path / f"wt_{repo}")}

        with patch.object(DagExecutor, "_run_child", fake_run_child), \
             patch("worca.workspace.dag_executor._extract_repo_context", fake_extract):
            executor = DagExecutor(manifest, run_dir)
            result = executor.execute()

        assert str(wt_lib) in context_extracted_from
        assert result["status"] == "completed"

    def test_resume_propagates_failure_to_dependents(self, tmp_path):
        """If a re-dispatched child fails again, its dependents should be blocked."""
        from worca.workspace.dag_executor import DagExecutor

        ws_root, run_dir = _make_run_dir(tmp_path)

        manifest = _base_manifest(ws_root)
        manifest["status"] = "running"
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
            {"tier": 1, "repos": ["backend"], "status": "pending"},
            {"tier": 2, "repos": ["frontend"], "status": "pending"},
        ]
        manifest["dag"]["dependency_graph"] = {
            "lib": [], "backend": ["lib"], "frontend": ["backend"],
        }
        manifest["children"] = [
            {"repo": "lib", "run_id": "run_lib_001", "worktree_path": str(tmp_path / "wt_lib"), "status": "completed", "tier": 0},
        ]

        def fake_run_child(self_inner, repo):
            if repo == "backend":
                return {"status": "failed", "run_id": "run_be_002", "worktree_path": None}
            return {"status": "completed", "run_id": f"run_{repo}_002", "worktree_path": f"/tmp/wt_{repo}"}

        def fake_extract(worktree_path, cap_bytes=8192):
            return ""

        with patch.object(DagExecutor, "_run_child", fake_run_child), \
             patch("worca.workspace.dag_executor._extract_repo_context", fake_extract):
            executor = DagExecutor(manifest, run_dir)
            result = executor.execute()

        assert result["status"] == "failed"
        children_by_repo = {c["repo"]: c for c in manifest["children"]}
        assert children_by_repo["frontend"]["status"] == "blocked"


# ---- resume_integration_only -----------------------------------------------

class TestResumeIntegrationOnly:
    """Resume where all tiers completed but integration test failed —
    should only re-run integration, not re-dispatch any children."""

    def test_integration_only_resume_skips_dispatch(self, tmp_path):
        from worca.scripts.run_workspace import (
            classify_children_for_resume,
        )

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root, status="integration_failed")
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
            {"tier": 1, "repos": ["backend"], "status": "completed"},
            {"tier": 2, "repos": ["frontend"], "status": "completed"},
        ]
        manifest["children"] = [
            {"repo": "lib", "run_id": "r1", "worktree_path": "/tmp/wt_lib", "status": "completed", "tier": 0},
            {"repo": "backend", "run_id": "r2", "worktree_path": "/tmp/wt_be", "status": "completed", "tier": 1},
            {"repo": "frontend", "run_id": "r3", "worktree_path": "/tmp/wt_fe", "status": "completed", "tier": 2},
        ]
        manifest["integration_test"] = {"status": "failed", "exit_code": 1, "log_path": "/tmp/log"}

        skip, redispatch = classify_children_for_resume(manifest["children"])
        assert len(skip) == 3
        assert len(redispatch) == 0

    def test_integration_failed_manifest_resets_integration(self, tmp_path):
        from worca.scripts.run_workspace import rebuild_resume_manifest

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root, status="integration_failed")
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
        ]
        manifest["children"] = [
            {"repo": "lib", "run_id": "r1", "worktree_path": "/tmp/wt_lib", "status": "completed", "tier": 0},
        ]
        manifest["integration_test"] = {"status": "failed", "exit_code": 1, "log_path": "/tmp/log"}

        result = rebuild_resume_manifest(manifest, {"lib"}, set())
        assert result["integration_test"]["status"] == "pending"
        assert result["status"] == "integration_testing"

    def test_integration_resume_sets_status_integration_testing(self, tmp_path):
        """When all children completed, resume should go straight to integration_testing."""
        from worca.scripts.run_workspace import rebuild_resume_manifest

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root, status="integration_failed")
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
            {"tier": 1, "repos": ["backend"], "status": "completed"},
        ]
        manifest["children"] = [
            {"repo": "lib", "run_id": "r1", "worktree_path": "/tmp/wt_lib", "status": "completed", "tier": 0},
            {"repo": "backend", "run_id": "r2", "worktree_path": "/tmp/wt_be", "status": "completed", "tier": 1},
        ]
        manifest["integration_test"] = {"status": "failed", "exit_code": 1, "log_path": "/tmp/log"}

        result = rebuild_resume_manifest(manifest, {"lib", "backend"}, set())
        assert result["status"] == "integration_testing"
        for tier in result["dag"]["tiers"]:
            assert tier["status"] == "completed"


# ---- tier_failure_and_integration_failure_combo -----------------------------

class TestTierAndIntegrationFailureCombo:
    """Resume where some children failed AND integration_test also failed
    (from a partial completion). Children should be re-dispatched AND
    integration should be re-run after all tiers complete."""

    def test_combo_classifies_correctly(self):
        from worca.scripts.run_workspace import classify_children_for_resume

        children = [
            {"repo": "lib", "run_id": "r1", "status": "completed", "tier": 0},
            {"repo": "backend", "run_id": "r2", "status": "failed", "tier": 1},
            {"repo": "frontend", "run_id": None, "status": "blocked", "tier": 2},
        ]
        skip, redispatch = classify_children_for_resume(children)
        assert skip == {"lib"}
        assert redispatch == {"backend", "frontend"}

    def test_combo_rebuild_resets_both(self, tmp_path):
        from worca.scripts.run_workspace import rebuild_resume_manifest

        ws_root = str(tmp_path)
        manifest = _base_manifest(ws_root, status="failed")
        manifest["integration_test"] = {"status": "failed", "exit_code": 1, "log_path": "/tmp/log"}

        result = rebuild_resume_manifest(manifest, {"lib"}, {"backend", "frontend"})
        assert result["status"] == "running"
        assert result["integration_test"]["status"] == "pending"
        children_repos = {c["repo"] for c in result["children"]}
        assert "lib" in children_repos
        assert "backend" not in children_repos
        assert "frontend" not in children_repos

    def test_combo_dag_executor_handles_mixed_state(self, tmp_path):
        """Full combo: tier 0 completed, tier 1 has one failed + one completed (diamond),
        tier 2 blocked. Resume re-dispatches failed in tier 1, then unblocks tier 2."""
        from worca.workspace.dag_executor import DagExecutor

        ws_root, run_dir = _make_run_dir(tmp_path)

        manifest = {
            "workspace_id": "ws_combo",
            "workspace_name": "diamond",
            "workspace_root": ws_root,
            "created_at": "2026-01-01T12:00:00+00:00",
            "work_request": {"title": "", "description": "test", "source": None},
            "guide": {"paths": [], "bytes": 0, "filenames": []},
            "branch_template": "workspace/{slug}/{repo}",
            "max_parallel": 5,
            "skip_integration": True,
            "skip_planning": True,
            "status": "running",
            "halt_reason": None,
            "dag": {
                "tiers": [
                    {"tier": 0, "repos": ["lib"], "status": "completed"},
                    {"tier": 1, "repos": ["backend", "worker"], "status": "pending"},
                    {"tier": 2, "repos": ["frontend"], "status": "pending"},
                ],
                "dependency_graph": {
                    "lib": [],
                    "backend": ["lib"],
                    "worker": ["lib"],
                    "frontend": ["backend", "worker"],
                },
            },
            "children": [
                {"repo": "lib", "run_id": "r_lib", "worktree_path": str(tmp_path / "wt_lib"), "status": "completed", "tier": 0},
                {"repo": "worker", "run_id": "r_worker", "worktree_path": str(tmp_path / "wt_worker"), "status": "completed", "tier": 1},
            ],
            "plan": {},
            "integration_test": {"status": "pending", "exit_code": None, "log_path": None},
        }

        dispatched = []

        def fake_run_child(self_inner, repo):
            dispatched.append(repo)
            return {"status": "completed", "run_id": f"run_{repo}_002", "worktree_path": str(tmp_path / f"wt_{repo}_new")}

        def fake_extract(worktree_path, cap_bytes=8192):
            return ""

        with patch.object(DagExecutor, "_run_child", fake_run_child), \
             patch("worca.workspace.dag_executor._extract_repo_context", fake_extract):
            executor = DagExecutor(manifest, run_dir)
            result = executor.execute()

        assert "lib" not in dispatched
        assert "worker" not in dispatched
        assert "backend" in dispatched
        assert "frontend" in dispatched
        assert result["status"] == "completed"


# ---- main() with --resume --------------------------------------------------

class TestMainResume:
    def test_resume_flag_loads_manifest(self, tmp_path):
        from worca.scripts.run_workspace import main

        ws_id = "ws_202601011200_abc12345"
        workspace_root, run_dir = _make_run_dir(tmp_path, ws_id)

        (tmp_path / "workspace.json").write_text(json.dumps(_linear_workspace_json()))

        manifest = _base_manifest(workspace_root, ws_id, status="failed")
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
            {"tier": 1, "repos": ["backend"], "status": "failed"},
            {"tier": 2, "repos": ["frontend"], "status": "pending"},
        ]
        manifest["children"] = [
            {"repo": "lib", "run_id": "r1", "worktree_path": str(tmp_path / "wt_lib"), "status": "completed", "tier": 0},
            {"repo": "backend", "run_id": "r2", "worktree_path": None, "status": "failed", "tier": 1},
        ]
        _write_manifest(run_dir, manifest)

        pointer_dir = str(tmp_path / "pointers")
        _write_pointer(pointer_dir, ws_id, workspace_root)

        with patch("worca.scripts.run_workspace._POINTER_DIR_DEFAULT", pointer_dir), \
             patch("worca.workspace.dag_executor.DagExecutor.execute", return_value={"status": "completed"}) as mock_execute, \
             patch("worca.workspace.dag_executor.DagExecutor._write_manifest"):

            exit_code = main([workspace_root, "--resume", ws_id])

        assert exit_code == 0
        mock_execute.assert_called_once()

    def test_resume_missing_manifest_fails(self, tmp_path, capsys):
        from worca.scripts.run_workspace import main

        ws_id = "ws_nonexistent"
        workspace_root = str(tmp_path)
        (tmp_path / "workspace.json").write_text(json.dumps(_linear_workspace_json()))

        pointer_dir = str(tmp_path / "pointers")
        os.makedirs(pointer_dir)

        with patch("worca.scripts.run_workspace._POINTER_DIR_DEFAULT", pointer_dir):
            exit_code = main([workspace_root, "--resume", ws_id])

        assert exit_code == 1
        captured = capsys.readouterr()
        assert "not found" in captured.err.lower()

    def test_resume_completed_workspace_is_noop(self, tmp_path, capsys):
        from worca.scripts.run_workspace import main

        ws_id = "ws_202601011200_abc12345"
        workspace_root, run_dir = _make_run_dir(tmp_path, ws_id)
        (tmp_path / "workspace.json").write_text(json.dumps(_linear_workspace_json()))

        manifest = _base_manifest(workspace_root, ws_id, status="completed")
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
        ]
        manifest["children"] = [
            {"repo": "lib", "run_id": "r1", "status": "completed", "tier": 0},
        ]
        _write_manifest(run_dir, manifest)

        pointer_dir = str(tmp_path / "pointers")
        _write_pointer(pointer_dir, ws_id, workspace_root)

        with patch("worca.scripts.run_workspace._POINTER_DIR_DEFAULT", pointer_dir):
            exit_code = main([workspace_root, "--resume", ws_id])

        assert exit_code == 0
        captured = capsys.readouterr()
        assert "already" in captured.out.lower() or "nothing" in captured.out.lower()
