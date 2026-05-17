"""Tests for 'worca workspace init /path' CLI command (W-047-04)."""
import json
import os
import subprocess

import pytest


def _make_git_repo(path):
    """Create a minimal git repo at the given path."""
    os.makedirs(path, exist_ok=True)
    subprocess.run(
        ["git", "init", "--initial-branch=main"],
        cwd=str(path),
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@test.com"],
        cwd=str(path),
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=str(path),
        capture_output=True,
    )
    # Need at least one commit for a valid repo
    readme = os.path.join(path, "README.md")
    with open(readme, "w") as f:
        f.write("# test\n")
    subprocess.run(["git", "add", "."], cwd=str(path), capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=str(path),
        capture_output=True,
    )


def _make_workspace(tmp_path, project_names):
    """Create a parent dir with child git repos, return parent path."""
    parent = tmp_path / "workspace"
    parent.mkdir()
    for name in project_names:
        _make_git_repo(str(parent / name))
    return str(parent)


# ---- unit tests for scan_projects ------------------------------------------------

class TestScanProjects:
    def test_discovers_git_children(self, tmp_path):
        from worca.cli.workspace import scan_projects

        parent = _make_workspace(tmp_path, ["backend", "frontend", "lib"])
        repos = scan_projects(parent)
        names = sorted(r["name"] for r in repos)
        assert names == ["backend", "frontend", "lib"]

    def test_paths_are_relative(self, tmp_path):
        from worca.cli.workspace import scan_projects

        parent = _make_workspace(tmp_path, ["myrepo"])
        repos = scan_projects(parent)
        assert repos[0]["path"] == "myrepo"

    def test_skips_non_git_dirs(self, tmp_path):
        from worca.cli.workspace import scan_projects

        parent = _make_workspace(tmp_path, ["real-repo"])
        # Create a non-git directory
        (tmp_path / "workspace" / "just-a-dir").mkdir()
        repos = scan_projects(parent)
        assert len(repos) == 1
        assert repos[0]["name"] == "real-repo"

    def test_skips_hidden_dirs(self, tmp_path):
        from worca.cli.workspace import scan_projects

        parent = _make_workspace(tmp_path, ["visible"])
        _make_git_repo(str(tmp_path / "workspace" / ".hidden-repo"))
        repos = scan_projects(parent)
        assert len(repos) == 1
        assert repos[0]["name"] == "visible"

    def test_no_repos_found(self, tmp_path):
        from worca.cli.workspace import scan_projects

        parent = tmp_path / "empty"
        parent.mkdir()
        repos = scan_projects(parent)
        assert repos == []

    def test_defaults_depends_on_empty(self, tmp_path):
        from worca.cli.workspace import scan_projects

        parent = _make_workspace(tmp_path, ["a"])
        repos = scan_projects(parent)
        assert repos[0]["depends_on"] == []

    def test_no_role_field_emitted(self, tmp_path):
        # `role` was a freeform label with no behavioral effect; removed to
        # simplify the schema. Make sure scan_projects doesn't reintroduce it.
        from worca.cli.workspace import scan_projects

        parent = _make_workspace(tmp_path, ["a"])
        repos = scan_projects(parent)
        assert "role" not in repos[0]

    def test_results_sorted_by_name(self, tmp_path):
        from worca.cli.workspace import scan_projects

        parent = _make_workspace(tmp_path, ["zebra", "alpha", "mid"])
        repos = scan_projects(parent)
        names = [r["name"] for r in repos]
        assert names == ["alpha", "mid", "zebra"]


# ---- unit tests for generate_workspace_json -----------------------------------

