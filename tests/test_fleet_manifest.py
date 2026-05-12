"""Tests for worca.orchestrator.fleet_manifest (W-040 Phase 2b task 1).

Covers: generate_fleet_id, fleet_manifest_path, write_fleet_manifest,
read_fleet_manifest, update_fleet_status, derive_fleet_status,
and poll_and_update_fleet_manifest.
"""
import json
import os
import re
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# generate_fleet_id
# ---------------------------------------------------------------------------


class TestGenerateFleetId:
    def _call(self):
        from worca.orchestrator.fleet_manifest import generate_fleet_id
        return generate_fleet_id()

    def test_returns_two_element_tuple(self):
        result = self._call()
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_both_elements_are_strings(self):
        fleet_id, fleet_id_short = self._call()
        assert isinstance(fleet_id, str)
        assert isinstance(fleet_id_short, str)

    def test_fleet_id_format(self):
        fleet_id, _ = self._call()
        assert re.match(r"^f_\d{12}_[a-z0-9]+$", fleet_id), (
            f"fleet_id {fleet_id!r} does not match f_<yyyymmddhhmm>_<rand>"
        )

    def test_fleet_id_short_is_suffix_of_fleet_id(self):
        fleet_id, fleet_id_short = self._call()
        assert fleet_id.endswith(fleet_id_short)

    def test_fleet_id_short_non_empty(self):
        _, fleet_id_short = self._call()
        assert len(fleet_id_short) >= 4

    def test_fleet_ids_unique_across_calls(self):
        id1, _ = self._call()
        id2, _ = self._call()
        # Random suffix means two calls are extremely unlikely to collide
        assert id1 != id2

    def test_now_parameter_controls_timestamp(self):
        from worca.orchestrator.fleet_manifest import generate_fleet_id
        fixed = datetime(2026, 5, 12, 8, 9, tzinfo=timezone.utc)
        fleet_id, _ = generate_fleet_id(now=fixed)
        assert "202605120809" in fleet_id

    def test_short_id_is_the_rand_part_only(self):
        fleet_id, fleet_id_short = self._call()
        parts = fleet_id.rsplit("_", 1)
        assert parts[-1] == fleet_id_short


# ---------------------------------------------------------------------------
# fleet_manifest_path
# ---------------------------------------------------------------------------


class TestFleetManifestPath:
    def test_returns_string(self, tmp_path):
        from worca.orchestrator.fleet_manifest import fleet_manifest_path
        result = fleet_manifest_path("f_202605120809_abc123", base_dir=str(tmp_path))
        assert isinstance(result, str)

    def test_path_ends_with_fleet_id_json(self, tmp_path):
        from worca.orchestrator.fleet_manifest import fleet_manifest_path
        fleet_id = "f_202605120809_abc123"
        path = fleet_manifest_path(fleet_id, base_dir=str(tmp_path))
        assert path.endswith(f"{fleet_id}.json")

    def test_path_is_under_base_dir(self, tmp_path):
        from worca.orchestrator.fleet_manifest import fleet_manifest_path
        path = fleet_manifest_path("f_202605120809_abc123", base_dir=str(tmp_path))
        assert path.startswith(str(tmp_path))

    def test_default_base_dir_expands_home(self):
        from worca.orchestrator.fleet_manifest import fleet_manifest_path
        path = fleet_manifest_path("f_202605120809_abc123")
        expanded_home = os.path.expanduser("~")
        assert path.startswith(expanded_home)

    def test_default_base_dir_is_worca_fleet_runs(self):
        from worca.orchestrator.fleet_manifest import fleet_manifest_path
        path = fleet_manifest_path("f_202605120809_abc123")
        assert ".worca/fleet-runs" in path


# ---------------------------------------------------------------------------
# write_fleet_manifest
# ---------------------------------------------------------------------------


