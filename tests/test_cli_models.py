"""Tests for `worca models add` CLI subcommand (Phase 7)."""

import json
import os
from unittest import mock

import pytest

from worca.cli.main import main


def _run(*argv, expected_exit=0):
    """Run worca CLI with given args; assert exit code matches expected_exit."""
    if expected_exit == 0:
        main(list(argv))
        return
    with pytest.raises(SystemExit) as exc_info:
        main(list(argv))
    assert exc_info.value.code == expected_exit, (
        f"Expected exit {expected_exit}, got {exc_info.value.code}"
    )


def _read_json(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class TestModelsAddUser:
    def test_writes_user_settings(self, tmp_path):
        global_path = str(tmp_path / "settings.json")
        with mock.patch("worca.utils.settings._default_global_path", return_value=global_path):
            _run("models", "add", "--tier", "user", "my-alias", "claude-sonnet-4-6")

        data = _read_json(global_path)
        assert data["worca"]["models"]["my-alias"] == "claude-sonnet-4-6"

    def test_writes_user_settings_with_env(self, tmp_path):
        global_path = str(tmp_path / "settings.json")
        local_path = str(tmp_path / "settings.local.json")
        with mock.patch("worca.utils.settings._default_global_path", return_value=global_path):
            _run(
                "models", "add", "--tier", "user",
                "my-alias", "claude-sonnet-4-6",
                "--env", "ANTHROPIC_BASE_URL=https://proxy.example",
            )

        data = _read_json(global_path)
        assert data["worca"]["models"]["my-alias"] == {"id": "claude-sonnet-4-6"}

        local = _read_json(local_path)
        assert local["worca"]["models"]["my-alias"] == {"env": {"ANTHROPIC_BASE_URL": "https://proxy.example"}}


class TestModelsAddProject:
    def _make_project(self, tmp_path):
        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()
        return tmp_path

    def test_writes_project_settings_with_env(self, tmp_path):
        project = self._make_project(tmp_path)
        settings_path = project / ".claude" / "settings.json"
        local_path = project / ".claude" / "settings.local.json"

        with mock.patch("os.getcwd", return_value=str(project)):
            _run(
                "models", "add", "--tier", "project",
                "my-alias", "claude-sonnet-4-6",
                "--env", "ANTHROPIC_BASE_URL=https://proxy.example",
            )

        data = _read_json(str(settings_path))
        assert data["worca"]["models"]["my-alias"] == {"id": "claude-sonnet-4-6"}

        local = _read_json(str(local_path))
        assert local["worca"]["models"]["my-alias"] == {"env": {"ANTHROPIC_BASE_URL": "https://proxy.example"}}

    def test_writes_project_settings_no_env(self, tmp_path):
        project = self._make_project(tmp_path)
        settings_path = project / ".claude" / "settings.json"

        with mock.patch("os.getcwd", return_value=str(project)):
            _run("models", "add", "--tier", "project", "bare-alias", "claude-opus-4-8")

        data = _read_json(str(settings_path))
        assert data["worca"]["models"]["bare-alias"] == "claude-opus-4-8"


class TestModelsAddRejections:
    def test_builtin_tier_rejected(self, capsys):
        _run("models", "add", "--tier", "builtin", "foo", "bar", expected_exit=1)
        out = capsys.readouterr()
        assert "built-in models are not user-writable" in out.err

    def test_colon_in_alias_rejected(self, capsys):
        _run("models", "add", "--tier", "user", "foo:bar", "baz", expected_exit=1)
        out = capsys.readouterr()
        assert "alias name cannot contain" in out.err or "colon" in out.err

    def test_reserved_env_key_rejected(self, capsys, tmp_path):
        global_path = str(tmp_path / "settings.json")
        with mock.patch("worca.utils.settings._default_global_path", return_value=global_path):
            _run(
                "models", "add", "--tier", "user",
                "foo", "claude-sonnet-4-6",
                "--env", "PATH=/usr/bin",
                expected_exit=1,
            )
        out = capsys.readouterr()
        assert "reserved" in out.err.lower() or "PATH" in out.err

    def test_reserved_worca_prefix_rejected(self, capsys, tmp_path):
        global_path = str(tmp_path / "settings.json")
        with mock.patch("worca.utils.settings._default_global_path", return_value=global_path):
            _run(
                "models", "add", "--tier", "user",
                "foo", "claude-sonnet-4-6",
                "--env", "WORCA_CUSTOM=val",
                expected_exit=1,
            )
        out = capsys.readouterr()
        assert "reserved" in out.err.lower() or "WORCA_" in out.err


class TestModelsAddTierInference:
    """When --tier is omitted, infer project if cwd is a git project, else user."""

    def test_infers_project_when_in_git_repo(self, tmp_path):
        (tmp_path / ".git").mkdir()
        (tmp_path / ".claude").mkdir()
        settings_path = tmp_path / ".claude" / "settings.json"

        with mock.patch("os.getcwd", return_value=str(tmp_path)):
            _run("models", "add", "inferred-alias", "claude-haiku-4-5-20251001")

        data = _read_json(str(settings_path))
        assert data["worca"]["models"]["inferred-alias"] == "claude-haiku-4-5-20251001"

    def test_infers_user_when_not_in_git_repo(self, tmp_path):
        plain_dir = tmp_path / "plain"
        plain_dir.mkdir()
        global_path = str(tmp_path / "settings.json")

        with mock.patch("os.getcwd", return_value=str(plain_dir)), \
             mock.patch("worca.utils.settings._default_global_path", return_value=global_path):
            _run("models", "add", "inferred-alias", "claude-haiku-4-5-20251001")

        data = _read_json(global_path)
        assert data["worca"]["models"]["inferred-alias"] == "claude-haiku-4-5-20251001"
