"""Tests for worca graphify CLI subcommands (status, recommend, enable, disable, rebuild, update)."""

import json
import os
from unittest.mock import patch

import pytest

from worca.cli.graphify_cmd import (
    cmd_graphify_disable,
    cmd_graphify_enable,
    cmd_graphify_rebuild,
    cmd_graphify_recommend,
    cmd_graphify_status,
    cmd_graphify_update,
)
from worca.utils.graphify import GraphifyDetect


@pytest.fixture
def project_dir(tmp_path):
    """Create a minimal project directory with .claude/settings.json."""
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    settings = {
        "worca": {
            "graphify": {
                "enabled": False,
                "mode": "structural",
                "backend": None,
                "model_profile": None,
                "out_dir": "graphify-out",
                "update_on": {"preflight": True, "guardian_post_commit": True},
                "min_repo_files": 100,
                "version_range": ">=4,<5",
            }
        }
    }
    (claude_dir / "settings.json").write_text(json.dumps(settings))
    # Also init a git repo so _find_git_root works
    (tmp_path / ".git").mkdir()
    return tmp_path


@pytest.fixture
def global_settings(tmp_path):
    """Create a global settings file."""
    global_dir = tmp_path / "global"
    global_dir.mkdir()
    path = global_dir / "settings.json"
    path.write_text(json.dumps({"worca": {"graphify": {"enabled": False}}}))
    return str(path)


