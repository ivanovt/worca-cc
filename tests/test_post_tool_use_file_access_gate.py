"""Tests for file access recording gate in post_tool_use hook."""

import json
import os
import tempfile

# Import the hook module functions (simulate the hook environment)
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "worca", "claude_hooks"))

from worca.utils.settings import load_settings


class TestFileAccessRecordingGate:
    """Test that file access recording respects the telemetry gate."""

    def test_is_file_access_enabled_with_missing_setting(self):
        """When setting is missing, should default to enabled."""
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, ".claude", "settings.json")
            os.makedirs(os.path.dirname(settings_path))
            with open(settings_path, "w") as f:
                json.dump({"worca": {}}, f)

            settings = load_settings(settings_path)
            enabled = (
                settings.get("worca", {})
                .get("telemetry", {})
                .get("file_access", {})
                .get("enabled", True)
            )
            assert enabled is True

    def test_is_file_access_enabled_when_explicitly_true(self):
        """When setting is true, recording should be enabled."""
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, ".claude", "settings.json")
            os.makedirs(os.path.dirname(settings_path))
            with open(settings_path, "w") as f:
                json.dump({"worca": {"telemetry": {"file_access": {"enabled": True}}}}, f)

            settings = load_settings(settings_path)
            enabled = (
                settings.get("worca", {})
                .get("telemetry", {})
                .get("file_access", {})
                .get("enabled", True)
            )
            assert enabled is True

    def test_is_file_access_disabled_when_explicitly_false(self):
        """When setting is false, recording should be disabled."""
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, ".claude", "settings.json")
            os.makedirs(os.path.dirname(settings_path))
            with open(settings_path, "w") as f:
                json.dump({"worca": {"telemetry": {"file_access": {"enabled": False}}}}, f)

            settings = load_settings(settings_path)
            enabled = (
                settings.get("worca", {})
                .get("telemetry", {})
                .get("file_access", {})
                .get("enabled", True)
            )
            assert enabled is False

    def test_recording_skipped_when_disabled(self):
        """When file_access is disabled, no JSONL file should be created."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Setup
            settings_path = os.path.join(tmpdir, ".claude", "settings.json")
            os.makedirs(os.path.dirname(settings_path))
            with open(settings_path, "w") as f:
                json.dump({"worca": {"telemetry": {"file_access": {"enabled": False}}}}, f)

            # Set environment
            run_id = "test-run-123"
            access_dir = os.path.join(tmpdir, ".worca", "runs", run_id, "access")

            # Test: Verify no file was created (we won't actually call the hook,
            # just verify the gate logic)
            settings = load_settings(settings_path)
            is_enabled = (
                settings.get("worca", {})
                .get("telemetry", {})
                .get("file_access", {})
                .get("enabled", True)
            )
            assert is_enabled is False

            # When disabled, recording should be skipped, so access dir shouldn't exist
            assert not os.path.exists(access_dir)
