"""Tests for run_workspace.py scaffold + dry-run (W-047-05)."""
import json
import os

import pytest


# ---- helpers ----------------------------------------------------------------

def _write_workspace_json(tmp_path, doc=None):
    """Write a workspace.json into tmp_path and return str(tmp_path)."""
    if doc is None:
        doc = _linear_chain_doc()
    p = tmp_path / "workspace.json"
    p.write_text(json.dumps(doc))
    return str(tmp_path)


def _minimal_doc():
    return {
        "name": "my-platform",
        "projects": [
            {"name": "lib", "path": "lib", "depends_on": []},
        ],
    }


def _linear_chain_doc():
    """lib -> backend -> frontend (3 tiers)."""
    return {
        "name": "my-platform",
        "projects": [
            {"name": "lib", "path": "lib", "depends_on": []},
            {"name": "backend", "path": "backend", "depends_on": ["lib"]},
            {"name": "frontend", "path": "frontend", "depends_on": ["backend"]},
        ],
    }


def _diamond_doc():
    """Diamond: lib -> (backend, worker) -> frontend."""
    return {
        "name": "diamond",
        "projects": [
            {"name": "lib", "path": "lib", "depends_on": []},
            {"name": "backend", "path": "backend", "depends_on": ["lib"]},
            {"name": "worker", "path": "worker", "depends_on": ["lib"]},
            {"name": "frontend", "path": "frontend", "depends_on": ["backend", "worker"]},
        ],
    }


# ---- arg parsing ------------------------------------------------------------

