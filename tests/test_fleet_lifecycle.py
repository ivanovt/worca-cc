"""Tests for fleet-level lifecycle actions: pause_fleet, stop_fleet, resume_child.

pause_fleet / stop_fleet fan a per-run control file out to every in-flight
child and stamp the manifest. resume_child continues a paused/interrupted
child in place by spawning run_pipeline.py --resume in its existing worktree.
"""

import json
import os
from unittest.mock import patch

from worca.orchestrator import fleet_lifecycle


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_manifest(fleet_runs_dir, fleet_id, children, status="running"):
    os.makedirs(fleet_runs_dir, exist_ok=True)
    manifest = {
        "fleet_id": fleet_id,
        "fleet_id_short": fleet_id.rsplit("_", 1)[-1],
        "work_request": {"title": "t", "description": "d", "source": None},
        "status": status,
        "halt_reason": None,
        "children": children,
    }
    with open(os.path.join(fleet_runs_dir, f"{fleet_id}.json"), "w") as f:
        json.dump(manifest, f)
    return manifest


def _write_child(project_dir, run_id, status, *, worktree_path=None, pid=2147483646):
    """Write a pipelines.d/ registry entry for a fleet child.

    worktree_path defaults to <project_dir>/.worktrees/<run_id>. pid defaults
    to a guaranteed-dead pid so stop_fleet's SIGTERM is a harmless no-op.
    """
    if worktree_path is None:
        worktree_path = os.path.join(project_dir, ".worktrees", run_id)
    pipelines_d = os.path.join(project_dir, ".worca", "multi", "pipelines.d")
    os.makedirs(pipelines_d, exist_ok=True)
    entry = {
        "run_id": run_id,
        "status": status,
        "worktree_path": worktree_path,
        "pid": pid,
        "title": "t",
    }
    with open(os.path.join(pipelines_d, f"{run_id}.json"), "w") as f:
        json.dump(entry, f)
    return worktree_path


def _read_manifest(fleet_runs_dir, fleet_id):
    with open(os.path.join(fleet_runs_dir, f"{fleet_id}.json")) as f:
        return json.load(f)


def _read_child(project_dir, run_id):
    path = os.path.join(
        project_dir, ".worca", "multi", "pipelines.d", f"{run_id}.json"
    )
    with open(path) as f:
        return json.load(f)


def _control_path(worktree_path, run_id):
    return os.path.join(worktree_path, ".worca", "runs", run_id, "control.json")


# ---------------------------------------------------------------------------
# pause_fleet
# ---------------------------------------------------------------------------


