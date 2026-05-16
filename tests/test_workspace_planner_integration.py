"""Tests for master planner integration in run_workspace.py (W-047-09)."""
import json
import os
from unittest.mock import patch


from worca.workspace.manifest import Workspace, RepoEntry


# ---- helpers ----------------------------------------------------------------

def _make_workspace(repos=None, tiers=None, name="my-platform"):
    """Build a Workspace instance for testing without touching disk."""
    if repos is None:
        repos = [
            RepoEntry(name="lib", path="lib", depends_on=[]),
            RepoEntry(name="backend", path="backend", depends_on=["lib"]),
            RepoEntry(name="frontend", path="frontend", depends_on=["backend"]),
        ]
    if tiers is None:
        tiers = [["lib"], ["backend"], ["frontend"]]
    return Workspace(name=name, repos=repos, tiers=tiers)


def _valid_plan(repo_names=None):
    """Return a minimal valid workspace plan dict."""
    if repo_names is None:
        repo_names = ["lib", "backend", "frontend"]
    return {
        "summary": "Add user authentication across all services",
        "repos": [
            {
                "name": name,
                "description": f"Implement auth changes in {name}",
                "acceptance_criteria": [f"{name} auth tests pass"],
            }
            for name in repo_names
        ],
        "integration_expectations": ["End-to-end auth flow works"],
    }


def _plan_with_skip():
    """Return a plan where one repo is skipped."""
    return {
        "summary": "Backend-only change",
        "repos": [
            {
                "name": "lib",
                "description": "No changes needed",
                "acceptance_criteria": ["N/A"],
                "skip": True,
            },
            {
                "name": "backend",
                "description": "Add new API endpoint",
                "acceptance_criteria": ["Endpoint returns 200"],
            },
            {
                "name": "frontend",
                "description": "Consume new endpoint",
                "acceptance_criteria": ["UI displays data"],
                "depends_on": ["backend"],
            },
        ],
        "integration_expectations": [],
    }


# ---- gather_repo_context ----------------------------------------------------

class TestGatherRepoContext:
    def test_reads_claude_md_from_repos(self, tmp_path):
        from worca.scripts.run_workspace import gather_repo_context

        (tmp_path / "lib").mkdir()
        (tmp_path / "lib" / "CLAUDE.md").write_text("# Lib project\nUses Python.")
        (tmp_path / "backend").mkdir()
        (tmp_path / "backend" / "CLAUDE.md").write_text("# Backend\nExpress.js server.")

        ws = _make_workspace(repos=[
            RepoEntry(name="lib", path="lib", depends_on=[]),
            RepoEntry(name="backend", path="backend", depends_on=["lib"]),
        ], tiers=[["lib"], ["backend"]])

        ctx = gather_repo_context(ws, str(tmp_path))
        assert ctx["lib"] == "# Lib project\nUses Python."
        assert ctx["backend"] == "# Backend\nExpress.js server."

    def test_truncates_to_max_bytes(self, tmp_path):
        from worca.scripts.run_workspace import gather_repo_context

        (tmp_path / "lib").mkdir()
        (tmp_path / "lib" / "CLAUDE.md").write_text("A" * 8000)

        ws = _make_workspace(repos=[
            RepoEntry(name="lib", path="lib", depends_on=[]),
        ], tiers=[["lib"]])

        ctx = gather_repo_context(ws, str(tmp_path), max_bytes=4096)
        assert len(ctx["lib"].encode("utf-8")) <= 4096

    def test_missing_claude_md_returns_empty_string(self, tmp_path):
        from worca.scripts.run_workspace import gather_repo_context

        (tmp_path / "lib").mkdir()

        ws = _make_workspace(repos=[
            RepoEntry(name="lib", path="lib", depends_on=[]),
        ], tiers=[["lib"]])

        ctx = gather_repo_context(ws, str(tmp_path))
        assert ctx["lib"] == ""

    def test_all_repos_covered(self, tmp_path):
        from worca.scripts.run_workspace import gather_repo_context

        for name in ["lib", "backend", "frontend"]:
            (tmp_path / name).mkdir()

        ws = _make_workspace()
        ctx = gather_repo_context(ws, str(tmp_path))
        assert set(ctx.keys()) == {"lib", "backend", "frontend"}


# ---- build_planner_prompt ---------------------------------------------------

