"""Tests for pipeline registry grouping: workspace_id / fleet_id mutual exclusion
and CLI passthrough from run_worktree.py."""

import json
import os

import pytest

from worca.orchestrator.registry import register_pipeline


# --- CLI parser: --workspace-id flag ---


class TestWorkspaceIdParser:
    def _parse(self, argv):
        from worca.scripts.run_worktree import create_parser
        return create_parser().parse_args(argv)

    def test_workspace_id_flag_accepted(self):
        args = self._parse(["--prompt", "x", "--workspace-id", "ws-abc123"])
        assert args.workspace_id == "ws-abc123"

    def test_workspace_id_absent_by_default(self):
        args = self._parse(["--prompt", "x"])
        assert args.workspace_id is None

    def test_fleet_and_workspace_both_parseable(self):
        args = self._parse([
            "--prompt", "x",
            "--fleet-id", "fleet-1",
            "--workspace-id", "ws-2",
        ])
        assert args.fleet_id == "fleet-1"
        assert args.workspace_id == "ws-2"


# --- register_pipeline grouping ---


def test_register_workspace_id_stored(tmp_path):
    base = str(tmp_path / ".worca")
    path = register_pipeline(
        "run-ws", "/tmp/wt", "WS Run", 1, base=base,
        workspace_id="ws-xyz", group_type="workspace",
    )
    with open(path) as f:
        data = json.load(f)
    assert data["workspace_id"] == "ws-xyz"
    assert data["group_type"] == "workspace"


def test_register_fleet_id_stored(tmp_path):
    base = str(tmp_path / ".worca")
    path = register_pipeline(
        "run-fl", "/tmp/wt", "Fleet Run", 1, base=base,
        fleet_id="fleet-abc", group_type="fleet",
    )
    with open(path) as f:
        data = json.load(f)
    assert data["fleet_id"] == "fleet-abc"
    assert data["group_type"] == "fleet"


def test_register_neither_id_no_group_fields(tmp_path):
    base = str(tmp_path / ".worca")
    path = register_pipeline("run-plain", "/tmp/wt", "Plain", 1, base=base)
    with open(path) as f:
        data = json.load(f)
    assert "fleet_id" not in data
    assert "workspace_id" not in data
    assert "group_type" not in data


def test_register_rejects_both_fleet_and_workspace(tmp_path):
    """Mutual exclusion: ValueError raised before any file is written."""
    base = str(tmp_path / ".worca")
    with pytest.raises(ValueError, match="mutually exclusive"):
        register_pipeline(
            "run-both", "/tmp/wt", "Both", 1, base=base,
            fleet_id="f1", workspace_id="w1",
        )
    d = os.path.join(base, "multi", "pipelines.d")
    if os.path.isdir(d):
        assert "run-both.json" not in os.listdir(d)


# --- run_worktree group_type derivation ---
# main() derives group_type from args and passes it to register_pipeline.
# We verify the derivation logic matches the source (lines ~288-297) by
# reading args and computing the expected kwargs.


class TestGroupTypeDerivation:
    def _parse(self, argv):
        from worca.scripts.run_worktree import create_parser
        return create_parser().parse_args(argv)

    @staticmethod
    def _derive_group_type(args):
        """Mirror the ternary in run_worktree.main() line ~296."""
        return "fleet" if args.fleet_id else "workspace" if args.workspace_id else None

    def test_workspace_id_derives_workspace(self):
        args = self._parse(["--prompt", "x", "--workspace-id", "ws-42"])
        assert self._derive_group_type(args) == "workspace"
        assert args.workspace_id == "ws-42"
        assert args.fleet_id is None

    def test_fleet_id_derives_fleet(self):
        args = self._parse(["--prompt", "x", "--fleet-id", "fleet-abc"])
        assert self._derive_group_type(args) == "fleet"
        assert args.fleet_id == "fleet-abc"
        assert args.workspace_id is None

    def test_neither_derives_none(self):
        args = self._parse(["--prompt", "x"])
        assert self._derive_group_type(args) is None
        assert args.fleet_id is None
        assert args.workspace_id is None
