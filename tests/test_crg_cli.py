"""Tests for worca crg CLI subcommands (status, recommend, enable, disable, rebuild)."""

import json
from unittest.mock import patch

import pytest

from worca.utils.code_review_graph import CrgDetect


@pytest.fixture
def project_dir(tmp_path):
    """Create a minimal project directory with .claude/settings.json."""
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    settings = {
        "worca": {
            "code_review_graph": {
                "enabled": False,
                "embeddings": False,
                "update_on": {
                    "preflight": True,
                    "post_implement": True,
                    "guardian_post_commit": True,
                },
                "min_repo_files": 100,
                "version_range": ">=2,<3",
                "fastmcp_min": "3.2.4",
                "preflight_timeout_seconds": 300,
                "stage_tools": None,
            }
        }
    }
    (claude_dir / "settings.json").write_text(json.dumps(settings))
    (tmp_path / ".git").mkdir()
    return tmp_path


@pytest.fixture
def global_settings(tmp_path):
    """Create a global settings file."""
    global_dir = tmp_path / "global"
    global_dir.mkdir()
    path = global_dir / "settings.json"
    path.write_text(json.dumps({"worca": {"code_review_graph": {"enabled": False}}}))
    return str(path)


class TestCrgStatus:
    def test_disabled_shows_disabled(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_status

        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_crg_status(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        assert "disabled" in out.lower()

    def test_enabled_shows_enabled_and_detection(
        self, project_dir, global_settings, capsys
    ):
        from worca.cli.crg_cmd import cmd_crg_status

        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)

        detect = CrgDetect(
            installed=True,
            version="2.2.3",
            compatible=True,
            fastmcp_ok=True,
            error=None,
        )
        with patch("worca.cli.crg_cmd.detect_code_review_graph", return_value=detect):
            cmd_crg_status(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        out = capsys.readouterr().out
        assert "enabled" in out.lower()
        assert "2.2.3" in out

    def test_enabled_but_not_installed(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_status

        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)

        detect = CrgDetect(
            installed=False,
            version=None,
            compatible=False,
            fastmcp_ok=False,
            error="code-review-graph CLI not found on PATH",
        )
        with patch("worca.cli.crg_cmd.detect_code_review_graph", return_value=detect):
            cmd_crg_status(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        out = capsys.readouterr().out
        assert "not installed" in out.lower() or "not found" in out.lower()

    def test_enabled_but_fastmcp_missing(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_status

        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)

        detect = CrgDetect(
            installed=True,
            version="2.2.3",
            compatible=True,
            fastmcp_ok=False,
            error="fastmcp not installed: not found on PATH",
        )
        with patch("worca.cli.crg_cmd.detect_code_review_graph", return_value=detect):
            cmd_crg_status(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        out = capsys.readouterr().out
        assert "fastmcp" in out.lower()

    def test_global_off_reason(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_status

        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_crg_status(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        assert "global" in out.lower()

    def test_shows_freshness(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_status

        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)

        detect = CrgDetect(
            installed=True, version="2.2.3", compatible=True,
            fastmcp_ok=True, error=None,
        )
        with patch("worca.cli.crg_cmd.detect_code_review_graph", return_value=detect):
            cmd_crg_status(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        out = capsys.readouterr().out
        assert "clean_only" in out


class TestCrgRecommend:
    def test_below_threshold_recommends_skip(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_recommend

        settings_path = str(project_dir / ".claude" / "settings.json")
        src = project_dir / "src"
        src.mkdir()
        for i in range(10):
            (src / f"file{i}.py").write_text(f"# file {i}")

        cmd_crg_recommend(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        assert "skip" in out.lower()

    def test_above_threshold_recommends_enable(
        self, project_dir, global_settings, capsys
    ):
        from worca.cli.crg_cmd import cmd_crg_recommend

        settings_path = str(project_dir / ".claude" / "settings.json")
        src = project_dir / "src"
        src.mkdir()
        for i in range(150):
            (src / f"file{i}.py").write_text(f"# file {i}")

        cmd_crg_recommend(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        assert "enable" in out.lower()


class TestCrgEnable:
    def test_enable_writes_project_setting(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_enable

        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_crg_enable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
        )
        with open(settings_path) as f:
            result = json.load(f)
        assert result["worca"]["code_review_graph"]["enabled"] is True

    def test_enable_preserves_other_settings(self, project_dir, global_settings):
        from worca.cli.crg_cmd import cmd_crg_enable

        settings_path = str(project_dir / ".claude" / "settings.json")
        existing = {
            "worca": {
                "code_review_graph": {"enabled": False},
                "fleet": {"max_parallel": 5},
            }
        }
        with open(settings_path, "w") as f:
            json.dump(existing, f)

        cmd_crg_enable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
        )
        with open(settings_path) as f:
            result = json.load(f)
        assert result["worca"]["fleet"]["max_parallel"] == 5
        assert result["worca"]["code_review_graph"]["enabled"] is True

    def test_enable_prints_confirmation(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_enable

        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_crg_enable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
        )
        out = capsys.readouterr().out
        assert "enabled" in out.lower()


class TestCrgDisable:
    def test_disable_writes_project_setting(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_disable

        settings_path = str(project_dir / ".claude" / "settings.json")
        existing = {"worca": {"code_review_graph": {"enabled": True}}}
        with open(settings_path, "w") as f:
            json.dump(existing, f)

        cmd_crg_disable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
        )
        with open(settings_path) as f:
            result = json.load(f)
        assert result["worca"]["code_review_graph"]["enabled"] is False

    def test_disable_already_disabled(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_disable

        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_crg_disable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
        )
        out = capsys.readouterr().out
        assert "disabled" in out.lower()


class TestCrgRebuild:
    def test_rebuild_disabled_errors(self, project_dir, global_settings):
        from worca.cli.crg_cmd import cmd_crg_rebuild

        settings_path = str(project_dir / ".claude" / "settings.json")
        with pytest.raises(SystemExit):
            cmd_crg_rebuild(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )

    def test_rebuild_not_installed_errors(self, project_dir, global_settings):
        from worca.cli.crg_cmd import cmd_crg_rebuild

        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)

        detect = CrgDetect(
            installed=False, version=None, compatible=False,
            fastmcp_ok=False, error="code-review-graph CLI not found on PATH",
        )
        with patch("worca.cli.crg_cmd.detect_code_review_graph", return_value=detect):
            with pytest.raises(SystemExit):
                cmd_crg_rebuild(
                    project_settings_path=settings_path,
                    global_settings_path=global_settings,
                    project_root=str(project_dir),
                )

    def test_rebuild_fastmcp_missing_errors(self, project_dir, global_settings):
        from worca.cli.crg_cmd import cmd_crg_rebuild

        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)

        detect = CrgDetect(
            installed=True, version="2.2.3", compatible=True,
            fastmcp_ok=False, error="fastmcp not installed",
        )
        with patch("worca.cli.crg_cmd.detect_code_review_graph", return_value=detect):
            with pytest.raises(SystemExit):
                cmd_crg_rebuild(
                    project_settings_path=settings_path,
                    global_settings_path=global_settings,
                    project_root=str(project_dir),
                )

    def test_rebuild_ready_prints_placeholder(self, project_dir, global_settings, capsys):
        from worca.cli.crg_cmd import cmd_crg_rebuild

        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"code_review_graph": {"enabled": True}}}, f)

        detect = CrgDetect(
            installed=True, version="2.2.3", compatible=True,
            fastmcp_ok=True, error=None,
        )
        with patch("worca.cli.crg_cmd.detect_code_review_graph", return_value=detect):
            cmd_crg_rebuild(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        out = capsys.readouterr().out
        assert "rebuild" in out.lower() or "preflight" in out.lower()


class TestCrgCLIRegistration:
    def test_crg_subcommand_registered(self):
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["crg", "status"])
        assert args.command == "crg"
        assert args.crg_command == "status"

    def test_crg_recommend_subcommand(self):
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["crg", "recommend"])
        assert args.crg_command == "recommend"

    def test_crg_enable_subcommand(self):
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["crg", "enable"])
        assert args.crg_command == "enable"

    def test_crg_disable_subcommand(self):
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["crg", "disable"])
        assert args.crg_command == "disable"

    def test_crg_rebuild_subcommand(self):
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["crg", "rebuild"])
        assert args.crg_command == "rebuild"
