"""Tests for shared CLI tool detection (tool_detect.py)."""

import subprocess
from unittest.mock import patch

import pytest

from worca.utils.tool_detect import ToolProbe, check_version_range, probe_cli


class TestCheckVersionRange:
    def test_in_range(self):
        assert check_version_range("0.8.16", ">=0.8.16,<1") is True

    def test_below_range(self):
        assert check_version_range("0.8.15", ">=0.8.16,<1") is False

    def test_above_range(self):
        assert check_version_range("1.0.0", ">=0.8.16,<1") is False

    def test_exact_match(self):
        assert check_version_range("2.0.0", "==2.0.0") is True

    def test_not_equal(self):
        assert check_version_range("2.0.0", "!=2.0.0") is False
        assert check_version_range("2.0.1", "!=2.0.0") is True

    def test_gt(self):
        assert check_version_range("3.0.0", ">2") is True
        assert check_version_range("2.0.0", ">2") is False

    def test_lte(self):
        assert check_version_range("2.0.0", "<=2") is True
        assert check_version_range("2.0.1", "<=2") is False

    def test_empty_spec(self):
        assert check_version_range("1.0.0", "") is True

    def test_invalid_spec(self):
        assert check_version_range("1.0.0", "~1.0") is False

    def test_four_part_version(self):
        assert check_version_range("2.2.3.1", ">=2,<3") is True
        assert check_version_range("1.9.9.9", ">=2,<3") is False


class TestProbeCli:
    def test_missing_binary(self):
        with patch("shutil.which", return_value=None):
            result = probe_cli("fakecli", version_range=">=1,<2")
        assert result == ToolProbe(
            installed=False,
            version=None,
            compatible=False,
            error="fakecli not found on PATH",
        )

    def test_compatible_version(self):
        with (
            patch("shutil.which", return_value="/usr/bin/fakecli"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["fakecli", "--version"],
                    returncode=0,
                    stdout="fakecli 2.1.0\n",
                    stderr="",
                ),
            ),
        ):
            result = probe_cli("fakecli", version_range=">=2,<3")
        assert result.installed is True
        assert result.version == "2.1.0"
        assert result.compatible is True
        assert result.error is None

    def test_incompatible_version(self):
        with (
            patch("shutil.which", return_value="/usr/bin/fakecli"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["fakecli", "--version"],
                    returncode=0,
                    stdout="fakecli 1.5.0\n",
                    stderr="",
                ),
            ),
        ):
            result = probe_cli("fakecli", version_range=">=2,<3")
        assert result.installed is True
        assert result.version == "1.5.0"
        assert result.compatible is False
        assert "1.5.0" in result.error

    def test_version_command_fails(self):
        with (
            patch("shutil.which", return_value="/usr/bin/fakecli"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["fakecli", "--version"],
                    returncode=1,
                    stdout="",
                    stderr="unknown option\n",
                ),
            ),
        ):
            result = probe_cli("fakecli", version_range=">=1,<2")
        assert result.installed is True
        assert result.version is None
        assert result.compatible is False
        assert result.error is not None

    def test_unparseable_version(self):
        with (
            patch("shutil.which", return_value="/usr/bin/fakecli"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["fakecli", "--version"],
                    returncode=0,
                    stdout="no version here\n",
                    stderr="",
                ),
            ),
        ):
            result = probe_cli("fakecli", version_range=">=1,<2")
        assert result.installed is True
        assert result.version is None
        assert result.compatible is False

    def test_subprocess_exception(self):
        with (
            patch("shutil.which", return_value="/usr/bin/fakecli"),
            patch("subprocess.run", side_effect=OSError("permission denied")),
        ):
            result = probe_cli("fakecli", version_range=">=1,<2")
        assert result.installed is True
        assert result.version is None
        assert result.compatible is False
        assert "permission denied" in result.error

    def test_custom_version_flag(self):
        with (
            patch("shutil.which", return_value="/usr/bin/fakecli"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["fakecli", "version"],
                    returncode=0,
                    stdout="v3.0.0\n",
                    stderr="",
                ),
            ) as mock_run,
        ):
            result = probe_cli(
                "fakecli", version_flag="version", version_range=">=3,<4"
            )
        mock_run.assert_called_once_with(
            ["fakecli", "version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.version == "3.0.0"
        assert result.compatible is True

    def test_dataclass_is_frozen(self):
        probe = ToolProbe(installed=True, version="1.0.0", compatible=True, error=None)
        with pytest.raises(AttributeError):
            probe.installed = False  # type: ignore[misc]