class TestArgParsing:
    def test_create_parser_returns_parser(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        assert parser is not None

    def test_prompt_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "Add user profiles"])
        assert args.prompt == "Add user profiles"

    def test_source_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--source", "gh:issue:42"])
        assert args.source == "gh:issue:42"

    def test_prompt_and_source_mutually_exclusive(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["/some/path", "--prompt", "x", "--source", "y"])

    def test_guide_flag_repeatable(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args([
            "/some/path", "--prompt", "x",
            "--guide", "a.md", "--guide", "b.md",
        ])
        assert args.guide == ["a.md", "b.md"]

    def test_branch_template_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args([
            "/some/path", "--prompt", "x",
            "--branch", "workspace/{slug}/{project}",
        ])
        assert args.branch == "workspace/{slug}/{project}"

    def test_branch_template_default(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x"])
        assert args.branch == "workspace/{slug}/{project}"

    def test_skip_integration_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x", "--skip-integration"])
        assert args.skip_integration is True

    def test_skip_planning_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x", "--skip-planning"])
        assert args.skip_planning is True

    def test_resume_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--resume", "ws_202601011200_abc12345"])
        assert args.resume == "ws_202601011200_abc12345"

    def test_max_parallel_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x", "--max-parallel", "3"])
        assert args.max_parallel == 3

    def test_max_parallel_default(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x"])
        assert args.max_parallel == 5

    def test_dry_run_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x", "--dry-run"])
        assert args.dry_run is True

    def test_dry_run_default_false(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x"])
        assert args.dry_run is False

    def test_workspace_root_positional(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/path/to/parent", "--prompt", "x"])
        assert args.workspace_root == "/path/to/parent"

    def test_workspace_root_required(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["--prompt", "x"])

    def test_workspace_plan_flag(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args([
            "/some/path", "--prompt", "x",
            "--workspace-plan", "/tmp/workspace-plan.json",
        ])
        assert args.workspace_plan == "/tmp/workspace-plan.json"

    def test_project_plan_flag_repeatable(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args([
            "/some/path", "--prompt", "x",
            "--project-plan", "api=/tmp/api-plan.md",
            "--project-plan", "web=/tmp/web-plan.md",
        ])
        assert args.project_plan == ["api=/tmp/api-plan.md", "web=/tmp/web-plan.md"]

    def test_workspace_plan_and_project_plan_mutually_exclusive(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args([
                "/some/path", "--prompt", "x",
                "--workspace-plan", "/tmp/ws.json",
                "--project-plan", "api=/tmp/api.md",
            ])

    def test_skip_planning_help_text_updated(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        for action in parser._actions:
            if "--skip-planning" in action.option_strings:
                assert "--plan" not in action.help
                assert "every child runs its own Planner" in action.help
                break
        else:
            pytest.fail("--skip-planning not found")


# ---- workspace ID generation ------------------------------------------------

class TestWorkspaceIdGeneration:
    def test_generate_workspace_id_format(self):
        from worca.scripts.run_workspace import generate_workspace_id

        ws_id, ws_id_short = generate_workspace_id()
        assert ws_id.startswith("ws_")
        parts = ws_id.split("_")
        assert len(parts) == 3
        assert len(parts[1]) == 12  # yyyymmddhhmm
        assert len(parts[2]) == 8   # hex suffix

    def test_generate_workspace_id_short_matches(self):
        from worca.scripts.run_workspace import generate_workspace_id

        ws_id, ws_id_short = generate_workspace_id()
        assert ws_id.endswith(ws_id_short)

    def test_generate_workspace_id_deterministic_with_now(self):
        from datetime import datetime, timezone
        from worca.scripts.run_workspace import generate_workspace_id

        now = datetime(2026, 1, 15, 10, 30, tzinfo=timezone.utc)
        ws_id, _ = generate_workspace_id(now=now)
        assert ws_id.startswith("ws_202601151030_")

    def test_generate_workspace_id_unique(self):
        from worca.scripts.run_workspace import generate_workspace_id

        ids = {generate_workspace_id()[0] for _ in range(20)}
        assert len(ids) == 20


# ---- run directory creation -------------------------------------------------

class TestRunDirectory:
    def test_create_workspace_run_dir(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_run_dir

        ws_id = "ws_202601011200_abc12345"
        run_dir = create_workspace_run_dir(str(tmp_path), ws_id)

        expected = os.path.join(str(tmp_path), ".worca", "workspace-runs", ws_id)
        assert run_dir == expected
        assert os.path.isdir(run_dir)

    def test_create_workspace_run_dir_idempotent(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_run_dir

        ws_id = "ws_202601011200_abc12345"
        run_dir1 = create_workspace_run_dir(str(tmp_path), ws_id)
        run_dir2 = create_workspace_run_dir(str(tmp_path), ws_id)
        assert run_dir1 == run_dir2
        assert os.path.isdir(run_dir2)

    def test_create_workspace_run_dir_creates_parents(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_run_dir

        workspace_root = str(tmp_path / "deep" / "nested")
        ws_id = "ws_202601011200_abc12345"
        run_dir = create_workspace_run_dir(workspace_root, ws_id)
        assert os.path.isdir(run_dir)


# ---- pointer file -----------------------------------------------------------

class TestPointerFile:
    def test_write_pointer_file(self, tmp_path):
        from worca.scripts.run_workspace import write_pointer_file

        ws_id = "ws_202601011200_abc12345"
        workspace_root = "/abs/path/to/parent"
        pointer_dir = str(tmp_path / "workspace-runs")

        write_pointer_file(ws_id, workspace_root, pointer_dir=pointer_dir)

        pointer_path = os.path.join(pointer_dir, f"{ws_id}.json")
        assert os.path.isfile(pointer_path)

        with open(pointer_path) as f:
            data = json.load(f)
        assert data["workspace_root"] == workspace_root
        assert data["workspace_id"] == ws_id

    def test_pointer_file_creates_directory(self, tmp_path):
        from worca.scripts.run_workspace import write_pointer_file

        ws_id = "ws_202601011200_abc12345"
        pointer_dir = str(tmp_path / "does-not-exist")

        write_pointer_file(ws_id, "/some/path", pointer_dir=pointer_dir)
        assert os.path.isdir(pointer_dir)

    def test_pointer_file_atomic_write(self, tmp_path):
        from worca.scripts.run_workspace import write_pointer_file

        ws_id = "ws_202601011200_abc12345"
        pointer_dir = str(tmp_path / "workspace-runs")

        write_pointer_file(ws_id, "/path/1", pointer_dir=pointer_dir)
        write_pointer_file(ws_id, "/path/2", pointer_dir=pointer_dir)

        pointer_path = os.path.join(pointer_dir, f"{ws_id}.json")
        with open(pointer_path) as f:
            data = json.load(f)
        assert data["workspace_root"] == "/path/2"


# ---- workspace manifest -----------------------------------------------------

class TestWorkspaceManifest:
    def test_create_workspace_manifest(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_manifest

        ws_id = "ws_202601011200_abc12345"
        workspace_root = str(tmp_path)
        _write_workspace_json(tmp_path)

        manifest = create_workspace_manifest(
            workspace_id=ws_id,
            workspace_root=workspace_root,
            workspace_name="my-platform",
            prompt="Add user profiles",
            source=None,
            guide_paths=[],
            branch_template="workspace/{slug}/{project}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"], ["backend"], ["frontend"]],
            projects_by_name={"lib": "lib", "backend": "backend", "frontend": "frontend"},
            dependency_graph={"lib": [], "backend": ["lib"], "frontend": ["backend"]},
        )

        assert manifest["workspace_id"] == ws_id
        assert manifest["workspace_name"] == "my-platform"
        assert manifest["workspace_root"] == workspace_root
        assert manifest["work_request"]["description"] == "Add user profiles"
        assert manifest["work_request"]["source"] is None
        assert manifest["status"] == "planning"
        assert manifest["halt_reason"] is None
        assert len(manifest["dag"]["tiers"]) == 3
        assert manifest["dag"]["tiers"][0]["tier"] == 0
        assert manifest["dag"]["tiers"][0]["projects"] == ["lib"]
        assert manifest["dag"]["tiers"][0]["status"] == "pending"
        assert manifest["children"] == []
        assert "created_at" in manifest
        assert manifest["dag"]["dependency_graph"] == {"lib": [], "backend": ["lib"], "frontend": ["backend"]}
        assert manifest["projects_by_name"] == {"lib": "lib", "backend": "backend", "frontend": "frontend"}
        assert "repos_info" not in manifest
        assert manifest["failure_threshold"] is None

    def test_manifest_with_failure_threshold(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_manifest

        manifest = create_workspace_manifest(
            workspace_id="ws_x",
            workspace_root=str(tmp_path),
            workspace_name="test",
            prompt="x",
            source=None,
            guide_paths=[],
            branch_template="workspace/{slug}/{project}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            projects_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
            failure_threshold=0.30,
        )
        assert manifest["failure_threshold"] == 0.30

    def test_manifest_with_source(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_manifest

        manifest = create_workspace_manifest(
            workspace_id="ws_x",
            workspace_root=str(tmp_path),
            workspace_name="test",
            prompt=None,
            source="gh:issue:42",
            guide_paths=[],
            branch_template="workspace/{slug}/{project}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            projects_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
        )
        assert manifest["work_request"]["source"] == "gh:issue:42"
        assert manifest["work_request"]["description"] == ""

    def test_manifest_with_guides(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_manifest

        guide_a = tmp_path / "guide-a.md"
        guide_a.write_text("# Guide A")
        guide_b = tmp_path / "guide-b.md"
        guide_b.write_text("# Guide B content here")

        manifest = create_workspace_manifest(
            workspace_id="ws_x",
            workspace_root=str(tmp_path),
            workspace_name="test",
            prompt="x",
            source=None,
            guide_paths=[str(guide_a), str(guide_b)],
            branch_template="workspace/{slug}/{project}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            projects_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
        )

        assert len(manifest["guide"]["paths"]) == 2
        assert manifest["guide"]["filenames"] == ["guide-a.md", "guide-b.md"]
        assert manifest["guide"]["bytes"] > 0

    def test_write_workspace_manifest(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_workspace_manifest,
            write_workspace_manifest,
        )

        ws_id = "ws_202601011200_abc12345"
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        manifest = create_workspace_manifest(
            workspace_id=ws_id,
            workspace_root=str(tmp_path),
            workspace_name="test",
            prompt="x",
            source=None,
            guide_paths=[],
            branch_template="workspace/{slug}/{project}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            projects_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
        )

        path = write_workspace_manifest(manifest, run_dir)
        assert os.path.isfile(path)
        assert path.endswith("workspace-manifest.json")

        with open(path) as f:
            loaded = json.load(f)
        assert loaded["workspace_id"] == ws_id


# ---- dry-run mode -----------------------------------------------------------

class TestDryRun:
    def test_dry_run_prints_dag(self, tmp_path, capsys):
        from worca.scripts.run_workspace import main

        _write_workspace_json(tmp_path, _linear_chain_doc())

        exit_code = main([str(tmp_path), "--prompt", "Add profiles", "--dry-run"])
        assert exit_code == 0

        captured = capsys.readouterr()
        assert "Tier 0" in captured.out
        assert "lib" in captured.out
        assert "Tier 1" in captured.out
        assert "backend" in captured.out
        assert "Tier 2" in captured.out
        assert "frontend" in captured.out

    def test_dry_run_diamond(self, tmp_path, capsys):
        from worca.scripts.run_workspace import main

        _write_workspace_json(tmp_path, _diamond_doc())

        exit_code = main([str(tmp_path), "--prompt", "x", "--dry-run"])
        assert exit_code == 0

        captured = capsys.readouterr()
        assert "Tier 0" in captured.out
        assert "lib" in captured.out
        assert "Tier 1" in captured.out
        assert "backend" in captured.out
        assert "worker" in captured.out
        assert "Tier 2" in captured.out
        assert "frontend" in captured.out

    def test_dry_run_no_dispatch(self, tmp_path, monkeypatch):
        """Dry-run must NOT spawn any child processes."""
        import subprocess
        from worca.scripts.run_workspace import main

        calls = []
        original_popen = subprocess.Popen
        def tracking_popen(*args, **kwargs):
            calls.append(args)
            return original_popen(*args, **kwargs)

        monkeypatch.setattr(subprocess, "Popen", tracking_popen)

        _write_workspace_json(tmp_path, _linear_chain_doc())
        main([str(tmp_path), "--prompt", "x", "--dry-run"])
        assert len(calls) == 0

    def test_dry_run_does_not_create_run_dir(self, tmp_path):
        from worca.scripts.run_workspace import main

        _write_workspace_json(tmp_path, _minimal_doc())
        main([str(tmp_path), "--prompt", "x", "--dry-run"])

        worca_dir = tmp_path / ".worca" / "workspace-runs"
        assert not worca_dir.exists()

    def test_dry_run_does_not_create_pointer(self, tmp_path):
        from worca.scripts.run_workspace import main

        _write_workspace_json(tmp_path, _minimal_doc())
        main([str(tmp_path), "--prompt", "x", "--dry-run"])

        pointer_dir = os.path.expanduser("~/.worca/workspace-runs")
        if os.path.isdir(pointer_dir):
            pointers = [f for f in os.listdir(pointer_dir) if f.endswith(".json")]
            for p in pointers:
                with open(os.path.join(pointer_dir, p)) as f:
                    data = json.load(f)
                assert data.get("workspace_root") != str(tmp_path)

    def test_dry_run_shows_workspace_name(self, tmp_path, capsys):
        from worca.scripts.run_workspace import main

        _write_workspace_json(tmp_path, _linear_chain_doc())
        main([str(tmp_path), "--prompt", "x", "--dry-run"])

        captured = capsys.readouterr()
        assert "my-platform" in captured.out

    def test_dry_run_shows_repo_count(self, tmp_path, capsys):
        from worca.scripts.run_workspace import main

        _write_workspace_json(tmp_path, _linear_chain_doc())
        main([str(tmp_path), "--prompt", "x", "--dry-run"])

        captured = capsys.readouterr()
        assert "3" in captured.out

    def test_dry_run_shows_skip_integration(self, tmp_path, capsys):
        from worca.scripts.run_workspace import main

        doc = _linear_chain_doc()
        doc["integration_test"] = {"command": "make test", "working_dir": "."}
        _write_workspace_json(tmp_path, doc)
        main([str(tmp_path), "--prompt", "x", "--dry-run", "--skip-integration"])

        captured = capsys.readouterr()
        assert "skip" in captured.out.lower()


# ---- error handling ---------------------------------------------------------

# ---- _materialize_plan dispatcher -------------------------------------------

def _valid_workspace_plan():
    return {
        "summary": "Add user profiles across the platform",
        "projects": [
            {
                "name": "lib",
                "description": "Add profile model",
                "acceptance_criteria": ["Profile model exists"],
                "depends_on": [],
            },
            {
                "name": "backend",
                "description": "Add profile API",
                "acceptance_criteria": ["GET /profiles works"],
                "depends_on": ["lib"],
            },
            {
                "name": "frontend",
                "description": "Add profile page",
                "acceptance_criteria": ["Profile page renders"],
                "depends_on": ["backend"],
            },
        ],
        "integration_expectations": ["All profiles sync"],
    }


class TestMaterializePlanConflictGuard:
    def test_skip_planning_with_workspace_plan_rejected(self):
        from worca.scripts.run_workspace import create_parser, _materialize_plan

        parser = create_parser()
        args = parser.parse_args([
            "/some/path", "--prompt", "x",
            "--skip-planning", "--workspace-plan", "/tmp/plan.json",
        ])
        with pytest.raises(SystemExit):
            _materialize_plan(args, None, "/tmp/run", {}, parser)

    def test_skip_planning_with_project_plan_rejected(self):
        from worca.scripts.run_workspace import create_parser, _materialize_plan

        parser = create_parser()
        args = parser.parse_args([
            "/some/path", "--prompt", "x",
            "--skip-planning", "--project-plan", "lib=/tmp/lib.md",
        ])
        with pytest.raises(SystemExit):
            _materialize_plan(args, None, "/tmp/run", {}, parser)


class TestMaterializePlanIndependent:
    def test_independent_returns_independent(self):
        from worca.scripts.run_workspace import create_parser, _materialize_plan

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x", "--skip-planning"])
        result = _materialize_plan(args, None, "/tmp/run", {}, parser)
        assert result == "independent"

    def test_independent_does_not_set_plan_key(self):
        from worca.scripts.run_workspace import create_parser, _materialize_plan

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x", "--skip-planning"])
        manifest = {}
        _materialize_plan(args, None, "/tmp/run", manifest, parser)
        assert "plan" not in manifest


class TestMaterializePlanExisting:
    def test_existing_happy_path(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        plan = _valid_workspace_plan()
        plan_file = tmp_path / "workspace-plan.json"
        plan_file.write_text(json.dumps(plan))

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--workspace-plan", str(plan_file),
        ])
        manifest = {}
        result = _materialize_plan(args, ws, run_dir, manifest, parser)

        assert result == "existing"
        assert "plan" in manifest
        assert manifest["plan"]["source"] == "existing"
        assert "lib" in manifest["plan"]["project_plans"]
        assert "backend" in manifest["plan"]["project_plans"]
        assert "frontend" in manifest["plan"]["project_plans"]

    def test_existing_invalid_json(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan, WorkspacePlanError,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        plan_file = tmp_path / "bad.json"
        plan_file.write_text("not json {{{")

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--workspace-plan", str(plan_file),
        ])
        with pytest.raises(WorkspacePlanError):
            _materialize_plan(args, ws, run_dir, {}, parser)

    def test_existing_schema_validation_failure(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan, WorkspacePlanError,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        plan_file = tmp_path / "bad-schema.json"
        plan_file.write_text(json.dumps({"summary": "x"}))

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--workspace-plan", str(plan_file),
        ])
        with pytest.raises(WorkspacePlanError):
            _materialize_plan(args, ws, run_dir, {}, parser)

    def test_existing_file_not_found(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan, WorkspacePlanError,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--workspace-plan", "/nonexistent/plan.json",
        ])
        with pytest.raises(WorkspacePlanError):
            _materialize_plan(args, ws, "/tmp/run", {}, parser)


class TestMaterializePlanPerRepo:
    def test_per_repo_full_coverage(self, tmp_path):
        from worca.scripts.run_workspace import create_parser, _materialize_plan
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        for name in ("lib", "backend", "frontend"):
            (tmp_path / f"{name}-plan.md").write_text(f"# Plan for {name}\nDo stuff.")

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", f"lib={tmp_path / 'lib-plan.md'}",
            "--project-plan", f"backend={tmp_path / 'backend-plan.md'}",
            "--project-plan", f"frontend={tmp_path / 'frontend-plan.md'}",
        ])
        manifest = {}
        result = _materialize_plan(args, ws, run_dir, manifest, parser)

        assert result == "per-repo"
        assert manifest["plan"]["source"] == "per-repo"
        assert len(manifest["plan"]["project_plans"]) == 3

    def test_per_repo_partial_coverage(self, tmp_path):
        from worca.scripts.run_workspace import create_parser, _materialize_plan
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        (tmp_path / "lib-plan.md").write_text("# Plan for lib")

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", f"lib={tmp_path / 'lib-plan.md'}",
        ])
        manifest = {}
        result = _materialize_plan(args, ws, run_dir, manifest, parser)

        assert result == "per-repo"
        assert "lib" in manifest["plan"]["project_plans"]
        assert "backend" not in manifest["plan"]["project_plans"]
        assert "frontend" not in manifest["plan"]["project_plans"]

    def test_per_repo_unknown_project(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan, WorkspacePlanError,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        (tmp_path / "unknown.md").write_text("# Plan")

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", f"unknown={tmp_path / 'unknown.md'}",
        ])
        with pytest.raises(WorkspacePlanError, match="unknown"):
            _materialize_plan(args, ws, run_dir, {}, parser)

    def test_per_repo_empty_plan_file(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan, WorkspacePlanError,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        (tmp_path / "lib-plan.md").write_text("   \n  \n  ")

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", f"lib={tmp_path / 'lib-plan.md'}",
        ])
        with pytest.raises(WorkspacePlanError, match="empty"):
            _materialize_plan(args, ws, run_dir, {}, parser)

    def test_per_repo_file_not_found(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan, WorkspacePlanError,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", "lib=/nonexistent/plan.md",
        ])
        with pytest.raises(WorkspacePlanError, match="not found"):
            _materialize_plan(args, ws, "/tmp/run", {}, parser)

    def test_per_repo_bad_format(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan, WorkspacePlanError,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", "no-equals-sign",
        ])
        with pytest.raises(WorkspacePlanError, match="NAME=PATH"):
            _materialize_plan(args, ws, "/tmp/run", {}, parser)

    def test_per_repo_copies_files_to_run_dir(self, tmp_path):
        from worca.scripts.run_workspace import create_parser, _materialize_plan
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        (tmp_path / "lib-plan.md").write_text("# Lib plan content")

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", f"lib={tmp_path / 'lib-plan.md'}",
        ])
        manifest = {}
        _materialize_plan(args, ws, run_dir, manifest, parser)

        plan_path = manifest["plan"]["project_plans"]["lib"]
        assert plan_path.startswith(run_dir)
        assert os.path.isfile(plan_path)
        with open(plan_path) as f:
            assert "Lib plan content" in f.read()


