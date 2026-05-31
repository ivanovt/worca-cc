"""Tests for worca templates CLI subcommands (list, show, create)."""

import json
import os
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
        # encoding='utf-8' is required — SKILL.md carries non-ASCII (em-dashes,
        # ⚠️) and Windows defaults to cp1252 in `read_text()` without it.
        content = installed.read_text(encoding="utf-8")
        assert content.startswith("---")
        assert "name: worca-template" in content

    def test_install_skills_copies_sibling_assets(self, tmp_path):
        """_install_skills must copy non-SKILL.md sibling files (e.g. worca-notify's
        send.mjs). Without this, the worca-notify skill would ship a SKILL.md that
        instructs Claude to invoke a Node script that doesn't exist on the target."""
        from worca.cli.init import _install_skills

        source = Path(__file__).resolve().parent.parent / "src" / "worca"
        git_root = tmp_path / "project"
        git_root.mkdir()
        _install_skills(source, git_root)
        send_mjs = git_root / ".claude" / "skills" / "worca-notify" / "send.mjs"
        skill_md = git_root / ".claude" / "skills" / "worca-notify" / "SKILL.md"
        assert send_mjs.exists(), "worca-notify/send.mjs was not installed"
        assert skill_md.exists(), "worca-notify/SKILL.md was not installed"
        # send.mjs must be substantial (>= 1KB) — guards against a stray
        # empty-file install if directory iteration ever silently fails.
        assert send_mjs.stat().st_size > 1024


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
        # Template must reference `opus` for it to survive the alias filter
        # — bare `--include-models` no longer copies the whole worca.models
        # block verbatim.
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(project_dir / "proj-tmpl", {
            **_minimal("proj-tmpl", tier="project"),
            "config": {"agents": {"planner": {"model": "opus"}}},
        })
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
        # Env scaffolding is preserved (keys still there) — only the secret
        # VALUE is replaced with the placeholder.
        env = tmpl["config"]["agents"]["planner"]["env"]
        assert "KEY" in env
        assert env["KEY"] == "<YOUR-SECRET-HERE>"
        assert "templates[0].config.agents.planner.env.KEY" in bundle["_redacted"]

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
            templates=[{
                "id": "imported-tmpl",
                "name": "Imported Template",
                "description": "A template from a bundle",
                "tags": ["fast"],
                "config": {"agents": {"planner": {"model": "proxy"}}},
            }],
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
        # Template must reference `opus` to survive the alias filter; bundle
        # pricing top-level keys (currency) pass through regardless.
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir(parents=True)
        settings_path = settings_dir / "settings.json"
        settings_path.write_text(json.dumps({"worca": {"models": {"sonnet": "claude-sonnet-4-6"}}}))

        bundle = _make_bundle(
            templates=[{
                "id": "imported-tmpl",
                "name": "Imported Template",
                "description": "A template from a bundle",
                "tags": ["fast"],
                "config": {"agents": {"planner": {"model": "opus"}}},
            }],
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


# ---------------------------------------------------------------------------
# End-to-end roundtrip + rollback + collision UX
# ---------------------------------------------------------------------------


class TestExportImportRoundtrip:
    """Export a template, fetch the bundle, import into a fresh target,
    confirm the imported template matches the redacted source."""

    def test_roundtrip_via_file(self, capsys, tmp_path):
        # ---- Source side: project has one template ----
        src_builtin = tmp_path / "src" / "builtin"
        src_project = tmp_path / "src" / "project"
        src_user = tmp_path / "src" / "user"
        src_builtin.mkdir(parents=True)
        _write_template(src_project / "shared-tmpl", {
            **_minimal("shared-tmpl", tier="project", name="Shared"),
            "config": {
                "stages": {"planner": {"enabled": True}},
                "agents": {"planner": {"model": "opus", "max_turns": 30}},
                # This subtree must be stripped by the allowlist.
                "webhooks": [{"url": "https://hook/", "secret": "supersecret"}],
            },
        })
        bundle_file = tmp_path / "bundle.json"

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(src_builtin, src_project, src_user),
        ), patch(
            "worca.cli.templates._load_current_worca_config",
            return_value={},
        ):
            main(["templates", "export", "--to", str(bundle_file)])

        bundle = json.loads(bundle_file.read_text())
        # webhooks must be gone, allowlisted fields must survive.
        cfg = bundle["templates"][0]["config"]
        assert "webhooks" not in cfg
        assert cfg["stages"] == {"planner": {"enabled": True}}
        assert cfg["agents"]["planner"]["model"] == "opus"
        assert "_stripped" in bundle

        # ---- Target side: fresh directories ----
        dst_builtin = tmp_path / "dst" / "builtin"
        dst_project = tmp_path / "dst" / "project"
        dst_user = tmp_path / "dst" / "user"
        dst_builtin.mkdir(parents=True)

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(dst_builtin, dst_project, dst_user),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ):
            main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])

        landed = json.loads((dst_project / "shared-tmpl" / "template.json").read_text())
        assert landed["id"] == "shared-tmpl"
        assert landed["name"] == "Shared"
        # Imported config matches the redacted bundle — no webhooks leaked through.
        assert "webhooks" not in landed["config"]
        assert landed["config"]["agents"]["planner"]["model"] == "opus"


