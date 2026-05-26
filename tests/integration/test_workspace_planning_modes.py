"""Integration test: all four workspace planning modes dispatch correct child commands.

Synthetic 3-repo workspace (shared-lib → backend → frontend).
For each mode (master, existing, per-repo, independent), runs
run_workspace.main() with DagExecutor.execute patched to capture the
manifest and child commands built by _build_child_cmd. Asserts each mode
produces the right --plan / --skip-planning arguments on children.

Assertions per mode:
  master:      project_plans populated from planner output; each child gets --plan <path>
  existing:    project_plans populated from supplied workspace-plan.json; each child gets --plan
  per-repo:    only covered projects get --plan; uncovered projects get no --plan
  independent: no plan block in manifest; no --plan on any child
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from worca.scripts.run_workspace import (
    _materialize_plan,
    create_parser,
    create_workspace_manifest,
)
from worca.workspace.dag_executor import DagExecutor, _build_child_cmd
from worca.workspace.manifest import Workspace


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _workspace_json():
    return {
        "name": "test-platform",
        "projects": [
            {"name": "shared-lib", "path": "shared-lib", "depends_on": []},
            {"name": "backend", "path": "backend", "depends_on": ["shared-lib"]},
            {"name": "frontend", "path": "frontend", "depends_on": ["backend"]},
        ],
    }


def _valid_workspace_plan():
    return {
        "summary": "Cross-project refactor",
        "projects": [
            {
                "name": "shared-lib",
                "description": "Add shared types",
                "acceptance_criteria": ["Types compile"],
                "depends_on": [],
            },
            {
                "name": "backend",
                "description": "Consume shared types",
                "acceptance_criteria": ["Backend builds"],
                "depends_on": ["shared-lib"],
            },
            {
                "name": "frontend",
                "description": "Update UI layer",
                "acceptance_criteria": ["Frontend renders"],
                "depends_on": ["backend"],
            },
        ],
        "integration_expectations": ["All projects build together"],
    }


@pytest.fixture()
def workspace_root(tmp_path):
    """Create a workspace directory with workspace.json and project subdirs."""
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "workspace.json").write_text(json.dumps(_workspace_json(), indent=2))
    for name in ("shared-lib", "backend", "frontend"):
        (root / name).mkdir()
    return root


@pytest.fixture()
def workspace(workspace_root):
    return Workspace.load(str(workspace_root))


@pytest.fixture()
def run_dir(tmp_path):
    d = tmp_path / "run-dir"
    d.mkdir()
    return d


def _make_manifest(workspace, workspace_root, *, skip_planning=False):
    return create_workspace_manifest(
        workspace_id="ws_test_plan_modes",
        workspace_root=str(workspace_root),
        workspace_name=workspace.name,
        prompt="Refactor shared types",
        source=None,
        guide_paths=[],
        branch_template="workspace/{slug}/{project}",
        max_parallel=3,
        skip_integration=True,
        skip_planning=skip_planning,
        tiers=workspace.tiers,
        projects_by_name={p.name: p.path for p in workspace.projects},
        dependency_graph={p.name: p.depends_on for p in workspace.projects},
    )


def _child_cmds_from_manifest(manifest):
    """Build the child commands DagExecutor would dispatch from the manifest."""
    project_plans = manifest.get("plan", {}).get("project_plans", {}) or {}
    projects = []
    for tier in manifest["dag"]["tiers"]:
        for proj in tier["projects"]:
            projects.append(proj)

    cmds = {}
    for proj in projects:
        plan_path = project_plans.get(proj)
        cmd = _build_child_cmd(
            workspace_id=manifest["workspace_id"],
            prompt=manifest["work_request"]["description"],
            guide_paths=manifest.get("guide", {}).get("paths", []),
            plan_path=plan_path,
        )
        cmds[proj] = cmd
    return cmds


# ---------------------------------------------------------------------------
# Mode: master — workspace planner runs, all children get --plan
# ---------------------------------------------------------------------------


class TestMasterMode:
    """Master mode: _materialize_plan returns 'master', then main() runs the
    workspace planner and populates manifest['plan'] with project_plans.
    These tests replicate that two-step flow."""

    def _run_master_flow(self, workspace_root, workspace, run_dir):
        """Simulate the master-mode flow: _materialize_plan + planner + plan files."""
        from worca.scripts.run_workspace import (
            validate_workspace_plan,
            write_workspace_plan_files,
        )

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
        ])
        manifest = _make_manifest(workspace, workspace_root)

        mode = _materialize_plan(args, workspace, str(run_dir), manifest, parser)
        assert mode == "master"

        plan = _valid_workspace_plan()
        errors = validate_workspace_plan(plan, workspace)
        assert not errors

        project_plan_paths = write_workspace_plan_files(plan, str(run_dir))
        manifest["plan"] = {
            "workspace_plan_path": os.path.join(str(run_dir), "workspace-plan.json"),
            "project_plans": project_plan_paths,
        }
        return manifest

    def test_master_planner_populates_project_plans(
        self, workspace_root, workspace, run_dir,
    ):
        manifest = self._run_master_flow(workspace_root, workspace, run_dir)

        assert "plan" in manifest
        plan_paths = manifest["plan"]["project_plans"]
        assert set(plan_paths) == {"shared-lib", "backend", "frontend"}
        for name, path in plan_paths.items():
            assert os.path.isfile(path), f"plan file missing for {name}: {path}"

    def test_master_child_commands_include_plan(
        self, workspace_root, workspace, run_dir,
    ):
        manifest = self._run_master_flow(workspace_root, workspace, run_dir)

        cmds = _child_cmds_from_manifest(manifest)
        for proj, cmd in cmds.items():
            assert "--plan" in cmd, f"{proj} child missing --plan"
            plan_idx = cmd.index("--plan")
            plan_path = cmd[plan_idx + 1]
            assert os.path.isfile(plan_path), (
                f"{proj} --plan points to non-existent file: {plan_path}"
            )

    def test_master_dag_executor_forwards_plan(
        self, workspace_root, workspace, run_dir,
    ):
        """DagExecutor reads project_plans from the manifest and forwards --plan."""
        manifest = self._run_master_flow(workspace_root, workspace, run_dir)

        executor = DagExecutor(manifest, str(run_dir))
        assert executor._project_plans == manifest["plan"]["project_plans"]
        for proj in ("shared-lib", "backend", "frontend"):
            assert proj in executor._project_plans


# ---------------------------------------------------------------------------
# Mode: existing — user supplies workspace-plan.json
# ---------------------------------------------------------------------------


class TestExistingMode:
    def test_existing_loads_and_materializes_plans(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        plan_file = tmp_path / "workspace-plan.json"
        plan_file.write_text(json.dumps(_valid_workspace_plan(), indent=2))

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--workspace-plan", str(plan_file),
        ])
        manifest = _make_manifest(workspace, workspace_root)

        mode = _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        assert mode == "existing"
        assert manifest["plan"]["source"] == "existing"
        plan_paths = manifest["plan"]["project_plans"]
        assert set(plan_paths) == {"shared-lib", "backend", "frontend"}

    def test_existing_child_commands_include_plan(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        plan_file = tmp_path / "workspace-plan.json"
        plan_file.write_text(json.dumps(_valid_workspace_plan(), indent=2))

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--workspace-plan", str(plan_file),
        ])
        manifest = _make_manifest(workspace, workspace_root)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        cmds = _child_cmds_from_manifest(manifest)
        for proj, cmd in cmds.items():
            assert "--plan" in cmd, f"{proj} child missing --plan"
            plan_idx = cmd.index("--plan")
            assert os.path.isfile(cmd[plan_idx + 1])

    def test_existing_dag_executor_reads_project_plans(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        plan_file = tmp_path / "workspace-plan.json"
        plan_file.write_text(json.dumps(_valid_workspace_plan(), indent=2))

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--workspace-plan", str(plan_file),
        ])
        manifest = _make_manifest(workspace, workspace_root)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        executor = DagExecutor(manifest, str(run_dir))
        for proj in ("shared-lib", "backend", "frontend"):
            assert proj in executor._project_plans
            assert os.path.isfile(executor._project_plans[proj])

    def test_existing_writes_workspace_plan_json_to_run_dir(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        plan_file = tmp_path / "workspace-plan.json"
        plan_file.write_text(json.dumps(_valid_workspace_plan(), indent=2))

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--workspace-plan", str(plan_file),
        ])
        manifest = _make_manifest(workspace, workspace_root)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        assert manifest["plan"]["workspace_plan_path"] is not None
        assert os.path.isfile(manifest["plan"]["workspace_plan_path"])
        stored = json.loads(Path(manifest["plan"]["workspace_plan_path"]).read_text())
        assert stored["summary"] == "Cross-project refactor"


# ---------------------------------------------------------------------------
# Mode: per-repo — partial coverage, uncovered projects get no --plan
# ---------------------------------------------------------------------------


class TestPerRepoMode:
    def test_per_repo_covered_projects_get_plan(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        lib_plan = tmp_path / "lib-plan.md"
        lib_plan.write_text("# Plan for shared-lib\nAdd shared types\n")
        backend_plan = tmp_path / "backend-plan.md"
        backend_plan.write_text("# Plan for backend\nConsume shared types\n")

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--project-plan", f"shared-lib={lib_plan}",
            "--project-plan", f"backend={backend_plan}",
        ])
        manifest = _make_manifest(workspace, workspace_root)

        mode = _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        assert mode == "per-repo"
        assert manifest["plan"]["source"] == "per-repo"
        plan_paths = manifest["plan"]["project_plans"]
        assert "shared-lib" in plan_paths
        assert "backend" in plan_paths
        assert "frontend" not in plan_paths

    def test_per_repo_child_commands_selective_plan(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        lib_plan = tmp_path / "lib-plan.md"
        lib_plan.write_text("# Plan for shared-lib\nAdd shared types\n")
        backend_plan = tmp_path / "backend-plan.md"
        backend_plan.write_text("# Plan for backend\nConsume shared types\n")

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--project-plan", f"shared-lib={lib_plan}",
            "--project-plan", f"backend={backend_plan}",
        ])
        manifest = _make_manifest(workspace, workspace_root)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        cmds = _child_cmds_from_manifest(manifest)

        assert "--plan" in cmds["shared-lib"]
        assert "--plan" in cmds["backend"]
        assert "--plan" not in cmds["frontend"], (
            "frontend (uncovered) should NOT get --plan"
        )

    def test_per_repo_full_coverage(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        plans = {}
        for name in ("shared-lib", "backend", "frontend"):
            p = tmp_path / f"{name}-plan.md"
            p.write_text(f"# Plan for {name}\nDo things\n")
            plans[name] = p

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--project-plan", f"shared-lib={plans['shared-lib']}",
            "--project-plan", f"backend={plans['backend']}",
            "--project-plan", f"frontend={plans['frontend']}",
        ])
        manifest = _make_manifest(workspace, workspace_root)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        cmds = _child_cmds_from_manifest(manifest)
        for proj in ("shared-lib", "backend", "frontend"):
            assert "--plan" in cmds[proj], f"{proj} missing --plan with full coverage"

    def test_per_repo_dag_executor_partial(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        lib_plan = tmp_path / "lib-plan.md"
        lib_plan.write_text("# Plan for shared-lib\n")

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--project-plan", f"shared-lib={lib_plan}",
        ])
        manifest = _make_manifest(workspace, workspace_root)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        executor = DagExecutor(manifest, str(run_dir))
        assert "shared-lib" in executor._project_plans
        assert "backend" not in executor._project_plans
        assert "frontend" not in executor._project_plans

    def test_per_repo_no_workspace_plan_path(
        self, workspace_root, workspace, run_dir, tmp_path,
    ):
        lib_plan = tmp_path / "lib-plan.md"
        lib_plan.write_text("# Plan\n")

        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor",
            "--project-plan", f"shared-lib={lib_plan}",
        ])
        manifest = _make_manifest(workspace, workspace_root)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        assert manifest["plan"]["workspace_plan_path"] is None


# ---------------------------------------------------------------------------
# Mode: independent — --skip-planning, no --plan on any child
# ---------------------------------------------------------------------------


class TestIndependentMode:
    def test_independent_returns_mode(self, workspace_root, workspace, run_dir):
        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--skip-planning",
        ])
        manifest = _make_manifest(workspace, workspace_root, skip_planning=True)

        mode = _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        assert mode == "independent"

    def test_independent_no_plan_in_manifest(
        self, workspace_root, workspace, run_dir,
    ):
        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--skip-planning",
        ])
        manifest = _make_manifest(workspace, workspace_root, skip_planning=True)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        assert "plan" not in manifest

    def test_independent_child_commands_no_plan(
        self, workspace_root, workspace, run_dir,
    ):
        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--skip-planning",
        ])
        manifest = _make_manifest(workspace, workspace_root, skip_planning=True)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        cmds = _child_cmds_from_manifest(manifest)
        for proj, cmd in cmds.items():
            assert "--plan" not in cmd, (
                f"{proj} should NOT get --plan in independent mode"
            )

    def test_independent_dag_executor_empty_plans(
        self, workspace_root, workspace, run_dir,
    ):
        parser = create_parser()
        args = parser.parse_args([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--skip-planning",
        ])
        manifest = _make_manifest(workspace, workspace_root, skip_planning=True)
        _materialize_plan(args, workspace, str(run_dir), manifest, parser)

        executor = DagExecutor(manifest, str(run_dir))
        assert executor._project_plans == {}


# ---------------------------------------------------------------------------
# Cross-mode: DagExecutor _build_child_cmd contract
# ---------------------------------------------------------------------------


class TestBuildChildCmdContract:
    def test_plan_path_present_adds_flag(self):
        cmd = _build_child_cmd(
            workspace_id="ws_test",
            prompt="do things",
            guide_paths=[],
            plan_path="/tmp/some-plan.md",
        )
        assert "--plan" in cmd
        idx = cmd.index("--plan")
        assert cmd[idx + 1] == "/tmp/some-plan.md"

    def test_plan_path_none_omits_flag(self):
        cmd = _build_child_cmd(
            workspace_id="ws_test",
            prompt="do things",
            guide_paths=[],
            plan_path=None,
        )
        assert "--plan" not in cmd

    def test_plan_path_empty_string_omits_flag(self):
        cmd = _build_child_cmd(
            workspace_id="ws_test",
            prompt="do things",
            guide_paths=[],
            plan_path="",
        )
        assert "--plan" not in cmd

    def test_guides_coexist_with_plan(self):
        cmd = _build_child_cmd(
            workspace_id="ws_test",
            prompt="do things",
            guide_paths=["/tmp/guide1.md", "/tmp/guide2.md"],
            plan_path="/tmp/plan.md",
        )
        assert "--plan" in cmd
        assert cmd.count("--guide") == 2


# ---------------------------------------------------------------------------
# End-to-end: main() with patched DagExecutor for each mode
# ---------------------------------------------------------------------------


class TestMainDispatchesModes:
    """Call main() for each mode, patching DagExecutor.execute to capture
    the manifest state after _materialize_plan populates it."""

    def _run_main(self, argv, *, planner_return=None):
        """Run main() with DagExecutor.execute and event emission patched out.

        Returns the manifest that DagExecutor was instantiated with.
        """
        captured = {}

        original_init = DagExecutor.__init__

        def spy_init(self_executor, manifest, run_dir_arg, **kwargs):
            captured["manifest"] = manifest
            captured["run_dir"] = run_dir_arg
            original_init(self_executor, manifest, run_dir_arg, **kwargs)

        patches = [
            patch.object(DagExecutor, "__init__", spy_init),
            patch.object(
                DagExecutor, "execute",
                return_value={"status": "completed", "completed": 3, "failed": 0},
            ),
            patch("worca.scripts.run_workspace.emit_workspace_event"),
            patch("worca.scripts.run_workspace._install_signal_handlers"),
            patch("worca.scripts.run_workspace.write_pointer_file"),
        ]
        if planner_return is not None:
            patches.append(
                patch(
                    "worca.scripts.run_workspace.run_workspace_planner",
                    return_value=planner_return,
                )
            )

        for p in patches:
            p.start()
        try:
            from worca.scripts.run_workspace import main
            rc = main(argv)
        finally:
            for p in patches:
                p.stop()

        assert rc == 0, f"main() returned {rc}"
        return captured["manifest"]

    def test_main_master_mode(self, workspace_root, tmp_path):
        manifest = self._run_main(
            [str(workspace_root), "--prompt", "Refactor shared types"],
            planner_return=_valid_workspace_plan(),
        )

        assert "plan" in manifest
        plan_paths = manifest["plan"]["project_plans"]
        assert set(plan_paths) == {"shared-lib", "backend", "frontend"}
        cmds = _child_cmds_from_manifest(manifest)
        for proj in ("shared-lib", "backend", "frontend"):
            assert "--plan" in cmds[proj]

    def test_main_existing_mode(self, workspace_root, tmp_path):
        plan_file = tmp_path / "ws-plan.json"
        plan_file.write_text(json.dumps(_valid_workspace_plan()))

        manifest = self._run_main([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--workspace-plan", str(plan_file),
        ])

        assert manifest["plan"]["source"] == "existing"
        cmds = _child_cmds_from_manifest(manifest)
        for proj in ("shared-lib", "backend", "frontend"):
            assert "--plan" in cmds[proj]

    def test_main_per_repo_partial(self, workspace_root, tmp_path):
        lib_plan = tmp_path / "lib.md"
        lib_plan.write_text("# Shared lib plan\n")

        manifest = self._run_main([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--project-plan", f"shared-lib={lib_plan}",
        ])

        assert manifest["plan"]["source"] == "per-repo"
        cmds = _child_cmds_from_manifest(manifest)
        assert "--plan" in cmds["shared-lib"]
        assert "--plan" not in cmds["backend"]
        assert "--plan" not in cmds["frontend"]

    def test_main_independent_mode(self, workspace_root):
        manifest = self._run_main([
            str(workspace_root), "--prompt", "Refactor shared types",
            "--skip-planning",
        ])

        assert "plan" not in manifest
        cmds = _child_cmds_from_manifest(manifest)
        for proj in ("shared-lib", "backend", "frontend"):
            assert "--plan" not in cmds[proj]