class TestGenerateWorkspaceJson:
    def test_generates_valid_json(self, tmp_path):
        from worca.cli.workspace import generate_workspace_json

        parent = _make_workspace(tmp_path, ["api", "web"])
        doc = generate_workspace_json(parent)
        assert doc["name"] == "workspace"
        assert len(doc["projects"]) == 2

    def test_name_from_dir_basename(self, tmp_path):
        from worca.cli.workspace import generate_workspace_json

        parent = tmp_path / "my-platform"
        parent.mkdir()
        _make_git_repo(str(parent / "svc"))
        doc = generate_workspace_json(str(parent))
        assert doc["name"] == "my-platform"

    def test_repos_have_required_fields(self, tmp_path):
        from worca.cli.workspace import generate_workspace_json

        parent = _make_workspace(tmp_path, ["repo1"])
        doc = generate_workspace_json(parent)
        repo = doc["projects"][0]
        assert "name" in repo
        assert "path" in repo
        assert "depends_on" in repo
        assert "role" not in repo

    def test_validates_against_schema(self, tmp_path):
        import jsonschema
        from worca.cli.workspace import generate_workspace_json
        from worca.workspace.manifest import _SCHEMA_PATH

        parent = _make_workspace(tmp_path, ["a", "b"])
        doc = generate_workspace_json(parent)

        with open(_SCHEMA_PATH) as f:
            schema = json.load(f)
        jsonschema.validate(doc, schema)


# ---- integration tests for cmd_workspace_init ---------------------------------

class TestCmdWorkspaceInit:
    def test_creates_workspace_json(self, tmp_path):
        from worca.cli.workspace import cmd_workspace_init

        parent = _make_workspace(tmp_path, ["api", "web"])
        cmd_workspace_init(parent)
        ws_path = os.path.join(parent, "workspace.json")
        assert os.path.isfile(ws_path)
        with open(ws_path) as f:
            doc = json.load(f)
        assert doc["name"] == "workspace"
        assert len(doc["projects"]) == 2

    def test_creates_dot_worca_dir(self, tmp_path):
        from worca.cli.workspace import cmd_workspace_init

        parent = _make_workspace(tmp_path, ["svc"])
        cmd_workspace_init(parent)
        assert os.path.isdir(os.path.join(parent, ".worca"))

    def test_nonexistent_path_raises(self, tmp_path):
        from worca.cli.workspace import cmd_workspace_init

        with pytest.raises(SystemExit):
            cmd_workspace_init(str(tmp_path / "nonexistent"))

    def test_no_repos_raises(self, tmp_path):
        from worca.cli.workspace import cmd_workspace_init

        empty = tmp_path / "empty"
        empty.mkdir()
        with pytest.raises(SystemExit):
            cmd_workspace_init(str(empty))

    def test_existing_workspace_json_raises(self, tmp_path):
        from worca.cli.workspace import cmd_workspace_init

        parent = _make_workspace(tmp_path, ["svc"])
        # Pre-create workspace.json
        with open(os.path.join(parent, "workspace.json"), "w") as f:
            json.dump({"name": "existing"}, f)
        with pytest.raises(SystemExit):
            cmd_workspace_init(parent)

    def test_force_overwrites_existing(self, tmp_path):
        from worca.cli.workspace import cmd_workspace_init

        parent = _make_workspace(tmp_path, ["svc"])
        # Pre-create workspace.json
        with open(os.path.join(parent, "workspace.json"), "w") as f:
            json.dump({"name": "old"}, f)
        cmd_workspace_init(parent, force=True)
        with open(os.path.join(parent, "workspace.json")) as f:
            doc = json.load(f)
        assert doc["name"] == "workspace"

    def test_output_prints_workspace_definition(self, tmp_path, capsys):
        from worca.cli.workspace import cmd_workspace_init

        parent = _make_workspace(tmp_path, ["api"])
        cmd_workspace_init(parent)
        out = capsys.readouterr().out
        assert "workspace" in out.lower()
        assert "api" in out

    def test_workspace_json_loadable_by_manifest(self, tmp_path):
        """The generated workspace.json should be loadable by Workspace.load."""
        from worca.cli.workspace import cmd_workspace_init
        from worca.workspace.manifest import Workspace

        parent = _make_workspace(tmp_path, ["lib", "api"])
        cmd_workspace_init(parent)
        ws = Workspace.load(parent)
        assert ws.name == "workspace"
        assert len(ws.projects) == 2


# ---- test CLI integration via argparse -----------------------------------------

class TestSubcommandRegistration:
    def test_workspace_subcommand_registered(self):
        from worca.cli.main import create_parser

        parser = create_parser()
        # Should parse without error
        args = parser.parse_args(["workspace", "init", "/tmp/test"])
        assert args.command == "workspace"
        assert args.workspace_command == "init"

    def test_workspace_init_requires_path(self):
        from worca.cli.main import create_parser

        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["workspace", "init"])