class TestMaterializePlanEvents:
    """_materialize_plan emits WORKSPACE_PLAN_LOADED / WORKSPACE_PLAN_PARTIAL."""

    def test_existing_emits_plan_loaded(self, tmp_path, monkeypatch):
        from unittest.mock import MagicMock
        from worca.events import types as event_types
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        plan = _valid_workspace_plan()
        plan_file = tmp_path / "workspace-plan.json"
        plan_file.write_text(json.dumps(plan))

        mock_emit = MagicMock()
        monkeypatch.setattr(
            "worca.scripts.run_workspace.emit_workspace_event", mock_emit,
        )

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--workspace-plan", str(plan_file),
        ])
        manifest = {}
        _materialize_plan(
            args, ws, run_dir, manifest, parser,
            workspace_id="ws_test", settings_path="/tmp/s.json",
        )

        assert mock_emit.call_count == 1
        call_args = mock_emit.call_args
        assert call_args[0][1] == event_types.WORKSPACE_PLAN_LOADED
        payload = call_args[0][2]
        assert payload["mode"] == "existing"
        assert set(payload["covered_projects"]) == {"lib", "backend", "frontend"}

    def test_per_repo_full_coverage_emits_plan_loaded(self, tmp_path, monkeypatch):
        from unittest.mock import MagicMock
        from worca.events import types as event_types
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        for name in ("lib", "backend", "frontend"):
            (tmp_path / f"{name}-plan.md").write_text(f"# Plan for {name}\nDo stuff.")

        mock_emit = MagicMock()
        monkeypatch.setattr(
            "worca.scripts.run_workspace.emit_workspace_event", mock_emit,
        )

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", f"lib={tmp_path / 'lib-plan.md'}",
            "--project-plan", f"backend={tmp_path / 'backend-plan.md'}",
            "--project-plan", f"frontend={tmp_path / 'frontend-plan.md'}",
        ])
        manifest = {}
        _materialize_plan(
            args, ws, run_dir, manifest, parser,
            workspace_id="ws_test", settings_path="/tmp/s.json",
        )

        assert mock_emit.call_count == 1
        call_args = mock_emit.call_args
        assert call_args[0][1] == event_types.WORKSPACE_PLAN_LOADED
        payload = call_args[0][2]
        assert payload["mode"] == "per-repo"

    def test_per_repo_partial_coverage_emits_plan_partial(self, tmp_path, monkeypatch):
        from unittest.mock import MagicMock
        from worca.events import types as event_types
        from worca.scripts.run_workspace import (
            create_parser, _materialize_plan,
        )
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        (tmp_path / "lib-plan.md").write_text("# Plan for lib\nDo stuff.")

        mock_emit = MagicMock()
        monkeypatch.setattr(
            "worca.scripts.run_workspace.emit_workspace_event", mock_emit,
        )

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--project-plan", f"lib={tmp_path / 'lib-plan.md'}",
        ])
        manifest = {}
        _materialize_plan(
            args, ws, run_dir, manifest, parser,
            workspace_id="ws_test", settings_path="/tmp/s.json",
        )

        assert mock_emit.call_count == 1
        call_args = mock_emit.call_args
        assert call_args[0][1] == event_types.WORKSPACE_PLAN_PARTIAL
        payload = call_args[0][2]
        assert payload["mode"] == "per-repo"
        assert payload["covered_projects"] == ["lib"]
        assert set(payload["uncovered_projects"]) == {"backend", "frontend"}

    def test_independent_no_event(self, monkeypatch):
        from unittest.mock import MagicMock
        from worca.scripts.run_workspace import create_parser, _materialize_plan

        mock_emit = MagicMock()
        monkeypatch.setattr(
            "worca.scripts.run_workspace.emit_workspace_event", mock_emit,
        )

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x", "--skip-planning"])
        _materialize_plan(
            args, None, "/tmp/run", {}, parser,
            workspace_id="ws_test", settings_path="/tmp/s.json",
        )
        mock_emit.assert_not_called()

    def test_master_no_event(self, monkeypatch):
        from unittest.mock import MagicMock
        from worca.scripts.run_workspace import create_parser, _materialize_plan

        mock_emit = MagicMock()
        monkeypatch.setattr(
            "worca.scripts.run_workspace.emit_workspace_event", mock_emit,
        )

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x"])
        _materialize_plan(
            args, None, "/tmp/run", {}, parser,
            workspace_id="ws_test", settings_path="/tmp/s.json",
        )
        mock_emit.assert_not_called()

    def test_no_event_without_workspace_id(self, tmp_path, monkeypatch):
        """Backwards compat: no emission when workspace_id is not provided."""
        from unittest.mock import MagicMock
        from worca.scripts.run_workspace import create_parser, _materialize_plan
        from worca.workspace.manifest import Workspace

        ws_root = _write_workspace_json(tmp_path)
        ws = Workspace.load(ws_root)
        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)

        plan = _valid_workspace_plan()
        plan_file = tmp_path / "workspace-plan.json"
        plan_file.write_text(json.dumps(plan))

        mock_emit = MagicMock()
        monkeypatch.setattr(
            "worca.scripts.run_workspace.emit_workspace_event", mock_emit,
        )

        parser = create_parser()
        args = parser.parse_args([
            ws_root, "--prompt", "x",
            "--workspace-plan", str(plan_file),
        ])
        _materialize_plan(args, ws, run_dir, {}, parser)
        mock_emit.assert_not_called()