class TestBuildPlannerPrompt:
    def test_contains_workspace_topology(self):
        from worca.scripts.run_workspace import build_planner_prompt

        ws = _make_workspace()
        prompt = build_planner_prompt(ws, "Add auth", {}, [])
        assert "lib" in prompt
        assert "backend" in prompt
        assert "frontend" in prompt

    def test_contains_repo_contexts(self):
        from worca.scripts.run_workspace import build_planner_prompt

        ws = _make_workspace()
        contexts = {"lib": "Python library", "backend": "Express server", "frontend": "React app"}
        prompt = build_planner_prompt(ws, "Add auth", contexts, [])
        assert "Python library" in prompt
        assert "Express server" in prompt
        assert "React app" in prompt

    def test_contains_user_prompt(self):
        from worca.scripts.run_workspace import build_planner_prompt

        ws = _make_workspace()
        prompt = build_planner_prompt(ws, "Add user authentication", {}, [])
        assert "Add user authentication" in prompt

    def test_contains_guide_content(self, tmp_path):
        from worca.scripts.run_workspace import build_planner_prompt

        guide = tmp_path / "migration.md"
        guide.write_text("# Migration Guide\nStep 1: do this")

        ws = _make_workspace()
        prompt = build_planner_prompt(ws, "Migrate", {}, [str(guide)])
        assert "Migration Guide" in prompt
        assert "Step 1: do this" in prompt

    def test_no_guides_no_guide_section(self):
        from worca.scripts.run_workspace import build_planner_prompt

        ws = _make_workspace()
        prompt = build_planner_prompt(ws, "Add auth", {}, [])
        assert "Reference Guide" not in prompt

    def test_includes_dependency_info(self):
        from worca.scripts.run_workspace import build_planner_prompt

        ws = _make_workspace()
        prompt = build_planner_prompt(ws, "x", {}, [])
        assert "depends_on" in prompt


# ---- validate_workspace_plan ------------------------------------------------

class TestValidateWorkspacePlan:
    def test_valid_plan_no_errors(self):
        from worca.scripts.run_workspace import validate_workspace_plan

        ws = _make_workspace()
        plan = _valid_plan()
        errors = validate_workspace_plan(plan, ws)
        assert errors == []

    def test_missing_summary_returns_error(self):
        from worca.scripts.run_workspace import validate_workspace_plan

        ws = _make_workspace()
        plan = _valid_plan()
        del plan["summary"]
        errors = validate_workspace_plan(plan, ws)
        assert len(errors) > 0

    def test_missing_repos_returns_error(self):
        from worca.scripts.run_workspace import validate_workspace_plan

        ws = _make_workspace()
        plan = _valid_plan()
        del plan["repos"]
        errors = validate_workspace_plan(plan, ws)
        assert len(errors) > 0

    def test_unknown_repo_name_returns_error(self):
        from worca.scripts.run_workspace import validate_workspace_plan

        ws = _make_workspace()
        plan = _valid_plan()
        plan["repos"][0]["name"] = "nonexistent"
        errors = validate_workspace_plan(plan, ws)
        assert any("nonexistent" in e for e in errors)

    def test_empty_repos_array_returns_error(self):
        from worca.scripts.run_workspace import validate_workspace_plan

        ws = _make_workspace()
        plan = {"summary": "x", "repos": [], "integration_expectations": []}
        errors = validate_workspace_plan(plan, ws)
        assert len(errors) > 0

    def test_valid_plan_with_skip(self):
        from worca.scripts.run_workspace import validate_workspace_plan

        ws = _make_workspace()
        plan = _plan_with_skip()
        errors = validate_workspace_plan(plan, ws)
        assert errors == []

    def test_extra_property_returns_error(self):
        from worca.scripts.run_workspace import validate_workspace_plan

        ws = _make_workspace()
        plan = _valid_plan()
        plan["extra_field"] = "oops"
        errors = validate_workspace_plan(plan, ws)
        assert len(errors) > 0


# ---- format_workspace_plan_md -----------------------------------------------

class TestFormatWorkspacePlanMd:
    def test_contains_summary(self):
        from worca.scripts.run_workspace import format_workspace_plan_md

        plan = _valid_plan()
        md = format_workspace_plan_md(plan)
        assert "Add user authentication across all services" in md

    def test_contains_repo_sections(self):
        from worca.scripts.run_workspace import format_workspace_plan_md

        plan = _valid_plan()
        md = format_workspace_plan_md(plan)
        assert "lib" in md
        assert "backend" in md
        assert "frontend" in md

    def test_contains_acceptance_criteria(self):
        from worca.scripts.run_workspace import format_workspace_plan_md

        plan = _valid_plan()
        md = format_workspace_plan_md(plan)
        assert "lib auth tests pass" in md

    def test_skipped_repo_marked(self):
        from worca.scripts.run_workspace import format_workspace_plan_md

        plan = _plan_with_skip()
        md = format_workspace_plan_md(plan)
        assert "skip" in md.lower()

    def test_integration_expectations_included(self):
        from worca.scripts.run_workspace import format_workspace_plan_md

        plan = _valid_plan()
        md = format_workspace_plan_md(plan)
        assert "End-to-end auth flow works" in md


