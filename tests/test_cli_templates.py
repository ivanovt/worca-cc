"""Tests for worca templates CLI subcommands (list, show, create)."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from worca.cli.main import create_parser, main
from worca.cli.templates import _resolve_dirs


def _write_template(directory: Path, data: dict):
    """Helper: create template dir with template.json."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "template.json").write_text(json.dumps(data))


def _minimal(
    id: str,
    name: str = None,
    tier: str = "builtin",
    tags: list = None,
    created_at: str = "2026-01-01T00:00:00Z",
) -> dict:
    return {
        "id": id,
        "name": name or id.capitalize(),
        "description": f"{id} description",
        "builtin": tier == "builtin",
        "created_at": created_at,
        "tags": tags or [],
        "config": {},
    }


# ---------------------------------------------------------------------------
# Parser tests
# ---------------------------------------------------------------------------


class TestTemplatesParser:
    def test_templates_list_subcommand_parsed(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "list"])
        assert args.command == "templates"
        assert args.templates_command == "list"

    def test_templates_show_subcommand_parsed(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "show", "bugfix"])
        assert args.command == "templates"
        assert args.templates_command == "show"
        assert args.template_id == "bugfix"

    def test_templates_no_subcommand_exits(self):
        with pytest.raises(SystemExit) as exc_info:
            main(["templates"])
        assert exc_info.value.code != 0


# ---------------------------------------------------------------------------
# worca templates list
# ---------------------------------------------------------------------------


