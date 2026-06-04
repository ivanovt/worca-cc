"""Tests for file access telemetry gate in runner."""

import json
import os
import subprocess
import tempfile

from worca.orchestrator.runner import (
    _aggregate_file_access_into_extras,
    _is_file_access_telemetry_enabled,
)


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


class TestRunnerBeadScopedAggregation:
    """Regression: the IMPLEMENT reader must mirror the bead-suffixed writer filename.

    The PostToolUse hook writes ``implement-<iter>-<bead>.jsonl`` whenever
    WORCA_BEAD_ID is stamped (IMPLEMENT only). The runner's aggregation must
    pass the same bead_id, otherwise it reads the unsuffixed ``implement-<iter>.jsonl``,
    finds nothing, and silently stores all-zeros telemetry for the one stage the
    feature exists to observe.
    """

    @staticmethod
    def _make_repo_with_fragment(tmpdir, *, bead_id):
        """Init a git repo + tracked file, and write the hook's bead-suffixed JSONL."""
        repo = os.path.join(tmpdir, "repo")
        os.makedirs(os.path.join(repo, "src"))
        with open(os.path.join(repo, "src", "main.py"), "w") as f:
            f.write("code\n")
        for args in (
            ["git", "init"],
            ["git", "config", "user.email", "t@t.com"],
            ["git", "config", "user.name", "T"],
            ["git", "add", "src/main.py"],
        ):
            subprocess.run(args, cwd=repo, capture_output=True, check=True)

        access_dir = os.path.join(repo, ".worca", "runs", "run-1", "access")
        os.makedirs(access_dir)
        fragment = os.path.join(access_dir, f"implement-1-{bead_id}.jsonl")
        records = [
            {"op": "read", "tool": "Read", "path": "src/main.py", "ts": "2026-01-01T00:00:00Z"},
            {"op": "write", "tool": "Write", "path": "src/main.py", "ts": "2026-01-01T00:00:01Z"},
        ]
        with open(fragment, "w") as f:
            f.write("\n".join(json.dumps(r) for r in records))
        return repo

    def test_implement_aggregation_reads_bead_suffixed_fragment(self):
        """With bead_id passed (the fix), IMPLEMENT telemetry is populated."""
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = self._make_repo_with_fragment(tmpdir, bead_id="beads-7")
            old_cwd = os.getcwd()
            try:
                os.chdir(repo)
                iter_extras = {}
                _aggregate_file_access_into_extras(
                    iter_extras,
                    settings_path="/nonexistent/settings.json",  # defaults enabled
                    status={"run_id": "run-1"},
                    stage="implement",
                    iter_num=1,
                    bead_id="beads-7",
                )
            finally:
                os.chdir(old_cwd)

            assert "file_access" in iter_extras
            fa = iter_extras["file_access"]
            assert fa["reads"].get("src/main.py") == 1
            assert fa["totals"]["distinct_read"] == 1

    def test_implement_aggregation_misses_without_bead_id(self):
        """Guards the regression: omitting bead_id reads the wrong file → empty telemetry.

        This is the pre-fix behavior. The hook wrote a bead-suffixed fragment, so
        an unsuffixed lookup must find nothing (proving why the fix is required).
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = self._make_repo_with_fragment(tmpdir, bead_id="beads-7")
            old_cwd = os.getcwd()
            try:
                os.chdir(repo)
                iter_extras = {}
                _aggregate_file_access_into_extras(
                    iter_extras,
                    settings_path="/nonexistent/settings.json",
                    status={"run_id": "run-1"},
                    stage="implement",
                    iter_num=1,
                    bead_id=None,  # pre-fix: no bead suffix
                )
            finally:
                os.chdir(old_cwd)

            # Fragment exists but under a bead-suffixed name; unsuffixed read is empty.
            fa = iter_extras.get("file_access", {})
            assert fa.get("reads", {}) == {}
            assert fa.get("totals", {}).get("distinct_read", 0) == 0

    def test_disabled_gate_skips_aggregation(self):
        """When telemetry is disabled, the helper writes nothing into iter_extras."""
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = self._make_repo_with_fragment(tmpdir, bead_id="beads-7")
            settings_path = os.path.join(tmpdir, "settings.json")
            with open(settings_path, "w") as f:
                json.dump({"worca": {"telemetry": {"file_access": {"enabled": False}}}}, f)
            old_cwd = os.getcwd()
            try:
                os.chdir(repo)
                iter_extras = {}
                _aggregate_file_access_into_extras(
                    iter_extras,
                    settings_path=settings_path,
                    status={"run_id": "run-1"},
                    stage="implement",
                    iter_num=1,
                    bead_id="beads-7",
                )
            finally:
                os.chdir(old_cwd)

            assert "file_access" not in iter_extras
