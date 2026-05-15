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
        "repos": [
            {"name": "lib", "path": "lib", "role": "library", "depends_on": []},
        ],
    }


def _linear_chain_doc():
    """lib -> backend -> frontend (3 tiers)."""
    return {
        "name": "my-platform",
        "repos": [
            {"name": "lib", "path": "lib", "role": "library", "depends_on": []},
            {"name": "backend", "path": "backend", "role": "service", "depends_on": ["lib"]},
            {"name": "frontend", "path": "frontend", "role": "app", "depends_on": ["backend"]},
        ],
    }


def _diamond_doc():
    """Diamond: lib -> (backend, worker) -> frontend."""
    return {
        "name": "diamond",
        "repos": [
            {"name": "lib", "path": "lib", "role": "library", "depends_on": []},
            {"name": "backend", "path": "backend", "role": "service", "depends_on": ["lib"]},
            {"name": "worker", "path": "worker", "role": "service", "depends_on": ["lib"]},
            {"name": "frontend", "path": "frontend", "role": "app", "depends_on": ["backend", "worker"]},
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
            "--branch", "workspace/{slug}/{repo}",
        ])
        assert args.branch == "workspace/{slug}/{repo}"

    def test_branch_template_default(self):
        from worca.scripts.run_workspace import create_parser

        parser = create_parser()
        args = parser.parse_args(["/some/path", "--prompt", "x"])
        assert args.branch == "workspace/{slug}/{repo}"

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
            branch_template="workspace/{slug}/{repo}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"], ["backend"], ["frontend"]],
            repos_by_name={"lib": "lib", "backend": "backend", "frontend": "frontend"},
            dependency_graph={"lib": [], "backend": ["lib"], "frontend": ["backend"]},
            repos_info={"lib": {"path": "lib", "role": "library"}, "backend": {"path": "backend", "role": "service"}, "frontend": {"path": "frontend", "role": "app"}},
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
        assert manifest["dag"]["tiers"][0]["repos"] == ["lib"]
        assert manifest["dag"]["tiers"][0]["status"] == "pending"
        assert manifest["children"] == []
        assert "created_at" in manifest
        assert manifest["dag"]["dependency_graph"] == {"lib": [], "backend": ["lib"], "frontend": ["backend"]}
        assert manifest["repos_by_name"] == {"lib": "lib", "backend": "backend", "frontend": "frontend"}
        assert manifest["repos_info"]["lib"]["role"] == "library"
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
            branch_template="workspace/{slug}/{repo}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            repos_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
            repos_info={"lib": {"path": "lib", "role": "library"}},
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
            branch_template="workspace/{slug}/{repo}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            repos_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
            repos_info={"lib": {"path": "lib", "role": "library"}},
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
            branch_template="workspace/{slug}/{repo}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            repos_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
            repos_info={"lib": {"path": "lib", "role": "library"}},
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
            branch_template="workspace/{slug}/{repo}",
            max_parallel=5,
            skip_integration=False,
            skip_planning=False,
            tiers=[["lib"]],
            repos_by_name={"lib": "lib"},
            dependency_graph={"lib": []},
            repos_info={"lib": {"path": "lib", "role": "library"}},
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