class TestLoadWorkspacePlanFromFile:
    def test_happy_path(self, tmp_path):
        from worca.scripts.run_workspace import _load_workspace_plan_from_file

        plan = _valid_workspace_plan()
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan))

        result = _load_workspace_plan_from_file(str(plan_file))
        assert result["summary"] == plan["summary"]

    def test_file_not_found(self):
        from worca.scripts.run_workspace import (
            _load_workspace_plan_from_file, WorkspacePlanError,
        )
        with pytest.raises(WorkspacePlanError, match="not found"):
            _load_workspace_plan_from_file("/nonexistent/plan.json")

    def test_invalid_json(self, tmp_path):
        from worca.scripts.run_workspace import (
            _load_workspace_plan_from_file, WorkspacePlanError,
        )
        bad = tmp_path / "bad.json"
        bad.write_text("{bad json")
        with pytest.raises(WorkspacePlanError, match="parse"):
            _load_workspace_plan_from_file(str(bad))


# ---- error handling ---------------------------------------------------------

class TestErrorHandling:
    def test_missing_workspace_json(self, tmp_path):
        from worca.scripts.run_workspace import main

        exit_code = main([str(tmp_path), "--prompt", "x", "--dry-run"])
        assert exit_code != 0

    def test_no_prompt_and_no_source_and_no_resume(self, tmp_path):
        from worca.scripts.run_workspace import main

        _write_workspace_json(tmp_path, _minimal_doc())
        exit_code = main([str(tmp_path)])
        assert exit_code != 0


