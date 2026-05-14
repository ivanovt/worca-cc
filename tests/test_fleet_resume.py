"""Tests for W-040 §12: run_fleet.py --resume <fleet_id>."""
import json
import os
from unittest.mock import patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_manifest(fleet_runs_dir, fleet_id, children, **overrides):
    """Write a minimal fleet manifest for testing."""
    manifest = {
        "fleet_id": fleet_id,
        "fleet_id_short": "abc123",
        "work_request": {
            "title": "Test fleet",
            "description": "Migrate auth",
            "source": None,
        },
        "guide": {"paths": [], "bytes": 0, "filenames": [], "uploaded": False},
        "plan": {"mode": "none", "path": None},
        "head_template": None,
        "base_branch": None,
        "max_parallel": 5,
        "fleet_failure_threshold": 0.30,
        "status": "halted",
        "halt_reason": "circuit_breaker",
        "children": children,
    }
    manifest.update(overrides)
    os.makedirs(fleet_runs_dir, exist_ok=True)
    path = os.path.join(fleet_runs_dir, f"{fleet_id}.json")
    with open(path, "w") as f:
        json.dump(manifest, f)
    return manifest


def _write_pipelines_entry(project_dir, run_id, status, worktree_path=None):
    """Write a pipelines.d/ entry for a fleet child.

    Pass worktree_path=None to store None (e.g. for setup_failed where no
    worktree was ever created). Pass an explicit path to store that path.
    """
    pipelines_d = os.path.join(project_dir, ".worca", "multi", "pipelines.d")
    os.makedirs(pipelines_d, exist_ok=True)
    entry = {
        "run_id": run_id,
        "status": status,
        "worktree_path": worktree_path,  # None when not created (e.g. setup_failed)
        "pid": 12345,
        "title": "Test run",
        "fleet_id": "f_20260512_test",
        "group_type": "fleet",
    }
    path = os.path.join(pipelines_d, f"{run_id}.json")
    with open(path, "w") as f:
        json.dump(entry, f)
    return entry


# ---------------------------------------------------------------------------
# Error cases
# ---------------------------------------------------------------------------


class TestResumeMissingManifest:
    """resume_fleet returns nonzero when the fleet manifest does not exist."""

    def test_missing_manifest_returns_nonzero(self, tmp_path):
        from worca.scripts.run_fleet import main

        fleet_runs_dir = str(tmp_path / "fleet-runs")
        with patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir):
            result = main(["--resume", "f_nonexistent"])
        assert result != 0

    def test_missing_manifest_prints_error(self, tmp_path, capsys):
        from worca.scripts.run_fleet import main

        fleet_runs_dir = str(tmp_path / "fleet-runs")
        with patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir):
            main(["--resume", "f_nonexistent"])
        captured = capsys.readouterr()
        assert "f_nonexistent" in captured.err or "f_nonexistent" in captured.out


# ---------------------------------------------------------------------------
# Child selection logic
# ---------------------------------------------------------------------------