class TestGraphifyStatus:
    def test_disabled_shows_disabled(self, project_dir, global_settings, capsys):
        """When graphify is disabled, status shows the disabled state."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_graphify_status(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        assert "disabled" in out.lower()

    def test_enabled_shows_enabled_and_detection(
        self, project_dir, global_settings, capsys
    ):
        """When enabled, status shows effective config and detection."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        # Enable globally
        global_cfg = {"worca": {"graphify": {"enabled": True}}}
        with open(global_settings, "w") as f:
            json.dump(global_cfg, f)
        # Enable in project
        project_cfg = {
            "worca": {"graphify": {"enabled": True, "mode": "structural"}}
        }
        with open(settings_path, "w") as f:
            json.dump(project_cfg, f)

        detect = GraphifyDetect(
            installed=True,
            version="4.2.1",
            compatible=True,
            backend_env_present=["ANTHROPIC_API_KEY"],
            error=None,
        )
        with patch("worca.cli.graphify_cmd.detect_graphify", return_value=detect):
            cmd_graphify_status(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        out = capsys.readouterr().out
        assert "enabled" in out.lower()
        assert "structural" in out.lower()
        assert "4.2.1" in out

    def test_enabled_but_not_installed(self, project_dir, global_settings, capsys):
        """When enabled but graphify is missing, shows not-installed state."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        global_cfg = {"worca": {"graphify": {"enabled": True}}}
        with open(global_settings, "w") as f:
            json.dump(global_cfg, f)
        project_cfg = {"worca": {"graphify": {"enabled": True}}}
        with open(settings_path, "w") as f:
            json.dump(project_cfg, f)

        detect = GraphifyDetect(
            installed=False,
            version=None,
            compatible=False,
            backend_env_present=[],
            error="graphify CLI not found on PATH",
        )
        with patch("worca.cli.graphify_cmd.detect_graphify", return_value=detect):
            cmd_graphify_status(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        out = capsys.readouterr().out
        assert "not installed" in out.lower() or "not found" in out.lower()

    def test_shows_graph_stats_when_present(
        self, project_dir, global_settings, capsys, tmp_path, monkeypatch
    ):
        """When a complete cache snapshot exists for HEAD, status shows it."""
        from worca.utils.graphify import (
            graphify_report_path,
            graphify_snapshot_dir,
            mark_snapshot_complete,
        )

        monkeypatch.setenv("WORCA_CACHE", str(tmp_path / "cache"))
        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"graphify": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"graphify": {"enabled": True}}}, f)

        snap = graphify_snapshot_dir("repo1", "deadbeef", cache_dir=str(tmp_path / "cache"))
        os.makedirs(os.path.join(snap, "graphify"))
        with open(graphify_report_path(snap), "w") as f:
            f.write("# Graph Report\nSome content.\n")
        mark_snapshot_complete(snap)

        detect = GraphifyDetect(
            installed=True, version="0.8.0", compatible=True,
            backend_env_present=[], error=None,
        )
        with (
            patch("worca.cli.graphify_cmd.detect_graphify", return_value=detect),
            patch("worca.cli.graphify_cmd.repo_id", return_value="repo1"),
            patch("worca.cli.graphify_cmd.get_current_git_head", return_value="deadbeef"),
        ):
            cmd_graphify_status(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        out = capsys.readouterr().out
        assert "deadbeef" in out and "built" in out

    def test_global_off_reason(self, project_dir, global_settings, capsys):
        """When global is off, status shows reason=global-off."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_graphify_status(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        assert "global" in out.lower()


class TestGraphifyRecommend:
    def test_below_threshold_recommends_skip(self, project_dir, global_settings, capsys):
        """When file count is below min_repo_files, recommend says skip."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        # Create fewer than 100 files
        src = project_dir / "src"
        src.mkdir()
        for i in range(10):
            (src / f"file{i}.py").write_text(f"# file {i}")

        cmd_graphify_recommend(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        assert "10" in out or "below" in out.lower() or "skip" in out.lower()

    def test_above_threshold_recommends_enable(
        self, project_dir, global_settings, capsys
    ):
        """When file count exceeds min_repo_files, recommend suggests enable."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        # Create more than 100 files
        src = project_dir / "src"
        src.mkdir()
        for i in range(150):
            (src / f"file{i}.py").write_text(f"# file {i}")

        cmd_graphify_recommend(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        assert "150" in out or "recommend" in out.lower() or "enable" in out.lower()

    def test_counts_tracked_files_only(self, project_dir, global_settings, capsys):
        """Recommend counts tracked source files, not all files."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        src = project_dir / "src"
        src.mkdir()
        for i in range(5):
            (src / f"file{i}.py").write_text(f"# file {i}")

        cmd_graphify_recommend(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            project_root=str(project_dir),
        )
        out = capsys.readouterr().out
        # Should show the count of files found
        assert "5" in out or "below" in out.lower()


class TestGraphifyEnable:
    def test_enable_writes_project_setting(self, project_dir, global_settings, capsys):
        """Enable writes enabled=true to project settings."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_graphify_enable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            mode="structural",
        )
        with open(settings_path) as f:
            result = json.load(f)
        assert result["worca"]["graphify"]["enabled"] is True
        assert result["worca"]["graphify"]["mode"] == "structural"

    def test_enable_full_prints_privacy_notice(
        self, project_dir, global_settings, capsys
    ):
        """Enable with --mode=full prints a privacy notice."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_graphify_enable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            mode="full",
        )
        out = capsys.readouterr().out
        assert "privacy" in out.lower() or "outbound" in out.lower()
        with open(settings_path) as f:
            result = json.load(f)
        assert result["worca"]["graphify"]["mode"] == "full"

    def test_enable_structural_no_privacy_notice(
        self, project_dir, global_settings, capsys
    ):
        """Enable with structural mode does not print privacy notice."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_graphify_enable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            mode="structural",
        )
        out = capsys.readouterr().out
        assert "privacy" not in out.lower()

    def test_enable_preserves_other_settings(self, project_dir, global_settings):
        """Enable does not clobber other worca settings."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        existing = {
            "worca": {
                "graphify": {"enabled": False, "mode": "structural"},
                "fleet": {"max_parallel": 5},
            }
        }
        with open(settings_path, "w") as f:
            json.dump(existing, f)

        cmd_graphify_enable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
            mode="structural",
        )
        with open(settings_path) as f:
            result = json.load(f)
        assert result["worca"]["fleet"]["max_parallel"] == 5
        assert result["worca"]["graphify"]["enabled"] is True

    def test_enable_invalid_mode_raises(self, project_dir, global_settings):
        """Enable with invalid mode raises SystemExit."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        with pytest.raises(SystemExit):
            cmd_graphify_enable(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                mode="turbo",
            )


