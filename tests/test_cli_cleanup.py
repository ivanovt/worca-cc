"""Tests for worca cleanup CLI (src/worca/cli/cleanup.py)."""

import json
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_registry(base, run_id, worktree_path, status="running", started_at=None):
    """Write a pipelines.d registry entry."""
    d = os.path.join(base, "multi", "pipelines.d")
    os.makedirs(d, exist_ok=True)
    ts = (started_at or datetime.now(timezone.utc)).isoformat()
    data = {
        "run_id": run_id,
        "worktree_path": worktree_path,
        "title": f"Task {run_id}",
        "pid": 99999,
        "status": status,
        "started_at": ts,
        "updated_at": ts,
    }
    path = os.path.join(d, f"{run_id}.json")
    with open(path, "w") as f:
        json.dump(data, f)


def _write_worktree_status(worktree_path, pipeline_status):
    """Write a status.json inside a fake worktree's runs/ directory."""
    run_dir = os.path.join(worktree_path, ".worca", "runs", "inner-run-1")
    os.makedirs(run_dir, exist_ok=True)
    data = {"pipeline_status": pipeline_status, "run_id": "inner-run-1"}
    with open(os.path.join(run_dir, "status.json"), "w") as f:
        json.dump(data, f)


# ---------------------------------------------------------------------------
# Parser tests
# ---------------------------------------------------------------------------


class TestCleanupParser:
    def test_parse_duration_days(self):
        from worca.cli.cleanup import _parse_duration
        assert _parse_duration("7d") == timedelta(days=7)

    def test_parse_duration_hours(self):
        from worca.cli.cleanup import _parse_duration
        assert _parse_duration("24h") == timedelta(hours=24)

    def test_parse_duration_minutes(self):
        from worca.cli.cleanup import _parse_duration
        assert _parse_duration("30m") == timedelta(minutes=30)

    def test_parse_duration_invalid(self):
        import argparse
        from worca.cli.cleanup import _parse_duration
        with pytest.raises(argparse.ArgumentTypeError):
            _parse_duration("invalid")

    def test_main_parser_cleanup_subcommand(self):
        from worca.cli.main import create_parser
        parser = create_parser()
        args = parser.parse_args(["cleanup", "--all"])
        assert args.command == "cleanup"
        assert args.all is True
        assert args.dry_run is False
        assert args.run_id is None
        assert args.older_than is None

    def test_main_parser_cleanup_dry_run(self):
        from worca.cli.main import create_parser
        parser = create_parser()
        args = parser.parse_args(["cleanup", "--dry-run"])
        assert args.dry_run is True

    def test_main_parser_cleanup_run_id(self):
        from worca.cli.main import create_parser
        parser = create_parser()
        args = parser.parse_args(["cleanup", "--run-id", "run-abc"])
        assert args.run_id == "run-abc"

    def test_main_parser_cleanup_older_than(self):
        from worca.cli.main import create_parser
        parser = create_parser()
        args = parser.parse_args(["cleanup", "--older-than", "7d"])
        assert args.older_than == timedelta(days=7)


# ---------------------------------------------------------------------------
# WorktreeSource.list_eligible
# ---------------------------------------------------------------------------


