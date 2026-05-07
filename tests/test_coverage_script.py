"""Tests for scripts/coverage.py — _run_pytest wrapping and --include-unit-tests flag."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Import the standalone script (not a package module)
# ---------------------------------------------------------------------------

_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "coverage.py"


def _load_coverage_script():
    spec = importlib.util.spec_from_file_location("coverage_script", _SCRIPT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def cov():
    return _load_coverage_script()


# ---------------------------------------------------------------------------
# _run_pytest — command construction
# ---------------------------------------------------------------------------


class TestRunPytestCommand:
    def test_no_wrap_builds_plain_pytest(self, cov):
        captured = []

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            return MagicMock(returncode=0)

        with patch("subprocess.run", side_effect=fake_run):
            cov._run_pytest("tests/integration/", "120", wrap_coverage=False)

        assert len(captured) == 1
        cmd = captured[0]
        assert cmd[1] == "-m"
        assert cmd[2] == "pytest"
        assert "coverage" not in cmd

    def test_no_wrap_is_default(self, cov):
        captured = []

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            return MagicMock(returncode=0)

        with patch("subprocess.run", side_effect=fake_run):
            cov._run_pytest("tests/integration/", "120")

        cmd = captured[0]
        assert cmd[2] == "pytest"
        assert "coverage" not in cmd

    def test_wrap_true_builds_coverage_run_command(self, cov):
        captured = []

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            return MagicMock(returncode=0)

        with patch("subprocess.run", side_effect=fake_run):
            cov._run_pytest("tests/", "120", wrap_coverage=True)

        assert len(captured) == 1
        cmd = captured[0]
        # Must invoke coverage run, not pytest directly
        assert cmd[1] == "-m"
        assert cmd[2] == "coverage"
        assert "run" in cmd
        assert "--parallel-mode" in cmd
        assert "-m" in cmd[cmd.index("--parallel-mode") + 1 :]
        # pytest must appear after the -m flag
        m_idx = cmd.index("--parallel-mode")
        rest = cmd[m_idx + 1 :]
        assert "-m" in rest
        assert rest[rest.index("-m") + 1] == "pytest"

    def test_wrap_true_includes_target(self, cov):
        captured = []

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            return MagicMock(returncode=0)

        with patch("subprocess.run", side_effect=fake_run):
            cov._run_pytest("tests/", "120", wrap_coverage=True)

        cmd = captured[0]
        assert "tests/" in cmd

    def test_wrap_true_includes_rcfile(self, cov):
        captured = []

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            return MagicMock(returncode=0)

        with patch("subprocess.run", side_effect=fake_run):
            cov._run_pytest("tests/", "120", wrap_coverage=True)

        cmd = captured[0]
        assert any("--rcfile=" in arg for arg in cmd)

    def test_wrap_false_includes_target_and_timeout(self, cov):
        captured = []

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            return MagicMock(returncode=0)

        with patch("subprocess.run", side_effect=fake_run):
            cov._run_pytest("tests/integration/", "999", wrap_coverage=False)

        cmd = captured[0]
        assert "tests/integration/" in cmd
        assert "--timeout=999" in cmd

    def test_extra_args_forwarded_with_wrap_false(self, cov):
        captured = []

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            return MagicMock(returncode=0)

        with patch("subprocess.run", side_effect=fake_run):
            cov._run_pytest("tests/", "60", extra=["-x", "-v"], wrap_coverage=False)

        cmd = captured[0]
        assert "-x" in cmd
        assert "-v" in cmd

    def test_extra_args_forwarded_with_wrap_true(self, cov):
        captured = []

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            return MagicMock(returncode=0)

        with patch("subprocess.run", side_effect=fake_run):
            cov._run_pytest("tests/", "60", extra=["-x"], wrap_coverage=True)

        cmd = captured[0]
        assert "-x" in cmd


# ---------------------------------------------------------------------------
# cmd_ci — --include-unit-tests flag
# ---------------------------------------------------------------------------


class TestCmdCiIncludeUnitTests:
    def _make_ci_args(self, cov, include_unit_tests=False, target="tests/integration/"):
        """Build a Namespace that matches what argparse would produce for cmd_ci."""
        import argparse

        return argparse.Namespace(
            target=target,
            timeout="180",
            out_dir="/tmp/cov-out",
            include=None,
            extra=None,
            include_unit_tests=include_unit_tests,
        )

    def test_default_ci_uses_integration_target_no_wrap(self, cov):
        """cmd_ci without --include-unit-tests must call _run_pytest with wrap_coverage=False."""
        calls = []

        def fake_run_pytest(target, timeout, extra=None, wrap_coverage=False):
            calls.append({"target": target, "wrap": wrap_coverage})
            return 0

        args = self._make_ci_args(cov, include_unit_tests=False)
        with patch.object(cov, "_run_pytest", side_effect=fake_run_pytest), \
             patch.object(cov, "_combine", return_value=0), \
             patch.object(cov, "_report_json", return_value=0), \
             patch.object(cov, "_report_xml", return_value=0), \
             patch.object(cov, "_report_text", return_value=0), \
             patch("os.makedirs"):
            cov.cmd_ci(args)

        assert len(calls) == 1
        assert calls[0]["wrap"] is False
        assert calls[0]["target"] == "tests/integration/"

    def test_include_unit_tests_sets_tests_root_target(self, cov):
        """--include-unit-tests must switch target to tests/."""
        calls = []

        def fake_run_pytest(target, timeout, extra=None, wrap_coverage=False):
            calls.append({"target": target, "wrap": wrap_coverage})
            return 0

        args = self._make_ci_args(cov, include_unit_tests=True)
        with patch.object(cov, "_run_pytest", side_effect=fake_run_pytest), \
             patch.object(cov, "_combine", return_value=0), \
             patch.object(cov, "_report_json", return_value=0), \
             patch.object(cov, "_report_xml", return_value=0), \
             patch.object(cov, "_report_text", return_value=0), \
             patch("os.makedirs"):
            cov.cmd_ci(args)

        assert len(calls) == 1
        assert calls[0]["target"] == "tests/"

    def test_include_unit_tests_enables_wrap(self, cov):
        """--include-unit-tests must set wrap_coverage=True."""
        calls = []

        def fake_run_pytest(target, timeout, extra=None, wrap_coverage=False):
            calls.append({"target": target, "wrap": wrap_coverage})
            return 0

        args = self._make_ci_args(cov, include_unit_tests=True)
        with patch.object(cov, "_run_pytest", side_effect=fake_run_pytest), \
             patch.object(cov, "_combine", return_value=0), \
             patch.object(cov, "_report_json", return_value=0), \
             patch.object(cov, "_report_xml", return_value=0), \
             patch.object(cov, "_report_text", return_value=0), \
             patch("os.makedirs"):
            cov.cmd_ci(args)

        assert calls[0]["wrap"] is True

    def test_parser_accepts_include_unit_tests_flag(self, cov):
        """The argparse parser must accept --include-unit-tests for the ci subcommand."""
        parser = cov._build_parser()
        args = parser.parse_args(["ci", "--include-unit-tests"])
        assert args.include_unit_tests is True

    def test_parser_default_include_unit_tests_is_false(self, cov):
        parser = cov._build_parser()
        args = parser.parse_args(["ci"])
        assert args.include_unit_tests is False