class TestImportRollbackOnSettingsFailure:
    """If os.replace(settings.json) fails, both the newly-copied templates
    AND the original settings.json must be restored to their pre-import state."""

    def test_rollback_restores_settings_and_templates(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        # Existing settings.json with content we want to preserve on failure.
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir()
        settings_path = settings_dir / "settings.json"
        original_settings = {
            "worca": {
                "models": {"sonnet": "claude-sonnet-4-6"},
                "pricing": {"currency": "EUR"},
            },
        }
        settings_path.write_text(json.dumps(original_settings))
        # Existing template at same id — replacing this is part of what we want
        # to be reversible.
        _write_template(project_dir / "imported-tmpl", _minimal(
            "imported-tmpl", tier="project", name="Original",
        ))

        bundle = _make_bundle(models={"opus": "claude-opus-4-6"})
        bundle["templates"][0]["name"] = "New"
        # Template must reference `opus` for bundle_models to survive the
        # alias filter and settings.json to be touched at all.
        bundle["templates"][0]["config"] = {"agents": {"planner": {"model": "opus"}}}
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        original_replace = __import__("os").replace
        def failing_replace(src, dst):
            if str(dst) == str(settings_path):
                raise OSError("simulated cross-device move")
            return original_replace(src, dst)

        # Interactive `r`eplace for the existing-template collision; new
        # `opus` model in bundle doesn't collide with existing `sonnet`, so
        # the alias-collision prompt is never reached.
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(settings_path),
        ), patch("os.replace", side_effect=failing_replace), patch(
            "builtins.input", return_value="r",
        ):
            with pytest.raises(SystemExit):
                main(["templates", "import", "--from", str(bundle_file)])

        # settings.json restored to original content
        restored = json.loads(settings_path.read_text())
        assert restored == original_settings, "settings.json must be reverted on failure"

        # Original template content restored (name="Original", not "New")
        landed = json.loads((project_dir / "imported-tmpl" / "template.json").read_text())
        assert landed["name"] == "Original"

        # No leftover .bak-* siblings
        leftovers = [
            p for p in project_dir.iterdir() if ".bak-" in p.name
        ] + [
            p for p in settings_dir.iterdir() if ".bak-" in p.name
        ]
        assert leftovers == [], f"leftover backups after rollback: {leftovers}"


