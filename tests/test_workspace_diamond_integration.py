"""Integration tests: diamond dependency topology + failure propagation + resume.

Diamond fixture:  lib → [svc-a, svc-b] → gateway
  Tier 0: lib (no deps)
  Tier 1: svc-a, svc-b (both depend on lib, run in parallel)
  Tier 2: gateway (depends on both svc-a and svc-b)

Tests cover:
  1. Tier computation produces the correct 3-tier structure
  2. All-success dispatches tiers in order with parallel tier 1
  3. Failure propagation: svc-a fails → gateway blocked, lib+svc-b completed
  4. Workspace status is failed when any child is blocked
  5. Resume re-dispatches only failed + blocked repos (svc-a, gateway)
  6. Resume preserves completed repos (lib, svc-b) without re-dispatching
"""
from __future__ import annotations

import json
import subprocess
from unittest.mock import patch



# ---- diamond workspace fixture -----------------------------------------------

def _diamond_workspace_json():
    return {
        "name": "diamond-platform",
        "repos": [
            {"name": "lib", "path": "lib", "role": "shared library", "depends_on": []},
            {"name": "svc-a", "path": "svc-a", "role": "service A", "depends_on": ["lib"]},
            {"name": "svc-b", "path": "svc-b", "role": "service B", "depends_on": ["lib"]},
            {"name": "gateway", "path": "gateway", "role": "API gateway", "depends_on": ["svc-a", "svc-b"]},
        ],
    }


def _diamond_manifest(workspace_root, **overrides):
    m = {
        "workspace_id": "ws_diamond_test",
        "workspace_name": "diamond-platform",
        "workspace_root": workspace_root,
        "created_at": "2026-01-01T12:00:00+00:00",
        "work_request": {"title": "", "description": "Diamond test", "source": None},
        "guide": {"paths": [], "bytes": 0, "filenames": []},
        "branch_template": "workspace/{slug}/{repo}",
        "max_parallel": 5,
        "skip_integration": True,
        "skip_planning": True,
        "status": "running",
        "halt_reason": None,
        "dag": {
            "tiers": [
                {"tier": 0, "repos": ["lib"], "status": "pending"},
                {"tier": 1, "repos": ["svc-a", "svc-b"], "status": "pending"},
                {"tier": 2, "repos": ["gateway"], "status": "pending"},
            ],
            "dependency_graph": {
                "lib": [],
                "svc-a": ["lib"],
                "svc-b": ["lib"],
                "gateway": ["svc-a", "svc-b"],
            },
        },
        "children": [],
        "plan": {"workspace_plan_path": None, "repo_plans": {}},
        "integration_test": {"status": "pending", "exit_code": None, "log_path": None},
    }
    m.update(overrides)
    return m


def _completed_proc(run_id="r-001", worktree_path="/tmp/wt"):
    return subprocess.CompletedProcess(
        args=[], returncode=0, stdout=f"{run_id}\n{worktree_path}\n", stderr=""
    )


def _failed_proc():
    return subprocess.CompletedProcess(
        args=[], returncode=1, stdout="", stderr="error: boom"
    )


# ---- 1. Tier computation ----------------------------------------------------

class TestDiamondTierComputation:
    """Workspace.load computes correct tiers for the diamond topology."""

    def test_diamond_produces_three_tiers(self, tmp_path):
        from worca.workspace.manifest import Workspace

        ws_json = _diamond_workspace_json()
        (tmp_path / "workspace.json").write_text(json.dumps(ws_json))
        ws = Workspace.load(str(tmp_path))

        assert len(ws.tiers) == 3

    def test_tier_zero_is_lib(self, tmp_path):
        from worca.workspace.manifest import Workspace

        ws_json = _diamond_workspace_json()
        (tmp_path / "workspace.json").write_text(json.dumps(ws_json))
        ws = Workspace.load(str(tmp_path))

        assert ws.tiers[0] == ["lib"]

    def test_tier_one_is_svc_a_and_svc_b_parallel(self, tmp_path):
        from worca.workspace.manifest import Workspace

        ws_json = _diamond_workspace_json()
        (tmp_path / "workspace.json").write_text(json.dumps(ws_json))
        ws = Workspace.load(str(tmp_path))

        assert sorted(ws.tiers[1]) == ["svc-a", "svc-b"]

    def test_tier_two_is_gateway(self, tmp_path):
        from worca.workspace.manifest import Workspace

        ws_json = _diamond_workspace_json()
        (tmp_path / "workspace.json").write_text(json.dumps(ws_json))
        ws = Workspace.load(str(tmp_path))

        assert ws.tiers[2] == ["gateway"]