class TestPauseFleet:
    def test_returns_none_when_manifest_missing(self, tmp_path):
        with patch(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR",
            str(tmp_path / "fleet-runs"),
        ):
            assert fleet_lifecycle.pause_fleet("f_202601010000_missing") is None

    def test_writes_pause_control_to_in_flight_children(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        fleet_id = "f_202601010000_abcd1234"
        proj_a = tmp_path / "a"
        proj_b = tmp_path / "b"
        proj_a.mkdir()
        proj_b.mkdir()
        wt_a = _write_child(str(proj_a), "run-a", "running")
        wt_b = _write_child(str(proj_b), "run-b", "running")
        _write_manifest(fleet_runs_dir, fleet_id, [
            {"project_path": str(proj_a), "run_id": "run-a"},
            {"project_path": str(proj_b), "run_id": "run-b"},
        ])

        with patch(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir
        ):
            count = fleet_lifecycle.pause_fleet(fleet_id)

        assert count == 2
        for wt, run_id in ((wt_a, "run-a"), (wt_b, "run-b")):
            ctrl = _control_path(wt, run_id)
            assert os.path.exists(ctrl)
            with open(ctrl) as f:
                assert json.load(f)["action"] == "pause"

    def test_skips_terminal_children(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        fleet_id = "f_202601010000_abcd1234"
        proj_a = tmp_path / "a"
        proj_b = tmp_path / "b"
        proj_a.mkdir()
        proj_b.mkdir()
        wt_a = _write_child(str(proj_a), "run-a", "running")
        wt_b = _write_child(str(proj_b), "run-b", "completed")
        _write_manifest(fleet_runs_dir, fleet_id, [
            {"project_path": str(proj_a), "run_id": "run-a"},
            {"project_path": str(proj_b), "run_id": "run-b"},
        ])

        with patch(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir
        ):
            count = fleet_lifecycle.pause_fleet(fleet_id)

        assert count == 1
        assert os.path.exists(_control_path(wt_a, "run-a"))
        assert not os.path.exists(_control_path(wt_b, "run-b"))

    def test_skips_already_paused_children(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        fleet_id = "f_202601010000_abcd1234"
        proj_a = tmp_path / "a"
        proj_a.mkdir()
        wt_a = _write_child(str(proj_a), "run-a", "paused")
        _write_manifest(fleet_runs_dir, fleet_id, [
            {"project_path": str(proj_a), "run_id": "run-a"},
        ])

        with patch(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir
        ):
            count = fleet_lifecycle.pause_fleet(fleet_id)

        assert count == 0
        assert not os.path.exists(_control_path(wt_a, "run-a"))

    def test_sets_manifest_status_paused(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        fleet_id = "f_202601010000_abcd1234"
        proj_a = tmp_path / "a"
        proj_a.mkdir()
        _write_child(str(proj_a), "run-a", "running")
        _write_manifest(fleet_runs_dir, fleet_id, [
            {"project_path": str(proj_a), "run_id": "run-a"},
        ])

        with patch(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir
        ):
            fleet_lifecycle.pause_fleet(fleet_id)

        assert _read_manifest(fleet_runs_dir, fleet_id)["status"] == "paused"


# ---------------------------------------------------------------------------
# stop_fleet
# ---------------------------------------------------------------------------


class TestStopFleet:
    def test_returns_none_when_manifest_missing(self, tmp_path):
        with patch(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR",
            str(tmp_path / "fleet-runs"),
        ):
            assert fleet_lifecycle.stop_fleet("f_202601010000_missing") is None

    def test_writes_stop_control_to_in_flight_children(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        fleet_id = "f_202601010000_abcd1234"
        proj_a = tmp_path / "a"
        proj_a.mkdir()
        wt_a = _write_child(str(proj_a), "run-a", "running")
        _write_manifest(fleet_runs_dir, fleet_id, [
            {"project_path": str(proj_a), "run_id": "run-a"},
        ])

        with patch(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir
        ):
            count = fleet_lifecycle.stop_fleet(fleet_id)

        assert count == 1
        ctrl = _control_path(wt_a, "run-a")
        assert os.path.exists(ctrl)
        with open(ctrl) as f:
            assert json.load(f)["action"] == "stop"

    def test_sets_manifest_halted_with_stopped_reason(self, tmp_path):
        fleet_runs_dir = str(tmp_path / "fleet-runs")
        fleet_id = "f_202601010000_abcd1234"
        proj_a = tmp_path / "a"
        proj_a.mkdir()
        _write_child(str(proj_a), "run-a", "running")
        _write_manifest(fleet_runs_dir, fleet_id, [
            {"project_path": str(proj_a), "run_id": "run-a"},
        ])

        with patch(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", fleet_runs_dir
        ):
            fleet_lifecycle.stop_fleet(fleet_id)

        manifest = _read_manifest(fleet_runs_dir, fleet_id)
        assert manifest["status"] == "halted"
        assert manifest["halt_reason"] == "stopped"


# ---------------------------------------------------------------------------
# resume_child
# ---------------------------------------------------------------------------


class TestResumeChild:
    def _setup_worktree(self, project_dir, run_id, pipeline_status):
        """Create a registry entry + worktree status.json. Returns worktree path."""
        wt = os.path.join(project_dir, ".worktrees", run_id)
        run_dir = os.path.join(wt, ".worca", "runs", run_id)
        os.makedirs(run_dir, exist_ok=True)
        with open(os.path.join(run_dir, "status.json"), "w") as f:
            json.dump(
                {"run_id": run_id, "pipeline_status": pipeline_status,
                 "stop_reason": "control_file"},
                f,
            )
        _write_child(project_dir, run_id, pipeline_status, worktree_path=wt)
        return wt

    def test_returns_false_when_registry_entry_missing(self, tmp_path):
        proj = tmp_path / "a"
        proj.mkdir()
        assert fleet_lifecycle.resume_child(str(proj), "run-x") is False

    def test_returns_false_when_worktree_missing(self, tmp_path):
        proj = tmp_path / "a"
        proj.mkdir()
        # Registry entry points at a worktree dir that doesn't exist on disk.
        _write_child(str(proj), "run-a", "paused",
                     worktree_path=str(tmp_path / "gone"))
        assert fleet_lifecycle.resume_child(str(proj), "run-a") is False

    def test_flips_interrupted_status_to_resuming(self, tmp_path):
        proj = tmp_path / "a"
        proj.mkdir()
        wt = self._setup_worktree(str(proj), "run-a", "interrupted")

        with patch.object(fleet_lifecycle.subprocess, "Popen") as mock_popen:
            result = fleet_lifecycle.resume_child(str(proj), "run-a")

        assert result is True
        mock_popen.assert_called_once()
        # status.json flipped interrupted -> resuming, stop_reason cleared
        with open(os.path.join(wt, ".worca", "runs", "run-a", "status.json")) as f:
            status = json.load(f)
        assert status["pipeline_status"] == "resuming"
        assert "stop_reason" not in status
        # registry mirrored to resuming so derivation never sees it as terminal
        assert _read_child(str(proj), "run-a")["status"] == "resuming"

    def test_leaves_paused_status_untouched(self, tmp_path):
        proj = tmp_path / "a"
        proj.mkdir()
        wt = self._setup_worktree(str(proj), "run-a", "paused")

        with patch.object(fleet_lifecycle.subprocess, "Popen") as mock_popen:
            result = fleet_lifecycle.resume_child(str(proj), "run-a")

        assert result is True
        mock_popen.assert_called_once()
        # paused is already non-terminal — _find_active_runs picks it up, so
        # resume_child leaves status.json alone for the runner to flip.
        with open(os.path.join(wt, ".worca", "runs", "run-a", "status.json")) as f:
            assert json.load(f)["pipeline_status"] == "paused"

    def test_spawns_run_pipeline_with_registry_base(self, tmp_path):
        proj = tmp_path / "a"
        proj.mkdir()
        wt = self._setup_worktree(str(proj), "run-a", "paused")

        with patch.object(fleet_lifecycle.subprocess, "Popen") as mock_popen:
            fleet_lifecycle.resume_child(str(proj), "run-a")

        cmd = mock_popen.call_args[0][0]
        assert "--resume" in cmd
        assert "--worktree" in cmd
        # --status-dir is the worktree's worca root; --registry-base is the
        # parent project's .worca so update_pipeline lands on the right entry.
        assert cmd[cmd.index("--status-dir") + 1] == os.path.join(wt, ".worca")
        assert cmd[cmd.index("--registry-base") + 1] == os.path.abspath(
            os.path.join(str(proj), ".worca")
        )
        assert mock_popen.call_args[1]["cwd"] == wt