class TestImportCrossDeviceSafety:
    """Regression: settings.json staging file must live in the SAME parent
    directory as the target so the final `os.replace` is single-filesystem.

    Background: `tempfile.mkdtemp()` returns a path under `tempfile.gettempdir()`
    (`/private/var/folders/...` on macOS, `/tmp` on Linux, `C:\\…\\Temp` on
    Windows) which is frequently on a different filesystem from the project
    repo (`/Volumes/X`, ext4 on `/home`, a `D:\\` drive). Staging settings.json
    in the system tempdir and then calling `os.replace(staged, target)` raises
    `OSError: [Errno 18] Cross-device link` on POSIX and
    `ERROR_NOT_SAME_DEVICE` on Windows — wiping the import via the rollback
    path even though nothing is actually wrong with the bundle.
    """

    def test_settings_staged_in_target_dir(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir()
        settings_path = settings_dir / "settings.json"
        settings_path.write_text(json.dumps({"worca": {}}))

        # Bundle must include a model the imported template references, so
        # the settings.json patch is non-empty and os.replace is reached.
        bundle = _make_bundle(models={"opus": "claude-opus-4-6"})
        bundle["templates"][0]["config"] = {"agents": {"planner": {"model": "opus"}}}
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        captured: list[tuple[str, str]] = []
        original_replace = os.replace

        def capturing_replace(src, dst, *args, **kwargs):
            captured.append((str(src), str(dst)))
            return original_replace(src, dst, *args, **kwargs)

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(settings_path),
        ), patch("worca.cli.templates.os.replace", side_effect=capturing_replace):
            main(["templates", "import", "--from", str(bundle_file)])

        settings_calls = [c for c in captured if c[1] == str(settings_path)]
        assert len(settings_calls) == 1, (
            f"expected exactly one os.replace targeting settings.json, "
            f"got {settings_calls}"
        )
        src, dst = settings_calls[0]
        assert Path(src).parent == Path(dst).parent, (
            f"settings.json staging must be in the same directory as the target "
            f"so os.replace stays single-filesystem. "
            f"src parent: {Path(src).parent}, dst parent: {Path(dst).parent}. "
            f"Cross-device staging triggers EXDEV on POSIX / ERROR_NOT_SAME_DEVICE "
            f"on Windows and silently routes the import through the rollback path."
        )

    def test_import_succeeds_under_simulated_cross_device_rename(self, tmp_path):
        """Simulate a real cross-device rename by raising EXDEV from os.replace
        whenever src and dst are in different parent directories — that's the
        kernel's actual EXDEV trigger condition. Before the fix, the settings
        staging file lived under the system tempdir while the target lived in
        the project's `.claude/`, so this check would fire and the import would
        bail. After the fix, every `os.replace` in the import path has src and
        dst as siblings, so the simulated EXDEV never fires."""
        import errno

        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir()
        settings_path = settings_dir / "settings.json"
        settings_path.write_text(json.dumps({"worca": {}}))

        bundle = _make_bundle(models={"opus": "claude-opus-4-6"})
        bundle["templates"][0]["config"] = {"agents": {"planner": {"model": "opus"}}}
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        original_replace = os.replace

        def exdev_on_different_parents(src, dst, *args, **kwargs):
            if Path(src).parent.resolve() != Path(dst).parent.resolve():
                raise OSError(errno.EXDEV, "simulated cross-device link")
            return original_replace(src, dst, *args, **kwargs)

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(settings_path),
        ), patch(
            "worca.cli.templates.os.replace",
            side_effect=exdev_on_different_parents,
        ):
            main(["templates", "import", "--from", str(bundle_file)])

        # Template landed
        landed = json.loads(
            (project_dir / "imported-tmpl" / "template.json").read_text()
        )
        assert landed["config"]["agents"]["planner"]["model"] == "opus"
        # Settings.json picked up the new model alias
        post = json.loads(settings_path.read_text())
        assert post["worca"]["models"]["opus"] == "claude-opus-4-6"
        # And no staged-import or .bak-* leftovers next to settings.json
        leftovers = [
            p for p in settings_dir.iterdir()
            if p.name != "settings.json" and (
                ".bak-" in p.name or p.name.startswith(".settings.json.import-")
            )
        ]
        assert leftovers == [], f"leftover staging/backup files: {leftovers}"


class TestImportMixedCollision:
    """Bundle contains one colliding and one non-colliding template;
    non-interactive skip should land the non-colliding one and skip the other."""

    def test_mixed_collision_non_interactive(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(project_dir / "collides", _minimal("collides", tier="project", name="Original"))

        bundle = _make_bundle(templates=[
            {"id": "collides", "name": "FromBundle", "description": "d", "tags": [], "config": {}},
            {"id": "new-tmpl", "name": "Fresh", "description": "d", "tags": [], "config": {}},
        ])
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ):
            main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])

        # Colliding one: still original
        collides_data = json.loads((project_dir / "collides" / "template.json").read_text())
        assert collides_data["name"] == "Original"
        # Non-colliding one: landed
        assert (project_dir / "new-tmpl" / "template.json").exists()
        new_data = json.loads((project_dir / "new-tmpl" / "template.json").read_text())
        assert new_data["name"] == "Fresh"


class TestImportCollisionReprompt:
    """Unknown collision input must re-prompt, not silently skip."""

    def test_reprompt_on_unknown_then_replace(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(project_dir / "imported-tmpl", _minimal("imported-tmpl", tier="project", name="Old"))

        bundle = _make_bundle()
        bundle["templates"][0]["name"] = "New"
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        answers = iter(["maybe?", "", "y", "r"])  # garbage, garbage, garbage, replace

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ), patch("builtins.input", side_effect=lambda *_: next(answers)):
            main(["templates", "import", "--from", str(bundle_file)])

        landed = json.loads((project_dir / "imported-tmpl" / "template.json").read_text())
        assert landed["name"] == "New"
        # Some "unrecognized choice" feedback should have been emitted
        err = capsys.readouterr().err
        assert "unrecognized" in err.lower()