# ---- format_repo_plan_md ---------------------------------------------------

class TestFormatRepoPlanMd:
    def test_contains_description(self):
        from worca.scripts.run_workspace import format_repo_plan_md

        repo = {"name": "backend", "description": "Add auth endpoint", "acceptance_criteria": ["test"]}
        md = format_repo_plan_md(repo, "Cross-repo auth feature")
        assert "Add auth endpoint" in md

    def test_contains_acceptance_criteria(self):
        from worca.scripts.run_workspace import format_repo_plan_md

        repo = {"name": "backend", "description": "x", "acceptance_criteria": ["API returns 200", "Token validated"]}
        md = format_repo_plan_md(repo, "summary")
        assert "API returns 200" in md
        assert "Token validated" in md

    def test_contains_workspace_summary(self):
        from worca.scripts.run_workspace import format_repo_plan_md

        repo = {"name": "lib", "description": "x", "acceptance_criteria": ["test"]}
        md = format_repo_plan_md(repo, "Cross-repo auth feature")
        assert "Cross-repo auth feature" in md

    def test_depends_on_listed(self):
        from worca.scripts.run_workspace import format_repo_plan_md

        repo = {"name": "frontend", "description": "x", "acceptance_criteria": ["test"], "depends_on": ["backend"]}
        md = format_repo_plan_md(repo, "summary")
        assert "backend" in md


# ---- write_workspace_plan_files ---------------------------------------------

class TestWriteWorkspacePlanFiles:
    def test_writes_workspace_plan_json(self, tmp_path):
        from worca.scripts.run_workspace import write_workspace_plan_files

        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)
        plan = _valid_plan()

        write_workspace_plan_files(plan, run_dir)

        json_path = os.path.join(run_dir, "workspace-plan.json")
        assert os.path.isfile(json_path)
        with open(json_path) as f:
            loaded = json.load(f)
        assert loaded == plan

    def test_writes_workspace_plan_md(self, tmp_path):
        from worca.scripts.run_workspace import write_workspace_plan_files

        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)
        plan = _valid_plan()

        write_workspace_plan_files(plan, run_dir)

        md_path = os.path.join(run_dir, "workspace-plan.md")
        assert os.path.isfile(md_path)
        content = open(md_path).read()
        assert "Add user authentication" in content

    def test_writes_per_repo_plan_md(self, tmp_path):
        from worca.scripts.run_workspace import write_workspace_plan_files

        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)
        plan = _valid_plan()

        paths = write_workspace_plan_files(plan, run_dir)

        for name in ["lib", "backend", "frontend"]:
            plan_path = os.path.join(run_dir, f"{name}-plan.md")
            assert os.path.isfile(plan_path)
            assert name in paths
            assert paths[name] == plan_path

    def test_skipped_repo_not_written(self, tmp_path):
        from worca.scripts.run_workspace import write_workspace_plan_files

        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)
        plan = _plan_with_skip()

        paths = write_workspace_plan_files(plan, run_dir)

        assert "lib" not in paths
        assert not os.path.isfile(os.path.join(run_dir, "lib-plan.md"))

    def test_returns_only_non_skipped_repo_paths(self, tmp_path):
        from worca.scripts.run_workspace import write_workspace_plan_files

        run_dir = str(tmp_path / "run")
        os.makedirs(run_dir)
        plan = _plan_with_skip()

        paths = write_workspace_plan_files(plan, run_dir)
        assert set(paths.keys()) == {"backend", "frontend"}


# ---- run_workspace_planner --------------------------------------------------

