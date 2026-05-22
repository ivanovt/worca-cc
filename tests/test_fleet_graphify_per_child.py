"""Tests for per-child graphify detection in fleet runs (W-053 Phase 4).

Covers: detect_child_graphify_status, register_fleet_child graph_status field,
circuit breaker isolation from graphify degradation, and fleet dispatch with
mixed graphify states.
"""

import json
import os
from unittest.mock import patch, MagicMock


# ---------------------------------------------------------------------------
# Graph status constants
# ---------------------------------------------------------------------------


class TestGraphStatusConstants:
    def test_ready_value(self):
        from worca.orchestrator.fleet_manifest import GRAPH_STATUS_READY

        assert GRAPH_STATUS_READY == "ready"

    def test_degraded_value(self):
        from worca.orchestrator.fleet_manifest import GRAPH_STATUS_DEGRADED

        assert GRAPH_STATUS_DEGRADED == "degraded"

    def test_disabled_value(self):
        from worca.orchestrator.fleet_manifest import GRAPH_STATUS_DISABLED

        assert GRAPH_STATUS_DISABLED == "disabled"


# ---------------------------------------------------------------------------
# detect_child_graphify_status
# ---------------------------------------------------------------------------


class TestDetectChildGraphifyGlobalKillSwitch:
    def test_global_off_overrides_child_enabled(self, tmp_path):
        """Global graphify.enabled=false returns disabled even when child has enabled=true."""
        from worca.scripts.run_fleet import detect_child_graphify_status

        settings = tmp_path / ".claude" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"worca": {"graphify": {"enabled": True}}}))

        global_settings = {"worca": {"graphify": {"enabled": False}}}

        with patch(
            "worca.scripts.run_fleet.load_global_settings",
            return_value=global_settings,
        ):
            assert detect_child_graphify_status(str(tmp_path)) == "disabled"

    def test_global_settings_passed_as_first_arg(self, tmp_path):
        """effective_graphify_config receives global settings, not child settings twice."""
        from worca.scripts.run_fleet import detect_child_graphify_status
        from worca.utils.graphify import EffectiveGraphifyConfig

        settings = tmp_path / ".claude" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"worca": {"graphify": {"enabled": True}}}))

        sentinel_global = {"worca": {"graphify": {"enabled": True}}}
        cfg = EffectiveGraphifyConfig(
            enabled=False, mode="structural", backend=None, model_profile=None,
            out_dir="graphify-out", update_on_preflight=True,
            update_on_guardian_post_commit=True, min_repo_files=100,
            version_range=">=4,<5", reason="global-off",
        )

        with patch(
            "worca.scripts.run_fleet.load_global_settings",
            return_value=sentinel_global,
        ) as mock_load_global, patch(
            "worca.scripts.run_fleet.effective_graphify_config",
            return_value=cfg,
        ) as mock_effective:
            detect_child_graphify_status(str(tmp_path))

        mock_load_global.assert_called_once()
        call_args = mock_effective.call_args
        assert call_args[0][0] is sentinel_global


class TestDetectChildGraphifyStatus:
    def test_disabled_when_graphify_off(self, tmp_path):
        from worca.scripts.run_fleet import detect_child_graphify_status

        settings = tmp_path / ".claude" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"worca": {"graphify": {"enabled": False}}}))

        assert detect_child_graphify_status(str(tmp_path)) == "disabled"

    def test_disabled_when_no_graphify_key(self, tmp_path):
        from worca.scripts.run_fleet import detect_child_graphify_status

        settings = tmp_path / ".claude" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"worca": {}}))

        assert detect_child_graphify_status(str(tmp_path)) == "disabled"

    def test_disabled_when_settings_missing(self, tmp_path):
        from worca.scripts.run_fleet import detect_child_graphify_status

        assert detect_child_graphify_status(str(tmp_path)) == "disabled"

    def test_ready_when_enabled_and_compatible(self, tmp_path):
        from worca.scripts.run_fleet import detect_child_graphify_status
        from worca.utils.graphify import GraphifyDetect

        settings = tmp_path / ".claude" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"worca": {"graphify": {"enabled": True}}}))

        global_on = {"worca": {"graphify": {"enabled": True}}}
        with patch(
            "worca.scripts.run_fleet.load_global_settings",
            return_value=global_on,
        ), patch(
            "worca.scripts.run_fleet.detect_graphify",
            return_value=GraphifyDetect(
                installed=True, version="4.2.1", compatible=True,
                backend_env_present=[], error=None,
            ),
        ):
            assert detect_child_graphify_status(str(tmp_path)) == "ready"

    def test_degraded_when_enabled_but_not_installed(self, tmp_path):
        from worca.scripts.run_fleet import detect_child_graphify_status
        from worca.utils.graphify import GraphifyDetect

        settings = tmp_path / ".claude" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"worca": {"graphify": {"enabled": True}}}))

        global_on = {"worca": {"graphify": {"enabled": True}}}
        with patch(
            "worca.scripts.run_fleet.load_global_settings",
            return_value=global_on,
        ), patch(
            "worca.scripts.run_fleet.detect_graphify",
            return_value=GraphifyDetect(
                installed=False, version=None, compatible=False,
                backend_env_present=[], error="graphify CLI not found on PATH",
            ),
        ):
            assert detect_child_graphify_status(str(tmp_path)) == "degraded"

    def test_degraded_when_enabled_but_incompatible(self, tmp_path):
        from worca.scripts.run_fleet import detect_child_graphify_status
        from worca.utils.graphify import GraphifyDetect

        settings = tmp_path / ".claude" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"worca": {"graphify": {"enabled": True}}}))

        global_on = {"worca": {"graphify": {"enabled": True}}}
        with patch(
            "worca.scripts.run_fleet.load_global_settings",
            return_value=global_on,
        ), patch(
            "worca.scripts.run_fleet.detect_graphify",
            return_value=GraphifyDetect(
                installed=True, version="3.0.0", compatible=False,
                backend_env_present=[], error="version 3.0.0 not in >=4,<5",
            ),
        ):
            assert detect_child_graphify_status(str(tmp_path)) == "degraded"