class TestImportBuiltinShadowInfo:
    """Importing a same-id template over a builtin should surface an info line."""

    def test_info_line_when_shadowing_builtin(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        # Builtin template with id "imported-tmpl"
        _write_template(builtin_dir / "imported-tmpl", _minimal("imported-tmpl", tier="builtin"))

        bundle = _make_bundle()
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._find_settings_path",
            return_value=str(tmp_path / ".claude" / "settings.json"),
        ):
            main(["templates", "import", "--from", str(bundle_file), "--non-interactive"])

        err = capsys.readouterr().err.lower()
        assert "shadowing" in err
        assert "imported-tmpl" in err
        # Template did land (no collision because builtin tier ≠ project tier)
        assert (project_dir / "imported-tmpl" / "template.json").exists()


class TestImportDeepMerge:
    """Importing models into a settings.json that already has different models
    must preserve both — deep-merge, not replace."""

    def test_deep_merge_preserves_existing_models(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir()
        settings_path = settings_dir / "settings.json"
        # Existing has 'haiku' AND custom unrelated config that must survive.
        settings_path.write_text(json.dumps({
            "worca": {
                "models": {"haiku": "claude-haiku-4-5"},
                "loops": {"plan_review": {"max": 5}},
            },
            "other_top_level": {"keep_me": True},
        }))

        # Templates must reference both aliases for them to survive the
        # alias filter; bundle's `sonnet` matches the target's `sonnet`
        # (no collision), so neither alias triggers the collision prompt.
        bundle = _make_bundle(
            templates=[{
                "id": "imported-tmpl",
                "name": "Imported Template",
                "description": "",
                "tags": [],
                "config": {
                    "agents": {
                        "planner": {"model": "opus"},
                        "implementer": {"model": "sonnet"},
                    },
                },
            }],
            models={"opus": "claude-opus-4-6", "sonnet": "claude-sonnet-4-6"},
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

        merged = json.loads(settings_path.read_text())
        models = merged["worca"]["models"]
        assert models["haiku"] == "claude-haiku-4-5"
        assert models["opus"] == "claude-opus-4-6"
        assert models["sonnet"] == "claude-sonnet-4-6"
        # Unrelated config preserved.
        assert merged["worca"]["loops"]["plan_review"]["max"] == 5
        assert merged["other_top_level"]["keep_me"] is True


class TestImportPlaceholderWarning:
    """Bundles carrying <YOUR-SECRET-HERE> placeholder values should produce an
    info line listing every placeholder path the user needs to fill in."""

    def test_placeholder_paths_surfaced(self, capsys, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir()
        settings_path = settings_dir / "settings.json"
        settings_path.write_text(json.dumps({"worca": {}}))

        # Template references `opus` so the bundle's opus model survives the
        # alias filter; the FOO_TOKEN placeholder under models.opus.env must
        # then land in settings and be reported.
        bundle = _make_bundle(
            templates=[{
                "id": "with-secrets",
                "name": "With Secrets",
                "description": "",
                "tags": [],
                "config": {
                    "agents": {
                        "planner": {
                            "model": "opus",
                            "env": {"ANTHROPIC_API_KEY": "<YOUR-SECRET-HERE>"},
                        },
                    },
                },
            }],
            models={
                "opus": {"id": "claude-opus-4-6", "env": {"FOO_TOKEN": "<YOUR-SECRET-HERE>"}},
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

        err = capsys.readouterr().err
        assert "placeholder" in err.lower()
        assert "ANTHROPIC_API_KEY" in err
        assert "FOO_TOKEN" in err


# ---------------------------------------------------------------------------
# Alias-scoped models/pricing filtering (export + import) and per-alias
# collision UX on import. The general policy is:
#   - export drops models/pricing entries the bundled templates don't
#     reference (one-hop alias chain followed);
#   - import does the same against the bundled templates that landed;
#   - on top of that, import detects per-alias collisions against the
#     target settings and refuses to silently overwrite them.
# ---------------------------------------------------------------------------


class TestExportAliasFiltering:
    def _setup(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        return builtin_dir, project_dir, user_dir

    def test_export_drops_unreferenced_models(self, capsys, tmp_path):
        builtin_dir, project_dir, user_dir = self._setup(tmp_path)
        _write_template(project_dir / "uses-opus", {
            **_minimal("uses-opus", tier="project"),
            "config": {"agents": {"planner": {"model": "opus"}}},
        })
        settings = {
            "models": {
                "opus": "claude-opus-4-6",
                "sonnet": "claude-sonnet-4-6",
                "haiku": "claude-haiku-4-5",
            },
        }
        out_file = tmp_path / "bundle.json"
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._load_current_worca_config",
            return_value=settings,
        ):
            main(["templates", "export", "--to", str(out_file), "--include-models"])

        bundle = json.loads(out_file.read_text())
        assert set(bundle["models"].keys()) == {"opus"}
        err = capsys.readouterr().err
        assert "haiku" in err and "sonnet" in err

    def test_export_keeps_only_directly_referenced_alias(self, capsys, tmp_path):
        """Template references glm-ds. glm-ds.id happens to be "opus" but
        that does NOT pull worca.models["opus"] into the bundle — `id` is the
        literal string passed to claude --model, not a recursive alias
        reference. Only glm-ds should survive."""
        builtin_dir, project_dir, user_dir = self._setup(tmp_path)
        _write_template(project_dir / "uses-glm", {
            **_minimal("uses-glm", tier="project"),
            "config": {"agents": {"planner": {"model": "glm-ds"}}},
        })
        settings = {
            "models": {
                "opus": "claude-opus-4-6",
                "sonnet": "claude-sonnet-4-6",
                "glm-ds": {"id": "opus", "env": {"ANTHROPIC_BASE_URL": "https://x/"}},
            },
        }
        out_file = tmp_path / "bundle.json"
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._load_current_worca_config",
            return_value=settings,
        ):
            main(["templates", "export", "--to", str(out_file), "--include-models"])

        bundle = json.loads(out_file.read_text())
        assert set(bundle["models"].keys()) == {"glm-ds"}
        assert "opus" not in bundle["models"]
        assert "sonnet" not in bundle["models"]

    def test_export_pricing_keeps_non_models_keys(self, capsys, tmp_path):
        """server_tools, currency, last_updated are project-wide context —
        they must survive even when no templates reference any model."""
        builtin_dir, project_dir, user_dir = self._setup(tmp_path)
        _write_template(project_dir / "no-models", _minimal("no-models", tier="project"))
        settings = {
            "pricing": {
                "models": {"opus": {"input_per_mtok": 5}},
                "server_tools": {"web_search_per_request": 0.01},
                "currency": "USD",
                "last_updated": "2026-04-06",
            },
        }
        out_file = tmp_path / "bundle.json"
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._load_current_worca_config",
            return_value=settings,
        ):
            main(["templates", "export", "--to", str(out_file), "--include-pricing"])

        bundle = json.loads(out_file.read_text())
        # models filtered to empty (no template references anything)...
        assert bundle["pricing"]["models"] == {}
        # ...but the rest of the pricing context is preserved.
        assert bundle["pricing"]["currency"] == "USD"
        assert bundle["pricing"]["server_tools"]["web_search_per_request"] == 0.01
        assert bundle["pricing"]["last_updated"] == "2026-04-06"

    def test_export_no_model_refs_drops_models_block(self, capsys, tmp_path):
        """Bare `--include-models` on a template that uses no models drops
        the `models` key entirely rather than emitting an empty {}."""
        builtin_dir, project_dir, user_dir = self._setup(tmp_path)
        _write_template(project_dir / "no-models", _minimal("no-models", tier="project"))
        settings = {"models": {"opus": "claude-opus-4-6"}}
        out_file = tmp_path / "bundle.json"
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin_dir, project_dir, user_dir),
        ), patch(
            "worca.cli.templates._load_current_worca_config",
            return_value=settings,
        ):
            main(["templates", "export", "--to", str(out_file), "--include-models"])

        bundle = json.loads(out_file.read_text())
        assert "models" not in bundle
        err = capsys.readouterr().err
        assert "no templates reference any model alias" in err


class TestImportAliasFiltering:
    def test_import_drops_unreferenced_bundle_models(self, capsys, tmp_path):
        """Bundle ships sonnet+haiku but the imported template only uses opus
        — only opus should land in settings.json."""
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir()
        settings_path = settings_dir / "settings.json"
        settings_path.write_text(json.dumps({"worca": {}}))

        bundle = _make_bundle(
            templates=[{
                "id": "imported-tmpl",
                "name": "Imported",
                "description": "",
                "tags": [],
                "config": {"agents": {"planner": {"model": "opus"}}},
            }],
            models={
                "opus": "claude-opus-4-6",
                "sonnet": "claude-sonnet-4-6",
                "haiku": "claude-haiku-4-5",
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

        written = json.loads(settings_path.read_text())
        assert set(written["worca"]["models"].keys()) == {"opus"}


class TestImportAliasCollision:
    """When bundle's alias would overwrite a different local value, the
    importer must surface the collision and (in non-interactive mode)
    default to preserving the local value."""

    def _run(self, tmp_path, *, current_models, bundle_models, template_model="opus",
             interactive_input=None):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir()
        settings_path = settings_dir / "settings.json"
        settings_path.write_text(json.dumps({"worca": {"models": current_models}}))

        bundle = _make_bundle(
            templates=[{
                "id": "uses-alias",
                "name": "Uses Alias",
                "description": "",
                "tags": [],
                "config": {"agents": {"planner": {"model": template_model}}},
            }],
            models=bundle_models,
        )
        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(bundle))

        patches = [
            patch("worca.cli.templates._resolve_dirs",
                  return_value=(builtin_dir, project_dir, user_dir)),
            patch("worca.cli.templates._find_settings_path",
                  return_value=str(settings_path)),
        ]
        args = ["templates", "import", "--from", str(bundle_file)]
        if interactive_input is None:
            args.append("--non-interactive")
        else:
            patches.append(patch("builtins.input", return_value=interactive_input))

        for p in patches:
            p.__enter__()
        try:
            try:
                main(args)
            except SystemExit:
                pass  # `abort` raises SystemExit — caller asserts side-effects
        finally:
            for p in reversed(patches):
                p.__exit__(None, None, None)

        return json.loads(settings_path.read_text())

    def test_same_value_is_not_a_collision(self, capsys, tmp_path):
        written = self._run(
            tmp_path,
            current_models={"opus": "claude-opus-4-6"},
            bundle_models={"opus": "claude-opus-4-6"},
        )
        # Identical value: no prompt, no warning, value preserved.
        assert written["worca"]["models"]["opus"] == "claude-opus-4-6"
        err = capsys.readouterr().err
        assert "would overwrite" not in err

    def test_different_value_non_interactive_keeps_local(self, capsys, tmp_path):
        """Bundle's opus differs from local's — non-interactive defaults to
        skip (preserve target), bundle value dropped."""
        written = self._run(
            tmp_path,
            current_models={"opus": "claude-opus-4-7"},  # newer locally
            bundle_models={"opus": "claude-opus-4-6"},   # older in bundle
        )
        assert written["worca"]["models"]["opus"] == "claude-opus-4-7"
        err = capsys.readouterr().err
        assert "would overwrite" in err
        assert "kept target's existing values" in err

    def test_different_value_interactive_replace(self, capsys, tmp_path):
        written = self._run(
            tmp_path,
            current_models={"opus": "claude-opus-4-7"},
            bundle_models={"opus": "claude-opus-4-6"},
            interactive_input="r",
        )
        # Replace: bundle wins.
        assert written["worca"]["models"]["opus"] == "claude-opus-4-6"

    def test_different_value_interactive_skip(self, capsys, tmp_path):
        written = self._run(
            tmp_path,
            current_models={"opus": "claude-opus-4-7"},
            bundle_models={"opus": "claude-opus-4-6"},
            interactive_input="s",
        )
        # Skip: local preserved.
        assert written["worca"]["models"]["opus"] == "claude-opus-4-7"

    def test_new_alias_no_collision(self, capsys, tmp_path):
        """Bundle adds a fresh alias that doesn't exist locally — no collision,
        merge proceeds, no overwrite warning."""
        written = self._run(
            tmp_path,
            current_models={"sonnet": "claude-sonnet-4-6"},
            bundle_models={"opus": "claude-opus-4-6"},
        )
        assert written["worca"]["models"]["opus"] == "claude-opus-4-6"
        assert written["worca"]["models"]["sonnet"] == "claude-sonnet-4-6"
        err = capsys.readouterr().err
        assert "would overwrite" not in err