class TestWorktreeSourceListEligible:
    def test_completed_worktree_is_eligible(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        _write_registry(base, "run1", wt)
        _write_worktree_status(wt, "completed")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({})

        assert len(eligible) == 1
        assert eligible[0]["run_id"] == "run1"
        assert eligible[0]["pipeline_status"] == "completed"

    def test_failed_worktree_is_eligible(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        _write_registry(base, "run1", wt)
        _write_worktree_status(wt, "failed")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({})

        assert len(eligible) == 1

    def test_running_worktree_not_eligible(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        _write_registry(base, "run1", wt)
        _write_worktree_status(wt, "running")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({})

        assert eligible == []

    def test_no_worktree_path_skipped(self, tmp_path):
        """Registry entries without worktree_path are skipped."""
        base = str(tmp_path / ".worca")
        d = os.path.join(base, "multi", "pipelines.d")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "run1.json"), "w") as f:
            json.dump({"run_id": "run1", "status": "completed"}, f)

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({})

        assert eligible == []

    def test_nonexistent_worktree_dir_skipped(self, tmp_path):
        """Registry entries whose worktree directory doesn't exist are skipped."""
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "nonexistent")
        _write_registry(base, "run1", wt, status="completed")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({})

        assert eligible == []

    def test_run_id_filter(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt1 = str(tmp_path / "wt1")
        wt2 = str(tmp_path / "wt2")
        _write_registry(base, "run1", wt1)
        _write_registry(base, "run2", wt2)
        _write_worktree_status(wt1, "completed")
        _write_worktree_status(wt2, "completed")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({"run_id": "run1"})

        assert len(eligible) == 1
        assert eligible[0]["run_id"] == "run1"

    def test_older_than_filter_includes_old(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        old_time = datetime.now(timezone.utc) - timedelta(days=10)
        _write_registry(base, "run1", wt, started_at=old_time)
        _write_worktree_status(wt, "completed")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({"older_than": timedelta(days=7)})

        assert len(eligible) == 1

    def test_older_than_filter_excludes_recent(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        recent_time = datetime.now(timezone.utc) - timedelta(days=2)
        _write_registry(base, "run1", wt, started_at=recent_time)
        _write_worktree_status(wt, "completed")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({"older_than": timedelta(days=7)})

        assert eligible == []

    def test_registry_status_fallback_when_no_status_json(self, tmp_path):
        """Falls back to registry status when worktree has no status.json."""
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        os.makedirs(wt)
        # Registry says completed, no status.json inside worktree
        _write_registry(base, "run1", wt, status="completed")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({})

        assert len(eligible) == 1

    def test_registry_status_fallback_running_skipped(self, tmp_path):
        """Falls back to registry status=running → not eligible."""
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        os.makedirs(wt)
        _write_registry(base, "run1", wt, status="running")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible({})

        assert eligible == []


# ---------------------------------------------------------------------------
# WorktreeSource.remove
# ---------------------------------------------------------------------------


class TestWorktreeSourceRemove:
    def test_remove_calls_git_and_deregisters(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        os.makedirs(wt)
        _write_registry(base, "run1", wt)

        from worca.cli.cleanup import WorktreeSource
        source = WorktreeSource(base=base)
        entry = {"run_id": "run1", "worktree_path": wt}

        with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=True) as mock_rm:
            with patch("worca.cli.cleanup.deregister_pipeline") as mock_dereg:
                ok = source.remove(entry)

        assert ok is True
        mock_rm.assert_called_once_with(wt)
        mock_dereg.assert_called_once_with("run1", base=base)

    def test_remove_skips_git_if_path_missing(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "nonexistent")

        from worca.cli.cleanup import WorktreeSource
        source = WorktreeSource(base=base)
        entry = {"run_id": "run1", "worktree_path": wt}

        with patch("worca.cli.cleanup.remove_pipeline_worktree") as mock_rm:
            with patch("worca.cli.cleanup.deregister_pipeline") as mock_dereg:
                ok = source.remove(entry)

        assert ok is True
        mock_rm.assert_not_called()
        mock_dereg.assert_called_once_with("run1", base=base)

    def test_remove_returns_false_on_git_failure(self, tmp_path):
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        os.makedirs(wt)

        from worca.cli.cleanup import WorktreeSource
        source = WorktreeSource(base=base)
        entry = {"run_id": "run1", "worktree_path": wt}

        with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=False):
            with patch("worca.cli.cleanup.deregister_pipeline") as mock_dereg:
                ok = source.remove(entry)

        assert ok is False
        mock_dereg.assert_not_called()


# ---------------------------------------------------------------------------
# cmd_cleanup — required tests from bead spec
# ---------------------------------------------------------------------------


class TestCmdCleanup:
    def test_cleanup_completed_worktree(self, tmp_path, capsys):
        """A completed worktree is removed and freed bytes reported."""
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        os.makedirs(wt)
        _write_registry(base, "run1", wt)
        _write_worktree_status(wt, "completed")

        import argparse
        args = argparse.Namespace(
            run_id="run1", all=False, dry_run=False, older_than=None
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
            with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=True):
                with patch("worca.cli.cleanup.deregister_pipeline"):
                    from worca.cli.cleanup import cmd_cleanup
                    cmd_cleanup(args)

        out = capsys.readouterr().out
        assert "Removed 1" in out

    def test_cleanup_skips_running(self, tmp_path, capsys):
        """A running worktree is never cleaned up, even with --all."""
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        os.makedirs(wt)
        _write_registry(base, "run1", wt)
        _write_worktree_status(wt, "running")

        import argparse
        args = argparse.Namespace(
            run_id=None, fleet_id=None, all=True, dry_run=False, older_than=None
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
            # Isolate FleetSource from the real ~/.worca/fleet-runs/ directory
            with patch("worca.cli.cleanup.FleetSource.list_eligible", return_value=[]):
                with patch("worca.cli.cleanup.remove_pipeline_worktree") as mock_rm:
                    from worca.cli.cleanup import cmd_cleanup
                    cmd_cleanup(args)

        mock_rm.assert_not_called()
        out = capsys.readouterr().out
        assert "No eligible" in out

    def test_cleanup_dry_run(self, tmp_path, capsys):
        """Dry run lists worktrees to remove without actually removing them."""
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        os.makedirs(wt)
        _write_registry(base, "run1", wt)
        _write_worktree_status(wt, "completed")

        import argparse
        args = argparse.Namespace(
            run_id=None, all=True, dry_run=True, older_than=None
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
            with patch("worca.cli.cleanup.remove_pipeline_worktree") as mock_rm:
                with patch("worca.cli.cleanup.deregister_pipeline") as mock_dereg:
                    from worca.cli.cleanup import cmd_cleanup
                    cmd_cleanup(args)

        mock_rm.assert_not_called()
        mock_dereg.assert_not_called()
        out = capsys.readouterr().out
        assert "Would remove" in out
        assert "run1" in out

    def test_cleanup_older_than(self, tmp_path, capsys):
        """--older-than removes old worktrees but skips recent ones."""
        base = str(tmp_path / ".worca")
        wt_old = str(tmp_path / "wt_old")
        wt_new = str(tmp_path / "wt_new")
        os.makedirs(wt_old)
        os.makedirs(wt_new)

        old_time = datetime.now(timezone.utc) - timedelta(days=10)
        recent_time = datetime.now(timezone.utc) - timedelta(days=2)
        _write_registry(base, "run-old", wt_old, started_at=old_time)
        _write_registry(base, "run-new", wt_new, started_at=recent_time)
        _write_worktree_status(wt_old, "completed")
        _write_worktree_status(wt_new, "completed")

        import argparse
        args = argparse.Namespace(
            run_id=None, fleet_id=None, all=True, dry_run=False,
            older_than=timedelta(days=7),
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
            # Isolate FleetSource from the real ~/.worca/fleet-runs/ directory
            with patch("worca.cli.cleanup.FleetSource.list_eligible", return_value=[]):
                with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=True) as mock_rm:
                    with patch("worca.cli.cleanup.deregister_pipeline"):
                        from worca.cli.cleanup import cmd_cleanup
                        cmd_cleanup(args)

        mock_rm.assert_called_once_with(wt_old)
        out = capsys.readouterr().out
        assert "Removed 1" in out

    def test_cleanup_no_eligible_message(self, tmp_path, capsys):
        """Prints a helpful message when there's nothing to clean up."""
        base = str(tmp_path / ".worca")
        os.makedirs(os.path.join(base, "multi", "pipelines.d"), exist_ok=True)

        import argparse
        args = argparse.Namespace(
            run_id=None, fleet_id=None, all=True, dry_run=False, older_than=None
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
            # Isolate FleetSource from the real ~/.worca/fleet-runs/ directory
            with patch("worca.cli.cleanup.FleetSource.list_eligible", return_value=[]):
                from worca.cli.cleanup import cmd_cleanup
                cmd_cleanup(args)

        out = capsys.readouterr().out
        assert "No eligible" in out

    def test_cleanup_reports_errors(self, tmp_path, capsys):
        """Reports to stderr when a removal fails."""
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        os.makedirs(wt)
        _write_registry(base, "run1", wt)
        _write_worktree_status(wt, "completed")

        import argparse
        args = argparse.Namespace(
            run_id=None, all=True, dry_run=False, older_than=None
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
            with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=False):
                from worca.cli.cleanup import cmd_cleanup
                cmd_cleanup(args)

        err = capsys.readouterr().err
        assert "failed" in err.lower() or "error" in err.lower() or "warning" in err.lower()


# ---------------------------------------------------------------------------
# FleetSource helpers
# ---------------------------------------------------------------------------


def _write_fleet_manifest(
    fleet_runs_dir,
    fleet_id,
    status="completed",
    started_at=None,
    children=None,
    title=None,
):
    """Write a minimal fleet manifest to fleet_runs_dir/<fleet_id>.json."""
    os.makedirs(fleet_runs_dir, exist_ok=True)
    ts = (started_at or datetime.now(timezone.utc)).isoformat()
    manifest = {
        "fleet_id": fleet_id,
        "status": status,
        "started_at": ts,
        "updated_at": ts,
        "title": title or f"Fleet {fleet_id}",
        "halt_reason": None,
        "children": children or [],
    }
    path = os.path.join(fleet_runs_dir, f"{fleet_id}.json")
    with open(path, "w") as f:
        json.dump(manifest, f)
    return path


# ---------------------------------------------------------------------------
# FleetSource.list_eligible
# ---------------------------------------------------------------------------


class TestFleetSourceListEligible:
    def test_empty_when_dir_does_not_exist(self, tmp_path):
        from worca.cli.cleanup import FleetSource
        source = FleetSource(fleet_runs_dir=str(tmp_path / "fleet-runs"))
        assert source.list_eligible({}) == []

    def test_returns_fleet_manifest_entry(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_20260512_abc1")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert len(eligible) == 1
        assert eligible[0]["fleet_id"] == "f_20260512_abc1"
        assert eligible[0]["run_id"] == "f_20260512_abc1"

    def test_returns_title_from_manifest(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_abc", title="My migration fleet")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert eligible[0]["title"] == "My migration fleet"

    def test_fleet_id_filter_includes_matching(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_001")
        _write_fleet_manifest(fleet_runs_dir, "f_002")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({"fleet_id": "f_001"})

        assert len(eligible) == 1
        assert eligible[0]["fleet_id"] == "f_001"

    def test_fleet_id_filter_excludes_non_matching(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_001")
        _write_fleet_manifest(fleet_runs_dir, "f_002")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({"fleet_id": "f_999"})

        assert eligible == []

    def test_older_than_filter_includes_old(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        old_time = datetime.now(timezone.utc) - timedelta(days=10)
        _write_fleet_manifest(fleet_runs_dir, "f_old", started_at=old_time)

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible(
            {"older_than": timedelta(days=7)}
        )

        assert len(eligible) == 1
        assert eligible[0]["fleet_id"] == "f_old"

    def test_older_than_filter_excludes_recent(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        recent_time = datetime.now(timezone.utc) - timedelta(days=2)
        _write_fleet_manifest(fleet_runs_dir, "f_new", started_at=recent_time)

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible(
            {"older_than": timedelta(days=7)}
        )

        assert eligible == []

    # Production manifests carry `created_at`, not `started_at`. Without the
    # fallback in FleetSource.list_eligible the age guard would be a no-op
    # and --older-than would delete every fleet regardless of age.

    def _write_created_at_manifest(self, fleet_runs_dir, fleet_id, created_at):
        os.makedirs(fleet_runs_dir, exist_ok=True)
        manifest = {
            "fleet_id": fleet_id,
            "status": "completed",
            "created_at": created_at.isoformat(),
            "title": f"Fleet {fleet_id}",
            "halt_reason": None,
            "children": [],
        }
        with open(os.path.join(fleet_runs_dir, f"{fleet_id}.json"), "w") as f:
            json.dump(manifest, f)

    def test_older_than_filter_uses_created_at_when_started_at_missing(self, tmp_path):
        """Production manifests have created_at, not started_at — must still age-filter."""
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        old = datetime.now(timezone.utc) - timedelta(days=10)
        self._write_created_at_manifest(fleet_runs_dir, "f_old_created", old)

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible(
            {"older_than": timedelta(days=7)}
        )

        assert len(eligible) == 1
        assert eligible[0]["fleet_id"] == "f_old_created"

    def test_older_than_filter_excludes_recent_created_at(self, tmp_path):
        """The no-op-age-guard bug: a recent created_at must NOT be eligible."""
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        recent = datetime.now(timezone.utc) - timedelta(days=2)
        self._write_created_at_manifest(fleet_runs_dir, "f_new_created", recent)

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible(
            {"older_than": timedelta(days=7)}
        )

        assert eligible == []

    def test_skips_malformed_json(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        os.makedirs(fleet_runs_dir)
        with open(os.path.join(fleet_runs_dir, "bad.json"), "w") as f:
            f.write("{not valid json}")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert eligible == []

    def test_skips_non_json_files(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        os.makedirs(fleet_runs_dir)
        with open(os.path.join(fleet_runs_dir, "notes.txt"), "w") as f:
            f.write("not a manifest")
        _write_fleet_manifest(fleet_runs_dir, "f_real")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert len(eligible) == 1
        assert eligible[0]["fleet_id"] == "f_real"

    def test_running_fleet_not_eligible(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_running", status="running")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert eligible == []

    def test_paused_fleet_not_eligible(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_paused", status="paused")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert eligible == []

    def test_completed_fleet_is_eligible(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_done", status="completed")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert len(eligible) == 1

    def test_halted_fleet_is_eligible(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_halted", status="halted")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert len(eligible) == 1

    def test_failed_fleet_is_eligible(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_failed", status="failed")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert len(eligible) == 1

    def test_entry_has_manifest_path(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(fleet_runs_dir, "f_abc")

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert "manifest_path" in eligible[0]
        assert eligible[0]["manifest_path"].endswith("f_abc.json")

    def test_entry_has_children_list(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        _write_fleet_manifest(
            fleet_runs_dir,
            "f_abc",
            children=[{"run_id": "r1", "project_path": "/p/a"}],
        )

        from worca.cli.cleanup import FleetSource
        eligible = FleetSource(fleet_runs_dir=fleet_runs_dir).list_eligible({})

        assert eligible[0]["children"] == [{"run_id": "r1", "project_path": "/p/a"}]


# ---------------------------------------------------------------------------
# FleetSource.remove
# ---------------------------------------------------------------------------


class TestFleetSourceRemove:
    def test_remove_no_children_removes_manifest_file(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        manifest_path = _write_fleet_manifest(fleet_runs_dir, "f_abc", children=[])

        from worca.cli.cleanup import FleetSource
        source = FleetSource(fleet_runs_dir=fleet_runs_dir)
        entry = {
            "fleet_id": "f_abc",
            "run_id": "f_abc",
            "children": [],
            "manifest_path": manifest_path,
            "worktree_path": str(tmp_path / "fleet-runs" / "f_abc"),
        }

        ok = source.remove(entry)

        assert ok is True
        assert not os.path.isfile(manifest_path)

    def test_remove_removes_fleet_guides_dir(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        manifest_path = _write_fleet_manifest(fleet_runs_dir, "f_abc", children=[])
        fleet_dir = os.path.join(fleet_runs_dir, "f_abc")
        os.makedirs(fleet_dir)
        with open(os.path.join(fleet_dir, "guide.md"), "w") as f:
            f.write("# Guide")

        from worca.cli.cleanup import FleetSource
        source = FleetSource(fleet_runs_dir=fleet_runs_dir)
        entry = {
            "fleet_id": "f_abc",
            "run_id": "f_abc",
            "children": [],
            "manifest_path": manifest_path,
            "worktree_path": fleet_dir,
        }

        ok = source.remove(entry)

        assert ok is True
        assert not os.path.isdir(fleet_dir)
        assert not os.path.isfile(manifest_path)

    def test_remove_calls_worktree_source_for_child(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        project_dir = str(tmp_path / "myrepo")
        os.makedirs(project_dir)
        child_base = os.path.join(project_dir, ".worca")
        child_wt = str(tmp_path / "wt_child")
        os.makedirs(child_wt)
        _write_registry(child_base, "run-child", child_wt, status="completed")

        manifest_path = _write_fleet_manifest(
            fleet_runs_dir,
            "f_abc",
            children=[{"run_id": "run-child", "project_path": project_dir}],
        )

        from worca.cli.cleanup import FleetSource
        source = FleetSource(fleet_runs_dir=fleet_runs_dir)
        entry = {
            "fleet_id": "f_abc",
            "run_id": "f_abc",
            "children": [{"run_id": "run-child", "project_path": project_dir}],
            "manifest_path": manifest_path,
            "worktree_path": str(tmp_path / "fleet-runs" / "f_abc"),
        }

        with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=True) as mock_rm:
            ok = source.remove(entry)

        assert ok is True
        mock_rm.assert_called_once_with(child_wt)
        # pipelines.d/ entry should be gone
        reg_path = os.path.join(child_base, "multi", "pipelines.d", "run-child.json")
        assert not os.path.isfile(reg_path)

    def test_remove_returns_false_on_child_worktree_failure(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        project_dir = str(tmp_path / "myrepo")
        os.makedirs(project_dir)
        child_base = os.path.join(project_dir, ".worca")
        child_wt = str(tmp_path / "wt_child")
        os.makedirs(child_wt)
        _write_registry(child_base, "run-child", child_wt)

        manifest_path = _write_fleet_manifest(
            fleet_runs_dir,
            "f_abc",
            children=[{"run_id": "run-child", "project_path": project_dir}],
        )

        from worca.cli.cleanup import FleetSource
        source = FleetSource(fleet_runs_dir=fleet_runs_dir)
        entry = {
            "fleet_id": "f_abc",
            "run_id": "f_abc",
            "children": [{"run_id": "run-child", "project_path": project_dir}],
            "manifest_path": manifest_path,
            "worktree_path": str(tmp_path / "fleet-runs" / "f_abc"),
        }

        with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=False):
            ok = source.remove(entry)

        assert ok is False

    def test_remove_skips_child_without_project_path(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        manifest_path = _write_fleet_manifest(
            fleet_runs_dir,
            "f_abc",
            children=[{"run_id": "run-orphan"}],  # no project_path
        )

        from worca.cli.cleanup import FleetSource
        source = FleetSource(fleet_runs_dir=fleet_runs_dir)
        entry = {
            "fleet_id": "f_abc",
            "run_id": "f_abc",
            "children": [{"run_id": "run-orphan"}],
            "manifest_path": manifest_path,
            "worktree_path": str(tmp_path / "fleet-runs" / "f_abc"),
        }

        with patch("worca.cli.cleanup.remove_pipeline_worktree") as mock_rm:
            ok = source.remove(entry)

        assert ok is True
        mock_rm.assert_not_called()

    def test_remove_fleet_dir_missing_still_removes_manifest(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        manifest_path = _write_fleet_manifest(fleet_runs_dir, "f_abc", children=[])
        # No fleet_dir — guides dir never created

        from worca.cli.cleanup import FleetSource
        source = FleetSource(fleet_runs_dir=fleet_runs_dir)
        entry = {
            "fleet_id": "f_abc",
            "run_id": "f_abc",
            "children": [],
            "manifest_path": manifest_path,
            "worktree_path": str(tmp_path / "fleet-runs" / "f_abc"),  # does not exist
        }

        ok = source.remove(entry)

        assert ok is True
        assert not os.path.isfile(manifest_path)


# ---------------------------------------------------------------------------
# _build_sources includes FleetSource
# ---------------------------------------------------------------------------


class TestBuildSourcesIncludesFleetSource:
    def test_build_sources_includes_fleet_source(self, tmp_path):
        from worca.cli.cleanup import _build_sources
        sources = _build_sources(str(tmp_path / ".worca"))
        source_types = [type(s).__name__ for s in sources]
        assert "FleetSource" in source_types


# ---------------------------------------------------------------------------
# --fleet-id CLI argument
# ---------------------------------------------------------------------------


class TestCleanupFleetIdArg:
    def test_main_parser_cleanup_fleet_id(self):
        from worca.cli.main import create_parser
        parser = create_parser()
        args = parser.parse_args(["cleanup", "--fleet-id", "f_20260512_abc1"])
        assert args.fleet_id == "f_20260512_abc1"

    def test_fleet_id_absent_by_default(self):
        from worca.cli.main import create_parser
        parser = create_parser()
        args = parser.parse_args(["cleanup"])
        assert args.fleet_id is None


# ---------------------------------------------------------------------------
# WorkspaceSource helpers
# ---------------------------------------------------------------------------


def _write_workspace_pointer(pointer_dir, workspace_id, workspace_root):
    """Write a pointer file at pointer_dir/<workspace_id>.json."""
    os.makedirs(pointer_dir, exist_ok=True)
    data = {"workspace_root": workspace_root, "workspace_id": workspace_id}
    path = os.path.join(pointer_dir, f"{workspace_id}.json")
    with open(path, "w") as f:
        json.dump(data, f)
    return path


def _write_workspace_manifest(
    workspace_root,
    workspace_id,
    status="completed",
    created_at=None,
    children=None,
    workspace_name=None,
):
    """Write a workspace manifest at workspace_root/.worca/workspace-runs/<id>/workspace-manifest.json."""
    run_dir = os.path.join(workspace_root, ".worca", "workspace-runs", workspace_id)
    os.makedirs(run_dir, exist_ok=True)
    ts = (created_at or datetime.now(timezone.utc)).isoformat()
    manifest = {
        "workspace_id": workspace_id,
        "workspace_name": workspace_name or f"ws-{workspace_id}",
        "workspace_root": workspace_root,
        "created_at": ts,
        "status": status,
        "halt_reason": None,
        "children": children or [],
        "dag": {"tiers": []},
        "integration_test": {"status": "pending", "exit_code": None, "log_path": None},
    }
    path = os.path.join(run_dir, "workspace-manifest.json")
    with open(path, "w") as f:
        json.dump(manifest, f)
    return run_dir


# ---------------------------------------------------------------------------
# WorkspaceSource.list_eligible
# ---------------------------------------------------------------------------


class TestWorkspaceSourceListEligible:
    def test_empty_when_pointer_dir_does_not_exist(self, tmp_path):
        from worca.cli.cleanup import WorkspaceSource
        source = WorkspaceSource(pointer_dir=str(tmp_path / "nonexistent"))
        assert source.list_eligible({}) == []

    def test_completed_workspace_is_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_202605_abc1", ws_root)
        _write_workspace_manifest(ws_root, "ws_202605_abc1", status="completed")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert len(eligible) == 1
        assert eligible[0]["workspace_id"] == "ws_202605_abc1"
        assert eligible[0]["run_id"] == "ws_202605_abc1"

    def test_failed_workspace_is_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_f", ws_root)
        _write_workspace_manifest(ws_root, "ws_f", status="failed")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert len(eligible) == 1

    def test_integration_failed_workspace_is_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_if", ws_root)
        _write_workspace_manifest(ws_root, "ws_if", status="integration_failed")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert len(eligible) == 1

    def test_halted_workspace_not_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_h", ws_root)
        _write_workspace_manifest(ws_root, "ws_h", status="halted")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_running_workspace_not_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_r", ws_root)
        _write_workspace_manifest(ws_root, "ws_r", status="running")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_planning_workspace_not_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_p", ws_root)
        _write_workspace_manifest(ws_root, "ws_p", status="planning")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_paused_workspace_not_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_pa", ws_root)
        _write_workspace_manifest(ws_root, "ws_pa", status="paused")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_integration_testing_workspace_not_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_it", ws_root)
        _write_workspace_manifest(ws_root, "ws_it", status="integration_testing")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_blocked_workspace_not_eligible(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_b", ws_root)
        _write_workspace_manifest(ws_root, "ws_b", status="blocked")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_workspace_id_filter_includes_matching(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_001", ws_root)
        _write_workspace_pointer(pointer_dir, "ws_002", ws_root)
        _write_workspace_manifest(ws_root, "ws_001", status="completed")
        _write_workspace_manifest(ws_root, "ws_002", status="completed")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible(
            {"workspace_id": "ws_001"}
        )

        assert len(eligible) == 1
        assert eligible[0]["workspace_id"] == "ws_001"

    def test_workspace_id_filter_excludes_non_matching(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_001", ws_root)
        _write_workspace_manifest(ws_root, "ws_001", status="completed")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible(
            {"workspace_id": "ws_999"}
        )

        assert eligible == []

    def test_older_than_filter_includes_old(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        old_time = datetime.now(timezone.utc) - timedelta(days=10)
        _write_workspace_pointer(pointer_dir, "ws_old", ws_root)
        _write_workspace_manifest(
            ws_root, "ws_old", status="completed", created_at=old_time,
        )

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible(
            {"older_than": timedelta(days=7)}
        )

        assert len(eligible) == 1

    def test_older_than_filter_excludes_recent(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        recent_time = datetime.now(timezone.utc) - timedelta(days=2)
        _write_workspace_pointer(pointer_dir, "ws_new", ws_root)
        _write_workspace_manifest(
            ws_root, "ws_new", status="completed", created_at=recent_time,
        )

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible(
            {"older_than": timedelta(days=7)}
        )

        assert eligible == []

    def test_guard_returns_empty_when_run_id_without_workspace_id(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_001", ws_root)
        _write_workspace_manifest(ws_root, "ws_001", status="completed")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible(
            {"run_id": "some-run"}
        )

        assert eligible == []

    def test_guard_returns_empty_when_fleet_id_without_workspace_id(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_001", ws_root)
        _write_workspace_manifest(ws_root, "ws_001", status="completed")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible(
            {"fleet_id": "some-fleet"}
        )

        assert eligible == []

    def test_skips_malformed_pointer_json(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        os.makedirs(pointer_dir)
        with open(os.path.join(pointer_dir, "bad.json"), "w") as f:
            f.write("{not valid json}")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_skips_pointer_without_workspace_root(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        os.makedirs(pointer_dir)
        with open(os.path.join(pointer_dir, "ws_bad.json"), "w") as f:
            json.dump({"workspace_id": "ws_bad"}, f)

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_skips_missing_manifest(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_gone", ws_root)

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible == []

    def test_entry_has_correct_fields(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        _write_workspace_pointer(pointer_dir, "ws_abc", ws_root)
        _write_workspace_manifest(
            ws_root, "ws_abc", status="completed", workspace_name="my-platform",
        )

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert len(eligible) == 1
        e = eligible[0]
        assert e["workspace_id"] == "ws_abc"
        assert e["run_id"] == "ws_abc"
        assert e["title"] == "my-platform"
        assert e["workspace_root"] == ws_root
        assert e["pointer_path"].endswith("ws_abc.json")
        assert "children" in e
        assert "worktree_path" in e

    def test_entry_children_from_manifest(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(ws_root)
        children = [
            {"repo": "backend", "run_id": "r1", "project_path": "/p/backend"},
        ]
        _write_workspace_pointer(pointer_dir, "ws_ch", ws_root)
        _write_workspace_manifest(
            ws_root, "ws_ch", status="completed", children=children,
        )

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert eligible[0]["children"] == children

    def test_skips_non_json_files(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        os.makedirs(pointer_dir)
        os.makedirs(ws_root)
        with open(os.path.join(pointer_dir, "notes.txt"), "w") as f:
            f.write("not a pointer")
        _write_workspace_pointer(pointer_dir, "ws_real", ws_root)
        _write_workspace_manifest(ws_root, "ws_real", status="completed")

        from worca.cli.cleanup import WorkspaceSource
        eligible = WorkspaceSource(pointer_dir=pointer_dir).list_eligible({})

        assert len(eligible) == 1
        assert eligible[0]["workspace_id"] == "ws_real"


# ---------------------------------------------------------------------------
# WorkspaceSource.remove
# ---------------------------------------------------------------------------


class TestWorkspaceSourceRemove:
    def test_remove_deletes_run_dir_and_pointer(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        pointer_path = _write_workspace_pointer(pointer_dir, "ws_abc", ws_root)
        run_dir = _write_workspace_manifest(ws_root, "ws_abc", status="completed")

        from worca.cli.cleanup import WorkspaceSource
        source = WorkspaceSource(pointer_dir=pointer_dir)
        entry = {
            "workspace_id": "ws_abc",
            "run_id": "ws_abc",
            "workspace_root": ws_root,
            "run_dir": run_dir,
            "pointer_path": pointer_path,
            "worktree_path": run_dir,
            "children": [],
        }

        ok = source.remove(entry)

        assert ok is True
        assert not os.path.isdir(run_dir)
        assert not os.path.isfile(pointer_path)

    def test_remove_removes_integration_env_dir(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        pointer_path = _write_workspace_pointer(pointer_dir, "ws_ie", ws_root)
        run_dir = _write_workspace_manifest(ws_root, "ws_ie", status="completed")

        int_env_dir = os.path.join(ws_root, ".worca", "integration-env")
        os.makedirs(int_env_dir)
        with open(os.path.join(int_env_dir, "marker.txt"), "w") as f:
            f.write("test")

        from worca.cli.cleanup import WorkspaceSource
        source = WorkspaceSource(pointer_dir=pointer_dir)
        entry = {
            "workspace_id": "ws_ie",
            "run_id": "ws_ie",
            "workspace_root": ws_root,
            "run_dir": run_dir,
            "pointer_path": pointer_path,
            "worktree_path": run_dir,
            "children": [],
        }

        ok = source.remove(entry)

        assert ok is True
        assert not os.path.isdir(int_env_dir)

    def test_remove_calls_worktree_source_for_children(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        project_dir = str(tmp_path / "repos" / "backend")
        os.makedirs(project_dir)
        child_base = os.path.join(project_dir, ".worca")
        child_wt = str(tmp_path / "wt_child")
        os.makedirs(child_wt)
        _write_registry(child_base, "run-child", child_wt, status="completed")

        pointer_path = _write_workspace_pointer(pointer_dir, "ws_ch", ws_root)
        run_dir = _write_workspace_manifest(
            ws_root, "ws_ch", status="completed",
            children=[{"repo": "backend", "run_id": "run-child", "project_path": project_dir}],
        )

        from worca.cli.cleanup import WorkspaceSource
        source = WorkspaceSource(pointer_dir=pointer_dir)
        entry = {
            "workspace_id": "ws_ch",
            "run_id": "ws_ch",
            "workspace_root": ws_root,
            "run_dir": run_dir,
            "pointer_path": pointer_path,
            "worktree_path": run_dir,
            "children": [{"repo": "backend", "run_id": "run-child", "project_path": project_dir}],
        }

        with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=True) as mock_rm:
            ok = source.remove(entry)

        assert ok is True
        mock_rm.assert_called_once_with(child_wt)
        reg_path = os.path.join(child_base, "multi", "pipelines.d", "run-child.json")
        assert not os.path.isfile(reg_path)

    def test_remove_returns_false_on_child_worktree_failure(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        project_dir = str(tmp_path / "repos" / "backend")
        os.makedirs(project_dir)
        child_base = os.path.join(project_dir, ".worca")
        child_wt = str(tmp_path / "wt_child")
        os.makedirs(child_wt)
        _write_registry(child_base, "run-child", child_wt)

        pointer_path = _write_workspace_pointer(pointer_dir, "ws_fail", ws_root)
        run_dir = _write_workspace_manifest(
            ws_root, "ws_fail", status="completed",
            children=[{"repo": "backend", "run_id": "run-child", "project_path": project_dir}],
        )

        from worca.cli.cleanup import WorkspaceSource
        source = WorkspaceSource(pointer_dir=pointer_dir)
        entry = {
            "workspace_id": "ws_fail",
            "run_id": "ws_fail",
            "workspace_root": ws_root,
            "run_dir": run_dir,
            "pointer_path": pointer_path,
            "worktree_path": run_dir,
            "children": [{"repo": "backend", "run_id": "run-child", "project_path": project_dir}],
        }

        with patch("worca.cli.cleanup.remove_pipeline_worktree", return_value=False):
            ok = source.remove(entry)

        assert ok is False

    def test_remove_skips_child_without_project_path(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        pointer_path = _write_workspace_pointer(pointer_dir, "ws_skip", ws_root)
        run_dir = _write_workspace_manifest(
            ws_root, "ws_skip", status="completed",
            children=[{"repo": "orphan", "run_id": "run-orphan"}],
        )

        from worca.cli.cleanup import WorkspaceSource
        source = WorkspaceSource(pointer_dir=pointer_dir)
        entry = {
            "workspace_id": "ws_skip",
            "run_id": "ws_skip",
            "workspace_root": ws_root,
            "run_dir": run_dir,
            "pointer_path": pointer_path,
            "worktree_path": run_dir,
            "children": [{"repo": "orphan", "run_id": "run-orphan"}],
        }

        with patch("worca.cli.cleanup.remove_pipeline_worktree") as mock_rm:
            ok = source.remove(entry)

        assert ok is True
        mock_rm.assert_not_called()

    def test_remove_handles_missing_run_dir(self, tmp_path):
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        pointer_path = _write_workspace_pointer(pointer_dir, "ws_nrd", ws_root)
        run_dir = os.path.join(ws_root, ".worca", "workspace-runs", "ws_nrd")

        from worca.cli.cleanup import WorkspaceSource
        source = WorkspaceSource(pointer_dir=pointer_dir)
        entry = {
            "workspace_id": "ws_nrd",
            "run_id": "ws_nrd",
            "workspace_root": ws_root,
            "run_dir": run_dir,
            "pointer_path": pointer_path,
            "worktree_path": run_dir,
            "children": [],
        }

        ok = source.remove(entry)

        assert ok is True
        assert not os.path.isfile(pointer_path)


# ---------------------------------------------------------------------------
# _build_sources includes WorkspaceSource
# ---------------------------------------------------------------------------


class TestBuildSourcesIncludesWorkspaceSource:
    def test_build_sources_includes_workspace_source(self, tmp_path):
        from worca.cli.cleanup import _build_sources
        sources = _build_sources(str(tmp_path / ".worca"))
        source_types = [type(s).__name__ for s in sources]
        assert "WorkspaceSource" in source_types


# ---------------------------------------------------------------------------
# --workspace-id CLI argument
# ---------------------------------------------------------------------------


class TestCleanupWorkspaceIdArg:
    def test_main_parser_cleanup_workspace_id(self):
        from worca.cli.main import create_parser
        parser = create_parser()
        args = parser.parse_args(["cleanup", "--workspace-id", "ws_202605_abc1"])
        assert args.workspace_id == "ws_202605_abc1"

    def test_workspace_id_absent_by_default(self):
        from worca.cli.main import create_parser
        parser = create_parser()
        args = parser.parse_args(["cleanup"])
        assert args.workspace_id is None

    def test_workspace_id_auto_proceeds_without_prompt(self, tmp_path, capsys):
        """--workspace-id should auto-proceed (no interactive prompt) like --fleet-id."""
        pointer_dir = str(tmp_path / "pointers")
        ws_root = str(tmp_path / "workspace")
        _write_workspace_pointer(pointer_dir, "ws_auto", ws_root)
        _write_workspace_manifest(ws_root, "ws_auto", status="completed")

        import argparse
        args = argparse.Namespace(
            run_id=None, fleet_id=None, workspace_id="ws_auto",
            all=False, dry_run=False, older_than=None,
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
            with patch("worca.cli.cleanup._build_sources") as mock_sources:
                from worca.cli.cleanup import WorkspaceSource
                source = WorkspaceSource(pointer_dir=pointer_dir)
                mock_sources.return_value = [source]
                from worca.cli.cleanup import cmd_cleanup
                cmd_cleanup(args)

        out = capsys.readouterr().out
        assert "Removed 1" in out


# ---------------------------------------------------------------------------
# WorktreeSource guard against workspace_id
# ---------------------------------------------------------------------------


class TestWorktreeSourceWorkspaceIdGuard:
    def test_worktree_source_returns_empty_for_workspace_id_filter(self, tmp_path):
        """WorktreeSource should not list worktrees when workspace_id is in filters."""
        base = str(tmp_path / ".worca")
        wt = str(tmp_path / "wt1")
        _write_registry(base, "run1", wt)
        _write_worktree_status(wt, "completed")

        from worca.cli.cleanup import WorktreeSource
        eligible = WorktreeSource(base=base).list_eligible(
            {"workspace_id": "ws_some"}
        )

        assert eligible == []