class TestResumeSelectsChildren:
    """resume_fleet re-launches only pending/failed/setup_failed children."""

    def test_resume_selects_failed(self, tmp_path):
        """Failed child is included in dispatch targets."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "failed",
                               worktree_path=str(proj_a / ".worktrees" / "run-a"))
        # Create the worktree dir so it's not treated as "cleaned"
        (proj_a / ".worktrees" / "run-a").mkdir(parents=True)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        mock_dispatch.assert_called_once()
        targets = mock_dispatch.call_args[1]["targets"]
        dirs = [t["project_dir"] for t in targets]
        assert str(proj_a) in dirs

    def test_resume_selects_setup_failed(self, tmp_path):
        """setup_failed child is included in dispatch targets."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        # setup_failed — worktree_path is None (never created)
        _write_pipelines_entry(str(proj_a), "run-a", "setup_failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        mock_dispatch.assert_called_once()
        targets = mock_dispatch.call_args[1]["targets"]
        dirs = [t["project_dir"] for t in targets]
        assert str(proj_a) in dirs

    def test_resume_skips_completed(self, tmp_path):
        """Completed child is NOT included in dispatch targets."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "completed")

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        if mock_dispatch.called:
            targets = mock_dispatch.call_args[1]["targets"]
            assert str(proj_a) not in [t["project_dir"] for t in targets]

    def test_resume_skips_running(self, tmp_path):
        """Running child is NOT re-launched."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "running")

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        if mock_dispatch.called:
            targets = mock_dispatch.call_args[1]["targets"]
            assert str(proj_a) not in [t["project_dir"] for t in targets]

    def test_resume_resumes_paused_in_place(self, tmp_path):
        """A paused child is resumed in place via resume_child, not re-dispatched."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "paused")

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
            patch(
                "worca.orchestrator.fleet_lifecycle.resume_child", return_value=True
            ) as mock_resume_child,
        ):
            main(["--resume", fleet_id])

        # In-place resume — never goes through the fresh-worktree dispatch path.
        mock_resume_child.assert_called_once_with(str(proj_a), "run-a")
        if mock_dispatch.called:
            targets = mock_dispatch.call_args[1]["targets"]
            assert str(proj_a) not in [t["project_dir"] for t in targets]

    def test_resume_resumes_interrupted_in_place(self, tmp_path):
        """An interrupted (stopped) child is resumed in place via resume_child."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "interrupted")

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
            patch(
                "worca.orchestrator.fleet_lifecycle.resume_child", return_value=True
            ) as mock_resume_child,
        ):
            main(["--resume", fleet_id])

        mock_resume_child.assert_called_once_with(str(proj_a), "run-a")
        if mock_dispatch.called:
            targets = mock_dispatch.call_args[1]["targets"]
            assert str(proj_a) not in [t["project_dir"] for t in targets]

    def test_resume_skips_unrecoverable(self, tmp_path):
        """Explicitly unrecoverable child is NOT re-launched."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "unrecoverable")

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        if mock_dispatch.called:
            targets = mock_dispatch.call_args[1]["targets"]
            assert str(proj_a) not in [t["project_dir"] for t in targets]

    def test_resume_selects_only_resumable_from_mixed_fleet(self, tmp_path):
        """Only failed/setup_failed selected from fleet with mixed statuses."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")

        proj_a = tmp_path / "a"   # failed → re-launch
        proj_b = tmp_path / "b"   # completed → skip
        proj_c = tmp_path / "c"   # setup_failed → re-launch
        for p in [proj_a, proj_b, proj_c]:
            p.mkdir()

        children = [
            {"project_path": str(proj_a), "run_id": "run-a"},
            {"project_path": str(proj_b), "run_id": "run-b"},
            {"project_path": str(proj_c), "run_id": "run-c"},
        ]
        _write_manifest(fleet_runs_dir, fleet_id, children)

        wt_a = proj_a / ".worktrees" / "run-a"
        wt_a.mkdir(parents=True)
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=str(wt_a))
        _write_pipelines_entry(str(proj_b), "run-b", "completed")
        _write_pipelines_entry(str(proj_c), "run-c", "setup_failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            result = main(["--resume", fleet_id])

        assert result == 0
        mock_dispatch.assert_called_once()
        targets = mock_dispatch.call_args[1]["targets"]
        dirs = [t["project_dir"] for t in targets]
        assert str(proj_a) in dirs
        assert str(proj_c) in dirs
        assert str(proj_b) not in dirs

    def test_resume_missing_pipelines_d_entry_treated_as_pending(self, tmp_path):
        """A child with no pipelines.d/ entry is treated as pending and re-launched."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        # No pipelines.d/ entry written for run-a

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        mock_dispatch.assert_called_once()
        targets = mock_dispatch.call_args[1]["targets"]
        dirs = [t["project_dir"] for t in targets]
        assert str(proj_a) in dirs

    def test_resume_reads_pipelines_d_not_manifest_status(self, tmp_path):
        """Status comes from pipelines.d/, not from any status field in the manifest."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        # Manifest says nothing about child status (correct design)
        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)

        # Status is only in pipelines.d/
        wt = proj_a / ".worktrees" / "run-a"
        wt.mkdir(parents=True)
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=str(wt))

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        # Dispatch was called — status was resolved from pipelines.d/
        mock_dispatch.assert_called_once()
        targets = mock_dispatch.call_args[1]["targets"]
        assert any(t["project_dir"] == str(proj_a) for t in targets)


# ---------------------------------------------------------------------------
# Cleaned worktrees → unrecoverable
# ---------------------------------------------------------------------------


class TestResumeCleanedWorktrees:
    """Cleaned worktrees are marked unrecoverable and skipped."""

    def test_cleaned_worktree_skipped(self, tmp_path):
        """Failed child whose worktree was deleted is not re-launched."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)

        # worktree_path does NOT exist on disk
        missing_wt = str(tmp_path / "gone_worktree")
        _write_pipelines_entry(str(proj_a), "run-a", "failed",
                               worktree_path=missing_wt)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        if mock_dispatch.called:
            targets = mock_dispatch.call_args[1]["targets"]
            assert str(proj_a) not in [t["project_dir"] for t in targets]

    def test_cleaned_worktree_logs_message(self, tmp_path, capsys):
        """Skipping a cleaned child prints a descriptive message."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)

        missing_wt = str(tmp_path / "gone_worktree")
        _write_pipelines_entry(str(proj_a), "run-a", "failed",
                               worktree_path=missing_wt)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
        ):
            main(["--resume", fleet_id])

        captured = capsys.readouterr()
        output = captured.err + captured.out
        assert "run-a" in output
        assert "worktree" in output.lower() or "cleaned" in output.lower()

    def test_cleaned_worktree_marks_unrecoverable_in_registry(self, tmp_path):
        """The pipelines.d/ entry is updated to 'unrecoverable' for cleaned children."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)

        missing_wt = str(tmp_path / "gone_worktree")
        _write_pipelines_entry(str(proj_a), "run-a", "failed",
                               worktree_path=missing_wt)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
        ):
            main(["--resume", fleet_id])

        # Check the registry entry was updated
        entry_path = os.path.join(
            str(proj_a), ".worca", "multi", "pipelines.d", "run-a.json"
        )
        with open(entry_path) as f:
            entry = json.load(f)
        assert entry["status"] == "unrecoverable"

    def test_cleaned_child_skipped_others_still_dispatched(self, tmp_path):
        """Cleaned children are skipped; remaining failed children are still launched."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")

        proj_a = tmp_path / "a"  # cleaned → unrecoverable → skip
        proj_b = tmp_path / "b"  # failed with existing worktree → re-launch
        for p in [proj_a, proj_b]:
            p.mkdir()

        children = [
            {"project_path": str(proj_a), "run_id": "run-a"},
            {"project_path": str(proj_b), "run_id": "run-b"},
        ]
        _write_manifest(fleet_runs_dir, fleet_id, children)

        missing_wt = str(tmp_path / "gone_worktree")
        _write_pipelines_entry(str(proj_a), "run-a", "failed",
                               worktree_path=missing_wt)

        wt_b = proj_b / ".worktrees" / "run-b"
        wt_b.mkdir(parents=True)
        _write_pipelines_entry(str(proj_b), "run-b", "failed",
                               worktree_path=str(wt_b))

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            result = main(["--resume", fleet_id])

        assert result == 0
        mock_dispatch.assert_called_once()
        targets = mock_dispatch.call_args[1]["targets"]
        dirs = [t["project_dir"] for t in targets]
        assert str(proj_b) in dirs
        assert str(proj_a) not in dirs


