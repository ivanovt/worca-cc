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
            run_id=None, all=True, dry_run=False, older_than=None
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
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
            run_id=None, all=True, dry_run=False,
            older_than=timedelta(days=7),
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
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
            run_id=None, all=True, dry_run=False, older_than=None
        )

        with patch("worca.cli.cleanup._find_git_root", return_value=tmp_path):
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
