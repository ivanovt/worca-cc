"""Verify _setup_repo helpers pass WORCA_SKIP_BEADS=1 to worca init subprocess."""

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest


def _fake_worca_init(path):
    """Create the .claude/settings.json that worca init would produce."""
    settings_dir = Path(path) / ".claude"
    settings_dir.mkdir(parents=True, exist_ok=True)
    (settings_dir / "settings.json").write_text(json.dumps({"worca": {}}))


def _make_tracking_run(calls, repo_path):
    original_run = subprocess.run

    def tracking_run(cmd, **kwargs):
        if isinstance(cmd, list) and "worca.cli.main" in cmd:
            calls.append(kwargs)
            _fake_worca_init(kwargs.get("cwd", repo_path))
            return subprocess.CompletedProcess(cmd, 0)
        return original_run(cmd, **kwargs)

    return tracking_run


@pytest.fixture
def git_repo(tmp_path):
    subprocess.run(["git", "init"], cwd=str(tmp_path), check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "t@t.com"],
        cwd=str(tmp_path), check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "T"],
        cwd=str(tmp_path), check=True, capture_output=True,
    )
    return tmp_path


def _assert_skip_beads_in_env(calls):
    assert len(calls) == 1, "Expected exactly one worca init call"
    env = calls[0].get("env", {})
    assert env.get("WORCA_SKIP_BEADS") == "1", (
        "worca init subprocess must pass WORCA_SKIP_BEADS=1 in env"
    )


class TestFleetLifecycleSetupRepo:
    def test_worca_init_passes_skip_beads(self, git_repo):
        from tests.integration.test_fleet_lifecycle_e2e import _setup_repo

        calls = []
        with patch("subprocess.run", side_effect=_make_tracking_run(calls, git_repo)):
            _setup_repo(git_repo)
        _assert_skip_beads_in_env(calls)


class TestFleetE2eSetupRepo:
    def test_worca_init_passes_skip_beads(self, git_repo):
        from tests.integration.test_fleet_e2e import _setup_repo

        calls = []
        with patch("subprocess.run", side_effect=_make_tracking_run(calls, git_repo)):
            _setup_repo(git_repo)
        _assert_skip_beads_in_env(calls)


class TestWorkspaceE2eSetupRepo:
    def test_worca_init_passes_skip_beads(self, git_repo):
        from tests.integration.test_workspace_e2e import _setup_workspace_repo

        calls = []
        with patch("subprocess.run", side_effect=_make_tracking_run(calls, git_repo)):
            _setup_workspace_repo(git_repo)
        _assert_skip_beads_in_env(calls)


class TestWorkspaceFullstackSetupRepo:
    def test_worca_init_passes_skip_beads(self, git_repo):
        from tests.integration.test_workspace_fullstack import _setup_workspace_repo

        calls = []
        with patch("subprocess.run", side_effect=_make_tracking_run(calls, git_repo)):
            _setup_workspace_repo(git_repo)
        _assert_skip_beads_in_env(calls)