# ---- W-069: --max-beads passthrough -----------------------------------------

class TestMaxBeadsWorkspace:
    """--max-beads is parsed and forwarded to dag_executor._build_child_cmd."""

    def _parse(self, argv):
        from worca.scripts.run_workspace import create_parser
        return create_parser().parse_args(argv)

    def test_max_beads_default_none(self, tmp_path):
        args = self._parse([str(tmp_path), "--prompt", "x"])
        assert args.max_beads is None

    def test_max_beads_parsed(self, tmp_path):
        args = self._parse([str(tmp_path), "--prompt", "x", "--max-beads", "5"])
        assert args.max_beads == 5

    def test_max_beads_zero_accepted(self, tmp_path):
        args = self._parse([str(tmp_path), "--prompt", "x", "--max-beads", "0"])
        assert args.max_beads == 0

    def test_build_child_cmd_includes_max_beads_when_set(self):
        from worca.workspace.dag_executor import _build_child_cmd
        cmd = _build_child_cmd(
            workspace_id="w-001",
            prompt="x",
            guide_paths=[],
            plan_path=None,
            max_beads=4,
        )
        idx = cmd.index("--max-beads")
        assert cmd[idx + 1] == "4"

    def test_build_child_cmd_omits_max_beads_when_none(self):
        from worca.workspace.dag_executor import _build_child_cmd
        cmd = _build_child_cmd(
            workspace_id="w-001",
            prompt="x",
            guide_paths=[],
            plan_path=None,
            max_beads=None,
        )
        assert "--max-beads" not in cmd

    def test_build_child_cmd_includes_max_beads_zero(self):
        from worca.workspace.dag_executor import _build_child_cmd
        cmd = _build_child_cmd(
            workspace_id="w-001",
            prompt="x",
            guide_paths=[],
            plan_path=None,
            max_beads=0,
        )
        idx = cmd.index("--max-beads")
        assert cmd[idx + 1] == "0"