class TestTemplatesList:
    def _run_list(self, capsys, builtin_dir=None, project_dir=None, user_dir=None):
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            main(["templates", "list"])
        return capsys.readouterr().out

    def test_list_shows_header_row(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        output = self._run_list(capsys, builtin_dir=builtin_dir)
        assert "ID" in output
        assert "NAME" in output
        assert "TIER" in output
        assert "TAGS" in output

    def test_list_shows_builtin_template(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix", tags=["fast", "focused"]))
        output = self._run_list(capsys, builtin_dir=builtin_dir)
        assert "bugfix" in output
        assert "Bugfix" in output
        assert "builtin" in output
        assert "fast" in output

    def test_list_shows_multiple_tiers(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        _write_template(project_dir / "my-template", _minimal("my-template", tier="project"))
        _write_template(
            user_dir / "user-tmpl",
            _minimal("user-tmpl", tier="user", created_at="2026-03-01T00:00:00Z"),
        )
        output = self._run_list(capsys, builtin_dir, project_dir, user_dir)
        assert "bugfix" in output
        assert "my-template" in output
        assert "user-tmpl" in output
        assert "builtin" in output
        assert "project" in output
        assert "user" in output

    def test_list_empty_shows_no_templates_message(self, capsys, tmp_path):
        output = self._run_list(capsys)
        # Should not crash; output may be empty table or message
        assert isinstance(output, str)

    def test_list_tags_comma_separated(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(
            builtin_dir / "feature",
            _minimal("feature", tags=["full-pipeline", "requires-approval"]),
        )
        output = self._run_list(capsys, builtin_dir=builtin_dir)
        assert "full-pipeline" in output
        assert "requires-approval" in output

    def test_list_no_tags_shows_dash_or_empty(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bare", _minimal("bare", tags=[]))
        output = self._run_list(capsys, builtin_dir=builtin_dir)
        assert "bare" in output  # template is shown

    def test_list_columns_aligned(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "a", _minimal("a", name="Alpha"))
        _write_template(builtin_dir / "b", _minimal("b", name="Beta"))
        output = self._run_list(capsys, builtin_dir=builtin_dir)
        lines = [line for line in output.splitlines() if line.strip()]
        # Header + at least 2 rows
        assert len(lines) >= 3

    def _run_list_json(self, capsys, builtin_dir=None, project_dir=None, user_dir=None):
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            main(["templates", "list", "--json"])
        return capsys.readouterr().out

    def test_list_json_emits_array_with_full_shape(self, capsys, tmp_path):
        """--json must emit a JSON array; each entry has the documented fields."""
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix", tags=["fast"]))
        _write_template(
            project_dir / "house-style", _minimal("house-style", tier="project")
        )

        output = self._run_list_json(capsys, builtin_dir=builtin_dir, project_dir=project_dir)
        payload = json.loads(output)

        assert isinstance(payload, list)
        by_id = {entry["id"]: entry for entry in payload}
        assert {"bugfix", "house-style"} <= set(by_id)

        for entry in payload:
            # Documented fields the skill / downstream tooling rely on.
            assert set(entry.keys()) == {
                "id", "name", "description", "tier", "tags", "builtin", "created_at",
            }

        assert by_id["bugfix"]["tier"] == "builtin"
        assert by_id["bugfix"]["tags"] == ["fast"]
        assert by_id["house-style"]["tier"] == "project"

    def test_list_json_empty_emits_empty_array(self, capsys, tmp_path):
        """No templates anywhere → `[]`, not a crash, not the table header."""
        output = self._run_list_json(capsys)
        assert json.loads(output) == []


# ---------------------------------------------------------------------------
# worca templates show
# ---------------------------------------------------------------------------


class TestTemplatesShow:
    def _run_show(self, capsys, template_id, builtin_dir=None, project_dir=None, user_dir=None):
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            main(["templates", "show", template_id])
        return capsys.readouterr()

    def test_show_prints_json_for_known_template(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        data = _minimal("bugfix", tags=["fast"])
        _write_template(builtin_dir / "bugfix", data)
        out = self._run_show(capsys, "bugfix", builtin_dir=builtin_dir)
        parsed = json.loads(out.out)
        assert parsed["id"] == "bugfix"

    def test_show_pretty_prints_json(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "feature", _minimal("feature"))
        out = self._run_show(capsys, "feature", builtin_dir=builtin_dir)
        # Pretty-printed JSON has newlines and indentation
        assert "\n" in out.out
        assert "  " in out.out

    def test_show_includes_all_template_fields(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        data = {
            "id": "bugfix",
            "name": "Bugfix",
            "description": "Fix bugs fast",
            "builtin": True,
            "created_at": "2026-01-01T00:00:00Z",
            "tags": ["fast"],
            "params": {},
            "config": {"agents": {"planner": {"model": "sonnet"}}},
        }
        _write_template(builtin_dir / "bugfix", data)
        out = self._run_show(capsys, "bugfix", builtin_dir=builtin_dir)
        parsed = json.loads(out.out)
        assert parsed["config"]["agents"]["planner"]["model"] == "sonnet"
        assert parsed["tags"] == ["fast"]

    def test_show_unknown_id_exits_nonzero(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        with pytest.raises(SystemExit) as exc_info:
            self._run_show(capsys, "nonexistent", builtin_dir=builtin_dir)
        assert exc_info.value.code != 0

    def test_show_unknown_id_prints_error_message(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        with pytest.raises(SystemExit):
            self._run_show(capsys, "nonexistent", builtin_dir=builtin_dir)
        captured = capsys.readouterr()
        assert "nonexistent" in captured.err or "not found" in captured.err.lower() or "nonexistent" in captured.out

    def test_show_project_template_over_builtin(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        _write_template(builtin_dir / "my-tmpl", _minimal("my-tmpl", name="Built-in Version"))
        _write_template(project_dir / "my-tmpl", _minimal("my-tmpl", name="Project Version", tier="project"))
        out = self._run_show(capsys, "my-tmpl", builtin_dir=builtin_dir, project_dir=project_dir)
        # user > project > builtin; project wins here
        # But TemplateResolver.get() includes tier in the Template object
        # The JSON output for "show" comes from template.json, which has "name"
        parsed = json.loads(out.out)
        assert parsed["name"] == "Project Version"

    def test_show_also_includes_tier_field(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        out = self._run_show(capsys, "bugfix", builtin_dir=builtin_dir)
        parsed = json.loads(out.out)
        assert "tier" in parsed
        assert parsed["tier"] == "builtin"


# ---------------------------------------------------------------------------
# worca templates save
# ---------------------------------------------------------------------------


class TestTemplatesSave:
    def _run_save(self, args, builtin_dir=None, project_dir=None, user_dir=None):
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            main(["templates", "save"] + args)

    def test_save_subcommand_parsed(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "save", "my-tmpl", "--description", "A description"])
        assert args.command == "templates"
        assert args.templates_command == "save"
        assert args.template_id == "my-tmpl"
        assert args.description == "A description"

    def test_save_global_flag_defaults_false(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "save", "my-tmpl"])
        assert args.global_ is False

    def test_save_global_flag_set(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "save", "my-tmpl", "--global"])
        assert args.global_ is True

    def test_save_creates_project_template(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        self._run_save(["my-tmpl", "--description", "desc"], builtin_dir, project_dir, user_dir)
        assert (project_dir / "my-tmpl" / "template.json").exists()

    def test_save_global_creates_user_template(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        self._run_save(
            ["my-tmpl", "--global", "--description", "desc"],
            builtin_dir,
            project_dir,
            user_dir,
        )
        assert (user_dir / "my-tmpl" / "template.json").exists()

    def test_save_template_json_has_correct_id_and_description(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        self._run_save(["my-tmpl", "--description", "Test desc"], builtin_dir, project_dir, user_dir)
        data = json.loads((project_dir / "my-tmpl" / "template.json").read_text())
        assert data["id"] == "my-tmpl"
        assert data["description"] == "Test desc"

    def test_save_rejects_builtin_id(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        project_dir = tmp_path / "project"
        with pytest.raises(SystemExit) as exc_info:
            self._run_save(
                ["bugfix", "--description", "test"],
                builtin_dir,
                project_dir,
                tmp_path / "user",
            )
        assert exc_info.value.code != 0

    def test_save_rejects_builtin_id_prints_error(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        project_dir = tmp_path / "project"
        with pytest.raises(SystemExit):
            self._run_save(
                ["bugfix", "--description", "test"],
                builtin_dir,
                project_dir,
                tmp_path / "user",
            )
        err = capsys.readouterr().err
        assert "bugfix" in err or "built-in" in err.lower()

    def test_save_prints_success_message(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        self._run_save(["my-tmpl", "--description", "desc"], builtin_dir, project_dir, user_dir)
        out = capsys.readouterr().out
        assert "my-tmpl" in out

    def test_save_description_defaults_to_empty(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        self._run_save(["my-tmpl"], builtin_dir, project_dir, user_dir)
        data = json.loads((project_dir / "my-tmpl" / "template.json").read_text())
        assert "description" in data


# ---------------------------------------------------------------------------
# worca templates delete
# ---------------------------------------------------------------------------


class TestTemplatesDelete:
    def _run_delete(self, args, builtin_dir=None, project_dir=None, user_dir=None):
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            main(["templates", "delete"] + args)

    def test_delete_subcommand_parsed(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "delete", "my-tmpl"])
        assert args.command == "templates"
        assert args.templates_command == "delete"
        assert args.template_id == "my-tmpl"

    def test_delete_global_flag_defaults_false(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "delete", "my-tmpl"])
        assert args.global_ is False

    def test_delete_global_flag_set(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "delete", "my-tmpl", "--global"])
        assert args.global_ is True

    def test_delete_removes_project_template(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        _write_template(project_dir / "my-tmpl", _minimal("my-tmpl", tier="project"))
        user_dir = tmp_path / "user"
        self._run_delete(["my-tmpl"], builtin_dir, project_dir, user_dir)
        assert not (project_dir / "my-tmpl").exists()

    def test_delete_global_removes_user_template(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(user_dir / "my-tmpl", _minimal("my-tmpl", tier="user"))
        self._run_delete(["my-tmpl", "--global"], builtin_dir, project_dir, user_dir)
        assert not (user_dir / "my-tmpl").exists()

    def test_delete_rejects_builtin(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        project_dir = tmp_path / "project"
        with pytest.raises(SystemExit) as exc_info:
            self._run_delete(["bugfix"], builtin_dir, project_dir, tmp_path / "user")
        assert exc_info.value.code != 0

    def test_delete_rejects_builtin_prints_error(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        project_dir = tmp_path / "project"
        with pytest.raises(SystemExit):
            self._run_delete(["bugfix"], builtin_dir, project_dir, tmp_path / "user")
        err = capsys.readouterr().err
        assert "bugfix" in err or "built-in" in err.lower()

    def test_delete_not_found_exits_nonzero(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        user_dir = tmp_path / "user"
        with pytest.raises(SystemExit) as exc_info:
            self._run_delete(["nonexistent"], builtin_dir, project_dir, user_dir)
        assert exc_info.value.code != 0

    def test_delete_not_found_prints_error(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        user_dir = tmp_path / "user"
        with pytest.raises(SystemExit):
            self._run_delete(["nonexistent"], builtin_dir, project_dir, user_dir)
        err = capsys.readouterr().err
        assert "nonexistent" in err or "not found" in err.lower()

    def test_delete_prints_success_message(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        _write_template(project_dir / "my-tmpl", _minimal("my-tmpl", tier="project"))
        user_dir = tmp_path / "user"
        self._run_delete(["my-tmpl"], builtin_dir, project_dir, user_dir)
        out = capsys.readouterr().out
        assert "my-tmpl" in out


# ---------------------------------------------------------------------------
# _resolve_dirs — builtin_dir uses runtime copy inside a project
# ---------------------------------------------------------------------------


class TestResolveDirs:
    def test_builtin_dir_points_to_runtime_copy_in_project(self, tmp_path, monkeypatch):
        """When in a git repo, builtin_dir is .claude/worca/templates/ (runtime copy)."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / ".git").mkdir()
        builtin_dir, _, _ = _resolve_dirs()
        assert builtin_dir == tmp_path / ".claude" / "worca" / "templates"

    def test_builtin_dir_falls_back_to_package_outside_project(self, tmp_path, monkeypatch):
        """When not in a git repo, builtin_dir falls back to package source."""
        monkeypatch.chdir(tmp_path)
        # No .git directory — walk up finds no git root
        builtin_dir, _, _ = _resolve_dirs()
        assert builtin_dir.name == "templates"
        assert builtin_dir.parent.name == "worca"
        # Must not be the runtime copy path
        assert ".claude" not in str(builtin_dir)

    def test_project_dir_is_dot_claude_templates(self, tmp_path, monkeypatch):
        """project_dir points to .claude/templates/ relative to git root."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / ".git").mkdir()
        _, project_dir, _ = _resolve_dirs()
        assert project_dir == tmp_path / ".claude" / "templates"

    def test_project_dir_is_none_outside_project(self, tmp_path, monkeypatch):
        """project_dir is None when not inside a git repo."""
        monkeypatch.chdir(tmp_path)
        _, project_dir, _ = _resolve_dirs()
        assert project_dir is None


# ---------------------------------------------------------------------------
# worca templates create --from-file
# ---------------------------------------------------------------------------


class TestTemplatesCreate:
    def _run_create(self, args, capsys, builtin_dir=None, project_dir=None, user_dir=None):
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            main(["templates", "create"] + args)
        return capsys.readouterr()

    def _valid_payload(self, **overrides):
        data = {
            "id": "my-pipeline",
            "name": "My Pipeline",
            "description": "A custom pipeline",
            "tags": ["fast"],
            "config": {"stages": {"test": {"enabled": False}}},
        }
        data.update(overrides)
        return data

    # --- parser ---

    def test_create_subcommand_parsed(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "create", "--from-file", "payload.json"])
        assert args.command == "templates"
        assert args.templates_command == "create"
        assert args.from_file == "payload.json"

    def test_create_global_flag_defaults_false(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "create", "--from-file", "payload.json"])
        assert args.global_ is False

    def test_create_global_flag_set(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "create", "--from-file", "payload.json", "--global"])
        assert args.global_ is True

    def test_create_from_file_is_required(self):
        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["templates", "create"])

    # --- happy path: project scope ---

    def test_create_writes_project_template(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(self._valid_payload()))
        self._run_create(
            ["--from-file", str(payload_file)],
            capsys, builtin_dir, project_dir, user_dir,
        )
        assert (project_dir / "my-pipeline" / "template.json").exists()

    def test_create_roundtrips_via_resolver_get(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(self._valid_payload()))
        self._run_create(
            ["--from-file", str(payload_file)],
            capsys, builtin_dir, project_dir, user_dir,
        )
        from worca.orchestrator.templates import TemplateResolver
        resolver = TemplateResolver(builtin_dir, project_dir, user_dir)
        tmpl = resolver.get("my-pipeline")
        assert tmpl is not None
        assert tmpl.name == "My Pipeline"
        assert tmpl.config == {"stages": {"test": {"enabled": False}}}

    def test_create_prints_success_message(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(self._valid_payload()))
        out = self._run_create(
            ["--from-file", str(payload_file)],
            capsys, builtin_dir, project_dir, user_dir,
        )
        assert "my-pipeline" in out.out

    # --- happy path: user scope ---

    def test_create_global_writes_user_template(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(self._valid_payload()))
        self._run_create(
            ["--from-file", str(payload_file), "--global"],
            capsys, builtin_dir, project_dir, user_dir,
        )
        assert (user_dir / "my-pipeline" / "template.json").exists()
        assert not (project_dir / "my-pipeline").exists()

    # --- validation errors ---

    def test_create_rejects_invalid_id(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(self._valid_payload(id="INVALID ID!")))
        with pytest.raises(SystemExit) as exc_info:
            self._run_create(
                ["--from-file", str(payload_file)],
                capsys, builtin_dir, project_dir, tmp_path / "user",
            )
        assert exc_info.value.code != 0
        err = capsys.readouterr().err
        assert "validation_error" in err or "id" in err.lower()

    def test_create_rejects_too_many_tags(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(
            self._valid_payload(tags=["a", "b", "c", "d", "e", "f"])
        ))
        with pytest.raises(SystemExit) as exc_info:
            self._run_create(
                ["--from-file", str(payload_file)],
                capsys, builtin_dir, project_dir, tmp_path / "user",
            )
        assert exc_info.value.code != 0

    def test_create_rejects_bad_tag_chars(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(
            self._valid_payload(tags=["BAD TAG!"])
        ))
        with pytest.raises(SystemExit) as exc_info:
            self._run_create(
                ["--from-file", str(payload_file)],
                capsys, builtin_dir, project_dir, tmp_path / "user",
            )
        assert exc_info.value.code != 0

    def test_create_rejects_nondict_config(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(
            self._valid_payload(config="not-a-dict")
        ))
        with pytest.raises(SystemExit) as exc_info:
            self._run_create(
                ["--from-file", str(payload_file)],
                capsys, builtin_dir, project_dir, tmp_path / "user",
            )
        assert exc_info.value.code != 0

    def test_create_validation_error_prints_details(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(
            self._valid_payload(id="INVALID!", config="bad")
        ))
        with pytest.raises(SystemExit):
            self._run_create(
                ["--from-file", str(payload_file)],
                capsys, builtin_dir, project_dir, tmp_path / "user",
            )
        err = capsys.readouterr().err
        assert "id" in err.lower()
        assert "config" in err.lower()

    # --- builtin conflict ---

    def test_create_rejects_builtin_id(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        project_dir = tmp_path / "project"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(
            self._valid_payload(id="bugfix", name="Bugfix Override")
        ))
        with pytest.raises(SystemExit) as exc_info:
            self._run_create(
                ["--from-file", str(payload_file)],
                capsys, builtin_dir, project_dir, tmp_path / "user",
            )
        assert exc_info.value.code != 0
        err = capsys.readouterr().err
        assert "bugfix" in err or "built-in" in err.lower()

    # --- stdin support ---

    def test_create_from_stdin(self, capsys, tmp_path, monkeypatch):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        payload_json = json.dumps(self._valid_payload())
        import io
        monkeypatch.setattr("sys.stdin", io.StringIO(payload_json))
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            main(["templates", "create", "--from-file", "-"])
        assert (project_dir / "my-pipeline" / "template.json").exists()

    # --- round-trip via list --json ---

    def test_create_roundtrips_via_list_json(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(json.dumps(self._valid_payload()))
        self._run_create(
            ["--from-file", str(payload_file)],
            capsys, builtin_dir, project_dir, user_dir,
        )
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            main(["templates", "list", "--json"])
        out = capsys.readouterr().out
        payload = json.loads(out)
        by_id = {e["id"]: e for e in payload}
        assert "my-pipeline" in by_id
        assert by_id["my-pipeline"]["name"] == "My Pipeline"
        assert by_id["my-pipeline"]["tier"] == "project"
        assert by_id["my-pipeline"]["tags"] == ["fast"]

    # --- invalid JSON ---

    def test_create_invalid_json_exits_nonzero(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text("not valid json {{{")
        with pytest.raises(SystemExit) as exc_info:
            self._run_create(
                ["--from-file", str(payload_file)],
                capsys, builtin_dir, project_dir, tmp_path / "user",
            )
        assert exc_info.value.code != 0

    def test_create_file_not_found_exits_nonzero(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        with pytest.raises(SystemExit) as exc_info:
            self._run_create(
                ["--from-file", str(tmp_path / "no-such-file.json")],
                capsys, builtin_dir, project_dir, tmp_path / "user",
            )
        assert exc_info.value.code != 0
        err = capsys.readouterr().err
        assert "error" in err.lower()


# ---------------------------------------------------------------------------
# Skill-shipping regression: worca-template installs via _install_skills
# ---------------------------------------------------------------------------


class TestWorcaTemplateSkillShipping:
    def test_install_skills_copies_worca_template(self, tmp_path):
        """_install_skills must install worca-template/SKILL.md into .claude/skills/."""
        from worca.cli.init import _install_skills

        source = Path(__file__).resolve().parent.parent / "src" / "worca"
        git_root = tmp_path / "project"
        git_root.mkdir()
        changes = _install_skills(source, git_root)
        installed = git_root / ".claude" / "skills" / "worca-template" / "SKILL.md"
        assert installed.exists(), "worca-template/SKILL.md was not installed"
        assert any("worca-template" in c for c in changes)

    def test_installed_skill_has_valid_frontmatter(self, tmp_path):
        """Installed SKILL.md must have name: worca-template in its frontmatter."""
        from worca.cli.init import _install_skills

        source = Path(__file__).resolve().parent.parent / "src" / "worca"
        git_root = tmp_path / "project"
        git_root.mkdir()
        _install_skills(source, git_root)
        installed = git_root / ".claude" / "skills" / "worca-template" / "SKILL.md"
        content = installed.read_text()
        assert content.startswith("---")
        assert "name: worca-template" in content


# ---------------------------------------------------------------------------
# worca templates export
# ---------------------------------------------------------------------------


class TestTemplatesExportParser:
    def test_export_subcommand_parsed(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "export", "--to", "bundle.json"])
        assert args.command == "templates"
        assert args.templates_command == "export"
        assert args.to == "bundle.json"

    def test_export_to_is_required(self):
        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["templates", "export"])

    def test_export_optional_flags_parsed(self):
        parser = create_parser()
        args = parser.parse_args([
            "templates", "export",
            "--to", "out.json",
            "--include-models",
            "--include-pricing",
            "--templates", "a,b,c",
        ])
        assert args.include_models is True
        assert args.include_pricing is True
        assert args.templates_filter == "a,b,c"

    def test_export_optional_flags_default_false(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "export", "--to", "out.json"])
        assert args.include_models is False
        assert args.include_pricing is False
        assert args.templates_filter is None


class TestTemplatesExport:
    def _setup_templates(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(builtin_dir / "builtin-tmpl", _minimal("builtin-tmpl", tier="builtin"))
        _write_template(project_dir / "proj-tmpl", _minimal("proj-tmpl", tier="project"))
        _write_template(user_dir / "user-tmpl", _minimal("user-tmpl", tier="user"))
        return builtin_dir, project_dir, user_dir

    def _run_export(self, args, capsys, builtin_dir=None, project_dir=None, user_dir=None, settings=None):
        patches = {
            "worca.cli.templates._resolve_dirs": lambda: (builtin_dir, project_dir, user_dir),
        }
        if settings is not None:
            patches["worca.cli.templates._load_current_worca_config"] = lambda: settings
        with patch.dict("os.environ", {}, clear=False):
            with patch(
                "worca.cli.templates._resolve_dirs",
                return_value=(builtin_dir, project_dir, user_dir),
            ):
                extra = patch("worca.cli.templates._load_current_worca_config", return_value=settings) if settings is not None else patch("worca.cli.templates._load_current_worca_config", return_value={})
                with extra:
                    main(["templates", "export"] + args)
        return capsys.readouterr()

    def test_export_writes_file_with_templates(self, capsys, tmp_path):
        builtin_dir, project_dir, user_dir = self._setup_templates(tmp_path)
        out_file = tmp_path / "bundle.json"
        self._run_export(
            ["--to", str(out_file)],
            capsys, builtin_dir, project_dir, user_dir,
        )
        assert out_file.exists()
        bundle = json.loads(out_file.read_text())
        assert bundle["worca_bundle_version"] == 1
        assert "exported_at" in bundle
        ids = {t["id"] for t in bundle["templates"]}
        assert "proj-tmpl" in ids
        assert "user-tmpl" in ids

    def test_export_excludes_builtins_by_default(self, capsys, tmp_path):
        builtin_dir, project_dir, user_dir = self._setup_templates(tmp_path)
        out_file = tmp_path / "bundle.json"
        self._run_export(
            ["--to", str(out_file)],
            capsys, builtin_dir, project_dir, user_dir,
        )
        bundle = json.loads(out_file.read_text())
        ids = {t["id"] for t in bundle["templates"]}
        assert "builtin-tmpl" not in ids

    def test_export_templates_filter(self, capsys, tmp_path):
        builtin_dir, project_dir, user_dir = self._setup_templates(tmp_path)
        out_file = tmp_path / "bundle.json"
        self._run_export(
            ["--to", str(out_file), "--templates", "proj-tmpl"],
            capsys, builtin_dir, project_dir, user_dir,
        )
        bundle = json.loads(out_file.read_text())
        assert len(bundle["templates"]) == 1
        assert bundle["templates"][0]["id"] == "proj-tmpl"

    def test_export_include_models(self, capsys, tmp_path):
        builtin_dir, project_dir, user_dir = self._setup_templates(tmp_path)
        out_file = tmp_path / "bundle.json"
        settings = {"models": {"opus": "claude-opus-4-6"}}
        self._run_export(
            ["--to", str(out_file), "--include-models"],
            capsys, builtin_dir, project_dir, user_dir, settings=settings,
        )
        bundle = json.loads(out_file.read_text())
        assert bundle["models"] == {"opus": "claude-opus-4-6"}

    def test_export_include_pricing(self, capsys, tmp_path):
        builtin_dir, project_dir, user_dir = self._setup_templates(tmp_path)
        out_file = tmp_path / "bundle.json"
        settings = {"pricing": {"currency": "USD"}}
        self._run_export(
            ["--to", str(out_file), "--include-pricing"],
            capsys, builtin_dir, project_dir, user_dir, settings=settings,
        )
        bundle = json.loads(out_file.read_text())
        assert bundle["pricing"] == {"currency": "USD"}

    def test_export_redacts_secrets(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(project_dir / "sec-tmpl", {
            **_minimal("sec-tmpl", tier="project"),
            "config": {"agents": {"planner": {"env": {"KEY": "sk-abcdefghijklmnopqrstuvwxyz"}}}},
        })
        out_file = tmp_path / "bundle.json"
        self._run_export(
            ["--to", str(out_file)],
            capsys, builtin_dir, project_dir, user_dir,
        )
        bundle = json.loads(out_file.read_text())
        assert "_redacted" in bundle
        tmpl = bundle["templates"][0]
        assert "env" not in tmpl.get("config", {}).get("agents", {}).get("planner", {})

    def test_export_gist_calls_gh(self, capsys, tmp_path):
        builtin_dir, project_dir, user_dir = self._setup_templates(tmp_path)
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = type("R", (), {"returncode": 0, "stdout": "https://gist.github.com/user/abc123\n", "stderr": ""})()
            self._run_export(
                ["--to", "gist"],
                capsys, builtin_dir, project_dir, user_dir,
            )
        mock_run.assert_called_once()
        call_args = mock_run.call_args
        assert "gh" in call_args[0][0]
        assert "gist" in call_args[0][0]
        assert "--public" not in call_args[0][0]

    def test_export_gist_public(self, capsys, tmp_path):
        builtin_dir, project_dir, user_dir = self._setup_templates(tmp_path)
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = type("R", (), {"returncode": 0, "stdout": "https://gist.github.com/user/abc123\n", "stderr": ""})()
            self._run_export(
                ["--to", "gist:public"],
                capsys, builtin_dir, project_dir, user_dir,
            )
        call_args = mock_run.call_args
        assert "--public" in call_args[0][0]


# ---------------------------------------------------------------------------
# worca templates import
# ---------------------------------------------------------------------------


def _make_bundle(templates=None, models=None, pricing=None, version=1):
    """Build a minimal valid bundle dict for testing."""
    bundle = {
        "worca_bundle_version": version,
        "exported_at": "2026-05-30T07:31:07Z",
        "templates": templates or [
            {
                "id": "imported-tmpl",
                "name": "Imported Template",
                "description": "A template from a bundle",
                "tags": ["fast"],
                "config": {},
            }
        ],
    }
    if models is not None:
        bundle["models"] = models
    if pricing is not None:
        bundle["pricing"] = pricing
    return bundle


class TestTemplatesImportParser:
    def test_import_subcommand_parsed(self):
        parser = create_parser()
        args = parser.parse_args([
            "templates", "import",
            "--from", "bundle.json",
            "--scope", "user",
            "--non-interactive",
        ])
        assert args.command == "templates"
        assert args.templates_command == "import"
        assert args.from_source == "bundle.json"
        assert args.scope == "user"
        assert args.non_interactive is True

    def test_import_from_is_required(self):
        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["templates", "import"])

    def test_import_defaults(self):
        parser = create_parser()
        args = parser.parse_args(["templates", "import", "--from", "b.json"])
        assert args.scope == "project"
        assert args.non_interactive is False


class TestTemplatesImport:
    def _run_import(
        self, args, capsys, builtin_dir=None, project_dir=None, user_dir=None,
        settings_path=None, stdin_lines=None,
    ):
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ):
            extra_patches = {}
            if settings_path is not None:
                extra_patches["worca.cli.templates._find_settings_path"] = lambda: settings_path
            if stdin_lines is not None:
                extra_patches["builtins.input"] = lambda prompt="": stdin_lines.pop(0)
            with patch.dict("os.environ", {}, clear=False):
                active_patches = []
                for target, replacement in extra_patches.items():
                    p = patch(target, replacement)
                    p.__enter__()
                    active_patches.append(p)
                try:
                    main(["templates", "import"] + args)
                finally:
                    for p in reversed(active_patches):
                        p.__exit__(None, None, None)
        return capsys.readouterr()

    def test_import_from_file(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(_make_bundle()))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ):
            main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])

        out = capsys.readouterr()
        assert (project_dir / "imported-tmpl" / "template.json").exists()
        data = json.loads((project_dir / "imported-tmpl" / "template.json").read_text())
        assert data["id"] == "imported-tmpl"
        assert "imported" in out.out.lower() or "1 template" in out.out.lower()

    def test_import_collision_skip_non_interactive(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(project_dir / "imported-tmpl", _minimal("imported-tmpl", tier="project"))
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(_make_bundle()))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ):
            main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])

        out = capsys.readouterr()
        assert "skip" in out.out.lower() or "skipped" in out.err.lower() or "0 template" in out.out.lower()

    def test_import_collision_replace_interactive(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(project_dir / "imported-tmpl", _minimal("imported-tmpl", tier="project", name="Old"))
        bundle = _make_bundle()
        bundle["templates"][0]["name"] = "New Name"
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ), patch("builtins.input", return_value="r"):
            main(["templates", "import", "--from", str(bundle_file)])

        data = json.loads((project_dir / "imported-tmpl" / "template.json").read_text())
        assert data["name"] == "New Name"

    def test_import_scope_user_skips_models_pricing(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        bundle = _make_bundle(
            models={"opus": "claude-opus-4-6"},
            pricing={"currency": "USD"},
        )
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ):
            main(["templates", "import", "--from", str(bundle_file), "--scope", "user", "--non-interactive"])

        out = capsys.readouterr()
        assert "skipped" in out.err.lower() or "skip" in out.err.lower()
        assert (user_dir / "imported-tmpl" / "template.json").exists()

    def test_import_reserved_env_key_stripping(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir(parents=True)
        settings_path = settings_dir / "settings.json"
        settings_path.write_text(json.dumps({"worca": {}}))

        bundle = _make_bundle(
            models={
                "proxy": {
                    "id": "claude-opus-4-6",
                    "env": {
                        "ANTHROPIC_BASE_URL": "https://proxy.example.com",
                        "WORCA_AGENT": "guardian",
                        "PATH": "/sneaky",
                    },
                }
            },
        )
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(settings_path),
        ):
            main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])

        capsys.readouterr()
        written = json.loads(settings_path.read_text())
        proxy_env = written.get("worca", {}).get("models", {}).get("proxy", {}).get("env", {})
        assert "ANTHROPIC_BASE_URL" in proxy_env
        assert "WORCA_AGENT" not in proxy_env
        assert "PATH" not in proxy_env

    def test_import_rollback_on_error(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        bundle = _make_bundle(templates=[
            {"id": "tmpl-a", "name": "A", "description": "a", "tags": [], "config": {}},
            {"id": "tmpl-b", "name": "B", "description": "b", "tags": [], "config": {}},
        ])
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        original_copytree = __import__("shutil").copytree
        call_count = [0]

        def failing_copytree(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 2:
                raise OSError("disk full")
            return original_copytree(*args, **kwargs)

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ), patch("shutil.copytree", side_effect=failing_copytree):
            with pytest.raises(SystemExit):
                main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])

        assert not (project_dir / "tmpl-a").exists()
        assert not (project_dir / "tmpl-b").exists()

    def test_import_invalid_version_rejected(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(_make_bundle(version=99)))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ):
            with pytest.raises(SystemExit) as exc_info:
                main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])
            assert exc_info.value.code != 0

        err = capsys.readouterr().err
        assert "version" in err.lower()

    def test_import_url_source_via_fetch(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"

        bundle = _make_bundle()
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ), patch(
            "worca.cli.templates.fetch_bundle",
            return_value=bundle,
        ) as mock_fetch:
            main([
                "templates", "import",
                "--from", "https://example.com/bundle.json",
                "--non-interactive",
            ])
            mock_fetch.assert_called_once_with("https://example.com/bundle.json")

        assert (project_dir / "imported-tmpl" / "template.json").exists()

    def test_import_with_models_and_pricing(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir(parents=True)
        settings_path = settings_dir / "settings.json"
        settings_path.write_text(json.dumps({"worca": {"models": {"sonnet": "claude-sonnet-4-6"}}}))

        bundle = _make_bundle(
            models={"opus": "claude-opus-4-6"},
            pricing={"currency": "USD"},
        )
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(settings_path),
        ):
            main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])

        written = json.loads(settings_path.read_text())
        assert written["worca"]["models"]["opus"] == "claude-opus-4-6"
        assert written["worca"]["models"]["sonnet"] == "claude-sonnet-4-6"
        assert written["worca"]["pricing"]["currency"] == "USD"
