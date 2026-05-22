"""Tests for graphify CLI detection (detect_graphify)."""

import subprocess
from unittest.mock import patch

from worca.utils.graphify import GraphifyDetect, detect_graphify


class TestGraphifyDetect:
    def test_missing_cli(self):
        """When graphify is not installed, installed=False and compatible=False."""
        with patch("shutil.which", return_value=None):
            result = detect_graphify()

        assert result == GraphifyDetect(
            installed=False,
            version=None,
            compatible=False,
            backend_env_present=[],
            error="graphify CLI not found on PATH",
        )

    def test_cli_present_compatible_version(self):
        """When graphify --version returns a compatible version (default range
        >=0.7.10,<1), both flags are True."""
        with (
            patch("shutil.which", return_value="/usr/local/bin/graphify"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["graphify", "--version"],
                    returncode=0,
                    stdout="graphify 0.8.0\n",
                    stderr="",
                ),
            ),
        ):
            result = detect_graphify()

        assert result.installed is True
        assert result.version == "0.8.0"
        assert result.compatible is True
        assert result.error is None

    def test_cli_present_incompatible_version_too_old(self):
        """When graphify version is below the range, compatible=False."""
        with (
            patch("shutil.which", return_value="/usr/local/bin/graphify"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["graphify", "--version"],
                    returncode=0,
                    stdout="graphify 3.9.0\n",
                    stderr="",
                ),
            ),
        ):
            result = detect_graphify(version_range=">=4,<5")

        assert result.installed is True
        assert result.version == "3.9.0"
        assert result.compatible is False
        assert result.error is not None
        assert "3.9.0" in result.error

    def test_cli_present_incompatible_version_too_new(self):
        """When graphify version is above the range, compatible=False."""
        with (
            patch("shutil.which", return_value="/usr/local/bin/graphify"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["graphify", "--version"],
                    returncode=0,
                    stdout="graphify 5.0.0\n",
                    stderr="",
                ),
            ),
        ):
            result = detect_graphify(version_range=">=4,<5")

        assert result.installed is True
        assert result.version == "5.0.0"
        assert result.compatible is False
        assert result.error is not None

    def test_cli_version_command_fails(self):
        """When graphify --version returns non-zero, installed=True but error set."""
        with (
            patch("shutil.which", return_value="/usr/local/bin/graphify"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["graphify", "--version"],
                    returncode=1,
                    stdout="",
                    stderr="error: unknown option\n",
                ),
            ),
        ):
            result = detect_graphify()

        assert result.installed is True
        assert result.version is None
        assert result.compatible is False
        assert result.error is not None

    def test_cli_version_parse_failure(self):
        """When graphify --version output is unparseable, version is None."""
        with (
            patch("shutil.which", return_value="/usr/local/bin/graphify"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["graphify", "--version"],
                    returncode=0,
                    stdout="something unexpected\n",
                    stderr="",
                ),
            ),
        ):
            result = detect_graphify()

        assert result.installed is True
        assert result.version is None
        assert result.compatible is False

    def test_cli_version_subprocess_exception(self):
        """When subprocess.run raises, installed=True but error set."""
        with (
            patch("shutil.which", return_value="/usr/local/bin/graphify"),
            patch(
                "subprocess.run",
                side_effect=OSError("permission denied"),
            ),
        ):
            result = detect_graphify()

        assert result.installed is True
        assert result.version is None
        assert result.compatible is False
        assert "permission denied" in result.error

    def test_custom_version_range(self):
        """detect_graphify respects a custom version_range parameter."""
        with (
            patch("shutil.which", return_value="/usr/local/bin/graphify"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["graphify", "--version"],
                    returncode=0,
                    stdout="graphify 4.2.1\n",
                    stderr="",
                ),
            ),
        ):
            result = detect_graphify(version_range=">=5,<6")

        assert result.installed is True
        assert result.version == "4.2.1"
        assert result.compatible is False

    def test_backend_env_detection(self):
        """detect_graphify reports which backend env vars are set."""
        env_patch = {
            "ANTHROPIC_API_KEY": "sk-ant-xxx",
            "OPENAI_API_KEY": "sk-xxx",
        }
        with (
            patch("shutil.which", return_value="/usr/local/bin/graphify"),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["graphify", "--version"],
                    returncode=0,
                    stdout="graphify 4.2.1\n",
                    stderr="",
                ),
            ),
            patch.dict("os.environ", env_patch, clear=False),
        ):
            result = detect_graphify()

        assert "ANTHROPIC_API_KEY" in result.backend_env_present
        assert "OPENAI_API_KEY" in result.backend_env_present

    def test_backend_env_empty_when_unset(self):
        """When no backend env vars are set, list is empty."""
        clear_keys = {
            "ANTHROPIC_API_KEY": "",
            "OPENAI_API_KEY": "",
            "OLLAMA_BASE_URL": "",
            "GEMINI_API_KEY": "",
        }
        with (
            patch("shutil.which", return_value=None),
            patch.dict("os.environ", {}, clear=False),
        ):
            for k in clear_keys:
                import os
                os.environ.pop(k, None)
            result = detect_graphify()

        assert result.backend_env_present == []

    def test_dataclass_is_frozen(self):
        """GraphifyDetect is frozen — fields cannot be mutated."""
        detect = GraphifyDetect(
            installed=False, version=None, compatible=False,
            backend_env_present=[], error=None,
        )
        import dataclasses
        assert dataclasses.fields(detect)  # is a dataclass
        try:
            detect.installed = True  # type: ignore[misc]
            raise AssertionError("Should have raised FrozenInstanceError")
        except dataclasses.FrozenInstanceError:
            pass