# ---------------------------------------------------------------------------
# Dispatch wiring — manifest params forwarded correctly
# ---------------------------------------------------------------------------


class TestResumeDispatchWiring:
    """resume_fleet forwards the right manifest values to dispatch_fleet."""

    def test_resume_uses_same_fleet_id(self, tmp_path):
        """Re-launched children use the original fleet_id."""
        fleet_id = "f_20260512_abc123"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs["fleet_id"] == fleet_id

    def test_resume_uses_manifest_prompt(self, tmp_path):
        """Re-launched children get the prompt stored in the manifest."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(
            fleet_runs_dir, fleet_id, children,
            work_request={"title": "x", "description": "Migrate postgres", "source": None},
        )
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs["prompt"] == "Migrate postgres"
        assert kwargs["source"] is None

    def test_resume_uses_manifest_source(self, tmp_path):
        """Re-launched children get the source reference from the manifest."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(
            fleet_runs_dir, fleet_id, children,
            work_request={"title": "x", "description": "", "source": "gh:issue:42"},
        )
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs["source"] == "gh:issue:42"

    def test_resume_uses_manifest_base_branch(self, tmp_path):
        """Re-launched children receive the base branch from the manifest."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children, base_branch="dev")
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs["base"] == "dev"

    def test_resume_uses_manifest_plan_path(self, tmp_path):
        """Re-launched children receive the plan from the manifest."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        plan_path = str(tmp_path / "plan.md")
        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(
            fleet_runs_dir, fleet_id, children,
            plan={"mode": "explicit", "path": plan_path},
        )
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs["plan"] == plan_path

    def test_resume_uses_manifest_guide_paths(self, tmp_path):
        """Re-launched children receive the guide paths from the manifest."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        guide_paths = ["/docs/spec.md", "/docs/rfc.md"]
        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(
            fleet_runs_dir, fleet_id, children,
            guide={"paths": guide_paths, "bytes": 100, "filenames": [], "uploaded": False},
        )
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs["guide"] == guide_paths

    def test_resume_uses_manifest_max_parallel(self, tmp_path):
        """Re-launched children use the max_parallel from the manifest."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children, max_parallel=3)
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}) as mock_dispatch,
        ):
            main(["--resume", fleet_id])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs["max_parallel"] == 3

    def test_resume_updates_fleet_status_to_resuming(self, tmp_path):
        """Fleet manifest status is updated to 'resuming' before dispatch."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        statuses_seen = []

        def _fake_dispatch(**kwargs):
            # Read manifest status at dispatch time
            manifest_path = os.path.join(fleet_runs_dir, f"{fleet_id}.json")
            with open(manifest_path) as f:
                m = json.load(f)
            statuses_seen.append(m.get("status"))
            return {}

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", side_effect=_fake_dispatch),
        ):
            main(["--resume", fleet_id])

        assert "resuming" in statuses_seen

    def test_resume_returns_zero_on_success(self, tmp_path):
        """main() returns 0 on successful resume."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "failed", worktree_path=None)

        from worca.scripts.run_fleet import main

        with (
            patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
        ):
            result = main(["--resume", fleet_id])

        assert result == 0

    def test_resume_returns_zero_when_no_resumable_children(self, tmp_path):
        """Returns 0 even when no children need re-launching (all completed)."""
        fleet_id = "f_20260512_test"
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        proj_a = tmp_path / "a"
        proj_a.mkdir()

        children = [{"project_path": str(proj_a), "run_id": "run-a"}]
        _write_manifest(fleet_runs_dir, fleet_id, children)
        _write_pipelines_entry(str(proj_a), "run-a", "completed")

        from worca.scripts.run_fleet import main

        with patch("worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir):
            result = main(["--resume", fleet_id])

        assert result == 0