class TestRunWorkspacePlanner:
    def test_invokes_run_agent_with_correct_agent(self):
        from worca.scripts.run_workspace import run_workspace_planner

        plan = _valid_plan()
        mock_event = {"type": "result", "result": json.dumps(plan)}

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event) as mock:
            run_workspace_planner("prompt text", "/tmp/run-dir")
            args, kwargs = mock.call_args
            agent_path = kwargs.get("agent") or args[1]
            assert "workspace_planner" in agent_path
            assert agent_path.endswith(".md")

    def test_invokes_run_agent_with_schema(self):
        from worca.scripts.run_workspace import run_workspace_planner

        plan = _valid_plan()
        mock_event = {"type": "result", "result": json.dumps(plan)}

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event) as mock:
            run_workspace_planner("prompt text", "/tmp/run-dir")
            args, kwargs = mock.call_args
            schema = kwargs.get("json_schema")
            assert schema is not None
            assert "workspace_plan" in schema

    def test_returns_parsed_plan(self):
        from worca.scripts.run_workspace import run_workspace_planner

        plan = _valid_plan()
        mock_event = {"type": "result", "result": json.dumps(plan)}

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event):
            result = run_workspace_planner("prompt text", "/tmp/run-dir")
            assert result == plan

    def test_uses_opus_model_by_default(self):
        from worca.scripts.run_workspace import run_workspace_planner

        plan = _valid_plan()
        mock_event = {"type": "result", "result": json.dumps(plan)}

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event) as mock:
            run_workspace_planner("prompt text", "/tmp/run-dir")
            args, kwargs = mock.call_args
            model = kwargs.get("model")
            assert model is not None
            assert "opus" in model.lower()

    def test_custom_model_override(self):
        from worca.scripts.run_workspace import run_workspace_planner

        plan = _valid_plan()
        mock_event = {"type": "result", "result": json.dumps(plan)}

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event) as mock:
            run_workspace_planner("prompt text", "/tmp/run-dir", model="claude-sonnet-4-6")
            args, kwargs = mock.call_args
            assert kwargs.get("model") == "claude-sonnet-4-6"

    def test_writes_log_to_run_dir(self):
        from worca.scripts.run_workspace import run_workspace_planner

        plan = _valid_plan()
        mock_event = {"type": "result", "result": json.dumps(plan)}

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event) as mock:
            run_workspace_planner("prompt text", "/tmp/run-dir")
            args, kwargs = mock.call_args
            log_path = kwargs.get("log_path")
            assert log_path is not None
            assert "/tmp/run-dir" in log_path


# ---- main() planner integration ---------------------------------------------