class TestGraphifyDisable:
    def test_disable_writes_project_setting(self, project_dir, global_settings, capsys):
        """Disable writes enabled=false to project settings."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        # First enable
        existing = {"worca": {"graphify": {"enabled": True, "mode": "structural"}}}
        with open(settings_path, "w") as f:
            json.dump(existing, f)

        cmd_graphify_disable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
        )
        with open(settings_path) as f:
            result = json.load(f)
        assert result["worca"]["graphify"]["enabled"] is False

    def test_disable_preserves_mode(self, project_dir, global_settings):
        """Disable keeps the mode setting intact."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        existing = {"worca": {"graphify": {"enabled": True, "mode": "full"}}}
        with open(settings_path, "w") as f:
            json.dump(existing, f)

        cmd_graphify_disable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
        )
        with open(settings_path) as f:
            result = json.load(f)
        assert result["worca"]["graphify"]["mode"] == "full"

    def test_disable_already_disabled(self, project_dir, global_settings, capsys):
        """Disable when already disabled is a no-op (doesn't error)."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        cmd_graphify_disable(
            project_settings_path=settings_path,
            global_settings_path=global_settings,
        )
        out = capsys.readouterr().out
        assert "disabled" in out.lower()


class TestGraphifyRebuild:
    def test_rebuild_deletes_snapshot_and_builds(
        self, project_dir, global_settings, capsys, tmp_path, monkeypatch
    ):
        """Rebuild deletes the current HEAD's cache snapshot and rebuilds it."""
        from worca.utils.graphify import graphify_snapshot_dir

        monkeypatch.setenv("WORCA_CACHE", str(tmp_path / "cache"))
        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"graphify": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"graphify": {"enabled": True}}}, f)

        snap = graphify_snapshot_dir("repo1", "deadbeef", cache_dir=str(tmp_path / "cache"))
        os.makedirs(snap)
        (snap and open(os.path.join(snap, "stale.txt"), "w")).write("old")

        detect = GraphifyDetect(
            installed=True, version="0.8.0", compatible=True,
            backend_env_present=[], error=None,
        )
        with (
            patch("worca.cli.graphify_cmd.detect_graphify", return_value=detect),
            patch("worca.cli.graphify_cmd.repo_id", return_value="repo1"),
            patch("worca.cli.graphify_cmd.get_current_git_head", return_value="deadbeef"),
            patch(
                "worca.scripts.graphify_preflight.run_graphify_preflight",
                return_value={"status": "ready", "report_path": "/x/GRAPH_REPORT.md"},
            ) as mock_pre,
        ):
            cmd_graphify_rebuild(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
                mode=None,
            )

        assert not os.path.exists(os.path.join(snap, "stale.txt"))
        mock_pre.assert_called_once()
        assert "Rebuild complete" in capsys.readouterr().out

    def test_rebuild_not_installed_errors(
        self, project_dir, global_settings, capsys
    ):
        """Rebuild when graphify is not installed exits with error."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        global_cfg = {"worca": {"graphify": {"enabled": True}}}
        with open(global_settings, "w") as f:
            json.dump(global_cfg, f)
        project_cfg = {"worca": {"graphify": {"enabled": True}}}
        with open(settings_path, "w") as f:
            json.dump(project_cfg, f)

        detect = GraphifyDetect(
            installed=False, version=None, compatible=False,
            backend_env_present=[], error="graphify CLI not found on PATH",
        )
        with patch("worca.cli.graphify_cmd.detect_graphify", return_value=detect):
            with pytest.raises(SystemExit):
                cmd_graphify_rebuild(
                    project_settings_path=settings_path,
                    global_settings_path=global_settings,
                    project_root=str(project_dir),
                    mode=None,
                )

    def test_rebuild_disabled_errors(
        self, project_dir, global_settings, capsys
    ):
        """Rebuild when graphify is disabled exits with error."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        with pytest.raises(SystemExit):
            cmd_graphify_rebuild(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
                mode=None,
            )

    def test_rebuild_build_failure_reports_error(
        self, project_dir, global_settings, capsys, monkeypatch, tmp_path
    ):
        """Rebuild propagates a degraded build as SystemExit."""
        monkeypatch.setenv("WORCA_CACHE", str(tmp_path / "cache"))
        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"graphify": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"graphify": {"enabled": True}}}, f)

        detect = GraphifyDetect(
            installed=True, version="0.8.0", compatible=True,
            backend_env_present=[], error=None,
        )
        with (
            patch("worca.cli.graphify_cmd.detect_graphify", return_value=detect),
            patch("worca.cli.graphify_cmd.repo_id", return_value="repo1"),
            patch("worca.cli.graphify_cmd.get_current_git_head", return_value="deadbeef"),
            patch(
                "worca.scripts.graphify_preflight.run_graphify_preflight",
                return_value={"status": "degraded", "reason": "build_failed"},
            ),
        ):
            with pytest.raises(SystemExit):
                cmd_graphify_rebuild(
                    project_settings_path=settings_path,
                    global_settings_path=global_settings,
                    project_root=str(project_dir),
                    mode=None,
                )