# ---------------------------------------------------------------------------
# register_fleet_child with graph_status
# ---------------------------------------------------------------------------


class TestRegisterFleetChildGraphStatus:
    def _seed_manifest(self, tmp_path, fleet_id="f_graph_test"):
        from worca.orchestrator.fleet_manifest import write_fleet_manifest

        write_fleet_manifest(
            {"fleet_id": fleet_id, "fleet_id_short": "gt", "status": "running",
             "halt_reason": None, "children": []},
            base_dir=str(tmp_path),
        )
        return fleet_id

    def test_graph_status_written_when_provided(self, tmp_path):
        from worca.orchestrator.fleet_manifest import register_fleet_child, read_fleet_manifest

        fid = self._seed_manifest(tmp_path)
        register_fleet_child(fid, "/repo/a", "r_001", graph_status="ready", base_dir=str(tmp_path))
        m = read_fleet_manifest(fid, base_dir=str(tmp_path))
        assert m["children"][0]["graph_status"] == "ready"

    def test_graph_status_absent_when_not_provided(self, tmp_path):
        from worca.orchestrator.fleet_manifest import register_fleet_child, read_fleet_manifest

        fid = self._seed_manifest(tmp_path)
        register_fleet_child(fid, "/repo/a", "r_001", base_dir=str(tmp_path))
        m = read_fleet_manifest(fid, base_dir=str(tmp_path))
        assert "graph_status" not in m["children"][0]

    def test_mixed_statuses_three_children(self, tmp_path):
        from worca.orchestrator.fleet_manifest import register_fleet_child, read_fleet_manifest

        fid = self._seed_manifest(tmp_path)
        register_fleet_child(fid, "/repo/a", "r_001", graph_status="ready", base_dir=str(tmp_path))
        register_fleet_child(fid, "/repo/b", "r_002", graph_status="degraded", base_dir=str(tmp_path))
        register_fleet_child(fid, "/repo/c", "r_003", graph_status="disabled", base_dir=str(tmp_path))

        m = read_fleet_manifest(fid, base_dir=str(tmp_path))
        gs = {c["project_path"]: c["graph_status"] for c in m["children"]}
        assert gs == {"/repo/a": "ready", "/repo/b": "degraded", "/repo/c": "disabled"}


# ---------------------------------------------------------------------------
# Circuit breaker ignores graphify degradation
# ---------------------------------------------------------------------------


class TestCircuitBreakerIgnoresGraphifyDegradation:
    def test_all_completed_regardless_of_graphify_state(self):
        from worca.orchestrator.fleet_manifest import derive_fleet_status

        status, reason = derive_fleet_status(
            ["completed", "completed", "completed"], threshold=0.30,
        )
        assert status == "completed"
        assert reason is None

    def test_no_breaker_when_all_pipelines_succeed(self):
        from worca.orchestrator.fleet_manifest import derive_fleet_status

        statuses = ["completed", "completed", "completed", "running", "running"]
        status, reason = derive_fleet_status(statuses, threshold=0.30)
        assert status == "running"
        assert reason is None

    def test_breaker_only_fires_on_pipeline_failures(self):
        from worca.orchestrator.fleet_manifest import derive_fleet_status

        statuses = ["failed", "failed", "failed", "running", "running"]
        status, reason = derive_fleet_status(statuses, threshold=0.30)
        assert status == "halted"
        assert reason == "circuit_breaker"


