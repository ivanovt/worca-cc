"""Tests for worca CLI entry point (src/worca/cli/main.py)."""

import pytest
from unittest.mock import patch

from worca.cli.main import create_parser, main, _parse_version_tuple, _warn_version_mismatch


class TestCliParser:
    def test_parser_no_args_exits(self):
        """No command prints help and exits."""
        with pytest.raises(SystemExit) as exc_info:
            main([])
        assert exc_info.value.code == 1

    def test_parser_version_flag(self, capsys):
        """--version prints version and exits cleanly."""
        main(["--version"])
        captured = capsys.readouterr()
        assert "worca-cc" in captured.out

    def test_parser_init_subcommand(self):
        parser = create_parser()
        args = parser.parse_args(["init"])
        assert args.command == "init"
        assert args.upgrade is False
        assert args.force is False
        assert args.check is False
        assert args.source is None

    def test_parser_init_with_flags(self):
        parser = create_parser()
        args = parser.parse_args(["init", "--upgrade", "--source", "/tmp/worca"])
        assert args.upgrade is True
        assert args.source == "/tmp/worca"

    def test_parser_run_subcommand(self):
        parser = create_parser()
        args = parser.parse_args(["run", "--prompt", "hello world"])
        assert args.command == "run"
        assert args.prompt == "hello world"

    def test_parser_run_with_all_flags(self):
        parser = create_parser()
        args = parser.parse_args([
            "run", "--prompt", "test", "--plan", "plan.md",
            "--msize", "3", "--mloops", "2", "--resume",
        ])
        assert args.prompt == "test"
        assert args.plan == "plan.md"
        assert args.msize == 3
        assert args.mloops == 2
        assert args.resume is True

    def test_parser_pause_subcommand(self):
        parser = create_parser()
        args = parser.parse_args(["pause", "run-123"])
        assert args.command == "pause"
        assert args.run_id == "run-123"

    def test_parser_stop_subcommand(self):
        parser = create_parser()
        args = parser.parse_args(["stop"])
        assert args.command == "stop"
        assert args.run_id is None

    def test_parser_status_with_base(self):
        parser = create_parser()
        args = parser.parse_args(["status", "run-1", "--base", "/tmp/.worca"])
        assert args.command == "status"
        assert args.run_id == "run-1"
        assert args.base == "/tmp/.worca"

    def test_parser_multi_status(self):
        parser = create_parser()
        args = parser.parse_args(["multi-status"])
        assert args.command == "multi-status"


class TestParseVersionTuple:
    def test_simple_version(self):
        assert _parse_version_tuple("0.6.0") == (0, 6, 0)

    def test_with_prerelease(self):
        assert _parse_version_tuple("0.6.0rc3") == (0, 6, 0)

    def test_two_part_version(self):
        assert _parse_version_tuple("1.2") == (1, 2)

    def test_with_dev_suffix(self):
        assert _parse_version_tuple("1.0.0dev1") == (1, 0, 0)


class TestWarnVersionMismatch:
    def test_warns_when_project_older(self, tmp_path, capsys):
        """Warning printed when project version < installed version."""
        worca_dir = tmp_path / "worca"
        worca_dir.mkdir()
        (worca_dir / "__init__.py").write_text('__version__ = "0.5.0"\n')

        with patch("worca.__version__", "0.6.0"):
            _warn_version_mismatch(worca_dir)

        captured = capsys.readouterr()
        assert "warning:" in captured.err
        assert "0.5.0" in captured.err
        assert "0.6.0" in captured.err
        assert "worca init --upgrade" in captured.err

    def test_no_warning_when_versions_match(self, tmp_path, capsys):
        """No warning when versions are equal."""
        worca_dir = tmp_path / "worca"
        worca_dir.mkdir()
        (worca_dir / "__init__.py").write_text('__version__ = "0.6.0"\n')

        with patch("worca.__version__", "0.6.0"):
            _warn_version_mismatch(worca_dir)

        captured = capsys.readouterr()
        assert captured.err == ""

    def test_no_warning_when_project_newer(self, tmp_path, capsys):
        """No warning when project is newer than installed (edge case)."""
        worca_dir = tmp_path / "worca"
        worca_dir.mkdir()
        (worca_dir / "__init__.py").write_text('__version__ = "0.7.0"\n')

        with patch("worca.__version__", "0.6.0"):
            _warn_version_mismatch(worca_dir)

        captured = capsys.readouterr()
        assert captured.err == ""

    def test_silent_when_no_init_file(self, tmp_path, capsys):
        """No crash or warning when __init__.py doesn't exist."""
        worca_dir = tmp_path / "worca"
        worca_dir.mkdir()

        _warn_version_mismatch(worca_dir)

        captured = capsys.readouterr()
        assert captured.err == ""

    def test_silent_when_dir_missing(self, tmp_path, capsys):
        """No crash when the worca dir doesn't exist at all."""
        _warn_version_mismatch(tmp_path / "nonexistent")

        captured = capsys.readouterr()
        assert captured.err == ""

    def test_prerelease_ignored_in_comparison(self, tmp_path, capsys):
        """Pre-release suffixes are stripped: 0.6.0rc3 satisfies >= 0.6.0."""
        worca_dir = tmp_path / "worca"
        worca_dir.mkdir()
        (worca_dir / "__init__.py").write_text('__version__ = "0.6.0rc3"\n')

        with patch("worca.__version__", "0.6.0"):
            _warn_version_mismatch(worca_dir)

        captured = capsys.readouterr()
        # Same base version — no warning
        assert "warning:" not in captured.err