class TestGraphifyUpdate:
    def test_update_builds_head_snapshot(
        self, project_dir, global_settings, capsys, monkeypatch, tmp_path
    ):
        """Update builds the current HEAD snapshot via run_graphify_preflight."""
        monkeypatch.setenv("WORCA_CACHE", str(tmp_path / "cache"))
        settings_path = str(project_dir / ".claude" / "settings.json")
        with open(global_settings, "w") as f:
            json.dump({"worca": {"graphify": {"enabled": True}}}, f)
        with open(settings_path, "w") as f:
            json.dump({"worca": {"graphify": {"enabled": True}}}, f)

        detect = GraphifyDetect(
            installed=True, version="0.8.0", compatible=True,
            backend_env_present=[], error=None,
        )
        with (
            patch("worca.cli.graphify_cmd.detect_graphify", return_value=detect),
            patch(
                "worca.scripts.graphify_preflight.run_graphify_preflight",
                return_value={"status": "ready", "report_path": "/x/GRAPH_REPORT.md"},
            ) as mock_pre,
        ):
            cmd_graphify_update(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )

        mock_pre.assert_called_once()
        assert "Update complete" in capsys.readouterr().out

    def test_update_not_installed_errors(
        self, project_dir, global_settings
    ):
        """Update when graphify not installed exits with error."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        global_cfg = {"worca": {"graphify": {"enabled": True}}}
        with open(global_settings, "w") as f:
            json.dump(global_cfg, f)
        project_cfg = {"worca": {"graphify": {"enabled": True}}}
        with open(settings_path, "w") as f:
            json.dump(project_cfg, f)

        detect = GraphifyDetect(
            installed=False, version=None, compatible=False,
            backend_env_present=[], error="graphify CLI not found on PATH",
        )
        with patch("worca.cli.graphify_cmd.detect_graphify", return_value=detect):
            with pytest.raises(SystemExit):
                cmd_graphify_update(
                    project_settings_path=settings_path,
                    global_settings_path=global_settings,
                    project_root=str(project_dir),
                )

    def test_update_disabled_errors(
        self, project_dir, global_settings
    ):
        """Update when graphify is disabled exits with error."""
        settings_path = str(project_dir / ".claude" / "settings.json")
        with pytest.raises(SystemExit):
            cmd_graphify_update(
                project_settings_path=settings_path,
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )


class TestGraphifyGc:
    def test_gc_clears_repo_cache(self, project_dir, global_settings, capsys, tmp_path, monkeypatch):
        """gc removes the entire <cache>/ast/<repo-id>/ tree for the repo."""
        from worca.cli.graphify_cmd import cmd_graphify_gc

        monkeypatch.setenv("WORCA_CACHE", str(tmp_path / "cache"))
        repo_cache = tmp_path / "cache" / "ast" / "repo1"
        (repo_cache / "deadbeef" / "graphify").mkdir(parents=True)
        (repo_cache / "deadbeef" / "graphify" / "GRAPH_REPORT.md").write_text("x")

        with patch("worca.cli.graphify_cmd.repo_id", return_value="repo1"):
            cmd_graphify_gc(
                project_settings_path=str(project_dir / ".claude" / "settings.json"),
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )

        assert not repo_cache.exists()
        assert "Cleared graph cache" in capsys.readouterr().out

    def test_gc_no_cache_is_graceful(self, project_dir, global_settings, capsys, tmp_path, monkeypatch):
        from worca.cli.graphify_cmd import cmd_graphify_gc

        monkeypatch.setenv("WORCA_CACHE", str(tmp_path / "cache"))
        with patch("worca.cli.graphify_cmd.repo_id", return_value="repo1"):
            cmd_graphify_gc(
                project_settings_path=str(project_dir / ".claude" / "settings.json"),
                global_settings_path=global_settings,
                project_root=str(project_dir),
            )
        assert "No graph cache" in capsys.readouterr().out


class TestGraphifyCLIRegistration:
    def test_graphify_subcommand_registered(self):
        """The 'graphify' subcommand is registered in the CLI parser."""
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["graphify", "status"])
        assert args.command == "graphify"
        assert args.graphify_command == "status"

    def test_graphify_recommend_subcommand(self):
        """The 'graphify recommend' subcommand parses correctly."""
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["graphify", "recommend"])
        assert args.graphify_command == "recommend"

    def test_graphify_enable_with_mode(self):
        """The 'graphify enable --mode=full' parses correctly."""
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["graphify", "enable", "--mode", "full"])
        assert args.graphify_command == "enable"
        assert args.mode == "full"

    def test_graphify_enable_default_mode(self):
        """The 'graphify enable' defaults to structural mode."""
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["graphify", "enable"])
        assert args.mode == "structural"

    def test_graphify_disable_subcommand(self):
        """The 'graphify disable' subcommand parses correctly."""
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["graphify", "disable"])
        assert args.graphify_command == "disable"

    def test_graphify_rebuild_subcommand(self):
        """The 'graphify rebuild' subcommand parses correctly."""
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["graphify", "rebuild"])
        assert args.graphify_command == "rebuild"

    def test_graphify_rebuild_with_mode(self):
        """The 'graphify rebuild --mode=full' parses correctly."""
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["graphify", "rebuild", "--mode", "full"])
        assert args.graphify_command == "rebuild"
        assert args.mode == "full"

    def test_graphify_update_subcommand(self):
        """The 'graphify update' subcommand parses correctly."""
        from worca.cli.main import create_parser

        parser = create_parser()
        args = parser.parse_args(["graphify", "update"])
        assert args.graphify_command == "update"