# ---- 2. All-success diamond dispatch ----------------------------------------

class TestDiamondAllSuccess:
    """DagExecutor dispatches all 4 repos across 3 tiers when everything succeeds."""

    def test_all_four_repos_dispatched(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _diamond_manifest("/workspace")
        executor = DagExecutor(manifest, "/tmp/run-dir")

        dispatched = []

        def fake_run_child(self_inner, repo):
            dispatched.append(repo)
            return {
                "status": "completed",
                "run_id": f"r-{repo}",
                "worktree_path": f"/wt/{repo}",
            }

        with (
            patch.object(DagExecutor, "_run_child", fake_run_child),
            patch(
                "worca.workspace.dag_executor._extract_repo_context",
                return_value="",
            ),
        ):
            result = executor.execute()

        assert result["status"] == "completed"
        assert sorted(dispatched) == ["gateway", "lib", "svc-a", "svc-b"]

    def test_tier_order_respected(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _diamond_manifest("/workspace")
        executor = DagExecutor(manifest, "/tmp/run-dir")

        tier_at_dispatch: list[tuple[str, int]] = []

        def fake_run_child(self_inner, repo):
            tier_at_dispatch.append((repo, executor._current_tier))
            return {
                "status": "completed",
                "run_id": f"r-{repo}",
                "worktree_path": f"/wt/{repo}",
            }

        with (
            patch.object(DagExecutor, "_run_child", fake_run_child),
            patch(
                "worca.workspace.dag_executor._extract_repo_context",
                return_value="",
            ),
        ):
            executor.execute()

        by_tier: dict[int, list[str]] = {}
        for repo, tier in tier_at_dispatch:
            by_tier.setdefault(tier, []).append(repo)

        assert by_tier[0] == ["lib"]
        assert sorted(by_tier[1]) == ["svc-a", "svc-b"]
        assert by_tier[2] == ["gateway"]

    def test_all_children_registered_in_manifest(self):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _diamond_manifest("/workspace")
        executor = DagExecutor(manifest, "/tmp/run-dir")

        def fake_run_child(self_inner, repo):
            return {
                "status": "completed",
                "run_id": f"r-{repo}",
                "worktree_path": f"/wt/{repo}",
            }

        with (
            patch.object(DagExecutor, "_run_child", fake_run_child),
            patch(
                "worca.workspace.dag_executor._extract_repo_context",
                return_value="",
            ),
        ):
            executor.execute()

        child_repos = {c["repo"] for c in manifest["children"]}
        assert child_repos == {"lib", "svc-a", "svc-b", "gateway"}
        assert all(c["status"] == "completed" for c in manifest["children"])


# ---- 3. Failure propagation -------------------------------------------------

class TestDiamondFailurePropagation:
    """When svc-a (tier 1) fails, gateway (tier 2) is blocked because it
    depends on both svc-a and svc-b."""

    def _run_with_svc_a_failure(self, manifest):
        from worca.workspace.dag_executor import DagExecutor

        executor = DagExecutor(manifest, "/tmp/run-dir")

        dispatched = []

        def mock_run(cmd, **kwargs):
            cwd = kwargs.get("cwd", "")
            repo = cwd.rsplit("/", 1)[-1]
            dispatched.append(repo)
            if repo == "svc-a":
                return _failed_proc()
            return _completed_proc(
                run_id=f"r-{repo}", worktree_path=f"/wt/{repo}"
            )

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
        ):
            result = executor.execute()

        return result, dispatched

    def test_gateway_marked_blocked(self):
        manifest = _diamond_manifest("/workspace")
        result, _ = self._run_with_svc_a_failure(manifest)

        blocked = [c for c in manifest["children"] if c["status"] == "blocked"]
        assert len(blocked) == 1
        assert blocked[0]["repo"] == "gateway"

    def test_gateway_not_dispatched(self):
        manifest = _diamond_manifest("/workspace")
        _, dispatched = self._run_with_svc_a_failure(manifest)

        assert "gateway" not in dispatched

    def test_lib_completed(self):
        manifest = _diamond_manifest("/workspace")
        self._run_with_svc_a_failure(manifest)

        lib = next(c for c in manifest["children"] if c["repo"] == "lib")
        assert lib["status"] == "completed"

    def test_svc_b_completed(self):
        manifest = _diamond_manifest("/workspace")
        self._run_with_svc_a_failure(manifest)

        svc_b = next(c for c in manifest["children"] if c["repo"] == "svc-b")
        assert svc_b["status"] == "completed"

    def test_svc_a_marked_failed(self):
        manifest = _diamond_manifest("/workspace")
        self._run_with_svc_a_failure(manifest)

        svc_a = next(c for c in manifest["children"] if c["repo"] == "svc-a")
        assert svc_a["status"] == "failed"

    def test_workspace_status_failed(self):
        manifest = _diamond_manifest("/workspace")
        result, _ = self._run_with_svc_a_failure(manifest)

        assert result["status"] == "failed"
        assert manifest["status"] == "failed"

    def test_blocked_child_has_null_run_id(self):
        manifest = _diamond_manifest("/workspace")
        self._run_with_svc_a_failure(manifest)

        gateway = next(c for c in manifest["children"] if c["repo"] == "gateway")
        assert gateway["run_id"] is None
        assert gateway["worktree_path"] is None

    def test_svc_b_still_dispatched_alongside_failing_svc_a(self):
        """svc-b has no dependency on svc-a, so it runs even when svc-a fails."""
        manifest = _diamond_manifest("/workspace")
        _, dispatched = self._run_with_svc_a_failure(manifest)

        assert "svc-b" in dispatched

    def test_tier_one_marked_failed(self):
        manifest = _diamond_manifest("/workspace")
        self._run_with_svc_a_failure(manifest)

        tier1 = manifest["dag"]["tiers"][1]
        assert tier1["status"] == "failed"


# ---- 4. Resume after failure -------------------------------------------------

class TestDiamondResume:
    """After svc-a fails (gateway blocked), resume re-dispatches only
    svc-a + gateway. lib and svc-b are preserved."""

    def _build_failed_manifest(self, tmp_path):
        """Build a manifest representing state after svc-a failure."""
        ws_root = str(tmp_path)
        manifest = _diamond_manifest(ws_root, status="failed")
        manifest["dag"]["tiers"] = [
            {"tier": 0, "repos": ["lib"], "status": "completed"},
            {"tier": 1, "repos": ["svc-a", "svc-b"], "status": "failed"},
            {"tier": 2, "repos": ["gateway"], "status": "pending"},
        ]
        manifest["children"] = [
            {"repo": "lib", "run_id": "r-lib", "worktree_path": str(tmp_path / "wt_lib"), "status": "completed", "tier": 0},
            {"repo": "svc-a", "run_id": "r-svc-a", "worktree_path": None, "status": "failed", "tier": 1},
            {"repo": "svc-b", "run_id": "r-svc-b", "worktree_path": str(tmp_path / "wt_svc_b"), "status": "completed", "tier": 1},
            {"repo": "gateway", "run_id": None, "worktree_path": None, "status": "blocked", "tier": 2},
        ]
        return manifest

    def test_classify_skips_completed(self, tmp_path):
        from worca.scripts.run_workspace import classify_children_for_resume

        manifest = self._build_failed_manifest(tmp_path)
        skip, redispatch = classify_children_for_resume(manifest["children"])

        assert skip == {"lib", "svc-b"}

    def test_classify_redispatches_failed_and_blocked(self, tmp_path):
        from worca.scripts.run_workspace import classify_children_for_resume

        manifest = self._build_failed_manifest(tmp_path)
        skip, redispatch = classify_children_for_resume(manifest["children"])

        assert redispatch == {"svc-a", "gateway"}

    def test_rebuild_preserves_completed_children(self, tmp_path):
        from worca.scripts.run_workspace import (
            classify_children_for_resume,
            rebuild_resume_manifest,
        )

        manifest = self._build_failed_manifest(tmp_path)
        skip, redispatch = classify_children_for_resume(manifest["children"])
        rebuild_resume_manifest(manifest, skip, redispatch)

        child_repos = {c["repo"] for c in manifest["children"]}
        assert "lib" in child_repos
        assert "svc-b" in child_repos
        assert "svc-a" not in child_repos
        assert "gateway" not in child_repos

    def test_rebuild_resets_status_to_running(self, tmp_path):
        from worca.scripts.run_workspace import (
            classify_children_for_resume,
            rebuild_resume_manifest,
        )

        manifest = self._build_failed_manifest(tmp_path)
        skip, redispatch = classify_children_for_resume(manifest["children"])
        rebuild_resume_manifest(manifest, skip, redispatch)

        assert manifest["status"] == "running"

    def test_rebuild_resets_failed_tier_status(self, tmp_path):
        from worca.scripts.run_workspace import (
            classify_children_for_resume,
            rebuild_resume_manifest,
        )

        manifest = self._build_failed_manifest(tmp_path)
        skip, redispatch = classify_children_for_resume(manifest["children"])
        rebuild_resume_manifest(manifest, skip, redispatch)

        tier_statuses = {t["tier"]: t["status"] for t in manifest["dag"]["tiers"]}
        assert tier_statuses[0] == "completed"
        assert tier_statuses[1] == "pending"
        assert tier_statuses[2] == "pending"

    def test_resume_dispatches_only_svc_a_and_gateway(self, tmp_path):
        """Full resume flow: DagExecutor skips lib+svc-b, dispatches svc-a+gateway."""
        from worca.workspace.dag_executor import DagExecutor
        from worca.scripts.run_workspace import (
            classify_children_for_resume,
            rebuild_resume_manifest,
        )

        manifest = self._build_failed_manifest(tmp_path)
        skip, redispatch = classify_children_for_resume(manifest["children"])
        rebuild_resume_manifest(manifest, skip, redispatch)

        dispatched = []

        def fake_run_child(self_inner, repo):
            dispatched.append(repo)
            return {
                "status": "completed",
                "run_id": f"r-{repo}-v2",
                "worktree_path": str(tmp_path / f"wt_{repo}_v2"),
            }

        def fake_extract(worktree_path, cap_bytes=8192):
            return ""

        with (
            patch.object(DagExecutor, "_run_child", fake_run_child),
            patch("worca.workspace.dag_executor._extract_repo_context", fake_extract),
        ):
            executor = DagExecutor(manifest, str(tmp_path / "run-dir"))
            result = executor.execute()

        assert result["status"] == "completed"
        assert "lib" not in dispatched
        assert "svc-b" not in dispatched
        assert "svc-a" in dispatched
        assert "gateway" in dispatched

    def test_resume_svc_a_fails_again_gateway_blocked_again(self, tmp_path):
        """If svc-a fails again on resume, gateway is blocked again."""
        from worca.workspace.dag_executor import DagExecutor
        from worca.scripts.run_workspace import (
            classify_children_for_resume,
            rebuild_resume_manifest,
        )

        manifest = self._build_failed_manifest(tmp_path)
        skip, redispatch = classify_children_for_resume(manifest["children"])
        rebuild_resume_manifest(manifest, skip, redispatch)

        def fake_run_child(self_inner, repo):
            if repo == "svc-a":
                return {"status": "failed", "run_id": None, "worktree_path": None}
            return {
                "status": "completed",
                "run_id": f"r-{repo}-v2",
                "worktree_path": str(tmp_path / f"wt_{repo}_v2"),
            }

        def fake_extract(worktree_path, cap_bytes=8192):
            return ""

        with (
            patch.object(DagExecutor, "_run_child", fake_run_child),
            patch("worca.workspace.dag_executor._extract_repo_context", fake_extract),
        ):
            executor = DagExecutor(manifest, str(tmp_path / "run-dir"))
            result = executor.execute()

        assert result["status"] == "failed"
        children_by_repo = {c["repo"]: c for c in manifest["children"]}
        assert children_by_repo["gateway"]["status"] == "blocked"
        assert children_by_repo["svc-a"]["status"] == "failed"
        assert children_by_repo["lib"]["status"] == "completed"
        assert children_by_repo["svc-b"]["status"] == "completed"

    def test_resume_context_regenerated_from_completed_tiers(self, tmp_path):
        """Resume regenerates context from completed tier 0 (lib) for tier 1."""
        from worca.workspace.dag_executor import DagExecutor
        from worca.scripts.run_workspace import (
            classify_children_for_resume,
            rebuild_resume_manifest,
        )

        manifest = self._build_failed_manifest(tmp_path)
        skip, redispatch = classify_children_for_resume(manifest["children"])
        rebuild_resume_manifest(manifest, skip, redispatch)

        context_extracted_from = []

        def fake_run_child(self_inner, repo):
            return {
                "status": "completed",
                "run_id": f"r-{repo}-v2",
                "worktree_path": str(tmp_path / f"wt_{repo}_v2"),
            }

        def fake_extract(worktree_path, cap_bytes=8192):
            context_extracted_from.append(worktree_path)
            return "### Changes\nsome diff"

        with (
            patch.object(DagExecutor, "_run_child", fake_run_child),
            patch("worca.workspace.dag_executor._extract_repo_context", fake_extract),
        ):
            executor = DagExecutor(manifest, str(tmp_path / "run-dir"))
            executor.execute()

        assert str(tmp_path / "wt_lib") in context_extracted_from