# ---- Phase 5: --claude-md-mode passthrough -----------------------------------

class TestClaudeMdModeWorkspace:
    """--claude-md-mode is parsed and forwarded to dag_executor._build_child_cmd."""

    def _parse(self, argv):
        from worca.scripts.run_workspace import create_parser
        return create_parser().parse_args(argv)

    def test_claude_md_mode_default_none(self, tmp_path):
        args = self._parse([str(tmp_path), "--prompt", "x"])
        assert args.claude_md_mode is None

    def test_claude_md_mode_parsed(self, tmp_path):
        args = self._parse([str(tmp_path), "--prompt", "x", "--claude-md-mode", "project"])
        assert args.claude_md_mode == "project"

    def test_build_child_cmd_includes_claude_md_mode_when_set(self):
        from worca.workspace.dag_executor import _build_child_cmd
        cmd = _build_child_cmd(
            workspace_id="w-001",
            prompt="x",
            guide_paths=[],
            plan_path=None,
            claude_md_mode="project+local",
        )
        idx = cmd.index("--claude-md-mode")
        assert cmd[idx + 1] == "project+local"

    def test_build_child_cmd_omits_claude_md_mode_when_none(self):
        from worca.workspace.dag_executor import _build_child_cmd
        cmd = _build_child_cmd(
            workspace_id="w-001",
            prompt="x",
            guide_paths=[],
            plan_path=None,
            claude_md_mode=None,
        )
        assert "--claude-md-mode" not in cmd

    def test_create_workspace_manifest_persists_claude_md_mode(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_manifest
        manifest = create_workspace_manifest(
            workspace_id="ws_x",
            workspace_root=str(tmp_path),
            workspace_name="test",
            prompt="x",
            source=None,
            guide_paths=[],
            branch_template="ws/{slug}/{project}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            projects_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
            claude_md_mode="project",
        )
        assert manifest["claude_md_mode"] == "project"

    def test_create_workspace_manifest_persists_max_beads(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_manifest
        manifest = create_workspace_manifest(
            workspace_id="ws_x",
            workspace_root=str(tmp_path),
            workspace_name="test",
            prompt="x",
            source=None,
            guide_paths=[],
            branch_template="ws/{slug}/{project}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            projects_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
            max_beads=2,
        )
        assert manifest["max_beads"] == 2

    def test_create_workspace_manifest_claude_md_mode_none_by_default(self, tmp_path):
        from worca.scripts.run_workspace import create_workspace_manifest
        manifest = create_workspace_manifest(
            workspace_id="ws_x",
            workspace_root=str(tmp_path),
            workspace_name="test",
            prompt="x",
            source=None,
            guide_paths=[],
            branch_template="ws/{slug}/{project}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            projects_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
        )
        assert manifest["claude_md_mode"] is None
        assert manifest["max_beads"] is None

    def test_resume_workspace_passes_claude_md_mode_and_max_beads_to_dag_executor(self, tmp_path):
        from unittest.mock import patch, MagicMock
        from worca.scripts.run_workspace import _resume_workspace

        ws_root = str(tmp_path)
        ws_id = "ws_202601011200_abc123"

        manifest = {
            "workspace_id": ws_id,
            "workspace_name": "test",
            "workspace_root": ws_root,
            "status": "running",
            "claude_md_mode": "project",
            "max_beads": 3,
            "skip_integration": True,
            "dag": {"tiers": [{"tier": 0, "projects": ["lib"], "status": "completed"}]},
            "children": [{"name": "lib", "status": "completed"}],
            "integration_test": {"status": "pending"},
            "plan": {},
        }

        mock_executor = MagicMock()
        mock_executor.execute.return_value = {"status": "completed"}

        with (
            patch("worca.scripts.run_workspace.load_workspace_manifest", return_value=manifest),
            patch("worca.scripts.run_workspace.classify_children_for_resume",
                  return_value=({"lib"}, set())),
            patch("worca.scripts.run_workspace.rebuild_resume_manifest"),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch("worca.scripts.run_workspace.collect_stale_worktrees", return_value=[]),
            patch("worca.scripts.run_workspace._settings_path_for_workspace",
                  return_value=None),
            patch("worca.scripts.run_workspace._register_active_run"),
            patch("worca.scripts.run_workspace.emit_workspace_event"),
            patch("worca.scripts.run_workspace.Workspace") as mock_ws_cls,
            patch("worca.workspace.dag_executor.DagExecutor",
                  return_value=mock_executor) as mock_dag_cls,
        ):
            mock_ws = MagicMock()
            mock_ws.name = "test"
            mock_ws.projects = []
            mock_ws.integration_test = None
            mock_ws_cls.load.return_value = mock_ws

            _resume_workspace(ws_root, ws_id)

        mock_dag_cls.assert_called_once()
        call_kwargs = mock_dag_cls.call_args[1]
        assert call_kwargs["claude_md_mode"] == "project"
        assert call_kwargs["max_beads"] == 3

    def test_resume_workspace_none_fields_when_absent_from_manifest(self, tmp_path):
        from unittest.mock import patch, MagicMock
        from worca.scripts.run_workspace import _resume_workspace

        ws_root = str(tmp_path)
        ws_id = "ws_202601011200_def456"

        manifest = {
            "workspace_id": ws_id,
            "workspace_name": "test",
            "workspace_root": ws_root,
            "status": "running",
            "skip_integration": True,
            "dag": {"tiers": [{"tier": 0, "projects": ["lib"], "status": "completed"}]},
            "children": [{"name": "lib", "status": "completed"}],
            "integration_test": {"status": "pending"},
            "plan": {},
        }

        mock_executor = MagicMock()
        mock_executor.execute.return_value = {"status": "completed"}

        with (
            patch("worca.scripts.run_workspace.load_workspace_manifest", return_value=manifest),
            patch("worca.scripts.run_workspace.classify_children_for_resume",
                  return_value=({"lib"}, set())),
            patch("worca.scripts.run_workspace.rebuild_resume_manifest"),
            patch("worca.scripts.run_workspace.write_workspace_manifest"),
            patch("worca.scripts.run_workspace.collect_stale_worktrees", return_value=[]),
            patch("worca.scripts.run_workspace._settings_path_for_workspace",
                  return_value=None),
            patch("worca.scripts.run_workspace._register_active_run"),
            patch("worca.scripts.run_workspace.emit_workspace_event"),
            patch("worca.scripts.run_workspace.Workspace") as mock_ws_cls,
            patch("worca.workspace.dag_executor.DagExecutor",
                  return_value=mock_executor) as mock_dag_cls,
        ):
            mock_ws = MagicMock()
            mock_ws.name = "test"
            mock_ws.projects = []
            mock_ws.integration_test = None
            mock_ws_cls.load.return_value = mock_ws

            _resume_workspace(ws_root, ws_id)

        mock_dag_cls.assert_called_once()
        call_kwargs = mock_dag_cls.call_args[1]
        assert call_kwargs["claude_md_mode"] is None
        assert call_kwargs["max_beads"] is None