# ---------------------------------------------------------------------------
# dispatch_fleet passes graph_status through
# ---------------------------------------------------------------------------


class TestDispatchFleetGraphStatus:
    def test_graph_status_from_targets_recorded_in_manifest(self, tmp_path):
        import worca.orchestrator.fleet_manifest as fm
        from worca.orchestrator.fleet_manifest import write_fleet_manifest, read_fleet_manifest
        from worca.scripts.run_fleet import dispatch_fleet

        manifest_dir = str(tmp_path / "fleet-runs")
        os.makedirs(manifest_dir)
        fleet_id = "f_dispatch_gs"

        write_fleet_manifest(
            {"fleet_id": fleet_id, "fleet_id_short": "dgs", "status": "running",
             "halt_reason": None, "fleet_failure_threshold": 0.30, "children": []},
            base_dir=manifest_dir,
        )

        targets = [
            {"project_dir": "/repo/a", "status": "pending", "graph_status": "ready"},
            {"project_dir": "/repo/b", "status": "pending", "graph_status": "degraded"},
            {"project_dir": "/repo/c", "status": "pending", "graph_status": "disabled"},
        ]

        call_idx = [0]

        def mock_popen(cmd, **kwargs):
            call_idx[0] += 1
            idx = call_idx[0]
            p = MagicMock()
            p.poll.return_value = 0
            p.communicate.return_value = (f"r_{idx:03d}\n/wt/{idx}\n", "")
            return p

        with patch("worca.scripts.run_fleet.subprocess.Popen", side_effect=mock_popen), \
             patch("worca.scripts.run_fleet.time.sleep"), \
             patch.object(fm, "_FLEET_RUNS_DIR", manifest_dir):
            dispatch_fleet(
                targets=targets,
                fleet_id=fleet_id,
                prompt="test",
                source=None,
                base=None,
                guide=[],
                plan=None,
                max_parallel=3,
                fleet_failure_threshold=0.30,
            )

        m = read_fleet_manifest(fleet_id, base_dir=manifest_dir)
        children = m["children"]
        assert len(children) == 3

        gs_map = {c["project_path"]: c.get("graph_status") for c in children}
        assert gs_map["/repo/a"] == "ready"
        assert gs_map["/repo/b"] == "degraded"
        assert gs_map["/repo/c"] == "disabled"


# ---------------------------------------------------------------------------
# Full mixed scenario (task acceptance test)
# ---------------------------------------------------------------------------


class TestFleetMixedGraphifyScenario:
    """Full scenario from task: child A ready, child B missing (degraded),
    child C disabled — all complete, manifest records distinct statuses,
    circuit breaker ignores degradation."""

    def test_mixed_graphify_states_all_complete(self, tmp_path):
        from worca.orchestrator.fleet_manifest import (
            GRAPH_STATUS_READY, GRAPH_STATUS_DEGRADED, GRAPH_STATUS_DISABLED,
            write_fleet_manifest, register_fleet_child, read_fleet_manifest,
            derive_fleet_status,
        )

        fleet_id = "f_mixed_scenario"
        write_fleet_manifest(
            {"fleet_id": fleet_id, "fleet_id_short": "ms", "status": "running",
             "halt_reason": None, "fleet_failure_threshold": 0.30, "children": []},
            base_dir=str(tmp_path),
        )

        register_fleet_child(
            fleet_id, "/repo/a", "r_001",
            graph_status=GRAPH_STATUS_READY, base_dir=str(tmp_path),
        )
        register_fleet_child(
            fleet_id, "/repo/b", "r_002",
            graph_status=GRAPH_STATUS_DEGRADED, base_dir=str(tmp_path),
        )
        register_fleet_child(
            fleet_id, "/repo/c", "r_003",
            graph_status=GRAPH_STATUS_DISABLED, base_dir=str(tmp_path),
        )

        manifest = read_fleet_manifest(fleet_id, base_dir=str(tmp_path))

        assert len(manifest["children"]) == 3

        gs = {c["project_path"]: c["graph_status"] for c in manifest["children"]}
        assert gs["/repo/a"] == "ready"
        assert gs["/repo/b"] == "degraded"
        assert gs["/repo/c"] == "disabled"

        pipeline_statuses = ["completed", "completed", "completed"]
        fleet_status, halt_reason = derive_fleet_status(
            pipeline_statuses, threshold=0.30,
        )
        assert fleet_status == "completed"
        assert halt_reason is None
