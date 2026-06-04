"""Tests for file access telemetry gate in runner."""

import json
import os
import tempfile

from worca.orchestrator.runner import _is_file_access_telemetry_enabled


class TestRunnerFileAccessTelemetryGate:
    """Test that runner respects the file_access telemetry gate."""

    def test_default_enabled(self):
        """When setting is missing, should default to enabled."""
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, "settings.json")
            with open(settings_path, "w") as f:
                json.dump({"worca": {}}, f)

            assert _is_file_access_telemetry_enabled(settings_path) is True

    def test_explicitly_enabled(self):
        """When setting is explicitly true, should return true."""
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, "settings.json")
            with open(settings_path, "w") as f:
                json.dump({"worca": {"telemetry": {"file_access": {"enabled": True}}}}, f)

            assert _is_file_access_telemetry_enabled(settings_path) is True

    def test_explicitly_disabled(self):
        """When setting is explicitly false, should return false."""
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, "settings.json")
            with open(settings_path, "w") as f:
                json.dump({"worca": {"telemetry": {"file_access": {"enabled": False}}}}, f)

            assert _is_file_access_telemetry_enabled(settings_path) is False

    def test_missing_settings_file(self):
        """When settings file is missing, should default to enabled."""
        assert _is_file_access_telemetry_enabled("/nonexistent/settings.json") is True

    def test_invalid_settings_file(self):
        """When settings file is invalid, should default to enabled."""
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, "settings.json")
            with open(settings_path, "w") as f:
                f.write("invalid json")

            assert _is_file_access_telemetry_enabled(settings_path) is True

    def test_nested_disabled(self):
        """Verify deep nesting of the setting works correctly."""
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, "settings.json")
            with open(settings_path, "w") as f:
                json.dump({
                    "worca": {
                        "agents": {"planner": "opus"},
                        "telemetry": {
                            "file_access": {"enabled": False}
                        },
                        "events": {"agent_telemetry": True}
                    }
                }, f)

            # Should still extract the correct value despite other settings
            assert _is_file_access_telemetry_enabled(settings_path) is False