class TestMainPlannerIntegration:
    def _write_workspace_json(self, tmp_path, doc=None):
        if doc is None:
            doc = {
                "name": "my-platform",
                "repos": [
                    {"name": "lib", "path": "lib", "depends_on": []},
                    {"name": "backend", "path": "backend", "depends_on": ["lib"]},
                ],
            }
        (tmp_path / "workspace.json").write_text(json.dumps(doc))
        for r in doc["repos"]:
            (tmp_path / r["path"]).mkdir(exist_ok=True)
        return str(tmp_path)

    def _mock_executor(self):
        """Return a context manager that stubs DagExecutor.execute to succeed."""
        mock_exec = type("MockExecutor", (), {
            "__init__": lambda self, *a, **kw: None,
            "execute": lambda self: {"status": "completed", "children": []},
        })
        return patch("worca.workspace.dag_executor.DagExecutor", mock_exec)

    def test_planner_runs_when_not_skip_planning(self, tmp_path, monkeypatch):
        from worca.scripts.run_workspace import main

        ws_root = self._write_workspace_json(tmp_path)
        plan = _valid_plan(["lib", "backend"])
        mock_event = {"type": "result", "result": json.dumps(plan)}

        monkeypatch.setattr(
            "worca.scripts.run_workspace._POINTER_DIR_DEFAULT",
            str(tmp_path / "pointers"),
        )

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event) as mock, \
             self._mock_executor():
            exit_code = main([ws_root, "--prompt", "Add auth", "--skip-integration"])

        assert mock.called
        assert exit_code == 0

    def test_planner_skipped_when_skip_planning(self, tmp_path, monkeypatch):
        from worca.scripts.run_workspace import main

        ws_root = self._write_workspace_json(tmp_path)

        monkeypatch.setattr(
            "worca.scripts.run_workspace._POINTER_DIR_DEFAULT",
            str(tmp_path / "pointers"),
        )

        with patch("worca.scripts.run_workspace.run_agent") as mock, \
             self._mock_executor():
            exit_code = main([ws_root, "--prompt", "Add auth", "--skip-planning", "--skip-integration"])

        assert not mock.called
        assert exit_code == 0

    def test_plan_files_written_to_run_dir(self, tmp_path, monkeypatch):
        from worca.scripts.run_workspace import main

        ws_root = self._write_workspace_json(tmp_path)
        plan = _valid_plan(["lib", "backend"])
        mock_event = {"type": "result", "result": json.dumps(plan)}

        monkeypatch.setattr(
            "worca.scripts.run_workspace._POINTER_DIR_DEFAULT",
            str(tmp_path / "pointers"),
        )

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event), \
             self._mock_executor():
            main([ws_root, "--prompt", "Add auth", "--skip-integration"])

        runs_dir = os.path.join(ws_root, ".worca", "workspace-runs")
        ws_dirs = os.listdir(runs_dir)
        assert len(ws_dirs) == 1

        run_dir = os.path.join(runs_dir, ws_dirs[0])
        assert os.path.isfile(os.path.join(run_dir, "workspace-plan.json"))
        assert os.path.isfile(os.path.join(run_dir, "workspace-plan.md"))
        assert os.path.isfile(os.path.join(run_dir, "lib-plan.md"))
        assert os.path.isfile(os.path.join(run_dir, "backend-plan.md"))

    def test_manifest_updated_after_planning(self, tmp_path, monkeypatch):
        from worca.scripts.run_workspace import main

        ws_root = self._write_workspace_json(tmp_path)
        plan = _valid_plan(["lib", "backend"])
        mock_event = {"type": "result", "result": json.dumps(plan)}

        monkeypatch.setattr(
            "worca.scripts.run_workspace._POINTER_DIR_DEFAULT",
            str(tmp_path / "pointers"),
        )

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event), \
             self._mock_executor():
            main([ws_root, "--prompt", "Add auth", "--skip-integration"])

        runs_dir = os.path.join(ws_root, ".worca", "workspace-runs")
        ws_dirs = os.listdir(runs_dir)
        run_dir = os.path.join(runs_dir, ws_dirs[0])

        with open(os.path.join(run_dir, "workspace-manifest.json")) as f:
            manifest = json.load(f)

        assert manifest["status"] == "completed"
        assert "plan" in manifest
        assert "repo_plans" in manifest["plan"]

    def test_validation_failure_returns_error(self, tmp_path, monkeypatch, capsys):
        from worca.scripts.run_workspace import main

        ws_root = self._write_workspace_json(tmp_path)
        bad_plan = {"summary": "x", "repos": [], "integration_expectations": []}
        mock_event = {"type": "result", "result": json.dumps(bad_plan)}

        monkeypatch.setattr(
            "worca.scripts.run_workspace._POINTER_DIR_DEFAULT",
            str(tmp_path / "pointers"),
        )

        with patch("worca.scripts.run_workspace.run_agent", return_value=mock_event):
            exit_code = main([ws_root, "--prompt", "Add auth"])

        assert exit_code == 1
        captured = capsys.readouterr()
        assert "validation" in captured.err.lower() or "error" in captured.err.lower()

    def test_skip_planning_manifest_status_running(self, tmp_path, monkeypatch):
        from worca.scripts.run_workspace import main

        ws_root = self._write_workspace_json(tmp_path)

        monkeypatch.setattr(
            "worca.scripts.run_workspace._POINTER_DIR_DEFAULT",
            str(tmp_path / "pointers"),
        )

        with patch("worca.scripts.run_workspace.run_agent"), \
             self._mock_executor():
            main([ws_root, "--prompt", "Add auth", "--skip-planning", "--skip-integration"])

        runs_dir = os.path.join(ws_root, ".worca", "workspace-runs")
        ws_dirs = os.listdir(runs_dir)
        run_dir = os.path.join(runs_dir, ws_dirs[0])

        with open(os.path.join(run_dir, "workspace-manifest.json")) as f:
            manifest = json.load(f)

        assert manifest["status"] == "completed"

    def test_agent_failure_returns_error(self, tmp_path, monkeypatch, capsys):
        from worca.scripts.run_workspace import main

        ws_root = self._write_workspace_json(tmp_path)

        monkeypatch.setattr(
            "worca.scripts.run_workspace._POINTER_DIR_DEFAULT",
            str(tmp_path / "pointers"),
        )

        with patch("worca.scripts.run_workspace.run_agent", side_effect=RuntimeError("agent crashed")):
            exit_code = main([ws_root, "--prompt", "Add auth"])

        assert exit_code == 1
        captured = capsys.readouterr()
        assert "planner" in captured.err.lower() or "error" in captured.err.lower()