class TestWriteFleetManifest:
    def _minimal_manifest(self, fleet_id="f_202605120809_abc123"):
        return {
            "fleet_id": fleet_id,
            "fleet_id_short": "abc123",
            "created_at": "2026-05-12T08:09:00+00:00",
            "work_request": {"title": "Migrate auth", "description": "...", "source": None},
            "guide": {"paths": [], "bytes": 0, "filenames": [], "uploaded": False},
            "plan": {"mode": "none", "path": None},
            "head_template": None,
            "base_branch": None,
            "max_parallel": 5,
            "fleet_failure_threshold": 0.30,
            "status": "running",
            "halt_reason": None,
            "children": [],
        }

    def test_returns_path_string(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest
        manifest = self._minimal_manifest()
        result = write_fleet_manifest(manifest, base_dir=str(tmp_path))
        assert isinstance(result, str)

    def test_file_exists_after_write(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest
        manifest = self._minimal_manifest()
        path = write_fleet_manifest(manifest, base_dir=str(tmp_path))
        assert os.path.exists(path)

    def test_file_contains_valid_json(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest
        manifest = self._minimal_manifest()
        path = write_fleet_manifest(manifest, base_dir=str(tmp_path))
        with open(path) as f:
            data = json.load(f)
        assert data["fleet_id"] == manifest["fleet_id"]

    def test_creates_parent_directories(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest
        nested_base = os.path.join(str(tmp_path), "a", "b", "c")
        manifest = self._minimal_manifest()
        path = write_fleet_manifest(manifest, base_dir=nested_base)
        assert os.path.exists(path)

    def test_roundtrips_all_fields(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest
        manifest = self._minimal_manifest()
        manifest["children"] = [
            {
                "project_path": "/repo/a",
                "project_slug": "a",
                "head_branch": "migration/a",
                "base_branch": "main",
                "run_id": "r_abc",
            }
        ]
        path = write_fleet_manifest(manifest, base_dir=str(tmp_path))
        with open(path) as f:
            data = json.load(f)
        assert data["children"][0]["run_id"] == "r_abc"

    def test_atomic_write_no_tmp_files_left(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest
        manifest = self._minimal_manifest()
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        tmp_files = [f for f in os.listdir(tmp_path) if f.startswith(".tmp_")]
        assert tmp_files == []


# ---------------------------------------------------------------------------
# read_fleet_manifest
# ---------------------------------------------------------------------------


class TestReadFleetManifest:
    def _write(self, tmp_path, fleet_id, data):
        path = os.path.join(str(tmp_path), f"{fleet_id}.json")
        with open(path, "w") as f:
            json.dump(data, f)
        return path

    def test_returns_dict_when_file_exists(self, tmp_path):
        from worca.orchestrator.fleet_manifest import read_fleet_manifest
        self._write(tmp_path, "f_abc", {"fleet_id": "f_abc"})
        result = read_fleet_manifest("f_abc", base_dir=str(tmp_path))
        assert isinstance(result, dict)
        assert result["fleet_id"] == "f_abc"

    def test_returns_none_when_file_missing(self, tmp_path):
        from worca.orchestrator.fleet_manifest import read_fleet_manifest
        result = read_fleet_manifest("f_does_not_exist", base_dir=str(tmp_path))
        assert result is None

    def test_returns_none_on_malformed_json(self, tmp_path):
        from worca.orchestrator.fleet_manifest import read_fleet_manifest
        path = os.path.join(str(tmp_path), "f_bad.json")
        with open(path, "w") as f:
            f.write("{not valid json")
        result = read_fleet_manifest("f_bad", base_dir=str(tmp_path))
        assert result is None


# ---------------------------------------------------------------------------
# update_fleet_status
# ---------------------------------------------------------------------------


class TestUpdateFleetStatus:
    def _create_manifest(self, tmp_path, fleet_id="f_202605120809_abc123", status="running"):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest
        manifest = {
            "fleet_id": fleet_id,
            "fleet_id_short": "abc123",
            "status": status,
            "halt_reason": None,
            "children": [],
        }
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        return manifest

    def test_returns_true_when_manifest_exists(self, tmp_path):
        from worca.orchestrator.fleet_manifest import update_fleet_status
        self._create_manifest(tmp_path)
        result = update_fleet_status("f_202605120809_abc123", "completed", base_dir=str(tmp_path))
        assert result is True

    def test_returns_false_when_manifest_missing(self, tmp_path):
        from worca.orchestrator.fleet_manifest import update_fleet_status
        result = update_fleet_status("f_does_not_exist", "completed", base_dir=str(tmp_path))
        assert result is False

    def test_updates_status_field(self, tmp_path):
        from worca.orchestrator.fleet_manifest import update_fleet_status, read_fleet_manifest
        self._create_manifest(tmp_path)
        update_fleet_status("f_202605120809_abc123", "completed", base_dir=str(tmp_path))
        manifest = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert manifest["status"] == "completed"

    def test_sets_halt_reason_when_provided(self, tmp_path):
        from worca.orchestrator.fleet_manifest import update_fleet_status, read_fleet_manifest
        self._create_manifest(tmp_path)
        update_fleet_status(
            "f_202605120809_abc123",
            "halted",
            halt_reason="circuit_breaker",
            base_dir=str(tmp_path),
        )
        manifest = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert manifest["halt_reason"] == "circuit_breaker"

    def test_clears_halt_reason_when_status_not_halted(self, tmp_path):
        from worca.orchestrator.fleet_manifest import update_fleet_status, read_fleet_manifest
        self._create_manifest(tmp_path, status="halted")
        update_fleet_status("f_202605120809_abc123", "completed", base_dir=str(tmp_path))
        manifest = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert manifest["halt_reason"] is None

    def test_preserves_other_fields(self, tmp_path):
        from worca.orchestrator.fleet_manifest import update_fleet_status, read_fleet_manifest
        self._create_manifest(tmp_path)
        update_fleet_status("f_202605120809_abc123", "completed", base_dir=str(tmp_path))
        manifest = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert manifest["fleet_id"] == "f_202605120809_abc123"
        assert manifest["fleet_id_short"] == "abc123"

    def test_adds_updated_at_field(self, tmp_path):
        from worca.orchestrator.fleet_manifest import update_fleet_status, read_fleet_manifest
        self._create_manifest(tmp_path)
        update_fleet_status("f_202605120809_abc123", "completed", base_dir=str(tmp_path))
        manifest = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert "updated_at" in manifest

    def test_halted_status_preserves_halt_reason_when_not_passed(self, tmp_path):
        from worca.orchestrator.fleet_manifest import update_fleet_status, read_fleet_manifest
        self._create_manifest(tmp_path)
        # Set halted with reason
        update_fleet_status(
            "f_202605120809_abc123", "halted",
            halt_reason="user", base_dir=str(tmp_path)
        )
        # Update again without halt_reason — should preserve "user"
        update_fleet_status(
            "f_202605120809_abc123", "halted",
            base_dir=str(tmp_path)
        )
        manifest = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert manifest["halt_reason"] == "user"


# ---------------------------------------------------------------------------
# derive_fleet_status (pure function)
# ---------------------------------------------------------------------------


class TestDeriveFleetStatus:
    def _call(self, statuses, threshold=0.30):
        from worca.orchestrator.fleet_manifest import derive_fleet_status
        return derive_fleet_status(statuses, threshold=threshold)

    def test_empty_list_returns_running(self):
        status, halt_reason = self._call([])
        assert status == "running"
        assert halt_reason is None

    def test_all_running_returns_running(self):
        status, _ = self._call(["running", "running"])
        assert status == "running"

    def test_all_completed_returns_completed(self):
        status, halt_reason = self._call(["completed", "completed", "completed"])
        assert status == "completed"
        assert halt_reason is None

    def test_all_failed_returns_failed(self):
        status, halt_reason = self._call(["failed", "failed", "failed"])
        assert status == "failed"
        assert halt_reason is None

    def test_some_running_some_completed_returns_running(self):
        status, _ = self._call(["running", "completed", "completed"])
        assert status == "running"

    def test_failure_ratio_below_threshold_returns_running(self):
        # 1/5 = 0.20 < 0.30 → not circuit breaker
        statuses = ["failed", "running", "running", "running", "running"]
        status, _ = self._call(statuses, threshold=0.30)
        assert status == "running"

    def test_circuit_breaker_trips_when_threshold_met_with_running(self):
        # 2/3 terminal failed = 0.67 >= 0.30, 3 >= min(3,5), 2 running in-flight
        statuses = ["failed", "failed", "completed", "running", "running"]
        status, halt_reason = self._call(statuses, threshold=0.30)
        assert status == "halted"
        assert halt_reason == "circuit_breaker"

    def test_circuit_breaker_no_trip_when_all_terminal(self):
        # Circuit breaker requires running children; all done → just "failed"
        statuses = ["failed", "failed", "completed", "completed", "completed"]
        status, halt_reason = self._call(statuses, threshold=0.30)
        assert status == "failed"
        assert halt_reason is None

    def test_circuit_breaker_requires_min_3_terminal(self):
        # Only 2 terminal (< min(3,5)=3) — not enough to trip breaker
        statuses = ["failed", "failed", "running", "running", "running"]
        status, _ = self._call(statuses, threshold=0.30)
        assert status == "running"

    def test_circuit_breaker_with_total_lt_3_needs_enough_terminal(self):
        # total=3, min(3,3)=3, need 3 terminal: only 2 failed + 1 running → no trip
        statuses = ["failed", "failed", "running"]
        status, _ = self._call(statuses, threshold=0.30)
        assert status == "running"

    def test_mixed_terminal_without_threshold_trip_is_failed(self):
        # 1/5 all terminal, some failed → "failed" (below threshold but no running)
        statuses = ["failed", "completed", "completed", "completed", "completed"]
        status, halt_reason = self._call(statuses, threshold=0.30)
        assert status == "failed"
        assert halt_reason is None

    def test_setup_failed_counts_as_failure_with_running_children(self):
        # 3/3 terminal are setup_failed = 1.0 >= 0.30, 3 >= min(3,5), 2 running
        statuses = ["setup_failed", "setup_failed", "setup_failed", "running", "running"]
        status, halt_reason = self._call(statuses, threshold=0.30)
        assert status == "halted"
        assert halt_reason == "circuit_breaker"

    def test_unrecoverable_counts_as_failure_with_running_children(self):
        # 2/3 terminal are unrecoverable = 0.67 >= 0.30, 3 >= min(3,5), 2 running
        statuses = ["unrecoverable", "unrecoverable", "completed", "running", "running"]
        status, halt_reason = self._call(statuses, threshold=0.30)
        assert status == "halted"
        assert halt_reason == "circuit_breaker"

    def test_paused_child_counts_as_running(self):
        statuses = ["paused", "completed"]
        status, _ = self._call(statuses)
        assert status == "running"

    def test_resuming_child_counts_as_running(self):
        statuses = ["resuming", "completed"]
        status, _ = self._call(statuses)
        assert status == "running"

    def test_pending_child_returns_running(self):
        statuses = ["pending", "completed"]
        status, _ = self._call(statuses)
        assert status == "running"


# ---------------------------------------------------------------------------
# poll_and_update_fleet_manifest
# ---------------------------------------------------------------------------


class TestPollAndUpdateFleetManifest:
    def _create_manifest(self, tmp_path, children, status="running", threshold=0.30, halt_reason=None):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest
        manifest = {
            "fleet_id": "f_202605120809_abc123",
            "fleet_id_short": "abc123",
            "status": status,
            "halt_reason": halt_reason,
            "fleet_failure_threshold": threshold,
            "children": children,
        }
        write_fleet_manifest(manifest, base_dir=str(tmp_path))

    def _write_pipeline_entry(self, project_path, run_id, status):
        pipelines_dir = os.path.join(project_path, ".worca", "multi", "pipelines.d")
        os.makedirs(pipelines_dir, exist_ok=True)
        path = os.path.join(pipelines_dir, f"{run_id}.json")
        with open(path, "w") as f:
            json.dump({"run_id": run_id, "status": status}, f)

    def test_returns_none_when_manifest_missing(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        result = poll_and_update_fleet_manifest(
            "f_does_not_exist", manifest_base_dir=str(tmp_path)
        )
        assert result is None

    def test_returns_completed_when_all_children_completed(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        project = os.path.join(str(tmp_path), "repo_a")
        os.makedirs(project, exist_ok=True)
        self._write_pipeline_entry(project, "r_001", "completed")
        self._write_pipeline_entry(project, "r_002", "completed")
        self._create_manifest(tmp_path, children=[
            {"project_path": project, "run_id": "r_001"},
            {"project_path": project, "run_id": "r_002"},
        ])
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "completed"

    def test_updates_manifest_status_field(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest, read_fleet_manifest
        project = os.path.join(str(tmp_path), "repo_a")
        os.makedirs(project, exist_ok=True)
        self._write_pipeline_entry(project, "r_001", "completed")
        self._create_manifest(tmp_path, children=[
            {"project_path": project, "run_id": "r_001"},
        ])
        poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        manifest = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert manifest["status"] == "completed"

    def test_returns_running_when_some_children_running(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        project = os.path.join(str(tmp_path), "repo_a")
        os.makedirs(project, exist_ok=True)
        self._write_pipeline_entry(project, "r_001", "running")
        self._write_pipeline_entry(project, "r_002", "completed")
        self._create_manifest(tmp_path, children=[
            {"project_path": project, "run_id": "r_001"},
            {"project_path": project, "run_id": "r_002"},
        ])
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "running"

    def test_returns_failed_when_all_children_failed(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        project = os.path.join(str(tmp_path), "repo_a")
        os.makedirs(project, exist_ok=True)
        self._write_pipeline_entry(project, "r_001", "failed")
        self._write_pipeline_entry(project, "r_002", "failed")
        self._write_pipeline_entry(project, "r_003", "failed")
        self._create_manifest(tmp_path, children=[
            {"project_path": project, "run_id": "r_001"},
            {"project_path": project, "run_id": "r_002"},
            {"project_path": project, "run_id": "r_003"},
        ])
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "failed"

    def test_circuit_breaker_returns_halted(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest, read_fleet_manifest
        project = os.path.join(str(tmp_path), "repo_a")
        os.makedirs(project, exist_ok=True)
        # 3 failed, 1 completed, 1 running → 3/4 terminal = 75% >= 30%; 4 >= min(3,5)
        for i, st in enumerate(["failed", "failed", "failed", "completed", "running"]):
            self._write_pipeline_entry(project, f"r_{i:03d}", st)
        self._create_manifest(tmp_path, children=[
            {"project_path": project, "run_id": f"r_{i:03d}"} for i in range(5)
        ], threshold=0.30)
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "halted"
        manifest = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert manifest["halt_reason"] == "circuit_breaker"

    def test_user_halted_manifest_not_overridden(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        project = os.path.join(str(tmp_path), "repo_a")
        os.makedirs(project, exist_ok=True)
        self._write_pipeline_entry(project, "r_001", "completed")
        self._create_manifest(
            tmp_path,
            children=[{"project_path": project, "run_id": "r_001"}],
            status="halted",
            halt_reason="user",
        )
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "halted"

    def test_circuit_breaker_halted_manifest_not_overridden(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        project = os.path.join(str(tmp_path), "repo_a")
        os.makedirs(project, exist_ok=True)
        # In-flight children all completed after breaker fired — fleet stays halted
        self._write_pipeline_entry(project, "r_001", "completed")
        self._create_manifest(
            tmp_path,
            children=[{"project_path": project, "run_id": "r_001"}],
            status="halted",
            halt_reason="circuit_breaker",
        )
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "halted"

    def test_missing_pipeline_entry_treated_as_running(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        project = os.path.join(str(tmp_path), "repo_a")
        os.makedirs(project, exist_ok=True)
        # No pipeline entry written — treated as running
        self._create_manifest(tmp_path, children=[
            {"project_path": project, "run_id": "r_missing"},
        ])
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "running"

    def test_no_children_returns_running(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        self._create_manifest(tmp_path, children=[])
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "running"

    def test_reads_from_per_project_pipelines_d(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest
        project_a = os.path.join(str(tmp_path), "repo_a")
        project_b = os.path.join(str(tmp_path), "repo_b")
        for p in [project_a, project_b]:
            os.makedirs(p, exist_ok=True)
        self._write_pipeline_entry(project_a, "r_001", "completed")
        self._write_pipeline_entry(project_b, "r_002", "completed")
        self._create_manifest(tmp_path, children=[
            {"project_path": project_a, "run_id": "r_001"},
            {"project_path": project_b, "run_id": "r_002"},
        ])
        result = poll_and_update_fleet_manifest(
            "f_202605120809_abc123", manifest_base_dir=str(tmp_path)
        )
        assert result == "completed"


# ---------------------------------------------------------------------------
# Manifest schema completeness
# ---------------------------------------------------------------------------


class TestManifestSchemaCompleteness:
    """Verify a fully-written manifest includes all §10 required fields."""

    def _full_manifest(self, fleet_id="f_202605120809_abc123"):
        return {
            "fleet_id": fleet_id,
            "fleet_id_short": "abc123",
            "created_at": "2026-05-12T08:09:00+00:00",
            "work_request": {
                "title": "Migrate auth",
                "description": "Migrate all repos",
                "source": "gh:issue:42",
            },
            "guide": {
                "paths": ["/home/user/spec.md"],
                "bytes": 12345,
                "filenames": ["spec.md"],
                "uploaded": False,
            },
            "plan": {"mode": "explicit", "path": "docs/plans/W-040.md"},
            "head_template": "migration/v2/{project}",
            "base_branch": "main",
            "max_parallel": 5,
            "fleet_failure_threshold": 0.30,
            "status": "running",
            "halt_reason": None,
            "children": [
                {
                    "project_path": "/repo/a",
                    "project_slug": "a",
                    "head_branch": "migration/v2/a",
                    "base_branch": "main",
                    "run_id": "r_abc",
                }
            ],
        }

    REQUIRED_TOP_LEVEL = [
        "fleet_id", "fleet_id_short", "created_at",
        "work_request", "guide", "plan",
        "head_template", "base_branch",
        "max_parallel", "fleet_failure_threshold",
        "status", "halt_reason", "children",
    ]

    REQUIRED_GUIDE_FIELDS = ["paths", "bytes", "filenames", "uploaded"]
    REQUIRED_CHILD_FIELDS = ["project_path", "project_slug", "head_branch", "base_branch", "run_id"]

    def test_all_top_level_fields_present(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest, read_fleet_manifest
        manifest = self._full_manifest()
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        data = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        for field in self.REQUIRED_TOP_LEVEL:
            assert field in data, f"Missing top-level field: {field}"

    def test_guide_fields_present(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest, read_fleet_manifest
        manifest = self._full_manifest()
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        data = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        for field in self.REQUIRED_GUIDE_FIELDS:
            assert field in data["guide"], f"Missing guide field: {field}"

    def test_guide_uploaded_false_for_cli_paths(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest, read_fleet_manifest
        manifest = self._full_manifest()
        manifest["guide"]["uploaded"] = False
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        data = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert data["guide"]["uploaded"] is False

    def test_guide_uploaded_true_for_ui_uploads(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest, read_fleet_manifest
        manifest = self._full_manifest()
        manifest["guide"]["uploaded"] = True
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        data = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert data["guide"]["uploaded"] is True

    def test_children_fields_present(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest, read_fleet_manifest
        manifest = self._full_manifest()
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        data = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        child = data["children"][0]
        for field in self.REQUIRED_CHILD_FIELDS:
            assert field in child, f"Missing child field: {field}"

    def test_halt_reason_null_when_not_halted(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest, read_fleet_manifest
        manifest = self._full_manifest()
        manifest["status"] = "running"
        manifest["halt_reason"] = None
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        data = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert data["halt_reason"] is None

    def test_fleet_id_short_is_rand_suffix_of_fleet_id(self, tmp_path):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest, read_fleet_manifest
        manifest = self._full_manifest()
        write_fleet_manifest(manifest, base_dir=str(tmp_path))
        data = read_fleet_manifest("f_202605120809_abc123", base_dir=str(tmp_path))
        assert data["fleet_id"].endswith(data["fleet_id_short"])
